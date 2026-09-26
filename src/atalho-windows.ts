// A barra de tarefas e as notificações do Windows desenham o ícone do app a partir do
// atalho do Menu Iniciar (via AUMID), não do .exe. Quando a pasta do app muda de lugar, o
// rastreamento de links do Windows corrige o ALVO do atalho sozinho, mas não o ícone: ele
// fica apontando para um .exe que não existe e a barra mostra um ícone em branco. Visto
// numa instalação real movida de pasta — e reinstalar não conserta, porque com
// KeepShortcuts=true no registro o instalador do electron-builder mantém o atalho como está.
import { existsSync } from 'fs';
import type { Shell } from 'electron';

export function reparaIconeDoAtalho(shell: Pick<Shell, 'readShortcutLink' | 'writeShortcutLink'>, lnk: string, exe: string) {
  if (!existsSync(lnk)) return 'ausente';
  let atual;
  try { atual = shell.readShortcutLink(lnk); } catch { return 'ilegivel'; }
  // Só mexe no atalho que abre ESTE executável: outro app com o mesmo nome não é assunto nosso.
  if (!atual.target || atual.target.toLowerCase() !== exe.toLowerCase()) return 'alheio';
  // Sem ícone próprio o Windows usa o do alvo, que acabou de ser conferido.
  if (!atual.icon || existsSync(atual.icon)) return 'ok';
  try { return shell.writeShortcutLink(lnk, 'update', { target: exe, icon: exe, iconIndex: 0 }) ? 'reparado' : 'falhou'; } catch { return 'falhou'; }
}
