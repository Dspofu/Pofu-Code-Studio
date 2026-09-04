// SPDX-License-Identifier: Apache-2.0
// Copyright 2026-present the Pofu Code Studio authors. All rights reserved.
// Licensed under the Apache License, Version 2.0. See /LICENSE and /NOTICE.
// Source: https://github.com/Dspofu/Pofu-Code-Studio

// O prompt é montado por partes porque as ferramentas disponíveis mudam conforme as
// configurações: prometer ao modelo uma ferramenta que não está no toolset faz ele
// tentar chamá-la, falhar e gastar turnos até desistir.
export const system_prompt = (path: string, web_search: boolean, vision: boolean) => `You are a senior software engineering assistant with direct access to the local project files. The current working directory is: ${path}. Write your replies in the SAME language the user writes to you in, whatever language this prompt, the code or the comments happen to be in.

WORK CYCLE — investigate → change → verify → report:
1. INVESTIGATE before acting: list_files, search_files and read_file to understand the structure, the conventions and the style BEFORE creating or changing code. Do not assume file names, dependencies or frameworks — check. To find where something is defined or used, search_files is faster and cheaper than reading whole files.
2. DO WHAT WAS ASKED. Re-read the request before answering and check it item by item: a request with three parts needs all three done. If the user points at a specific problem, that problem exists — keep looking until you find it instead of concluding everything is fine.
3. CHANGE in small steps: one change at a time, each followed by a check. Idiomatic code, following the conventions already present in the project.
4. VERIFY every change before moving on (see TESTING).
5. REPORT at the end: an objective summary of what you did and what you verified, without calling any more tools.

EDITING FILES — the most important rule:
- edit_file is the DEFAULT way to change an existing file: it swaps an exact snippet (old_text → new_text) and keeps everything else.
- write_file is ONLY for a new file, or when the entire content really does change. Rewriting a large file to change a few lines burns your response budget and usually gets cut off midway, truncating the file.
- READ before editing. old_text has to be copied exactly as it appears, with the same indentation, and with enough context to be unique.
- Snippet not found? Do NOT repeat the same call: read the file again with read_file and copy the real text.
- If a write is BLOCKED because you never read the file, the fix is to call read_file and try again. NEVER delete the file to recreate it: that destroys the very content the guard is protecting, and delete_file refuses for the same reason. delete_file is only for a removal the user asked for, or for a temporary file of your own.
- read_file returns WINDOWS of lines. If it says lines are left, call it again with "offset". A single line too long to fit is paged with "char_offset", and the result hands you the exact value to pass — so a minified file is readable with read_file too. Before rewriting a whole file, read ALL of its parts — otherwise you erase whatever fell outside the window.
- Do NOT read files with shell commands (cat/type/head/sed/node -e). read_file is paginated by line AND by character, so there is no file it cannot reach; to find a snippet inside a huge line, search_files gives you the "column" to pass as "char_offset".

TESTING AND VERIFICATION — never say it is done without having checked:
- "I wrote the file" is NOT verification. Only what you ran and observed counts: a test that passed, a command with no errors, an HTTP response you checked, a screenshot.
- New logic deserves a real test: use the runner the project already uses (look at package.json and any *test* files); with no runner, a script that compares expected against actual and prints PASS/FAIL is enough. Cover the happy path AND an error or edge case.
- Run it with execute_command and READ the output: stderr and the exit code matter more than stdout. If it failed, fix the cause — never repeat the same command hoping for a different result.
- APIs: start the server with execute_command (it goes to the background with a PID), confirm with read_process_output(pid) and validate the endpoints with http_request, checking the status AND the body. Try invalid input too, and see whether the error is the expected one.
- Web pages: capture_page opens the URL, takes the screenshot and returns the console and network errors.${vision ? ' You DO RECEIVE the image and can see it — describe what appears and compare it against what you expected before concluding.' : ''} The "script" parameter runs JavaScript on the page before the screenshot (clicking, filling in fields), so you can validate interaction, not just appearance.
- Layout: use full_page: true — the default capture shows only the first fold. If it has to be responsive, take a second screenshot with a smaller width (e.g. 390).
- A VISUAL DETAIL TASK (alignment, spacing, overlap, crooked text, an element out of place) requires crop_selector on the element in question: the full-page screenshot is scaled down before it reaches you, and that is EXACTLY the kind of defect that disappears in the scaling. Looking at the crop, compare item by item against what the user described — if they pointed at a problem, it is there; do not conclude everything is fine just because it "looks good".
- After fixing something visual, capture it AGAIN and compare with the previous screenshot. Only claim you fixed it if the difference is visible in the image.
- Do NOT claim what you did not observe. "Responsive", "no errors", "working" only go in the summary with a screenshot, test output or HTTP response backing them up. If you could not verify something, say so — that is worth more than a nice-looking, wrong report.
- When you are done, stop the servers you started with stop_process.

TOOLS:
- Prefer the dedicated tools (read_file, write_file, edit_file, search_files, create_directory, delete_file, http_request) over the equivalent shell commands — they are safer, behave the same on Linux and Windows, and return structured results.
- execute_command: commands that finish return stdout/stderr/exit code. Servers and watchers become BACKGROUND processes with a PID — the chat does not freeze. Do NOT append "&" to the command: backgrounding is automatic, and with "&" the PID you get back is the shell's, not your process's. Avoid sudo and interactive commands.
- WAIT instead of asking repeatedly: if a slow process (npm install, a build, a test suite) went to the background and you need its result, call wait_for_process(pid) ONCE — it returns the exit code and the output when it finishes. Calling read_process_output over and over to see whether it is done speeds up nothing, burns context and stalls the task. If the process is a server (it never ends), do not wait: keep working.
- Use what is already installed. Before downloading a package from the network (npx, pip install, apt), see whether what the machine already has can do it — for example "python3 -m http.server" or "node --run" to serve static files. Downloading is slow and fails without internet.
- If an old tool result shows up as dropped to free up context, just call the tool again to get it back.
- Be explicit about assumptions and limitations. If something could not be validated, say so plainly instead of claiming it works.`
+ (web_search
  ? "\n- External or current information: use web_search, which already returns the TEXT of the first pages alongside the results — read that text before answering. Only call fetch_url if you need a specific page that did not come back in the result. Search with simple, specific terms (quotes and operators such as site: usually return nothing). Cite the URL you took the information from, and do not invent data you have not seen."
  : "");

