// SPDX-License-Identifier: Apache-2.0
// Copyright 2026-present the Pofu Code Studio authors. All rights reserved.
// Licensed under the Apache License, Version 2.0. See /LICENSE and /NOTICE.
// Source: https://github.com/Dspofu/Pofu-Code-Studio

import { app, BrowserWindow, ipcMain, dialog, shell, Menu, clipboard, Notification, nativeImage, safeStorage, desktopCapturer, screen, globalShortcut } from 'electron';
import { dirname, join, relative, resolve, isAbsolute } from 'path';
import { readdirSync, readFileSync, writeFileSync, unlinkSync, existsSync, mkdirSync, statSync, realpathSync, openSync, fstatSync, closeSync, readSync } from 'fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'os';
import { spawn } from 'child_process';
import { fileURLToPath, pathToFileURL } from 'url';
// main.ts e os demais módulos moram no MESMO diretório (src/), então os imports são
// "./x.js" — o rootDir "src" do tsconfig espelha a estrutura em out/.
import { WebSearch } from './websearch.js';
import { WebResearch } from './web-research.js';
import { articleText, researchGate } from './research/researchReader.js';
import { navigable } from './research/webpage.js';
import packageJson from '../package.json' with { type: "json" };
import { McpServidor, textoDoResultado, type McpConfig } from './mcp.js';
import { McpOAuth } from './mcp-oauth.js';
import { reparaIconeDoAtalho } from './atalho-windows.js';
import { ConsumptionStore } from './consumption-store.js';
import { queryConsumption, type ConsumptionConnection, type ConsumptionPeriod } from './consumption.js';
import { protectConsumptionKeys, restoreConsumptionKeys } from './consumption-vault.js';
import { RemoteControl } from './remote-control.js';
import { baixaInstalador, detectaMetodo, escolheAsset, iniciaInstaladorWindows, instalaPacoteLinux, type AssetRelease } from './updater.js';
import { DesktopComputer } from './computer.js';
import { windowsComputer } from './computer-windows.js';
import { CAPTURE_FRAME_MS, CAPTURE_SCRIPT_MS, CAPTURE_STEP_MS, CAPTURE_TOTAL_MS, COMPUTER_IMAGE_MAX_SIDE } from './constants.js';
import { fileOps, type FileWorkerPool } from './fileworker.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// No Windows não existe /bin/bash nem grupos de processos no sentido POSIX; várias
// rotinas de terminal precisam de tratamento específico por plataforma.
const isWindows = process.platform === 'win32';

let mainWindow;
const COMPUTER_STOP_SHORTCUT = 'CommandOrControl+Alt+Escape';
function mainSender(event) {
  return !!mainWindow && !mainWindow.isDestroyed() && event.sender === mainWindow.webContents
    && event.senderFrame === mainWindow.webContents.mainFrame
    && event.senderFrame.url.split('#')[0] === pathToFileURL(join(__dirname, '..', 'index.html')).href;
}
function setComputerPermission(enabled: boolean) {
  getDesktopComputer().setEnabled(enabled);
  if (!enabled) { globalShortcut.unregister(COMPUTER_STOP_SHORTCUT); return; }
  if (!globalShortcut.isRegistered(COMPUTER_STOP_SHORTCUT)) globalShortcut.register(COMPUTER_STOP_SHORTCUT, () => {
    getDesktopComputer().cancel();
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('computer-stopped');
  });
}

// As operações de arquivo rodam numa thread separada (ver fileworker.ts): o main só
// despacha e `await`a, então uma leitura pesada não segura o event loop que bombeia a
// janela. `app.getPath('userData')` só existe depois do `whenReady`, por isso a iniciação
// é preguiçosa — a primeira chamada a um handler já vem depois do boot.
let filePool: FileWorkerPool | null = null;
function pool() {
  if (!filePool) filePool = fileOps(app.getPath('userData'));
  return filePool;
}

// Precisa ser idêntico ao "build.appId" do package.json: o instalador NSIS grava esse
// mesmo AUMID no atalho, e o Windows só associa a janela ao atalho (ícone correto na
// barra de tarefas + fixar) quando os dois valores batem.
// Em DESENVOLVIMENTO o AUMID é outro de propósito: o toast do Windows exige um atalho no
// Menu Iniciar carregando o AUMID, e quando não existe nenhum o Electron cria um apontando
// para o electron.exe do node_modules. Com o AUMID de produção, esse atalho de dev passa a
// disputar a resolução com o do instalador — e vence, porque é mais antigo. Aí a barra de
// tarefas e as notificações (que resolvem o ícone via AUMID -> atalho) exibem o ícone do
// Electron, enquanto a janela continua certa (essa lê o ícone embutido no .exe, sem AUMID).
app.setAppUserModelId(app.isPackaged ? "com.dspofu.pofusercoderstudio" : "com.dspofu.pofusercoderstudio.dev")

// __dirname é out/ (ver tsconfig.json) e o assets/ fica na RAIZ do app — sem o "..", o
// caminho não existe e o Electron ignora a opção `icon` em silêncio.
const iconePath = join(__dirname, '..', 'assets', 'icon.png');

// No Windows EMPACOTADO quem manda é o ícone embutido no .exe: o build/icon.ico traz
// 16/24/32/48 desenhados na mão, enquanto esta opção faria o Electron reduzir um PNG de
// 1254px para 16px no título da janela — mais borrado do que o que já vinha. Em dev não
// há .exe próprio (o processo é o electron.exe) e no Linux não existe recurso embutido,
// então nesses dois casos a opção continua sendo a única fonte do ícone.
const iconeDaJanela = (isWindows && app.isPackaged) ? undefined : iconePath;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1380,
    minWidth: 760,
    height: 860,
    minHeight: 560,
    backgroundColor: '#121710',
    icon: iconeDaJanela,
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false
    },
    autoHideMenuBar: true
  });

  // main.js roda de out/ (ver tsconfig.json); o index.html fica na RAIZ do app —
  // sem o join, o loadFile procuraria index.html dentro de out/ e a janela abriria em branco.
  mainWindow.loadFile(join(__dirname, '..', 'index.html'));
  mainWindow.webContents.on('did-start-loading', () => { remoteControl?.stop(); setComputerPermission(false); });
  mainWindow.on('closed', () => setComputerPermission(false));
  // mainWindow.webContents.openDevTools()

  // Links (ex: markdown gerado pela IA, target="_blank" ou window.open) nunca abrem
  // dentro do app — sempre no navegador padrão do sistema.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http:') || url.startsWith('https:')) shell.openExternal(url);
    return { action: 'deny' };
  });

  // Bloqueia qualquer navegação para fora do próprio index.html (cliques em <a> sem
  // target, redirecionamentos etc.) e abre a URL no navegador externo em vez disso.
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (url.startsWith('file://') && url.includes('index.html')) return; // navegação interna legítima
    event.preventDefault();
    if (url.startsWith('http:') || url.startsWith('https:')) shell.openExternal(url);
  });

  // Menu de contexto nativo no clique direito (copiar/colar/selecionar), essencial
  // para copiar textos das respostas. Também oferece abrir link no navegador externo.
  mainWindow.webContents.on('context-menu', (event, params) => {
    const items = [];
    const { editFlags, selectionText, isEditable, linkURL } = params;
    if (linkURL) {
      items.push({ label: 'Abrir link no navegador', click: () => shell.openExternal(linkURL) });
      items.push({ label: 'Copiar endereço do link', click: () => clipboard.writeText(linkURL) });
      items.push({ type: 'separator' });
    }
    if (isEditable) {
      items.push({ label: 'Desfazer', role: 'undo', enabled: editFlags.canUndo });
      items.push({ label: 'Refazer', role: 'redo', enabled: editFlags.canRedo });
      items.push({ type: 'separator' });
      items.push({ label: 'Recortar', role: 'cut', enabled: editFlags.canCut });
    }
    items.push({ label: 'Copiar', role: 'copy', enabled: editFlags.canCopy || !!selectionText });
    if (isEditable) items.push({ label: 'Colar', role: 'paste', enabled: editFlags.canPaste });
    items.push({ type: 'separator' });
    items.push({ label: 'Selecionar tudo', role: 'selectAll' });
    Menu.buildFromTemplate(items).popup({ window: mainWindow });
  });
}

app.whenReady().then(() => {
  createWindow();

  // Antes da primeira notificação: ela também puxa o ícone pelo atalho (ver atalho-windows.ts).
  if (isWindows && app.isPackaged) {
    const menus = [app.getPath('appData'), process.env.ProgramData || 'C:\\ProgramData'].map(base => join(base, 'Microsoft', 'Windows', 'Start Menu', 'Programs', `${packageJson.productName}.lnk`));
    if (menus.some(lnk => reparaIconeDoAtalho(shell, lnk, process.execPath) === 'reparado'))
      spawn('ie4uinit.exe', ['-show'], { windowsHide: true }).on('error', () => { /* o ícone novo aparece no próximo login */ });
  }

  void checkForUpdates().then(result => {
    if (!result.success || !result.maior || !Notification.isSupported()) return;
    try {
      const notification = new Notification({
        title: packageJson.productName,
        body: 'Nova atualização disponível: v' + result.remota + '. Clique para atualizar.'
      });
      notification.on('click', () => {
        if (!mainWindow || mainWindow.isDestroyed()) return;
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.show(); mainWindow.focus(); mainWindow.webContents.send('update-open');
      });
      notification.show();
    } catch { /* Sem serviço de notificações: a versão continua disponível nas configurações. */ }
  });

  // macOS: recria a janela ao clicar no dock com todas fechadas.
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// Manipuladores IPC para ações do sistema de arquivos e terminal
ipcMain.handle('select-folder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory']
  });
  return result.filePaths[0];
});

