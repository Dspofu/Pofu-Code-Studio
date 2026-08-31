# Pendências

> Arquivo com **somente pendências reais**. As seções de tarefas já concluídas
> (menu "Visão Geral", notificação, lixeira de recentes, problemas de ferramenta,
> anexos de imagem + nível de raciocínio, estrutura de build) foram removidas —
> o histórico delas está no git e em AGENTS.md §7 / CLAUDE.md.

## (vazio)

Não há pendência conhecida em aberto.

### Resolvido nesta rodada — visão em anexo do usuário

A lista anterior dizia que imagem colada/arrastada nunca chegava ao modelo. Era
verdade, e foi corrigido: o anexo de imagem agora segue o mesmo caminho do print
do `capture_page` (bytes em `userData`, caminho no histórico, data URL no
`shotCache`) e vira bloco `image_url` quando o modelo é multimodal.

Medido com proxy registrando o payload, mesma pergunta sobre a mesma imagem:

| | Requisições | Como respondeu |
|---|---|---|
| Antes | **32** | sem os pixels, instalou Pillow com `pip`, escreveu scripts Python de recorte e cor, improvisou um OCR |
| Depois | **1** | olhou a imagem |

Também conferido: a imagem continua visível depois de fechar e reabrir o app
(`hydrateShots` relê do disco), e quando o modelo NÃO é multimodal — ou quando
"Enviar prints para o modelo" está desligado — o chip avisa e o texto do anexo
diz ao modelo que ele não recebe imagens, em vez de deixá-lo procurar um jeito.

Um item da lista antiga estava errado e não gerou trabalho: dizia que o
`buildAttachmentBlock` "instrui o modelo a usar `read_image`". Não instruía — a
única menção a `read_image` era um comentário em `src/types.d.ts`, que o modelo
nunca lê. O comentário foi corrigido junto.

### Uso das ferramentas — verificado, sem pendência

> Bateria rodada contra o servidor local, uma tarefa por comportamento esperado.
> Fica aqui para não repetir o trabalho: **nenhum destes é problema hoje**.

- Alterar uma linha em arquivo de 1.500 linhas → `search_files` + `read_file` +
  `edit_file` (não reescreveu com `write_file`).
- Localizar uma definição → `search_files` numa chamada só (não foi ao terminal).
- Comando de 25s com timeout de 8s → virou background e o agente usou
  `wait_for_process` (não ficou em `read_process_output` em looping).
- Pedido ambíguo com três arquivos de configuração → `ask_user`, sem apagar nada.
  Com um único candidato, ele resolve sozinho — que é o comportamento certo.
- Apagar/sobrescrever arquivo não lido → trava dispara, ele lê antes, e o conteúdo
  que não estava na conversa (uma senha no arquivo) sobreviveu à reescrita.
- Linha maior que a janela de leitura → o rodapé diz o que faltou e ele usa
  `search_files`, em vez de despejar o arquivo pelo terminal.
