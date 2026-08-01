// SPDX-License-Identifier: Apache-2.0
// Copyright 2026-present the Pofuserver Coder Studio authors. All rights reserved.
// Licensed under the Apache License, Version 2.0. See /LICENSE and /NOTICE.
// Source: https://github.com/Dspofu/Pofuserver-Code

import { app, BrowserWindow, ipcMain, dialog, shell, Menu, clipboard } from 'electron';
import { dirname, join } from 'path';
import { readdirSync, readFileSync, writeFileSync, unlinkSync, existsSync, mkdirSync, statSync } from 'fs';
import { tmpdir } from 'os';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { WebSearch } from './src/websearch.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// No Windows não existe /bin/bash nem grupos de processos no sentido POSIX; várias
// rotinas de terminal precisam de tratamento específico por plataforma.
const isWindows = process.platform === 'win32';

let mainWindow;

// Precisa ser idêntico ao "build.appId" do package.json: o instalador NSIS grava esse
// mesmo AUMID no atalho, e o Windows só associa a janela ao atalho (ícone correto na
// barra de tarefas + fixar) quando os dois valores batem.
app.setAppUserModelId("com.dspofu.pofusercoderstudio")

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 600,
    icon: join(__dirname, 'assets', 'icon.png'), // usado no Linux/Windows em desenvolvimento (empacotado usa o ícone do build)
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    },
    autoHideMenuBar: true
  });

  mainWindow.loadFile('index.html');
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
  return readdirSync(dirPath, { withFileTypes: true }).map(item => {
    const isDirectory = item.isDirectory();
    // Tamanho junto da listagem evita um round-trip só para o agente decidir se vale a
    // pena ler o arquivo inteiro (ou se é um minificado gigante que ele deve pular).
    let size;
    if (!isDirectory) {
      try { size = statSync(join(dirPath, item.name)).size; } catch (e) { /* link quebrado */ }
    }
    return { name: item.name, isDirectory, size };
  });
});

// Arquivos maiores que isto não são lidos: carregar 25 MB numa string só para devolver
// uma janela de poucas centenas de linhas trava o processo main. O agente deve usar search_files.
const READ_MAX_BYTES = 25 * 1024 * 1024;