ipcMain.handle('list-files', async (event, dirPath) => {
  return pool().run('list-files', { dirPath });
});

// A janela é recortada AQUI, e não no renderer: antes o arquivo inteiro atravessava o
// IPC para mostrar uma fração dele. Roda na thread de arquivo (fileworker.ts): o main só
// despacha e `await`a, então um read_file de 25 MiB não segura a janela.
ipcMain.handle('read-file', async (event, filePath, opts: any = {}) => {
  return pool().run('read-file', { filePath, opts });
});

// ==========================================================================
//  Diff e desfazer
// ==========================================================================
// Toda alteração de arquivo guarda o conteúdo ANTERIOR num instantâneo em disco. Em
// disco, e não em memória, porque o botão "Desfazer" fica no histórico do chat: se o
// app reiniciar, o card continua lá e precisa continuar funcionando.
//
// A implementação (mudouDesde, mtimeDe, pastaInstantaneos, podaInstantaneos,
// salvaInstantaneo e calculaDiff) mora no fileworker.ts: o diff LCS e a poda dos
// instantâneos custam CPU/disco o bastante para, no main, segurarem o event loop.

// Remonta o diff a partir do instantâneo. Ao reabrir um chat antigo o histórico só tem
// o snapshotId — o antes/depois vive no arquivo do instantâneo, não no app-store.json.
ipcMain.handle('get-diff', async (event, snapshotId) => {
  return pool().run('get-diff', { snapshotId });
});

// Restaura o arquivo ao estado guardado no instantâneo.
ipcMain.handle('undo-change', async (event, snapshotId) => {
  return pool().run('undo-change', { snapshotId });
});

ipcMain.handle('write-file', async (event, filePath, content, opts = {}) => {
  return pool().run('write-file', { filePath, content, opts });
});

// Edição cirúrgica: troca um trecho exato em vez de reescrever o arquivo inteiro.
// É a ferramenta de escrita padrão do agente — write_file de um arquivo de 800 linhas
// para mudar 3 delas gasta ~10x mais tokens de saída e é onde a geração costuma ser
// cortada no limite, produzindo arquivos truncados.
ipcMain.handle('edit-file', async (event, filePath, oldText, newText, replaceAll = false, opts: any = {}) => {
  return pool().run('edit-file', { filePath, oldText, newText, replaceAll, opts });
});

ipcMain.handle('create-directory', async (event, dirPath) => {
  return pool().run('create-directory', { dirPath });
});

// Informações do app lidas do package.json (ex: URL do GitHub, versão)
ipcMain.handle('get-app-info', async () => {
  try {
    // package.json fica na RAIZ; com outDir o main.js roda de out/ (ver tsconfig.json).
    const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf-8'));
    return {
      githubUrl: pkg.githubUrl || pkg.homepage || (pkg.repository && (pkg.repository.url || pkg.repository)) || '',
      version: pkg.version || '',
      name: pkg.productName || pkg.name || '',
      author: pkg.author || '',
      license: pkg.license || ''
    };
  } catch (e) {
    return { githubUrl: '', version: '', name: '', author: '', license: '' };
  }
});

// A abertura e o botão manual compartilham a consulta para evitar pedidos duplicados.
let updateRequest: ReturnType<typeof fetchLatestUpdate> | undefined;
let updateCheckedAt = 0;
function checkForUpdates() {
  if (!updateRequest || Date.now() - updateCheckedAt >= 60_000) {
    updateCheckedAt = Date.now();
    updateRequest = fetchLatestUpdate();
  }
  return updateRequest;
}
ipcMain.handle('check-update', () => checkForUpdates());

async function fetchLatestUpdate() {
  try {
    const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf-8'));
    const url = pkg.githubUrl || pkg.homepage || (pkg.repository && (pkg.repository.url || pkg.repository)) || '';
    const m = String(url).match(/github\.com[/:]([\w.-]+)\/([\w.-]+)/i);
    if (!m) return { success: false, error: 'Nenhum repositório GitHub configurado no package.json.' };
    const [ , owner, repo ] = m;
    const resp = await fetch(`https://api.github.com/repos/${owner}/${repo}/releases/latest`, {
      headers: { 'User-Agent': 'Pofu-Code-Studio', Accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(12000)
    });
    if (resp.status === 404) return { success: false, error: 'Nenhum release publicado ainda.' };
    if (!resp.ok) return { success: false, error: `GitHub respondeu ${resp.status}.` };
    const rel = await resp.json();
    const remota = String(rel.tag_name || '').replace(/^v/i, '');
    const atual = String(pkg.version || '');
    const stableVersion = /^\d+\.\d+\.\d+$/;
    const maior = !rel.draft && !rel.prerelease && stableVersion.test(remota)
      && stableVersion.test(atual) && compareVersions(atual, remota) < 0;
    return {
      success: true, atual, remota, maior,
      releaseUrl: `https://github.com/${owner}/${repo}/releases/tag/${encodeURIComponent(rel.tag_name)}`,
      nomeRelease: rel.name || rel.tag_name || '',
      notas: String(rel.body || '').slice(0, 20000),
      assets: (Array.isArray(rel.assets) ? rel.assets : []).map(a => ({ name: String(a.name), url: String(a.browser_download_url), size: Number(a.size) || 0, digest: a.digest || undefined })),
      metodo: await metodoAtualizacao()
    };
  } catch (e) {
    return { success: false, error: String(e.message || e) };
  }
}

let metodoCache: Promise<'nsis' | 'deb' | 'rpm' | null> | undefined;
function metodoAtualizacao() {
  return metodoCache ??= detectaMetodo({ isPackaged: app.isPackaged, execPath: process.execPath, productName: packageJson.productName });
}

let atualizacaoEmCurso: AbortController | null = null;
ipcMain.handle('cancel-update', () => { atualizacaoEmCurso?.abort(); return { success: true }; });
ipcMain.handle('install-update', async () => {
  if (atualizacaoEmCurso) return { success: false, error: 'Uma atualização já está em andamento.' };
  const info: any = await checkForUpdates();
  if (!info.success || !info.maior) return { success: false, error: info.error || 'Nenhuma versão nova para instalar.' };
  const metodo = await metodoAtualizacao();
  const asset = metodo && escolheAsset(info.assets as AssetRelease[], metodo);
  if (!metodo || !asset) return { success: false, manual: true, error: 'Este formato de instalação não se atualiza sozinho.' };
  const controle = atualizacaoEmCurso = new AbortController();
  const envia = (p) => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('update-progress', p); };
  try {
    const arquivo = await baixaInstalador(asset, join(tmpdir(), 'pofu-code-studio-update'), controle.signal, envia);
    envia({ fase: 'instalando' });
    if (metodo === 'nsis') {
      iniciaInstaladorWindows(arquivo);
      setTimeout(() => app.quit(), 300);
    } else {
      await instalaPacoteLinux(arquivo, metodo);
      setTimeout(() => { app.relaunch(); app.exit(0); }, 300);
    }
    return { success: true, metodo };
  } catch (e) {
    return { success: false, cancelado: controle.signal.aborted, error: controle.signal.aborted ? 'Download cancelado.' : String(e?.message || e) };
  } finally { atualizacaoEmCurso = null; }
});

// Compara versões semânticas ponto a ponto (1.2.0 < 1.10.0 — comparação por texto
// daria o resultado errado). Sem patch, o campo vira 0.
function compareVersions(a, b) {
  const pa = String(a).split('.').map(n => parseInt(n, 10) || 0);
  const pb = String(b).split('.').map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
}

ipcMain.handle('delete-file', async (event, filePath, opts = {}) => {
  return pool().run('delete-file', { filePath, opts });
});

// A varredura (arvoreDoProjeto) e os limites de busca/estrutura moram no fileworker.ts:
// é o trabalho de disco/CPU que mais segurava o event loop do main.
ipcMain.handle('search-files', async (event, rootPath, opts = {}) => {
  return pool().run('search-files', { rootPath, opts });
});

ipcMain.handle('list-tree', async (event, rootPath) => {
  return pool().run('list-tree', { rootPath });
});

ipcMain.handle('outline', async (event, target, opts: any = {}) => {
  return pool().run('outline', { target, opts });
});

// ==========================================================================
//  Execução de comandos com gerenciamento inteligente de processos
// ==========================================================================
// Registro de processos vivos (servidores, watchers, etc.). Cada entrada mantém
// um buffer rolante de logs para que o agente possa inspecioná-los depois.
const procs = new Map(); // pid -> { command, child, stdout, stderr, startedAt, ready, status }

const LOG_CAP = 2 * 1024 * 1024; // buffer rolante por stream
// Padrões que indicam que um servidor "subiu" (retorno antecipado, sem esperar o timeout)
const READY_PATTERNS = [
  /listening on/i, /now listening/i, /server (is )?(running|started|up|listening)/i,
  /running on/i, /started server/i, /uvicorn running/i, /serving (http|at|on)/i,
  /\blocal:\s*https?:\/\//i, /https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0)[:\/]/i,
  /compiled successfully/i, /ready in \d/i, /ready on/i, /accepting connections/i,
  /listening at/i, /development server/i, /app running/i, /nest application successfully started/i
];

