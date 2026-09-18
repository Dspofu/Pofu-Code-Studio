# AGENTS.md

> Notas de trabalho do assistente de IA (eu) para este repositório.
> **Convenções, armadilhas e o fluxo de ferramenta nova: veja [CLAUDE.md](CLAUDE.md)** — este arquivo
> não repete isso. Aqui está o **mapa** (onde cada coisa vive) e o **estado atual**.
> Mantenha atualizado junto com o código: mapa velho é pior que mapa ausente.
> **As linhas citadas mudam a cada edição** — quando um trecho não estiver na linha dada,
> localize com search_files em vez de confiar no número.

---

## 1. O que é o projeto em uma frase

Desktop Electron que é um **agente de código**: fala com qualquer API REST compatível com
OpenAI (llama.cpp, Ollama, vLLM) e dá ao modelo 18 ferramentas para mexer num workspace
("pasta segura"), rodar comandos, chamar APIs, tirar print de páginas e buscar na web.
Idioma: **pt-BR para as pessoas** (UI, comentários, commits, docs), **inglês para o modelo**
(system prompt, descrições das tools, `error`/`hint`/`note`) — o agente responde na língua de
quem escreveu. Detalhes e o porquê: CLAUDE.md.

## 2. Mapa de arquivos

| Arquivo | Papel |
|---|---|
| `src/main.ts` | Processo main: janela, menu, **todos os 25 handlers IPC** (fs, processos, HTTP, captura, busca, store) |
| `src/preload.cts` | Ponte `contextBridge` → `window.electronAPI` (`.cts` porque o preload é CommonJS → `preload.cjs`) |
| `src/renderer.ts` | Cérebro: estado, loop do agente, `tools`, streaming, cards de ferramenta, diff, menções `@`, anexos, workspace |
| `src/edit-diagnostics.ts` | Diagnóstico de edições sem correspondência; sugestões nunca escrevem no arquivo |
| `src/edit-match.ts` | Casamento do `edit_file` (exato → CRLF → tolerante a espaço), reindentação e lote `edits` atômico |
| `src/tool-output.ts` | Formato compacto ao modelo: busca agrupada, listagens, terminal limpo, glob e sugestão de caminho |
| `src/tool-results.ts` | Recorte de arquivos, schemas de leitura e cache recuperável de resultados |
| `src/providers.ts` | Migração da conexão antiga, validação e seleção de perfis de provedor |
| `src/mention-highlight.ts`, `src/workspace-path.ts` | Menções azuis sem alterar o textarea e resolução de caminhos do projeto |
| `assets/studio.css` | Identidade Pofu, tela inicial e ajustes de layout |
| `scripts/*.test.mjs`, `scripts/test-electron.cjs` | Regressões de leitura/cache e integração real do Electron |
| `src/constants.ts` | `system_prompt()`, `DEFAULT_SETTINGS`, `THINK_LEVELS` e todos os limites (cada um comentado com o *porquê*) |
| `src/types.d.ts` | Tipos **globais** (sem import/export de propósito): `Settings`, `Chat`, `ElectronAPI`, `ProcEntry`… |
| `src/websearch.js` | **GERADO noutro repositório — não editar, não converter p/ .ts.** Tipos em `src/websearch.d.ts` |
| `index.html` | UI inteira: estilos no topo, sidebar, chat, modais (config, processos, confirmação, viewer); carrega `out/renderer.js` |
| `out/` | **Saída do build** (`rootDir: src` → `outDir: out`): `main.js`, `preload.cjs`, `renderer.js`, `constants.js` + maps. Ignorada pelo git, regerada pelo `npm run build`. |
| `vendor/` | Libs offline do renderer: tailwind, marked, purify, highlight, github-dark |
| `build/`, `dist/` | Recursos e saída do electron-builder |
| `.github/workflows/release.yml` | CI: tag `vX.Y.Z` → build `.deb` (ubuntu) + `.rpm` (fedora, cruza via `apt install rpm` no ubuntu) + `.exe` (windows) → publica no release |
| `CLAUDE.md` | Orientações gerais (convenções, armadilhas, fluxo de tool nova) |
| `TASKS.md` | Tarefas abertas do usuário |

**Layout do build (reorganizado em 2026-08):** TODA a fonte compilável vive em `src/`
(`main.ts` e `preload.cts` foram movidos para lá com `git mv`), e o `tsc` emite em `out/`.
`main` do package.json = `out/main.js`; o index.html carrega `out/renderer.js`;
o electron-builder empacota `out/**`. `src/websearch.js` é fonte versionada (NÃO é
compilada pelo tsc) — o `npm run build` copia ela para `out/` via `scripts/copy-websearch.mjs`;
sem essa cópia o `out/main.js` falha no boot com `ERR_MODULE_NOT_FOUND: out/websearch.js`.
Consequência: os imports relativos de `src/main.ts` são `./x.js` (mesmo diretório) e o
package.json é `../package.json`.

