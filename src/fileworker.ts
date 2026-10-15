// SPDX-License-Identifier: Apache-2.0
// Copyright 2026-present the Pofu Code Studio authors. All rights reserved.
// Licensed under the Apache License, Version 2.0. See /LICENSE and /NOTICE.
// Source: https://github.com/Dspofu/Pofu-Code-Studio

// Todos os handlers de arquivo do main usavam fs SÍNCRONO (readFileSync, readdirSync,
// statSync, writeFileSync…) dentro de callbacks `async` que não tinham `await` antes da
// chamada. `async` aí é cosmético: o bloco síncrono roda na hora e TRAVA o event loop do
// processo main — o MESMO loop que bombeia a BrowserWindow (título, "não está respondendo",
// IPC, pintura). Uma leitura pesada (search_files varrendo o projeto, list_definitions em
// 200 arquivos, read_file de 25 MiB, diff LCS de 1500x1500) segurava o loop por segundos e
// o Chromium marcava a janela como "App is not responding".
//
// Por isso o trabalho de arquivo mora aqui, numa POCA de worker_threads: o main só faz o
// IPC e `await`a o resultado, deixando o loop livre enquanto o disco/CPU rodam em outra
// thread. Só o que exige API do Electron (safeStorage, desktopCapturer, nativeImage, spawn,
// janelas ocultas, rede) fica no main — e o `userData` chega por workerData, porque
// `app.getPath` não existe na thread de trabalho.
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { cpus } from 'node:os';
import { dirname, join, relative } from 'path';
import { readdirSync, readFileSync, writeFileSync, unlinkSync, existsSync, mkdirSync, statSync, realpathSync, openSync, fstatSync, closeSync, readSync } from 'fs';
import { fileWindow } from './tool-results.js';
import { globToRegex, suggestPaths } from './tool-output.js';
import { extraiDefinicoes, suportaEstrutura } from './outline.js';
import { applyEdits } from './edit-match.js';
import { editDiagnostics } from './edit-diagnostics.js';

// ---------------------------------------------------------------------------
//  Constantes e helpers (mesmos valores do main; movidos para a thread de arquivo)
// ---------------------------------------------------------------------------
const READ_MAX_BYTES = 25 * 1024 * 1024;