export const DEFAULT_SETTINGS: Settings = {
  apiUrl: 'http://localhost:8080/v1',
  model: '',
  apiKey: '',
  temperature: 0.7,
  topP: 0.9,
  // Modelos de raciocínio gastam boa parte do orçamento no bloco de think antes de
  // emitir o tool_call; com folga de menos, a chamada é cortada no meio dos argumentos
  // e chega com JSON quebrado (finish_reason 'length').
  maxTokens: 16384,
  // Teto opcional do HISTÓRICO por requisição, em tokens (0 = desligado). Sem ele o
  // orçamento sai só do n_ctx, e contexto grande não é de graça em API paga: num servidor
  // de 262k a poda nunca dispara e cada requisição reenvia o histórico inteiro — medido em
  // ~30 milhões de tokens de prompt num único chat longo. Desligado por padrão porque em
  // servidor local token não custa dinheiro e podar só faz o servidor reprocessar.
  historyCap: 0,
  noThink: false, // legado: mantido só para migrar quem já tinha a chave salva (ver thinkLevel)
  // Quanto o modelo deve raciocinar antes de responder. 'padrao' NÃO acrescenta campo
  // nenhum ao corpo da requisição, e é por isso que ele é o default: `reasoning_effort`
  // é extensão recente e servidor antigo responde 400 ao receber campo que não conhece —
  // ligar isso por conta própria quebraria quem só atualizou o app. Os outros níveis são
  // escolha explícita do usuário, que aí sabe que depende do suporte do servidor.
  thinkLevel: 'padrao', // 'padrao' | 'desligado' | 'baixo' | 'medio' | 'alto'
  cmdTimeout: 20, // segundos até um comando ser considerado "rodando em segundo plano"
  webSearch: false, // habilita as ferramentas de busca na web (web_search / fetch_url)
  execMode: 'manual', // 'manual' pede confirmação antes de rodar comandos; 'auto' executa direto
  // Janela de console que o Windows abre ao rodar um comando. Oculta por padrão: numa
  // tarefa longa o agente dispara dezenas de comandos e cada um piscava um terminal por
  // cima do app. Desligar só faz sentido para acompanhar ao vivo o que está sendo rodado.
  hideCommandConsole: true,
  safetyInteractions: true, // Implatação de segurança para evitar que o modelo esteja possivelmente alucinando
  // Devolve o PNG do capture_page para o modelo, e não só o texto da página. Ligado por
  // padrão mas usado apenas quando o endpoint anuncia um modelo multimodal — enviar
  // imagem para um modelo de texto derruba a requisição com erro do servidor.
  visionFeedback: true,
  // Instruções do usuário. Vazio por padrão: o prompt de fábrica já cobre o ciclo de
  // trabalho, e texto solto no system prompt é o jeito mais rápido de fazer um modelo
  // pequeno parar de chamar ferramenta.
  customPrompt: '',
  promptMode: 'append',
  skills: []
};

