# CLAUDE.md

Orientações para o Claude Code trabalhar neste repositório.

## O que é o projeto

**Pofu Code Studio** — app desktop Electron que é um *agente de código*: conecta-se a
qualquer API REST compatível com OpenAI (llama.cpp, Ollama, vLLM…) e dá ao modelo ferramentas
para ler/escrever/editar/apagar arquivos do workspace, buscar por conteúdo no projeto, rodar
comandos no terminal (com processos em segundo plano), chamar APIs por HTTP, tirar print de
páginas web, pesquisar na web e anexar arquivos ao chat.

Idioma: **pt-BR para as pessoas, inglês para o modelo**. Commits, comentários, documentação e
UI são em português — mantenha isso. Já tudo que é ENVIADO ao modelo (o `system_prompt`, as
descrições das ferramentas e seus parâmetros, e os `error`/`hint`/`note` que voltam de uma tool
call) é em **inglês**, porque é a língua em que os modelos foram treinados a seguir instrução e
a chamar ferramenta. O agente **não é preso a idioma nenhum**: o prompt manda responder na língua
de quem escreveu, porque o app é usado fora do Brasil — não volte a fixar pt-BR ali. Ao mexer
nessas strings, olhe para quem elas vão: card de ferramenta, modal e mensagem de erro na tela
são da INTERFACE e continuam em pt-BR.

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
- **Comentário só quando é necessário.** O padrão é NÃO comentar: código claro não precisa de
  legenda, e comentário genérico é ruído que ainda envelhece errado — quando o código muda e a
  legenda fica, ela passa a mentir. Escreva um comentário quando a resposta for sim a alguma
  destas: o *porquê* não se deduz lendo a linha? há uma armadilha que faria alguém "consertar"
  isso de volta? o número saiu de uma medição? o comportamento é contraintuitivo (ordem que
  importa, efeito colateral, limitação de servidor)? Se for não, não comente.
  Não escreva: o que a linha já diz (`// cria o elemento` sobre um `createElement`), rótulo de
  seção (`// ---- helpers ----`), nome repetido em prosa, nem passo a passo do óbvio.
  Veja [src/constants.ts](src/constants.ts) para o tom: cada limite diz o motivo de existir
  (ex.: `maxTokens` alto porque modelo de raciocínio gasta orçamento no bloco de think e corta
  o JSON do tool call). Mantenha esse estilo ao mexer em constante ou heurística — e prefira
  UM comentário que explique a decisão a vários espalhados narrando a implementação.
- Mudanças de comportamento do agente quase sempre significam ajustar o `system_prompt` em
  [src/constants.ts](src/constants.ts) — não espalhe instruções pelo renderer.

## Armadilhas conhecidas

- **Leitura paginada**: `read_file` devolve janelas de linhas com aviso de `offset`. Não volte a
  truncar em silêncio — foi a causa de o modelo apagar arquivos ao reescrevê-los.
  **Linha maior que a janela inteira** (minificado, JSON numa linha) pagina por `char_offset`,
  que retoma a MESMA linha de onde parou — e o rodapé entrega o número pronto. Avisar não
  bastava: a versão anterior dizia o tamanho real da linha e mandava buscar o resto com
  `cut`/`sed`, ou seja, a ferramenta ensinava o agente a abandoná-la. Medido com modelo real
  sobre um bundle de uma linha de 90 mil caracteres: duas leituras e ele passou a ler o arquivo
  por `execute_command` (`node -e`), o que custa mais tokens, mais turnos e enche o projeto de
  rascunho. Não volte a fechar essa saída: **todo corte que vai ao MODELO precisa de um jeito de
  buscar o que sumiu, não só do aviso de que sumiu** — e esse jeito não pode ser o terminal.
  `search_files` é o par disso: devolve a `column` do casamento, que é o `char_offset` para ir
  direto ao trecho, e recorta a linha CENTRADA no casamento (recortar do começo devolvia um
  resultado que nem continha o termo procurado). A janela é
  recortada no **main**; o renderer só formata (`formatFileWindow`). Não volte a mandar o arquivo
  inteiro pelo IPC. O tamanho da janela NÃO é constante: `readCharBudget(n_ctx)` tira uma fatia
  do contexto do modelo em uso, porque um número fixo é pequeno demais num modelo de 65k e
  grande demais num de 8k.
