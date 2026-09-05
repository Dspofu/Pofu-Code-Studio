"use strict";
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026-present the Pofuserver Coder Studio authors. All rights reserved.
// Licensed under the Apache License, Version 2.0. See /LICENSE and /NOTICE.
// Source: https://github.com/Dspofu/Pofuserver-Code
Object.defineProperty(exports, "__esModule", { value: true });
// Arquivo .cts (e não .ts): o Electron carrega o script de preload com o loader CommonJS
// dele, mas o package.json declara "type": "module" — sem a extensão .cts o compilador
// emitiria `import` aqui e a ponte morreria antes de expor qualquer coisa, deixando a
// janela sem `window.electronAPI`. A extensão trava o formato de saída em CJS.
const electron_1 = require("electron");
const api = {
    selectFolder: () => electron_1.ipcRenderer.invoke('select-folder'),
    listFiles: (dirPath) => electron_1.ipcRenderer.invoke('list-files', dirPath),
    listTree: (rootPath) => electron_1.ipcRenderer.invoke('list-tree', rootPath),
    readFile: (filePath, opts) => electron_1.ipcRenderer.invoke('read-file', filePath, opts),
    writeFile: (filePath, content, opts) => electron_1.ipcRenderer.invoke('write-file', filePath, content, opts),
    editFile: (filePath, oldText, newText, replaceAll) => electron_1.ipcRenderer.invoke('edit-file', filePath, oldText, newText, replaceAll),
    searchFiles: (rootPath, opts) => electron_1.ipcRenderer.invoke('search-files', rootPath, opts),
    createDirectory: (dirPath) => electron_1.ipcRenderer.invoke('create-directory', dirPath),
    deleteFile: (filePath, opts) => electron_1.ipcRenderer.invoke('delete-file', filePath, opts),
    undoChange: (snapshotId) => electron_1.ipcRenderer.invoke('undo-change', snapshotId),
    getDiff: (snapshotId) => electron_1.ipcRenderer.invoke('get-diff', snapshotId),
    httpRequest: (url, opts) => electron_1.ipcRenderer.invoke('http-request', url, opts),
    capturePage: (url, opts) => electron_1.ipcRenderer.invoke('capture-page', url, opts),
    readImage: (filePath) => electron_1.ipcRenderer.invoke('read-image', filePath),
    executeCommand: (command, cwd, opts) => electron_1.ipcRenderer.invoke('execute-command', command, cwd, opts),
    readProcessOutput: (pid) => electron_1.ipcRenderer.invoke('read-process-output', pid),
    waitForProcess: (pid, timeoutMs) => electron_1.ipcRenderer.invoke('wait-for-process', pid, timeoutMs),
    listProcesses: () => electron_1.ipcRenderer.invoke('list-processes'),
    stopProcess: (pid) => electron_1.ipcRenderer.invoke('stop-process', pid),
    clearFinishedProcesses: () => electron_1.ipcRenderer.invoke('clear-finished-processes'),
    getAppInfo: () => electron_1.ipcRenderer.invoke('get-app-info'),
    webSearch: (query, maxResults) => electron_1.ipcRenderer.invoke('web-search', query, maxResults),
    fetchUrl: (url, maxChars) => electron_1.ipcRenderer.invoke('fetch-url', url, maxChars),
    loadStore: () => electron_1.ipcRenderer.invoke('load-store'),
    saveStore: (data) => electron_1.ipcRenderer.invoke('save-store', data),
    setTitle: (title) => electron_1.ipcRenderer.send('set-title', title)
};
electron_1.contextBridge.exposeInMainWorld('electronAPI', api);
//# sourceMappingURL=preload.cjs.map