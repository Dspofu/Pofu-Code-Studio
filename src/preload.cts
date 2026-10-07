// SPDX-License-Identifier: Apache-2.0
// Copyright 2026-present the Pofu Code Studio authors. All rights reserved.
// Licensed under the Apache License, Version 2.0. See /LICENSE and /NOTICE.
// Source: https://github.com/Dspofu/Pofu-Code-Studio

// Arquivo .cts (e não .ts): o Electron carrega o script de preload com o loader CommonJS
// dele, mas o package.json declara "type": "module" — sem a extensão .cts o compilador
// emitiria `import` aqui e a ponte morreria antes de expor qualquer coisa, deixando a
// janela sem `window.electronAPI`. A extensão trava o formato de saída em CJS.
import { contextBridge, ipcRenderer } from 'electron';

const api: ElectronAPI = {
  selectFolder: () => ipcRenderer.invoke('select-folder'),
  listFiles: (dirPath) => ipcRenderer.invoke('list-files', dirPath),
  listTree: (rootPath) => ipcRenderer.invoke('list-tree', rootPath),
  outline: (target, opts) => ipcRenderer.invoke('outline', target, opts),
  mcpSync: (servers) => ipcRenderer.invoke('mcp-sync', servers),
  mcpStatus: () => ipcRenderer.invoke('mcp-status'),
  mcpCall: (server, tool, args) => ipcRenderer.invoke('mcp-call', server, tool, args),
  readFile: (filePath, opts) => ipcRenderer.invoke('read-file', filePath, opts),
  writeFile: (filePath, content, opts) => ipcRenderer.invoke('write-file', filePath, content, opts),
  editFile: (filePath, oldText, newText, replaceAll, opts) => ipcRenderer.invoke('edit-file', filePath, oldText, newText, replaceAll, opts),
  searchFiles: (rootPath, opts) => ipcRenderer.invoke('search-files', rootPath, opts),
  createDirectory: (dirPath) => ipcRenderer.invoke('create-directory', dirPath),
  deleteFile: (filePath, opts) => ipcRenderer.invoke('delete-file', filePath, opts),
  undoChange: (snapshotId) => ipcRenderer.invoke('undo-change', snapshotId),
  getDiff: (snapshotId) => ipcRenderer.invoke('get-diff', snapshotId),
  httpRequest: (url, opts) => ipcRenderer.invoke('http-request', url, opts),
  capturePage: (url, opts) => ipcRenderer.invoke('capture-page', url, opts),
  readImage: (filePath) => ipcRenderer.invoke('read-image', filePath),
  saveAttachmentImage: (dataUrl, nome) => ipcRenderer.invoke('save-attachment-image', dataUrl, nome),
  executeCommand: (command, cwd, opts) => ipcRenderer.invoke('execute-command', command, cwd, opts),
  readProcessOutput: (pid) => ipcRenderer.invoke('read-process-output', pid),
  waitForProcess: (pid, timeoutMs) => ipcRenderer.invoke('wait-for-process', pid, timeoutMs),
  listProcesses: () => ipcRenderer.invoke('list-processes'),
  stopProcess: (pid) => ipcRenderer.invoke('stop-process', pid),
  clearFinishedProcesses: () => ipcRenderer.invoke('clear-finished-processes'),
  getAppInfo: () => ipcRenderer.invoke('get-app-info'),
  checkUpdate: () => ipcRenderer.invoke('check-update'),
  providerConsumption: (connection, period) => ipcRenderer.invoke('provider-consumption', connection, period),
  recordUsage: (connection, usage) => ipcRenderer.invoke('record-usage', connection, usage),
  remoteStatus: () => ipcRenderer.invoke('remote-status'),
  remotePair: (server, code, name) => ipcRenderer.invoke('remote-pair', server, code, name),
  remoteEnable: (enabled, forget) => ipcRenderer.invoke('remote-enable', enabled, forget),
  remotePublish: (snapshot) => ipcRenderer.send('remote-snapshot', snapshot),
  remoteResult: (id, ok) => ipcRenderer.send('remote-result', id, ok),
  onRemoteCommand: (fn) => { const listener = (_event, value) => fn(value); ipcRenderer.on('remote-command', listener); return () => ipcRenderer.removeListener('remote-command', listener); },
  onRemoteStatus: (fn) => { const listener = (_event, value) => fn(value); ipcRenderer.on('remote-status', listener); return () => ipcRenderer.removeListener('remote-status', listener); },
  webSearch: (query, maxResults) => ipcRenderer.invoke('web-search', query, maxResults),
  fetchUrl: (url, maxChars) => ipcRenderer.invoke('fetch-url', url, maxChars),
  loadStore: () => ipcRenderer.invoke('load-store'),
  saveStore: (data) => ipcRenderer.invoke('save-store', data),
  setTitle: (title) => ipcRenderer.send('set-title', title)
};

contextBridge.exposeInMainWorld('electronAPI', api);