function appendCapped(entry, key, chunk) {
  entry[key] += chunk;
  if (entry[key].length > LOG_CAP) {
    entry[key + 'Dropped'] = (entry[key + 'Dropped'] || 0) + entry[key].length - LOG_CAP;
    entry[key] = entry[key].slice(-LOG_CAP);
  }
}

// Shell por plataforma. No Windows usamos o cmd.exe (ComSpec); no restante, /bin/bash.
// Antes isto era fixo em '/bin/bash', o que fazia o spawn falhar no Windows com
// "spawn /bin/bash ENOENT" — o executável simplesmente não existe lá.
const SHELL = isWindows ? (process.env.ComSpec || 'cmd.exe') : '/bin/bash';

// Encerra um processo E TODA a sua árvore de filhos, de forma multiplataforma.
//  - POSIX: mata o grupo de processos inteiro (pid negativo), possível porque o
//    processo foi criado com `detached: true` (vira líder do próprio grupo).
//  - Windows: `process.kill(-pid)` lança erro (não há grupos POSIX); usamos
//    `taskkill /T` que derruba o processo e todos os descendentes.
function killTree(pid, { force = false } = {}) {
  if (!pid) return;
  if (isWindows) {
    const args = ['/pid', String(pid), '/T'];
    if (force) args.push('/F');
    try { spawn('taskkill', args, { windowsHide: true }); } catch (e) { /* ignora */ }
  } else {
    try { process.kill(-pid, force ? 'SIGKILL' : 'SIGTERM'); } catch (e) { /* ignora */ }
  }
}

ipcMain.handle('execute-command', async (event, command, cwd, opts = {}) => {
  const direct = opts.args !== undefined;
  if (typeof command !== 'string' || !command.trim() || command.includes('\0') ||
      (direct && (!Array.isArray(opts.args) || opts.args.some(arg => typeof arg !== 'string' || arg.includes('\0'))))) {
    return { success: false, finished: true, error: 'Invalid command or args. command must be a nonempty string; args must be an array of strings without NUL characters.' };
  }
  const executable = command;
  if (direct) command = [command, ...opts.args.map(arg => JSON.stringify(arg))].join(' ');
  const hardTimeoutMs = opts.timeoutMs || 25000; // teto absoluto para tarefas que terminam
  const idleMs = opts.idleMs || 2500;            // silêncio => provável servidor ocioso esperando conexões
  const graceMs = 600;                           // tempo mínimo antes de considerar "ocioso"

  return new Promise((resolve) => {
    // detached + stdin ignorado => sessão própria, SEM terminal de controle:
    //  - impede que `sudo` sequestre o terminal do usuário (falha com "a terminal is required")
    //  - permite deixar servidores rodando em segundo plano sem travar o app
    //
    // No WINDOWS, porém, `detached` é o que fazia a janela de console piscar a cada
    // comando, apesar do `windowsHide: true` logo abaixo: `detached` vira DETACHED_PROCESS,
    // e a documentação do CreateProcess diz que CREATE_NO_WINDOW (o que o windowsHide liga)
    // é IGNORADO quando vem junto de DETACHED_PROCESS. Sem console herdado e sem o flag de
    // esconder, o cmd.exe aloca um console próprio — visível. Nada disso se perde ao tirar
    // o detached lá: os dois motivos acima são POSIX (sudo e grupo de processos), e quem
    // encerra a árvore no Windows é o `taskkill /T` do killTree, não o grupo de processos.
    const esconderConsole = opts.hideConsole !== false;
    let child;
    try {
      child = spawn(executable, direct ? opts.args : [], {
        cwd, shell: direct ? false : SHELL,
        detached: !isWindows || !esconderConsole,
        windowsHide: esconderConsole,
        stdio: ['ignore', 'pipe', 'pipe'],
        // NO_COLOR é a convenção que a maioria das CLIs respeita; o que ainda vier colorido
        // o renderer limpa (cleanTerminalOutput) antes de mandar ao modelo.
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', FORCE_COLOR: '0', NO_COLOR: '1' }
      });
    } catch (err) {
      return resolve({ success: false, operation_status: 'failed', command, stdout: '', stderr: '', error: err.message, finished: true });
    }

    const entry: ProcEntry = { command, child, stdout: '', stderr: '', startedAt: Date.now(), ready: false, status: 'running' };
    if (child.pid) {
      procs.set(child.pid, entry);
      // Retém no máximo 32 processos encerrados; nunca remove um processo ainda ativo.
      const finished = [...procs].filter(([, p]) => p.status !== 'running');
      for (const [pid] of finished.slice(0, Math.max(0, finished.length - 32))) procs.delete(pid);
    }
    let settled = false;
    let idleTimer = null;

    const backgroundify = (reason) => {
      if (settled) return;
      settled = true;
      clearTimeout(hardTimer);
      clearTimeout(idleTimer);
      entry.ready = true;
      procs.set(child.pid, entry);
      child.unref();
      resolve({
        success: true, operation_status: 'running', command, pid: child.pid, finished: false, backgrounded: true, reason,
        stdout: entry.stdout, stderr: entry.stderr,
        stdoutDropped: entry.stdoutDropped || 0, stderrDropped: entry.stderrDropped || 0,
        note: `Process moved to the background (PID ${child.pid}) — ${reason}. ` +
              `The chat is NOT stuck. Use read_process_output(${child.pid}) to see the logs, ` +
              `list_processes to list them, and stop_process(${child.pid}) to terminate it.`
      });
    };

    // Reinicia o "cronômetro de ocioso" a cada saída: builds barulhentos seguem esperando;
    // servidores que imprimem o banner e ficam quietos são considerados prontos.
    //
    // IMPORTANTE: o timer só backgroundiza se o processo AINDA ESTIVER VIVO. Antes, um
    // comando rápido com pausa (ex.: `git status` num disco de rede, que fica ~7s sem
    // imprimir nada) era "promovido" a servidor ocioso e devolvia um PID em vez do
    // resultado — o agente então precisava de um read_process_output extra só para ler
    // a saída de algo que já tinha terminado.
    const bumpIdle = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        if (entry.status !== 'exited' && Date.now() - entry.startedAt >= graceMs)
          backgroundify('ficou ocioso (provável servidor aguardando conexões)');
      }, idleMs);
    };

    const onData = (key) => (d) => {
      const s = d.toString();
      appendCapped(entry, key, s);
      // Detecção de "pronto" por padrão de log
      if (!settled && READY_PATTERNS.some(re => re.test(s))) {
        backgroundify('detectado como servidor pronto (padrão de log)');
        return;
      }
      bumpIdle();
    };
    // O decoder mantém caracteres UTF-8 que chegam divididos entre dois blocos.
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', onData('stdout'));
    child.stderr.on('data', onData('stderr'));
    // Sem bumpIdle() aqui de propósito: o cronômetro de ocioso só começa a rodar DEPOIS
    // da PRIMEIRA linha de saída. Um comando travado/silencioso (ex.: `git status` num
    // disco de rede, ~7s sem imprimir nada) não tem como ser confundido com "servidor
    // ocioso" — ele simplesmente termina no 'close'. Já um servidor que imprimiu o banner
    // e ficou quieto entra no idle e vira background. Antes havia um bumpIdle() aqui
    // que promovia a qualquer processo que passasse de idleMs sem sair, mesmo mudo.

    const hardTimer = setTimeout(() => backgroundify(`ainda em execução após ${Math.round(hardTimeoutMs / 1000)}s`), hardTimeoutMs);

    child.on('error', (err) => {
      entry.status = 'error';
      if (settled) return;
      settled = true;
      clearTimeout(hardTimer); clearTimeout(idleTimer);
      resolve({ success: false, operation_status: 'failed', command, pid: child.pid, stdout: entry.stdout, stderr: entry.stderr,
        stdoutDropped: entry.stdoutDropped || 0, stderrDropped: entry.stderrDropped || 0, error: err.message, finished: true });
    });

    child.on('close', (code) => {
      entry.status = 'exited';
      entry.exitCode = code; // guardado no registro: wait_for_process precisa dizer se deu certo
      if (settled) return; // já estava em segundo plano — apenas marca como encerrado no registro
      settled = true;
      clearTimeout(hardTimer); clearTimeout(idleTimer);
      resolve({
        command, pid: child.pid, stdout: entry.stdout, stderr: entry.stderr,
        stdoutDropped: entry.stdoutDropped || 0, stderrDropped: entry.stderrDropped || 0,
        success: code === 0, operation_status: code === 0 ? 'completed' : 'failed',
        error: code === 0 ? null : `Process exited with code ${code}`,
        failure_kind: code === 0 ? undefined : 'command_exit',
        hint: code === 0 ? undefined : 'The process ran and returned a nonzero exit code. Inspect stderr/stdout to diagnose the command or code. For quote-heavy commands, pass the executable as command and each argument in args to bypass shell parsing.',
        exitCode: code, finished: true
      });
    });
  });
});

// Lê o output acumulado de um processo em segundo plano
function unknownProcess(pid) {
  return { success: false, error: `Unknown managed process: ${pid}`,
    managed_pids: [...procs.keys()].slice(-32),
    hint: 'This PID is not registered in this app session. Use list_processes and the PID returned by execute_command; a child PID from terminal output or an earlier app session may differ. No process was stopped.' };
}

