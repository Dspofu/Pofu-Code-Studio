# Corrigir/Terminar

> **Status (2026-08):** todas as tarefas abaixo foram concluídas e validadas nesta sessão
> (typecheck + build + teste funcional via harness headless com stub de `electronAPI`).
> Detalhes do "por quê" e das decisões: ORIENTACAO.md §7 e CLAUDE.md.

## Pendências antigas

- [x] **Campos do menu de configuração "Visão Geral"** — ID duplicado corrigido
      (`#info-product-name` para o card de Nome) e ambos os cards populados via `loadAppInfo`.
- [x] **Notificação não funciona** — movida de `app.on('activate')` (só macOS) para o
      `whenReady`, com `try/catch` para ambientes sem daemon de notificação; `console.log("ué")` removido.
- [x] **Pingo não mostra versão** — `#info-version-dot` ganha `title="Versão: X"` via `loadAppInfo`.
- [x] **Terminar funcionalidade de excluir recentes** — lixeira `.trash-folder` agora remove do
      `state.recentPaths`, chama `persist()` e reabre o menu; `stopPropagation` impede trocar de workspace.

## Problemas de ferramenta encontrados em uso

- [x] **`execute_command` no Windows: `cmd.exe` não suporta sintaxe composta** — mantido o `cmd.exe`
      (PowerShell 5.1 rejeita `&&` e tem ~1s de start-up, medido). A **descrição da tool** agora
      documenta: Windows usa `&`/`&&` (`;` vira argumento), Linux/macOS usa `;`/`&&`.
- [x] **Comando que termina ocioso vira background à toa** — o cronômetro de ocioso só arma
      **depois da primeira linha de saída** e só backgroundiza se o processo **ainda estiver vivo**.
      Comando mudo/travado (ex.: `git status` num disco lento) termina no `close` e devolve a saída direto.
- [x] **`read_file`: o `limit` alto não garante o arquivo inteiro** — a descrição do parâmetro `limit`
      agora explica que a janela é limitada por orçamento de caracteres derivado do contexto do modelo.
- [x] **`search_files`: truncamento sem total** — o handler agora devolve `totalFound` (contagem total,
      cap 10000) além de `matches` (limitados a `max_results`); a descrição da tool orienta refinar a busca.

## Estrutura

- [x] **Arquivos de build separados** — fonte em `src/` (`main.ts` e `preload.cts` movidos com `git mv`),
      saída em `out/` (`tsconfig` com `rootDir: src` + `outDir: out`). Ajustados: `main` do package.json
      (`out/main.js`), `<script>` do index.html (`out/renderer.js`), `files` do electron-builder (`out/**`),
      `.gitignore` (`/out`), imports relativos de `src/main.ts`, e os caminhos de `__dirname` (loadFile
      `../index.html`, preload `preload.cjs`, `../package.json`). `src/websearch.js` (fonte versionada)
      vai junto no `out/`. Build limpo (`rmdir out` + `npm run build`) reproduz a saída do zero.

## Decisão aberta (recomendação: manter como está)

- ⬜ **Trocar o shell do Windows para PowerShell** — não recomendado: o PowerShell 5.1 (padrão)
      rejeita `&&` com parser error e adiciona ~1s de start-up por comando (medido); o `cmd.exe` é
      instantâneo e aceita `&&`. A descrição da tool já ensina o separador certo por plataforma.
      Só vale a pena se o usuário insistir em `;` funcionar no Windows.
