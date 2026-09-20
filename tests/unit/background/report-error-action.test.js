const path = require('path');
const ROUTER_PATH = path.resolve(__dirname, '../../../extension/background/router.js');
const ACTION_PATH = path.resolve(__dirname, '../../../extension/background/actions/report-error.js');

function loadRouter() {
    global.self = global;
    global.chrome = { runtime: { id: 'test-extension-id', lastError: null }, tabs: { sendMessage: jest.fn((_id, _message, callback) => callback()) } };
    delete global.MangaTranslatorRouter;
    jest.isolateModules(() => { require(ROUTER_PATH); require(ACTION_PATH); });
    return global.MangaTranslatorRouter;
}
function dispatch(listener, request, sender) {
    return new Promise(resolve => { let keepAlive; keepAlive = listener(request, sender, response => resolve({ keepAlive, response })); });
}

describe('background/actions/report-error.js', () => {
    afterEach(() => delete global.MangaTranslatorRouter);

    test('encaminha erro e finaliza o job que o reportou', async () => {
        const router = loadRouter();
        const finalizeJob = jest.fn();
        const result = await dispatch(router.createMessageRouter({ contextFactory: () => ({
            state: { currentBatchId: 'batch-1' }, ensureInitialized: jest.fn().mockResolvedValue(), finalizeJob,
            assertJobOwnership: (_sender, _jobId, callback) => callback(true), storage: { get: jest.fn().mockResolvedValue({ debugMode: true }) },
        }) }), { action: 'GEMINI_ERROR', mangaTabId: 31, index: 4, error: 'Falhou', jobId: 'job-4', batchId: 'batch-1' }, { tab: { id: 17, url: 'https://gemini.google.com/app' } });

        expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(31, expect.objectContaining({ action: 'SHOW_ERROR_INTEGRATED', isDebug: true, jobId: 'job-4' }), expect.any(Function));
        expect(finalizeJob).toHaveBeenCalledWith(17, 31, true);
        expect(result).toEqual({ keepAlive: true, response: { ok: true } });
    });

    test('não notifica nem finaliza quando a propriedade do job falha', async () => {
        const router = loadRouter();
        const finalizeJob = jest.fn();
        const result = await dispatch(router.createMessageRouter({ contextFactory: () => ({
            state: {}, ensureInitialized: jest.fn().mockResolvedValue(), finalizeJob,
            assertJobOwnership: (_sender, _jobId, callback) => callback(false), storage: { get: jest.fn() },
        }) }), { action: 'GEMINI_ERROR', mangaTabId: 31, index: 4, error: 'Falhou', jobId: 'job-4' }, { tab: { id: 18, url: 'https://gemini.google.com/app' } });

        expect(chrome.tabs.sendMessage).not.toHaveBeenCalled();
        expect(finalizeJob).not.toHaveBeenCalled();
        expect(result).toEqual({ keepAlive: true, response: { ok: false, reason: 'sender_mismatch' } });
    });

    test.each([
        [{ action: 'GEMINI_ERROR', mangaTabId: 31, index: 4, error: 'Falhou' }, 'jobId é obrigatório'],
        [{ action: 'GEMINI_ERROR', mangaTabId: 31, index: 4, error: '   ', jobId: 'job-4' }, 'erro inválido'],
        [{ action: 'GEMINI_ERROR', mangaTabId: 31, index: 4, error: 'x'.repeat(4097), jobId: 'job-4' }, 'erro inválido'],
    ])('rejeita payload inválido antes de reidratar ou finalizar', async (request, message) => {
        const router = loadRouter();
        const ensureInitialized = jest.fn();
        const finalizeJob = jest.fn();
        const result = await dispatch(router.createMessageRouter({ contextFactory: () => ({
            state: {}, ensureInitialized, finalizeJob, assertJobOwnership: jest.fn(), storage: { get: jest.fn() },
        }) }), request, { tab: { id: 17, url: 'https://gemini.google.com/app' } });

        expect(ensureInitialized).not.toHaveBeenCalled();
        expect(chrome.tabs.sendMessage).not.toHaveBeenCalled();
        expect(finalizeJob).not.toHaveBeenCalled();
        expect(result.response).toEqual({ ok: false, error: { code: 'INVALID_PAYLOAD', message } });
    });
});
