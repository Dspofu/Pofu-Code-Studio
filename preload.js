// SPDX-License-Identifier: Apache-2.0
// Copyright 2026-present the Pofuserver Coder Studio authors. All rights reserved.
// Licensed under the Apache License, Version 2.0. See /LICENSE and /NOTICE.
// Source: https://github.com/Dspofu/Pofuserver-Code

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  selectFolder: () => ipcRenderer.invoke('select-folder'),
  listFiles: (dirPath) => ipcRenderer.invoke('list-files', dirPath),
  listTree: (rootPath) => ipcRenderer.invoke('list-tree', rootPath),
  readFile: (filePath, opts) => ipcRenderer.invoke('read-file', filePath, opts),
  writeFile: (filePath, content, opts) => ipcRenderer.invoke('write-file', filePath, content, opts),
  editFile: (filePath, oldText, newText, replaceAll) => ipcRenderer.invoke('edit-file', filePath, oldText, newText, replaceAll),
  searchFiles: (rootPath, opts) => ipcRenderer.invoke('search-files', rootPath, opts),
  createDirectory: (dirPath) => ipcRenderer.invoke('create-directory', dirPath),
  deleteFile: (filePath, opts) => ipcRenderer.invoke('delete-file', filePath, opts),
  undoChange: (snapshotId) => ipcRenderer.invoke('undo-change', snapshotId),
  getDiff: (snapshotId) => ipcRenderer.invoke('get-diff', snapshotId),
  httpRequest: (url, opts) => ipcRenderer.invoke('http-request', url, opts),
  capturePage: (url, opts) => ipcRenderer.invoke('capture-page', url, opts),
  readImage: (filePath) => ipcRenderer.invoke('read-image', filePath),
  executeCommand: (command, cwd, opts) => ipcRenderer.invoke('execute-command', command, cwd, opts),
  readProcessOutput: (pid) => ipcRenderer.invoke('read-process-output', pid),
  waitForProcess: (pid, timeoutMs) => ipcRenderer.invoke('wait-for-process', pid, timeoutMs),
  listProcesses: () => ipcRenderer.invoke('list-processes'),
  stopProcess: (pid) => ipcRenderer.invoke('stop-process', pid),
  clearFinishedProcesses: () => ipcRenderer.invoke('clear-finished-processes'),
  getAppInfo: () => ipcRenderer.invoke('get-app-info'),
  webSearch: (query, maxResults) => ipcRenderer.invoke('web-search', query, maxResults),
  fetchUrl: (url, maxChars) => ipcRenderer.invoke('fetch-url', url, maxChars),
  loadStore: () => ipcRenderer.invoke('load-store'),
  saveStore: (data) => ipcRenderer.invoke('save-store', data),
  setTitle: (title) => ipcRenderer.send('set-title', title)
});