const path = require('path');
const ROUTER_PATH = path.resolve(__dirname, '../../../extension/background/router.js');
const ACTION_PATH = path.resolve(__dirname, '../../../extension/background/actions/export-all.js');

function loadRouter() {
    global.self = global;
    global.chrome = {
        runtime: { id: 'test-extension-id', lastError: null },
        downloads: { download: jest.fn(), show: jest.fn() },
    };
    delete global.MangaTranslatorRouter;
    jest.isolateModules(() => { require(ROUTER_PATH); require(ACTION_PATH); });
    return global.MangaTranslatorRouter;
}

function dispatch(listener, request, contextFactory) {
    return new Promise(resolve => {
        let keepAlive;
        keepAlive = listener(request, { tab: { id: 2, url: 'https://reader.example/chapter' } }, response => {
            resolve({ keepAlive, response });
        });
    });
}

describe('background/actions/export-all.js', () => {
    afterEach(() => delete global.MangaTranslatorRouter);

    test('confirma sem download quando não há páginas', async () => {
        const router = loadRouter();
        const result = await dispatch(router.createMessageRouter({}), { action: 'EXPORT_ALL_AND_SHOW', allDownloads: [] });
        expect(chrome.downloads.download).not.toHaveBeenCalled();
        expect(result).toEqual({ keepAlive: true, response: { ok: true } });
    });

    test('prefixa arquivos e abre o último download concluído', async () => {
        const router = loadRouter();
        chrome.downloads.download
            .mockImplementationOnce((_options, callback) => callback(11))
            .mockImplementationOnce((_options, callback) => callback(12));
        const waitForDownload = jest.fn((id, done) => done(id));
        const result = await dispatch(router.createMessageRouter({ contextFactory: () => ({ waitForDownload }) }), {
            action: 'EXPORT_ALL_AND_SHOW',
            allDownloads: [
                { url: 'data:image/png;base64,AA', filename: 'one.png' },
                { url: 'data:image/png;base64,BB', filename: 'MangaTranslator/two.png' },
            ],
        });
        expect(chrome.downloads.download).toHaveBeenNthCalledWith(1, expect.objectContaining({ filename: 'MangaTranslator/one.png' }), expect.any(Function));
        expect(chrome.downloads.download).toHaveBeenNthCalledWith(2, expect.objectContaining({ filename: 'MangaTranslator/two.png' }), expect.any(Function));
        expect(chrome.downloads.show).toHaveBeenCalledWith(12);
        expect(result).toEqual({ keepAlive: true, response: { ok: true } });
    });
});