- **Caminho vindo do modelo**: as cinco ferramentas de arquivo passam por `caminhoNoWorkspace`
  no renderer, e a trava de leitura usa `chaveArquivo`. Não volte a concatenar
  `` `${workspace}/${args.filename}` `` cru: um caminho ABSOLUTO — que é o que o prompt de
  sistema mostra ao modelo e o que o usuário cola no chat — virava `C:/ws/C:/ws/arquivo` e a
  leitura respondia "File not found", erro que o modelo não tem como diagnosticar. Pior, a chave
  de `arquivosLidos` saía da mesma concatenação: ler `./x.ts` e escrever `x.ts` eram chaves
  diferentes, então a trava acusava "not been read" logo depois da leitura, e a saída que o
  modelo achava era o shell. Normalizar num ponto só é o que faz as cinco ferramentas
  concordarem sobre o que é "o mesmo arquivo".
- **`edit_file` antes de `write_file`**: alterar arquivo existente é trabalho de `edit_file`
  (troca de trecho exato). Reescrever tudo com `write_file` gasta tokens de saída à toa e a
  geração é cortada no meio, truncando o arquivo. O prompt e as descrições das ferramentas
  reforçam isso — não afrouxe.
- **A substituição do `edit_file` é `split/join`, nunca `replace`**: mesmo com pattern string,
  o `String.prototype.replace` continua expandindo `$&`, `` $` ``, `$'`, `$1` e `$$` DENTRO do
  texto de substituição. Um `new_text` com `$$var` (PHP, sed, LaTeX) era gravado corrompido e
  ainda voltava `success: true` — erro silencioso, do tipo que só aparece muito depois. O
  `split(alvo).join(troca)` é literal e serve aos dois modos, porque o caso ambíguo já saiu
  antes com erro.
- **Quebra de linha do `edit_file`**: o `read_file` entrega as linhas de um arquivo CRLF com o
  `\r`, e o modelo copia o trecho sem ele — a busca exata nunca casava, e a dica ainda mandava
  reler, num vaivém que não convergia. Por isso a busca é refeita com o `old_text` convertido
  para CRLF, e o `new_text` é normalizado para a quebra do arquivo **mesmo quando o `old_text`
  casou de primeira**: trecho de uma linha só não passa pelo fallback, e gravar LF no meio de um
  arquivo CRLF deixa quebras misturadas que quebram a edição SEGUINTE.
- **Imagem anexada pelo usuário usa o MESMO caminho do print**: bytes em
  `userData/screenshots` (com a poda de lá), caminho no histórico, data URL no `shotCache`
  e bloco `image_url` no `toApiMessages`. Não volte a mandar a MINIATURA no lugar dos
  pixels: ela tem 140 px e serve ao chip da UI; o modelo não leria nada nela. E o
  `hydrateShots` precisa rodar ANTES de montar o payload — inverter a ordem faz a imagem
  sumir da conversa depois de reabrir o app (o cache começa vazio e o payload sai sem ela).
  Sem os pixels o modelo não desiste: medido, ele instalou o Pillow com `pip` e escreveu um
  OCR em Python para responder sobre a imagem — 32 requisições contra 1.
