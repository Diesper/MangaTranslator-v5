const path = require('path');

const { getRuntimeMock, getStorageMock } = require('../../mocks/chrome-api.mock.js');

const CONTENT_GEMINI_PATH = path.resolve(__dirname, '../../../extension/content_gemini.js');
const GEMINI_SELECTORS_PATH = path.resolve(__dirname, '../../../extension/gemini/selectors.js');
const GEMINI_DOM_PATH = path.resolve(__dirname, '../../../extension/gemini/dom.js');
const GEMINI_OBSERVER_PATH = path.resolve(__dirname, '../../../extension/gemini/observer.js');
const GEMINI_EDITOR_PATH = path.resolve(__dirname, '../../../extension/gemini/editor.js');
const GEMINI_TEMP_CHAT_PATH = path.resolve(__dirname, '../../../extension/gemini/temporary-chat.js');

function setWindowLocation(pathname = '/app/chat-1') {
    Object.defineProperty(window, 'location', {
        value: {
            pathname,
            href: `https://gemini.test${pathname}`,
        },
        configurable: true,
        writable: true,
    });
}

function installMissingDomApis() {
    if (typeof window.HTMLElement !== 'undefined' && typeof window.HTMLElement.prototype.scrollIntoView !== 'function') {
        Object.defineProperty(window.HTMLElement.prototype, 'scrollIntoView', {
            value: jest.fn(),
            configurable: true,
            writable: true,
        });
    }

    if (typeof window.PointerEvent !== 'function') {
        window.PointerEvent = window.MouseEvent;
    }
    if (typeof global.PointerEvent !== 'function') {
        global.PointerEvent = window.PointerEvent;
    }

    if (typeof window.DataTransfer !== 'function') {
        class MockDataTransfer {
            constructor() {
                const items = [];
                items.add = (item) => items.push(item);
                this.items = items;
                this._data = new Map();
            }

            setData(type, value) {
                this._data.set(type, value);
            }

            getData(type) {
                return this._data.get(type) || '';
            }
        }

        window.DataTransfer = MockDataTransfer;
    }
    if (typeof global.DataTransfer !== 'function') {
        global.DataTransfer = window.DataTransfer;
    }

    if (typeof window.ClipboardEvent !== 'function') {
        class MockClipboardEvent extends window.Event {
            constructor(type, init = {}) {
                super(type, init);
                this.clipboardData = init.clipboardData || null;
            }
        }

        window.ClipboardEvent = MockClipboardEvent;
    }
    if (typeof global.ClipboardEvent !== 'function') {
        global.ClipboardEvent = window.ClipboardEvent;
    }

    if (typeof window.InputEvent !== 'function') {
        window.InputEvent = window.Event;
    }
    if (typeof global.InputEvent !== 'function') {
        global.InputEvent = window.InputEvent;
    }

    if (typeof global.atob !== 'function') {
        global.atob = (value) => Buffer.from(value, 'base64').toString('binary');
    }
}

function appendGeneratedImage(src) {
    const img = document.createElement('img');
    img.src = src;
    img.scrollIntoView = jest.fn();
    Object.defineProperty(img, 'naturalWidth', { value: 1024, configurable: true });
    Object.defineProperty(img, 'naturalHeight', { value: 1536, configurable: true });
    Object.defineProperty(img, 'complete', { value: true, configurable: true });
    document.body.appendChild(img);
    return img;
}

