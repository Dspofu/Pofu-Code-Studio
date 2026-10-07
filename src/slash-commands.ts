export const slashCommands = [
  { name: 'ajuda', aliases: ['help'], description: 'Ver todos os comandos', action: 'local' },
  { name: 'novo', aliases: ['new'], description: 'Nova conversa no mesmo projeto', action: 'local' },
  { name: 'projeto', aliases: ['project'], description: 'Escolher a pasta de trabalho', action: 'local' },
  { name: 'consumo', aliases: ['usage', 'cost'], description: 'Ver tokens, saldo e consumo da API ativa', action: 'local' },
  { name: 'config', aliases: ['settings'], description: 'Abrir configurações', action: 'local' },
  { name: 'modelo', aliases: ['model'], description: 'Escolher o modelo de IA', action: 'local' },
  { name: 'compactar', aliases: ['compact'], description: 'Liberar contexto sem apagar a conversa', action: 'local' },
  { name: 'processos', aliases: ['processes'], description: 'Acompanhar os processos do projeto', action: 'local' },
  { name: 'parar', aliases: ['stop'], description: 'Interromper a geração atual', action: 'local' },
  { name: 'planejar', aliases: ['plan'], description: 'Preparar um pedido de planejamento', action: 'prompt', prompt: 'Analise o projeto e proponha um plano de implementação, sem alterar arquivos ainda. Objetivo: ' },
  { name: 'revisar', aliases: ['review'], description: 'Preparar uma revisão de código', action: 'prompt', prompt: 'Revise o código, priorizando bugs, regressões e testes ausentes. Cite arquivos e linhas e não altere nada ainda. Escopo: ' },
  { name: 'testar', aliases: ['test'], description: 'Preparar um pedido de testes', action: 'prompt', prompt: 'Identifique e execute os testes relevantes do projeto. Relate o que passou, as falhas e o que não pôde ser validado. Escopo: ' },
  { name: 'explicar', aliases: ['explain'], description: 'Preparar uma explicação do código', action: 'prompt', prompt: 'Leia o código e explique seu funcionamento, com referências aos arquivos relevantes. Assunto: ' }
];

export function parseSlash(value: string) {
  const match = value.match(/^\/([a-z-]+)(?:\s+([\s\S]*))?$/i);
  if (!match) return null;
  const name = match[1].toLowerCase();
  return { command: slashCommands.find(c => c.name === name || c.aliases.includes(name)), name, args: match[2]?.trim() || '' };
}

export function matchingCommands(value: string) {
  const match = value.match(/^\/([a-z-]*)$/i);
  if (!match) return [];
  const query = match[1].toLowerCase();
  return slashCommands.filter(c => c.name.startsWith(query) || c.aliases.some(a => a.startsWith(query)));
}

// O menu só prepara mensagens ou chama ações locais. Nunca envia uma requisição à IA.
export function mountSlashCommands(input: HTMLTextAreaElement, menu: HTMLElement, callbacks: {
  execute: (command: typeof slashCommands[number], args: string) => boolean | string | Promise<boolean | string>;
  notify: (message: string) => void;
  opened: () => void;
}) {
  let items = [], index = 0, busy = false;
  const close = () => {
    menu.hidden = true;
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
  };
  const refreshInput = () => input.dispatchEvent(new Event('input', { bubbles: true }));
  const submit = (value = input.value) => {
    if (value === '/') { update(); return true; }
    const parsed = parseSlash(value);
    if (!parsed) return false;
    const command = parsed.command;
    if (!command) { callbacks.notify(`Comando /${parsed.name} não encontrado. Digite /ajuda para ver as opções.`); return true; }
    if (busy) return true;
    if (command.action === 'local' && parsed.args) {
      callbacks.notify(`/${command.name} não recebe argumentos. O texto foi mantido no campo.`);
      return true;
    }
    if (command.name === 'ajuda') { input.value = '/'; input.focus(); refreshInput(); return true; }
    close();
    busy = true;
    Promise.resolve().then(() => callbacks.execute(command, parsed.args)).then(result => {
      // Um diálogo pode demorar: não substitui texto que o usuário digitou enquanto isso.
      if (result !== false && input.value === value) {
        input.value = typeof result === 'string' ? result : '';
        refreshInput();
      }
    }).catch(() => callbacks.notify('Não foi possível executar o comando. O texto foi mantido para tentar novamente.'))
      .finally(() => { busy = false; });
    return true;
  };
  const render = () => {
    menu.replaceChildren();
    const header = document.createElement('div');
    header.className = 'slash-heading'; header.textContent = 'Comandos do Pofu';
    menu.append(header);
    const list = document.createElement('div'); list.className = 'slash-list'; list.setAttribute('role', 'listbox');
    items.forEach((command, i) => {
      const button = document.createElement('button');
      button.type = 'button'; button.id = `slash-option-${i}`;
      button.className = 'slash-option' + (i === index ? ' active' : '');
      button.setAttribute('role', 'option'); button.setAttribute('aria-selected', String(i === index));
      const name = document.createElement('strong'); name.textContent = '/' + command.name;
      const description = document.createElement('span'); description.textContent = command.description;
      const kind = document.createElement('small'); kind.textContent = command.action === 'local' ? 'Ação' : 'Preparar pedido';
      button.append(name, description, kind);
      button.addEventListener('mousedown', e => e.preventDefault());
      button.onclick = () => { input.value = '/' + command.name; submit(); };
      list.append(button);
    });
    menu.append(list);
    const footer = document.createElement('div'); footer.className = 'slash-footer';
    footer.textContent = '↑ ↓ escolher · Enter executar · Tab completar · Esc fechar'; menu.append(footer);
    menu.hidden = false;
    input.setAttribute('aria-expanded', 'true');
    input.setAttribute('aria-activedescendant', `slash-option-${index}`);
    (list.children[index] as HTMLElement)?.scrollIntoView({ block: 'nearest' });
  };
  const update = () => {
    items = input.selectionStart === input.selectionEnd && input.selectionStart === input.value.length ? matchingCommands(input.value) : [];
    if (!items.length) return close();
    callbacks.opened(); index = 0; render();
  };
  const keydown = (e: KeyboardEvent) => {
    if (e.isComposing || menu.hidden) return false;
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); return true; }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault(); index = (index + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length; render(); return true;
    }
    if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
      e.preventDefault(); input.value = '/' + items[index].name;
      if (e.key === 'Tab') { input.value += ' '; close(); refreshInput(); }
      else submit();
      return true;
    }
    return false;
  };
  input.setAttribute('aria-controls', menu.id);
  input.setAttribute('aria-expanded', 'false');
  input.addEventListener('input', update);
  input.addEventListener('click', update);
  input.addEventListener('keyup', e => { if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) update(); });
  input.addEventListener('blur', close);
  return { submit, keydown, close };
}