ipcMain.handle('read-process-output', async (event, pid) => {
  const entry = procs.get(pid);
  if (!entry) return unknownProcess(pid);
  return {
    success: true, pid, command: entry.command, status: entry.status,
    uptimeSec: Math.round((Date.now() - entry.startedAt) / 1000),
    stdout: entry.stdout, stderr: entry.stderr,
        stdoutDropped: entry.stdoutDropped || 0, stderrDropped: entry.stderrDropped || 0
  };
});

// ESPERA o processo terminar, em vez de o agente ficar perguntando "já acabou?".
// Sem isto, um `npm install` de 20s vira uma dezena de idas e voltas ao modelo —
// cada uma com o histórico inteiro — só para reler "running". Aqui o turno fica
// parado no main até o processo sair (ou até o prazo), e volta UMA resposta.
ipcMain.handle('wait-for-process', async (event, pid, timeoutMs = 120000) => {
  const entry = procs.get(pid);
  if (!entry) return unknownProcess(pid);

  const limite = clamp(timeoutMs, 1000, 600000);
  const inicio = Date.now();

  if (entry.status === 'running') {
    await new Promise<void>((resolve) => {
      let pronto = false;
      const terminar = () => { if (!pronto) { pronto = true; clearTimeout(prazo); entry.child.removeListener('close', terminar); resolve(); } };
      const prazo = setTimeout(terminar, limite);
      // 'close' já pode ter passado enquanto ninguém ouvia; o once não perde nada
      // porque o status acima é relido a cada chamada.
      entry.child.once('close', terminar);
    });
  }

  const esperou = Math.round((Date.now() - inicio) / 1000);
  const terminou = entry.status !== 'running';
  return {
    success: true, pid, command: entry.command, status: entry.status,
    finished: terminou, exitCode: entry.exitCode,
    waitedSec: esperou,
    stdout: entry.stdout, stderr: entry.stderr,
        stdoutDropped: entry.stdoutDropped || 0, stderrDropped: entry.stderrDropped || 0,
    note: terminou
      ? `The process finished after ~${esperou}s.`
      : `Still running after ${esperou}s (deadline reached). If it is a server, that is expected — carry on and use read_process_output when you need the logs.`
  };
});

// Lista processos em segundo plano conhecidos
ipcMain.handle('list-processes', async () => {
  return Array.from(procs.values()).map(e => ({
    pid: e.child.pid, command: e.command, status: e.status,
    uptimeSec: Math.round((Date.now() - e.startedAt) / 1000)
  }));
});

// Encerra um processo em segundo plano (e todo o seu grupo, por ser detached)
ipcMain.handle('stop-process', async (event, pid) => {
  const entry = procs.get(pid);
  if (!entry) return unknownProcess(pid);
  if (entry.status !== 'running') return { success: true, pid, note: 'Process already finished.' };
  try {
    killTree(pid);                                       // pedido educado (SIGTERM / taskkill sem /F)
    setTimeout(() => { if (entry.status !== 'exited') killTree(pid, { force: true }); }, 3000); // força se ainda estiver vivo
    if (entry) entry.status = 'stopped';
    return { success: true, pid };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// Remove do registro os processos já encerrados (limpa o painel)
ipcMain.handle('clear-finished-processes', async () => {
  for (const [pid, e] of procs) {
    if (e.status !== 'running') procs.delete(pid);
  }
  return { success: true };
});

// Ao fechar o app, encerra tudo que ficou rodando em segundo plano
app.on('before-quit', () => {
  for (const [pid] of procs) killTree(pid, { force: true });
  for (const { srv } of mcp.values()) srv.fechar();
});

// ==========================================================================
//  MCP — servidores configurados pelo usuário (ver src/mcp.ts)
// ==========================================================================
// Por nome, com a config serializada: sincronizar mantém conectado o que não mudou —
// reconectar um servidor via npx custa segundos — e reinicia só o que mudou ou saiu.
const mcp = new Map<string, { cfg: string; srv: McpServidor; url?: string }>();
let mcpOAuth: McpOAuth;
const getMcpOAuth = () => mcpOAuth ||= new McpOAuth(join(app.getPath('userData'), 'mcp-oauth.json'), consumptionCipher, url => shell.openExternal(url));
function estadoMcp() {
  return [...mcp.values()].map(({ srv, url }) => ({ name: srv.nome, status: srv.estado, error: srv.erro || undefined, tools: srv.ferramentas, oauth: !!url && getMcpOAuth().temLogin(url) }));
}
ipcMain.handle('mcp-sync', async (event, servers: Record<string, McpConfig> = {}) => {
  const novos = servers && typeof servers === 'object' ? servers : {};
  for (const [nome, { cfg, srv }] of mcp) {
    if (JSON.stringify(novos[nome] ?? null) !== cfg) { srv.fechar(); mcp.delete(nome); }
  }
  const conexoes = [];
  for (const [nome, cfg] of Object.entries(novos)) {
    if (mcp.has(nome)) continue;
    const url = typeof cfg?.url === 'string' ? cfg.url : undefined;
    const auth = url ? { cabecalho: () => getMcpOAuth().cabecalho(url), renovar: () => getMcpOAuth().renovar(url) } : undefined;
    const srv = new McpServidor(nome, cfg, app.getVersion(), (pid) => killTree(pid, { force: true }), auth);
    mcp.set(nome, { cfg: JSON.stringify(cfg), srv, url });
    conexoes.push(srv.conectar());
  }
  await Promise.all(conexoes);
  return estadoMcp();
});
ipcMain.handle('mcp-status', async () => estadoMcp());
// Login e saída do OAuth são sempre pedidos pelo usuário (botão na lista de servidores): a sincronização
// nunca abre o navegador sozinha, nem na partida do app.
ipcMain.handle('mcp-login', async (event, nome: string) => {
  if (!mainSender(event)) return { success: false, error: 'Pedido recusado.', estado: [] };
  const e = mcp.get(String(nome));
  if (!e?.url) return { success: false, error: 'Servidor MCP remoto não encontrado.', estado: estadoMcp() };
  try { await getMcpOAuth().entrar(e.url); } catch (err) { return { success: false, error: String(err && err.message || err), estado: estadoMcp() }; }
  await e.srv.conectar();
  return { success: e.srv.estado === 'ok', error: e.srv.estado === 'ok' ? undefined : e.srv.erro, estado: estadoMcp() };
});
ipcMain.handle('mcp-logout', async (event, nome: string) => {
  if (!mainSender(event)) return { success: false, estado: [] };
  const e = mcp.get(String(nome));
  if (!e?.url) return { success: false, estado: estadoMcp() };
  getMcpOAuth().sair(e.url); await e.srv.conectar();
  return { success: true, estado: estadoMcp() };
});
ipcMain.handle('mcp-call', async (event, server, tool, args) => {
  const e = mcp.get(server);
  if (!e) return { success: false, error: `Unknown MCP server: ${server}` };
  try {
    const r = await e.srv.chamar(tool, args);
    return { success: !r?.isError, isError: !!r?.isError, text: textoDoResultado(r) };
  } catch (err) {
    return { success: false, error: String(err && err.message || err) };
  }
});

// Persistência local (chats e configurações) no diretório de dados do usuário
const storePath = () => join(app.getPath('userData'), 'app-store.json');
const consumptionCipher = {
  available: () => safeStorage.isEncryptionAvailable() && (process.platform !== 'linux' || safeStorage.getSelectedStorageBackend() !== 'basic_text'),
  encrypt: (text: string) => safeStorage.encryptString(text).toString('base64'),
  decrypt: (text: string) => safeStorage.decryptString(Buffer.from(text, 'base64')),
};
let consumptionStore: ConsumptionStore;
const getConsumptionStore = () => consumptionStore ||= new ConsumptionStore(join(app.getPath('userData'), 'consumo.json'));
let remoteControl: RemoteControl;
const getRemoteControl = () => remoteControl ||= new RemoteControl(join(app.getPath('userData'), 'remote-control.json'), consumptionCipher,
  command => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('remote-command', command); },
  status => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('remote-status', status); });
ipcMain.handle('remote-status', () => { const remote = getRemoteControl(); remote.resume(); return remote.status(); });
ipcMain.handle('remote-pair', async (_, server, code, name) => {
  try { return { success: true, status: await getRemoteControl().pair(String(server), String(code).trim(), String(name || 'Meu PC')) }; }
  catch { return { success: false, error: 'Não foi possível parear. Confira o endereço, o código, o plano e o armazenamento seguro do sistema.' }; }
});
ipcMain.handle('remote-enable', (_, enabled, forget = false) => {
  try { return { success: true, status: getRemoteControl().enable(enabled === true, forget === true) }; }
  catch { return { success: false, error: 'Não foi possível salvar a conexão remota.' }; }
});
ipcMain.on('remote-snapshot', (_, snapshot) => { try { getRemoteControl().publish(snapshot); } catch { /* Próxima captura tenta novamente. */ } });
ipcMain.on('remote-result', (_, id, ok) => { if (typeof id === 'string') getRemoteControl().complete(id, ok === true); });
app.on('before-quit', () => { remoteControl?.stop(); setComputerPermission(false); });

function usageConnection(raw: ConsumptionConnection): ConsumptionConnection {
  if (!raw || typeof raw.id !== 'string' || raw.id.length > 200 || typeof raw.apiUrl !== 'string' || raw.apiUrl.length > 2000 || typeof raw.apiKey !== 'string') throw new Error('Configuração de consumo inválida.');
  const url = new URL(raw.apiUrl);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) throw new Error('Endpoint de consumo inválido.');
  return { id: raw.id, apiUrl: raw.apiUrl.replace(/\/+$/, ''), apiKey: raw.apiKey, model: String(raw.model || ''),
    usageAdminKey: String(raw.usageAdminKey || ''), usageUrl: String(raw.usageUrl || '') };
}
ipcMain.handle('provider-consumption', async (_, raw, selected = 'month') => {
  try {
    const connection = usageConnection(raw);
    const period: ConsumptionPeriod = ['month', '7d', '30d'].includes(selected) ? selected : 'month';
    const local = getConsumptionStore().summary(connection, period);
    const remote = await queryConsumption(connection, period);
    return { success: true, local, remote };
  } catch { return { success: false, error: 'Não foi possível consultar o registro de consumo.' }; }
});
ipcMain.handle('record-usage', async (_, raw, usage) => {
  try { getConsumptionStore().record(usageConnection(raw), usage); return { success: true }; }
  catch { return { success: false, error: 'Não foi possível salvar o consumo local.' }; }
});

