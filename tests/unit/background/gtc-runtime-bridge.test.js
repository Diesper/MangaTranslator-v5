const path = require('path');

const {
    getRuntimeMock,
    getStorageMock,
} = require('../../mocks/chrome-api.mock.js');

const BACKGROUND_PATH = path.resolve(__dirname, '../../../extension/background.js');

function sendRuntimeMessage(runtimeMock, message) {
    return new Promise((resolve) => {
        runtimeMock.sendMessage(message, resolve);
    });
}

describe('REG-01/REG-02/IPC-04/IPC-05/IPC-06: background.js - ponte de mensagens GTC', () => {
    let runtimeMock;
    let storageMock;

    beforeEach(async () => {
        jest.resetModules();

        runtimeMock = getRuntimeMock();
        storageMock = getStorageMock();

        runtimeMock._messageListeners = [];
        runtimeMock._connectListeners = [];
        runtimeMock.lastError = null;

        await storageMock.clear();

        jest.isolateModules(() => {
            require(BACKGROUND_PATH);
        });
    });

    test('encaminha GTC_SAVE e GTC_QUERY_MANY pelo listener real do background', async () => {
        const saveResponse = await sendRuntimeMessage(runtimeMock, {
            action: 'GTC_SAVE',
            hash: 'ABC123',
            translatedDataUrl: 'data:image/png;base64,REAL_BG_CACHE',
            cleanUrl: 'https://reader.test/panel-001.png',
            width: 800,
            height: 1200,
        });

        expect(saveResponse).toEqual(expect.objectContaining({
            ok: true,
            saved: true,
            durationMs: expect.any(Number),
        }));

        const queryResponse = await sendRuntimeMessage(runtimeMock, {
            action: 'GTC_QUERY_MANY',
            hashes: ['abc123', 'missing'],
        });

        expect(queryResponse).toEqual(expect.objectContaining({
            ok: true,
            entriesByHash: {
                abc123: 'data:image/png;base64,REAL_BG_CACHE',
            },
            durationMs: expect.any(Number),
        }));
    });

    test('mantem outros handlers funcionais depois do guard de GTC (regressao BUG NEW-1)', async () => {
        const response = await sendRuntimeMessage(runtimeMock, {
            action: 'GET_TAB_ID',
        });

        expect(response).toEqual({ tabId: null });
    });

    test('tambem encaminha GTC_SAVE_MANY e GTC_STATS pelo caminho real', async () => {
        const saveManyResponse = await sendRuntimeMessage(runtimeMock, {
            action: 'GTC_SAVE_MANY',
            entries: [
                { hash: 'hash-1', translatedDataUrl: 'data:1' },
                { hash: 'hash-2', translatedDataUrl: 'data:2' },
                { hash: null, translatedDataUrl: 'data:ignored' },
            ],
        });

        expect(saveManyResponse).toEqual(expect.objectContaining({
            ok: true,
            saved: true,
            count: 3,
            durationMs: expect.any(Number),
        }));

        const statsResponse = await sendRuntimeMessage(runtimeMock, {
            action: 'GTC_STATS',
        });

        expect(statsResponse).toEqual(expect.objectContaining({
            ok: true,
            stats: { count: 2 },
            durationMs: expect.any(Number),
        }));
    });
});
