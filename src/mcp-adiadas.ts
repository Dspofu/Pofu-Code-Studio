// Ferramentas MCP carregadas sob demanda. Um servidor grande (o Higgsfield expõe 184
// ferramentas) mandava ~130 mil tokens de schema em TODA requisição, antes de qualquer
// mensagem: medido num chat real, o primeiro pedido, com 543 caracteres de histórico, já
// cobrou 135.900 tokens de prompt. Aqui fica o índice só com os nomes e a busca que decide
// quais schemas entram no payload. Puro, para testar em Node.

export interface FerramentaAdiada {
  /** Nome no payload: mcp__servidor__ferramenta. */
  nome: string;
  server: string;
  /** Nome original no servidor. */
  tool: string;
  description: string;
}

export const MAX_CARGA_POR_CONSULTA = 8;

const primeiraFrase = (s: string) => {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  const m = t.match(/^.{20,200}?[.!?](\s|$)/);
  return (m ? m[0] : t.slice(0, 160)).trim();
};

// Agrupa por servidor e escreve o prefixo uma vez: repetir "mcp__higgsfield__" 184 vezes
// custava mais que os próprios nomes.
export function descricaoDoCarregador(adiadas: FerramentaAdiada[]): string {
  const porServidor = new Map<string, FerramentaAdiada[]>();
  for (const f of adiadas) {
    if (!porServidor.has(f.server)) porServidor.set(f.server, []);
    porServidor.get(f.server).push(f);
  }
  const linhas = [...porServidor].map(([server, fs]) => {
    const prefixo = fs[0].nome.slice(0, fs[0].nome.length - fs[0].nome.split('__').pop().length);
    return `${server} (full name = ${prefixo}<name>): ${fs.map(f => f.nome.slice(prefixo.length)).join(', ')}`;
  });
  return 'Loads MCP server tools that are not in your tool list yet (kept out so every request stays small). ' +
    'Before calling one of the tools below, load it here by name, or by a keyword query when you do not know the name. ' +
    'Loaded tools stay in your tool list for the rest of the chat and are called directly by their full name. ' +
    'Never guess the arguments of a tool you have not loaded.\nAvailable, by server:\n' + linhas.join('\n');
}

export const SCHEMA_CARREGADOR = {
  type: 'object',
  properties: {
    names: { type: 'array', items: { type: 'string' }, description: 'Tool names to load, full (mcp__server__tool) or short (tool).' },
    query: { type: 'string', description: `Keywords to search tool names and descriptions; loads up to ${MAX_CARGA_POR_CONSULTA} best matches.` }
  }
};

const normaliza = (s: string) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
const palavras = (s: string) => normaliza(s).split(/[^a-z0-9]+/).filter(p => p.length > 1);

export function resolveCarga(args: { names?: unknown; query?: unknown }, adiadas: FerramentaAdiada[]) {
  const porNome = new Map<string, FerramentaAdiada>();
  for (const f of adiadas) { porNome.set(normaliza(f.nome), f); if (!porNome.has(normaliza(f.tool))) porNome.set(normaliza(f.tool), f); }
  const escolhidas = new Map<string, FerramentaAdiada>();
  const naoAchadas: string[] = [];
  const nomes = Array.isArray(args?.names) ? args.names : typeof args?.names === 'string' ? String(args.names).split(/[,\s]+/) : [];
  for (const n of nomes.map(String).map(s => s.trim()).filter(Boolean)) {
    const f = porNome.get(normaliza(n)) || porNome.get(normaliza(n.split('__').pop()));
    if (f) escolhidas.set(f.nome, f); else naoAchadas.push(n);
  }
  const termos = palavras(String(args?.query || '') + ' ' + naoAchadas.join(' '));
  if (termos.length) {
    const pontuadas = adiadas.filter(f => !escolhidas.has(f.nome)).map(f => {
      const nome = palavras(f.tool.replace(/_/g, ' ')), desc = palavras(f.description);
      let pontos = 0;
      for (const t of termos) {
        if (nome.includes(t)) pontos += 4;
        else if (nome.some(p => p.startsWith(t) || t.startsWith(p) && p.length > 3)) pontos += 2;
        if (desc.includes(t)) pontos += 1;
      }
      return { f, pontos };
    }).filter(x => x.pontos > 0).sort((a, b) => b.pontos - a.pontos);
    for (const { f } of pontuadas.slice(0, MAX_CARGA_POR_CONSULTA)) escolhidas.set(f.nome, f);
  }
  return { carregar: [...escolhidas.values()], naoAchadas };
}

// O modelo às vezes embrulha os argumentos num campo que o schema não tem: visto com o
// Higgsfield, {"prompt":{"preset":"…"}} no lugar de {"preset":"…"}. O servidor ignorou o
// campo desconhecido e devolveu a lista de TODOS os presets, 53 mil caracteres no contexto.
// Só desembrulha quando não há ambiguidade: uma chave só, fora do schema, cujo valor é um
// objeto com chaves todas do schema.
export function desembrulhaArgs(args: any, schema: any): { args: any; campo: string | null } {
  const props = schema && typeof schema.properties === 'object' ? schema.properties : null;
  if (!props || !args || typeof args !== 'object' || Array.isArray(args)) return { args, campo: null };
  const chaves = Object.keys(args);
  if (chaves.length !== 1 || chaves[0] in props) return { args, campo: null };
  const dentro = args[chaves[0]];
  if (!dentro || typeof dentro !== 'object' || Array.isArray(dentro)) return { args, campo: null };
  const internas = Object.keys(dentro);
  if (!internas.length || !internas.every(k => k in props)) return { args, campo: null };
  return { args: dentro, campo: chaves[0] };
}

export function respostaDaCarga(carregar: FerramentaAdiada[], naoAchadas: string[], jaCarregadas: Set<string>): string {
  if (!carregar.length) {
    return JSON.stringify({ error: `No MCP tool matched${naoAchadas.length ? ': ' + naoAchadas.join(', ') : ''}.`,
      hint: 'Use a name from the list in the load_mcp_tools description, or a shorter keyword query.' });
  }
  const linhas = carregar.map(f => `- ${f.nome}${jaCarregadas.has(f.nome) ? ' (already loaded)' : ''}: ${primeiraFrase(f.description)}`);
  return `Loaded ${carregar.length} MCP tool(s); their full schemas are now in your tool list. Call them directly:\n` + linhas.join('\n') +
    (naoAchadas.length ? `\nNot found by exact name: ${naoAchadas.join(', ')} (searched them as keywords).` : '');
}