ipcMain.handle('load-store', async (event) => {
  if (!mainSender(event)) return null;
  try {
    const file = storePath();
    if (!existsSync(file)) { setComputerPermission(false); return null; }
    const data = restoreConsumptionKeys(JSON.parse(readFileSync(file, 'utf-8')), consumptionCipher);
    setComputerPermission(data?.settings?.computerUse === true);
    return data;
  } catch (err) {
    setComputerPermission(false);
    return null;
  }
});

ipcMain.handle('save-store', async (event, data) => {
  if (!mainSender(event)) return { success: false, error: 'Untrusted application window.' };
  if (data?.settings?.computerUse !== true) setComputerPermission(false);
  try {
    writeFileSync(storePath(), JSON.stringify(protectConsumptionKeys(data, consumptionCipher), null, 2), 'utf-8');
    setComputerPermission(data?.settings?.computerUse === true);
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// Atualiza o título da janela (ex.: "Pofu Code Studio — pensando…")
ipcMain.on('set-title', (event, title) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win && typeof title === 'string' && title.trim()) win.setTitle(title);
});

// Notificação do sistema para chamar a atenção (ex.: o agente fez uma pergunta e o
// app está em segundo plano). Clique restaura/foca a janela e avisa o renderer.
ipcMain.on('notify', (event, title, body) => {
  if (!mainSender(event) || !Notification.isSupported()) return;
  try {
    const n = new Notification({
      title: typeof title === 'string' && title ? title : packageJson.productName,
      body: typeof body === 'string' ? body : ''
    });
    n.on('click', () => {
      if (!mainWindow || mainWindow.isDestroyed()) return;
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show(); mainWindow.focus();
      mainWindow.webContents.send('notify-click');
    });
    n.show();
  } catch { /* sem serviço de notificações: a pergunta continua visível no app */ }
});

// ==========================================================================
//  Busca na web (DuckDuckGo, sem chave de API) + leitura de páginas
// ==========================================================================
const WEB_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';
// Cabeçalhos "de navegador" reduzem os bloqueios anti-bot do DuckDuckGo
const WEB_HEADERS = {
  'User-Agent': WEB_UA,
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7',
  'Referer': 'https://duckduckgo.com/',
  'Sec-Fetch-Dest': 'document', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Site': 'same-origin'
};
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// O Electron não cancela executeJavaScript nem capturePage. Numa página com a thread presa
// (laço infinito, script que espera algo que nunca chega) eles
// nunca resolvem, e o tool call do agente ficava pendurado: o Parar não alcança uma chamada
// IPC pendente, e a saída era fechar o app. Estourado o prazo, quem chamou segue em frente e
// o finally de quem abriu a janela a destrói.
// O teste de integração encurta os prazos pelo ambiente: esperar os valores reais em cada
// cenário de página travada tornaria a suíte inviável.
const prazoDe = (nome: string, padrao: number) => Number(process.env[nome]) || padrao;

function comPrazo<T>(promessa: Promise<T>, ms: number, motivo: string): Promise<T> {
  let timer;
  const estouro = new Promise<never>((_, rejeita) => { timer = setTimeout(() => rejeita(new Error(motivo)), ms); });
  return Promise.race([promessa, estouro]).finally(() => clearTimeout(timer));
}

function decodeEntities(s) {
  return String(s)
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&#x27;/gi, "'")
    .replace(/&#x2F;/gi, '/').replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n));
}
function stripTags(s) { return String(s).replace(/<[^>]*>/g, ''); }

// Extrai a URL real do redirecionador do DuckDuckGo (//duckduckgo.com/l/?uddg=...)
function ddgRealUrl(href) {
  const m = href.match(/[?&]uddg=([^&]+)/);
  if (m) { try { return decodeURIComponent(m[1]); } catch (e) { return m[1]; } }
  if (href.startsWith('//')) return 'https:' + href;
  return href;
}

// --------------------------------------------------------------------------
//  Janela oculta reutilizável (busca e leitura de páginas)
// --------------------------------------------------------------------------
// Buscadores devolvem 202/403 para requisição HTTP crua mas respondem normalmente a um
// navegador de verdade — que é o que o Electron já tem. Esta função abre uma janela
// invisível, roda um extrator no DOM e SEMPRE fecha a janela.
async function comJanelaOculta(url, opts, extrator) {
  const timeoutMs = clamp(opts.timeoutMs || 15000, 1000, 60000);
  let win: BrowserWindow = null;
  try {
    win = new BrowserWindow({
      width: opts.width || 1280, height: opts.height || 900, show: false, skipTaskbar: true,
      webPreferences: {
        offscreen: true, nodeIntegration: false, contextIsolation: true, sandbox: true,
        backgroundThrottling: false, partition: opts.partition || 'janela-oculta',
        disableDialogs: true // ver capture-page: alert() abre diálogo nativo e prende a página
      }
    });
    // loadURL só resolve no did-finish-load: numa página que nunca termina de carregar
    // (anúncio pendurado, websocket aberto) ele fica preso PARA SEMPRE e o tool call do
    // agente nunca retorna. O limite de tempo é obrigatório, não um refinamento.
    let expirou = false;
    await Promise.race([
      win.webContents.loadURL(url).catch(e => { if (!/ERR_ABORTED/.test(String(e.message || e))) throw e; }),
      sleep(timeoutMs).then(() => { expirou = true; })
    ]);
    if (expirou && win.webContents.isLoading()) win.webContents.stop(); // usa o que já renderizou
    if (opts.waitMs) await sleep(opts.waitMs);
    return await comPrazo(win.webContents.executeJavaScript(extrator, true), 10000,
      `The page at ${url} did not respond to text extraction within 10 s (its scripts may be stuck).`);
  } finally {
    if (win && !win.isDestroyed()) win.destroy();
  }
}

// Extrai resultados do HTML do DuckDuckGo já renderizado. Tenta primeiro as classes
// oficiais e cai para uma varredura genérica de âncoras — as classes mudam de tempos em
// tempos e uma busca que "para de achar resultado" é pior que uma imprecisa.
const EXTRATOR_DDG = `(() => {
  const limpa = (s) => (s || '').replace(/\\s+/g, ' ').trim();
  const out = [];
  for (const bloco of document.querySelectorAll('.result, .web-result')) {
    const a = bloco.querySelector('a.result__a, h2 a, a[href]');
    if (!a) continue;
    const snip = bloco.querySelector('.result__snippet');
    const titulo = limpa(a.innerText);
    if (!titulo) continue;
    out.push({ title: titulo, url: a.href, snippet: limpa(snip ? snip.innerText : '') });
  }
  if (out.length) return out;

  // Sem as classes conhecidas: qualquer âncora externa com texto vira candidata.
  const vistos = new Set();
  for (const a of document.querySelectorAll('a[href]')) {
    if (!/^https?:/.test(a.href)) continue;
    const titulo = limpa(a.innerText);
    if (titulo.length < 15 || vistos.has(a.href)) continue;
    vistos.add(a.href);
    let bloco = a, desc = '';
    for (let i = 0; i < 4 && bloco; i++) {
      bloco = bloco.parentElement;
      if (!bloco) break;
      const t = limpa((bloco.innerText || '').replace(titulo, ''));
      if (t.length > 60) { desc = t.slice(0, 300); break; }
    }
    out.push({ title: titulo.slice(0, 160), url: a.href, snippet: desc });
  }
  return out;
})()`;

// Caminho principal: DuckDuckGo dentro do navegador oculto.
async function buscaNoNavegador(query, max) {
  try {
    const url = 'https://html.duckduckgo.com/html/?q=' + encodeURIComponent(query) + '&kl=br-pt';
    const brutos = await comJanelaOculta(url, { timeoutMs: 15000, waitMs: 900, partition: 'busca' }, EXTRATOR_DDG);
    if (!Array.isArray(brutos)) return null;
    const results = brutos
      .map(r => ({ title: r.title, url: ddgRealUrl(r.url), snippet: r.snippet }))
      // o próprio DDG aparece entre as âncoras (menu, configurações) e não é resultado
      .filter(r => r.url && !/duckduckgo\.com\/(?!l\/)/.test(r.url))
      .slice(0, max);
    return results.length ? results : null;
  } catch (e) {
    return null;
  }
}

// Fallback com transporte diferente: o Brave responde bem a HTTP com cabeçalho de
// navegador (e falha dentro da janela oculta) — os dois se cobrem justamente por errarem
// de formas diferentes.
async function buscaBrave(query, max) {
  try {
    const resp = await fetch('https://search.brave.com/search?q=' + encodeURIComponent(query),
      { headers: WEB_HEADERS, signal: AbortSignal.timeout(15000) });
    if (!resp.ok) return null;
    const html = await resp.text();
    const results = [];
    const vistos = new Set();
    // Cada resultado é uma âncora para fora do domínio, seguida de um trecho de descrição
    const re = /<a[^>]+href="(https?:\/\/[^"]+)"[^>]*>([\s\S]{0,400}?)<\/a>/g;
    let m;
    while ((m = re.exec(html)) !== null && results.length < max) {
      const url = decodeEntities(m[1]);
      if (/brave\.com|search\.brave|\.css|\.js$|\.svg|\.png/i.test(url)) continue;
      const titulo = decodeEntities(stripTags(m[2])).replace(/\s+/g, ' ').trim();
      if (titulo.length < 15 || vistos.has(url)) continue;
      vistos.add(url);
      results.push({ title: titulo.slice(0, 160), url, snippet: '' });
    }
    return results.length ? results : null;
  } catch (e) {
    return null;
  }
}

