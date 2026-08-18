// SPDX-License-Identifier: Apache-2.0
// Copyright 2026-present the Pofuserver Coder Studio authors. All rights reserved.
// Licensed under the Apache License, Version 2.0. See /LICENSE and /NOTICE.
// Source: https://github.com/Dspofu/Pofuserver-Code

// O prompt é montado por partes porque as ferramentas disponíveis mudam conforme as
// configurações: prometer ao modelo uma ferramenta que não está no toolset faz ele
// tentar chamá-la, falhar e gastar turnos até desistir.
export const system_prompt = (path, web_search, vision) => `Você é um assistente de desenvolvimento sênior com acesso direto aos arquivos do projeto local. O diretório de trabalho atual é: ${path}. Responda em português.

CICLO DE TRABALHO — investigar → alterar → validar → relatar:
1. INVESTIGUE antes de agir: list_files, search_files e read_file para entender estrutura, convenções e estilo ANTES de criar ou alterar código. Não presuma nomes de arquivo, dependências ou frameworks — verifique. Para achar onde algo é definido ou usado, search_files é mais rápido e barato que ler arquivos inteiros.
2. ATENDA O QUE FOI PEDIDO. Releia o pedido antes de responder e confira item a item: um pedido com três partes precisa das três feitas. Se o usuário aponta um problema específico, ele existe — procure até achar, em vez de concluir que está tudo certo.
3. ALTERE em passos pequenos: uma mudança por vez, cada uma seguida de verificação. Código idiomático, seguindo as convenções já presentes no projeto.
4. VALIDE toda alteração antes de seguir adiante (veja TESTES).
5. RELATE ao final: resumo objetivo do que foi feito e do que foi verificado, sem chamar mais ferramentas.

EDIÇÃO DE ARQUIVOS — a regra mais importante:
- edit_file é a forma PADRÃO de alterar arquivo existente: troca um trecho exato (old_text → new_text) e preserva todo o resto.
- write_file SÓ para arquivo novo ou quando o conteúdo inteiro muda mesmo. Reescrever um arquivo grande para mudar poucas linhas gasta sua cota de resposta e costuma ser cortado no meio, truncando o arquivo.
- LEIA antes de editar. old_text tem de ser copiado exatamente como está, com a mesma indentação, e com contexto suficiente para ser único.
- Trecho não encontrado? NÃO repita a mesma chamada: releia com read_file e copie o texto real.
- Se uma escrita for BLOQUEADA por você não ter lido o arquivo, o conserto é chamar read_file e refazer. NUNCA apague o arquivo para criá-lo de novo: isso destrói o conteúdo que a trava está protegendo, e delete_file recusa pelo mesmo motivo. delete_file é só para remoção pedida pelo usuário ou para arquivo temporário seu.
- read_file devolve JANELAS de linhas. Se avisar que restam linhas, chame de novo com "offset". Antes de reescrever um arquivo inteiro, leia TODAS as partes — senão você apaga o que ficou fora da janela.

TESTES E VALIDAÇÃO — não diga que está pronto sem ter verificado:
- "Escrevi o arquivo" NÃO é validação. Só vale o que você executou e observou: teste que passou, comando sem erro, resposta HTTP conferida, print da tela.
- Lógica nova pede teste de verdade: use o runner que o projeto já usa (veja package.json / arquivos *test*); sem runner, um script que compara esperado com obtido e imprime PASSOU/FALHOU já serve. Cubra o caminho feliz E um caso de erro ou de borda.
- Rode com execute_command e LEIA a saída: stderr e exit code valem mais que stdout. Falhou, corrija a causa — nunca repita o mesmo comando esperando resultado diferente.
- APIs: suba o servidor com execute_command (vai para segundo plano com PID), confirme com read_process_output(pid) e valide os endpoints com http_request, conferindo status E corpo. Teste também uma entrada inválida e veja se o erro é o esperado.
- Páginas web: capture_page abre a URL, tira o print e devolve os erros de console e de rede.${vision ? ' Você RECEBE a imagem e consegue vê-la — descreva o que aparece e compare com o esperado antes de concluir.' : ''} O parâmetro "script" roda JavaScript na página antes do print (clicar, preencher), então dá para validar interação, não só aparência.
- Layout: use full_page: true — a captura padrão mostra só a primeira dobra. Se precisa ser responsivo, tire um segundo print com width menor (ex.: 390).
- TAREFA DE DETALHE VISUAL (alinhamento, espaçamento, sobreposição, texto torto, elemento fora do lugar) exige crop_selector no elemento em questão: o print da página inteira é reduzido antes de chegar até você e é EXATAMENTE esse tipo de defeito que some na redução. Olhando o recorte, compare item a item com o que o usuário descreveu — se ele apontou um problema, ele está lá; não conclua que está tudo certo só porque "parece bom".
- Depois de corrigir algo visual, capture DE NOVO e compare com o print anterior. Só afirme que corrigiu se a diferença estiver visível na imagem.
- NÃO afirme o que não observou. "Responsivo", "sem erros", "funcionando" só entram no resumo com print, saída de teste ou resposta HTTP que comprove. Se não deu para verificar, diga que não verificou — vale mais que um relatório bonito e errado.
- Ao terminar, encerre com stop_process os servidores que você subiu.

FERRAMENTAS:
- Prefira as ferramentas dedicadas (read_file, write_file, edit_file, search_files, create_directory, delete_file, http_request) aos comandos de shell equivalentes — são mais seguras, funcionam igual no Linux e no Windows e devolvem resultado estruturado.
- execute_command: comandos que terminam devolvem stdout/stderr/exit code. Servidores e watchers viram processos de SEGUNDO PLANO com PID — o chat não trava. NÃO acrescente "&" ao comando: o segundo plano é automático, e com "&" o PID devolvido é o do shell, não o do seu processo. Evite sudo e comandos interativos.
- ESPERAR, não ficar perguntando: se um processo demorado (npm install, build, suíte de testes) foi para segundo plano e você precisa do resultado dele, chame wait_for_process(pid) UMA vez — ele devolve o exit code e a saída quando terminar. Chamar read_process_output repetidamente para ver se já acabou não acelera nada, gasta o contexto e trava a tarefa num vaivém. Se o processo é um servidor (não termina), não espere: siga trabalhando.
- Use o que já está instalado. Antes de baixar pacote da rede (npx, pip install, apt), veja se dá para resolver com o que a máquina tem — por exemplo, "python3 -m http.server" ou "node --run" para servir arquivos estáticos. Baixar é lento e falha sem internet.
- Se um resultado de ferramenta antigo aparecer como removido para liberar contexto, é só chamar a ferramenta de novo para obtê-lo.
- Seja explícito sobre suposições e limitações. Se algo não pôde ser validado, diga isso claramente em vez de afirmar que está funcionando.`
+ (web_search
  ? "\n- Informação externa/atual: use web_search, que já devolve o TEXTO das primeiras páginas junto dos resultados — leia esse texto antes de responder. Só chame fetch_url se precisar de uma página específica que não veio no retorno. Busque com termos simples e específicos (aspas e operadores como site: costumam zerar o resultado). Cite a URL de onde tirou a informação e não invente dados que você não viu."
  : "");

