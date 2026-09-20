const path = require('path');

const { getStorageMock, getTabsMock } = require('../../mocks/chrome-api.mock.js');

const ROUTER_PATH = path.resolve(__dirname, '../../../extension/background/router.js');
const ACTION_PATHS = [
    'check-extraction-tab.js',
    'get-tab-id.js',
    'log-entry.js',
    'relay-progress.js',
    'set-debug-mode.js',
].map(file => path.resolve(__dirname, '../../../extension/background/actions', file));

function dispatch(listener, request, sender) {
    return new Promise(resolve => {
        let keepAlive;
        let delivered = false;
        let deliveredResponse;

        const sendResponse = response => {
            delivered = true;
            deliveredResponse = response;
            if (keepAlive !== undefined) resolve({ keepAlive, response });
        };

        keepAlive = listener(request, sender, sendResponse);
        if (delivered || keepAlive === false) {
            resolve({ keepAlive, response: delivered ? deliveredResponse : undefined });
        }
    });
}

function loadActions(state = {}) {
    global.self = global;
    global.MangaTranslatorState = state;
    global.MangaTranslatorLog = { log: jest.fn() };
    delete global.MangaTranslatorRouter;

    jest.isolateModules(() => {
        require(ROUTER_PATH);
        ACTION_PATHS.forEach(require);
    });

    return global.MangaTranslatorRouter;
}

describe('ações de baixo risco do background', () => {
    let storageMock;
    let tabsMock;

    beforeEach(async () => {
        jest.resetModules();
        storageMock = getStorageMock();
        tabsMock = getTabsMock();
        await storageMock.clear();
    });

    afterEach(() => {
        delete global.MangaTranslatorLog;
        delete global.MangaTranslatorRouter;
        delete global.MangaTranslatorState;
    });

    test('get-tab-id retorna a aba Gemini remetente', async () => {
        const router = loadActions();
        const response = await dispatch(router.createMessageRouter({}), { action: 'GET_TAB_ID' }, {
            tab: { id: 41, url: 'https://gemini.google.com/app' },
        });

        expect(response).toEqual({ keepAlive: false, response: { ok: true, tabId: 41 } });
    });

    test('log-entry encaminha a entrada sem alterar a resposta legada', async () => {
        const router = loadActions();
        const response = await dispatch(router.createMessageRouter({}), {
            action: 'LOG_ENTRY',
            level: 'info',
            source: 'manga',
            action_name: 'CACHE_HIT',
            detail: 'Imagem atendida pelo cache',
            extra: { index: 3 },
        }, { tab: { id: 22, url: 'https://reader.example/chapter' } });

        expect(response).toEqual({ keepAlive: false, response: { ok: true } });
        expect(global.MangaTranslatorLog.log).toHaveBeenCalledWith(
            'info', 'manga', 'CACHE_HIT', 'Imagem atendida pelo cache', { index: 3 }
        );
    });

    test('check-extraction-tab devolve o mapeamento persistido da aba remetente', async () => {
        const router = loadActions({
            extractionTabs: {
                61: { mangaTabId: 7, index: 4, geminiTabId: 32, jobId: 'job-1' },
            },
        });
        const response = await dispatch(router.createMessageRouter({
            contextFactory: () => ({ ensureInitialized: jest.fn().mockResolvedValue() }),
        }), {
            action: 'CHECK_IF_EXTRACTION_TAB',
        }, { tab: { id: 61, url: 'https://cdn.example/result.png' } });

        expect(response).toEqual({
            keepAlive: true,
            response: {
                ok: true,
                isExtractionTab: true,
                mangaTabId: 7,
                index: 4,
                geminiTabId: 32,
                jobId: 'job-1',
            },
        });
    });

    test('relay-progress encaminha progresso e marca o job Gemini como running', async () => {
        const mangaTab = await tabsMock.create({ url: 'https://reader.example/chapter' });
        const messages = [];
        tabsMock._registerMessageHandler(mangaTab.id, (message, _sender, sendResponse) => {
            messages.push(message);
            sendResponse({ ok: true });
        });
        await storageMock.set({
            gemini_job_32: { jobId: 'job-1', state: 'opening' },
        });

        const router = loadActions({ activeMangaTabId: mangaTab.id });
        const response = await dispatch(router.createMessageRouter({}), {
            action: 'GEMINI_PROGRESS',
            text: 'Gerando tradução...',
        }, { tab: { id: 32, url: 'https://gemini.google.com/app' } });

        expect(response).toEqual({ keepAlive: true, response: { ok: true } });
        expect(messages).toContainEqual({ action: 'PROGRESS', text: 'Gerando tradução...' });
        expect(await storageMock.get(['gemini_job_32'])).toEqual({
            gemini_job_32: expect.objectContaining({ jobId: 'job-1', state: 'running' }),
        });
    });

    test('set-debug-mode persiste a opção e avisa todas as abas', async () => {
        const firstTab = await tabsMock.create({ url: 'https://reader.example/one' });
        const secondTab = await tabsMock.create({ url: 'https://reader.example/two' });
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

        const router = loadActions();
        const response = await dispatch(router.createMessageRouter({}), {
            action: 'SET_DEBUG_MODE',
            debugOn: true,
        }, { id: chrome.runtime.id, tab: null });

        expect(response).toEqual({ keepAlive: true, response: { ok: true } });
        expect(await storageMock.get(['debugMode'])).toEqual({ debugMode: true });
        expect(firstMessages).toContainEqual({ action: 'DEBUG_MODE_CHANGED', debugOn: true });
        expect(secondMessages).toContainEqual({ action: 'DEBUG_MODE_CHANGED', debugOn: true });
    });

    test('set-debug-mode rejeita payload inválido', async () => {
        const router = loadActions();
        const response = await dispatch(router.createMessageRouter({}), {
            action: 'SET_DEBUG_MODE',
            debugOn: 'true',
        }, { id: chrome.runtime.id, tab: null });

        expect(response).toEqual({
            keepAlive: false,
            response: {
                ok: false,
                error: { code: 'INVALID_PAYLOAD', message: 'debugOn deve ser um booleano' },
            },
        });
    });
});