// Última linha de defesa para pergunta factual: a API da Wikipédia não bloqueia robô.
// Não substitui uma busca web, mas é melhor que devolver "não consegui" ao agente.
async function buscaWikipedia(query, max) {
  for (const lang of ['pt', 'en']) {
    try {
      const url = `https://${lang}.wikipedia.org/w/api.php?action=query&list=search&srsearch=` +
        encodeURIComponent(query) + '&format=json&srlimit=' + max + '&origin=*';
      const resp = await fetch(url, { headers: { 'User-Agent': WEB_UA }, signal: AbortSignal.timeout(12000) });
      if (!resp.ok) continue;
      const j = await resp.json();
      const hits = (j.query && j.query.search) || [];
      if (!hits.length) continue;
      return hits.map(h => ({
        title: h.title,
        url: `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(h.title.replace(/ /g, '_'))}`,
        snippet: decodeEntities(stripTags(h.snippet || ''))
      }));
    } catch (e) { /* tenta o próximo idioma */ }
  }
  return null;
}


// Renderiza a página com JavaScript executado. É o `renderHtml` que o módulo de busca
// usa quando o fetch traz só a casca de um site que monta o conteúdo no cliente.
async function renderizaHtml(url) {
  try {
    return await comJanelaOculta(url, { timeoutMs: 15000, waitMs: 1200, partition: 'leitura' },
      'document.documentElement.outerHTML');
  } catch (e) {
    return null;
  }
}

// Instância única: ela guarda o cache por consulta e o cooldown por provedor, que só
// servem para alguma coisa se sobreviverem entre as buscas da sessão.
let buscador = null;
function getBuscador() {
  if (buscador) return buscador;
  buscador = new WebSearch({
    language: 'pt-BR',
    resultLimit: 8,
    pagesToFetch: 0,      // A leitura com evidências agora pertence ao WebResearch.
    pageCharLimit: 2500,
    searchTimeoutMs: 8000, // scraper bloqueado deve desistir rápido e ceder a vez ao próximo
    logger: (nivel, msg) => { if (nivel !== 'info') console.log('[busca]', msg); },
    renderHtml: renderizaHtml,
    // Provedores que dependem do Electron entram aqui, no fim da cascata. Medido nesta
    // máquina: por fetch, DuckDuckGo e Startpage devolvem 202 e o Bing cai num muro de
    // consentimento — mas o MESMO DuckDuckGo responde normalmente dentro de um navegador
    // de verdade. Os dois transportes falham por motivos diferentes, então se cobrem.
    extraProviders: [
      { name: 'ddg-navegador', run: async (q) => (await buscaNoNavegador(q, 10)) || [] },
      { name: 'brave-http', run: async (q) => (await buscaBrave(q, 10)) || [] },
      { name: 'wikipedia', run: async (q) => (await buscaWikipedia(q, 5)) || [] }
    ]
  });
  return buscador;
}

const pesquisaWeb = new WebResearch({ fallback: query => getBuscador().search(query), renderHtml: renderizaHtml });

