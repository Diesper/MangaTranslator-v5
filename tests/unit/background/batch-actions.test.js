const path = require('path');

const ROUTER_PATH = path.resolve(__dirname, '../../../extension/background/router.js');
const START_ACTION_PATH = path.resolve(__dirname, '../../../extension/background/actions/start-batch.js');
const STOP_ACTION_PATH = path.resolve(__dirname, '../../../extension/background/actions/stop-batch.js');

function loadRouter() {
    global.self = global;
    global.chrome = { runtime: { id: 'test-extension-id' } };
    delete global.MangaTranslatorRouter;
    jest.isolateModules(() => {
        require(ROUTER_PATH);
        require(START_ACTION_PATH);
        require(STOP_ACTION_PATH);
    });
    return global.MangaTranslatorRouter;
}

function dispatch(listener, request, sender) {
    return new Promise(resolve => {
        let keepAlive;
        keepAlive = listener(request, sender, response => resolve({ keepAlive, response }));
    });
}

describe('background/actions batch', () => {
    afterEach(() => delete global.MangaTranslatorRouter);

    test('START_BATCH delega para lifecycle reidratado e valida índices', async () => {
        const router = loadRouter();
        const startBatch = jest.fn().mockResolvedValue({ batchId: 'batch-1' });
        const listener = router.createMessageRouter({ contextFactory: () => ({ startBatch }) });
        const sender = { tab: { id: 17, url: 'https://reader.test/chapter' } };

        const success = await dispatch(listener, {
            action: 'START_BATCH', images: [{ index: 2 }], prompt: 'Traduzir', mangaTabId: 17,
        }, sender);
        expect(success).toEqual({ keepAlive: true, response: { ok: true, batchId: 'batch-1' } });
        expect(startBatch).toHaveBeenCalledWith(expect.objectContaining({ images: [{ index: 2 }] }), sender);

        const invalid = await dispatch(listener, { action: 'START_BATCH', images: [{ index: '2' }] }, sender);
        expect(invalid.response).toEqual({ ok: false, error: expect.objectContaining({ code: 'INVALID_PAYLOAD' }) });
    });

    test('STOP_BATCH delega o batch alvo sem aceitar identificador inválido', async () => {
        const router = loadRouter();
        const stopBatch = jest.fn().mockResolvedValue({});
        const listener = router.createMessageRouter({ contextFactory: () => ({ stopBatch }) });
        const sender = { tab: { id: 17, url: 'https://reader.test/chapter' } };

        const success = await dispatch(listener, { action: 'STOP_BATCH', batchId: 'batch-a' }, sender);
        expect(success).toEqual({ keepAlive: true, response: { ok: true } });
        expect(stopBatch).toHaveBeenCalledWith({ action: 'STOP_BATCH', batchId: 'batch-a' });

        const invalid = await dispatch(listener, { action: 'STOP_BATCH', batchId: 4 }, sender);
        expect(invalid.response).toEqual({ ok: false, error: expect.objectContaining({ code: 'INVALID_PAYLOAD' }) });
    });
});
