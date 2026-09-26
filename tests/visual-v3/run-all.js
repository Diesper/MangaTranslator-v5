'use strict';
// run_all.js — Executa todos os suites e aguarda a serial queue de testes async

const ROOT_PACKAGE_VERSION = require('../../package.json').version;
const PRODUCT_VERSION = ROOT_PACKAGE_VERSION.endsWith('.0')
    ? ROOT_PACKAGE_VERSION.slice(0, -2)
    : ROOT_PACKAGE_VERSION;

(async () => {
    console.log('\n' + '═'.repeat(60));
    console.log(`  MangaTranslator v${PRODUCT_VERSION} — Cadeia Completa de Testes`);
    console.log('  visual-v4 · wHash · pHash · Crop · Regional · Cross-Language');
    console.log('  Pipeline 6 fases · CALCULATE_VISUAL_FINGERPRINT · IDB v4');
    console.log('═'.repeat(60));

    // Load all suites — sync tests run immediately, async (ita) enqueue serially
    require('./gtc-fingerprint.visual-v3.js');
    require('./gtc-indexeddb.visual-v3.js');
    require('./background-fingerprint.visual-v3.js');
    require('./content-manga-pipeline.visual-v3.js');
    require('./integration.visual-v3.js');
    require('./visual-v4-crop.visual-v3.js');

    // Await the serial queue (all ita tests)
    const { getAsyncQueue, printSummary } = require('./runner.js');
    await getAsyncQueue();

    const allPassed = printSummary();
    process.exit(allPassed ? 0 : 1);
})();
