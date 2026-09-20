/**
 * smoke-04-storage-manager.js
 * Cobre: Transações atômicas, round-trip Blob↔DataURL, assets órfãos,
 * deleteByCleanUrl, deleteChapter, migração idempotente.
 */
'use strict';

const assert = require('assert');
require('fake-indexeddb/auto');

// Mock mínimo do chrome.storage.local para testes do storage-manager
const localStore = {};
global.chrome = {
    storage: {
        local: {
            get: (keys, cb) => {
                const res = {};
                if (typeof keys === 'string') res[keys] = localStore[keys];
                else if (Array.isArray(keys)) keys.forEach(k => { if (k in localStore) res[k] = localStore[k]; });
                else if (keys === null) Object.assign(res, localStore);
                if (cb) cb(res);
                return Promise.resolve(res);
            },
            set: (items, cb) => {
                Object.assign(localStore, items);
                if (cb) cb();
                return Promise.resolve();
            },
            remove: (keys, cb) => {
                const arr = Array.isArray(keys) ? keys : [keys];
                arr.forEach(k => delete localStore[k]);
                if (cb) cb();
                return Promise.resolve();
            }
        }
    }
};

const sm = require('../../extension/storage-manager.js');

async function run() {
    console.log('[smoke-04] 1. Testando round-trip DataURL <-> Blob...');
    // 1x1 pixel PNG em base64
    const sampleDataUrl = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
    const blob = sm.dataUrlToBlob(sampleDataUrl);
    assert.strictEqual(blob.type, 'image/png');
    assert(blob.size > 0);

    const convertedBack = await sm.blobToDataUrl(blob);
    assert.strictEqual(convertedBack, sampleDataUrl);
    console.log('  -> Round-trip Blob <-> DataURL OK');

    console.log('[smoke-04] 2. Testando transações atômicas e eliminação de assets órfãos...');
    const chapterId = 'chap_test_04';
    const cleanUrl = 'https://example.com/clean/img1.png';
    const origUrl = 'https://example.com/orig/img1.png';

    // Grava página 0
    const save1 = await sm.savePageResult(chapterId, 0, sampleDataUrl, origUrl, cleanUrl, { width: 100, height: 200, host: 'example.com' });
    assert(save1.assetId, 'Deve gerar assetId');

    const asset1 = await sm.getAssetBlob(save1.assetId);
    assert(asset1, 'Asset gravado deve existir');

    let pageBlob = await sm.getPageAsset(chapterId, 0);
    assert(pageBlob, 'Page blob deve existir');
    let pages = await sm.getChapterPageIndex(chapterId);
    assert.strictEqual(pages[0].assetId, save1.assetId);

    // Substitui a página 0 com novo conteúdo
    const sampleDataUrl2 = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    const save2 = await sm.savePageResult(chapterId, 0, sampleDataUrl2, origUrl, cleanUrl, { width: 100, height: 200, host: 'example.com' });
    assert.notStrictEqual(save2.assetId, save1.assetId, 'Novo assetId deve ser diferente');

    // Asset antigo deve ter sido removido (sem órfãos)
    const oldAsset = await sm.getAssetBlob(save1.assetId);
    assert.strictEqual(oldAsset, null, 'Asset antigo substituído deve ser limpo');

    const newAsset = await sm.getAssetBlob(save2.assetId);
    assert(newAsset, 'Novo asset deve existir');
    console.log('  -> Substituição atômica e eliminação de órfãos OK');

    console.log('[smoke-04] 3. Testando deleteByCleanUrl...');
    const delCleanRes = await sm.deleteByCleanUrl(cleanUrl);
    assert(delCleanRes.deleted >= 1, 'Deve deletar entrada pelo cleanUrl');
    const restoreIndex = await sm.getRestoreIndex(chapterId);
    assert(!restoreIndex[cleanUrl], 'Restore entry não deve mais existir');
    console.log('  -> deleteByCleanUrl OK');

    console.log('[smoke-04] 4. Testando deleteChapter...');
    // Grava mais uma página
    await sm.savePageResult(chapterId, 1, sampleDataUrl2, 'orig2', 'clean2');
    const delChapterRes = await sm.deleteChapter(chapterId);
    assert(delChapterRes.deleted > 0, 'Deve deletar registros do capítulo');
    const countAfter = await sm.getChapterPageCount(chapterId);
    assert.strictEqual(countAfter, 0, 'Capítulo deve estar vazio');
    console.log('  -> deleteChapter OK');

    console.log('[smoke-04] 5. Testando migração idempotente do storage legado...');
    const legacyChapter = 'chap_legacy_99';
    localStore[`${legacyChapter}_images`] = { '0': sampleDataUrl, '1': sampleDataUrl2 };
    localStore[`${legacyChapter}_restoreMap`] = { 'https://site.com/c0.png': sampleDataUrl };
    localStore[`${legacyChapter}_restoreMeta`] = { 'https://site.com/c0.png': { index: 0, host: 'site.com' } };

    const mig1 = await sm.migrateChapterFromLegacy(legacyChapter);
    assert(mig1.migrated >= 1, 'Deve migrar páginas');
    assert.strictEqual(mig1.skipped, false);
    assert.strictEqual(localStore[`_sm_migrated_${legacyChapter}`], true, 'Flag de migração deve ser setada');
    assert(!localStore[`${legacyChapter}_images`], 'Storage legado deve ser limpo');

    // Segunda execução da migração deve pular (idempotente)
    const mig2 = await sm.migrateChapterFromLegacy(legacyChapter);
    assert.strictEqual(mig2.skipped, true, 'Segunda migração deve ser ignorada');
    console.log('  -> Migração idempotente OK');

    console.log('✅ smoke-04-storage-manager passou com sucesso.');
}

run().catch(err => {
    console.error('❌ Falha em smoke-04-storage-manager:', err);
    process.exit(1);
});