// Um arquivo binário lido como utf-8 vira lixo de caracteres de substituição que só
// queima contexto. Detecta pelo primeiro bloco: NUL nunca aparece em texto real.
function looksBinary(buf) {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

// A janela é recortada AQUI, e não no renderer: antes o arquivo inteiro atravessava o
// IPC para mostrar uma fração dele. Os padrões abaixo são rede de segurança — quem
// chama manda o orçamento real, derivado do n_ctx do modelo.
ipcMain.handle('read-file', async (event, filePath, opts = {}) => {
  let st;
  try { st = statSync(filePath); } catch (e) { return { success: false, error: `Arquivo não encontrado: ${filePath}` }; }
  if (st.isDirectory()) return { success: false, error: `"${filePath}" é uma pasta — use list_files.` };
  if (st.size > READ_MAX_BYTES) {
    return { success: false, error: `Arquivo grande demais (${(st.size / 1e6).toFixed(1)} MB, teto ${READ_MAX_BYTES / 1e6} MB). Use search_files para localizar o trecho ou execute_command com head/sed.` };
  }

  const buf = readFileSync(filePath);
  if (looksBinary(buf)) {
    return { success: false, binary: true, size: st.size, error: `Arquivo binário (${st.size} bytes) — conteúdo não é texto legível.` };
  }
  const text = buf.toString('utf-8');
  if (text === '') return { success: true, empty: true, total: 0, content: '', size: 0 };

  const maxLines = Math.max(1, opts.maxLines || 500);
  const maxChars = Math.max(500, opts.maxChars || 20000);

  const allLines = text.split('\n');
  const total = allLines.length;
  const start = Math.max(1, Math.floor(opts.offset > 0 ? opts.offset : 1));
  if (start > total) {
    return { success: false, total, error: `O arquivo tem ${total} linha(s); o offset ${start} está além do fim.` };
  }
  const want = Math.min(Math.max(1, Math.floor(opts.limit > 0 ? opts.limit : maxLines)), maxLines);

  // Respeita o teto de linhas E o de caracteres (uma linha minificada pode ter 1 MB sozinha)
  const chunk = [];
  let chars = 0;
  for (let i = start - 1; i < total && chunk.length < want; i++) {
    const ln = allLines[i];
    if (chunk.length > 0 && chars + ln.length + 1 > maxChars) break;
    chunk.push(ln);
    chars += ln.length + 1;
  }
  let content = chunk.join('\n');
  let charClipped = false;
  if (content.length > maxChars) { content = content.slice(0, maxChars); charClipped = true; }

  return {
    success: true, content, total, size: st.size,
    start, end: start - 1 + chunk.length, charClipped
  };
});

// ==========================================================================
//  Diff e desfazer
// ==========================================================================
// Toda alteração de arquivo guarda o conteúdo ANTERIOR num instantâneo em disco. Em
// disco, e não em memória, porque o botão "Desfazer" fica no histórico do chat: se o
// app reiniciar, o card continua lá e precisa continuar funcionando.
const LIMITE_INSTANTANEOS = 200;
function pastaInstantaneos() {
  const dir = join(app.getPath('userData'), 'instantaneos');
  mkdirSync(dir, { recursive: true });
  return dir;
}

function podaInstantaneos() {
  try {
    const dir = pastaInstantaneos();
    const arqs = readdirSync(dir).filter(f => f.endsWith('.json'))
      .map(f => ({ f, t: statSync(join(dir, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t);
    for (const { f } of arqs.slice(LIMITE_INSTANTANEOS)) { try { unlinkSync(join(dir, f)); } catch (e) { } }
  } catch (e) { /* poda é best-effort */ }
}

function salvaInstantaneo(filePath, antes, existiaAntes, depois) {
  try {
    const id = 'snap-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
    writeFileSync(join(pastaInstantaneos(), id + '.json'),
      JSON.stringify({ id, filePath, antes, existiaAntes, depois, quando: Date.now() }), 'utf-8');
    podaInstantaneos();
    return id;
  } catch (e) {
    return null; // sem instantâneo o desfazer não aparece, mas a escrita não pode falhar por isso
  }
}

// Diff por linhas. Apara prefixo e sufixo iguais antes de rodar o LCS porque a edição
// típica mexe em poucas linhas de um arquivo grande — sem isso, a matriz do LCS ficaria
// do tamanho do arquivo inteiro e travaria o processo main.
const DIFF_MAX_MIOLO = 1500;   // acima disso o LCS custa caro demais
const DIFF_MAX_LINHAS = 400;   // teto do que é enviado para a tela
const DIFF_CONTEXTO = 3;       // linhas inalteradas mostradas em volta de cada mudança

function calculaDiff(antes, depois) {
  const a = String(antes ?? '').split('\n');
  const b = String(depois ?? '').split('\n');

  let ini = 0;
  while (ini < a.length && ini < b.length && a[ini] === b[ini]) ini++;
  let fim = 0;
  while (fim < a.length - ini && fim < b.length - ini && a[a.length - 1 - fim] === b[b.length - 1 - fim]) fim++;

  const mioloA = a.slice(ini, a.length - fim);
  const mioloB = b.slice(ini, b.length - fim);

  if (!mioloA.length && !mioloB.length) {
    return { linhas: [], adicionadas: 0, removidas: 0, semMudanca: true };
  }

  // Miolo grande demais: reporta como bloco trocado em vez de tentar casar linha a linha.
  let ops;
  if (mioloA.length > DIFF_MAX_MIOLO || mioloB.length > DIFF_MAX_MIOLO) {
    ops = [
      ...mioloA.map(t => ({ tipo: 'del', texto: t })),
      ...mioloB.map(t => ({ tipo: 'add', texto: t }))
    ];
  } else {
    // LCS clássico sobre o miolo já reduzido
    const n = mioloA.length, m = mioloB.length;
    const tab = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        tab[i][j] = mioloA[i] === mioloB[j] ? tab[i + 1][j + 1] + 1 : Math.max(tab[i + 1][j], tab[i][j + 1]);
      }
    }
    ops = [];
    let i = 0, j = 0;
    while (i < n && j < m) {
      if (mioloA[i] === mioloB[j]) { ops.push({ tipo: 'ctx', texto: mioloA[i] }); i++; j++; }
      else if (tab[i + 1][j] >= tab[i][j + 1]) { ops.push({ tipo: 'del', texto: mioloA[i] }); i++; }
      else { ops.push({ tipo: 'add', texto: mioloB[j] }); j++; }
    }
    while (i < n) ops.push({ tipo: 'del', texto: mioloA[i++] });
    while (j < m) ops.push({ tipo: 'add', texto: mioloB[j++] });
  }

  // Reconstrói a numeração real das linhas (o prefixo aparado desloca tudo)
  const linhas = [];
  let numA = ini + 1, numB = ini + 1;
  for (const op of ops) {
    if (op.tipo === 'ctx') linhas.push({ ...op, a: numA++, b: numB++ });
    else if (op.tipo === 'del') linhas.push({ ...op, a: numA++ });
    else linhas.push({ ...op, b: numB++ });
  }

  // Contexto DENTRO do miolo: mantém as linhas iguais perto de uma mudança e colapsa
  // o resto — num miolo grande, 200 linhas idênticas escondem as 3 que mudaram.
  const relevante = new Array(linhas.length).fill(false);
  linhas.forEach((l, k) => {
    if (l.tipo === 'ctx') return;
    for (let d = -DIFF_CONTEXTO; d <= DIFF_CONTEXTO; d++) {
      if (k + d >= 0 && k + d < linhas.length) relevante[k + d] = true;
    }
  });

  const miolo = [];
  let pulando = 0;
  for (let k = 0; k < linhas.length; k++) {
    if (relevante[k]) {
      if (pulando) { miolo.push({ tipo: 'pulo', quantas: pulando }); pulando = 0; }
      miolo.push(linhas[k]);
    } else pulando++;
  }
  if (pulando) miolo.push({ tipo: 'pulo', quantas: pulando });

  // Contexto FORA do miolo. O prefixo e o sufixo iguais foram aparados lá em cima para
  // o LCS não custar o arquivo inteiro — mas é neles que está o entorno da mudança, e
  // sem ele o diff vira uma lista de linhas soltas, impossível de revisar.
  const ctxIni = Math.min(DIFF_CONTEXTO, ini);
  const ctxFim = Math.min(DIFF_CONTEXTO, fim);
  const antesDoMiolo = [];
  if (ini - ctxIni > 0) antesDoMiolo.push({ tipo: 'pulo', quantas: ini - ctxIni });
  for (let k = ini - ctxIni; k < ini; k++) {
    antesDoMiolo.push({ tipo: 'ctx', texto: a[k], a: k + 1, b: k + 1 });
  }
  const depoisDoMiolo = [];
  const baseA = a.length - fim, baseB = b.length - fim;
  for (let k = 0; k < ctxFim; k++) {
    depoisDoMiolo.push({ tipo: 'ctx', texto: a[baseA + k], a: baseA + k + 1, b: baseB + k + 1 });
  }
  if (fim - ctxFim > 0) depoisDoMiolo.push({ tipo: 'pulo', quantas: fim - ctxFim });

  const saida = [...antesDoMiolo, ...miolo, ...depoisDoMiolo];
  const adicionadas = linhas.filter(l => l.tipo === 'add').length;
  const removidas = linhas.filter(l => l.tipo === 'del').length;
  const cortado = saida.length > DIFF_MAX_LINHAS;

  return {
    linhas: cortado ? saida.slice(0, DIFF_MAX_LINHAS) : saida,
    adicionadas, removidas, cortado,
    totalLinhasDiff: saida.length
  };
}

// Remonta o diff a partir do instantâneo. Ao reabrir um chat antigo o histórico só tem
// o snapshotId — o antes/depois vive no arquivo do instantâneo, não no app-store.json.
ipcMain.handle('get-diff', async (event, snapshotId) => {
  try {
    const snap = JSON.parse(readFileSync(join(pastaInstantaneos(), snapshotId + '.json'), 'utf-8'));
    return calculaDiff(snap.antes ?? '', snap.depois ?? '');
  } catch (e) {
    return { linhas: [], adicionadas: 0, removidas: 0, indisponivel: true };
  }
});

// Restaura o arquivo ao estado guardado no instantâneo.
ipcMain.handle('undo-change', async (event, snapshotId) => {
  let snap;
  try {
    snap = JSON.parse(readFileSync(join(pastaInstantaneos(), snapshotId + '.json'), 'utf-8'));
  } catch (e) {
    return { success: false, error: 'O ponto de restauração não existe mais (o histórico de alterações é limitado).' };
  }
  try {
    // Antes de desfazer, guarda o estado ATUAL: assim o desfazer também pode ser desfeito.
    let atual = null, existeAgora = false;
    try { atual = readFileSync(snap.filePath, 'utf-8'); existeAgora = true; } catch (e) { }
    const refazerId = salvaInstantaneo(snap.filePath, atual, existeAgora, snap.antes);

    if (snap.existiaAntes) {
      mkdirSync(dirname(snap.filePath), { recursive: true });
      writeFileSync(snap.filePath, snap.antes, 'utf-8');
    } else {
      try { unlinkSync(snap.filePath); } catch (e) { /* já não existia */ }
    }
    return {
      success: true, filePath: snap.filePath, refazerId,
      recriado: !snap.existiaAntes ? false : !existeAgora,
      apagado: !snap.existiaAntes
    };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('write-file', async (event, filePath, content, opts = {}) => {
  // Reporta o tamanho anterior para o agente perceber quando "reescrever" encolheu o
  // arquivo — o sintoma clássico de ter reescrito a partir de uma leitura parcial.
  let previousLines = 0, existed = false;
  try {
    const prev = readFileSync(filePath, 'utf-8');
    existed = true;
    previousLines = prev.split('\n').length;
  } catch (e) { /* arquivo novo */ }

  // Sobrescrever um arquivo que o agente nunca leu apaga conteúdo que ele nem sabe que
  // existe. A checagem mora aqui, junto da escrita, para não haver intervalo entre
  // verificar e gravar. Criar arquivo novo segue livre.
  if (existed && opts.requireRead) {
    return {
      success: false,
      error: `O arquivo ${filePath} já existe e não foi lido nesta conversa — sobrescrevê-lo apagaria conteúdo desconhecido.`,
      // Sem a última frase o modelo contornava o bloqueio apagando o arquivo e criando
      // de novo, que é exatamente a perda de conteúdo que a trava existe para impedir.
      hint: 'Chame read_file neste arquivo e refaça. Para mudar só um trecho, edit_file preserva o resto. NÃO apague o arquivo para recriá-lo: isso destrói o que você ainda não leu, e delete_file recusa pelo mesmo motivo.'
    };
  }

  const anterior = existed ? readFileSync(filePath, 'utf-8') : '';
  mkdirSync(dirname(filePath), { recursive: true }); // cria as pastas pai se não existirem
  writeFileSync(filePath, content, 'utf-8');
  const lines = String(content).split('\n').length;
  return {
    success: true, created: !existed, lines, previousLines,
    bytes: Buffer.byteLength(content, 'utf-8'),
    snapshotId: salvaInstantaneo(filePath, anterior, existed, String(content)),
    diff: calculaDiff(anterior, content)
  };
});

// Edição cirúrgica: troca um trecho exato em vez de reescrever o arquivo inteiro.
// É a ferramenta de escrita padrão do agente — write_file de um arquivo de 800 linhas
// para mudar 3 delas gasta ~10x mais tokens de saída e é onde a geração costuma ser
// cortada no limite, produzindo arquivos truncados.
ipcMain.handle('edit-file', async (event, filePath, oldText, newText, replaceAll = false) => {
  if (typeof oldText !== 'string' || oldText === '') {
    return { success: false, error: 'old_text vazio. Informe o trecho exato a substituir (use write_file para criar um arquivo novo).' };
  }
  if (oldText === newText) return { success: false, error: 'old_text e new_text são idênticos — nada a fazer.' };

  let original;
  try { original = readFileSync(filePath, 'utf-8'); }
  catch (e) { return { success: false, error: `Arquivo não encontrado: ${filePath}. Use write_file para criá-lo.` }; }

  let count = 0, at = 0, first = -1;
  while ((at = original.indexOf(oldText, at)) !== -1) {
    if (first === -1) first = at;
    count++; at += oldText.length;
  }

  if (count === 0) {
    // Quase sempre a diferença é indentação/espaço no fim da linha, e o modelo fica
    // tentando a mesma edição em loop. Dizer QUAL é a diferença encerra o loop.
    const norm = (s) => s.replace(/[ \t]+/g, ' ').replace(/[ \t]+$/gm, '').trim();
    const hint = norm(original).includes(norm(oldText))
      ? 'O trecho existe mas com espaços/indentação diferentes — releia o arquivo com read_file e copie o texto exatamente como está.'
      : 'Releia o arquivo com read_file: o conteúdo pode ter mudado ou o trecho não existe.';
    return { success: false, error: `Trecho não encontrado em ${filePath}.`, hint };
  }
  if (count > 1 && !replaceAll) {
    return {
      success: false, occurrences: count,
      error: `O trecho aparece ${count} vezes em ${filePath}.`,
      hint: 'Inclua linhas de contexto ao redor para tornar old_text único, ou passe replace_all: true para trocar todas.'
    };
  }

  const updated = replaceAll ? original.split(oldText).join(newText) : original.replace(oldText, newText);
  writeFileSync(filePath, updated, 'utf-8');
  return {
    success: true,
    replacements: replaceAll ? count : 1,
    line: original.slice(0, first).split('\n').length, // linha da primeira substituição
    linesBefore: original.split('\n').length,
    linesAfter: updated.split('\n').length,
    snapshotId: salvaInstantaneo(filePath, original, true, updated),
    diff: calculaDiff(original, updated)
  };
});

ipcMain.handle('create-directory', async (event, dirPath) => {
  mkdirSync(dirPath, { recursive: true });
  return { success: true };
});

// Informações do app lidas do package.json (ex: URL do GitHub, versão)
ipcMain.handle('get-app-info', async () => {
  try {
    const pkg = JSON.parse(readFileSync(join(__dirname, 'package.json'), 'utf-8'));
    return {
      githubUrl: pkg.githubUrl || pkg.homepage || (pkg.repository && (pkg.repository.url || pkg.repository)) || '',
      version: pkg.version || '',
      name: pkg.productName || pkg.name || ''
    };
  } catch (e) {
    return { githubUrl: '', version: '', name: '' };
  }
});

ipcMain.handle('delete-file', async (event, filePath, opts = {}) => {
  // Mesma trava do write_file. Sem ela, o modelo barrado ao sobrescrever simplesmente
  // apagava o arquivo e criava de novo — o desvio que causava a perda de conteúdo.
  if (opts.requireRead && existsSync(filePath)) {
    return {
      success: false,
      error: `O arquivo ${filePath} não foi lido nesta conversa — apagá-lo removeria conteúdo que você não viu.`,
      hint: 'Se a intenção é alterar o conteúdo, use edit_file ou leia com read_file e reescreva. Se a remoção foi mesmo pedida pelo usuário, leia o arquivo antes para confirmar que é o certo.'
    };
  }

  // Guarda o conteúdo ANTES de apagar: é a operação em que desfazer mais importa,
  // porque sem o instantâneo o arquivo simplesmente deixou de existir.
  let anterior = null;
  try { anterior = readFileSync(filePath, 'utf-8'); } catch (e) { /* binário ou ilegível */ }
  const linhas = anterior != null ? anterior.split('\n').length : 0;
  unlinkSync(filePath);
  return {
    success: true, linhasApagadas: linhas,
    snapshotId: anterior != null ? salvaInstantaneo(filePath, anterior, true, '') : null
  };
});

// Lista recursiva dos ARQUIVOS do workspace, usada pelo autocomplete de menção (@arquivo).
// Ignora pastas pesadas/geradas e limita a quantidade para não travar projetos gigantes.
const MENTION_IGNORE = new Set([
  'node_modules', 'dist', 'build', 'out', '.next', '.nuxt', 'coverage', '.cache',
  'vendor', '__pycache__', '.venv', 'venv', 'target', 'bin', 'obj', '.git'
]);
const MENTION_FILE_CAP = 5000;

// Sem isto o agente só procuraria via `grep` no execute_command — que passa pelo modal
// de confirmação, muda de sintaxe entre Linux e Windows e não devolve nada estruturado.
const SEARCH_MAX_FILE_BYTES = 2 * 1024 * 1024; // arquivos maiores raramente são fonte
const SEARCH_MAX_RESULTS = 200;

ipcMain.handle('search-files', async (event, rootPath, opts = {}) => {
  const query = String(opts.query || '');
  if (!query) return { success: false, error: 'query vazia' };

  let re;
  try {
    re = opts.regex
      ? new RegExp(query, opts.caseSensitive ? 'g' : 'gi')
      : new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), opts.caseSensitive ? 'g' : 'gi');
  } catch (e) {
    return { success: false, error: `Regex inválida: ${e.message}` };
  }

  // Filtro de nome de arquivo no estilo glob (*.js, *.test.*), aplicado ao caminho relativo
  // Glob simples (*.js, src/**/*.test.js) convertido caractere a caractere: "*" fica
  // dentro de um segmento e "**" atravessa barras, como nas ferramentas de busca usuais.
  const globToRegex = (glob) => {
    let out = '';
    for (let i = 0; i < glob.length; i++) {
      const c = glob[i];
      if (c === '*') {
        if (glob[i + 1] === '*') {
          // "src/**/*.js" precisa casar também com "src/app.js" — o "**/" cobre
          // ZERO ou mais pastas, senão só acha o que está aninhado.
          if (glob[i + 2] === '/') { out += '(?:.*/)?'; i += 2; } else { out += '.*'; i++; }
        } else out += '[^/]*';
      } else if (c === '?') out += '[^/]';
      else if ('.+^${}()|[]\\'.includes(c)) out += '\\' + c;
      else out += c;
    }
    return new RegExp('^' + out + '$', 'i');
  };

  let nameRe = null;
  if (opts.filePattern) {
    try { nameRe = globToRegex(String(opts.filePattern)); } catch (e) { nameRe = null; }
  }

  const max = Math.min(Math.max(opts.maxResults || 60, 1), SEARCH_MAX_RESULTS);
  const matches = [];
  let scanned = 0, truncated = false;

  const walk = (dir, rel) => {
    if (truncated) return;
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
    for (const ent of entries) {
      if (truncated) return;
      const relPath = rel ? `${rel}/${ent.name}` : ent.name;
      if (ent.isDirectory()) {
        if (ent.name.startsWith('.') || MENTION_IGNORE.has(ent.name)) continue;
        walk(join(dir, ent.name), relPath);
        continue;
      }
      if (!ent.isFile()) continue;
      if (nameRe && !nameRe.test(relPath) && !nameRe.test(ent.name)) continue;

      const full = join(dir, ent.name);
      let buf;
      try {
        if (statSync(full).size > SEARCH_MAX_FILE_BYTES) continue;
        buf = readFileSync(full);
      } catch (e) { continue; }
      if (looksBinary(buf)) continue;
      scanned++;

      const lines = buf.toString('utf-8').split('\n');
      for (let i = 0; i < lines.length; i++) {
        re.lastIndex = 0;
        if (!re.test(lines[i])) continue;
        matches.push({
          file: relPath,
          line: i + 1,
          // Linhas muito longas (minificados que passaram do filtro) viram ruído no contexto
          text: lines[i].length > 300 ? lines[i].slice(0, 300) + '…' : lines[i]
        });
        if (matches.length >= max) { truncated = true; return; }
      }
    }
  };

  try { walk(rootPath, ''); } catch (e) { /* ignora */ }
  return { success: true, query, count: matches.length, scanned, truncated, matches };
});

ipcMain.handle('list-tree', async (event, rootPath) => {
  const files = [];
  const walk = (dir, rel) => {
    if (files.length >= MENTION_FILE_CAP) return;
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
    for (const ent of entries) {
      if (files.length >= MENTION_FILE_CAP) return;
      const relPath = rel ? `${rel}/${ent.name}` : ent.name;
      if (ent.isDirectory()) {
        // pula pastas ignoradas e ocultas (.git, .idea, etc.), mas mantém arquivos ocultos
        if (ent.name.startsWith('.') || MENTION_IGNORE.has(ent.name)) continue;
        walk(join(dir, ent.name), relPath);
      } else if (ent.isFile()) {
        files.push(relPath);
      }
    }
  };
  try { walk(rootPath, ''); } catch (e) { /* ignora */ }
  return { files, capped: files.length >= MENTION_FILE_CAP };
});

// ==========================================================================
//  Execução de comandos com gerenciamento inteligente de processos
// ==========================================================================
// Registro de processos vivos (servidores, watchers, etc.). Cada entrada mantém
// um buffer rolante de logs para que o agente possa inspecioná-los depois.
const procs = new Map(); // pid -> { command, child, stdout, stderr, startedAt, ready, status }

const LOG_CAP = 200 * 1024; // buffer rolante por stream
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
  if (entry[key].length > LOG_CAP) entry[key] = entry[key].slice(-LOG_CAP);
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
  const hardTimeoutMs = opts.timeoutMs || 25000; // teto absoluto para tarefas que terminam
  const idleMs = opts.idleMs || 2500;            // silêncio => provável servidor ocioso esperando conexões
  const graceMs = 600;                           // tempo mínimo antes de considerar "ocioso"

  return new Promise((resolve) => {
    // detached + stdin ignorado => sessão própria, SEM terminal de controle:
    //  - impede que `sudo` sequestre o terminal do usuário (falha com "a terminal is required")
    //  - permite deixar servidores rodando em segundo plano sem travar o app
    let child;
    try {
      child = spawn(command, {
        cwd, shell: SHELL, detached: true,
        windowsHide: true, // no Windows, evita piscar uma janela de console a cada comando
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', FORCE_COLOR: '0' }
      });
    } catch (err) {
      return resolve({ command, stdout: '', stderr: '', error: err.message, finished: true });
    }

    const entry = { command, child, stdout: '', stderr: '', startedAt: Date.now(), ready: false, status: 'running' };
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
        command, pid: child.pid, finished: false, backgrounded: true, reason,
        stdout: entry.stdout, stderr: entry.stderr,
        note: `Processo iniciado em segundo plano (PID ${child.pid}) — ${reason}. ` +
              `O chat NÃO travou. Use read_process_output(${child.pid}) para ver os logs, ` +
              `list_processes para listar, e stop_process(${child.pid}) para encerrar.`
      });
    };

    // Reinicia o "cronômetro de ocioso" a cada saída: builds barulhentos seguem esperando;
    // servidores que imprimem o banner e ficam quietos são considerados prontos.
    const bumpIdle = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        if (Date.now() - entry.startedAt >= graceMs) backgroundify('ficou ocioso (provável servidor aguardando conexões)');
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
    child.stdout.on('data', onData('stdout'));
    child.stderr.on('data', onData('stderr'));
    bumpIdle();

    const hardTimer = setTimeout(() => backgroundify(`ainda em execução após ${Math.round(hardTimeoutMs / 1000)}s`), hardTimeoutMs);

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(hardTimer); clearTimeout(idleTimer);
      resolve({ command, stdout: entry.stdout, stderr: entry.stderr, error: err.message, finished: true });
    });

    child.on('close', (code) => {
      entry.status = 'exited';
      entry.exitCode = code; // guardado no registro: wait_for_process precisa dizer se deu certo
      if (settled) return; // já estava em segundo plano — apenas marca como encerrado no registro
      settled = true;
      clearTimeout(hardTimer); clearTimeout(idleTimer);
      resolve({
        command, stdout: entry.stdout, stderr: entry.stderr,
        error: code === 0 ? null : `Processo encerrou com código ${code}`,
        exitCode: code, finished: true
      });
    });
  });
});

