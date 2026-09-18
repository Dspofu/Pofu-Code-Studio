// Formato do que as ferramentas devolvem ao MODELO. Tudo aqui existe para gastar menos
// tokens sem esconder informação: JSON com as mesmas chaves repetidas em cada item custa
// mais que o próprio conteúdo. Medido numa busca real deste repositório (20 achados com
// 2 linhas de contexto): 11,9 mil caracteres em JSON contra 3,6 mil agrupado por arquivo.

// Glob simples (*.js, src/**/*.test.js): "*" fica num segmento e "**" atravessa barras.
export function globToRegex(glob: string) {
  let out = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        // "src/**/*.js" precisa casar também com "src/app.js": o "**/" cobre ZERO ou mais pastas.
        if (glob[i + 2] === '/') { out += '(?:.*/)?'; i += 2; } else { out += '.*'; i++; }
      } else out += '[^/]*';
    } else if (c === '?') out += '[^/]';
    else if ('.+^${}()|[]\\'.includes(c)) out += '\\' + c;
    else out += c;
  }
  return new RegExp('^' + out + '$', 'i');
}

// ---------------------------------------------------------------------------
// Saída de terminal
// ---------------------------------------------------------------------------
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;

// Cor, barra de progresso e CRLF não carregam informação para o modelo e custam caro: no
// JSON cada \r\n vira 4 caracteres, e um `npm install` redesenha a mesma linha centenas de
// vezes com \r. O terminal só MOSTRA o último redesenho — é ele que fica.
export function cleanTerminalOutput(text: string) {
  if (typeof text !== 'string' || !text) return text;
  let s = text.replace(ANSI, '').replace(/\r\n/g, '\n');
  if (s.includes('\r')) s = s.split('\n').map(l => {
    const partes = l.split('\r').filter(p => p.length);
    return partes.length ? partes[partes.length - 1] : '';
  }).join('\n');
  while (/[^\n][\b]/.test(s)) s = s.replace(/[^\n][\b]/g, '');
  const out: string[] = [];
  const linhas = s.split('\n');
  for (let i = 0; i < linhas.length;) {
    let j = i + 1;
    while (j < linhas.length && linhas[j] === linhas[i]) j++;
    const repeticoes = j - i;
    if (!linhas[i].trim()) out.push(...linhas.slice(i, i + Math.min(repeticoes, 2)));
    else if (repeticoes >= 3) out.push(linhas[i], `[previous line repeated ${repeticoes - 1} more times]`);
    else out.push(...linhas.slice(i, j));
    i = j;
  }
  return out.join('\n');
}

// ---------------------------------------------------------------------------
// search_files
// ---------------------------------------------------------------------------
type Ctx = { line: number; text: string; shortened?: boolean };
type Match = { file: string; line: number; column: number; text: string; textColumn?: number; shortened?: boolean; before?: Ctx[]; after?: Ctx[] };

const plural = (n: number, um: string, varios = um + 's') => `${n} ${n === 1 ? um : varios}`;

// Agrupado por arquivo, no formato do rg/grep que os modelos já conhecem: "N:" é a linha
// que casou e "N-" é contexto. Contextos que se sobrepõem entre achados vizinhos saem UMA
// vez (em JSON cada achado carregava a própria cópia), e "--" separa blocos distantes.
export function formatSearch(res: any) {
  if (!res?.success) return JSON.stringify({ error: res?.error || 'Search failed.' });
  const avisos: string[] = [];
  if (res.countCapped) avisos.push('Count capped at 10000 matching lines; narrow the query or file_pattern.');
  if (res.skippedLarge) avisos.push(`${res.skippedLarge} file(s) over 25 MiB were not scanned.`);
  const rodape = avisos.length ? '\n' + avisos.join(' ') : '';

  if (res.mode === 'count')
    return `${plural(res.totalFound, 'matching line')} in ${plural(Object.keys(res.fileCounts || {}).length, 'file')} (scanned ${res.scanned}).${rodape}`;
  if (res.mode === 'files') {
    const arquivos = Object.entries(res.fileCounts || {}) as Array<[string, number]>;
    if (!arquivos.length) return `No matches for ${JSON.stringify(res.query)} (scanned ${res.scanned} files).${rodape}`;
    const mostra = arquivos.slice(0, res.maxFiles || 200);
    return `${plural(arquivos.length, 'file')} with ${plural(res.totalFound, 'matching line')}:\n` +
      mostra.map(([f, n]) => `${f}: ${n}`).join('\n') +
      (mostra.length < arquivos.length ? `\n[${arquivos.length - mostra.length} more files; refine file_pattern]` : '') + rodape;
  }

  const matches: Match[] = res.matches || [];
  if (!matches.length)
    return res.totalFound
      ? `No matches at offset ${res.offset || 0}; total ${res.totalFound}.${rodape}`
      : `No matches for ${JSON.stringify(res.query)} (scanned ${res.scanned} files).${rodape}`;

  const inicio = (res.offset || 0) + 1, fim = (res.offset || 0) + matches.length;
  let cab = `${plural(res.totalFound, 'match', 'matches')}`;
  if (res.next_offset != null || inicio > 1) cab += `; showing ${inicio}-${fim}` + (res.next_offset != null ? `, continue with offset=${res.next_offset}` : '');
  const partes = [cab + ':'];

  const porArquivo = new Map<string, Match[]>();
  for (const m of matches) {
    if (!porArquivo.has(m.file)) porArquivo.set(m.file, []);
    porArquivo.get(m.file).push(m);
  }
  let recortou = false;
  for (const [file, lista] of porArquivo) {
    partes.push(file);
    const linhas = new Map<number, string>();
    const casou = new Set<number>();
    for (const m of lista) {
      for (const c of m.before || []) if (!linhas.has(c.line)) linhas.set(c.line, `${c.line}-${c.text}${c.shortened ? '…' : ''}`);
      let texto = m.text;
      if (m.shortened) {
        recortou = true;
        const ini = m.textColumn || 1;
        texto = `[col ${m.column}] ${ini > 1 ? '…' : ''}${m.text}…`;
      }
      linhas.set(m.line, `${m.line}:${texto}`);
      casou.add(m.line);
      for (const c of m.after || []) if (!casou.has(c.line)) linhas.set(c.line, `${c.line}-${c.text}${c.shortened ? '…' : ''}`);
    }
    let anterior = -1;
    for (const n of [...linhas.keys()].sort((a, b) => a - b)) {
      if (anterior !== -1 && n > anterior + 1) partes.push('--');
      partes.push(linhas.get(n));
      anterior = n;
    }
  }
  if (recortou) partes.push('[Long lines are excerpts around the match. read_file with query jumps straight to it.]');
  return partes.join('\n') + rodape;
}

