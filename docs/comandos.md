# Comandos

## Comandos no chat

Digite `/` no início da mensagem ou clique no botão `/` do compositor. Os comandos locais executam ações do aplicativo sem chamar a API da IA.

| Comando | Aliases | Ação |
|---|---|---|
| `/ajuda` | `/help` | Mostra o menu de comandos. |
| `/novo` | `/new` | Cria uma conversa no mesmo projeto. |
| `/projeto` | `/project` | Abre a seleção da pasta de trabalho. |
| `/consumo` | `/usage`, `/cost` | Abre o consumo do provedor ativo. |
| `/config` | `/settings` | Abre as configurações. |
| `/modelo` | `/model` | Abre a seleção de modelo. |
| `/compactar` | `/compact` | Libera contexto preservando o histórico local. |
| `/processos` | `/processes` | Abre o painel de processos. |
| `/parar` | `/stop` | Interrompe a geração e os subagentes em andamento. |

Comandos locais não recebem argumentos. Se você acrescentar texto, o aplicativo mantém o rascunho e informa o problema.

Os comandos abaixo preparam um pedido no campo de mensagem. Você pode revisar e alterar o texto antes de enviar. A chamada à IA só acontece ao enviar o pedido preparado.

| Comando | Alias | Pedido preparado |
|---|---|---|
| `/planejar` | `/plan` | Analisa o objetivo e propõe um plano sem alterar arquivos. |
| `/revisar` | `/review` | Revisa bugs, regressões e testes ausentes, citando arquivos e linhas. |
| `/testar` | `/test` | Identifica e executa testes relevantes, relatando resultados e limitações. |
| `/explicar` | `/explain` | Lê e explica o código com referências aos arquivos. |

Exemplos:

```text
/revisar src/main.ts
/testar autenticação
/explicar o fluxo de reconexão
/planejar suporte a outro provedor
```

### Teclado e anexos

| Ação | Atalho |
|---|---|
| Escolher um comando no menu | ↑ ou ↓ |
| Executar o comando selecionado | Enter |
| Completar o nome do comando | Tab |
| Fechar o menu | Esc |
| Inserir uma nova linha | Shift+Enter |
| Mencionar um arquivo do projeto | `@` |
| Anexar um arquivo | Clipe, arrastar ou colar |

Mensagens enviadas enquanto a IA trabalha entram na fila. O botão **Parar** interrompe a geração, mas processos de terminal que continuam em segundo plano são gerenciados pelo painel **Processos**.

Subagentes são solicitados em uma mensagem normal, por exemplo: “Use dois subagentes para revisar autenticação e testes”. Não existe um comando `/subagents` no catálogo.

## Comandos de desenvolvimento

Execute na raiz do projeto. O catálogo está em [package.json](../package.json).

| Comando | Uso |
|---|---|
| `npm ci` | Instala as dependências a partir do lockfile. |
| `npm run build` | Compila a fonte em `out/` e copia o módulo de pesquisa web. |
| `npm run typecheck` | Confere os tipos sem gerar arquivos. |
| `npm start` | Compila e abre o Electron com as opções usadas no Linux. |
| `npx electron .` | Abre o app já compilado, inclusive no Windows. |
| `npm run dist:win` | Compila e gera o instalador Windows. |
| `npm run dist:linux` | Compila e gera o pacote Debian/Ubuntu. |
| `npm run dist:fedora` | Compila e gera o pacote RPM. Requer `rpmbuild`. |

No Windows, rode `npm run build` antes de `npx electron .`.

### Testes com dados controlados

| Comando | Cobertura |
|---|---|
| `npm test` | Testes unitários das ferramentas, provedores, consumo, ponte remota e subagentes. |
| `npm run test:integration` | Ferramentas, preload e interface no Electron com perfil isolado. |
| `npm run test:subagents` | Paralelismo, histórico isolado, cancelamento, reconexão e cards dos subagentes. |
| `npm run test:reconnect` | Contagem regressiva, respostas vazias, fila e status remoto. |
| `npm run test:computer` | Ferramentas visuais com adaptador falso, sem inputs nativos ao PC. |
| `npm run test:consumption` | Painel e IPCs de consumo. |
| `npm run test:update` | Fluxo de atualização com release simulado. |
| `npm run test:startup` | Avisos de atualização na inicialização. |

### Testes com a API real

`test:api`, `test:agent`, `test:agent:long`, `test:agent:quality`, `test:subagents:real` e `test:vision` fazem chamadas à API configurada para o ensaio. Execute com `npm run`, por exemplo `npm run test:subagents:real`.

Informe `POFU_TEST_API_URL`, `POFU_TEST_API_KEY` e, quando necessário, `POFU_TEST_MODEL` no ambiente. Não grave credenciais nos guias ou no código. Consulte o [README](../README.md) para as opções dos ensaios.

`npm run test:computer:real` também envia mouse e teclado nativos no Windows em janelas de teste. Não use o PC durante esse ensaio. Relatórios e capturas de diagnóstico devem ser salvos fora do repositório.
