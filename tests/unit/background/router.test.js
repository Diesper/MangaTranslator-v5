const path = require('path');

const ROUTER_PATH = path.resolve(__dirname, '../../../extension/background/router.js');

function loadRouter() {
    delete global.MangaTranslatorRouter;
    jest.isolateModules(() => {
        require(ROUTER_PATH);
    });
    return global.MangaTranslatorRouter;
}

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

describe('background/router.js', () => {
    beforeEach(() => {
        jest.resetModules();
        delete global.MangaTranslatorLog;
        delete global.MangaTranslatorState;
    });

    afterEach(() => {
        delete global.MangaTranslatorRouter;
    });

    test('resolve nomes legados e identifica a origem de cada contexto', () => {
        const router = loadRouter();

        expect(router.resolveActionName('GET_TAB_ID')).toBe('get-tab-id');
        expect(router.resolveActionName('UNKNOWN')).toBeNull();
        expect(router.identifySource({ tab: { url: 'https://gemini.google.com/app' } })).toBe('gemini');
        expect(router.identifySource({ tab: { url: 'https://reader.example/chapter' } })).toBe('content');
        expect(router.identifySource({ id: chrome.runtime.id })).toBe('popup');
        expect(router.identifySource({ id: 'outside-extension' })).toBe('external');
    });

    test('despacha uma ação síncrona autorizada e preserva sua resposta', async () => {
        const router = loadRouter();
        router.registerAction({
            name: 'get-tab-id',
            meta: { allowedSources: ['content'], async: false },
            validate: request => request.action === 'GET_TAB_ID' ? null : { code: 'INVALID_ACTION' },
            execute: (_request, context) => ({ tabId: context.sender.tab.id }),
        });

        const response = await dispatch(
            router.createMessageRouter({}),
            { action: 'GET_TAB_ID' },
            { tab: { id: 42, url: 'https://reader.example/chapter' } }
        );

        expect(response).toEqual({ keepAlive: false, response: { ok: true, tabId: 42 } });
    });

    test('bloqueia origem não permitida antes de executar a ação', async () => {
        const router = loadRouter();
        const execute = jest.fn();
        router.registerAction({
            name: 'get-tab-id',
            meta: { allowedSources: ['content'], async: false },
            execute,
        });

        const response = await dispatch(
            router.createMessageRouter({}),
            { action: 'GET_TAB_ID' },
            { id: chrome.runtime.id, tab: null }
        );

        expect(execute).not.toHaveBeenCalled();
        expect(response).toEqual({
            keepAlive: false,
            response: { ok: false, error: { code: 'SOURCE_DENIED' } },
        });
    });

    test('retorna falha de validação sem abrir canal assíncrono', async () => {
        const router = loadRouter();
        router.registerAction({
            name: 'get-tab-id',
            meta: { allowedSources: ['content'], async: false },
            validate: () => ({ code: 'INVALID_PAYLOAD', message: 'Payload inválido' }),
            execute: jest.fn(),
        });

        const response = await dispatch(
            router.createMessageRouter({}),
            { action: 'GET_TAB_ID' },
            { tab: { id: 42, url: 'https://reader.example/chapter' } }
        );

        expect(response).toEqual({
            keepAlive: false,
            response: { ok: false, error: { code: 'INVALID_PAYLOAD', message: 'Payload inválido' } },
        });
    });

    test('mantém aberto o canal de uma ação assíncrona até a resposta', async () => {
        const router = loadRouter();
        router.registerAction({
            name: 'get-tab-id',
            meta: { allowedSources: ['content'] },
            async execute(_request, context) {
                await Promise.resolve();
                return { tabId: context.sender.tab.id };
            },
        });

        const response = await dispatch(
            router.createMessageRouter({}),
            { action: 'GET_TAB_ID' },
            { tab: { id: 73, url: 'https://reader.example/chapter' } }
        );

        expect(response).toEqual({ keepAlive: true, response: { ok: true, tabId: 73 } });
    });

    test('aceita dependências explícitas sem substituir o sender do contexto', async () => {
        const router = loadRouter();
        router.registerAction({
            name: 'get-tab-id',
            meta: { allowedSources: ['content'], async: false },
            execute(_request, context) {
                return {
                    tabId: context.sender.tab.id,
                    activeMangaTabId: context.state.activeMangaTabId,
                };
            },
        });

        const response = await dispatch(
            router.createMessageRouter({
                contextFactory: () => ({ state: { activeMangaTabId: 91 } }),
            }),
            { action: 'GET_TAB_ID' },
            { tab: { id: 44, url: 'https://reader.example/chapter' } }
        );

        expect(response).toEqual({
            keepAlive: false,
            response: { ok: true, tabId: 44, activeMangaTabId: 91 },
        });
    });
});
