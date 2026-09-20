const path = require('path');
const ROUTER_PATH = path.resolve(__dirname, '../../../extension/background/router.js');
const ACTION_PATH = path.resolve(__dirname, '../../../extension/background/actions/deliver-result-from-tab.js');

function loadRouter() {
    global.self = global;
    global.chrome = { runtime: { id: 'test-extension-id', lastError: null }, tabs: { remove: jest.fn((_id, callback) => callback()) } };
    delete global.MangaTranslatorRouter;
    jest.isolateModules(() => { require(ROUTER_PATH); require(ACTION_PATH); });
    return global.MangaTranslatorRouter;
}

function dispatch(listener, request, sender) {
    return new Promise(resolve => {
        let keepAlive;
        keepAlive = listener(request, sender, response => resolve({ keepAlive, response }));
    });
}

describe('background/actions/deliver-result-from-tab.js', () => {
    afterEach(() => delete global.MangaTranslatorRouter);

    test('usa o mapeamento temporário, remove a aba e entrega o resultado', async () => {
        const router = loadRouter();
        const state = { currentBatchId: 'batch-1', extractionTabs: { 82: { mangaTabId: 33, index: 4, geminiTabId: 17, jobId: 'job-4', batchId: 'batch-1' } } };
        const deliverResultToManga = jest.fn();
        const syncState = jest.fn().mockResolvedValue();
        const result = await dispatch(router.createMessageRouter({ contextFactory: () => ({
            state, syncState, ensureInitialized: jest.fn().mockResolvedValue(), deliverResultToManga,
            assertJobOwnership: (_sender, _jobId, callback) => callback(true), finalizeJob: jest.fn(),
        }) }), { action: 'IMAGE_READY_FROM_NEW_TAB', src: 'data:image/png;base64,AA', jobId: 'job-4' }, { tab: { id: 82, url: 'https://cdn.example/result.png' } });

        expect(chrome.tabs.remove).toHaveBeenCalledWith(82, expect.any(Function));
        expect(state.extractionTabs[82]).toBeUndefined();
        expect(deliverResultToManga).toHaveBeenCalledWith(expect.objectContaining({ mangaTabId: 33, index: 4, geminiTabId: 17, jobId: 'job-4' }));
        expect(result).toEqual({ keepAlive: true, response: { ok: true } });
    });

    test('rejeita lote obsoleto sem entregar a imagem', async () => {
        const router = loadRouter();
        const finalizeJob = jest.fn();
        const result = await dispatch(router.createMessageRouter({ contextFactory: () => ({
            state: { currentBatchId: 'batch-current', extractionTabs: { 83: { mangaTabId: 33, index: 4, geminiTabId: 17, jobId: 'job-4', batchId: 'batch-old' } } },
            syncState: jest.fn().mockResolvedValue(), ensureInitialized: jest.fn().mockResolvedValue(),
            deliverResultToManga: jest.fn(), assertJobOwnership: (_sender, _jobId, callback) => callback(true), finalizeJob,
        }) }), { action: 'IMAGE_READY_FROM_NEW_TAB', src: 'data:image/png;base64,AA', jobId: 'job-4' }, { tab: { id: 83, url: 'https://cdn.example/result.png' } });

        expect(finalizeJob).toHaveBeenCalledWith(17, 33, true);
        expect(result).toEqual({ keepAlive: true, response: { ok: false, reason: 'stale_batch' } });
    });

    test('rejeita job diferente do mapeamento sem remover ou finalizar a aba', async () => {
        const router = loadRouter();
        const finalizeJob = jest.fn();
        const syncState = jest.fn();
        const result = await dispatch(router.createMessageRouter({ contextFactory: () => ({
            state: { extractionTabs: { 82: { mangaTabId: 33, index: 4, geminiTabId: 17, jobId: 'job-4', batchId: 'batch-1' } } },
            syncState, ensureInitialized: jest.fn().mockResolvedValue(), deliverResultToManga: jest.fn(),
            assertJobOwnership: jest.fn(), finalizeJob,
        }) }), { action: 'IMAGE_READY_FROM_NEW_TAB', src: 'data:image/png;base64,AA', jobId: 'job-forjado', geminiTabId: 99 }, { tab: { id: 82, url: 'https://cdn.example/result.png' } });

        expect(chrome.tabs.remove).not.toHaveBeenCalled();
        expect(syncState).not.toHaveBeenCalled();
        expect(finalizeJob).not.toHaveBeenCalled();
        expect(result).toEqual({ keepAlive: true, response: { ok: false, reason: 'sender_mismatch' } });
    });

    test.each([
        [{ action: 'IMAGE_READY_FROM_NEW_TAB', src: 'data:image/png;base64,AA' }, 'jobId é obrigatório'],
        [{ action: 'IMAGE_READY_FROM_NEW_TAB', src: 'https://cdn.example/result.png', jobId: 'job-4' }, 'src de resultado inválido'],
    ])('rejeita payload inválido antes de reidratar', async (request, message) => {
        const router = loadRouter();
        const ensureInitialized = jest.fn();
        const result = await dispatch(router.createMessageRouter({ contextFactory: () => ({
            state: { extractionTabs: {} }, ensureInitialized, syncState: jest.fn(),
            assertJobOwnership: jest.fn(), finalizeJob: jest.fn(), deliverResultToManga: jest.fn(),
        }) }), request, { tab: { id: 82, url: 'https://cdn.example/result.png' } });

        expect(ensureInitialized).not.toHaveBeenCalled();
        expect(chrome.tabs.remove).not.toHaveBeenCalled();
        expect(result.response).toEqual({ ok: false, error: { code: 'INVALID_PAYLOAD', message } });
    });
});
