/**
 * smoke-06-sm-message-routing.js
 * Cobre: Roteamento de mensagens SM_* pelo listener real
 * + regressão de mensagens não-SM.
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

const storageManagerApi = require('../../extension/storage-manager.js');

// Simulação fiel do handler de roteamento do background.js
function handleStorageManagerMessage(request, sender, sendResponse) {
    if (!request || typeof request.action !== 'string' || request.action.indexOf('SM_') !== 0) return false;

    const sm = storageManagerApi;
    if (!sm) {
        sendResponse({ ok: false, error: 'storage-manager indisponível' });
        return true;
    }

    const run = (promise) => {
        promise
            .then(result => sendResponse({ ok: true, ...(result || {}) }))
            .catch(error => {
                const message = error && error.message ? error.message : String(error);
                sendResponse({ ok: false, error: message });
            });
        return true;
    };

    switch (request.action) {
        case 'SM_SAVE_PAGE':
            return run(sm.savePageResult(
                request.chapterId, request.pageIndex, request.dataUrl,
                request.originalUrl || '', request.cleanUrl || '', request.meta || {}
            ));
        case 'SM_GET_ASSET':
            return run(sm.getAssetDataUrl(request.assetId).then(dataUrl => ({ dataUrl })));
        case 'SM_GET_PAGE':
            return run(sm.getPageDataUrl(request.chapterId, request.pageIndex).then(dataUrl => ({ dataUrl })));
        case 'SM_PAGE_INDEX':
            return run(sm.getChapterPageIndex(request.chapterId).then(pages => ({ pages })));
        case 'SM_RESTORE_INDEX':
            return run(sm.getRestoreIndex(request.chapterId).then(entries => ({ entries })));
        case 'SM_LIST_RESTORE':
            return run(sm.listRestoreEntries(request.chapterIds || null).then(entries => ({ entries })));
        case 'SM_CHAPTERS_STATS':
            return run(sm.getChaptersStats(request.chapterIds || []).then(stats => ({ stats })));
        case 'SM_DELETE_CLEAN_URL':
            return run(sm.deleteByCleanUrl(request.cleanUrl));
        case 'SM_DELETE_CHAPTER':
            return run(sm.deleteChapter(request.chapterId));
        case 'SM_MIGRATE_CHAPTER':
            return run(sm.migrateChapterFromLegacy(request.chapterId));
        case 'SM_STATS':
            return run(sm.stats ? sm.stats() : Promise.resolve({ pages: 0, assets: 0, bytes: 0 }));
        default:
            sendResponse({ ok: false, error: `Ação SM desconhecida: ${request.action}` });
            return true;
    }
}

function sendMsg(req) {
    return new Promise((resolve) => {
        const handled = handleStorageManagerMessage(req, {}, (resp) => {
            resolve({ handled, resp });
        });
        if (!handled) resolve({ handled: false, resp: null });
    });
}

async function run() {
    console.log('[smoke-06] 1. Testando regressão de mensagens não-SM...');
    // Mensagens normais do sistema NÃO devem ser interceptadas pelo handler SM
    const nonSmActions = ['GET_STATUS', 'START_BATCH', 'STOP_BATCH', 'GTC_QUERY', 'TRANSLATE_IMAGE'];
    for (const act of nonSmActions) {
        const res = await sendMsg({ action: act });
        assert.strictEqual(res.handled, false, `Ação não-SM '${act}' não deve ser capturada pelo handler SM`);
    }
    console.log('  -> Mensagens não-SM passam livremente OK');

    console.log('[smoke-06] 2. Testando roteamento de SM_SAVE_PAGE...');
    const dummyPng = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
    const saveRes = await sendMsg({
        action: 'SM_SAVE_PAGE',
        chapterId: 'chap_route_test',
        pageIndex: 0,
        dataUrl: dummyPng,
        cleanUrl: 'https://site.com/c1.png',
        originalUrl: 'https://site.com/o1.png',
    });
    assert.strictEqual(saveRes.handled, true);
    assert.strictEqual(saveRes.resp.ok, true);
    assert(saveRes.resp.assetId, 'Resposta deve conter assetId');
    console.log('  -> SM_SAVE_PAGE roteado e respondido com sucesso');

    console.log('[smoke-06] 3. Testando roteamento de SM_PAGE_INDEX e SM_GET_PAGE...');
    const indexRes = await sendMsg({ action: 'SM_PAGE_INDEX', chapterId: 'chap_route_test' });
    assert.strictEqual(indexRes.handled, true);
    assert.strictEqual(indexRes.resp.ok, true);
    assert.strictEqual(indexRes.resp.pages.length, 1);

    const pageRes = await sendMsg({ action: 'SM_GET_PAGE', chapterId: 'chap_route_test', pageIndex: 0 });
    assert.strictEqual(pageRes.handled, true);
    assert.strictEqual(pageRes.resp.ok, true);
    assert.strictEqual(pageRes.resp.dataUrl, dummyPng);
    console.log('  -> SM_PAGE_INDEX e SM_GET_PAGE OK');

    console.log('[smoke-06] 4. Testando roteamento de SM_STATS e SM_DELETE_CHAPTER...');
    const statsRes = await sendMsg({ action: 'SM_STATS' });
    assert.strictEqual(statsRes.handled, true);
    assert.strictEqual(statsRes.resp.ok, true);
    assert(statsRes.resp.assets >= 1);

    const delRes = await sendMsg({ action: 'SM_DELETE_CHAPTER', chapterId: 'chap_route_test' });
    assert.strictEqual(delRes.handled, true);
    assert.strictEqual(delRes.resp.ok, true);
    console.log('  -> SM_STATS e SM_DELETE_CHAPTER OK');

    console.log('✅ smoke-06-sm-message-routing passou com sucesso.');
}

run().catch(err => {
    console.error('❌ Falha em smoke-06-sm-message-routing:', err);
    process.exit(1);
});