function looksBinary(buf) {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

function mudouDesde(filePath, esperado) {
  if (typeof esperado !== 'number') return false;
  try { return Math.abs(statSync(filePath).mtimeMs - esperado) > 1; } catch { return false; }
}
function mtimeDe(filePath) {
  try { return statSync(filePath).mtimeMs; } catch { return undefined; }
}

const LIMITE_INSTANTANEOS = 200;
function pastaInstantaneos() {
  const dir = join(userData(), 'instantaneos');
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

function dicaDeReescrita(antes: string, depois: string) {
  if (antes.length < 2000 || depois.length < 2000) return {};
  const velhas = new Map<string, number>();
  for (const l of antes.split('\n')) velhas.set(l, (velhas.get(l) || 0) + 1);
  const novas = depois.split('\n');
  let iguais = 0;
  for (const l of novas) { const n = velhas.get(l); if (n) { iguais++; velhas.set(l, n - 1); } }
  const total = Math.max(novas.length, antes.split('\n').length);
  if (iguais / total < 0.6) return {};
  return { hint: `${iguais} of ${novas.length} lines were already on disk; only ~${total - iguais} changed. ` +
    'For edits like this use edit_file (with edits[] for several spots): it sends only the changed snippets.' };
}

// Lista recursiva dos ARQUIVOS do workspace, usada pelo autocomplete de menção (@arquivo).
// Ignora pastas pesadas/geradas e limita a quantidade para não travar projetos gigantes.
const MENTION_IGNORE = new Set([
  'node_modules', 'dist', 'build', 'out', '.next', '.nuxt', 'coverage', '.cache',
  'vendor', '__pycache__', '.venv', 'venv', 'target', 'bin', 'obj', '.git'
]);
const MENTION_FILE_CAP = 5000;

// Sem isto o agente só procuraria via `grep` no execute_command — que passa pelo modal
// de confirmação, muda de sintaxe entre Linux e Windows e não devolve nada estruturado.
const SEARCH_MAX_FILE_BYTES = READ_MAX_BYTES; // busca e leitura aceitam os mesmos arquivos
const SEARCH_MAX_RESULTS = 200;

const OUTLINE_MAX_FILES = 200;
const OUTLINE_MAX_BYTES = 2 * 1024 * 1024;

function arvoreDoProjeto(rootPath) {
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
}

// ---------------------------------------------------------------------------
//  Implementações das operações (corpo idêntico ao que antes rodava no main)
// ---------------------------------------------------------------------------
function opReadFile(args) {
  const { filePath, opts = {} } = args;
  let st;
  try { st = statSync(filePath); } catch (e) {
    const suggestions = opts.workspace ? suggestPaths(filePath, arvoreDoProjeto(opts.workspace).files) : [];
    return { success: false, error: `File not found: ${filePath}`,
      ...(suggestions.length ? { did_you_mean: suggestions } : {}) };
  }
  if (st.isDirectory()) return { success: false, error: `"${filePath}" is a directory — use list_files.` };
  if (st.size > READ_MAX_BYTES) {
    return { success: false, error: `File too large (${(st.size / 1e6).toFixed(1)} MB, cap ${READ_MAX_BYTES / 1e6} MB). No content was read. This file exceeds the memory guard for read_file and search_files; use a streaming reader with a bounded output for this large dataset.` };
  }

  const buf = readFileSync(filePath);
  if (looksBinary(buf)) {
    return { success: false, binary: true, size: st.size, error: `Binary file (${st.size} bytes) — the content is not readable text.` };
  }
  const text = buf.toString('utf-8');
  return { ...fileWindow(text, opts), size: st.size, mtimeMs: st.mtimeMs };
}

function opListFiles(args) {
  const dirPath = args.dirPath;
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
}

function opListTree(args) {
  return arvoreDoProjeto(args.rootPath);
}

function opOutline(args) {
  const { target, opts = {} } = args;
  let st;
  try { st = statSync(target); } catch (e) {
    const suggestions = opts.workspace ? suggestPaths(target, arvoreDoProjeto(opts.workspace).files) : [];
    return { success: false, error: `Path not found: ${target}`, ...(suggestions.length ? { did_you_mean: suggestions } : {}) };
  }
  const pasta = st.isDirectory();
  if (!pasta && !suportaEstrutura(target))
    return { success: false, error: `list_definitions does not support this file type: ${target}. Use read_file (with query to jump to a term).` };
  const nameRe = opts.pattern ? globToRegex(String(opts.pattern)) : null;
  const fontes = pasta
    ? arvoreDoProjeto(target).files.filter(f => suportaEstrutura(f) && (!nameRe || nameRe.test(f) || nameRe.test(f.slice(f.lastIndexOf('/') + 1)))).map(f => join(target, f))
    : [target];
  const base = opts.workspace || (pasta ? target : dirname(target));
  const files = [], notes = [];
  let grandes = 0;
  for (const full of fontes.slice(0, OUTLINE_MAX_FILES)) {
    let buf;
    try {
      if (statSync(full).size > OUTLINE_MAX_BYTES) { grandes++; continue; }
      buf = readFileSync(full);
    } catch (e) { continue; }
    if (looksBinary(buf)) continue;
    const file = relative(base, full).replace(/\\/g, '/') || full;
    files.push({ file, ...extraiDefinicoes(buf.toString('utf-8'), full) });
  }
  if (grandes) notes.push(`[${grandes} file(s) over 2 MiB skipped (likely generated or minified).]`);
  if (fontes.length > OUTLINE_MAX_FILES) notes.push(`[${fontes.length - OUTLINE_MAX_FILES} more source files not scanned; narrow path or pattern.]`);
  return { success: true, files, notes };
}

function opSearchFiles(args) {
  const { rootPath, opts = {} } = args;
  const query = String(opts.query || '');
  if (!query) return { success: false, error: 'Empty query.' };

  let re;
  try {
    re = opts.regex
      ? new RegExp(query, opts.caseSensitive ? 'g' : 'gi')
      : new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), opts.caseSensitive ? 'g' : 'gi');
  } catch (e) {
    return { success: false, error: `Invalid regex: ${e.message}` };
  }

  let nameRe = null;
  if (opts.filePattern) {
    try { nameRe = globToRegex(String(opts.filePattern)); } catch (e) { nameRe = null; }
  }

  const max = Math.min(Math.max(opts.maxResults || 60, 1), SEARCH_MAX_RESULTS);
  const offset = Math.max(0, Math.floor(Number(opts.offset) || 0));
  const matches = [];
  // files/count não precisam do texto de cada achado — só da contagem por arquivo, que é
  // o que responde "onde isso é usado?" por uma fração dos tokens.
  const mode = opts.mode === 'files' || opts.mode === 'count' ? opts.mode : 'content';
  const fileCounts = {};
  let scanned = 0, skippedLarge = 0, truncated = false;
  const contextLines = Math.min(20, Math.max(0, Math.floor(Number(opts.contextLines ?? 2) || 0)));
  // totalFound conta TODAS as ocorrências (não só as devolvidas): sem ele o agente
  // não saberia que uma busca "curta" casou com milhares de linhas e deveria refinar.
  // countCap limita o CONTADOR (não o retorno) — varrer o projeto inteiro só para
  // contar um "function" seria caro demais; passado disso reportamos o teto e paramos.
  let totalFound = 0;
  const countCap = 10000;
  let done = false;

  const walk = (dir, rel) => {
    if (done) return;
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
    for (const ent of entries) {
      if (done) return;
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
        if (statSync(full).size > SEARCH_MAX_FILE_BYTES) { skippedLarge++; continue; }
        buf = readFileSync(full);
      } catch (e) { continue; }
      if (looksBinary(buf)) continue;
      scanned++;

      const lines = buf.toString('utf-8').split('\n');
      for (let i = 0; i < lines.length; i++) {
        re.lastIndex = 0;
        const match = re.exec(lines[i]);
        if (!match) continue;
        totalFound++;
        fileCounts[relPath] = (fileCounts[relPath] || 0) + 1;
        // Devolve só as primeiras `max` (o resto é ruído no contexto), mas CONTINUA
        // contando para o totalFound — para de empilhar, não de escanear.
        if (mode === 'content' && totalFound > offset && matches.length < max) {
          const snippetStart = Math.max(0, match.index - 120);
          const snippetEnd = Math.min(lines[i].length, match.index + Math.min(Math.max(match[0].length, 1), 500) + 180);
          matches.push({
            file: relPath,
            line: i + 1,
            // Linhas muito longas (minificados que passaram do filtro) viram ruído no contexto
            column: match.index + 1,
            text: lines[i].slice(snippetStart, snippetEnd),
            textColumn: snippetStart + 1,
            matchChars: match[0].length,
            shortened: snippetStart > 0 || snippetEnd < lines[i].length,
            lineChars: lines[i].length,
            before: lines.slice(Math.max(0, i - contextLines), i).map((text, n) => ({ line: Math.max(0, i - contextLines) + n + 1, text: text.slice(0, 500), shortened: text.length > 500 })),
            after: lines.slice(i + 1, i + 1 + contextLines).map((text, n) => ({ line: i + n + 2, text: text.slice(0, 500), shortened: text.length > 500 }))
          });
        }
        if (totalFound >= countCap) { done = true; return; }
      }
    }
  };

  try { walk(rootPath, ''); } catch (e) { /* ignora */ }
  truncated = totalFound > offset + matches.length;
  return { success: true, query, mode, fileCounts, offset, count: matches.length, totalFound, scanned, skippedLarge, truncated, matches,
    next_offset: truncated ? offset + matches.length : null,
    countCapped: done,
    note: [done ? 'Count capped at 10000 matching lines; narrow the query or file_pattern.' : '',
      skippedLarge ? `${skippedLarge} file(s) exceed the 25 MiB memory guard and were not scanned.` : '',
      matches.some(m => m.shortened) ? 'Matches are excerpts. Use read_file with filename and offset (line), or query to jump directly to a literal term in a long line.' : ''].filter(Boolean).join(' ') || undefined };
}