function mountGeminiEditor({ sendMode = 'exact', onSubmit } = {}) {
    document.body.innerHTML = '<div class="ql-editor" contenteditable="true"><p></p></div><div class="momentary-indicator">conversa momentânea</div>';

    const editor = document.querySelector('.ql-editor');
    editor.focus = jest.fn();
    editor.scrollIntoView = jest.fn();

    editor.addEventListener('paste', (event) => {
        const clipboardData = event.clipboardData;
        const pastedText = clipboardData && typeof clipboardData.getData === 'function'
            ? clipboardData.getData('text/plain')
            : '';

        if (pastedText) {
            const pTag = editor.querySelector('p') || editor;
            pTag.textContent = pastedText;
            return;
        }

        if (clipboardData && clipboardData.items && clipboardData.items.length > 0) {
            let preview = document.querySelector('file-preview');
            if (!preview) {
                preview = document.createElement('file-preview');
                const thumbImg = document.createElement('img');
                thumbImg.src = 'blob:https://gemini.test/mock-attachment';
                preview.appendChild(thumbImg);
                document.body.appendChild(preview);
            }
        }
    });

    editor.addEventListener('keydown', (event) => {
        if (sendMode === 'enter' && event.key === 'Enter') {
            onSubmit();
        }
    });

    let sendButton = null;
    if (sendMode !== 'enter') {
        sendButton = document.createElement('button');
        if (sendMode === 'exact') {
            sendButton.setAttribute('aria-label', 'send message');
        } else {
            sendButton.setAttribute('aria-label', 'enviar agora');
        }
        sendButton.click = jest.fn(() => {
            editor.textContent = '';
            onSubmit();
        });
        document.body.appendChild(sendButton);
    }

    return { editor, sendButton };
}

function delay(ms = 0) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function advance(ms = 0) {
    await delay(ms);
}

async function waitFor(predicate, { timeout = 8000, step = 50 } = {}) {
    let elapsed = 0;
    while (elapsed <= timeout) {
        const result = await predicate();
        if (result) return result;
        await advance(step);
        elapsed += step;
    }
    throw new Error('Timeout aguardando condicao');
}

function collectActions(messages, action) {
    return messages.filter(message => message && message.action === action);
}

function dispatchContentMessage(runtimeMock, request, sender = { tab: null }) {
    return new Promise((resolve) => {
        const listeners = runtimeMock._messageListeners || [];
        if (listeners.length === 0) {
            resolve({ keepAlive: false, response: undefined });
            return;
        }

        let settled = false;
        let keepAlive = false;
        const sendResponse = (response) => {
            settled = true;
            resolve({ keepAlive, response });
        };

        keepAlive = listeners[listeners.length - 1](request, sender, sendResponse);
        if (keepAlive === false && !settled) {
            resolve({ keepAlive, response: undefined });
        }
    });
}

