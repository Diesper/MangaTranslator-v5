const path = require('path');

const ROUTER_PATH = path.resolve(__dirname, '../../../extension/background/router.js');
const ACTION_PATH = path.resolve(__dirname, '../../../extension/background/actions/download-chapter.js');

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

function dispatch(listener, request) {
    return new Promise(resolve => {
        let keepAlive;
        keepAlive = listener(request, { tab: { id: 2, url: 'https://reader.example/chapter' } }, response => {
            resolve({ keepAlive, response });
        });
    });
}

describe('background/actions/download-chapter.js', () => {
    afterEach(() => delete global.MangaTranslatorRouter);

    test('reusa o marcador de capítulo existente', async () => {
        const router = loadRouter();
        chrome.downloads.search.mockImplementation((_query, callback) => callback([{ id: 31, exists: true }]));
        const downloadImagesAndShow = jest.fn();
        const result = await dispatch(router.createMessageRouter({
            contextFactory: () => ({ handleMarkerAndShow: jest.fn(), downloadImagesAndShow }),
        }), { action: 'OPEN_CHAPTER_FOLDER', anchorId: 31, images: {}, safeTitle: 'Capítulo 1' });

        expect(chrome.downloads.show).toHaveBeenCalledWith(31);
        expect(downloadImagesAndShow).not.toHaveBeenCalled();
        expect(result).toEqual({ keepAlive: true, response: { ok: true } });
    });

    test('baixa páginas quando o marcador não existe', async () => {
        const router = loadRouter();
        const images = { 0: 'data:image/png;base64,AA' };
        const downloadImagesAndShow = jest.fn().mockResolvedValue();
        const result = await dispatch(router.createMessageRouter({
            contextFactory: () => ({ handleMarkerAndShow: jest.fn(), downloadImagesAndShow }),
        }), { action: 'DOWNLOAD_CHAPTER_AND_SHOW', images, safeTitle: 'Capítulo 2', chapId: 'chap-2' });

        expect(downloadImagesAndShow).toHaveBeenCalledWith(images, 'Capítulo 2', 'chap-2');
        expect(result).toEqual({ keepAlive: true, response: { ok: true } });
    });
});