## 3. Comandos

```bash
npm run build      # tsc: emite a saída em out/
npm run typecheck  # só checagem de tipos, sem emitir
npm start          # build + electron --no-sandbox . --ozone-platform=x11 (Linux)
npm run dist       # build + .deb + .nsis
npm run dist:fedora # build + .rpm (exige rpmbuild: apt install rpm / dnf install rpm-build)
```

**Testes:** `npm run test:startup` cobre avisos de atualização sem rede/notificações reais.
`npm test` (leitura/cache) e `npm run test:integration` (Electron isolado).
`npm run test:api` testa um endpoint real usando variáveis de ambiente. Não há linter.
Validação = testes + `npm run typecheck` + conferir o layout no app. TS é frouxo de propósito (`strict: false`) — ver tsconfig.json para o porquê.

## 4. Mapa dos IPC handlers (src/main.ts)

Cada um tem correspondente 1:1 em `src/preload.cts` e assinatura em `ElectronAPI` (`src/types.d.ts`).

| Handler | O que faz |
|---|---|
| `select-folder` | Diálogo de pasta |
| `list-files` | Lista arquivos **com tamanho** (evita round-trip para o agente decidir se lê) |
| `read-file` | Leitura em **janelas** — recorte por orçamento de contexto, sem teto fixo de linhas; cursor `char_offset`; devolve `mtimeMs`; "não encontrado" traz `did_you_mean` |
| `get-diff` / `undo-change` | Remonta diff de instantâneo / desfaz (e grava outro instantâneo → refazer) |
| `write-file` / `delete-file` | **Trava**: recusa sobrescrever/apagar arquivo não lido (`arquivosLidos`); `write-file` também recusa se mudou em disco depois da leitura (`expectedMtimeMs`) |
| `edit-file` | `applyEdits` de `edit-match.ts`: trecho exato ou tolerante a espaço (único), `replaceAll`, lote `opts.edits` atômico |
| `create-directory` | Cria pasta |
| `get-app-info` | Lê `package.json` (`../package.json`, pois main roda de out/): githubUrl, version, name |
| `search-files` | Busca texto/regex com filtro glob; devolve `totalFound` (cap 10000), `fileCounts` e `matches` (limitados a max); `opts.mode` `files`/`count` pula o texto |
| `list-tree` | Árvore do workspace (para o menu `@`) |
| `execute-command` | Spawn; Windows: `cmd.exe` + `detached:false` + `windowsHide` (ver CLAUDE.md); background só por READY_PATTERNS, idle **pós-primeira-saída** ou timeout |
| `read-process-output` / `wait-for-process` / `list-processes` / `stop-process` / `clear-finished-processes` | Gestão dos processos em segundo plano |
| `load-store` / `save-store` | Lê/grava `app-store.json` do userData |
| `web-search` | Instância ÚNICA de `WebSearch` (cache/cooldown entre buscas) |
| `http-request` | Status + cabeçalhos + corpo separados |
| `capture-page` | BrowserWindow **offscreen** + `loadURL` contra timeout; PNG em `userData/screenshots` |
| `read-image` | Base64 de um PNG (para reenviar prints ao modelo) |
| `fetch-url` | Baixa página → texto (turndown/linkedom/readability) |

Outros pontos do main.ts: `app.setAppUserModelId` (deve bater com `build.appId`),
`createWindow` (loadFile de `../index.html`, preload de `preload.cjs` — ambos relativos a
`__dirname`, que em runtime é `out/`), menu de contexto nativo, e a **verificação de atualização**
no `whenReady` (notifica somente uma versão estável mais nova; `activate` só recria a janela
no macOS). A consulta é compartilhada com o card de configurações e reaproveitada por um minuto.

## 5. Mapa de funções (src/renderer.ts)

> As linhas abaixo são de referência; localizar por nome é mais seguro que por número.

