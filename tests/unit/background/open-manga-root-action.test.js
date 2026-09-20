const path = require('path');

const ROUTER_PATH = path.resolve(__dirname, '../../../extension/background/router.js');
const ACTION_PATH = path.resolve(
    __dirname,
    '../../../extension/background/actions/open-manga-root.js'
);

function dispatch(listener, request, sender) {
    return new Promise(resolve => {
        let keepAlive;
        let response;

        const sendResponse = result => {
            response = result;
            if (keepAlive !== undefined) resolve({ keepAlive, response });
        };

        keepAlive = listener(request, sender, sendResponse);
        if (response !== undefined || keepAlive === false) {
            resolve({ keepAlive, response });
        }
    });
}

function loadAction() {
    global.self = global;
    global.MangaTranslatorLog = { log: jest.fn() };
    delete global.MangaTranslatorRouter;

    jest.isolateModules(() => {
        require(ROUTER_PATH);
        require(ACTION_PATH);
    });

    return global.MangaTranslatorRouter;
}

describe('background/actions/open-manga-root.js', () => {
    beforeEach(() => {
        jest.resetModules();
    });

    afterEach(() => {
        delete global.MangaTranslatorLog;
        delete global.MangaTranslatorRouter;
    });

    test('delegates to the root marker helper and preserves its success response', async () => {
        const handleMarkerAndShow = jest.fn((_safeTitle, sendResponse) => {
            sendResponse({ ok: true });
        });
        const router = loadAction();

        const result = await dispatch(router.createMessageRouter({
            contextFactory: () => ({ handleMarkerAndShow }),
        }), {
            action: 'OPEN_MANGA_ROOT',
        }, { id: chrome.runtime.id, tab: null });

        expect(result).toEqual({
            keepAlive: true,
            response: { ok: true },
        });
        expect(handleMarkerAndShow).toHaveBeenCalledWith(null, expect.any(Function));
    });

    test('preserves an error returned by the root marker helper', async () => {
        const router = loadAction();

        const result = await dispatch(router.createMessageRouter({
            contextFactory: () => ({
                handleMarkerAndShow: (_safeTitle, sendResponse) => {
                    sendResponse({ ok: false, error: 'Falha.' });
                },
            }),
        }), {
            action: 'OPEN_MANGA_ROOT',
        }, { tab: { id: 22, url: 'https://reader.example/chapter' } });

        expect(result).toEqual({
            keepAlive: true,
            response: { ok: false, error: 'Falha.' },
        });
    });
});
