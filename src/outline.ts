// Estrutura de um arquivo sem os corpos: funções, classes, métodos e tipos com a linha de
// cada um. É a ideia do list_code_definition_names do Cline e do repo map do Aider, que
// usam tree-sitter; aqui são expressões por linguagem, sem binário nativo nem WASM, o que
// mantém o app offline e leve. Erra para o lado de listar a mais (um método de objeto
// literal aparece como definição), nunca de ler o arquivo. O ganho é o mesmo: o modelo lia
// o arquivo inteiro para descobrir onde algo estava, e a estrutura custa uma fração disso.

type Regra = RegExp;
const ID = '[A-Za-z_$][\\w$]*';
const PALAVRAS = new Set(['if', 'for', 'while', 'switch', 'catch', 'function', 'return', 'else', 'do', 'with', 'await', 'typeof', 'new', 'super']);

const JS: Regra[] = [
  new RegExp(`^\\s*(?:export\\s+)?(?:default\\s+)?(?:declare\\s+)?(?:abstract\\s+)?class\\s+${ID}`),
  new RegExp(`^\\s*(?:export\\s+)?(?:declare\\s+)?(?:interface|enum)\\s+${ID}`),
  new RegExp(`^\\s*(?:export\\s+)?(?:declare\\s+)?type\\s+${ID}\\s*(?:<[^>]*>)?\\s*=`),
  new RegExp(`^\\s*(?:export\\s+)?(?:default\\s+)?(?:async\\s+)?function\\s*\\*?\\s*${ID}\\s*(?:<[^>]*>)?\\s*\\(`),
  new RegExp(`^\\s*(?:export\\s+)?(?:const|let|var)\\s+${ID}\\s*(?::[^=]+)?=\\s*(?:async\\s+)?(?:function\\b|\\([^()]*\\)\\s*(?::[^=]+)?=>|${ID}\\s*=>)`),
  // Método: indentado, parâmetros sem parêntese dentro (senão `fn(function () {` casaria)
  // e terminando em "{". O nome passa pelo filtro de PALAVRAS (if/for/while…).
  new RegExp(`^\\s+(?:(?:public|private|protected|static|readonly|async|override|abstract|get|set)\\s+)*\\*?\\s*(#?${ID})\\s*(?:<[^>]*>)?\\s*\\([^()]*\\)\\s*(?::\\s*[^={;]+)?\\s*\\{\\s*$`)
];
const PY: Regra[] = [/^\s*(?:async\s+)?def\s+\w+\s*\(/, /^\s*class\s+\w+/];
const GO: Regra[] = [/^func\s+(?:\([^)]*\)\s*)?\w+/, /^type\s+\w+/];
const RUST: Regra[] = [
  /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(?:unsafe\s+)?(?:const\s+)?(?:extern\s+"[^"]*"\s+)?fn\s+\w+/,
  /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:struct|enum|trait|mod|union)\s+\w+/,
  /^\s*impl\b/
];
const MOD = '(?:public|private|protected|internal|static|final|abstract|sealed|partial|data|open|override|virtual|async|synchronized|native|default|inline|suspend|readonly)';
const JVM: Regra[] = [
  new RegExp(`^\\s*(?:${MOD}\\s+)*(?:class|interface|enum|record|object|struct)\\s+\\w+`),
  /^\s*(?:[\w@]+\s+)*fun\s+(?:<[^>]*>\s*)?[\w.]+\s*\(/,
  new RegExp(`^\\s*(?:${MOD}\\s+)+[\\w<>\\[\\],.?]+(?:\\s*<[^>]*>)?\\s+\\w+\\s*\\([^;]*$`)
];
const PHP: Regra[] = [/^\s*(?:(?:public|private|protected|static|abstract|final)\s+)*function\s+&?\w+/, /^\s*(?:abstract\s+|final\s+)?(?:class|interface|trait|enum)\s+\w+/];
const RUBY: Regra[] = [/^\s*def\s+[\w.?!=]+/, /^\s*(?:class|module)\s+[\w:]+/];
const C: Regra[] = [
  /^\s*(?:typedef\s+)?(?:struct|class|enum|union|namespace)\s+\w+[^;]*$/,
  /^[A-Za-z_][\w\s*&:<>,]*[\s*&]\*?&?[A-Za-z_~][\w:~]*\s*\([^;]*\)\s*(?:const\s*)?(?:noexcept\s*)?\{?\s*$/
];
const SWIFT: Regra[] = [/^\s*(?:(?:public|private|internal|fileprivate|open|static|final|override|mutating)\s+)*func\s+\w+/, /^\s*(?:(?:public|private|internal|open|final)\s+)*(?:class|struct|enum|protocol|extension|actor)\s+\w+/];
const LUA: Regra[] = [/^\s*(?:local\s+)?function\s+[\w.:]+\s*\(/, /^\s*(?:local\s+)?[\w.]+\s*=\s*function\s*\(/];

const POR_EXTENSAO: Record<string, Regra[]> = {
  js: JS, jsx: JS, ts: JS, tsx: JS, mjs: JS, cjs: JS, mts: JS, cts: JS,
  py: PY, pyw: PY, go: GO, rs: RUST,
  java: JVM, kt: JVM, kts: JVM, cs: JVM, scala: JVM,
  php: PHP, rb: RUBY, swift: SWIFT, lua: LUA,
  c: C, h: C, cc: C, cpp: C, cxx: C, hpp: C, hh: C
};

export function suportaEstrutura(nome: string) {
  return !!POR_EXTENSAO[nome.slice(nome.lastIndexOf('.') + 1).toLowerCase()];
}

export type Definicao = { line: number; nested: boolean; text: string };

export function extraiDefinicoes(texto: string, nome: string, max = 400): { defs: Definicao[]; lines: number; capped: boolean } {
  const regras = POR_EXTENSAO[nome.slice(nome.lastIndexOf('.') + 1).toLowerCase()];
  const linhas = texto.split('\n');
  const defs: Definicao[] = [];
  if (!regras) return { defs, lines: linhas.length, capped: false };
  let emComentario = false;
  for (let i = 0; i < linhas.length; i++) {
    const bruta = linhas[i].replace(/\r$/, '');
    const t = bruta.trim();
    if (emComentario) { if (t.includes('*/')) emComentario = false; continue; }
    if (t.startsWith('/*') && !t.includes('*/')) { emComentario = true; continue; }
    if (!t || t.length > 400 || /^(\/\/|#|\*|--|\/\*)/.test(t)) continue;
    for (const r of regras) {
      const m = bruta.match(r);
      if (!m) continue;
      if (m[1] && PALAVRAS.has(m[1])) break;
      if (defs.length >= max) return { defs, lines: linhas.length, capped: true };
      // Até a abertura do corpo: a assinatura é o que interessa, o "{" e o "=>" não.
      // Arrow function: o casamento termina na seta da declaração, e é ali que a assinatura
      // acaba — o resto da linha é corpo (num one-liner, às vezes uma regex inteira).
      let sig = m[0].trimEnd().endsWith('=>') ? m[0].trim()
        : t.replace(/\s*\{\s*$/, '').replace(/\s*=>\s*\{?\s*$/, ' =>');
      if (sig.length > 140) sig = sig.slice(0, 139) + '…';
      defs.push({ line: i + 1, nested: /^\s/.test(bruta), text: sig });
      break;
    }
  }
  return { defs, lines: linhas.length, capped: false };
}

export function formataEstrutura(arquivos: Array<{ file: string; lines: number; defs: Definicao[]; capped?: boolean }>, avisos: string[] = []) {
  const com = arquivos.filter(a => a.defs.length);
  const sem = arquivos.filter(a => !a.defs.length).map(a => a.file);
  if (!com.length) return (sem.length ? `No definitions found in ${sem.length} file(s).` : 'No supported source files here.') + (avisos.length ? '\n' + avisos.join('\n') : '');
  const partes: string[] = [];
  for (const a of com) {
    partes.push(`${a.file} (${a.lines} lines)`);
    for (const d of a.defs) partes.push(`${d.nested ? '    ' : '  '}${d.line}: ${d.text}`);
    if (a.capped) partes.push('  [more definitions omitted; read_file with query to find the rest]');
  }
  if (sem.length) partes.push(`[no definitions: ${sem.slice(0, 20).join(', ')}${sem.length > 20 ? ` and ${sem.length - 20} more` : ''}]`);
  partes.push(...avisos);
  return partes.join('\n');
}