- Helpers de DOM: `el` / `q` — **sempre usar em vez de `getElementById`/`querySelector`** (devolvem `CampoUI`)
- Confirmação e modo: `stopAgent` · `precisaConfirmar` · `maybeConfirmTool` · `askExecConfirm` · `resolveConfirm` · `showConfirmModal` · `hideConfirmModal` · `updateExecModeUI`
- Nível de raciocínio: `nivelThinkAtual` · `updateThinkUI` · `buildThinkMenu` · `fechaThinkMenu` · `recusouRaciocinio`/`avisaRaciocinioRecusado`/`valoresAceitosNoErro` (aviso só quando o servidor RECUSA de fato, no loop de tentativas do `agentTurns`)
- Painel de processos: `refreshProcesses` · `buildProcRow` · `renderProcessList` · `toggleProcOutput` · `stopProc` · `openProcessesModal` · `closeProcessesModal` · `clearFinishedProcesses`
- Chats e persistência: `scrollChat` · `forceScrollBottom` · `seguirAposCarregarImagens` · `setAppTitle` · `persist` · `migraSettings` · `loadPersisted` · `createChat` · `activeChat` · `renderChatList` · `beginRenameChat` · `renameActiveChat` · `switchChat` · `deleteChat` · `renderActiveChat` · `updateInputState`
- Render de mensagens/ferramentas: `renderMarkdownInto` · `appendMessage` · `renderUserMessage` · `attachMsgAction` · `editUserMessage` · `regenerateFromAssistant` · `appendInfo` · `logSystem` · `appendToolLog` · `TOOL_META` (ícone + rótulo) · `summarizeToolCall`/`summarizeToolResult` · `ERROS_NA_TELA`/`erroParaTela` (erro do modelo → uma linha em pt-BR; `hint` nunca vai à tela) · `appendToolCall` · `fillToolResult` · `attachDiff` · `renderDiffLines` · `attachToolShot` · `openImageViewer` · `renderToolInvocation` · `appendReasoning` · `appendError` · `appendErrorCard` · `showTyping` · `hideTyping`
- `truncate` · `formatFileWindow` · `clipMiddle` — **o renderer SÓ formata; o recorte da janela é no main**
- Núcleo do agente: `tools` (schemas) · `activeTools` · `visionEnabled` · `detectVision` · `recentShotIndexes` · `hydrateShots` · `comAlteracao` · `runTool` (executor, um case por tool) · `submitUserMessage` · `runAgent` (loop principal) · `compactarAgora` · `classificaErroDeRequisicao` · `streamChatCompletion` · `buildResponseStats` · `createLiveAgentBody` · `agentTurns` · `sanitizeToolCalls` · `compactToolResults` (poda do mais antigo, com folga `PODA_FOLGA` e marca `chat.podaAutoAte`; teto opcional `settings.historyCap`) · `toApiMessages` · `buildAttachmentBlock`
- Menções/anexos: `ensureMentionFiles` · `mentionScore` · `updateMentionMenu` · `renderMentionMenu` · `handleMentionKeydown` · `acceptMention` · `addMentionAttachment` · `readFileAsText` · `handleFiles` · `renderAttachments`
- Uso/config/workspace: `maybeRenameChat` · `trackUsage` · `renderUsage` · `fetchModels` (popula dropdown **e** cards da aba Visão geral via `updateModelInfo`; usa endpoint/chave DO FORMULÁRIO) · `pendenciaDaConexao` · `refreshModelContext` · `applySettingsToForm` · `updateVisionStatus` · `CAMPO_DA_SETTING`/`leSettingsDoFormulario`/`readSettingsFromForm` · `atualizaEstadoSalvamento` (selo de alteração pendente, comparando com `settingsSalvas`) · `encurtaCaminho` · `mostraCaminhoAtivo` · `registraPastaRecente` · `defineWorkspace` · `abreMenuPastas` (inclui lixeira dos recentes) · `wireEvents` · `loadAppInfo` (GitHub + versão + cards de produto) · `init`

### Ferramentas do agente (18)

| Tool | IPC no main |
|---|---|
| read_tool_result | Cache do renderer ou histórico persistido do chat (`history:`) |
| list_files / read_file / write_file / edit_file / search_files / create_directory / delete_file | list-files / read-file / write-file / edit-file / search-files / create-directory / delete-file |
| ask_user | **nenhum** — pergunta é UI pura (card com opções); o turno para até a resposta ou "Pular" |
| execute_command / read_process_output / wait_for_process / list_processes / stop_process | execute-command / read-process-output / wait-for-process / list-processes / stop-process |
| http_request / capture_page / web_search / fetch_url | http-request / capture-page / web-search / fetch-url |

Para adicionar uma: **quatro pontos** (main → preload+types.d.ts → `tools` → `runTool`+`TOOL_META`+
resumos+`CONFIRM_TOOLS` se destrutiva). Detalhes em CLAUDE.md.