// ---------------------------------------------------------------------------
// list_files
// ---------------------------------------------------------------------------
export function fmtBytes(n: number) {
  if (!Number.isFinite(n)) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function formatListing(entries: Array<{ name: string; isDirectory: boolean; size?: number }>, pattern?: string) {
  const re = pattern ? globToRegex(pattern) : null;
  const itens = (entries || []).filter(e => e.isDirectory || !re || re.test(e.name));
  if (!itens.length) return pattern ? `No entries match ${JSON.stringify(pattern)}.` : '(empty folder)';
  const pastas = itens.filter(e => e.isDirectory).map(e => e.name + '/');
  const arquivos = itens.filter(e => !e.isDirectory).map(e => e.size != null ? `${e.name}  ${fmtBytes(e.size)}` : e.name);
  return [...pastas, ...arquivos].join('\n');
}

// Caminho de pasta UMA vez, arquivos embaixo: numa lista plana o mesmo prefixo
// ("src/components/forms/") se repetia em cada linha. Pastas saem com caminho completo, não
// aninhadas por recuo — reconstruir o caminho contando espaços é onde o modelo erra.
export function formatTree(files: string[], opts: { capped?: boolean; pattern?: string; cap?: number } = {}) {
  const re = opts.pattern ? globToRegex(opts.pattern) : null;
  const lista = (files || []).filter(f => !re || re.test(f) || re.test(f.slice(f.lastIndexOf('/') + 1)));
  if (!lista.length) return opts.pattern ? `No files match ${JSON.stringify(opts.pattern)}.` : '(no files)';
  const grupos = new Map<string, string[]>();
  for (const f of lista) {
    const barra = f.lastIndexOf('/');
    const dir = barra < 0 ? './' : f.slice(0, barra + 1);
    if (!grupos.has(dir)) grupos.set(dir, []);
    grupos.get(dir).push(f.slice(barra + 1));
  }
  const partes = [`${plural(lista.length, 'file')} in ${plural(grupos.size, 'folder')}:`];
  for (const dir of [...grupos.keys()].sort()) partes.push(dir, ...grupos.get(dir).map(n => '  ' + n));
  if (opts.capped) partes.push(`[Listing capped at ${opts.cap || 5000} paths; pass subpath or pattern to see the rest.]`);
  return partes.join('\n');
}

// ---------------------------------------------------------------------------
// Arquivo não encontrado
// ---------------------------------------------------------------------------
function distancia(a: string, b: string) {
  if (Math.abs(a.length - b.length) > 3) return 99;
  const d = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = d[0]; d[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const t = d[j];
      d[j] = Math.min(d[j] + 1, d[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = t;
    }
  }
  return d[b.length];
}

// "File not found" sem pista custa um list_files ou um search_files na volta. O mesmo nome
// em outra pasta, outra extensão ou um erro de digitação resolvem a maioria dos casos.
export function suggestPaths(target: string, files: string[], max = 5) {
  const nome = String(target || '').replace(/\\/g, '/').split('/').pop().toLowerCase();
  if (!nome) return [];
  const radical = nome.replace(/\.[^.]+$/, '');
  const pontuados: Array<[number, string]> = [];
  for (const f of files || []) {
    const base = f.slice(f.lastIndexOf('/') + 1).toLowerCase();
    let p = -1;
    if (base === nome) p = 0;
    else if (base.replace(/\.[^.]+$/, '') === radical) p = 1;
    else { const d = distancia(base, nome); if (d <= 2) p = 1 + d; }
    if (p >= 0) pontuados.push([p, f]);
  }
  return pontuados.sort((a, b) => a[0] - b[0] || a[1].length - b[1].length).slice(0, max).map(x => x[1]);
}
