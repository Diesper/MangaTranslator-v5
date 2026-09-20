const path = require('path');

const ROUTER_PATH = path.resolve(__dirname, '../../../extension/background/router.js');
const ACTION_PATH = path.resolve(__dirname, '../../../extension/background/actions/download-image.js');

function dispatch(listener, request) {
    return new Promise(resolve => {
        let keepAlive;
        const sendResponse = response => resolve({ keepAlive, response });
        keepAlive = listener(request, { tab: { id: 7, url: 'https://reader.example/chapter' } }, sendResponse);
    });
}

describe('background/actions/download-image.js', () => {
    beforeEach(() => {
        jest.resetModules();
        global.self = global;
        global.chrome = {
            runtime: { id: 'test-extension-id', lastError: null },
            downloads: {
                download: jest.fn((_options, callback) => callback(41)),
                search: jest.fn((_query, callback) => callback([{ filename: '/downloads/MangaTranslator/page.png' }])),
            },
        };
        delete global.MangaTranslatorRouter;
        jest.isolateModules(() => {
            require(ROUTER_PATH);
            require(ACTION_PATH);
        });
    });

    afterEach(() => {
        delete global.MangaTranslatorRouter;
    });

    test('prefixa o arquivo, aguarda a conclusão e devolve o caminho legado', async () => {
        const waitForDownload = jest.fn((id, done) => done(id));
        const router = global.MangaTranslatorRouter;
        const result = await dispatch(router.createMessageRouter({
            contextFactory: () => ({ waitForDownload }),
        }), { action: 'DOWNLOAD_IMAGE', url: 'data:image/png;base64,AA', filename: 'chapter/page.png' });

        expect(global.chrome.downloads.download).toHaveBeenCalledWith({
            url: 'data:image/png;base64,AA', filename: 'MangaTranslator/chapter/page.png', saveAs: false,
        }, expect.any(Function));
        expect(waitForDownload).toHaveBeenCalledWith(41, expect.any(Function), expect.any(Function));
        expect(result).toEqual({
            keepAlive: true,
            response: { ok: true, filePath: '/downloads/MangaTranslator/page.png', downloadId: 41 },
        });
    });
});
