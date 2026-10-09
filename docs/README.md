# Guias do Pofu Code Studio

Esta pasta reúne referências gerais sobre o funcionamento e o uso do projeto. Os documentos são organizados por assunto e descrevem o comportamento atual do aplicativo.

## O que consultar

| Guia | Conteúdo |
|---|---|
| [Comandos](comandos.md) | Comandos do chat, aliases, atalhos e comandos de desenvolvimento. |
| [Consumo e controle remoto](consumo-remoto.md) | Tokens, cota, provedores, pareamento e acesso pela área Code do site. |
| [README do projeto](../README.md) | Instalação, primeiros passos, recursos e ferramentas da IA. |
| [Mapa do projeto](../AGENTS.md) | Arquivos, responsabilidades e orientações para agentes. |
| [Convenções de desenvolvimento](../CLAUDE.md) | Regras de implementação e cuidados com ferramentas, histórico e interface. |

`img/` guarda imagens usadas pelos guias e pelo README. Capturas da interface devem vir do aplicativo real e acompanhar o recurso documentado.

## Como manter esta pasta

- Atualize o guia do assunto quando o comportamento mudar. Não crie outro documento para cada atualização.
- Crie um guia novo somente quando houver um assunto permanente que os guias existentes não cobrem.
- Use nomes por assunto, como `comandos.md`. Não use versão, data ou nome de sessão no nome do documento.
- Não guarde notas de versão, changelogs, resumos de sessões, listas de alterações ou relatórios de testes nesta pasta, inclusive em subpastas.
- Informe resultados de testes na resposta ou na descrição do PR. Logs, relatórios e capturas temporárias de diagnóstico ficam fora do repositório.

As instruções de trabalho permanecem em `AGENTS.md` e `CLAUDE.md`. O README principal apresenta o projeto e aponta para estes guias quando o assunto precisa de mais detalhes.