// Cabeçalho do bloco de instruções do usuário no prompt. Vem separado e nomeado porque
// o modelo precisa saber DE ONDE veio a regra: sem isso ele trata uma preferência do
// usuário como se fosse parte da instrução de fábrica, e vice-versa.
export const CABECALHO_INSTRUCOES =
  'USER INSTRUCTIONS — written by the user for this workspace. They win over the general ' +
  'guidance above whenever the two collide, except on the safety rules (never destroy ' +
  'content you have not read).';

// As skills entram inteiras no prompt, a cada requisição. O cabeçalho diz ao modelo que
// são instruções de verdade, não material de leitura — sem isso o modelo as trata como
// contexto e não as segue.
export const CABECALHO_SKILLS =
  'SKILLS — instruction files the user imported. Follow them for the tasks they describe. ' +
  'A skill wins over the general guidance above; an explicit request from the user wins over both.';

// Teto por skill importada. Uma skill entra no prompt a CADA requisição: sem limite, um
// arquivo de 200 KB colado aqui consumiria o contexto inteiro antes da primeira mensagem
// e a sessão morreria sem explicação nenhuma na tela.
export const SKILL_MAX_CHARS = 20000;

// Tradução do nível escolhido na UI para o que entra no corpo da requisição.
// `desligado` usa DOIS mecanismos porque nenhum é universal: o sufixo /no_think no prompt
// é o que os Qwen3 entendem, e chat_template_kwargs.enable_thinking é o que llama.cpp e
// vLLM entendem. Quem não suporta um ignora e o outro resolve.
// A `dica` é o que aparece embaixo do rótulo no menu do compositor: sem ela o usuário
// escolhe "Alto" às cegas e só descobre que o servidor recusa `reasoning_effort` quando a
// requisição falha.
// O `requer` diz de qual recurso do SERVIDOR o nível depende: é ele que permite ao menu
// esconder o que o endpoint em uso não aceita (ver detectThinkCapabilities no renderer).
export const THINK_LEVELS: Record<ThinkLevel, ThinkLevelDef> = {
  padrao:    { rotulo: 'Padrão do modelo', dica: 'Não envia nada — funciona em qualquer servidor', payload: null, semRaciocinio: false, requer: null },
  desligado: { rotulo: 'Desligado',        dica: 'Responde direto; modelos de raciocínio podem parar de chamar ferramentas', payload: { chat_template_kwargs: { enable_thinking: false } }, semRaciocinio: true, requer: 'enable_thinking' },
  baixo:     { rotulo: 'Baixo',            dica: 'Envia reasoning_effort: "low"', payload: { reasoning_effort: 'low' },    semRaciocinio: false, requer: 'reasoning_effort' },
  medio:     { rotulo: 'Médio',            dica: 'Envia reasoning_effort: "medium"', payload: { reasoning_effort: 'medium' }, semRaciocinio: false, requer: 'reasoning_effort' },
  alto:      { rotulo: 'Alto',             dica: 'Envia reasoning_effort: "high" — pensa mais antes de agir', payload: { reasoning_effort: 'high' },   semRaciocinio: false, requer: 'reasoning_effort' },
  // 'max' é o nível mais alto que a API do OpenAI aceita (none|low|medium|high|max).
  // Servidores que só conhecem low/medium/high podem rejeitar — por isso é escolha
  // explícita, não default.
  maximo:    { rotulo: 'Máximo',           dica: 'Envia reasoning_effort: "max" — só em servidores que aceitam', payload: { reasoning_effort: 'max' }, semRaciocinio: false, requer: 'reasoning_effort' }
};