function opWriteFile(args) {
  const { filePath, content, opts = {} } = args;
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
      error: `File ${filePath} already exists and has not been read in this conversation — overwriting it would erase content you have never seen.`,
      // Sem a última frase o modelo contornava o bloqueio apagando o arquivo e criando
      // de novo, que é exatamente a perda de conteúdo que a trava existe para impedir.
      hint: 'Call read_file on this file and try again. To change only part of it, edit_file keeps the rest. DO NOT delete the file to recreate it: that destroys what you have not read yet, and delete_file refuses for the same reason.'
    };
  }
  // Leu, mas o arquivo mudou depois (o usuário editou, um formatador rodou, o "Desfazer"
  // foi clicado): sobrescrever agora apagaria uma versão que o agente nunca viu.
  if (existed && mudouDesde(filePath, opts.expectedMtimeMs)) {
    return {
      success: false, stale: true,
      error: `File ${filePath} changed on disk after you last read it — overwriting it would discard changes you have not seen.`,
      hint: 'Call read_file again, then write. edit_file is safer: it only touches the exact snippet.'
    };
  }

  const anterior = existed ? readFileSync(filePath, 'utf-8') : '';
  mkdirSync(dirname(filePath), { recursive: true }); // cria as pastas pai se não existirem
  writeFileSync(filePath, content, 'utf-8');
  const lines = String(content).split('\n').length;
  return {
    success: true, created: !existed, lines, previousLines,
    bytes: Buffer.byteLength(content, 'utf-8'), mtimeMs: mtimeDe(filePath),
    ...dicaDeReescrita(anterior, String(content)),
    snapshotId: salvaInstantaneo(filePath, anterior, existed, String(content)),
    diff: calculaDiff(anterior, content)
  };
}

