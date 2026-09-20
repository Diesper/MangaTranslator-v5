const path = require('path');
const ROUTER_PATH = path.resolve(__dirname, '../../../extension/background/router.js');
const ACTION_PATH = path.resolve(__dirname, '../../../extension/background/actions/deliver-result.js');
function loadRouter() { global.self = global; global.chrome = { runtime: { id: 'test-extension-id' } }; delete global.MangaTranslatorRouter; jest.isolateModules(() => { require(ROUTER_PATH); require(ACTION_PATH); }); return global.MangaTranslatorRouter; }
function dispatch(listener, request, sender) { return new Promise(resolve => { let keepAlive; keepAlive = listener(request, sender, response => resolve({ keepAlive, response })); }); }
describe('background/actions/deliver-result.js', () => {
    afterEach(() => delete global.MangaTranslatorRouter);
    test('entrega resultado somente depois de reidratar e validar ownership', async () => {
        const router = loadRouter(); const deliverResultToManga = jest.fn(); const ensureInitialized = jest.fn().mockResolvedValue();
        const result = await dispatch(router.createMessageRouter({ contextFactory: () => ({ state: { currentBatchId: 'batch-1' }, ensureInitialized, deliverResultToManga, finalizeJob: jest.fn(), assertJobOwnership: (_sender, _jobId, callback) => callback(true) }) }), { action: 'GEMINI_IMAGE_EXTRACTED', mangaTabId: 31, index: 4, src: 'data:image/png;base64,AA', jobId: 'job-4', batchId: 'batch-1' }, { tab: { id: 17, url: 'https://gemini.google.com/app' } });
        expect(ensureInitialized).toHaveBeenCalledTimes(1);
        expect(deliverResultToManga).toHaveBeenCalledWith(expect.objectContaining({ geminiTabId: 17, jobId: 'job-4' }));
        expect(result).toEqual({ keepAlive: true, response: { ok: true } });
    });
    test('rejeita payload sem imagem antes de executar efeitos', async () => {
        const router = loadRouter(); const result = await dispatch(router.createMessageRouter({}), { action: 'GEMINI_IMAGE_EXTRACTED', mangaTabId: 31 }, { tab: { id: 17, url: 'https://gemini.google.com/app' } });
        expect(result).toEqual({ keepAlive: undefined, response: { ok: false, error: { code: 'INVALID_PAYLOAD', message: 'src da imagem é obrigatório' } } });
    });
    test('não finaliza job de outro remetente mesmo para batch obsoleto', async () => {
        const router = loadRouter(); const finalizeJob = jest.fn(); const deliverResultToManga = jest.fn();
        const result = await dispatch(router.createMessageRouter({ contextFactory: () => ({ state: { currentBatchId: 'batch-atual' }, ensureInitialized: jest.fn().mockResolvedValue(), deliverResultToManga, finalizeJob, log: jest.fn(), assertJobOwnership: (_sender, _jobId, callback) => callback(false) }) }), { action: 'GEMINI_IMAGE_EXTRACTED', mangaTabId: 31, src: 'data:image/png;base64,AA', jobId: 'job-de-outra-aba', batchId: 'batch-antigo' }, { tab: { id: 17, url: 'https://gemini.google.com/app' } });
        expect(result).toEqual({ keepAlive: true, response: { ok: false, reason: 'sender_mismatch' } });
        expect(finalizeJob).not.toHaveBeenCalled();
        expect(deliverResultToManga).not.toHaveBeenCalled();
    });
});
