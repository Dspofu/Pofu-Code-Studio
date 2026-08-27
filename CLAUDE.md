# CLAUDE.md

Orientações para o Claude Code trabalhar neste repositório.

## O que é o projeto

**Pofuserver Coder Studio** — app desktop Electron que é um *agente de código*: conecta-se a
qualquer API REST compatível com OpenAI (llama.cpp, Ollama, vLLM…) e dá ao modelo ferramentas
para ler/escrever/editar/apagar arquivos do workspace, buscar por conteúdo no projeto, rodar
comandos no terminal (com processos em segundo plano), chamar APIs por HTTP, tirar print de
páginas web, pesquisar na web e anexar arquivos ao chat.

Idioma do projeto: **português**. Commits, comentários, prompts e UI são em pt-BR — mantenha isso.

## Estrutura

| Arquivo | Papel |
|---|---|
| [src/main.ts](src/main.ts) | Processo *main* do Electron. Todos os `ipcMain.handle` (fs, spawn de comandos, store, web search/fetch), janela e menu. |
| [src/preload.cts](src/preload.cts) | Ponte `contextBridge` → `window.electronAPI`. Toda nova capacidade do main precisa ser exposta aqui. É `.cts` porque o preload é CommonJS (sai como `preload.cjs`). |
| [index.html](index.html) | UI inteira: Tailwind (vendorizado), `<style>` grande no topo, markup e modais. Carrega `out/renderer.js` ao final. |
| [src/renderer.ts](src/renderer.ts) | Cérebro do renderer: estado dos chats, loop do agente, definição das `tools`, streaming, execução de tool calls, render de mensagens. |
| [src/constants.ts](src/constants.ts) | `system_prompt`, `DEFAULT_SETTINGS` e os limites, todos comentados com o *porquê*: janela de leitura derivada do contexto, orçamento de histórico, prints por requisição, retries e trava de loop. |
| [src/types.d.ts](src/types.d.ts) | Tipos GLOBAIS (o arquivo não exporta nada de propósito): `Settings`, `Chat`, `ChatMessage`, `ElectronAPI`, `ProcEntry`. Main e renderer os enxergam sem importar. |
| [src/websearch.js](src/websearch.js) | **Arquivo gerado** — não edite, e não converta para `.ts`. Saída do `tsc` sobre o módulo portátil `…/chat/src/lib/websearch.ts`, mantido em OUTRO repositório. Os tipos dele estão em [src/websearch.d.ts](src/websearch.d.ts). |
| `vendor/` | Libs offline do RENDERER (tailwind, marked, purify, highlight). Sem CDN. |
| `build/`, `dist/` | Recursos e saída do electron-builder. |

## Comandos

```bash
npm run build     # tsc: emite a saída em out/ (fonte em src/)
npm run typecheck # só checagem, sem emitir
npm start         # build + electron --no-sandbox . --ozone-platform=x11
npm run dist      # build + empacota .deb + .nsis
npm run dist:linux   # só o .deb
npm run dist:fedora  # só o .rpm — exige o rpmbuild (Ubuntu: apt install rpm; Fedora: dnf install rpm-build)
npm run dist:win     # só o .exe (NSIS)
```

Não há testes nem linter. Verificação = `npm run typecheck` + rodar o app e exercitar o fluxo alterado.

## TypeScript / layout do build

Toda a fonte compilável vive em `src/` (por isso `main.ts` e `preload.cts` foram movidos
para lá) e o `tsconfig.json` emite em **`out/`** (`rootDir: "src"`, `outDir: "out"`):
`src/main.ts → out/main.js`, `src/preload.cts → out/preload.cjs`, `src/renderer.ts →
out/renderer.js`. O `main` do package.json é `out/main.js`, o index.html carrega
`out/renderer.js` e o electron-builder empacota `out/**`. O `out/` é gerado e ignorado
pelo git; `prestart`/`predist` rodam o build antes. `src/websearch.js` é fonte
versionada (gerada noutro repositório) e vai junto no `out/` por estar dentro do rootDir.

A checagem é **frouxa de propósito** (`strict: false`, `noImplicitAny: false`,
`strictNullChecks: false`): a base veio de ~5 mil linhas de JS de DOM imperativo e ligar
`strict` de uma vez daria centenas de erros. Apertar isso é trabalho arquivo a arquivo, não
um flag no config.

