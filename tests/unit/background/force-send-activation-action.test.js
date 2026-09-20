const path = require('path');

const ROUTER_PATH = path.resolve(__dirname, '../../../extension/background/router.js');
const ACTION_PATH = path.resolve(
    __dirname,
    '../../../extension/background/actions/force-send-activation.js'
);

function dispatch(listener, request, sender) {
    let keepAlive;
    let response;
    const sendResponse = result => { response = result; };

    keepAlive = listener(request, sender, sendResponse);
    return { keepAlive, response };
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

describe('background/actions/force-send-activation.js', () => {
    let originalGet;
    let originalTabs;
    let originalWindows;

    beforeEach(() => {
        jest.resetModules();
        jest.useFakeTimers();
        originalGet = chrome.storage.local.get;
        originalTabs = chrome.tabs;
        originalWindows = chrome.windows;

        chrome.storage.local.get = jest.fn((_keys, callback) => callback({}));
        chrome.tabs = {
            get: jest.fn(),
            sendMessage: jest.fn((_tabId, _message, callback) => callback()),
            update: jest.fn((_tabId, _options, callback) => callback()),
        };
        chrome.windows = {
            update: jest.fn((_windowId, _options, callback) => callback()),
        };
    });

    afterEach(() => {
        jest.useRealTimers();
        chrome.storage.local.get = originalGet;
        chrome.tabs = originalTabs;
        chrome.windows = originalWindows;
        delete global.MangaTranslatorLog;
        delete global.MangaTranslatorRouter;
    });

    test('foca a janela minimizada, envia ao Gemini e restaura o foco do mangá', () => {
        chrome.storage.local.get.mockImplementation((_keys, callback) => {
            callback({ geminiExecutionMode: 'minimized_window' });
        });
        chrome.tabs.get.mockImplementation((_tabId, callback) => callback({ windowId: 73 }));
        const router = loadAction();

        const result = dispatch(router.createMessageRouter({}), {
            action: 'FORCE_SEND_ACTIVATION',
            geminiTabId: 17,
            mangaTabId: 29,
            windowId: 61,
        }, { tab: { id: 29, url: 'https://reader.example/chapter' } });

        expect(result).toEqual({ keepAlive: false, response: { ok: true } });
        expect(chrome.windows.update).toHaveBeenCalledWith(61, { focused: true }, expect.any(Function));
        expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(
            17,
            { action: 'DO_SEND_NOW' },
            expect.any(Function)
        );

        jest.advanceTimersByTime(250);

        expect(chrome.windows.update).toHaveBeenCalledWith(
            61,
            { state: 'minimized', focused: false },
            expect.any(Function)
        );
        expect(chrome.tabs.get).toHaveBeenCalledWith(29, expect.any(Function));
        expect(chrome.windows.update).toHaveBeenCalledWith(73, { focused: true }, expect.any(Function));
    });

    test('usa a ativação por aba quando a janela minimizada não é aplicável', () => {
        const router = loadAction();

        const result = dispatch(router.createMessageRouter({}), {
            action: 'FORCE_SEND_ACTIVATION',
            geminiTabId: 18,
            mangaTabId: 30,
            executionMode: 'temp_chat',
        }, { tab: { id: 30, url: 'https://reader.example/chapter' } });

        expect(result).toEqual({ keepAlive: false, response: { ok: true } });
        expect(chrome.tabs.update).toHaveBeenCalledWith(18, { active: true }, expect.any(Function));
        expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(
            18,
            { action: 'DO_SEND_NOW' },
            expect.any(Function)
        );

        jest.advanceTimersByTime(250);

        expect(chrome.tabs.update).toHaveBeenCalledWith(30, { active: true }, expect.any(Function));
    });
});
