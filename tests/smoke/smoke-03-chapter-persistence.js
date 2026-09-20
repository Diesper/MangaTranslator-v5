/**
 * smoke-03-chapter-persistence.js
 * Cobre: 10 gravações concorrentes pelo caminho real;
 * mapa de restauração por assetId; cache hit gerando restore.
 */
'use strict';

const assert = require('assert');
require('fake-indexeddb/auto');

global.chrome = {
    storage: {
        local: {
            get: () => Promise.resolve({}),
            set: () => Promise.resolve(),
            remove: () => Promise.resolve(),
        }
    }
};

const sm = require('../../extension/storage-manager.js');

async function run() {
    const chapterId = 'smoke03_concurrency_chapter';
    const sampleDataUrl = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

    console.log('[smoke-03] 1. Disparando 10 gravações concorrentes no mesmo capítulo...');
    const saves = Array.from({ length: 10 }, (_, i) => {
        return sm.savePageResult(
            chapterId,
            i,
            sampleDataUrl,
            `https://site.com/orig/page_${i}.jpg`,
            `https://site.com/clean/page_${i}.jpg`,
            { host: 'site.com', width: 800, height: 1200, index: i }
        );
    });

    const results = await Promise.all(saves);
    assert.strictEqual(results.length, 10, 'Deve concluir as 10 operações');

    console.log('[smoke-03] 2. Verificando sobrevivência das 10 páginas (fim do bug read-modify-write)...');
    const pages = await sm.getChapterPageIndex(chapterId);
    assert.strictEqual(pages.length, 10, `Esperado 10 páginas salvas, obtido ${pages.length}`);
    for (let i = 0; i < 10; i++) {
        assert(pages.some(p => p.pageIndex === i), `Página ${i} deve existir`);
    }
    console.log('  -> 10 de 10 páginas sobreviveram à concorrência');

    console.log('[smoke-03] 3. Verificando mapa de restauração com assetId...');
    const restoreIndex = await sm.getRestoreIndex(chapterId);
    for (let i = 0; i < 10; i++) {
        const cleanUrl = `https://site.com/clean/page_${i}.jpg`;
        const entry = restoreIndex[cleanUrl];
        assert(entry, `Entrada de restauração para ${cleanUrl} deve existir`);
        assert(entry.assetId, 'Entrada de restauração deve conter assetId');
        assert.strictEqual(entry.index, i);
    }
    console.log('  -> Mapa de restauração consistente');

    console.log('[smoke-03] 4. Testando cache hit gerando entrada de restauração...');
    const hitCleanUrl = 'https://site.com/clean/cache_hit_page.jpg';
    await sm.savePageResult(chapterId, 15, sampleDataUrl, 'orig_hit', hitCleanUrl, { host: 'site.com', index: 15 });
    const restoreEntries = await sm.listRestoreEntries([chapterId]);
    const hitRestore = restoreEntries.find(e => e.cleanUrl === hitCleanUrl);
    assert(hitRestore, 'Cache hit deve gerar entrada de restauração correspondente');
    assert(hitRestore.assetId, 'Cache hit deve referenciar assetId');
    console.log('  -> Cache hit gerando restore OK');

    console.log('✅ smoke-03-chapter-persistence passou com sucesso.');
}

run().catch(err => {
    console.error('❌ Falha em smoke-03-chapter-persistence:', err);
    process.exit(1);
});