- **`imagemPath` NÃO é o `path` do anexo**: o `path` de um `Attachment` já era o caminho
  relativo da MENÇÃO (@arquivo). Reaproveitá-lo para a imagem fez o app mandar um `.md`
  rotulado como PNG, e o servidor recusa a REQUISIÇÃO INTEIRA com 400 ("Failed to load
  image or audio file") — três tentativas e a conversa morre, com a mensagem sem relação
  nenhuma com o arquivo mencionado. Por isso o campo da imagem tem nome próprio e o
  `read-image` confere a assinatura do arquivo (PNG/JPEG/GIF/BMP/WEBP) antes de devolver:
  imagem faltando é ruim, turno morto é pior.
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
  Três decisões da poda existem por causa do CACHE DE PREFIXO, e desfazer qualquer uma delas
  custa dinheiro sem aparecer na tela: (1) encurta do MAIS ANTIGO para o mais novo — a versão
  original andava do fim para o começo e preservava o início da conversa, o oposto do que o
  comentário dizia; (2) quando dispara, desce até `PODA_FOLGA` do orçamento em vez do mínimo
  que cabe; (3) grava até onde podou em `chat.podaAutoAte` — o que foi encurtado CONTINUA
  encurtado. Sem a marca, cada turno recalcula o corte do zero, a fronteira anda alguns
  tokens por requisição e o prefixo muda sempre. Medido nas conversas reais do próprio app
  (chat de 270 requisições, teto de 64k): com a marca, 5 requisições mudam o prefixo; sem
  ela, 160 — e a conta com desconto de cache chegava a ficar MAIOR que a de não podar nada.
  O `historyCap` (Ajustes) só APERTA o orçamento, nunca afrouxa: com `n_ctx` de 262k a poda
  nunca dispararia e cada requisição reenviaria o histórico inteiro — ~30 milhões de tokens
  de prompt num único chat medido. Vem desligado porque em servidor local podar só faz o
  servidor reprocessar de graça.
  **A janela do `read_file` acompanha o teto** (`readCharBudget` recebe o `historyCap`
  quando ele existe, não só o `n_ctx`). Sem esse acoplamento a leitura podia ser MAIOR que o
  histórico inteiro: o arquivo era encurtado no turno seguinte ao de ter sido lido e o agente
  relia o mesmo trecho para sempre. Medido em execução real, mesma tarefa e temperatura 0:
  sem teto, 6 requisições e 130k tokens; com teto de 8k e sem o acoplamento, 44 requisições e
  503k; com o acoplamento, 24 e 262k. Ou seja: teto apertado ainda é ruim, mas deixou de ser
  catastrófico. Numa sessão longa com teto sensato (64k) a mesma tarefa custou 19% menos que
  sem teto. Cuidado com o número simulado: replay de conversa gravada NÃO modela o agente
  mudando de comportamento, e foi por isso que a primeira estimativa (-50%) ficou otimista.
  Limite conhecido: mensagens do ASSISTENTE não são podadas (só as `tool`), então o
  `content` e os argumentos de `tool_call` — o conteúdo de um `write_file`, por exemplo —
  formam um piso que a poda não alcança; nas conversas medidas esse piso chegou a 59k tokens.
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
- **Saída de comando cortada**: `execute_command`/`read_process_output`/`wait_for_process`
  passam a saída pelo `cortaSaida` (corte no meio, `MAX_CMD_STDOUT_CHARS`/`MAX_CMD_STDERR_CHARS`).
  O marcador é em INGLÊS e diz o que fazer ("re-run narrowing the output with head/tail/findstr"),
  porque quem lê é o modelo: com o marcador mudo ele repetia o comando despejando em arquivo.
  Os tetos eram 3000/2500 e cortavam a saída de um `dir` ou de um teste no meio — economia que
  saía cara, porque o contorno gastava mais tokens do que o corte poupava.
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
- **Espera de contexto frio**: a primeira requisição de um chat REABERTO reprocessa o
  histórico inteiro no servidor, sem cache — medido em 177s num chat de 123k tokens, com
  três pontinhos na tela o tempo todo. Por isso `showTyping` aceita o tamanho do prompt e
  troca o indicador por um aviso com cronômetro quando o chat ainda não foi "aquecido"
  (`chatsAquecidos`, que vive só na memória: reabrir o app zera o cache do servidor junto).
  A estimativa de tokens é grosseira de propósito — contar caracteres deu 99k onde o
  servidor cobrou 123k —, então ela aparece arredondada e com "≈". O `renderActiveChat` é
  `async` pelo mesmo motivo: a montagem trava o renderer por segundos numa conversa longa,
  e o aviso precisa ser pintado ANTES de ela começar.
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
- **Configurações no boot**: o `init` chama `applySettingsToForm()` ANTES do `fetchModels()`.
  O `fetchModels` lê o endpoint do campo `#api-url`, e esse campo nasce com o valor fixo do
  index.html; enquanto o formulário só era preenchido ao ABRIR as configurações, a consulta da
  abertura ia para `localhost:8080` em vez do endpoint salvo — de calado, quando havia algo
  respondendo lá. É essa ordem que faz `n_ctx`, visão e níveis de raciocínio chegarem certos já
  na primeira mensagem. O `migraSettings` também valida o que veio do disco (store é JSON
  editável): endpoint vazio, `thinkLevel` que não existe mais, número fora de faixa.
- **Detecção do raciocínio**: não existe campo padrão no `/v1/models` para isso — quem responde
  são as `capabilities` (Ollama anuncia `thinking`), o `chat_template` do `/props` do llama.cpp
  e o `/api/show` do Ollama. Três situações diferentes, e juntá-las estraga o menu: detectou
  algo → só o confirmado; leu o template e ele não fala de raciocínio → só *Padrão*; não leu
  nada → mostra tudo, porque silêncio não é prova de que não suporta. A sonda roda uma vez por
  par endpoint+modelo: o `refreshModelContext` é chamado a cada requisição.
- **Erro de ferramenta na tela é pt-BR, e o `hint` NUNCA aparece**: o `error`/`hint` que volta
  de uma tool call é escrito para o MODELO — o `hint` é a instrução do próximo passo ("call
  read_file and try again"). Despejar esse bloco no card enchia a conversa de alerta vermelho
  em inglês, muitas vezes por uma trava que o próprio agente resolve na chamada seguinte. O
  `erroParaTela` (tabela `ERROS_NA_TELA`) traduz em UMA linha; o resultado que vai ao modelo
  continua íntegro. Erro sem tradução cai no texto cru — esconder a falha seria pior. O
  prefixo escolhe o tom: `↷` é orientação (o agente se corrige sozinho) e só o `⚠` é pintado
  de vermelho pelo `fillToolResult`. Mensagem nova do main que o usuário possa ver pede uma
  linha nessa tabela.
- **Aviso de raciocínio só depois do erro REAL**: a tentação é avisar antes de enviar, olhando
  o que o `/models` deixou de anunciar — e foi o que se fez primeiro. Só que servidor que
  aceita o campo caladamente é comum, e o aviso passou a aparecer em toda conversa sem nada
  ter dado errado (medido no llama.cpp da porta 5001: nível *Alto* responde 200 e o aviso
  preventivo mentia). Agora quem decide é a resposta: `recusouRaciocinio` só aceita 4xx/5xx
  cujo corpo cite `reasoning_effort`/`enable_thinking`/`chat_template_kwargs` — com espaço ou
  hífen também, porque o llama.cpp devolve a exceção do Jinja ("Unexpected reasoning effort
  max"), sem o nome do campo da API. Aí o campo sai do payload (`thinkRecusado`), a MESMA
  mensagem é reenviada e o aviso cita a resposta do servidor, que costuma listar os valores
  aceitos. Não volte a avisar por suspeita, e não deixe o turno morrer por causa de uma opção
  do menu.
- **O formulário de configurações não é o disco**: nada ali é gravado antes do "Salvar e
  Fechar", mas o "Recarregar" da lista de modelos usa o que está DIGITADO — digitar a API Key
  e recarregar é o fluxo natural de quem acabou de configurar, e ler a chave salva devolvia
  401 justamente no servidor que a chave nova abre. Como isso cria um estado "funciona aqui,
  mas não está salvo", o `atualizaEstadoSalvamento` realça o campo alterado e conta as
  pendências no rodapé. A comparação é contra `settingsSalvas` (retrato do disco, atualizado
  no `persist`), e não contra `state.settings`: trocar o modelo no `<select>` já mexe em
  `state.settings` na hora, e a troca por gravar apareceria como salva.
- **`ask_user` não passa pelo main**: a pergunta é UI pura, então ela quebra o fluxo de
  quatro passos da tabela acima — não tem `ipcMain.handle` nem entrada no preload, só o
  schema, o `case` no `runTool` e o modal. O turno do agente fica PARADO na promessa até
  o clique, igual ao modal de confirmação; por isso `stopAgent` precisa resolver
  `pendingQuestion` além do `pendingConfirm`, senão o botão Parar deixa o card aberto com
  o turno congelado atrás dele. Resposta vazia (nada marcado, nada escrito) vira "pulou":
  devolver `answered: true` sem conteúdo faria o agente seguir achando que foi respondido.
- **Opção de pergunta em dois formatos**: o schema do `ask_user` declara `options` como
  array de STRING porque é o que um modelo pequeno sob gramática consegue emitir, mas os
  modelos grandes mandam `{label, description}`. O `normalizaOpcoes` aceita os dois — o
  schema não é contrato, é sugestão, e recusar um dos formatos jogaria a chamada fora.
- **Skills entram INTEIRAS no prompt, a cada requisição**: não são anexo que se lê uma
  vez. Daí o `SKILL_MAX_CHARS` e o custo em tokens mostrado em cada linha da lista — sem
  isso, dois arquivos grandes comem o contexto antes da primeira mensagem e a sessão morre
  sem explicação na tela. Skill desligada não é enviada.
- **`promptMode: 'replace'` só vale com texto**: substituir o prompt de fábrica por vazio
  deixaria o modelo sem instrução nenhuma e ele para de chamar ferramenta — por isso o
  `buildSystem` só troca quando o campo tem conteúdo.
- **Servidor local**: a porta e o modelo do llama.cpp variam — confirme com o usuário antes de
  assumir `http://localhost:8080/v1`.

## Git

Branch principal: `main`. O usuário costuma pedir "commit" significando commit + push na `main`.
Mensagens em português, com prefixo (`feat:`, `fix:`, `docs:`, `update:`).
