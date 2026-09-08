const { spawnSync } = require('node:child_process');
for (const scenario of ['newer', 'equal', 'older', 'invalid', 'prerelease', 'draft', 'offline', 'missing', 'limited']) {
  const result = spawnSync(require('electron'), ['scripts/test-startup.cjs', scenario], { stdio: 'inherit', windowsHide: true, timeout: 30000 });
  if (result.error || result.status !== 0) { console.error(result.error || 'Falha: ' + scenario); process.exit(1); }
}