describe('content_gemini.js - RPA real do Gemini', () => {
    let runtimeMock;
    let storageMock;
    let originalSendMessage;
    let originalFetch;
    let sentMessages;
    let consoleErrorSpy;

    beforeEach(async () => {
        jest.resetModules();
        delete window.__mt_gemini_started;

        installMissingDomApis();
        setWindowLocation('/app/chat-1');

        runtimeMock = getRuntimeMock();
        storageMock = getStorageMock();
        originalSendMessage = runtimeMock.sendMessage;
        originalFetch = global.fetch;

        runtimeMock._messageListeners = [];
        runtimeMock._connectListeners = [];
        runtimeMock.lastError = null;
        sentMessages = [];
        consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

        document.documentElement.innerHTML = '<head></head><body></body>';
        await storageMock.clear();
    });

    afterEach(async () => {
        delete window.__mt_gemini_started;
        delete globalThis.__MT_GEMINI_GENERATION_TIMEOUT_MS__;
        runtimeMock.sendMessage = originalSendMessage;
        global.fetch = originalFetch;
        jest.restoreAllMocks();
        await storageMock.clear();
        document.documentElement.innerHTML = '<head></head><body></body>';
    });

    async function loadScript({
        tabId = 321,
        pathname = '/app/chat-1',
        job = {
            mangaTabId: 77,
            index: 5,
            prompt: 'Traduzir tudo para PT-BR',
        },
        storage = {},
        responders = {},
    } = {}) {
        setWindowLocation(pathname);

        if (job) {
            const normalizedJob = {
                jobId: `job-${tabId}`,
                batchId: 'batch-test',
                ...job,
            };
            await storageMock.set({
                [`gemini_job_${tabId}`]: normalizedJob,
                ...storage,
            });
        } else {
            await storageMock.set(storage);
        }

        runtimeMock.sendMessage = jest.fn((message, callback) => {
            sentMessages.push(message);
            const responder = responders[message.action];
            if (typeof callback === 'function') {
                callback(responder ? responder(message) : undefined);
            }
        });

        jest.isolateModules(() => {
            require(GEMINI_SELECTORS_PATH);
            require(GEMINI_DOM_PATH);
            require(GEMINI_OBSERVER_PATH);
            require(GEMINI_EDITOR_PATH);
            require(GEMINI_TEMP_CHAT_PATH);
            require(CONTENT_GEMINI_PATH);
        });

        await advance(0);
        await advance(0);
    }

    test('CG-09/CG-15/CG-18/CG-20/CG-22/CG-26/CG-31/CG-38: processa job com botao exato e extracao HTTP via background', async () => {
        mountGeminiEditor({
            sendMode: 'exact',
            onSubmit: () => {
                setTimeout(() => {
                    appendGeneratedImage('https://cdn.gemini.test/result-001.png?token=signed-secret');
                }, 1300);
            },
        });

        await loadScript({
            storage: { debugMode: true },
            job: {
                mangaTabId: 77,
                index: 5,
                prompt: 'prompt-private-text',
            },
            responders: {
                GET_TAB_ID: () => ({ tabId: 321 }),
                REQUEST_IMAGE_DATA: () => ({ srcData: 'data:image/png;base64,QUJDRA==' }),
                FETCH_IMAGE_AS_BASE64: () => ({ dataUrl: 'data:image/png;base64,UkVTVUxU' }),
            },
        });

        await waitFor(() => collectActions(sentMessages, 'GEMINI_IMAGE_EXTRACTED')[0]);

        const extracted = collectActions(sentMessages, 'GEMINI_IMAGE_EXTRACTED')[0];
        const fetchCall = collectActions(sentMessages, 'FETCH_IMAGE_AS_BASE64')[0];
        const exactLog = sentMessages.find(message =>
            message && message.action === 'LOG_ENTRY' && message.action_name === 'GEMINI_SEND_SUCCESS'
        );
        const imageFoundLog = sentMessages.find(message =>
            message && message.action === 'LOG_ENTRY' && message.action_name === 'GEMINI_IMG_FOUND'
        );
        const promptLog = sentMessages.find(message =>
            message && message.action === 'LOG_ENTRY' && message.action_name === 'PROMPT_INJECTED'
        );

        expect(fetchCall).toEqual(expect.objectContaining({
            action: 'FETCH_IMAGE_AS_BASE64',
            url: 'https://cdn.gemini.test/result-001.png?token=signed-secret',
        }));
        expect(extracted).toEqual(expect.objectContaining({
            action: 'GEMINI_IMAGE_EXTRACTED',
            mangaTabId: 77,
            index: 5,
            src: 'data:image/png;base64,UkVTVUxU',
        }));
        expect(exactLog).toEqual(expect.objectContaining({
            action: 'LOG_ENTRY',
            action_name: 'GEMINI_SEND_SUCCESS',
        }));
        expect(imageFoundLog.extra).toEqual({ urlKind: '[redacted]', host: 'cdn.gemini.test', hasQuery: true });
        expect(JSON.stringify(imageFoundLog)).not.toContain('signed-secret');
        expect(promptLog.extra).toEqual({ promptLen: '[redacted]' });
        expect(JSON.stringify(promptLog)).not.toContain('prompt-private-text');
    });

    test('CG-37: processa resultado blob sem usar o fallback do background', async () => {
        mountGeminiEditor({
            sendMode: 'exact',
            onSubmit: () => {
                setTimeout(() => {
                    appendGeneratedImage('blob:generated-result');
                }, 1300);
            },
        });

        global.fetch = jest.fn(async (url) => ({
            blob: async () => new Blob(['BLOB_OK'], { type: 'image/png' }),
        }));

        await loadScript({
            storage: { debugMode: true },
            responders: {
                GET_TAB_ID: () => ({ tabId: 321 }),
                REQUEST_IMAGE_DATA: () => ({ srcData: 'data:image/png;base64,QUJDRA==' }),
            },
        });

        await waitFor(() => collectActions(sentMessages, 'GEMINI_IMAGE_EXTRACTED')[0]);

        const extracted = collectActions(sentMessages, 'GEMINI_IMAGE_EXTRACTED')[0];
        expect(global.fetch).toHaveBeenCalledWith('blob:generated-result');
        expect(collectActions(sentMessages, 'FETCH_IMAGE_AS_BASE64')).toHaveLength(0);
        expect(extracted).toEqual(expect.objectContaining({
            action: 'GEMINI_IMAGE_EXTRACTED',
            mangaTabId: 77,
            index: 5,
            src: expect.stringMatching(/^data:image\/png;base64,/),
        }));
    });

    test('CG-25: usa o prompt de emergencia quando o job chega sem prompt valido', async () => {
        mountGeminiEditor({
            sendMode: 'exact',
            onSubmit: () => {
                setTimeout(() => {
                    appendGeneratedImage('https://cdn.gemini.test/result-fallback-prompt.png');
                }, 1300);
            },
        });

        await loadScript({
            storage: { debugMode: true },
            job: {
                mangaTabId: 77,
                index: 8,
                prompt: '   ',
            },
            responders: {
                GET_TAB_ID: () => ({ tabId: 321 }),
                REQUEST_IMAGE_DATA: () => ({ srcData: 'data:image/png;base64,QUJDRA==' }),
                FETCH_IMAGE_AS_BASE64: () => ({ dataUrl: 'data:image/png;base64,UFJPTVBUX09L' }),
            },
        });

        await waitFor(() => collectActions(sentMessages, 'GEMINI_IMAGE_EXTRACTED')[0]);

        const promptFallbackLog = sentMessages.find(message =>
            message && message.action === 'LOG_ENTRY' && message.action_name === 'PROMPT_FALLBACK'
        );

        expect(promptFallbackLog).toEqual(expect.objectContaining({
            action: 'LOG_ENTRY',
            action_name: 'PROMPT_FALLBACK',
        }));
        expect(promptFallbackLog.extra).toEqual(expect.objectContaining({ fallbackLength: expect.any(Number) }));
        expect(promptFallbackLog.extra).not.toHaveProperty('fallbackPrompt');
        expect(collectActions(sentMessages, 'GEMINI_IMAGE_EXTRACTED')[0]).toEqual(expect.objectContaining({
            action: 'GEMINI_IMAGE_EXTRACTED',
            mangaTabId: 77,
            index: 8,
        }));
    });

    test('CG-16: envia GEMINI_ERROR quando a aba de manga nao devolve a imagem', async () => {
        document.body.innerHTML = '<div class="ql-editor" contenteditable="true"></div>';

        await loadScript({
            responders: {
                GET_TAB_ID: () => ({ tabId: 321 }),
                REQUEST_IMAGE_DATA: () => undefined,
            },
        });

        await waitFor(() => collectActions(sentMessages, 'GEMINI_ERROR')[0]);

        expect(collectActions(sentMessages, 'GEMINI_ERROR')[0]).toEqual(expect.objectContaining({
            action: 'GEMINI_ERROR',
            mangaTabId: 77,
            index: 5,
            error: expect.stringContaining('Sem resposta da aba do mangá'),
        }));
    });

    test('CG-12/CG-13: nao reivindica job de outra aba ao abrir Gemini manualmente', async () => {
        document.body.innerHTML = '<div class="ql-editor" contenteditable="true"></div>';

        await loadScript({
            job: null,
            storage: {
                gemini_job_999: {
                    mangaTabId: 77,
                    index: 12,
                    prompt: 'Traducao orfa',
                    geminiTabId: 999,
                },
            },
            responders: {
                GET_TAB_ID: () => ({ tabId: 321 }),
                REQUEST_IMAGE_DATA: () => undefined,
            },
        });

        await advance(800);

        const data = await storageMock.get(null);
        expect(data.gemini_job_321).toBeUndefined();
        expect(data.gemini_job_999).toEqual(expect.objectContaining({
            mangaTabId: 77,
            index: 12,
            prompt: 'Traducao orfa',
        }));
        expect(collectActions(sentMessages, 'REQUEST_IMAGE_DATA')).toHaveLength(0);
        expect(collectActions(sentMessages, 'GEMINI_ERROR')).toHaveLength(0);
    });

    test('CG-30/CG-39: usa fallback MAIN-world e GEMINI_RESULT_URL quando a extracao HTTP falha', async () => {
        mountGeminiEditor({ sendMode: 'enter', onSubmit: () => {} });
        const triggerSend = jest.fn(() => {
            const editor = document.querySelector('.ql-editor');
            if (editor) editor.textContent = '';
            setTimeout(() => {
                appendGeneratedImage('https://cdn.gemini.test/result-fallback.png');
            }, 1300);
        });
        window.addEventListener('MANGA_TRANSLATOR_TRIGGER_SEND', triggerSend, { once: true });

        await loadScript({
            storage: { debugMode: true },
            responders: {
                GET_TAB_ID: () => ({ tabId: 321 }),
                REQUEST_IMAGE_DATA: () => ({ srcData: 'data:image/png;base64,QUJDRA==' }),
                FETCH_IMAGE_AS_BASE64: () => ({}),
            },
        });

        await waitFor(() => collectActions(sentMessages, 'GEMINI_RESULT_URL')[0], { timeout: 35000 });

        const fallback = collectActions(sentMessages, 'GEMINI_RESULT_URL')[0];
        const fallbackLog = sentMessages.find(message =>
            message && message.action === 'LOG_ENTRY' && message.action_name === 'GEMINI_SEND_FALLBACK'
        );

        expect(fallback).toEqual(expect.objectContaining({
            action: 'GEMINI_RESULT_URL',
            mangaTabId: 77,
            index: 5,
            url: 'https://cdn.gemini.test/result-fallback.png',
        }));
        expect(triggerSend).toHaveBeenCalledTimes(1);
        expect(fallbackLog).toEqual(expect.objectContaining({
            action: 'LOG_ENTRY',
            action_name: 'GEMINI_SEND_FALLBACK',
        }));
    }, 40000);

    test('CG-27/CG-35: detecta erro da UI e encaminha GEMINI_ERROR', async () => {
        mountGeminiEditor({
            sendMode: 'fuzzy',
            onSubmit: () => {
                const alert = document.createElement('div');
                alert.setAttribute('role', 'alert');
                alert.innerText = 'Falha do Gemini';
                // O Observer V2 exige visibilidade real. JSDOM não calcula
                // layout, então a fixture precisa representar um alerta que
                // ocuparia espaço na página em vez de enfraquecer a regra de produção.
                alert.getBoundingClientRect = () => ({
                    x: 0, y: 0, top: 0, left: 0,
                    right: 320, bottom: 48, width: 320, height: 48,
                    toJSON() { return this; },
                });
                document.body.appendChild(alert);
            },
        });

        await loadScript({
            storage: { debugMode: true },
            responders: {
                GET_TAB_ID: () => ({ tabId: 321 }),
                REQUEST_IMAGE_DATA: () => ({ srcData: 'data:image/png;base64,QUJDRA==' }),
            },
        });

        await waitFor(() => collectActions(sentMessages, 'GEMINI_ERROR')[0]);

        expect(collectActions(sentMessages, 'GEMINI_ERROR')[0]).toEqual(expect.objectContaining({
            action: 'GEMINI_ERROR',
            mangaTabId: 77,
            index: 5,
            error: expect.stringContaining('Retornou erro interface'),
        }));
        const errorLog = sentMessages.find(message =>
            message && message.action === 'LOG_ENTRY' && message.action_name === 'GEMINI_ERROR'
        );
        expect(errorLog).toEqual(expect.objectContaining({
            action: 'LOG_ENTRY',
            action_name: 'GEMINI_ERROR',
            level: 'error',
        }));
    });

    test('CG-36: encerra com GEMINI_ERROR quando o Observer V2 estoura o timeout de geração', async () => {
        mountGeminiEditor({
            sendMode: 'exact',
            onSubmit: () => {},
        });
        globalThis.__MT_GEMINI_GENERATION_TIMEOUT_MS__ = 80;

        await loadScript({
            storage: { debugMode: true },
            responders: {
                GET_TAB_ID: () => ({ tabId: 321 }),
                REQUEST_IMAGE_DATA: () => ({ srcData: 'data:image/png;base64,QUJDRA==' }),
            },
        });

        await waitFor(() => collectActions(sentMessages, 'GEMINI_ERROR')[0], { timeout: 12000 });

        const timeoutLog = sentMessages.find(message =>
            message && message.action === 'LOG_ENTRY' && message.action_name === 'GEMINI_TIMEOUT'
        );

        expect(collectActions(sentMessages, 'GEMINI_ERROR')[0]).toEqual(expect.objectContaining({
            action: 'GEMINI_ERROR',
            mangaTabId: 77,
            index: 5,
            error: 'Tempo limite (4 min)',
        }));
        expect(timeoutLog).toEqual(expect.objectContaining({
            action: 'LOG_ENTRY',
            action_name: 'GEMINI_TIMEOUT',
        }));
    });

    test('CG-43/CG-52/CG-53: handler DELETE_CONVERSATION responde ok em modo debug', async () => {
        document.body.innerHTML = '<div class="ql-editor" contenteditable="true"></div>';

        await loadScript({
            job: null,
            storage: { debugMode: true },
            responders: {
                GET_TAB_ID: () => undefined,
            },
        });

        const result = await dispatchContentMessage(runtimeMock, { action: 'DELETE_CONVERSATION' });
        const debugLog = sentMessages.find(message =>
            message && message.action === 'LOG_ENTRY' && message.action_name === 'DEBUG_MODE_SKIP'
        );

        expect(result.keepAlive).toBe(true);
        expect(result.response).toEqual({ ok: true });
        expect(debugLog).toEqual(expect.objectContaining({
            action: 'LOG_ENTRY',
            action_name: 'DEBUG_MODE_SKIP',
        }));
    });

    test('CG-44/CG-48/CG-49/CG-52/CG-53: handler DELETE_CONVERSATION percorre o DOM e confirma a exclusao', async () => {
        document.body.innerHTML = `
            <div id="conversation-row">
                <a href="/app/chat-1">Conversa atual</a>
                <button id="options-btn" aria-haspopup="menu" aria-label="opções">...</button>
            </div>
            <div id="delete-item" role="menuitem">Excluir</div>
            <button id="confirm-delete">Excluir</button>
        `;

        const optionsBtn = document.getElementById('options-btn');
        const deleteItem = document.getElementById('delete-item');
        const confirmBtn = document.getElementById('confirm-delete');

        optionsBtn.scrollIntoView = jest.fn();
        optionsBtn.click = jest.fn();
        deleteItem.click = jest.fn();
        confirmBtn.click = jest.fn();

        await loadScript({
            job: null,
            responders: {
                GET_TAB_ID: () => undefined,
            },
        });

        const result = await dispatchContentMessage(runtimeMock, { action: 'DELETE_CONVERSATION' });
        const deleteOkLog = sentMessages.find(message =>
            message && message.action === 'LOG_ENTRY' && message.action_name === 'DELETE_OK'
        );

        expect(result.keepAlive).toBe(true);
        expect(result.response).toEqual({ ok: true });
        expect(optionsBtn.click).toHaveBeenCalled();
        expect(deleteItem.click).toHaveBeenCalled();
        expect(confirmBtn.click).toHaveBeenCalled();
        expect(deleteOkLog).toEqual(expect.objectContaining({
            action: 'LOG_ENTRY',
            action_name: 'DELETE_OK',
        }));
    });
});