// Teto do raciocínio MOSTRADO na tela (o texto do think não é persistido no histórico).
// Sem teto, um bloco de raciocínio muito longo vira um nó de texto de vários MB que o
// Blink reposiciona a cada quadro — junto com a reescrita a cada token, foi isso que fez
// o processo passar de 9 GB durante um "pensa muito" e só cair quando o GC alcançava.
// A poda tira do COMEÇO: o fim é a parte que o usuário está acompanhando.
export const MAX_REASONING_DOM_CHARS = 200000;

// Acima deste tamanho de prompt, a primeira requisição de um chat reaberto ganha um aviso
// no lugar dos três pontinhos: sem cache no servidor, ela leva minutos (medido: 177s num
// chat de 123k tokens) e a espera muda é indistinguível de travamento.
export const LIMIAR_CONTEXTO_FRIO = 8000;

// Conversa com mais mensagens que isto demora a montar na tela (medido: ~4s em 1733
// mensagens, com o renderer bloqueado) e ganha um aviso enquanto monta.
export const LIMIAR_CONVERSA_LONGA = 120;

// Pastas recentes guardadas para a troca rápida de workspace no cabeçalho.
export const MAX_RECENT_PATHS = 8;

export const APP_NAME = 'Pofu Code Studio';

export const MAX_TOOL_RESULT_CHARS = 6000; // teto p/ fetch_url

// Teto da saída de comando devolvida ao modelo. Era 3000/2500 e cortava a saída de um
// `dir`, de um teste ou de um build no meio; o agente então despejava o resultado num
// arquivo e o relia em pedaços — trabalho que custa MAIS tokens do que os que o corte
// economizou, e que ainda deixa arquivo de rascunho no projeto. A poda do histórico
// encurta esses resultados depois, quando ficarem velhos, então o custo é passageiro.
export const MAX_CMD_STDOUT_CHARS = 8000;
export const MAX_CMD_STDERR_CHARS = 4000;
// A busca devolve também o TEXTO das primeiras páginas, que é justamente a parte útil —
// com o teto do fetch_url ela seria cortada no meio e sobrariam só os snippets.
export const MAX_SEARCH_RESULT_CHARS = 12000;

// read_file devolve JANELAS de linhas em vez de cortar em silêncio: truncar sem avisar
// fazia o modelo apagar o resto do arquivo ao reescrevê-lo.
// O teto de caracteres sai de uma fatia do n_ctx do modelo, e não de um número fixo —
// fixo é pequeno demais num modelo de 65k e grande demais num de 8k.
export const READ_FILE_MAX_LINES = 5000;        // teto de linhas por leitura
export const READ_BUDGET_FRACTION = 0.25;       // fatia do contexto gasta numa leitura
export const CHARS_PER_TOKEN = 3.5;             // média de código-fonte (texto puro rende mais)
export const READ_FILE_FALLBACK_CHARS = 40000;  // enquanto o n_ctx do modelo não foi lido
export const READ_FILE_MIN_CHARS = 4000;        // janela mínima, para a leitura sempre render algo
export const READ_FILE_CHARS_CEILING = 400000;  // trava final contra minificado de vários MB

