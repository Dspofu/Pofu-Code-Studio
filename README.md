<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- Copyright 2026-present the Pofuserver Coder Studio authors. All rights reserved. -->

# Pofuserver Coder Studio

**Agente de código em desktop** (Electron) que se conecta a **qualquer API REST compatível com OpenAI** — [llama.cpp](https://github.com/ggml-org/llama.cpp), [Ollama](https://ollama.com/), [vLLM](https://github.com/vllm-project/vllm) — e trabalha direto nos arquivos do seu projeto: lê, edita, busca, roda comandos, chama APIs e **tira print das páginas que constrói**.

Um "Cursor/Claude Code" local, rodando com o **seu** modelo, na **sua** máquina.

![Visão geral do chat](docs/img/chat.png)

---

## Demonstração

O pedido foi: *"os números da roleta estão tortos, conserte e confirme visualmente"*. Sem sair do chat, o agente:

1. **Leu** o arquivo e localizou o cálculo do posicionamento;
2. **Recortou o print** só na roleta (`crop_selector`), porque defeito de alinhamento some quando a imagem da página inteira é reduzida;
3. **Viu** que cada número girava junto com o setor — a segunda rotação estava no mesmo sentido da primeira;
4. **Editou uma linha** com `edit_file`, preservando o resto do arquivo;
5. **Capturou de novo** e comparou antes/depois.

Toda alteração vira um **diff revisável com botão de desfazer**:

![Diff e desfazer](docs/img/diff.png)

---

## Funcionalidades

### Ferramentas do agente

| Ferramenta | O que faz |
|---|---|
| `list_files` | Lista arquivos e pastas (com tamanho) |
| `read_file` | Lê em janelas de linhas, com paginação por `offset` |
| `write_file` | Cria um arquivo, ou sobrescreve um que já foi lido |
| `edit_file` | **Troca um trecho exato** — a forma padrão de alterar arquivo existente |
| `search_files` | Busca por texto/regex no projeto, com filtro glob |
| `create_directory` / `delete_file` | Cria pasta / apaga arquivo |
| `execute_command` | Roda comando no workspace; servidores vão para segundo plano |
| `wait_for_process` | **Espera** um processo demorado terminar e devolve o exit code |
| `read_process_output` / `list_processes` / `stop_process` | Acompanha e encerra processos |
| `http_request` | Chama uma API e devolve status, cabeçalhos e corpo separados |
| `capture_page` | Abre a URL num navegador oculto, tira print e reporta erros de console e de rede |
| `web_search` / `fetch_url` | Busca na web e leitura de páginas (opcional, em *Ajustes → Ferramentas*) |

### Diff e desfazer
Cada escrita, edição ou remoção mostra **o que exatamente mudou** — colorido, numerado nas duas versões e com o contexto em volta — e um botão **Desfazer** que reverte o arquivo no disco. O desfazer também pode ser desfeito.

### O agente enxerga o que constrói
`capture_page` renderiza a página num navegador oculto e devolve o print. Com um modelo **multimodal**, a imagem volta para o modelo: ele descreve o que apareceu e compara com o esperado, em vez de deduzir pelo código. Use `full_page` para a página inteira e `crop_selector` para conferir detalhe em tamanho cheio.

### Validação de verdade
O prompt exige evidência: teste executado, exit code lido, resposta HTTP conferida ou print observado. "Escrevi o arquivo" não conta como validação, e o que não pôde ser verificado é declarado como não verificado.

### Contexto que não estoura
O histórico é compactado automaticamente quando se aproxima do limite do modelo: resultados antigos de ferramenta passam a ir encurtados **no envio**, e continuam completos na tela. O botão **Compactar**, ao lado do campo de texto, libera contexto na hora.

### Processos sem travar o chat
Servidores e watchers são detectados (por padrão de log ou ociosidade) e vão para segundo plano com PID. Tarefas demoradas são aguardadas com `wait_for_process`, numa chamada só.

### Erros que dizem o que fazer
Falha de conexão, chave inválida, modelo inexistente e erro do servidor viram mensagens com causa e passos — não uma exceção crua. Só falha transitória é repetida.

![Configurações](docs/img/config.png)

### Pasta segura com troca rápida
Cada chat trabalha dentro de **uma pasta** — o agente não enxerga nada fora dela. O botão de pasta no cabeçalho abre um menu com a **pasta atual**, as **usadas recentemente** e a opção de escolher outra: alternar entre projetos é um clique, sem passar pelo diálogo do sistema toda vez.

![Troca da pasta segura](docs/img/pasta-segura.png)

### Nível de raciocínio no próprio compositor
O seletor **Raciocínio** fica ao lado do campo de mensagem, junto do Auto/Manual — quanto o modelo deve pensar é decisão que se toma na hora de escrever o pedido, não algo para lembrar dentro de um modal com a resposta já em andamento. Um clique abre os níveis, cada um com o que ele exige do servidor:

![Seletor de raciocínio no compositor](docs/img/raciocinio.png)

| Nível | O que é enviado |
|---|---|
| Padrão do modelo | nada — funciona em qualquer servidor |
| Desligado | `enable_thinking: false` + `/no_think` no prompt |
| Baixo / Médio / Alto | `reasoning_effort: low \| medium \| high` |

O padrão não acrescenta campo nenhum à requisição de propósito: `reasoning_effort` é extensão recente e servidor antigo recusa o que não conhece. Se um nível der erro, volte para o padrão.

### Sem janela de console piscando
No Windows, cada comando do agente abria um terminal por cima do app — e uma tarefa longa dispara dezenas deles. Em *Ajustes → Ferramentas*, **Ocultar o console dos comandos** vem **ligado** e a janela não aparece mais. Desligue só para acompanhar ao vivo o que está sendo executado.

### Offline
As bibliotecas de front-end (Markdown, sanitização, realce de sintaxe, estilos) são vendorizadas em `vendor/` — a interface não depende de CDN.

---

## Requisitos

- **[Node.js](https://nodejs.org/)** 18+ com `npm`
- Um **servidor de modelo compatível com OpenAI** rodando (ex.: llama.cpp)
- Linux, Windows ou macOS

Modelos com **function calling** são necessários (o agente depende disso). Para modelos de raciocínio (ex.: Qwen3), mantenha o **Nível de raciocínio** diferente de *Desligado* — sem pensar, eles costumam parar de chamar ferramentas. Um modelo **multimodal** habilita o retorno visual dos prints.

## Instalação

```bash
git clone https://github.com/Dspofu/Pofuserver-Code.git
cd Pofuserver-Code
npm install
npm start
```

> `npm start` compila o TypeScript (via `prestart`) e abre o app. Ele usa `--no-sandbox --ozone-platform=x11` (Linux); em Windows/macOS, rode `npm run build` e depois `npx electron .`.

### Servidor de exemplo com llama.cpp

```bash
llama-server -m /caminho/para/seu-modelo.gguf --port 8080 --jinja
```

## Configuração

Engrenagem → aba **Ajustes**:

1. **Endpoint** — padrão `http://localhost:8080/v1`
2. **Modelo** — *Recarregar* lista o que o endpoint expõe
3. **API Key** — opcional (vazio para servidores locais)
4. **Enviar prints para o modelo** — usado quando o endpoint anuncia um modelo multimodal
5. **Ocultar o console dos comandos** — ligado por padrão (veja acima)
6. **Busca na web**, temperatura, top-p, máximo de tokens e timeout de comando

O **nível de raciocínio** não fica aqui: ele mora no rodapé do compositor, ao lado do campo de mensagem.

## Como usar

1. Crie um chat e **escolha a pasta segura** (ícone de pasta no cabeçalho — o menu também lista as pastas recentes)
2. Peça o que precisa — ex.: *"crie uma API Express com testes e valide os endpoints"*
3. Acompanhe os cards de ferramenta, os diffs e os prints em tempo real
4. Use **Auto/Manual** para decidir se comandos pedem confirmação, e **Raciocínio** para regular quanto o modelo pensa antes de agir
5. `@` menciona um arquivo; o clipe (ou arrastar) anexa arquivos

---

## Estrutura do projeto

O código-fonte é **TypeScript**. O `tsc` emite o `.js` ao lado de cada `.ts` (sem `outDir`), então o Electron continua carregando os mesmos caminhos de sempre, sem empacotador no caminho:

```
├── main.ts           # Processo main: IPC de arquivos, processos, HTTP, captura e busca
├── preload.cts       # Ponte contextBridge (.cts porque o preload é CommonJS → preload.cjs)
├── index.html        # Interface e estilos
├── tsconfig.json     # Único config do build
├── src/
│   ├── renderer.ts   # Loop do agente, ferramentas, streaming, diff, render das mensagens
│   ├── constants.ts  # system_prompt, padrões e limites
│   ├── types.d.ts    # Tipos compartilhados (Settings, Chat, ElectronAPI…)
│   ├── websearch.js  # Busca web (arquivo gerado noutro repositório — veja o cabeçalho)
│   └── websearch.d.ts# Tipos do módulo acima
├── docs/img/         # Imagens do README
└── vendor/           # Bibliotecas de front-end (offline)
```

Os `.js`/`.cjs` gerados são ignorados pelo git: `npm start` e `npm run dist` já rodam o build antes. Para compilar sozinho, `npm run build`; para só checar tipos, `npm run typecheck`.

---

## Créditos e licença

Licenciado sob a **[Apache License 2.0](LICENSE)** — veja também o [NOTICE](NOTICE).

Você pode usar, modificar, redistribuir e criar derivados, inclusive comercialmente. Em troca, a licença pede que você **mantenha o aviso de copyright e o arquivo NOTICE**, e **sinalize os arquivos que alterou**. Se este projeto te ajudou, um link de volta para o repositório é muito bem-vindo.

- Ícone do aplicativo gerado com ChatGPT (OpenAI)
- Bibliotecas de terceiros e suas licenças estão listadas no [NOTICE](NOTICE)
- Referencia de icones: https://feathericons.com

## Notas

- Histórico e configurações ficam no diretório de dados do Electron (`app-store.json`)
- Prints e pontos de restauração ficam em `screenshots/` e `instantaneos/`, no mesmo diretório
- Desenvolvido e testado principalmente no **Linux (Ubuntu 26.04) / Windows (11 PRO 25H2)**, contra um **llama.cpp** local