function opEditFile(args) {
  const { filePath, oldText, newText, replaceAll = false, opts = {} } = args;
  // edits[] faz várias trocas numa chamada só; o formato antigo vira uma lista de uma.
  const lote = Array.isArray(opts.edits) && opts.edits.length;
  const pedidos = lote ? opts.edits : [{ old_text: oldText, new_text: newText, replace_all: replaceAll }];
  if (lote && pedidos.length > 50) return { success: false, error: 'Too many edits in one call (max 50).' };
  // O modelo às vezes manda número ou objeto no new_text; sem o String() o arquivo
  // receberia "[object Object]".
  for (const e of pedidos) if (e && e.new_text != null) e.new_text = String(e.new_text);

  let original;
  try { original = readFileSync(filePath, 'utf-8'); }
  catch (e) { return { success: false, error: `File not found: ${filePath}. Use write_file to create it.` }; }

  const r = applyEdits(original, pedidos);
  if (r.ok === false) {
    const f = r.failure, qual = lote ? `edits[${r.index}]: ` : '';
    // Ninguém ficou gravado: o lote é atômico, então repetir só o que falhou não basta.
    const nada = lote ? ' No edit from this call was applied; resend the whole batch after fixing it.' : '';
    if (f.kind === 'empty') return { success: false, error: `${qual}Empty old_text. Provide the exact snippet to replace (use write_file to create a new file).` + nada };
    if (f.kind === 'identical') return { success: false, error: `${qual}old_text and new_text are identical — nothing to do.` + nada };
    if (f.kind === 'ambiguous' || f.kind === 'ambiguous_fuzzy') return {
      success: false, occurrences: f.count, lines: f.lines,
      error: `${qual}The snippet appears ${f.count} times in ${filePath}` + (f.kind === 'ambiguous_fuzzy' ? ' (ignoring whitespace).' : '.'),
      hint: (f.kind === 'ambiguous_fuzzy'
        ? 'replace_all only applies to exact text; copy the snippet exactly, whitespace included.'
        : 'Add surrounding lines to make old_text unique, or pass replace_all: true to replace every occurrence.') + nada
    };
    // Não achou nem ignorando espaço: diagnóstico do disco, sem escrever nada aproximado.
    // Num lote, o diagnóstico é contra o conteúdo JÁ com as edições anteriores aplicadas.
    const e = pedidos[r.index];
    return { success: false, error: `${qual}Snippet not found in ${filePath}.` + nada,
      ...editDiagnostics(r.content, e.old_text, e.new_text ?? '') };
  }

  const updated = r.content;
  try { writeFileSync(filePath, updated, 'utf-8'); }
  catch (err) {
    // Somente-leitura, arquivo aberto por outro programa, pasta protegida: sem esta
    // captura a exceção subia crua ("EPERM: operation not permitted"), sem dica, e o
    // agente repetia a mesma edição.
    return {
      success: false,
      error: `Could not write to ${filePath}: ${err.message}`,
      hint: 'The file may be read-only or open in another program. Check it with execute_command before trying again.'
    };
  }

  // Casamento que ignorou espaço é dito ao modelo: o texto que ele "lembra" daquele trecho
  // não é o que está no arquivo, e a próxima edição ali deve partir do que foi gravado.
  const tolerante = r.applied.filter(a => a.strategy !== 'exact' && a.strategy !== 'crlf');
  return {
    success: true,
    replacements: r.applied.reduce((n, a) => n + a.count, 0),
    line: r.applied[0].line, // linha da primeira substituição
    ...(lote ? { edits_applied: r.applied.length, lines_edited: r.applied.map(a => a.line) } : {}),
    ...(tolerante.length ? { matched_ignoring_whitespace: true,
      note: 'old_text matched after normalizing whitespace/indentation/quotes; new_text was re-indented to the file. Copy exact text from the file for later edits here.' } : {}),
    linesBefore: original.split('\n').length,
    linesAfter: updated.split('\n').length,
    mtimeMs: mtimeDe(filePath),
    snapshotId: salvaInstantaneo(filePath, original, true, updated),
    diff: calculaDiff(original, updated)
  };
}

