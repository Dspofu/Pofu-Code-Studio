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
OpenAI (llama.cpp, Ollama, vLLM) e dá ao modelo 17 ferramentas para mexer num workspace
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

**Não há testes nem linter.** Validação = `npm run typecheck` + rodar o app e exercitar o fluxo
alterado. TS é frouxo de propósito (`strict: false`) — ver tsconfig.json para o porquê.

## 4. Mapa dos IPC handlers (src/main.ts)

Cada um tem correspondente 1:1 em `src/preload.cts` e assinatura em `ElectronAPI` (`src/types.d.ts`).

| Handler | O que faz |
|---|---|
| `select-folder` | Diálogo de pasta |
| `list-files` | Lista arquivos **com tamanho** (evita round-trip para o agente decidir se lê) |
| `read-file` | Leitura em **janelas** — recorte por `readCharBudget(n_ctx)` mora aqui |
| `get-diff` / `undo-change` | Remonta diff de instantâneo / desfaz (e grava outro instantâneo → refazer) |
| `write-file` / `delete-file` | **Trava**: recusa sobrescrever/apagar arquivo não lido (`arquivosLidos`) |
| `edit-file` | Troca de trecho exato, `replaceAll` opcional |
| `create-directory` | Cria pasta |
| `get-app-info` | Lê `package.json` (`../package.json`, pois main roda de out/): githubUrl, version, name |
| `search-files` | Busca texto/regex com filtro glob; devolve `totalFound` (contagem total, cap 10000) além de `matches` (limitados a max) |
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
`__dirname`, que em runtime é `out/`), menu de contexto nativo, e a **notificação de dica**
no `whenReady` (uma por abertura; `activate` só recria a janela no macOS).

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

### Ferramentas do agente (17)

| Tool | IPC no main |
|---|---|
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
