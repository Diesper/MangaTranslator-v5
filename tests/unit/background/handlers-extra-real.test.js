const path = require('path');

const {
    getRuntimeMock,
    getStorageMock,
    getTabsMock,
    getDownloadsMock,
    getAlarmsMock,
} = require('../../mocks/chrome-api.mock.js');

const BACKGROUND_PATH = path.resolve(__dirname, '../../../extension/background.js');

function delay(ms = 0) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function flush(rounds = 6) {
    for (let i = 0; i < rounds; i++) {
        await delay(0);
    }
}

async function waitFor(assertion, { timeout = 4000, interval = 10 } = {}) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeout) {
        const result = await assertion();
        if (result) return result;
        await delay(interval);
    }
    throw new Error('Timeout aguardando condição assíncrona');
}

function getBackgroundListener(runtimeMock) {
    const listeners = runtimeMock._messageListeners || [];
    if (listeners.length !== 1) {
        throw new Error(`Esperava 1 listener do background, recebi ${listeners.length}`);
    }
    return listeners[0];
}

function dispatchToBackground(runtimeMock, request, sender = { tab: null }) {
    return new Promise((resolve) => {
        let settled = false;
        let keepAlive = false;

        const sendResponse = (response) => {
            settled = true;
            resolve({ keepAlive, response });
        };

        keepAlive = getBackgroundListener(runtimeMock)(request, sender, sendResponse);
        if (keepAlive === false && !settled) {
            resolve({ keepAlive, response: undefined });
        }
    });
}

describe('background.js - handlers extras e regressions reais', () => {
    let runtimeMock;
    let storageMock;
    let tabsMock;
    let downloadsMock;
    let alarmsMock;

    beforeEach(async () => {
        jest.resetModules();

        runtimeMock = getRuntimeMock();
        storageMock = getStorageMock();
        tabsMock = getTabsMock();
        downloadsMock = getDownloadsMock();
        alarmsMock = getAlarmsMock();

        runtimeMock._messageListeners = [];
        runtimeMock._connectListeners = [];
        runtimeMock.lastError = null;

        await storageMock.clear();

        jest.isolateModules(() => {
            require(BACKGROUND_PATH);
        });

        await flush(10);
    });

    afterEach(async () => {
        alarmsMock.clearAll();
        tabsMock._tabs.clear();
        downloadsMock._downloads.clear();
        await storageMock.clear();
    });

    test('onInstalled define o defaultPrompt no storage local', async () => {
        const data = await storageMock.get(['defaultPrompt']);

        expect(typeof data.defaultPrompt).toBe('string');
        expect(data.defaultPrompt).toContain('Objetivo primário');
        expect(data.defaultPrompt.length).toBeGreaterThan(100);
    });

    test('SET_DEBUG_MODE persiste o estado e faz broadcast para todas as tabs abertas', async () => {
        const firstTab = await tabsMock.create({ url: 'https://reader.test/a', active: true });
        const secondTab = await tabsMock.create({ url: 'https://reader.test/b', active: false });
        const firstMessages = [];
        const secondMessages = [];

        tabsMock._registerMessageHandler(firstTab.id, (message, _sender, sendResponse) => {
            firstMessages.push(message);
            sendResponse({ ok: true });
        });
        tabsMock._registerMessageHandler(secondTab.id, (message, _sender, sendResponse) => {
            secondMessages.push(message);
            sendResponse({ ok: true });
        });

        const result = await dispatchToBackground(runtimeMock, {
            action: 'SET_DEBUG_MODE',
            debugOn: true,
        });

        await flush(8);

        expect(result.response).toEqual({ ok: true });

        const data = await storageMock.get(['debugMode']);
        expect(data.debugMode).toBe(true);
        expect(firstMessages).toContainEqual({ action: 'DEBUG_MODE_CHANGED', debugOn: true });
        expect(secondMessages).toContainEqual({ action: 'DEBUG_MODE_CHANGED', debugOn: true });
    });

    test('SHOW_EXISTING_FOLDER reutiliza anchorId valido sem fazer novo download', async () => {
        downloadsMock._downloads.set(44, {
            id: 44,
            url: 'data:image/png;base64,MARKER',
            filename: '/home/user/Downloads/MangaTranslator/Chapter_10/_anchor.png',
            state: 'complete',
            exists: true,
        });

        const showSpy = jest.spyOn(downloadsMock, 'show').mockResolvedValue();
        const downloadSpy = jest.spyOn(downloadsMock, 'download');

        const result = await dispatchToBackground(runtimeMock, {
            action: 'SHOW_EXISTING_FOLDER',
            folderPath: '/home/user/Downloads/MangaTranslator/Chapter_10',
            safeTitle: 'Chapter_10',
            anchorId: 44,
        });

        await flush(6);

        expect(result.response).toEqual({ ok: true });
        expect(showSpy).toHaveBeenCalledWith(44);
        expect(downloadSpy).not.toHaveBeenCalled();
    });

    test('LOG_ENTRY mantém somente os 500 registros mais recentes', async () => {
        for (let index = 0; index < 505; index++) {
            // eslint-disable-next-line no-await-in-loop
            await dispatchToBackground(runtimeMock, {
                action: 'LOG_ENTRY',
                level: 'info',
                source: 'test',
                action_name: 'SPAM',
                detail: `log-${index}`,
                extra: { index },
            });
        }

        const logs = await waitFor(async () => {
            const data = await storageMock.get(['translatorLog']);
            const entries = data.translatorLog || [];
            return entries.length === 500 ? entries : null;
        });

        expect(logs).toHaveLength(500);
        expect(logs[0]).toEqual(expect.objectContaining({ detail: 'log-5' }));
        expect(logs[499]).toEqual(expect.objectContaining({ detail: 'log-504' }));
    });
});
