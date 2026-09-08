// Aceita caminhos absolutos do projeto, comuns nas chamadas de modelos de código.
export function workspacePath(workspace: string, filename = '') {
  const normalize = (path: string) => {
    const parts: string[] = [];
    for (const part of path.replace(/\\/g, '/').split('/')) {
      if (part === '.') continue;
      if (part === '..') { if (parts.length > 1) parts.pop(); else throw new Error('Path is outside the current workspace.'); }
      else parts.push(part);
    }
    return parts.join('/').replace(/\/$/, '');
  };
  const root = normalize(workspace);
  const target = normalize(/^(?:[a-z]:[\\/]|[\\/])/i.test(filename) ? filename : `${root}/${filename}`);
  const windows = /^[a-z]:/i.test(root) || root.startsWith('//');
  const compare = windows ? target.toLowerCase() : target;
  const base = windows ? root.toLowerCase() : root;
  if (compare !== base && !compare.startsWith(base + '/')) throw new Error('Path is outside the current workspace. Use a relative path or an absolute path inside this project.');
  return target;
}
