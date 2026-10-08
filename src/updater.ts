import { createHash } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync, rmSync } from 'node:fs';
import { execFile, spawn } from 'node:child_process';
import { dirname, join } from 'node:path';

export type MetodoAtualizacao = 'nsis' | 'deb' | 'rpm';
export type AssetRelease = { name: string; url: string; size: number; digest?: string };
export type ProgressoAtualizacao = { fase: 'baixando' | 'conferindo' | 'instalando'; recebidos?: number; total?: number };

const ARQUITETURAS: Record<string, Record<MetodoAtualizacao, RegExp>> = {
  x64: { nsis: /\.exe$/i, deb: /_amd64\.deb$/i, rpm: /\.x86_64\.rpm$/i },
  arm64: { nsis: /\.exe$/i, deb: /_arm64\.deb$/i, rpm: /\.aarch64\.rpm$/i },
};

// Só o instalador do próprio formato serve: um .rpm no Ubuntu ou o .exe de outra
// arquitetura falham no meio da instalação, depois de o app já ter fechado.
export function escolheAsset(assets: AssetRelease[], metodo: MetodoAtualizacao, arch = process.arch): AssetRelease | undefined {
  const padrao = ARQUITETURAS[arch]?.[metodo];
  if (!padrao) return undefined;
  const candidatos = assets.filter(a => padrao.test(a.name) && !/\.blockmap$/i.test(a.name));
  return metodo === 'nsis' ? candidatos.find(a => /setup/i.test(a.name)) || candidatos[0] : candidatos[0];
}

// O GitHub publica o sha256 de cada asset ("sha256:<hex>"). Sem ele não há como saber
// se o instalador baixado é o publicado, e instalar às cegas com privilégio de
// administrador não é aceitável: a instalação automática é recusada.
export function sha256Esperado(digest?: string): string | undefined {
  const m = /^sha256:([0-9a-f]{64})$/i.exec(String(digest || '').trim());
  return m ? m[1].toLowerCase() : undefined;
}

function roda(cmd: string, args: string[], timeout = 15000): Promise<{ code: number; saida: string }> {
  return new Promise(resolve => {
    execFile(cmd, args, { timeout, windowsHide: true }, (err: any, stdout, stderr) => {
      if (err?.code === 'ENOENT') return resolve({ code: 127, saida: `${cmd}: not found` });
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, saida: String(stdout || '') + String(stderr || '') });
    });
  });
}

// Quem sabe se o app veio de .deb ou .rpm é o gerenciador de pacotes: pergunta-se a
// ele quem é dono do executável. O Ubuntu pode ter o `rpm` instalado (o CI do próprio
// projeto instala), então ter o comando não prova nada — só ser dono do arquivo.
export async function detectaMetodo(opts: { isPackaged: boolean; execPath: string; productName: string; platform?: string }): Promise<MetodoAtualizacao | null> {
  const platform = opts.platform || process.platform;
  if (!opts.isPackaged) return null;
  if (platform === 'win32') return existsSync(join(dirname(opts.execPath), `Uninstall ${opts.productName}.exe`)) ? 'nsis' : null;
  if (platform !== 'linux') return null;
  if ((await roda('dpkg', ['-S', opts.execPath])).code === 0) return 'deb';
  if ((await roda('rpm', ['-qf', opts.execPath])).code === 0) return 'rpm';
  return null;
}

export async function baixaInstalador(asset: AssetRelease, destinoDir: string, signal: AbortSignal, progresso: (p: ProgressoAtualizacao) => void): Promise<string> {
  const esperado = sha256Esperado(asset.digest);
  if (!esperado) throw new Error('O release não informa o sha256 do instalador; baixe pela página do GitHub.');
  mkdirSync(destinoDir, { recursive: true });
  const destino = join(destinoDir, asset.name.replace(/[^\w.-]/g, '_'));
  const resp = await fetch(asset.url, { signal, headers: { 'User-Agent': 'Pofu-Code-Studio' } });
  if (!resp.ok || !resp.body) throw new Error(`Download falhou: HTTP ${resp.status}.`);
  const total = Number(resp.headers.get('content-length')) || asset.size || 0;
  const hash = createHash('sha256'), arquivo = createWriteStream(destino);
  let recebidos = 0, avisado = 0;
  try {
    for await (const pedaco of resp.body as any as AsyncIterable<Uint8Array>) {
      hash.update(pedaco); recebidos += pedaco.length;
      if (!arquivo.write(pedaco)) await new Promise(ok => arquivo.once('drain', ok));
      if (Date.now() - avisado > 200) { avisado = Date.now(); progresso({ fase: 'baixando', recebidos, total }); }
    }
    await new Promise<void>((ok, falha) => arquivo.end((e?: Error) => e ? falha(e) : ok()));
  } catch (e) {
    arquivo.destroy(); rmSync(destino, { force: true });
    throw e;
  }
  progresso({ fase: 'conferindo', recebidos, total });
  if (hash.digest('hex') !== esperado) { rmSync(destino, { force: true }); throw new Error('O instalador baixado não confere com o sha256 publicado no release.'); }
  return destino;
}

// `--updated` faz o instalador do electron-builder reaproveitar a pasta e o modo
// (usuário/todos) da instalação atual e encerrar a instância aberta; `--force-run`
// reabre o app no fim. É a mesma linha que o electron-updater usa.
export function iniciaInstaladorWindows(arquivo: string) {
  spawn(arquivo, ['--updated', '/S', '--force-run'], { detached: true, stdio: 'ignore', windowsHide: false }).unref();
}

// pkexec abre o diálogo de senha do próprio desktop. 126/127 = autorização negada ou
// cancelada: não é falha do pacote, e a mensagem precisa dizer isso.
export async function instalaPacoteLinux(arquivo: string, metodo: 'deb' | 'rpm'): Promise<void> {
  let cmd: string[];
  if (metodo === 'deb') cmd = ['apt-get', 'install', '-y', '--allow-downgrades', arquivo];
  else cmd = (await roda('sh', ['-c', 'command -v dnf'])).code === 0 ? ['dnf', 'install', '-y', arquivo] : ['rpm', '-U', '--replacepkgs', arquivo];
  const r = await roda('pkexec', cmd, 15 * 60_000);
  if (r.code === 126 || r.code === 127) throw new Error(r.code === 127 && /not found|não encontrado/i.test(r.saida) ? 'pkexec não está disponível; instale o pacote manualmente.' : 'Autorização cancelada.');
  if (r.code !== 0) throw new Error(`A instalação falhou (código ${r.code}). ${r.saida.trim().split('\n').slice(-3).join(' ')}`.trim());
}
