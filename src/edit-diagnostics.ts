// Sugestões servem somente para diagnóstico; nunca autorizam uma escrita aproximada.
export function editDiagnostics(original: string, oldText: string, newText: string) {
  const lines = original.split('\n');
  const wanted = oldText.replace(/\r\n/g, '\n').split('\n');
  const clean = (s: string) => s.replace(/\r$/, '').trim();
  const meaningful = wanted.map((text, index) => ({ text: clean(text), index }))
    .filter(item => item.text.length >= 8);
  const anchors = meaningful.filter((_, i) => i % Math.max(1, Math.ceil(meaningful.length / 8)) === 0).slice(0, 8);
  const starts = new Set<number>();
  for (let i = 0; i < lines.length && starts.size < 64; i++) {
    const text = clean(lines[i]);
    for (const anchor of anchors) {
      if (text === anchor.text && i >= anchor.index) starts.add(i - anchor.index);
    }
  }
  if (!starts.size && meaningful.length) {
    const anchor = meaningful[0];
    const prefix = anchor.text.slice(0, Math.min(12, anchor.text.length));
    for (let i = 0; i < lines.length && starts.size < 64; i++) {
      if (i >= anchor.index && clean(lines[i]).startsWith(prefix)) starts.add(i - anchor.index);
    }
  }
  const samples = meaningful.filter((_, i) => i % Math.max(1, Math.ceil(meaningful.length / 32)) === 0).slice(0, 32);
  const similarity = (a: string, b: string) => {
    if (a === b) return 1;
    const tokens = new Set(a.slice(0, 2000).match(/\w+|[^\s\w]/g) || []);
    const other = new Set(b.slice(0, 2000).match(/\w+|[^\s\w]/g) || []);
    const common = [...tokens].filter(t => other.has(t)).length;
    return common / Math.max(1, tokens.size + other.size - common);
  };
  const candidates = [...starts].map(start => ({ start, score: samples.reduce((sum, item) =>
    sum + similarity(item.text, clean(lines[start + item.index] || '')), 0) / Math.max(1, samples.length) }))
    .filter(item => item.score >= .45).sort((a, b) => b.score - a.score || a.start - b.start);
  const base = {
    content_source: 'Fresh disk read at the time of this edit; not a cached tool result.',
    file_changed: false,
    replacement_present: newText.length > 0 && original.replace(/\r\n/g, '\n').includes(newText.replace(/\r\n/g, '\n')),
    hint: 'Do not repeat the same old_text. Inspect the current excerpt and build a new exact, unique snippet. If replacement_present is true, check whether the intended change is already present. No approximate replacement was performed.'
  };
  if (!candidates.length) return { ...base, hint: base.hint + ' No reliable nearby match was found. Use read_file with query for a distinctive literal from the target section.' };
  const start = candidates[0].start;
  let difference = 0;
  while (difference < wanted.length && wanted[difference] === (lines[start + difference] || '').replace(/\r$/, '')) difference++;
  const focus = Math.min(start + difference, lines.length - 1);
  const from = Math.max(0, focus - 3);
  const to = Math.min(lines.length, from + Math.min(40, Math.max(8, wanted.length + 6)));
  const excerpt = lines.slice(from, to).join('\n');
  return {
    ...base,
    candidate_is_suggestion: true,
    candidate_line: start + 1,
    candidate_count: candidates.length,
    difference: {
      line: focus + 1,
      expected: (wanted[difference] || '').slice(0, 500),
      actual: (lines[focus] || '').replace(/\r$/, '').slice(0, 500),
      lines_shortened: (wanted[difference] || '').length > 500 || (lines[focus] || '').length > 500
    },
    current_excerpt: excerpt.slice(0, 4000),
    excerpt_start_line: from + 1,
    excerpt_truncated: excerpt.length > 4000 || from > start || to < start + wanted.length,
    read_request: { offset: from + 1, limit: to - from }
  };
}