ipcMain.handle('web-search', async (event, query, maxResults = 5) => {
  const max = clamp(maxResults || 5, 1, 10);
  if (!String(query || '').trim()) return { success: false, error: 'Search query must not be empty.' };
  try {
    return await pesquisaWeb.search(String(query || ''), max);
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// ==========================================================================
//  Validação de aplicações: requisição HTTP e captura visual de página
// ==========================================================================
const clamp = (v, min, max) => Math.min(Math.max(Number(v) || min, min), max);

// Chamada HTTP estruturada (status, headers e corpo separados). É o que o agente usa
// para validar uma API que ele mesmo subiu: melhor que `curl` no execute_command
// porque não passa pelo modal de confirmação nem depende de curl estar instalado.
ipcMain.handle('http-request', async (event, url, opts = {}) => {
  const started = Date.now();
  try {
    const init: RequestInit = {
      method: (opts.method || 'GET').toUpperCase(),
      headers: opts.headers && typeof opts.headers === 'object' ? { ...opts.headers } : {},
      redirect: 'follow',
      signal: AbortSignal.timeout(clamp(opts.timeoutMs || 15000, 500, 120000))
    };
    if (opts.body != null && init.method !== 'GET' && init.method !== 'HEAD') {
      const corpo = typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body);
      init.body = corpo;
      // Sem content-type explícito o servidor recebe o JSON como texto e devolve 400/415,
      // e o agente perde turnos depurando um erro que é da própria chamada.
      const cabecalhos = init.headers as Record<string, string>;
      const hasCt = Object.keys(cabecalhos).some(h => h.toLowerCase() === 'content-type');
      if (!hasCt && /^\s*[[{]/.test(corpo)) cabecalhos['Content-Type'] = 'application/json';
    }

    const resp = await fetch(url, init);
    const body = await resp.text();
    const headers = {};
    resp.headers.forEach((v, k) => { headers[k] = v; });
    return {
      success: true, url, status: resp.status, statusText: resp.statusText,
      ok: resp.ok, ms: Date.now() - started, headers,
      body,
      bodyBytes: Buffer.byteLength(body, 'utf8')
    };
  } catch (err) {
    const msg = String(err.message || err);
    // O erro de conexão recusada é o caso mais comum (servidor não subiu); dizer isso
    // direto evita que o modelo trate como bug da aplicação e saia editando código.
    const hint = /ECONNREFUSED|fetch failed|refused/i.test(msg)
      ? 'Nothing is listening on that port. Start the server with execute_command (it goes to the background) and check the logs with read_process_output before trying again.'
      : (/timed out|aborted|TimeoutError/i.test(msg) ? 'The request timed out — the server may be hung or slow.' : undefined);
    return { success: false, url, error: msg, hint, ms: Date.now() - started };
  }
});

// Ficam no diretório de dados (e não em /tmp) para sobreviverem à reabertura de um
// chat antigo; a poda evita crescimento sem fim.
const SHOTS_KEEP = 60;
function shotsDir() {
  const dir = join(app.getPath('userData'), 'screenshots');
  mkdirSync(dir, { recursive: true });
  return dir;
}
function pruneShots() {
  try {
    const dir = shotsDir();
    const files = readdirSync(dir).filter(f => f.endsWith('.png'))
      .map(f => ({ f, t: statSync(join(dir, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t);
    for (const { f } of files.slice(SHOTS_KEEP)) { try { unlinkSync(join(dir, f)); } catch (e) { } }
  } catch (e) { /* poda é best-effort */ }
}

// Um print de 1920px vira muitos tokens de visão sem informação extra; 1024 mantém
// texto de UI legível.
const SHOT_MODEL_WIDTH = 1024;

let desktopComputer: DesktopComputer;
function getDesktopComputer() {
  return desktopComputer ||= new DesktopComputer({
    platform: process.platform,
    primaryDisplay: () => String(screen.getPrimaryDisplay().id),
    displays: () => screen.getAllDisplays().map(display => ({
      id: String(display.id), label: display.label || `Display ${display.id}`,
      bounds: display.bounds, scaleFactor: display.scaleFactor, rotation: display.rotation,
      physicalBounds: isWindows ? screen.dipToScreenRect(null, display.bounds) : {
        x: display.bounds.x, y: display.bounds.y,
        width: Math.round(display.bounds.width * display.scaleFactor), height: Math.round(display.bounds.height * display.scaleFactor)
      }
    })),
    sources: () => desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: COMPUTER_IMAGE_MAX_SIDE, height: COMPUTER_IMAGE_MAX_SIDE }, fetchWindowIcons: false }),
    save: (png, id) => { const file = join(shotsDir(), `screen-${id}.png`); writeFileSync(file, png); pruneShots(); return file; },
    input: windowsComputer
  });
}
ipcMain.handle('capture-screen', (event, opts) => mainSender(event)
  ? getDesktopComputer().capture(opts) : { success: false, error: 'Untrusted application window.' });
ipcMain.handle('computer-action', (event, args) => mainSender(event)
  ? getDesktopComputer().action(args) : { success: false, error: 'Untrusted application window.' });
ipcMain.handle('cancel-computer', (event) => {
  if (!mainSender(event)) return { success: false, error: 'Untrusted application window.' };
  getDesktopComputer().cancel();
  return { success: true };
});
ipcMain.handle('view-image', (event, filePath, opts) => {
  if (!mainSender(event)) return { success: false, error: 'Untrusted application window.' };
  let fd: number;
  try {
    if (typeof filePath !== 'string' || !filePath || typeof opts?.workspace !== 'string' || !opts.workspace)
      throw new Error('view_image requires a file path and an active workspace.');
    const root = realpathSync(opts.workspace), target = realpathSync(resolve(root, filePath));
    const rel = relative(root, target);
    if (isAbsolute(rel) || rel === '..' || rel.startsWith('..\\') || rel.startsWith('../')) throw new Error('The image must be inside the active workspace, including its symlink target.');
    fd = openSync(target, 'r');
    const info = fstatSync(fd);
    if (!info.isFile() || info.size < 1 || info.size > 25 * 1024 * 1024) throw new Error('The image must be a non-empty file no larger than 25 MiB.');
    const bytes = Buffer.alloc(info.size);
    let offset = 0;
    while (offset < bytes.length) { const count = readSync(fd, bytes, offset, bytes.length - offset, offset); if (!count) break; offset += count; }
    if (offset !== bytes.length) throw new Error('The image changed while being read. Retry view_image.');
    if (!tipoDaImagem(bytes)) throw new Error('Unsupported image format. Use PNG, JPEG, GIF, BMP or WebP.');
    let image = nativeImage.createFromBuffer(bytes);
    if (image.isEmpty()) throw new Error('The file could not be decoded as an image.');
    const size = image.getSize(), scale = Math.min(1, COMPUTER_IMAGE_MAX_SIDE / Math.max(size.width, size.height));
    if (scale < 1) image = image.resize({ width: Math.max(1, Math.round(size.width * scale)), height: Math.max(1, Math.round(size.height * scale)) });
    const png = image.toPNG(), path = join(shotsDir(), `image-${randomUUID()}.png`);
    writeFileSync(path, png); pruneShots();
    return { success: true, path, dataUrl: 'data:image/png;base64,' + png.toString('base64'), ...image.getSize(), original_width: size.width, original_height: size.height };
  } catch (error) { return { success: false, error: String(error?.message || error) }; }
  finally { if (fd !== undefined) closeSync(fd); }
});

// Abre a URL oculta, coleta console e rede, roda um script opcional e devolve o PNG.
// É assim que o agente vê o que construiu, em vez de deduzir pelo código.
ipcMain.handle('capture-page', async (event, url, opts = {}) => {
  const width = clamp(opts.width || 1280, 320, 2560);
  const height = clamp(opts.height || 800, 240, 2000);
  const waitMs = clamp(opts.waitMs ?? 700, 0, 20000);
  const prazoScript = prazoDe('POFU_CAPTURE_SCRIPT_MS', CAPTURE_SCRIPT_MS);
  const prazoEtapa = prazoDe('POFU_CAPTURE_STEP_MS', CAPTURE_STEP_MS);
  const prazoQuadro = prazoDe('POFU_CAPTURE_FRAME_MS', CAPTURE_FRAME_MS);
  const prazoTotal = prazoDe('POFU_CAPTURE_TOTAL_MS', CAPTURE_TOTAL_MS);

  const logs = [];
  const netErrors = [];
  // O que já se leu da página volta mesmo quando o print falha: o texto e o título dizem ao
  // agente onde a página parou.
  const parcial: { title?: string; text?: string } = {};
  let win: BrowserWindow = null;
  // Página que estourou um prazo está com a thread presa: as leituras seguintes estourariam
  // também, cinco segundos cada, sem trazer nada — e no fim o processo dela é derrubado,
  // porque um laço infinito segue queimando CPU depois de a janela ser destruída.
  let travada = false;

  // Cada etapa que depende da página tem prazo próprio (ver comPrazo); o teto geral pega o
  // que escapar delas, e o finally lá embaixo destrói a janela nos dois casos.
  const captura = async () => {
    win = new BrowserWindow({
      width, height, show: false, frame: false, skipTaskbar: true,
      webPreferences: {
        // O modo offscreen renderiza a página sem abrir uma janela visível.
        offscreen: true,
        nodeIntegration: false, contextIsolation: true, sandbox: true,
        backgroundThrottling: false,
        partition: 'capture-session', // sessão isolada: não mistura cookies/cache com o app
        // alert/confirm/prompt da janela invisível viram DIÁLOGOS NATIVOS na tela do usuário,
        // e a página fica parada até alguém clicar (medido: o load de uma página com alert()
        // passou de 6 s esperando). Desligados, alert volta na hora e confirm responde false.
        disableDialogs: true
      }
    });
    const wc = win.webContents;

    const lePagina = async (codigo: string, padrao) => {
      if (travada) return padrao;
      try { return await comPrazo(wc.executeJavaScript(codigo), prazoEtapa, 'prazo-da-pagina'); }
      catch (e) { if (String(e?.message) === 'prazo-da-pagina') travada = true; return padrao; }
    };

    // A assinatura de 'console-message' mudou entre versões do Electron (argumentos
    // soltos → objeto de detalhes); aceita as duas para não quebrar ao atualizar.
    wc.on('console-message', (...a) => {
      const d = (a[1] && typeof a[1] === 'object') ? a[1] : { level: a[1], message: a[2], lineNumber: a[3], sourceId: a[4] };
      const lvl = typeof d.level === 'number' ? ['debug', 'info', 'warning', 'error'][d.level] || 'info' : String(d.level || 'info');
      if (logs.length < 100) logs.push({ level: lvl, text: String(d.message || '').slice(0, 500), line: d.lineNumber, source: d.sourceId });
    });
    wc.on('did-fail-load', (e, code, desc, failedUrl, isMainFrame) => {
      if (!isMainFrame && netErrors.length < 30) netErrors.push({ url: failedUrl, error: `${desc} (${code})` });
    });

    let httpStatus = null;
    wc.session.webRequest.onCompleted({ urls: ['*://*/*'] }, (details) => {
      if (details.resourceType === 'mainFrame' && httpStatus == null) httpStatus = details.statusCode;
      if (details.statusCode >= 400 && netErrors.length < 30) {
        netErrors.push({ url: String(details.url).slice(0, 200), error: `HTTP ${details.statusCode}` });
      }
    });

    // Com limite de tempo: numa página que nunca termina de carregar (anúncio pendurado,
    // websocket aberto) o loadURL fica preso para sempre e o tool call nunca retorna.
    // Estourando o prazo, captura o que já renderizou em vez de falhar.
    let expirouCarga = false;
    await Promise.race([
      wc.loadURL(url).catch(e => { if (!/ERR_ABORTED/.test(String(e.message || e))) throw e; }),
      sleep(clamp(opts.loadTimeoutMs || 20000, 2000, 60000)).then(() => { expirouCarga = true; })
    ]);
    if (expirouCarga && wc.isLoading()) wc.stop();

    // Espera opcional por um seletor (páginas que montam a UI em JS depois do load)
    let selectorFound;
    if (opts.selector) {
      const deadline = Date.now() + clamp(opts.selectorTimeoutMs || 5000, 100, 20000);
      selectorFound = false;
      while (Date.now() < deadline && !travada) {
        selectorFound = await lePagina(`!!document.querySelector(${JSON.stringify(opts.selector)})`, false);
        if (selectorFound) break;
        await sleep(150);
      }
    }
    if (waitMs) await sleep(waitMs);

    // Script opcional na página: permite interagir (clicar, preencher) antes do print
    let scriptResult, scriptError;
    if (opts.script) {
      try {
        const r = await comPrazo(wc.executeJavaScript(`(async () => { ${opts.script} })()`, true), prazoScript, 'prazo-do-script');
        scriptResult = typeof r === 'string' ? r : JSON.stringify(r ?? null);
        if (waitMs) await sleep(Math.min(waitMs, 800)); // deixa a UI reagir ao script
      } catch (e) {
        const estourou = String(e && e.message) === 'prazo-do-script';
        if (estourou) travada = true;
        scriptError = estourou
          ? `The script did not finish within ${prazoScript / 1000} s: it is waiting for something that never happens, or stuck in a loop. The page was captured as it is.`
          : String(e && e.message || e).slice(0, 500);
      }
    }

    const title = parcial.title = await lePagina('document.title', '');
    const text = parcial.text = await lePagina(
      '(document.body ? document.body.innerText : "").replace(/\\n{3,}/g, "\\n\\n")', ''
    );

    // Página inteira: sem isto o agente vê só a primeira dobra e conclui que "está tudo
    // certo" sem nunca ter olhado o rodapé. Aumentar a janela até a altura do documento
    // também faz o IntersectionObserver disparar em tudo, revelando animações de rolagem
    // que ficariam invisíveis numa captura só do topo.
    let alturaTotal = height;
    if (opts.fullPage) {
      const medida = await lePagina(
        'Math.max(document.body.scrollHeight, document.documentElement.scrollHeight)', height
      );
      alturaTotal = clamp(medida, height, 6000);
      if (alturaTotal > height) {
        win.setSize(width, Math.round(alturaTotal));
        await sleep(600); // deixa o layout reagir e as animações de entrada rodarem
      }
    }

    // Recorte de um elemento: a página inteira é reduzida para caber no orçamento de
    // visão, e detalhe fino (alinhamento, sobreposição de poucos pixels) some na
    // redução. Capturando só o elemento, ele chega ao modelo em tamanho cheio.
    let rect = null, recorteFalhou = null;
    if (opts.cropSelector) {
      const medida = await lePagina(`(() => {
        const el = document.querySelector(${JSON.stringify(opts.cropSelector)});
        if (!el) return null;
        el.scrollIntoView({ block: 'center' });
        const r = el.getBoundingClientRect();
        return { x: r.x, y: r.y, width: r.width, height: r.height };
      })()`, null);
      if (!medida || medida.width < 1 || medida.height < 1) {
        recorteFalhou = `Element "${opts.cropSelector}" not found (or has no size) — captured the whole page instead.`;
      } else {
        await sleep(250); // o scrollIntoView precisa assentar antes de medir de novo
        const r2 = await lePagina(`(() => {
          const el = document.querySelector(${JSON.stringify(opts.cropSelector)});
          const r = el.getBoundingClientRect();
          return { x: r.x, y: r.y, width: r.width, height: r.height };
        })()`, medida);
        const folga = 8; // uma margem ajuda a julgar alinhamento em relação ao redor
        rect = {
          x: Math.max(0, Math.floor(r2.x - folga)),
          y: Math.max(0, Math.floor(r2.y - folga)),
          width: Math.ceil(r2.width + folga * 2),
          height: Math.ceil(r2.height + folga * 2)
        };
      }
    }

    // Recorta dentro do bitmap para não solicitar pixels fora da superfície capturada.
    // O invalidate pede um quadro novo ao modo offscreen: sem quadro pintado, o capturePage
    // pode esperar para sempre.
    wc.invalidate();
    let image = await comPrazo(wc.capturePage(), prazoQuadro,
      `The page did not produce a frame to capture within ${prazoQuadro / 1000} s (a script on it is probably stuck).`);
    if (image.isEmpty()) return { success: false, error: 'The capture came out empty (the page never rendered).' };
    if (rect) {
      const size = image.getSize();
      const x = Math.min(rect.x, size.width - 1), y = Math.min(rect.y, size.height - 1);
      image = image.crop({ x, y, width: Math.min(rect.width, size.width - x), height: Math.min(rect.height, size.height - y) });
    }

    const file = join(shotsDir(), `shot-${Date.now()}.png`);
    writeFileSync(file, image.toPNG());
    pruneShots();

    const size = image.getSize();
    // Recorte vai em tamanho cheio: reduzir a imagem é justamente o que apagava o
    // detalhe que o recorte foi pedido para mostrar.
    const forModel = (!rect && size.width > SHOT_MODEL_WIDTH) ? image.resize({ width: SHOT_MODEL_WIDTH }) : image;

    return {
      success: true, url, path: file, title, httpStatus,
      width: size.width, height: size.height,
      dataUrl: 'data:image/png;base64,' + forModel.toPNG().toString('base64'),
      console: logs, netErrors, text, selectorFound, scriptResult, scriptError,
      recorte: rect ? opts.cropSelector : undefined, recorteFalhou: recorteFalhou || undefined
    };
  };

  try {
    return await comPrazo(captura(), prazoTotal, `capture_page did not finish within ${prazoTotal / 1000} s; the page stopped responding.`);
  } catch (err) {
    const msg = String(err && err.message || err);
    const hint = /ERR_CONNECTION_REFUSED|ERR_FAILED|ERR_EMPTY_RESPONSE/i.test(msg)
      ? 'The page did not respond. Confirm the server is up (list_processes / read_process_output) before capturing.'
      : /did not (finish|produce)|stopped responding/i.test(msg)
        ? 'The page froze (a script stuck in a loop or waiting forever). Check console for errors, and capture without the script or with a simpler one.'
        : undefined;
    if (/did not (finish|produce)|stopped responding/i.test(msg)) travada = true;
    // O console e a rede que já chegaram são a melhor pista de por que a página travou.
    return { success: false, url, error: msg, hint, console: logs, netErrors, ...parcial };
  } finally {
    if (win && !win.isDestroyed()) {
      if (travada) win.webContents.forcefullyCrashRenderer();
      win.destroy();
    }
  }
});

// Rehidrata um print salvo (histórico recarregado) para reenviá-lo ao modelo
// Imagem que o USUÁRIO anexou. Vai para o mesmo lugar (e a mesma poda) dos prints do
// capture_page porque tem a mesma necessidade: o histórico guarda só o CAMINHO, já que
// base64 no app-store.json infla o arquivo a cada imagem colada, e o chat precisa
// continuar mostrando a imagem depois de reabrir o app.
ipcMain.handle('save-attachment-image', async (event, dataUrl, nome) => {
  try {
    const img = nativeImage.createFromDataURL(String(dataUrl || ''));
    if (img.isEmpty()) return { success: false, error: 'the file did not decode as an image' };
    const size = img.getSize();
    // Mesma redução do print, pelo mesmo motivo: foto de celular tem 4000px de largura e
    // custa milhares de tokens de visão sem mostrar nada a mais do que 1024 já mostra.
    const paraModelo = size.width > SHOT_MODEL_WIDTH ? img.resize({ width: SHOT_MODEL_WIDTH }) : img;
    const limpo = String(nome || 'anexo').replace(/[^\w.-]+/g, '_').slice(-40);
    const file = join(shotsDir(), `anexo-${Date.now()}-${limpo}.png`);
    const png = paraModelo.toPNG();
    writeFileSync(file, png);
    pruneShots();
    return {
      success: true, path: file, width: size.width, height: size.height,
      dataUrl: 'data:image/png;base64,' + png.toString('base64')
    };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// Assinatura dos formatos que o servidor consegue decodificar. A checagem existe porque um
// arquivo que não é imagem, mandado como `image_url`, faz o servidor recusar a REQUISIÇÃO
// INTEIRA com 400 ("Failed to load image or audio file") — e a conversa morre nas três
// tentativas. Aconteceu de verdade: um anexo de menção (@arquivo.md) foi confundido com
// imagem e o markdown saiu rotulado como PNG. Melhor a imagem faltar do que o turno morrer.
function tipoDaImagem(buf) {
  if (buf.length < 12) return null;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return 'image/gif';
  if (buf[0] === 0x42 && buf[1] === 0x4d) return 'image/bmp';
  if (buf.subarray(0, 4).toString('ascii') === 'RIFF' && buf.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  return null;
}

ipcMain.handle('read-image', async (event, filePath) => {
  try {
    const buf = readFileSync(filePath);
    const tipo = tipoDaImagem(buf);
    if (!tipo) return { success: false, error: `"${filePath}" is not a decodable image` };
    return { success: true, dataUrl: `data:${tipo};base64,` + buf.toString('base64') };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// Converte HTML em texto legível (remove scripts/estilos/tags, normaliza espaços)
function htmlToText(html) {
  return decodeEntities(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<(br|\/p|\/div|\/li|\/h[1-6])>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
  ).replace(/[ \t]+/g, ' ').replace(/\n\s*\n\s*\n+/g, '\n\n').trim();
}

// Abaixo disto o resultado é considerado "casca": ou o site monta tudo em JS, ou
// devolveu página de bloqueio. Nos dois casos o navegador oculto resolve.
const FETCH_MIN_TEXTO_UTIL = 400;

ipcMain.handle('fetch-url', async (event, url, maxChars = 2 * 1024 * 1024) => {
  maxChars = clamp(maxChars, 80, 2 * 1024 * 1024);
  if (navigable(String(url))) {
    const page = await pesquisaWeb.read(String(url), '', AbortSignal.timeout(45000), maxChars);
    return page ? { success: true, url: page.url, content: page.text, links: page.links, viaBrowser: page.via === 'browser', totalChars: page.text.length }
      : { success: false, url, error: 'The page returned no readable text (unavailable or access challenge).' };
  }
  let statusHttp = null, viaBrowser = false, texto = '', erroHttp = null;
  try {
    // Sem timeout, um servidor que aceita a conexão e nunca responde deixa o tool call
    // pendurado para sempre e o agente trava esperando.
    const resp = await fetch(url, {
      headers: { 'User-Agent': WEB_UA, 'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8' },
      redirect: 'follow', signal: AbortSignal.timeout(20000)
    });
    statusHttp = resp.status;
    const ct = resp.headers.get('content-type') || '';
    const bruto = await resp.text();
    texto = resp.ok ? ((ct.includes('html') || /^\s*</.test(bruto)) ? articleText(bruto, url, '', maxChars)?.text || '' : bruto) : '';
  } catch (err) {
    texto = '';
    statusHttp = null;
    erroHttp = err.message;
  }

  // Segunda tentativa no navegador: SPA, muro de consentimento ou anti-bot.
  if (texto.trim().length < FETCH_MIN_TEXTO_UTIL) {
    const html = await renderizaHtml(url);
    if (html) {
      const rend = articleText(html, url, '', maxChars)?.text || '';
      if (rend.trim().length > texto.trim().length) { texto = rend; viaBrowser = true; }
    }
  }

  if (!texto.trim() || researchGate(url, '', texto)) {
    return { success: false, url, status: statusHttp, error: erroHttp || 'The page returned no readable text.' };
  }
  return {
    success: true, url, status: statusHttp, viaBrowser,
    content: texto.slice(0, maxChars),
    totalChars: texto.length,
    truncated: texto.length > maxChars || undefined,
    note: texto.length > maxChars ? 'Page exceeds the extraction limit; request a more specific URL.' : undefined
  };
});
