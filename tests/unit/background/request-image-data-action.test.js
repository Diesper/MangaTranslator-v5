const path = require('path');

const ROUTER_PATH = path.resolve(__dirname, '../../../extension/background/router.js');
const ACTION_PATH = path.resolve(
    __dirname,
    '../../../extension/background/actions/request-image-data.js'
);

function loadAction() {
    global.self = global;
    delete global.MangaTranslatorRouter;

    jest.isolateModules(() => {
        require(ROUTER_PATH);
        require(ACTION_PATH);
    });

    return global.MangaTranslatorRouter.getAction('request-image-data');
}

describe('background/actions/request-image-data.js', () => {
    let originalSendMessage;
    let originalSelf;

    beforeEach(() => {
        jest.resetModules();
        originalSelf = global.self;
        originalSendMessage = chrome.tabs.sendMessage;
    });

    afterEach(() => {
        chrome.tabs.sendMessage = originalSendMessage;
        global.self = originalSelf;
        delete global.MangaTranslatorRouter;
    });

    test('encaminha a pagina para a aba do manga e preserva sua resposta', async () => {
        const contentResponse = { srcData: 'data:image/png;base64,QUJDRA==' };
        chrome.tabs.sendMessage = jest.fn((_tabId, _message, callback) => callback(contentResponse));
        const action = loadAction();

        const result = await action.execute({ mangaTabId: 71, index: 5 });

        expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(
            71,
            { action: 'REQUEST_IMAGE_DATA', index: 5 },
            expect.any(Function)
        );
        expect(result).toBe(contentResponse);
    });

    test('devolve a mensagem de chrome.runtime.lastError', async () => {
        chrome.tabs.sendMessage = jest.fn((_tabId, _message, callback) => {
            chrome.runtime.lastError = { message: 'Could not establish connection.' };
            callback(undefined);
            chrome.runtime.lastError = null;
        });
        const action = loadAction();

        await expect(action.execute({ mangaTabId: 404, index: 8 })).resolves.toEqual({
            error: 'Could not establish connection.',
        });
    });
});