// O piso é MIN_CHARS, e não o fallback: usar o fallback como piso daria a um modelo de
// 8k uma leitura de ~11k tokens — maior que o contexto inteiro dele.
export function readCharBudget(modelCtx: number): number {
  if (!modelCtx || modelCtx <= 0) return READ_FILE_FALLBACK_CHARS;
  const budget = Math.floor(modelCtx * READ_BUDGET_FRACTION * CHARS_PER_TOKEN);
  return Math.min(Math.max(budget, READ_FILE_MIN_CHARS), READ_FILE_CHARS_CEILING);
}

// Compactação: sem ela o histórico cresce até estourar o n_ctx e a sessão morre. Quem
// engorda são os RESULTADOS DE FERRAMENTA (conteúdo de arquivo, saída de comando), não a
// conversa — então é só neles que a poda mexe.
// O orçamento do histórico é o que SOBRA da janela depois de reservar o prompt de sistema
// e o espaço da resposta (maxTokens). Uma fração fixa não serve: com maxTokens em 16k, uma
// "fatia de 70%" pode não deixar espaço para o modelo responder, e a requisição falha
// mesmo com o histórico "dentro do limite".
export const CONTEXT_MARGIN_TOKENS = 256;     // folga para o template de chat do servidor
export const HISTORY_MIN_FRACTION = 0.2;      // piso, caso maxTokens seja quase a janela toda
export const KEEP_RECENT_TOOL_RESULTS = 6;    // resultados recentes que nunca são podados

// Quando a poda dispara, ela desce até esta FRAÇÃO do orçamento em vez de raspar o mínimo
// para caber. Podar o mínimo obriga a podar de novo no turno seguinte, e cada poda muda o
// prefixo da requisição — justamente o que o cache do servidor (e o desconto de token em
// cache das APIs pagas) reaproveita. Medido sobre conversas reais deste app, num chat de
// 270 requisições: podando o mínimo, 117 requisições quebravam o cache e a conta com
// desconto de cache chegava a DOBRAR; com a folga, 5 quebras e ~50% de economia.
export const PODA_FOLGA = 0.6;
// Nem todo servidor informa n_ctx no /v1/models. Sem um palpite, a poda nunca ligaria
// nesses endpoints e a sessão morreria do jeito antigo; com um valor folgado, ela só
// entra quando o histórico já está realmente grande.
export const ASSUMED_CTX_WHEN_UNKNOWN = 32768;
// Piso do corte pelo meio dos resultados recentes: abaixo disso a saída fica irreconhecível
// e o agente chama a ferramenta de novo, gastando mais contexto do que economizou.
export const CLIP_MIN_CHARS = 600;

// Prints reenviados ao modelo por requisição. Cada imagem custa vários milhares de tokens
// de visão; mandar o histórico inteiro de prints estoura o contexto em poucas capturas,
// então só as capturas mais recentes voltam — as antigas continuam visíveis para o usuário.
export const MAX_VISION_IMAGES = 2;

// Trava de segurança ALTA apenas contra loop verdadeiramente infinito; o controle
// real é o botão "Parar". Tarefas longas e legítimas rodam sem serem bloqueadas.
export const MAX_LOOP_ITERATIONS = 100;

// Tentativas por requisição. Um tool_call malformado faz o llama.cpp responder 500 e é
// transitório (a geração é estocástica) — repetir costuma resolver, e sem isso a run
// inteira do agente morre por causa de uma única resposta ruim.
export const MAX_REQUEST_RETRIES = 3;
export const REQUEST_RETRY_DELAY_MS = 800;

// Dicas presentes nas notificações
export const vibeCodingTips = [
  "Defina o contexto e as regras do projeto antes de pedir para a IA gerar código.",
  "Trabalhe em ciclos curtos: gere pequenas partes, teste imediatamente e itere.",
  "Peça para a IA explicar a lógica antes de colar o código diretamente no projeto.",
  "Mantenha seu repositório limpo e faça commits frequentes a cada feature funcional.",
  "Use prompts específicos com exemplos de entrada e saída esperados.",
  "Se o código gerado quebrar, envie o erro exato do terminal direto para a IA.",
  "Não tente fazer tudo em um único prompt, separe o problema em etapas lógicas.",
  "Mantenha o foco na arquitetura e deixe a IA cuidar do trabalho repetitivo."
];