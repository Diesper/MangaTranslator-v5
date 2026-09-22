const path = require('path');

const ROUTER_PATH = path.resolve(__dirname, '../../../extension/background/router.js');
const ACTION_PATH = path.resolve(
    __dirname,
    '../../../extension/background/actions/fetch-image-base64.js'
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

describe('background/actions/fetch-image-base64.js', () => {
    let originalFetch;
    let originalFileReader;

    class MockFileReader {
        readAsDataURL(blob) {
            this.result = `data:${blob.type};base64,SU1BR0U=`;
            setTimeout(() => this.onloadend(), 0);
        }
    }

    beforeEach(() => {
        jest.resetModules();
        jest.useRealTimers();
        originalFetch = global.fetch;
        originalFileReader = global.FileReader;
        global.FileReader = MockFileReader;
    });

    afterEach(() => {
        jest.useRealTimers();
        global.fetch = originalFetch;
        global.FileReader = originalFileReader;
        delete global.MangaTranslatorLog;
        delete global.MangaTranslatorRouter;
        delete global.MangaTranslatorState;
    });

    test('busca uma imagem HTTP e devolve dataUrl no formato legado', async () => {
        global.fetch = jest.fn().mockResolvedValue({
            ok: true,
            status: 200,
            headers: { get: jest.fn(() => 'image/png') },
            blob: jest.fn().mockResolvedValue({ size: 1024, type: 'image/png' }),
        });
        const router = loadAction();

        const result = await dispatch(router.createMessageRouter({}), {
            action: 'FETCH_IMAGE_AS_BASE64',
            url: 'https://cdn.example/page.png',
        }, { tab: { id: 17, url: 'https://reader.example/chapter' } });

        expect(result).toEqual({
            keepAlive: true,
            response: { ok: true, dataUrl: 'data:image/png;base64,SU1BR0U=' },
        });
        expect(global.fetch).toHaveBeenCalledWith(
            'https://cdn.example/page.png',
            expect.objectContaining({
                signal: expect.any(AbortSignal),
                credentials: 'omit',
                cache: 'no-store',
            })
        );
    });

    test('busca asset googleusercontent com credenciais somente quando vem da aba Gemini', async () => {
        global.fetch = jest.fn().mockResolvedValue({
            ok: true,
            status: 200,
            headers: { get: jest.fn(() => 'image/png') },
            blob: jest.fn().mockResolvedValue({ size: 1024, type: 'image/png' }),
        });
        const router = loadAction();

        const result = await dispatch(router.createMessageRouter({}), {
            action: 'FETCH_IMAGE_AS_BASE64',
            url: 'https://lh3.googleusercontent.com/generated-image',
            geminiSession: true,
        }, { tab: { id: 17, url: 'https://gemini.google.com/app/chat-1' } });

        expect(result.response).toEqual(expect.objectContaining({ ok: true, dataUrl: expect.any(String) }));
        expect(global.fetch).toHaveBeenCalledWith(
            'https://lh3.googleusercontent.com/generated-image',
            expect.objectContaining({ credentials: 'include', cache: 'no-store' })
        );
    });

    test.each([
        ['host não Google', 'https://example.test/image.png', 'https://gemini.google.com/app/chat-1', 'Asset autenticado deve ser googleusercontent.com'],
        ['origem fora do Gemini', 'https://lh3.googleusercontent.com/image.png', 'https://reader.example/chapter', 'Sessão Gemini permitida somente para a aba Gemini'],
    ])('rejeita sessão autenticada para %s', async (_name, url, senderUrl, message) => {
        global.fetch = jest.fn();
        const router = loadAction();
        const result = await dispatch(router.createMessageRouter({}), {
            action: 'FETCH_IMAGE_AS_BASE64', url, geminiSession: true,
        }, { tab: { id: 18, url: senderUrl } });

        expect(result.response).toEqual(expect.objectContaining({
            ok: false,
            error: expect.objectContaining({ message }),
        }));
        expect(global.fetch).not.toHaveBeenCalled();
    });

    test.each([
        ['aceita exatamente 50 MB', 50 * 1024 * 1024, true],
        ['rejeita mais de 50 MB', (50 * 1024 * 1024) + 1, false],
    ])('%s', async (_name, size, shouldSucceed) => {
        global.fetch = jest.fn().mockResolvedValue({
            ok: true,
            status: 200,
            headers: { get: jest.fn(() => 'image/png') },
            blob: jest.fn().mockResolvedValue({ size, type: 'image/png' }),
        });
        const router = loadAction();

        const result = await dispatch(router.createMessageRouter({}), {
            action: 'FETCH_IMAGE_AS_BASE64',
            url: 'https://cdn.example/page.png',
        }, { tab: { id: 22, url: 'https://reader.example/chapter' } });

        if (shouldSucceed) {
            expect(result).toEqual({
                keepAlive: true,
                response: { ok: true, dataUrl: 'data:image/png;base64,SU1BR0U=' },
            });
            return;
        }

        expect(result).toEqual({
            keepAlive: true,
            response: {
                ok: false,
                error: {
                    code: 'INTERNAL_ERROR',
                    message: 'Imagem muito grande (>50MB)',
                },
            },
        });
    });

    test.each([
        ['URL inválida', 'not a url', 'URL inválida'],
        ['protocolo não permitido', 'data:image/png;base64,AA==', 'Protocolo inválido'],
    ])('rejeita %s antes do fetch', async (_name, url, message) => {
        global.fetch = jest.fn();
        const router = loadAction();

        const result = await dispatch(router.createMessageRouter({}), {
            action: 'FETCH_IMAGE_AS_BASE64',
            url,
        }, { tab: { id: 18, url: 'https://reader.example/chapter' } });

        expect(result).toEqual({
            keepAlive: false,
            response: {
                ok: false,
                error: { code: 'INVALID_PAYLOAD', message },
            },
        });
        expect(global.fetch).not.toHaveBeenCalled();
    });

    test('rejeita uma resposta que nao declara content-type de imagem', async () => {
        const blob = jest.fn();
        global.fetch = jest.fn().mockResolvedValue({
            ok: true,
            status: 200,
            headers: { get: jest.fn(() => 'text/html') },
            blob,
        });
        const router = loadAction();

        const result = await dispatch(router.createMessageRouter({}), {
            action: 'FETCH_IMAGE_AS_BASE64',
            url: 'https://cdn.example/not-image',
        }, { tab: { id: 19, url: 'https://reader.example/chapter' } });

        expect(result).toEqual({
            keepAlive: true,
            response: {
                ok: false,
                error: {
                    code: 'INTERNAL_ERROR',
                    message: 'Content-Type inválido: text/html',
                },
            },
        });
        expect(blob).not.toHaveBeenCalled();
    });

    test('rejeita uma resposta HTTP sem sucesso', async () => {
        global.fetch = jest.fn().mockResolvedValue({
            ok: false,
            status: 404,
            headers: { get: jest.fn() },
        });
        const router = loadAction();

        const result = await dispatch(router.createMessageRouter({}), {
            action: 'FETCH_IMAGE_AS_BASE64',
            url: 'https://cdn.example/missing.png',
        }, { tab: { id: 20, url: 'https://reader.example/chapter' } });

        expect(result.response).toEqual({
            ok: false,
            error: { code: 'INTERNAL_ERROR', message: 'HTTP 404' },
        });
    });

    test('aborta o fetch apos 30 segundos', async () => {
        jest.useFakeTimers();
        let signal;
        global.fetch = jest.fn((_url, options) => {
            signal = options.signal;
            return new Promise((_resolve, reject) => {
                signal.addEventListener('abort', () => reject(new Error('Abortado')));
            });
        });
        const router = loadAction();
        const resultPromise = dispatch(router.createMessageRouter({}), {
            action: 'FETCH_IMAGE_AS_BASE64',
            url: 'https://cdn.example/slow.png',
        }, { tab: { id: 21, url: 'https://reader.example/chapter' } });

        expect(signal.aborted).toBe(false);
        jest.advanceTimersByTime(30_000);

        await expect(resultPromise).resolves.toEqual({
            keepAlive: true,
            response: {
                ok: false,
                error: { code: 'INTERNAL_ERROR', message: 'Abortado' },
            },
        });
        expect(signal.aborted).toBe(true);
    });
});