## 6. Mapa da UI (index.html)

- **Sidebar**: `chat-list-container`, footer com `btn-github`, "pingo" de versão
  `#info-version-dot` (title preenchido por `loadAppInfo`), `btn-open-settings`
- **Header**: `active-chat-title`, `btn-processes` + `proc-badge`, pílula de contexto,
  `selected-path` + `btn-select-folder` + `folder-menu` (itens recentes têm lixeira `.trash-folder` funcional)
- **Chat**: `chat-box`, `mention-menu`, `attachments`, compositor (input, Auto/Manual, Raciocínio, Compactar)
- **Modal de config** (2 abas): `tab-geral` — cards do modelo ativo (`info-model-*`), uso
  (`usage-*`), **"Informação do produto"** (`#info-version` + `#info-product-name`);
  `tab-personalizacao` — `api-url`, `model-name`, `api-key`, sliders e toggles
- **Modais**: processos, confirmação de ferramenta, **pergunta do agente** (`#question-modal`,
  da `ask_user`), viewer de imagem
- Libs: `vendor/*.min.js` via `<script>` global (declarados em `Window`, types.d.ts);
  módulos do app: `out/renderer.js` + `out/constants.js` no fim do body

## 7. Estado atual (2026-08)

**Concluído (não commitado ainda):**
- ✅ Regra de idioma corrigida no ORIENTACAO/AGENTS.md: pt-BR para as pessoas, inglês para o
  modelo, resposta na língua de quem escreveu (o `system_prompt` e o CLAUDE.md já estavam certos)
- ✅ Renomeação `Pofuserver Coder Studio` → `Pofu Code Studio` (UI, docs, copyright, package.json,
  URLs do repo `Dspofu/Pofu-Code-Studio`); typecheck passou; `git remote` e a pasta local ficaram
  de propósito (o usuário renomeia a pasta depois)
- ✅ `ORIENTACAO.md` virou `AGENTS.md` (convenção aberta de instruções para agentes de IA)

**Concluído na sessão anterior** (validado com typecheck + build + teste funcional via harness
headless com stub de electronAPI):
- ✅ "Pingo" mostra a versão (`loadAppInfo` preenche `#info-version-dot` e `#info-version`)
- ✅ Cards "Informação do produto" (ID duplicado corrigido: `#info-product-name`)
- ✅ Notificação de dica no `whenReady` (funcionava só no macOS via `activate`; `console.log("ué")` removido)
- ✅ Lixeira dos recentes remove do `state.recentPaths` + `persist()` + reabre o menu
- ✅ `search_files` devolve `totalFound` (contagem total com cap de 10000)
- ✅ `execute_command`: idle só pós-primeira-saída + processo vivo (comando mudo/travado não vira PID); separadores `;` vs `&` documentados na descrição da tool
- ✅ Build separado: fonte em `src/`, saída em `out/` (main, preload, scripts do index.html, files do electron-builder, .gitignore)

**Aberto (decisão do usuário):**
- ⬜ Trocar o shell do Windows de `cmd.exe` para PowerShell — **recomendação: NÃO**.
  Medido: PowerShell 5.1 (padrão do Windows) rejeita `&&` com parser error e tem ~1s de
  start-up por comando; o cmd é instantâneo e aceita `&&`. A descrição da tool já ensina o
  separador certo por plataforma. Só trocar se o usuário insistir em `;` funcionar.

## 8. Regras de ouro (resumo — o porquê está em CLAUDE.md)

- pt-BR para as pessoas (UI, comentários, commits, docs); inglês para o modelo (system prompt,
  descrições das tools, `error`/`hint`/`note`); o agente responde na língua de quem escreveu (ver CLAUDE.md).
- `edit_file` para alterar existente; `write_file` só para arquivo novo.
  **CUIDADO COM CRLF**: `index.html`, `src/renderer.ts`, `src/constants.ts` e `README.md`
  usam CRLF — `edit_file` multi-linha com `\n` não casa. Solução: script Node que
  normaliza `\n`→`\r\n` no trecho (ou edição em linha única).
- `el()`/`q()` no renderer; DOM imperativo, sem framework de UI.
- **Comentar é exceção, não hábito**: só quando o porquê não se deduz da linha, quando há
  armadilha que alguém desfaria "consertando", quando o número veio de medição ou quando o
  comportamento é contraintuitivo. Nada de legenda do óbvio nem rótulo de seção. Constantes de
  `src/constants.ts` são a exceção que sempre leva motivo. Detalhe em CLAUDE.md → Convenções.