function opDeleteFile(args) {
  const { filePath, opts = {} } = args;
  // Mesma trava do write_file. Sem ela, o modelo barrado ao sobrescrever simplesmente
  // apagava o arquivo e criava de novo — o desvio que causava a perda de conteúdo.
  if (opts.requireRead && existsSync(filePath)) {
    return {
      success: false,
      error: `File ${filePath} has not been read in this conversation — deleting it would remove content you have never seen.`,
      hint: 'If the goal is to change the content, use edit_file, or read it with read_file and rewrite it. If the user really asked for the removal, read the file first to confirm it is the right one.'
    };
  }

  // Guarda o conteúdo ANTES de apagar: é a operação em que desfazer mais importa,
  // porque sem o instantâneo o arquivo simplesmente deixou de existir.
  let anterior = null;
  try { anterior = readFileSync(filePath, 'utf-8'); } catch (e) { /* binário ou ilegível */ }
  const linhas = anterior != null ? anterior.split('\n').length : 0;
  try { unlinkSync(filePath); }
  catch (err) {
    if (err.code === 'ENOENT') return {
      success: true, deleted: false, already_absent: true,
      note: 'The file is already absent. Nothing was deleted; no retry is needed.'
    };
    return { success: false, deleted: false, error: `Could not delete ${filePath}: ${err.message}`,
      code: err.code, hint: 'Check whether the path is a directory, read-only, or locked. No deletion was completed; do not retry unchanged arguments.' };
  }
  return {
    success: true, deleted: true, deletedLines: linhas,
    snapshotId: anterior != null ? salvaInstantaneo(filePath, anterior, true, '') : null
  };
}

function opCreateDirectory(args) {
  mkdirSync(args.dirPath, { recursive: true });
  return { success: true };
}