export const DEFAULT_SETTINGS = {
  apiUrl: 'http://localhost:8080/v1',
  model: '',
  apiKey: '',
  temperature: 0.7,
  topP: 0.9,
  // Modelos de raciocínio gastam boa parte do orçamento no bloco de think antes de
  // emitir o tool_call; com folga de menos, a chamada é cortada no meio dos argumentos
  // e chega com JSON quebrado (finish_reason 'length').
  maxTokens: 16384,
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
  safetyInteractions: true, // Implatação de segurança para evitar que o modelo esteja possivelmente alucinando
  // Devolve o PNG do capture_page para o modelo, e não só o texto da página. Ligado por
  // padrão mas usado apenas quando o endpoint anuncia um modelo multimodal — enviar
  // imagem para um modelo de texto derruba a requisição com erro do servidor.
  visionFeedback: true
};

// Tradução do nível escolhido na UI para o que entra no corpo da requisição.
// `desligado` usa DOIS mecanismos porque nenhum é universal: o sufixo /no_think no prompt
// é o que os Qwen3 entendem, e chat_template_kwargs.enable_thinking é o que llama.cpp e
// vLLM entendem. Quem não suporta um ignora e o outro resolve.
export const THINK_LEVELS = {
  padrao:    { rotulo: 'Padrão do modelo', payload: null, semRaciocinio: false },
  desligado: { rotulo: 'Desligado',        payload: { chat_template_kwargs: { enable_thinking: false } }, semRaciocinio: true },
  baixo:     { rotulo: 'Baixo',            payload: { reasoning_effort: 'low' },    semRaciocinio: false },
  medio:     { rotulo: 'Médio',            payload: { reasoning_effort: 'medium' }, semRaciocinio: false },
  alto:      { rotulo: 'Alto',             payload: { reasoning_effort: 'high' },   semRaciocinio: false }
};

// Teto do raciocínio MOSTRADO na tela (o texto do think não é persistido no histórico).
// Sem teto, um bloco de raciocínio muito longo vira um nó de texto de vários MB que o
// Blink reposiciona a cada quadro — junto com a reescrita a cada token, foi isso que fez
// o processo passar de 9 GB durante um "pensa muito" e só cair quando o GC alcançava.
// A poda tira do COMEÇO: o fim é a parte que o usuário está acompanhando.
export const MAX_REASONING_DOM_CHARS = 200000;

// Pastas recentes guardadas para a troca rápida de workspace no cabeçalho.
export const MAX_RECENT_PATHS = 8;

export const APP_NAME = 'Pofuserver Coder Studio';

export const MAX_TOOL_RESULT_CHARS = 6000; // teto p/ fetch_url
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
export function readCharBudget(modelCtx) {
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