// Lê o output acumulado de um processo em segundo plano
ipcMain.handle('read-process-output', async (event, pid) => {
  const entry = procs.get(pid);
  if (!entry) return { success: false, error: `Nenhum processo em segundo plano com PID ${pid}` };
  return {
    success: true, pid, command: entry.command, status: entry.status,
    uptimeSec: Math.round((Date.now() - entry.startedAt) / 1000),
    stdout: entry.stdout, stderr: entry.stderr
  };
});

// ESPERA o processo terminar, em vez de o agente ficar perguntando "já acabou?".
// Sem isto, um `npm install` de 20s vira uma dezena de idas e voltas ao modelo —
// cada uma com o histórico inteiro — só para reler "running". Aqui o turno fica
// parado no main até o processo sair (ou até o prazo), e volta UMA resposta.
ipcMain.handle('wait-for-process', async (event, pid, timeoutMs = 120000) => {
  const entry = procs.get(pid);
  if (!entry) return { success: false, error: `Nenhum processo em segundo plano com PID ${pid}` };

  const limite = clamp(timeoutMs, 1000, 600000);
  const inicio = Date.now();

  if (entry.status === 'running') {
    await new Promise((resolve) => {
      let pronto = false;
      const terminar = () => { if (!pronto) { pronto = true; clearTimeout(prazo); resolve(); } };
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
    note: terminou
      ? `O processo terminou depois de ~${esperou}s.`
      : `Ainda rodando após ${esperou}s (prazo esgotado). Se for um servidor, isso é o esperado — siga o trabalho e use read_process_output quando precisar dos logs.`
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
  try {
    killTree(pid);                                       // pedido educado (SIGTERM / taskkill sem /F)
    setTimeout(() => killTree(pid, { force: true }), 3000); // força se ainda estiver vivo
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
});

// Persistência local (chats e configurações) no diretório de dados do usuário
const storePath = () => join(app.getPath('userData'), 'app-store.json');

ipcMain.handle('load-store', async () => {
  try {
    const file = storePath();
    if (!existsSync(file)) return null;
    return JSON.parse(readFileSync(file, 'utf-8'));
  } catch (err) {
    return null;
  }
});

ipcMain.handle('save-store', async (event, data) => {
  try {
    writeFileSync(storePath(), JSON.stringify(data, null, 2), 'utf-8');
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// Atualiza o título da janela (ex.: "Pofuserver Coder Studio — pensando…")
ipcMain.on('set-title', (event, title) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win && typeof title === 'string' && title.trim()) win.setTitle(title);
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
  let win = null;
  try {
    win = new BrowserWindow({
      width: opts.width || 1280, height: opts.height || 900, show: false, skipTaskbar: true,
      webPreferences: {
        offscreen: true, nodeIntegration: false, contextIsolation: true, sandbox: true,
        backgroundThrottling: false, partition: opts.partition || 'janela-oculta'
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
    return await win.webContents.executeJavaScript(extrator, true);
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
    pagesToFetch: 2,      // o conteúdo real das páginas é o que vale; 2 já enche o contexto
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

ipcMain.handle('web-search', async (event, query, maxResults = 5) => {
  const max = clamp(maxResults || 5, 1, 10);
  try {
    const out = await getBuscador().search(String(query || ''));
    if (!out || !out.results.length) {
      return {
        success: false,
        error: `Nenhum provedor de busca retornou resultado útil para "${query}".`,
        hint: 'Tente termos mais simples e específicos (sem aspas nem operadores como site:).'
      };
    }
    return {
      success: true,
      query: out.query,
      reformulada: out.simplified ? out.originalQuery : undefined,
      source: out.provider,
      count: out.results.length,
      results: out.results.slice(0, max),
      // O conteúdo já extraído das primeiras páginas evita um fetch_url a seguir só
      // para descobrir o que o snippet resumiu pela metade.
      paginas: out.pages
    };
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
    const init = {
      method: (opts.method || 'GET').toUpperCase(),
      headers: opts.headers && typeof opts.headers === 'object' ? { ...opts.headers } : {},
      redirect: 'follow',
      signal: AbortSignal.timeout(clamp(opts.timeoutMs || 15000, 500, 120000))
    };
    if (opts.body != null && init.method !== 'GET' && init.method !== 'HEAD') {
      init.body = typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body);
      // Sem content-type explícito o servidor recebe o JSON como texto e devolve 400/415,
      // e o agente perde turnos depurando um erro que é da própria chamada.
      const hasCt = Object.keys(init.headers).some(h => h.toLowerCase() === 'content-type');
      if (!hasCt && /^\s*[[{]/.test(init.body)) init.headers['Content-Type'] = 'application/json';
    }

    const resp = await fetch(url, init);
    const body = await resp.text();
    const headers = {};
    resp.headers.forEach((v, k) => { headers[k] = v; });
    return {
      success: true, url, status: resp.status, statusText: resp.statusText,
      ok: resp.ok, ms: Date.now() - started, headers,
      body: body.length > 20000 ? body.slice(0, 20000) + '\n…[corpo truncado]' : body,
      bodyBytes: body.length
    };
  } catch (err) {
    const msg = String(err.message || err);
    // O erro de conexão recusada é o caso mais comum (servidor não subiu); dizer isso
    // direto evita que o modelo trate como bug da aplicação e saia editando código.
    const hint = /ECONNREFUSED|fetch failed|refused/i.test(msg)
      ? 'Nada escutando nessa porta. Suba o servidor com execute_command (ele fica em segundo plano) e confira os logs com read_process_output antes de tentar de novo.'
      : (/timed out|aborted|TimeoutError/i.test(msg) ? 'A requisição estourou o tempo limite — o servidor pode estar travado ou lento.' : undefined);
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

// Abre a URL oculta, coleta console e rede, roda um script opcional e devolve o PNG.
// É assim que o agente vê o que construiu, em vez de deduzir pelo código.
ipcMain.handle('capture-page', async (event, url, opts = {}) => {
  const width = clamp(opts.width || 1280, 320, 2560);
  const height = clamp(opts.height || 800, 240, 2000);
  const waitMs = clamp(opts.waitMs ?? 700, 0, 20000);

  const logs = [];
  const netErrors = [];
  let win = null;

  try {
    win = new BrowserWindow({
      width, height, show: false, skipTaskbar: true,
      webPreferences: {
        // offscreen garante que a página seja realmente renderizada mesmo com a janela
        // oculta — sem isso capturePage() pode devolver uma imagem em branco.
        offscreen: true,
        nodeIntegration: false, contextIsolation: true, sandbox: true,
        backgroundThrottling: false,
        partition: 'capture-session' // sessão isolada: não mistura cookies/cache com o app
      }
    });
    const wc = win.webContents;

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
      while (Date.now() < deadline) {
        selectorFound = await wc.executeJavaScript(`!!document.querySelector(${JSON.stringify(opts.selector)})`).catch(() => false);
        if (selectorFound) break;
        await sleep(150);
      }
    }
    if (waitMs) await sleep(waitMs);

    // Script opcional na página: permite interagir (clicar, preencher) antes do print
    let scriptResult, scriptError;
    if (opts.script) {
      try {
        const r = await wc.executeJavaScript(`(async () => { ${opts.script} })()`, true);
        scriptResult = typeof r === 'string' ? r.slice(0, 4000) : JSON.stringify(r ?? null)?.slice(0, 4000);
        if (waitMs) await sleep(Math.min(waitMs, 800)); // deixa a UI reagir ao script
      } catch (e) {
        scriptError = String(e && e.message || e).slice(0, 500);
      }
    }

    const title = await wc.executeJavaScript('document.title').catch(() => '');
    const text = await wc.executeJavaScript(
      '(document.body ? document.body.innerText : "").replace(/\\n{3,}/g, "\\n\\n").slice(0, 3000)'
    ).catch(() => '');

    // Página inteira: sem isto o agente vê só a primeira dobra e conclui que "está tudo
    // certo" sem nunca ter olhado o rodapé. Aumentar a janela até a altura do documento
    // também faz o IntersectionObserver disparar em tudo, revelando animações de rolagem
    // que ficariam invisíveis numa captura só do topo.
    let alturaTotal = height;
    if (opts.fullPage) {
      const medida = await wc.executeJavaScript(
        'Math.max(document.body.scrollHeight, document.documentElement.scrollHeight)'
      ).catch(() => height);
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
      const medida = await wc.executeJavaScript(`(() => {
        const el = document.querySelector(${JSON.stringify(opts.cropSelector)});
        if (!el) return null;
        el.scrollIntoView({ block: 'center' });
        const r = el.getBoundingClientRect();
        return { x: r.x, y: r.y, width: r.width, height: r.height };
      })()`).catch(() => null);
      if (!medida || medida.width < 1 || medida.height < 1) {
        recorteFalhou = `Elemento "${opts.cropSelector}" não encontrado (ou sem tamanho) — capturei a página toda.`;
      } else {
        await sleep(250); // o scrollIntoView precisa assentar antes de medir de novo
        const r2 = await wc.executeJavaScript(`(() => {
          const el = document.querySelector(${JSON.stringify(opts.cropSelector)});
          const r = el.getBoundingClientRect();
          return { x: r.x, y: r.y, width: r.width, height: r.height };
        })()`).catch(() => medida);
        const folga = 8; // uma margem ajuda a julgar alinhamento em relação ao redor
        rect = {
          x: Math.max(0, Math.floor(r2.x - folga)),
          y: Math.max(0, Math.floor(r2.y - folga)),
          width: Math.ceil(r2.width + folga * 2),
          height: Math.ceil(r2.height + folga * 2)
        };
      }
    }

    const image = rect ? await wc.capturePage(rect) : await wc.capturePage();
    if (image.isEmpty()) return { success: false, error: 'A captura saiu vazia (a página não chegou a renderizar).' };

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
  } catch (err) {
    const msg = String(err && err.message || err);
    const hint = /ERR_CONNECTION_REFUSED|ERR_FAILED|ERR_EMPTY_RESPONSE/i.test(msg)
      ? 'A página não respondeu. Confirme que o servidor está no ar (list_processes / read_process_output) antes de capturar.'
      : undefined;
    return { success: false, url, error: msg, hint };
  } finally {
    if (win && !win.isDestroyed()) win.destroy();
  }
});

// Rehidrata um print salvo (histórico recarregado) para reenviá-lo ao modelo
ipcMain.handle('read-image', async (event, filePath) => {
  try {
    const buf = readFileSync(filePath);
    return { success: true, dataUrl: 'data:image/png;base64,' + buf.toString('base64') };
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

ipcMain.handle('fetch-url', async (event, url, maxChars = 8000) => {
  let statusHttp = null, viaNavegador = false, texto = '', erroHttp = null;
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
    texto = (ct.includes('html') || /^\s*</.test(bruto)) ? htmlToText(bruto) : bruto;
  } catch (err) {
    texto = '';
    statusHttp = null;
    erroHttp = err.message;
  }

  // Segunda tentativa no navegador: SPA, muro de consentimento ou anti-bot.
  if (texto.trim().length < FETCH_MIN_TEXTO_UTIL) {
    const html = await renderizaHtml(url);
    if (html) {
      const rend = htmlToText(html);
      if (rend.trim().length > texto.trim().length) { texto = rend; viaNavegador = true; }
    }
  }

  if (!texto.trim()) {
    return { success: false, url, status: statusHttp, error: erroHttp || 'A página não devolveu texto legível.' };
  }
  return {
    success: true, url, status: statusHttp, viaNavegador,
    content: texto.slice(0, maxChars),
    truncado: texto.length > maxChars || undefined
  };
});