- Fonte em `src/`, build em `out/`: ao mover/adicionar arquivo compilável, confira os 5
  pontos (tsconfig include, `main` do package.json, `<script>` do index.html, `files` do
  electron-builder, `.gitignore`).
- Todo corte que vai ao MODELO (janela do `read_file`, saída de comando, poda do histórico)
  precisa dizer, em inglês, o que sumiu e como buscar o que falta — corte mudo faz o agente
  abandonar a ferramenta e ler tudo pelo terminal, gastando mais.
- Imagem que volta ao modelo (print do `capture_page` e anexo do usuário) passa por
  `save-attachment-image`/`read-image` + `shotCache` + `hydrateShots`, e o `hydrateShots`
  roda ANTES de montar o payload.
- `src/websearch.js`: não editar, não converter.
- README envelhece rápido: mudança visível ao usuário → atualizar README no mesmo commit.
- Git: branch `main`, mensagens pt-BR com prefixo (`feat:`, `fix:`, `docs:`, `update:`);
  release = tag `vX.Y.Z` **batendo com o `version` do package.json** (o CI confere e falha antes do build).

## Atualização de setembro de 2026

- Layout Pofu com ícone original, paleta verde, atalhos de início e compositor reorganizado.
- Leitura completa quando cabe, continuação exata nos demais casos; sem arquivos temporários.
- Resultados grandes em JSON válido, consulta por cursor/termo via `read_tool_result`.
- Busca paginada com coluna e trecho centrado na ocorrência. Logs retêm até 2 Mi caracteres
  por stream e informam perdas; processos rápidos também ficam consultáveis.
- Compactação preserva os resultados mais novos e permite consultar o histórico original.

## Comandos do compositor

`src/slash-commands.ts` mantém catálogo, aliases, parser e menu acessível por teclado.
`executeSlashCommand` no renderer chama as ações locais existentes; `sendMessage`
intercepta comandos antes de consumir anexos ou enviar à API. Os comandos de pedido
preparam texto, sem envio automático. Preserve IME, Shift+Enter e as menções `@`.
Os testes estão em `scripts/slash-commands.test.mjs` e na integração Electron.

## Leitura e menções: setembro de 2026

`read_file.query` localiza trechos sem percorrer janelas; `search_files.context_lines`
devolve linhas vizinhas e `list_files.recursive` lista caminhos em uma chamada.
Use `workspacePath` para aceitar caminhos relativos e absolutos dentro do projeto.
Resultados paginados guardam a saída íntegra em `ChatMessage.retainedResult`, somente
no histórico local: preserve a exclusão desse campo em `toApiMessages`.
O destaque azul usa uma camada atrás do textarea nativo; sincronize-a após mudanças
programáticas de valor ou tamanho. Menções com espaços usam `@"caminho com espaços"`.

## Ferramentas e tokens: setembro de 2026

Revisão com o Hermes Agent como referência (detalhes e medições em CLAUDE.md e README).
- Busca e listagem vão ao modelo em **texto** (`tool-output.ts`), não JSON. O IPC continua
  estruturado; quem formata é o renderer. Testes de integração leem o texto.
- `ToolResultStore.encode` aceita string e guarda como está; `restore` aceita texto que não
  é JSON. Não volte a passar texto por `JSON.stringify` antes de guardar.
- `runTool(name, args, workspace, toolCallId)`: o id alimenta `leiturasEntregues` (releitura
  sem mudança vira aviso). Sem id, não há deduplicação — é o caso do harness de testes.
- `arquivosLidos` é `Map<chave, mtimeMs>` com `chaveArquivo` (minúsculas quando o caminho tem
  letra de unidade). Todo handler que grava devolve `mtimeMs`, e o renderer atualiza o mapa.
- Cada caractere de `tools`/`system_prompt` vai em toda requisição: meça com um script antes
  de alongar uma descrição, e não repita no prompt o que a descrição da ferramenta já diz.

## Provedores e thinking

`Settings.providers` guarda endpoint, chave, modelo e thinking por perfil; os campos
antigos continuam como espelho do perfil ativo. `rememberProvider` sincroniza esse
espelho antes de persistir. O modal edita cópias e só aplica em Salvar. Preserve a
proteção contra respostas atrasadas da descoberta e bloqueie trocas durante geração.
`muito_alto` envia `xhigh`; `maximo` envia `max`. O seletor é horizontal e deriva de
`THINK_LEVELS`. Ao adaptar um nível recusado, confira o payload enviado na tentativa
seguinte, não apenas o aviso. Regressões em `providers.test.mjs` e `test-electron.cjs`.
