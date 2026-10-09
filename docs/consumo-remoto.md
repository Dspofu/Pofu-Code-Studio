# Consumo e controle remoto

## Contexto, tokens e cota

O indicador de contexto mostra quanto da conversa principal está ocupando o contexto do modelo. O consumo soma as requisições do agente e dos subagentes. Contexto e consumo têm funções diferentes: uma nova análise pode aumentar o consumo sem aumentar o contexto da conversa principal.

Clique no indicador de consumo junto ao contexto ou use `/consumo`, `/usage` ou `/cost`. O resumo usa o provedor ativo e permite escolher o período. Detalhes por modelo ficam recolhidos.

![Painel de consumo do Studio com dados de demonstração](img/consumo-desktop.png)

O registro local contabiliza respostas com `usage` válido, por dia e modelo, e preserva até 366 dias. Trocar perfil, chave ou endpoint separa o registro. Os totais ficam em `consumo.json`, sem mensagens ou chaves.

Chamadas de outros aplicativos e respostas sem `usage` não entram nesse registro. Ele não representa a fatura inteira da conta. Saldo, cota e ciclo aparecem quando a API os informa. APIs sem relatório remoto mostram o registro local.

## Relatórios por provedor

| Integração do Studio | Dados consultados | Credencial |
|---|---|---|
| OpenAI | Uso e custos da organização | Chave administrativa separada |
| Claude / Anthropic | Uso e custos da organização | Chave administrativa com acesso ao Admin API |
| OpenRouter | Uso acumulado e limite da chave | Chave comum |
| DeepSeek | Saldo por moeda | Chave comum |
| Pofu Server | Saldo, ciclo e plano em créditos | Chave comum |
| API compatível com `ai-usage/v1` | Relatório do endpoint `/usage` | Chave comum |

Sem uma credencial administrativa salva, o Studio usa o registro local nas integrações que precisam dela. Credenciais administrativas são protegidas pelo cofre do sistema e usadas somente no host HTTPS oficial. Elas não entram no payload do modelo. Sistemas sem cofre seguro não salvam credenciais administrativas ou de pareamento.

OpenRouter informa o limite da chave. DeepSeek informa saldo por moeda. O Studio mantém essas medidas separadas e sinaliza falhas ou relatórios parciais sem inventar valores.

O consumo usa a conexão do provedor ativo. Não é necessário configurar outra URL para abrir o resumo.

## Conectar o computador ao site

1. Abra **Code → Conectar computador** no site para obter o código de pareamento.
2. No Studio, abra **Configurações → Controle remoto** e informe a origem HTTPS do site e o código.
3. Conecte antes de o código expirar, em cinco minutos, e mantenha o Studio aberto.

Não é necessário abrir uma porta no PC. O botão da lateral permite ligar ou desligar a ponte e mostra se a conexão está ativa. Se ainda não houver pareamento, **Ligar** abre as configurações remotas.

![Área Code do site com uma conversa de demonstração](img/code-remoto.png)

Pelo site, você pode conversar, enviar mensagens à fila, parar a geração, responder perguntas, aprovar ou recusar ferramentas e consultar consumo. As ferramentas executam no computador e mantêm as proteções do modo Manual.

Com o agente parado, você pode gerenciar chats e trocar projeto conhecido, provedor, raciocínio ou modo de execução. Escolher o modo automático pelo site exige confirmar que a escolha também vale no desktop. Novos projetos e provedores são cadastrados no desktop.

### Histórico, imagens e alterações

A área Code permite editar mensagens, apagar ramos, regenerar respostas, duplicar ou limpar conversas e consultar processos. Editar ou regenerar não desfaz as ações das ferramentas já executadas. Desfazer um arquivo usa o snapshot da conversa, com confirmação.

Até três imagens PNG, JPEG ou WebP podem ser anexadas pelo site. O modelo precisa oferecer visão. Os pixels seguem para a inferência, enquanto o espelho remoto usa nomes e miniaturas.

O espelho contém os últimos 80 blocos, limitado a 60 mil caracteres. A exportação pelo site baixa esse trecho. O histórico completo permanece no desktop. Recursos também dependem das permissões do plano no servidor.

### Conexão e segurança

- Chaves da API e credenciais administrativas não são enviadas ao site.
- A credencial de pareamento fica protegida pelo cofre do sistema.
- **Desligar** no desktop pausa a ponte. **Desconectar** no site revoga o pareamento.
- Sem conexão, novos comandos remotos são recusados. O consumo pode estar desatualizado e mostra a data da consulta.
- Após uma falha de conexão, a ponte espera dez segundos antes de tentar novamente. Comandos expirados não são reproduzidos ao reconectar.

API, site e desktop precisam oferecer recursos compatíveis para que o acesso remoto funcione.

## Referência de desenvolvimento

| Arquivo | Responsabilidade |
|---|---|
| `src/consumption.ts` | Normaliza relatórios, tokens, caches, moedas e paginação. |
| `src/consumption-store.ts` | Persiste o registro local de consumo. |
| `src/consumption-vault.ts` | Protege credenciais administrativas no cofre do sistema. |
| `src/remote-control.ts` | Mantém a conexão HTTPS da ponte no processo main. |

Renderer e preload compartilham somente o espelho e os comandos permitidos. Preserve a identidade das aprovações, a expiração e a idempotência dos comandos.

`npm test` cobre os contratos e a persistência. `npm run test:consumption` verifica o painel e os IPCs com dados sintéticos. Consulte o [guia de comandos](comandos.md) para os demais ensaios.

A integração entre API, proxy e Electron pode ser verificada pela raiz do projeto Saas com `node bench/bench-remote-code.ts --desktop`, usando contas e workspace isolados. Os resultados desse ensaio são informados na resposta ou no PR, sem criar um relatório nesta pasta.
