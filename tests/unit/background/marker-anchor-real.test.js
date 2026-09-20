const {
    getRuntimeMock,
    getStorageMock,
    getTabsMock,
    getAlarmsMock,
    getDownloadsMock,
} = require('../../mocks/chrome-api.mock.js');
const { loadBackgroundModule } = require('../../helpers/load-background-module.js');
const {
    BACKGROUND_PATH,
    flush,
} = require('../../helpers/background-test-utils.js');

describe('background.js - handleMarkerAndShow real', () => {
    let runtimeMock;
    let storageMock;
    let tabsMock;
    let alarmsMock;
    let downloadsMock;
    let backgroundModule;

    async function flushFakeTimerRounds(rounds = 6, stepMs = 1) {
        for (let index = 0; index < rounds; index++) {
            // eslint-disable-next-line no-await-in-loop
            await jest.advanceTimersByTimeAsync(stepMs);
        }
    }

    beforeEach(async () => {
        jest.resetModules();
        jest.useRealTimers();

        runtimeMock = getRuntimeMock();
        storageMock = getStorageMock();
        tabsMock = getTabsMock();
        alarmsMock = getAlarmsMock();
        downloadsMock = getDownloadsMock();

        runtimeMock._messageListeners = [];
        runtimeMock._connectListeners = [];
        runtimeMock._installedListeners = [];
        runtimeMock._startupListeners = [];
        runtimeMock.lastError = null;

        await storageMock.clear();
        global.chrome = {
            storage: { local: storageMock },
            tabs: tabsMock,
            alarms: alarmsMock,
            runtime: runtimeMock,
            downloads: downloadsMock,
            scripting: global.chrome?.scripting,
        };

        backgroundModule = loadBackgroundModule(BACKGROUND_PATH);
        await flush(8);
    });

    afterEach(async () => {
        alarmsMock.clearAll();
        tabsMock._tabs.clear();
        downloadsMock._downloads.clear();
        await storageMock.clear();
        jest.useRealTimers();
        jest.restoreAllMocks();
    });

    test('BG-38/BG-40/BG-41: cria âncora no path correto quando não há download anterior', async () => {
        jest.spyOn(downloadsMock, 'search').mockImplementation((query, callback) => {
            if (callback) callback([]);
            return Promise.resolve([]);
        });
        const downloadSpy = jest.spyOn(downloadsMock, 'download');

        const rootResponse = jest.fn();
        backgroundModule.handleMarkerAndShow(null, rootResponse);
        await flush(8);

        expect(downloadSpy).toHaveBeenCalledWith(expect.objectContaining({
            filename: 'MangaTranslator/_anchor.png',
        }), expect.any(Function));

        const titledResponse = jest.fn();
        backgroundModule.handleMarkerAndShow('Capitulo_10', titledResponse);
        await flush(8);

        expect(downloadSpy).toHaveBeenCalledWith(expect.objectContaining({
            filename: 'MangaTranslator/Capitulo_10/_anchor.png',
        }), expect.any(Function));
    });

    test('BG-39: âncora é removida do disco após 4s quando o download completa', async () => {
        jest.spyOn(downloadsMock, 'search').mockImplementation((query, callback) => {
            if (callback) callback([]);
            return Promise.resolve([]);
        });
        const showSpy = jest.spyOn(downloadsMock, 'show').mockResolvedValue();
        const removeFileSpy = jest.spyOn(downloadsMock, 'removeFile').mockImplementation((id, callback) => {
            if (callback) callback();
            return Promise.resolve();
        });
        const eraseSpy = jest.spyOn(downloadsMock, 'erase').mockImplementation((query, callback) => {
            if (callback) callback();
            return Promise.resolve();
        });
        const sendResponse = jest.fn();

        jest.useFakeTimers();

        backgroundModule.handleMarkerAndShow('Capitulo_11', sendResponse);
        await jest.advanceTimersByTimeAsync(20);
        await flushFakeTimerRounds(6);

        expect(showSpy).toHaveBeenCalled();
        expect(sendResponse).toHaveBeenCalledWith({ ok: true });

        await jest.advanceTimersByTimeAsync(4001);
        await flushFakeTimerRounds(4);

        expect(removeFileSpy).toHaveBeenCalled();
        expect(eraseSpy).toHaveBeenCalled();
    });

    test('BG-42: falha ao criar âncora responde erro sem crash', async () => {
        jest.spyOn(downloadsMock, 'search').mockImplementation((query, callback) => {
            if (callback) callback([]);
            return Promise.resolve([]);
        });
        jest.spyOn(downloadsMock, 'download').mockImplementation((options, callback) => {
            if (callback) callback(undefined);
            return Promise.resolve(undefined);
        });

        const sendResponse = jest.fn();
        backgroundModule.handleMarkerAndShow('Capitulo_12', sendResponse);
        await flush(6);

        expect(sendResponse).toHaveBeenCalledWith({ ok: false, error: 'Falha.' });
    });
});
