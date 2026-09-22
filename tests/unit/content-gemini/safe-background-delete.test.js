const { loadContentGeminiModule } = require('../../helpers/load-content-gemini-module.js');
const { getStorageMock } = require('../../mocks/chrome-api.mock.js');

function installImageMetrics(image, { width = 32, height = 48, complete = true } = {}) {
    Object.defineProperties(image, {
        naturalWidth: { value: width, configurable: true },
        naturalHeight: { value: height, configurable: true },
        complete: { value: complete, configurable: true },
    });
    return image;
}

describe('content_gemini.js - modo background_delete', () => {
    let originalCreateElement;
    let originalCss;

    beforeEach(() => {
        jest.resetModules();
        originalCreateElement = document.createElement.bind(document);
        originalCss = global.CSS;
        document.documentElement.innerHTML = '<head></head><body></body>';
    });

    afterEach(() => {
        if (originalCss === undefined) delete global.CSS;
        else global.CSS = originalCss;
        jest.restoreAllMocks();
        document.documentElement.innerHTML = '<head></head><body></body>';
    });

    test('BGD-01: escapa chatId sem depender de CSS.escape', () => {
        delete global.CSS;
        const mod = loadContentGeminiModule();

        expect(mod.escapeCssAttributeValue('chat-1')).toBe('chat-1');
        expect(mod.escapeCssAttributeValue('chat"1\\x')).toBe('chat\\"1\\\\x');
    });

    test('BGD-02: converte a imagem já renderizada para Data URL pelo canvas', async () => {
        const canvasContext = { drawImage: jest.fn() };
        jest.spyOn(document, 'createElement').mockImplementation((tagName) => {
            if (String(tagName).toLowerCase() === 'canvas') {
                return {
                    width: 0,
                    height: 0,
                    getContext: () => canvasContext,
                    toDataURL: () => 'data:image/png;base64,Q0FOVkFT',
                };
            }
            return originalCreateElement(tagName);
        });
        const mod = loadContentGeminiModule();
        const image = installImageMetrics(document.createElement('img'));

        await expect(mod.imageElementToDataUrl(image)).resolves.toBe('data:image/png;base64,Q0FOVkFT');
        expect(canvasContext.drawImage).toHaveBeenCalledWith(image, 0, 0);
    });

    test('BGD-03: imagem não pronta não tenta canvas', async () => {
        const mod = loadContentGeminiModule();
        const image = installImageMetrics(document.createElement('img'), { complete: false });

        await expect(mod.imageElementToDataUrl(image)).rejects.toThrow('ainda não está pronta');
    });

    test('BGD-04: ponte MAIN resolve Data URL autenticada pelo requestId correto', async () => {
        const mod = loadContentGeminiModule();
        const listener = event => {
            const { requestId } = event.detail;
            window.dispatchEvent(new CustomEvent('MANGA_TRANSLATOR_FETCH_IMAGE_RESULT', {
                detail: { requestId, dataUrl: 'data:image/png;base64,TUFJTg==' },
            }));
        };
        window.addEventListener('MANGA_TRANSLATOR_FETCH_IMAGE', listener);

        await expect(mod.fetchImageThroughGeminiPage('https://lh3.googleusercontent.com/image')).resolves
            .toBe('data:image/png;base64,TUFJTg==');

        window.removeEventListener('MANGA_TRANSLATOR_FETCH_IMAGE', listener);
    });

    test('BGD-05: ponte MAIN rejeita erro da página sem abrir aba auxiliar', async () => {
        const mod = loadContentGeminiModule();
        const listener = event => {
            const { requestId } = event.detail;
            window.dispatchEvent(new CustomEvent('MANGA_TRANSLATOR_FETCH_IMAGE_RESULT', {
                detail: { requestId, error: 'HTTP 403' },
            }));
        };
        window.addEventListener('MANGA_TRANSLATOR_FETCH_IMAGE', listener);

        await expect(mod.fetchImageThroughGeminiPage('https://lh3.googleusercontent.com/image')).rejects
            .toThrow('HTTP 403');

        window.removeEventListener('MANGA_TRANSLATOR_FETCH_IMAGE', listener);
    });

    test('BGD-06: quando canvas falha, usa a ponte MAIN na própria aba', async () => {
        const mod = loadContentGeminiModule();
        const listener = event => {
            const { requestId } = event.detail;
            window.dispatchEvent(new CustomEvent('MANGA_TRANSLATOR_FETCH_IMAGE_RESULT', {
                detail: { requestId, dataUrl: 'data:image/png;base64,RkFMTEJBQ0s=' },
            }));
        };
        window.addEventListener('MANGA_TRANSLATOR_FETCH_IMAGE', listener);

        await expect(mod.extractImageInGeminiTab(null, 'https://lh3.googleusercontent.com/image')).resolves
            .toBe('data:image/png;base64,RkFMTEJBQ0s=');

        window.removeEventListener('MANGA_TRANSLATOR_FETCH_IMAGE', listener);
    });

    test('BGD-07: estabilidade falha quando a linha é removida durante a espera', async () => {
        const mod = loadContentGeminiModule();
        const row = document.createElement('a');
        row.getBoundingClientRect = () => ({ top: 10, left: 10, width: 100, height: 20 });
        document.body.appendChild(row);
        setTimeout(() => row.remove(), 2);

        await expect(mod.waitForElementToSettle(row, 3, 5)).resolves.toBe(false);
    });

    test('BGD-08: ponte MAIN ignora resposta de outra requisição antes de aceitar a correta', async () => {
        const mod = loadContentGeminiModule();
        const listener = event => {
            const { requestId } = event.detail;
            window.dispatchEvent(new CustomEvent('MANGA_TRANSLATOR_FETCH_IMAGE_RESULT', {
                detail: { requestId: 'outra-requisicao', dataUrl: 'data:image/png;base64,RVJSQURP' },
            }));
            setTimeout(() => window.dispatchEvent(new CustomEvent('MANGA_TRANSLATOR_FETCH_IMAGE_RESULT', {
                detail: { requestId, dataUrl: 'data:image/png;base64,Q0VSVE8=' },
            })), 2);
        };
        window.addEventListener('MANGA_TRANSLATOR_FETCH_IMAGE', listener);

        await expect(mod.fetchImageThroughGeminiPage('https://lh3.googleusercontent.com/image')).resolves
            .toBe('data:image/png;base64,Q0VSVE8=');

        window.removeEventListener('MANGA_TRANSLATOR_FETCH_IMAGE', listener);
    });

    test('BGD-09: ponte MAIN expira e remove o listener quando não há resposta', async () => {
        const mod = loadContentGeminiModule();

        await expect(mod.fetchImageThroughGeminiPage('https://lh3.googleusercontent.com/image', 1)).rejects
            .toThrow('Tempo limite ao extrair imagem na página Gemini');
    });

    test('BGD-10: após falha da página Gemini, usa Service Worker autenticado sem abrir aba', async () => {
        const originalSendMessage = chrome.runtime.sendMessage;
        chrome.runtime.sendMessage = jest.fn((message, callback) => {
            if (message.action === 'FETCH_IMAGE_AS_BASE64') {
                callback({ dataUrl: 'data:image/png;base64,U0VSVklDRVdPUktFUg==' });
            }
        });
        const mod = loadContentGeminiModule();
        const pageListener = event => {
            window.dispatchEvent(new CustomEvent('MANGA_TRANSLATOR_FETCH_IMAGE_RESULT', {
                detail: { requestId: event.detail.requestId, error: 'Failed to fetch' },
            }));
        };
        window.addEventListener('MANGA_TRANSLATOR_FETCH_IMAGE', pageListener);

        await expect(mod.extractImageInGeminiTab(null, 'https://lh3.googleusercontent.com/image')).resolves
            .toBe('data:image/png;base64,U0VSVklDRVdPUktFUg==');
        expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(expect.objectContaining({
            action: 'FETCH_IMAGE_AS_BASE64',
            geminiSession: true,
        }), expect.any(Function));

        window.removeEventListener('MANGA_TRANSLATOR_FETCH_IMAGE', pageListener);
        chrome.runtime.sendMessage = originalSendMessage;
    });

    test('BGD-11: preserva conversa após erro somente no background_delete com Debug ativo', async () => {
        const storage = getStorageMock();
        const mod = loadContentGeminiModule();
        const delivery = { action: 'GEMINI_ERROR', error: 'Falha de extração' };

        await storage.set({ debugMode: true });
        await expect(mod.shouldKeepConversationForDebug(delivery, 'background_delete')).resolves.toBe(true);

        await storage.set({ debugMode: false });
        await expect(mod.shouldKeepConversationForDebug(delivery, 'background_delete')).resolves.toBe(false);
        await storage.set({ debugMode: true });
        await expect(mod.shouldKeepConversationForDebug({ action: 'GEMINI_IMAGE_EXTRACTED' }, 'background_delete')).resolves.toBe(false);
        await expect(mod.shouldKeepConversationForDebug(delivery, 'temp_chat')).resolves.toBe(false);
    });

    test('BGD-12: registra host, etapa e causa quando as três rotas diretas falham', async () => {
        const originalSendMessage = chrome.runtime.sendMessage;
        chrome.runtime.sendMessage = jest.fn((message, callback) => {
            if (message.action === 'FETCH_IMAGE_AS_BASE64') {
                callback({ error: 'Failed to fetch' });
            } else if (callback) {
                callback();
            }
        });
        const mod = loadContentGeminiModule();
        const pageListener = event => {
            window.dispatchEvent(new CustomEvent('MANGA_TRANSLATOR_FETCH_IMAGE_RESULT', {
                detail: { requestId: event.detail.requestId, error: 'HTTP 403' },
            }));
        };
        window.addEventListener('MANGA_TRANSLATOR_FETCH_IMAGE', pageListener);

        await expect(mod.extractImageInGeminiTab(null, 'https://lh3.googleusercontent.com/image', 1)).rejects
            .toThrow('Failed to fetch');

        const stageLogs = chrome.runtime.sendMessage.mock.calls
            .map(([message]) => message)
            .filter(message => message.action === 'LOG_ENTRY' && message.action_name === 'GEMINI_EXTRACT_STAGE');
        expect(stageLogs).toEqual(expect.arrayContaining([
            expect.objectContaining({ extra: expect.objectContaining({ host: 'lh3.googleusercontent.com', stage: 'canvas', attempt: 1, failureKind: 'unknown' }) }),
            expect.objectContaining({ extra: expect.objectContaining({ host: 'lh3.googleusercontent.com', stage: 'gemini_page_fetch', attempt: 1, failureKind: 'http' }) }),
            expect.objectContaining({ extra: expect.objectContaining({ host: 'lh3.googleusercontent.com', stage: 'service_worker_session', attempt: 1, failureKind: 'network' }) }),
        ]));

        window.removeEventListener('MANGA_TRANSLATOR_FETCH_IMAGE', pageListener);
        chrome.runtime.sendMessage = originalSendMessage;
    });

    test('BGD-13: repete a cadeia inteira uma vez e recupera uma falha transitória', async () => {
        const originalSendMessage = chrome.runtime.sendMessage;
        let serviceWorkerCalls = 0;
        chrome.runtime.sendMessage = jest.fn((message, callback) => {
            if (message.action === 'FETCH_IMAGE_AS_BASE64') {
                serviceWorkerCalls += 1;
                callback(serviceWorkerCalls === 1
                    ? { error: 'Failed to fetch' }
                    : { dataUrl: 'data:image/png;base64,UkVDVVBFUkFETw==' });
            } else if (callback) {
                callback();
            }
        });
        const mod = loadContentGeminiModule();
        const pageListener = event => {
            window.dispatchEvent(new CustomEvent('MANGA_TRANSLATOR_FETCH_IMAGE_RESULT', {
                detail: { requestId: event.detail.requestId, error: 'Failed to fetch' },
            }));
        };
        window.addEventListener('MANGA_TRANSLATOR_FETCH_IMAGE', pageListener);

        await expect(mod.extractResultImageWithRetry(null, 'https://lh3.googleusercontent.com/image', 'background_delete', 2, 0)).resolves
            .toBe('data:image/png;base64,UkVDVVBFUkFETw==');
        expect(serviceWorkerCalls).toBe(2);
        expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(expect.objectContaining({
            action: 'LOG_ENTRY',
            action_name: 'GEMINI_EXTRACT_RETRY_ALL',
            extra: expect.objectContaining({ host: 'lh3.googleusercontent.com', attempt: 1 }),
        }), expect.any(Function));

        window.removeEventListener('MANGA_TRANSLATOR_FETCH_IMAGE', pageListener);
        chrome.runtime.sendMessage = originalSendMessage;
    });

    test('BGD-14: repete a cadeia direta antes de permitir o último recurso', async () => {
        const originalSendMessage = chrome.runtime.sendMessage;
        let serviceWorkerCalls = 0;
        chrome.runtime.sendMessage = jest.fn((message, callback) => {
            if (message.action === 'FETCH_IMAGE_AS_BASE64') {
                serviceWorkerCalls += 1;
                callback({ error: 'Failed to fetch' });
            } else if (callback) {
                callback();
            }
        });
        const mod = loadContentGeminiModule();
        const pageListener = event => {
            window.dispatchEvent(new CustomEvent('MANGA_TRANSLATOR_FETCH_IMAGE_RESULT', {
                detail: { requestId: event.detail.requestId, error: 'Failed to fetch' },
            }));
        };
        window.addEventListener('MANGA_TRANSLATOR_FETCH_IMAGE', pageListener);

        await expect(mod.extractResultImageWithRetry(null, 'https://lh3.googleusercontent.com/image', 'background_delete', undefined, 0)).rejects
            .toThrow('Failed to fetch');
        expect(serviceWorkerCalls).toBeGreaterThan(1);

        window.removeEventListener('MANGA_TRANSLATOR_FETCH_IMAGE', pageListener);
        chrome.runtime.sendMessage = originalSendMessage;
    });
});