function opGetDiff(args) {
  try {
    const snap = JSON.parse(readFileSync(join(pastaInstantaneos(), args.snapshotId + '.json'), 'utf-8'));
    return calculaDiff(snap.antes ?? '', snap.depois ?? '');
  } catch (e) {
    return { linhas: [], adicionadas: 0, removidas: 0, indisponivel: true };
  }
}

function opUndoChange(args) {
  let snap;
  try {
    snap = JSON.parse(readFileSync(join(pastaInstantaneos(), args.snapshotId + '.json'), 'utf-8'));
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
}

function opStoreLoad(args) {
  try {
    if (!existsSync(args.file)) return { data: null };
    return { data: JSON.parse(readFileSync(args.file, 'utf-8')) };
  } catch (e) {
    return { data: null };
  }
}

function opStoreSave(args) {
  try {
    writeFileSync(args.file, JSON.stringify(args.data, null, 2), 'utf-8');
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

// `userData` chega por workerData; o main não tem `app.getPath` aqui.
let _userData: string;
function userData() { return _userData; }

function runOp(op, args) {
  switch (op) {
    case 'read-file': return opReadFile(args);
    case 'list-files': return opListFiles(args);
    case 'list-tree': return opListTree(args);
    case 'outline': return opOutline(args);
    case 'search-files': return opSearchFiles(args);
    case 'write-file': return opWriteFile(args);
    case 'edit-file': return opEditFile(args);
    case 'delete-file': return opDeleteFile(args);
    case 'create-directory': return opCreateDirectory(args);
    case 'get-diff': return opGetDiff(args);
    case 'undo-change': return opUndoChange(args);
    case 'store-load': return opStoreLoad(args);
    case 'store-save': return opStoreSave(args);
    default: throw new Error(`Unknown file operation: ${op}`);
  }
}

// ---------------------------------------------------------------------------
//  Lado WORKER: recebe {id, op, args} e devolve {id, result}.
// ---------------------------------------------------------------------------
if (!isMainThread) {
  // Em ESM, workerData não é global: só vem do import.
  _userData = workerData?.userData;
  parentPort.on('message', (msg) => {
    const { id, op, args } = msg;
    let result;
    try {
      result = runOp(op, args);
    } catch (e) {
      result = { success: false, error: String(e?.message || e) };
    }
    parentPort.postMessage({ id, result });
  });
}

// ---------------------------------------------------------------------------
//  Lado MAIN: uma poca pequena de workers; o main só despacha e espera.
// ---------------------------------------------------------------------------
export class FileWorkerPool {
  private workers: Worker[] = [];
  private next = 0;
  private seq = 0;
  private pending = new Map<number, (r: any) => void>();
  constructor(userDataDir: string) {
    const size = Math.max(2, Math.min(4, cpus().length || 2));
    for (let i = 0; i < size; i++) this.workers.push(this.spawn(userDataDir));
  }
  private spawn(userDataDir: string) {
    // new Worker() exige caminho de arquivo absoluto (file:// URL vira ERR_WORKER_PATH).
    const w = new Worker(fileURLToPath(import.meta.url), { workerData: { userData: userDataDir } });
    w.on('message', (m: any) => {
      const p = this.pending.get(m.id);
      if (p) { this.pending.delete(m.id); p(m.result); }
    });
    w.on('error', (e: any) => {
      for (const [id, p] of [...this.pending]) { this.pending.delete(id); p({ success: false, error: String(e?.message || e) }); }
    });
    return w;
  }
  run(op: string, args: any): Promise<any> {
    return new Promise((resolve) => {
      const w = this.workers[this.next % this.workers.length];
      this.next++;
      const id = ++this.seq;
      this.pending.set(id, resolve);
      w.postMessage({ id, op, args });
    });
  }
  dispose() {
    this.workers.forEach(w => w.terminate());
    this.workers = [];
  }
}

let pool: FileWorkerPool | null = null;
// `userData` é resolvido na primeira chamada (depois de `app.whenReady`), quando
// `app.getPath` já está disponível — o main é quem injeta, não o worker.
export function fileOps(userDataDir: string): FileWorkerPool {
  if (!pool) pool = new FileWorkerPool(userDataDir);
  return pool;
}
