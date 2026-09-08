const { spawn } = require('node:child_process');
// O wrapper espera o executável GUI também no Windows e propaga falhas ao npm.
const child = spawn(require('electron'), ['scripts/test-electron.cjs'], { stdio: 'inherit', windowsHide: true });
child.on('error', err => { console.error(err.message); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code ?? 1; });
