export function mentionParts(text: string) {
  const parts: { text: string; mention: boolean }[] = [];
  const pattern = /(^|[\s(])(@(?:"[^"\r\n]+"|[^\s@<>"`,;!?()]+))/g;
  let cursor = 0;
  for (const match of text.matchAll(pattern)) {
    const start = match.index + match[1].length;
    if (start > cursor) parts.push({ text: text.slice(cursor, start), mention: false });
    parts.push({ text: match[2], mention: true });
    cursor = start + match[2].length;
  }
  if (cursor < text.length) parts.push({ text: text.slice(cursor), mention: false });
  return parts;
}

export function paintMentions(target: HTMLElement, text: string) {
  target.replaceChildren();
  for (const part of mentionParts(text)) {
    if (!part.mention) target.append(document.createTextNode(part.text));
    else {
      const mark = document.createElement('span'); mark.className = 'file-mention';
      mark.textContent = part.text; target.append(mark);
    }
  }
}

// Mantém o textarea nativo para seleção, IME, colagem e desfazer; só a cor é desenhada atrás.
export function mountMentionHighlight(input: HTMLTextAreaElement, layer: HTMLElement) {
  const sync = () => {
    const style = getComputedStyle(input);
    for (const property of ['font-family', 'font-size', 'font-weight', 'line-height', 'letter-spacing', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left', 'tab-size'])
      layer.style.setProperty(property, style.getPropertyValue(property));
    layer.style.width = input.clientWidth + 'px';
    layer.style.height = input.clientHeight + 'px';
    paintMentions(layer, input.value + (input.value.endsWith('\n') ? ' ' : ''));
    layer.scrollTop = input.scrollTop; layer.scrollLeft = input.scrollLeft;
  };
  input.classList.add('highlighted-input');
  input.addEventListener('input', sync);
  input.addEventListener('scroll', () => { layer.scrollTop = input.scrollTop; layer.scrollLeft = input.scrollLeft; });
  new ResizeObserver(sync).observe(input);
  sync();
  return sync;
}
