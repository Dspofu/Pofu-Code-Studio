// SPDX-License-Identifier: Apache-2.0

// JSON.parse aceita chave repetida e fica com a ÚLTIMA: dois "mcpServers" no mesmo texto faziam os
// servidores do primeiro sumirem sem aviso nenhum, e só o erro do último aparecia.
export function chaveRepetida(texto: string): string | null {
  const pilha: (Set<string> | null)[] = [];
  for (let i = 0; i < texto.length; i++) {
    const c = texto[i];
    if (c === '"') {
      let j = i + 1;
      while (j < texto.length && texto[j] !== '"') j += texto[j] === '\\' ? 2 : 1;
      let k = j + 1; while (/\s/.test(texto[k] || '')) k++;
      const chaves = pilha[pilha.length - 1];
      if (texto[k] === ':' && chaves) { const chave = texto.slice(i + 1, j); if (chaves.has(chave)) return chave; chaves.add(chave); }
      i = j;
    } else if (c === '{') pilha.push(new Set()); else if (c === '[') pilha.push(null); else if (c === '}' || c === ']') pilha.pop();
  }
  return null;
}

// Aceita o JSON como vem no README dos servidores ({ "mcpServers": {…} }) ou só o objeto
// interno. Erro em pt-BR porque aparece no formulário, para quem está configurando.
export function parseMcpConfig(texto: unknown): Record<string, any> {
  const t = String(texto || '').trim();
  if (!t) return {};
  let j;
  try { j = JSON.parse(t); } catch (e) { throw new Error(`MCP: o JSON não é válido — ${e.message}`); }
  const repetida = chaveRepetida(t);
  if (repetida) throw new Error(`MCP: a chave "${repetida}" aparece duas vezes no mesmo bloco, e só a última valeria — o que vem antes seria ignorado. Junte tudo num único "${repetida}".`);
  const servers = j && typeof j === 'object' && j.mcpServers && typeof j.mcpServers === 'object' ? j.mcpServers : j;
  if (!servers || typeof servers !== 'object' || Array.isArray(servers)) throw new Error('MCP: esperado { "mcpServers": { "nome": { "command": … } } }.');
  for (const [nome, cfg] of Object.entries<any>(servers)) {
    if (!cfg || typeof cfg !== 'object' || (!cfg.command && !cfg.url)) throw new Error(`MCP: o servidor "${nome}" precisa de "command" (local) ou "url" (remoto).`);
    if (cfg.tools !== undefined && (!Array.isArray(cfg.tools) || cfg.tools.some(t => typeof t !== 'string' || !t.trim()))) throw new Error(`MCP: "tools" do servidor "${nome}" precisa ser uma lista de nomes, ex.: ["generate_image", "job_status"].`);
  }
  return servers;
}