No renderer, use os helpers `el(id)` e `q(seletor, raiz)` em vez de
`document.getElementById`/`querySelector` — eles devolvem `CampoUI` (um `HTMLElement` com as
propriedades de campo opcionais), que é o que evita um cast em cada uma das ~120 buscas.

## Fluxo de uma alteração no agente

Uma ferramenta nova exige tocar em **quatro** pontos, na ordem:

1. `ipcMain.handle('nome', …)` em [src/main.ts](src/main.ts)
2. exposição em [src/preload.cts](src/preload.cts) — e a assinatura em `ElectronAPI`, em [src/types.d.ts](src/types.d.ts)
3. entrada no array `tools` em [src/renderer.ts:1328](src/renderer.ts#L1328) (schema JSON enviado ao modelo)
4. o `case` no executor `runTool` ([src/renderer.ts:1684](src/renderer.ts#L1684)), a entrada em
   `TOOL_META` ([src/renderer.ts:810](src/renderer.ts#L810)) e os `switch` de rótulo/resumo em
   [src/renderer.ts:830](src/renderer.ts#L830) e [src/renderer.ts:873](src/renderer.ts#L873)

Esquecer o passo 4 gera tool call que "funciona" mas aparece cru na UI.

## README — mantenha atualizado

O [README.md](README.md) é a vitrine do projeto e **envelhece rápido**: quando foi reescrito,
metade das ferramentas do agente não estava documentada lá. Toda alteração que muda o que o
usuário vê ou pode fazer exige atualizar o README **no mesmo commit**:

- ferramenta nova, renomeada ou removida → tabela de ferramentas
- funcionalidade ou opção nova na UI → seção correspondente + captura, se for visual
- mudança em requisitos, instalação ou configuração → as seções respectivas

As imagens ficam em `docs/img/` e são geradas do app REAL (nunca mockup). Se a interface
mudou, refaça a captura afetada em vez de deixar a antiga: print desatualizado engana mais
que a ausência dele.

## Convenções

- ES modules (`"type": "module"`) no main; renderer também usa `type="module"`.
- Sem framework de UI: DOM imperativo (`document.createElement`). Siga o padrão dos
  `render*`/`build*` existentes em vez de introduzir templates ou libs.
- Comentários explicam **por quê**, não o quê — veja [src/constants.ts](src/constants.ts), que
  documenta o motivo de cada limite (ex.: `maxTokens` alto porque modelos de raciocínio gastam
  orçamento no bloco de think e cortam o JSON do tool call). Mantenha esse estilo ao mexer em
  qualquer constante ou heurística.
- Mudanças de comportamento do agente quase sempre significam ajustar o `system_prompt` em
  [src/constants.ts](src/constants.ts) — não espalhe instruções pelo renderer.

## Armadilhas conhecidas

- **Leitura paginada**: `read_file` devolve janelas de linhas com aviso de `offset`. Não volte a
  truncar em silêncio — foi a causa de o modelo apagar arquivos ao reescrevê-los. A janela é
  recortada no **main**; o renderer só formata (`formatFileWindow`). Não volte a mandar o arquivo
  inteiro pelo IPC. O tamanho da janela NÃO é constante: `readCharBudget(n_ctx)` tira uma fatia
  do contexto do modelo em uso, porque um número fixo é pequeno demais num modelo de 65k e
  grande demais num de 8k.
- **`edit_file` antes de `write_file`**: alterar arquivo existente é trabalho de `edit_file`
  (troca de trecho exato). Reescrever tudo com `write_file` gasta tokens de saída à toa e a
  geração é cortada no meio, truncando o arquivo. O prompt e as descrições das ferramentas
  reforçam isso — não afrouxe.
- **Prints e visão**: `capture_page` abre a URL numa `BrowserWindow` oculta (`offscreen: true`,
  necessário para o `capturePage()` não sair em branco) e devolve `{ text, image }`. O PNG vai
  para `userData/screenshots`; no histórico fica só o **caminho** (o base64 mora em `shotCache`,
  em memória) — persistir o base64 inflaria o `app-store.json`. O reenvio ao modelo só acontece
  quando o `/v1/models` anuncia `capabilities: multimodal` (`detectVision`): mandar `image_url`
  para modelo de texto derruba a requisição inteira. `full_page` aumenta a janela até a altura do
  documento antes de capturar — sem ele o agente valida só a primeira dobra e declara "tudo
  certo" sem ter visto o rodapé. Só os `MAX_VISION_IMAGES` prints mais
  recentes voltam, porque cada imagem custa milhares de tokens de visão.
- **HTTP 500 do llama.cpp**: tool call malformado é transitório; existem `MAX_REQUEST_RETRIES`
  e limpeza do histórico. Preserve esse tratamento ao mexer no loop de request.
- **Compactação de contexto** (`compactToolResults`): sem ela o histórico cresce até estourar
  o `n_ctx` e a sessão morre. Duas regras que não podem cair: a mensagem `tool` nunca é
  REMOVIDA (um `tool_call` órfão faz o servidor recusar a requisição inteira, só o `content`
  é trocado), e a poda vale só para o **payload** — `chat.messages` continua íntegro em disco
  e na tela. O orçamento desconta o prompt de sistema e `maxTokens` do `n_ctx`; por isso
  `runAgent` faz `await refreshModelContext()` na primeira requisição — sem o `n_ctx` a poda
  não teria como dimensionar nada, justamente na conversa longa recém-reaberta.
- **Escrita sem leitura**: `write_file` recusa sobrescrever arquivo existente que não está em
  `arquivosLidos` (a checagem mora no main, junto da escrita, para não haver intervalo entre
  verificar e gravar). Criar arquivo novo passa livre. O conjunto zera ao trocar de chat.
- **Janela de console no Windows**: `windowsHide: true` sozinho NÃO esconde nada quando o
  spawn também usa `detached: true`. `detached` vira `DETACHED_PROCESS`, e o `CreateProcess`
  ignora o `CREATE_NO_WINDOW` (o que o `windowsHide` liga) quando os dois vêm juntos — sem
  console herdado e sem o flag de esconder, o `cmd.exe` aloca um console PRÓPRIO e visível.
  Medido: `detached:true + windowsHide:true` abre 2 janelas por comando; `detached:false +
  windowsHide:true` abre 0. Por isso o `execute-command` só usa `detached` fora do Windows —
  os dois motivos do `detached` são POSIX (sudo e grupo de processos), e quem derruba a
  árvore no Windows é o `taskkill /T` do `killTree`. Não volte a ligar `detached` lá.
- **Processos longos**: comandos que passam de `cmdTimeout` viram background e retornam PID,
  acompanhados por `read_process_output`/`stop_process`. Não converta isso em execução bloqueante.
  `wait_for_process` existe para o agente ESPERAR num turno só: sem ele, o modelo chamava
  `read_process_output` em looping ("já acabou?"), gastando o contexto inteiro num `npm install`.
  A detecção de "servidor ocioso" só arma o cronômetro DEPOIS da primeira linha de saída e só
  backgroundiza se o processo ainda estiver vivo — comando mudo/travado (ex.: `git status` num
  disco lento) termina no `close` e devolve a saída direto, sem virar PID à toa.
- **Shell por plataforma**: no Windows o comando roda no `cmd.exe` (`;` vira argumento; use
  `&`/`&&`), em Linux/macOS no `bash` (`;` e `&&` ok). A descrição da tool já documenta isso.
  Não troque para PowerShell: o 5.1 do Windows rejeita `&&` com parser error e tem ~1s de
  start-up por comando (medido).
- **Diff e desfazer**: toda escrita/edição/remoção grava um instantâneo em
  `userData/instantaneos` e devolve `snapshotId` + `diff`. O diff é do USUÁRIO — `comAlteracao`
  o remove do que vai ao modelo, senão cada edição custaria em contexto o dobro do arquivo. No
  histórico fica só o `snapshotId` (o `antes`/`depois` mora no instantâneo, e `get-diff`
  remonta na recarga). O desfazer também cria um instantâneo, e é isso que permite refazer.
  `calculaDiff` apara prefixo/sufixo iguais ANTES do LCS — sem isso a matriz teria o tamanho do
  arquivo e travaria o main —, mas depois reinsere esse entorno como contexto, senão o diff vira
  uma lista de linhas soltas.
- **Falha de requisição**: `classificaErroDeRequisicao` traduz o erro em causa + passos e diz se
  vale repetir. Só 5xx é transitório; servidor fora do ar, 401 e 404 falham igual nas três
  tentativas e só atrasam o diagnóstico. Não volte a mostrar a exceção crua.
- **Confirmação**: `CONFIRM_TOOLS` (`execute_command`, `delete_file`, `http_request` fora de
  GET/HEAD/OPTIONS) e `execMode` `manual`/`auto` controlam o modal de aprovação. O valor pode ser
  `true` ou um teste sobre os argumentos. Ferramentas destrutivas novas devem entrar aí — e quem
  ganhar rótulo próprio no modal precisa de um `else if` em `showConfirmModal`.
- **Busca na web**: buscador NÃO se raspa por `fetch`. Medido em 01/08/2026: DuckDuckGo e
  Startpage devolvem 202/captcha e o Bing cai num muro de consentimento — mas o MESMO
  DuckDuckGo responde normalmente dentro de uma `BrowserWindow` oculta. Por isso o provedor
  `ddg-navegador` (via `comJanelaOculta`) entra em `extraProviders` e é o que ganha na prática;
  os scrapers HTTP ficam como reserva para outras redes. Não troque isso por `fetch` "para
  simplificar" — volta a falhar. A instância de `WebSearch` é única de propósito: cache e
  cooldown por provedor só servem se sobreviverem entre as buscas.
- **`loadURL` sem prazo trava**: ele só resolve no `did-finish-load`; numa página que nunca
  termina de carregar (anúncio pendurado, websocket) fica preso PARA SEMPRE e o tool call do
  agente nunca retorna. Todo `loadURL` aqui corre contra um `sleep` e chama `stop()` no
  estouro, aproveitando o que já renderizou.
- **`depends` substitui o default**: declarar `depends` em `build.rpm`/`build.deb` no
  package.json TROCA a lista inteira do electron-builder — não acrescenta. O default do rpm
  inclui `at-spi2-core` e `libuuid`, que são `NEEDED` de verdade do binário do Electron
  (`libatspi.so.0`, `libuuid.so.1`); sem eles o `dnf install` conclui e o app não abre num
  Fedora enxuto (Server, spin, toolbox) — no Workstation passa despercebido porque já vêm
  instalados. Compare com o default antes de mexer nessa lista.
- **Ícone no Windows vem de dois lugares**: a JANELA lê o ícone embutido no `.exe` (o
  `build/icon.ico`, gravado pelo electron-builder), mas a BARRA DE TAREFAS e as
  NOTIFICAÇÕES resolvem pelo AUMID → atalho do Menu Iniciar. Por isso um ícone pode estar
  certo na janela e errado nos outros dois ao mesmo tempo — não é defeito do `.ico`. O
  `setAppUserModelId` usa um AUMID **diferente em dev**: o toast do Windows exige um
  atalho carregando o AUMID e, quando não existe, o Electron cria um apontando para o
  `electron.exe` do `node_modules`. Com o AUMID de produção, esse atalho de dev disputa a
  resolução com o do instalador e VENCE (é mais antigo), e aí o app instalado exibe o
  ícone do Electron. Se acontecer de novo: apague o `.lnk` órfão em
  `%APPDATA%\Microsoft\Windows\Start Menu\Programs\` e confira com `Get-StartApps`.
- **Fila de mensagens** (`filaMensagens`/`drenaFila`): mensagem escrita durante a geração
  NÃO entra no histórico na hora — cairia no meio de um par `tool_call`/`tool` e o servidor
  recusaria o payload inteiro pelo `tool_call` órfão. Ela espera a virada de turno, no topo
  do `while` do `agentTurns`, único ponto em que toda chamada já tem a sua resposta. Entrega
  de mensagem zera `iterations`: a trava existe contra o agente em looping, não contra a
  conversa. Não converta isso em envio imediato.
- **Tela parada durante o tool call**: os argumentos da ferramenta não passam por
  `onContent`, então sem o `onToolCall` a UI fica congelada do fim do texto até o resultado
  — num `write_file` grande, dezenas de segundos que parecem travamento. O
  `criaCardFerramentaViva` desenha o progresso a partir do JSON **ainda incompleto**
  (`criaLeitorStringJson`, que guarda escape partido entre deltas). O trabalho roda uma vez
  por quadro e só sobre o pedaço novo, pelo mesmo motivo de custo O(n²) do
  `criaEscritorStream` — não passe a varrer o acumulado inteiro a cada delta.
- **Servidor local**: a porta e o modelo do llama.cpp variam — confirme com o usuário antes de
  assumir `http://localhost:8080/v1`.

## Git

Branch principal: `main`. O usuário costuma pedir "commit" significando commit + push na `main`.
Mensagens em português, com prefixo (`feat:`, `fix:`, `docs:`, `update:`).
