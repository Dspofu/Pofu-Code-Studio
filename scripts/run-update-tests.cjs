const { spawn } = require('node:child_process');
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(require('electron'), ['scripts/test-update-electron.cjs'], { stdio: 'inherit', windowsHide: true, env });
child.on('error', err => { console.error(err.message); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code ?? 1; });
