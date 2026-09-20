const path = require('path');
const ROUTER_PATH = path.resolve(__dirname, '../../../extension/background/router.js');
const ACTION_PATH = path.resolve(__dirname, '../../../extension/background/actions/deliver-result-url.js');

function loadRouter() {
    global.self = global;
    global.chrome = { runtime: { id: 'test-extension-id' }, tabs: { create: jest.fn() } };
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

describe('background/actions/deliver-result-url.js', () => {
    afterEach(() => delete global.MangaTranslatorRouter);

    test('cria aba de extração e preserva a identidade do job', async () => {
        const router = loadRouter();
        chrome.tabs.create.mockImplementation((_options, callback) => callback({ id: 81 }));
        const state = { extractionTabs: {} };
        const syncState = jest.fn().mockResolvedValue();
        const result = await dispatch(router.createMessageRouter({ contextFactory: () => ({
            state,
            syncState,
            ensureInitialized: jest.fn().mockResolvedValue(),
            assertJobOwnership: (_sender, _jobId, callback) => callback(true),
        }) }), {
            action: 'GEMINI_RESULT_URL', mangaTabId: 33, index: 4, url: 'https://cdn.example/result.png', jobId: 'job-4', batchId: 'batch-1',
        }, { tab: { id: 17, url: 'https://gemini.google.com/app' } });

        expect(chrome.tabs.create).toHaveBeenCalledWith({ url: 'https://cdn.example/result.png', active: false }, expect.any(Function));
        expect(state.extractionTabs[81]).toEqual({ mangaTabId: 33, index: 4, geminiTabId: 17, jobId: 'job-4', batchId: 'batch-1' });
        expect(syncState).toHaveBeenCalledTimes(1);
        expect(result).toEqual({ keepAlive: true, response: { ok: true } });
    });

    test('rejeita job de uma aba que não o possui', async () => {
        const router = loadRouter();
        const result = await dispatch(router.createMessageRouter({ contextFactory: () => ({
            state: { extractionTabs: {} }, syncState: jest.fn(), ensureInitialized: jest.fn().mockResolvedValue(),
            assertJobOwnership: (_sender, _jobId, callback) => callback(false),
        }) }), {
            action: 'GEMINI_RESULT_URL', mangaTabId: 33, index: 4, url: 'https://cdn.example/result.png', jobId: 'job-4',
        }, { tab: { id: 18, url: 'https://gemini.google.com/app' } });

        expect(chrome.tabs.create).not.toHaveBeenCalled();
        expect(result).toEqual({ keepAlive: true, response: { ok: false, reason: 'sender_mismatch' } });
    });

    test.each([
        [{ action: 'GEMINI_RESULT_URL', mangaTabId: 33, index: 4, url: 'https://cdn.example/result.png' }, 'jobId é obrigatório'],
        [{ action: 'GEMINI_RESULT_URL', mangaTabId: 33, index: 4, url: 'javascript:alert(1)', jobId: 'job-4' }, 'url de resultado inválida'],
    ])('rejeita payload inválido antes de abrir a aba', async (request, message) => {
        const router = loadRouter();
        const ensureInitialized = jest.fn();
        const result = await dispatch(router.createMessageRouter({ contextFactory: () => ({
            state: { extractionTabs: {} }, syncState: jest.fn(), ensureInitialized,
            assertJobOwnership: jest.fn(),
        }) }), request, { tab: { id: 17, url: 'https://gemini.google.com/app' } });

        expect(ensureInitialized).not.toHaveBeenCalled();
        expect(chrome.tabs.create).not.toHaveBeenCalled();
        expect(result.response).toEqual({ ok: false, error: { code: 'INVALID_PAYLOAD', message } });
    });
});
