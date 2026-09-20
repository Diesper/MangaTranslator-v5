// Roda todos os testes de fumaça em sequência e resume o resultado.
const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const files = fs.readdirSync(__dirname)
    .filter(f => /^smoke-\d+/.test(f))
    .sort();

let failed = 0;
for (const f of files) {
    console.log(`\n=== ${f} ===`);
    const r = spawnSync(process.execPath, [path.join(__dirname, f)], { stdio: 'inherit' });
    if (r.status !== 0) failed++;
}
console.log(failed === 0 ? `\n✅ ${files.length} arquivo(s), todos passaram.` : `\n❌ ${failed} de ${files.length} arquivo(s) com falha.`);
process.exit(failed === 0 ? 0 : 1);
