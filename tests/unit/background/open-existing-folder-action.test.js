const path = require('path');

const ROUTER_PATH = path.resolve(__dirname, '../../../extension/background/router.js');
const ACTION_PATH = path.resolve(__dirname, '../../../extension/background/actions/open-existing-folder.js');

function loadRouter() {
    global.self = global;
    global.chrome = {
        runtime: { id: 'test-extension-id' },
        downloads: { search: jest.fn(), show: jest.fn() },
    };
    delete global.MangaTranslatorRouter;
    jest.isolateModules(() => {
        require(ROUTER_PATH);
        require(ACTION_PATH);
    });
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

describe('background/actions/open-existing-folder.js', () => {
    afterEach(() => delete global.MangaTranslatorRouter);

    test('abre o marcador existente quando ele ainda existe', async () => {
        const router = loadRouter();
        chrome.downloads.search.mockImplementation((_query, callback) => callback([{ id: 45, exists: true }]));

        const result = await dispatch(router.createMessageRouter({
            contextFactory: () => ({ handleMarkerAndShow: jest.fn() }),
        }), { action: 'SHOW_EXISTING_FOLDER', anchorId: 45, folderPath: 'MangaTranslator/Chap', safeTitle: 'Chap' });

        expect(chrome.downloads.show).toHaveBeenCalledWith(45);
        expect(result).toEqual({ keepAlive: true, response: { ok: true } });
    });

    test('usa o marcador quando não encontra nenhum download na pasta', async () => {
        const router = loadRouter();
        chrome.downloads.search.mockImplementation((_query, callback) => callback([]));
        const handleMarkerAndShow = jest.fn((_title, callback) => callback({ ok: true }));

        const result = await dispatch(router.createMessageRouter({
            contextFactory: () => ({ handleMarkerAndShow }),
        }), { action: 'SHOW_EXISTING_FOLDER', folderPath: 'MangaTranslator/Chap.1', safeTitle: 'Chap.1' });

        expect(chrome.downloads.search).toHaveBeenCalledWith(
            { filenameRegex: 'MangaTranslator/Chap\\.1' }, expect.any(Function)
        );
        expect(handleMarkerAndShow).toHaveBeenCalledWith('Chap.1', expect.any(Function));
        expect(result).toEqual({ keepAlive: true, response: { ok: true } });
    });
});
