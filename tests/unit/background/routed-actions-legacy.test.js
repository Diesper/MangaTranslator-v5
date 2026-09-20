const {
    getRuntimeMock,
    getStorageMock,
    getTabsMock,
    getDownloadsMock,
    getAlarmsMock,
} = require('../../mocks/chrome-api.mock.js');
const { loadBackgroundModule } = require('../../helpers/load-background-module.js');
const {
    BACKGROUND_PATH,
    flush,
    dispatchToBackground,
} = require('../../helpers/background-test-utils.js');

describe('background.js - acoes legadas encaminhadas pelo roteador', () => {
    let runtimeMock;
    let storageMock;
    let tabsMock;
    let downloadsMock;
    let alarmsMock;
    let backgroundModule;
    let routerApi;
    let createMessageRouterSpy;

    beforeEach(async () => {
        jest.resetModules();

        runtimeMock = getRuntimeMock();
        storageMock = getStorageMock();
        tabsMock = getTabsMock();
        downloadsMock = getDownloadsMock();
        alarmsMock = getAlarmsMock();

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

        routerApi = global.MangaTranslatorRouter;
        createMessageRouterSpy = jest.spyOn(routerApi, 'createMessageRouter');
    });

    afterEach(async () => {
        alarmsMock.clearAll();
        tabsMock._tabs.clear();
        downloadsMock._downloads.clear();
        await storageMock.clear();
        jest.restoreAllMocks();
    });

    function spyOnRoutedAction(name) {
        const action = routerApi.getAction(name);
        expect(action).toBeDefined();
        return jest.spyOn(action, 'execute');
    }

    function expectRouted(actionSpy) {
        expect(createMessageRouterSpy).toHaveBeenCalledTimes(1);
        expect(actionSpy).toHaveBeenCalledTimes(1);
    }

    test('carrega as ações de mídia, resultado e ativação no worker', () => {
        expect(routerApi.getAction('fetch-image-base64')).toBeDefined();
        expect(routerApi.getAction('calculate-visual-fingerprint')).toBeDefined();
        expect(routerApi.getAction('force-send-activation')).toBeDefined();
        expect(routerApi.getAction('request-image-data')).toBeDefined();
        expect(routerApi.getAction('open-manga-root')).toBeDefined();
        expect(routerApi.getAction('download-image')).toBeDefined();
    });

    test('LOG_ENTRY passa pelo roteador e mantém a confirmação legada', async () => {
        const actionSpy = spyOnRoutedAction('log-entry');

        const result = await dispatchToBackground(runtimeMock, {
            action: 'LOG_ENTRY',
            level: 'info',
            source: 'manga',
            action_name: 'CACHE_HIT',
            detail: 'Imagem recuperada do cache',
            extra: { index: 2 },
        }, { tab: { id: 71, url: 'https://reader.test/chapter' } });

        expectRouted(actionSpy);
        expect(result.response).toEqual({ ok: true });
    });

    test('GET_TAB_ID passa pelo roteador e mantém a resposta sem ok', async () => {
        const actionSpy = spyOnRoutedAction('get-tab-id');

        const result = await dispatchToBackground(runtimeMock, {
            action: 'GET_TAB_ID',
        }, { tab: { id: 72, url: 'https://gemini.google.com/app' } });

        expectRouted(actionSpy);
        expect(result.response).toEqual({ tabId: 72 });
    });

    test('GEMINI_PROGRESS passa pelo roteador e mantém a confirmação legada', async () => {
        const actionSpy = spyOnRoutedAction('relay-progress');
        const mangaTab = await tabsMock.create({ url: 'https://reader.test/chapter' });
        const messages = [];
        tabsMock._registerMessageHandler(mangaTab.id, (message, _sender, sendResponse) => {
            messages.push(message);
            sendResponse({ ok: true });
        });
        await storageMock.set({
            gemini_job_73: { jobId: 'job-73', state: 'opening' },
        });

        const result = await dispatchToBackground(runtimeMock, {
            action: 'GEMINI_PROGRESS',
            mangaTabId: mangaTab.id,
            text: 'Gerando traducao...',
        }, { tab: { id: 73, url: 'https://gemini.google.com/app' } });

        expectRouted(actionSpy);
        expect(result.response).toEqual({ ok: true });
        expect(messages).toContainEqual({ action: 'PROGRESS', text: 'Gerando traducao...' });
        expect(await storageMock.get(['gemini_job_73'])).toEqual({
            gemini_job_73: expect.objectContaining({ jobId: 'job-73', state: 'running' }),
        });
    });

    test('CHECK_IF_EXTRACTION_TAB passa pelo roteador e mantém a resposta sem ok', async () => {
        const actionSpy = spyOnRoutedAction('check-extraction-tab');
        backgroundModule.__setState({
            extractionTabs: {
                74: { mangaTabId: 11, index: 5, geminiTabId: 73, jobId: 'job-73' },
            },
        });

        const result = await dispatchToBackground(runtimeMock, {
            action: 'CHECK_IF_EXTRACTION_TAB',
        }, { tab: { id: 74, url: 'https://cdn.reader.test/result.png' } });

        expectRouted(actionSpy);
        expect(result.response).toEqual({
            isExtractionTab: true,
            mangaTabId: 11,
            index: 5,
            geminiTabId: 73,
            jobId: 'job-73',
        });
    });

    test('SET_DEBUG_MODE passa pelo roteador e mantém a confirmação legada', async () => {
        const actionSpy = spyOnRoutedAction('set-debug-mode');
        const firstTab = await tabsMock.create({ url: 'https://reader.test/one' });
        const secondTab = await tabsMock.create({ url: 'https://reader.test/two' });
        const messages = [];
        [firstTab, secondTab].forEach(tab => {
            tabsMock._registerMessageHandler(tab.id, (message, _sender, sendResponse) => {
                messages.push({ tabId: tab.id, message });
                sendResponse({ ok: true });
            });
        });

        const result = await dispatchToBackground(runtimeMock, {
            action: 'SET_DEBUG_MODE',
            debugOn: true,
        }, { id: chrome.runtime.id, tab: null });

        expectRouted(actionSpy);
        expect(result.response).toEqual({ ok: true });
        expect(await storageMock.get(['debugMode'])).toEqual({ debugMode: true });
        expect(messages).toEqual(expect.arrayContaining([
            { tabId: firstTab.id, message: { action: 'DEBUG_MODE_CHANGED', debugOn: true } },
            { tabId: secondTab.id, message: { action: 'DEBUG_MODE_CHANGED', debugOn: true } },
        ]));
    });
});
