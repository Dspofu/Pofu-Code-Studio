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

### Offline
As bibliotecas de front-end (Markdown, sanitização, realce de sintaxe, estilos) são vendorizadas em `vendor/` — a interface não depende de CDN.

---

## Requisitos

- **[Node.js](https://nodejs.org/)** 18+ com `npm`
- Um **servidor de modelo compatível com OpenAI** rodando (ex.: llama.cpp)
- Linux, Windows ou macOS

Modelos com **function calling** são necessários (o agente depende disso). Para modelos de raciocínio (ex.: Qwen3), mantenha o raciocínio **ligado**. Um modelo **multimodal** habilita o retorno visual dos prints.

## Instalação

```bash
git clone https://github.com/Dspofu/Pofuserver-Code.git
cd Pofuserver-Code
npm install
npm start
```

> O script `start` usa `--no-sandbox --ozone-platform=x11` (Linux). Em Windows/macOS, rode `npx electron .`.

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
5. **Busca na web**, temperatura, top-p, máximo de tokens e timeout de comando

## Como usar

1. Crie um chat e **escolha a pasta de trabalho** (ícone de pasta no cabeçalho)
2. Peça o que precisa — ex.: *"crie uma API Express com testes e valide os endpoints"*
3. Acompanhe os cards de ferramenta, os diffs e os prints em tempo real
4. Use **Auto/Manual** para decidir se comandos pedem confirmação
5. `@` menciona um arquivo; o clipe (ou arrastar) anexa arquivos

---

## Estrutura do projeto

```
├── main.js           # Processo main: IPC de arquivos, processos, HTTP, captura e busca
├── preload.js        # Ponte contextBridge entre renderer e main
├── index.html        # Interface e estilos
├── src/
│   ├── renderer.js   # Loop do agente, ferramentas, streaming, diff, render das mensagens
│   ├── constants.js  # system_prompt, padrões e limites
│   └── websearch.js  # Busca web (arquivo gerado — veja o cabeçalho)
├── docs/img/         # Imagens do README
└── vendor/           # Bibliotecas de front-end (offline)
```

---

## Créditos e licença

Licenciado sob a **[Apache License 2.0](LICENSE)** — veja também o [NOTICE](NOTICE).

Você pode usar, modificar, redistribuir e criar derivados, inclusive comercialmente. Em troca, a licença pede que você **mantenha o aviso de copyright e o arquivo NOTICE**, e **sinalize os arquivos que alterou**. Se este projeto te ajudou, um link de volta para o repositório é muito bem-vindo.

- Ícone do aplicativo gerado com ChatGPT (OpenAI)
- Bibliotecas de terceiros e suas licenças estão listadas no [NOTICE](NOTICE)

## Notas

- Histórico e configurações ficam no diretório de dados do Electron (`app-store.json`)
- Prints e pontos de restauração ficam em `screenshots/` e `instantaneos/`, no mesmo diretório
- Desenvolvido e testado principalmente no **Linux**, contra um **llama.cpp** local
