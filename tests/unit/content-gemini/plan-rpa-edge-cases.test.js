const { getRuntimeMock, getStorageMock } = require('../../mocks/chrome-api.mock.js');
const { loadContentGeminiModule } = require('../../helpers/load-content-gemini-module.js');

function setWindowLocation(pathname = '/app/chat-1') {
    Object.defineProperty(window, 'location', {
        value: {
            pathname,
            href: `https://gemini.test${pathname}`,
            origin: 'https://gemini.test',
        },
        configurable: true,
        writable: true,
    });
}

function installDomApis() {
    if (typeof window.HTMLElement !== 'undefined' && typeof window.HTMLElement.prototype.scrollIntoView !== 'function') {
        Object.defineProperty(window.HTMLElement.prototype, 'scrollIntoView', {
            value: jest.fn(),
            configurable: true,
            writable: true,
        });
    }

    if (typeof window.PointerEvent !== 'function') window.PointerEvent = window.MouseEvent;
    if (typeof global.PointerEvent !== 'function') global.PointerEvent = window.PointerEvent;
    if (typeof global.File !== 'function') global.File = window.File;
    if (typeof global.Blob !== 'function') global.Blob = window.Blob;
    if (typeof global.FileReader !== 'function') global.FileReader = window.FileReader;

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
    if (typeof global.DataTransfer !== 'function') global.DataTransfer = window.DataTransfer;

    if (typeof window.ClipboardEvent !== 'function') {
        class MockClipboardEvent extends window.Event {
            constructor(type, init = {}) {
                super(type, init);
                this.clipboardData = init.clipboardData || null;
            }
        }
        window.ClipboardEvent = MockClipboardEvent;
    }
    if (typeof global.ClipboardEvent !== 'function') global.ClipboardEvent = window.ClipboardEvent;

    if (typeof window.InputEvent !== 'function') window.InputEvent = window.Event;
    if (typeof global.InputEvent !== 'function') global.InputEvent = window.InputEvent;
    if (typeof global.atob !== 'function') {
        global.atob = (value) => Buffer.from(value, 'base64').toString('binary');
    }
}

function delay(ms = 0) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitFor(predicate, { timeout = 9000, step = 25 } = {}) {
    let elapsed = 0;
    while (elapsed <= timeout) {
        // eslint-disable-next-line no-await-in-loop
        const result = await predicate();
        if (result) return result;
        // eslint-disable-next-line no-await-in-loop
        await delay(step);
        elapsed += step;
    }
    throw new Error('Timeout aguardando condicao');
}

function defineImageMetrics(img, { width = 1024, height = 1536, complete = true } = {}) {
    img.scrollIntoView = jest.fn();
    Object.defineProperty(img, 'naturalWidth', { value: width, configurable: true });
    Object.defineProperty(img, 'naturalHeight', { value: height, configurable: true });
    Object.defineProperty(img, 'complete', { value: complete, configurable: true });
}

function appendImage(src, metrics = {}) {
    const img = document.createElement('img');
    img.src = src;
    defineImageMetrics(img, metrics);
    document.body.appendChild(img);
    return img;
}

function mountEditor({
    disabled = false,
    attachThumbnail = true,
    onSubmit = () => {},
} = {}) {
    if (!document.querySelector('.momentary-indicator')) {
        const indicator = document.createElement('div');
        indicator.className = 'momentary-indicator';
        indicator.textContent = 'conversa momentânea';
        document.body.appendChild(indicator);
    }

    const editor = document.createElement('div');
    editor.className = 'ql-editor';
    editor.setAttribute('contenteditable', 'true');
    if (disabled) editor.setAttribute('aria-disabled', 'true');
    editor.innerHTML = '<p></p>';
    editor.focus = jest.fn();
    editor.scrollIntoView = jest.fn();

    editor.addEventListener('paste', (event) => {
        const dt = event.clipboardData;
        const text = dt && typeof dt.getData === 'function' ? dt.getData('text/plain') : '';

        if (text) {
            editor.querySelector('p').textContent = text;
            return;
        }

        if (attachThumbnail && dt?.items?.length) {
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

    document.body.appendChild(editor);
    return editor;
}

function appendSendButton({
    label = 'send message',
    disabled = false,
    hidden = false,
    onSubmit = () => {},
} = {}) {
    const button = document.createElement('button');
    button.setAttribute('aria-label', label);
    button.disabled = disabled;
    if (hidden) button.style.display = 'none';
    button.click = jest.fn(() => {
        const editor = document.querySelector('.ql-editor, [contenteditable="true"]');
        if (editor) editor.textContent = '';
        onSubmit();
    });
    document.body.appendChild(button);
    return button;
}

describe('content_gemini.js - bordas RPA do plano v3.1', () => {
    let runtimeMock;
    let storageMock;
    let originalSendMessage;
    let sentMessages;

    beforeEach(async () => {
        jest.resetModules();
        installDomApis();
        setWindowLocation('/app/chat-1');

        runtimeMock = getRuntimeMock();
        storageMock = getStorageMock();
        originalSendMessage = runtimeMock.sendMessage;
        sentMessages = [];

        runtimeMock._messageListeners = [];
        runtimeMock._connectListeners = [];
        runtimeMock.lastError = null;

        document.documentElement.innerHTML = '<head></head><body></body>';
        await storageMock.clear();
    });

    afterEach(async () => {
        runtimeMock.sendMessage = originalSendMessage;
        jest.useRealTimers();
        jest.restoreAllMocks();
        document.documentElement.innerHTML = '<head></head><body></body>';
        await storageMock.clear();
    });

    function installResponder(responders = {}) {
        runtimeMock.sendMessage = jest.fn((message, callback) => {
            sentMessages.push(message);
            const responder = responders[message.action];
            if (typeof callback === 'function') {
                setTimeout(() => callback(responder ? responder(message) : undefined), 0);
            }
        });
    }

    async function seedJob(job = {}) {
        await storageMock.set({
            gemini_job_321: {
                jobId: 'job-321',
                batchId: 'batch-test',
                mangaTabId: 77,
                index: 5,
                prompt: 'Traduzir borda do plano',
                ...job,
            },
        });
    }

    test('CG-10: job registrado tardiamente ainda e encontrado pelo loop de tentativas', async () => {
        mountEditor();
        installResponder({
            GET_TAB_ID: () => ({ tabId: 321 }),
            REQUEST_IMAGE_DATA: () => undefined,
        });

        const mod = loadContentGeminiModule();
        mod.processGeminiJob();

        setTimeout(() => {
            storageMock.set({
                gemini_job_321: {
                    jobId: 'job-321-late',
                    batchId: 'batch-test',
                    mangaTabId: 77,
                    index: 10,
                    prompt: 'Job tardio',
                },
            });
        }, 650);

        await waitFor(() => sentMessages.find(message =>
            message.action === 'REQUEST_IMAGE_DATA' && message.index === 10
        ), { timeout: 2500 });
        await waitFor(() => sentMessages.find(message =>
            message.action === 'GEMINI_ERROR' && message.index === 10
        ), { timeout: 1000 });
    });

    test('CG-11: sem job apos 30 tentativas registra JOB_NOT_FOUND e encerra sem crash', async () => {
        setWindowLocation('/new-chat');
        mountEditor();
        installResponder({
            GET_TAB_ID: () => ({ tabId: 321 }),
        });

        const mod = loadContentGeminiModule();
        mod.processGeminiJob();

        const notFoundLog = await waitFor(() => sentMessages.find(message =>
            message.action === 'LOG_ENTRY' && message.action_name === 'JOB_NOT_FOUND'
        ), { timeout: 17000, step: 100 });

        expect(notFoundLog).toEqual(expect.objectContaining({
            action: 'LOG_ENTRY',
            action_name: 'JOB_NOT_FOUND',
            level: 'warn',
        }));
        expect(sentMessages.some(message => message.action === 'REQUEST_IMAGE_DATA')).toBe(false);
        expect(sentMessages.some(message => message.action === 'GEMINI_ERROR')).toBe(false);
    }, 20000);

    test('CG-17: REQUEST_IMAGE_DATA com payload que nao e imagem gera GEMINI_ERROR', async () => {
        await seedJob();
        installResponder({
            GET_TAB_ID: () => ({ tabId: 321 }),
            REQUEST_IMAGE_DATA: () => ({ srcData: 'texto puro' }),
        });

        const mod = loadContentGeminiModule();
        mod.processGeminiJob();

        const error = await waitFor(() => sentMessages.find(message => message.action === 'GEMINI_ERROR'));
        expect(error).toEqual(expect.objectContaining({
            mangaTabId: 77,
            index: 5,
            error: expect.stringContaining('Os dados não são imagem válida'),
        }));
    });

    test('REG-12/CG-19/CG-40: editor desabilitado aborta o RPA e limpa o scrollInterval', async () => {
        mountEditor({ disabled: true });
        const clearIntervalSpy = jest.spyOn(global, 'clearInterval');
        await seedJob();
        installResponder({
            GET_TAB_ID: () => ({ tabId: 321 }),
            REQUEST_IMAGE_DATA: () => ({ srcData: 'data:image/png;base64,QUJDRA==' }),
        });

        const mod = loadContentGeminiModule();
        mod.processGeminiJob();

        const error = await waitFor(() => sentMessages.find(message => message.action === 'GEMINI_ERROR'));
        expect(error.error).toContain('Editor do Gemini está desabilitado');
        expect(clearIntervalSpy).toHaveBeenCalled();
    });

    test('CG-21: ausencia de thumbnail apos paste gera GEMINI_ERROR', async () => {
        mountEditor({ attachThumbnail: false });
        await seedJob();
        jest.useFakeTimers();
        installResponder({
            GET_TAB_ID: () => ({ tabId: 321 }),
            REQUEST_IMAGE_DATA: () => ({ srcData: 'data:image/png;base64,QUJDRA==' }),
        });

        const mod = loadContentGeminiModule();
        mod.processGeminiJob();

        for (let i = 0; i < 40; i += 1) {
            // eslint-disable-next-line no-await-in-loop
            await jest.advanceTimersByTimeAsync(500);
        }

        const error = sentMessages.find(message => message.action === 'GEMINI_ERROR');
        expect(error).toEqual(expect.objectContaining({
            error: expect.stringContaining('Thumb (imagem enviada) não foi encontrado'),
        }));
    });

    test('CG-28/CG-29: botoes desabilitados ou ocultos sao ignorados ate achar botao valido', async () => {
        let submitted = false;
        mountEditor();
        const disabledButton = appendSendButton({ disabled: true });
        const hiddenButton = appendSendButton({ label: 'enviar agora', hidden: true });
        const validButton = appendSendButton({
            label: 'send message',
            onSubmit: () => {
                submitted = true;
                setTimeout(() => appendImage('https://cdn.gemini.test/result-valid-button.png'), 1300);
            },
        });

        await seedJob();
        installResponder({
            GET_TAB_ID: () => ({ tabId: 321 }),
            REQUEST_IMAGE_DATA: () => ({ srcData: 'data:image/png;base64,QUJDRA==' }),
            FETCH_IMAGE_AS_BASE64: () => ({ dataUrl: 'data:image/png;base64,UkVTVUxU' }),
        });

        const mod = loadContentGeminiModule();
        mod.processGeminiJob();

        await waitFor(() => sentMessages.find(message => message.action === 'GEMINI_IMAGE_EXTRACTED'));

        expect(submitted).toBe(true);
        expect(disabledButton.click).not.toHaveBeenCalled();
        expect(hiddenButton.click).not.toHaveBeenCalled();
        expect(validButton.click).toHaveBeenCalled();
    }, 12000);

    test('CG-32/CG-33/CG-34: ignora imagem preexistente, avatar e imagem pequena antes de aceitar resultado valido', async () => {
        appendImage('https://cdn.gemini.test/pre-existing.png');
        mountEditor();
        appendSendButton({
            onSubmit: () => {
                setTimeout(() => {
                    appendImage('https://cdn.gemini.test/avatar-user.png');
                    appendImage('https://cdn.gemini.test/tiny-result.png', { width: 50, height: 50 });
                    appendImage('https://cdn.gemini.test/final-result.png', { width: 900, height: 1200 });
                }, 1300);
            },
        });

        await seedJob();
        installResponder({
            GET_TAB_ID: () => ({ tabId: 321 }),
            REQUEST_IMAGE_DATA: () => ({ srcData: 'data:image/png;base64,QUJDRA==' }),
            FETCH_IMAGE_AS_BASE64: (message) => ({ dataUrl: `data:image/png;base64,${Buffer.from(message.url).toString('base64')}` }),
        });

        const mod = loadContentGeminiModule();
        mod.processGeminiJob();

        const fetch = await waitFor(() => sentMessages.find(message =>
            message.action === 'FETCH_IMAGE_AS_BASE64'
        ));
        const extracted = await waitFor(() => sentMessages.find(message =>
            message.action === 'GEMINI_IMAGE_EXTRACTED'
        ));

        expect(fetch.url).toBe('https://cdn.gemini.test/final-result.png');
        expect(extracted.src).toBe(`data:image/png;base64,${Buffer.from('https://cdn.gemini.test/final-result.png').toString('base64')}`);
    }, 12000);

    test('aceita imagem gerada em proporcao extrema como 60x1024', async () => {
        mountEditor();
        appendSendButton({
            onSubmit: () => {
                setTimeout(() => appendImage('https://cdn.gemini.test/tall-thin-result.png', { width: 60, height: 1024 }), 1300);
            },
        });

        await seedJob();
        installResponder({
            GET_TAB_ID: () => ({ tabId: 321 }),
            REQUEST_IMAGE_DATA: () => ({ srcData: 'data:image/png;base64,QUJDRA==' }),
            FETCH_IMAGE_AS_BASE64: (message) => ({ dataUrl: `data:image/png;base64,${Buffer.from(message.url).toString('base64')}` }),
        });

        const mod = loadContentGeminiModule();
        mod.processGeminiJob();

        const fetch = await waitFor(() => sentMessages.find(message =>
            message.action === 'FETCH_IMAGE_AS_BASE64'
        ));
        const extracted = await waitFor(() => sentMessages.find(message =>
            message.action === 'GEMINI_IMAGE_EXTRACTED'
        ));

        expect(fetch.url).toBe('https://cdn.gemini.test/tall-thin-result.png');
        expect(extracted.src).toBe(`data:image/png;base64,${Buffer.from('https://cdn.gemini.test/tall-thin-result.png').toString('base64')}`);
        expect(sentMessages).toContainEqual(expect.objectContaining({
            action: 'LOG_ENTRY',
            action_name: 'GEMINI_IMG_FOUND',
        }));
    }, 12000);

    test('painel manual do Gemini permite marcar imagem gerada que a heuristica automatica rejeitaria', async () => {
        let manualImage = null;
        mountEditor();
        appendSendButton({
            onSubmit: () => {
                setTimeout(() => {
                    manualImage = appendImage('https://cdn.gemini.test/manual-result.png', { width: 30, height: 1024 });
                }, 1300);
            },
        });

        await seedJob();
        installResponder({
            GET_TAB_ID: () => ({ tabId: 321 }),
            REQUEST_IMAGE_DATA: () => ({ srcData: 'data:image/png;base64,QUJDRA==' }),
            FETCH_IMAGE_AS_BASE64: (message) => ({ dataUrl: `data:image/png;base64,${Buffer.from(message.url).toString('base64')}` }),
        });

        const mod = loadContentGeminiModule();
        mod.processGeminiJob();

        const panel = await waitFor(() => document.getElementById('mt-gemini-assist'));
        await waitFor(() => manualImage);
        panel.querySelector('#mt-gemini-pick').click();
        manualImage.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));

        const fetch = await waitFor(() => sentMessages.find(message =>
            message.action === 'FETCH_IMAGE_AS_BASE64'
        ), { timeout: 4000 });
        const manualLog = await waitFor(() => sentMessages.find(message =>
            message.action === 'LOG_ENTRY' && message.action_name === 'GEMINI_MANUAL_RESULT'
        ), { timeout: 1000 });

        expect(fetch.url).toBe('https://cdn.gemini.test/manual-result.png');
        expect(manualLog.extra).toEqual(expect.objectContaining({ source: 'image-click' }));
    }, 12000);

    test('CG-41: sucesso chama deleteCurrentConversation e confirma exclusao quando debugMode esta desligado', async () => {
        mountEditor();
        appendSendButton({
            onSubmit: () => {
                setTimeout(() => appendImage('https://cdn.gemini.test/result-delete-after-success.png'), 1300);
            },
        });
        document.body.insertAdjacentHTML('beforeend', `
            <div id="conversation-row">
                <a href="/app/chat-1">Conversa atual</a>
                <button id="options-btn" aria-haspopup="menu" aria-label="opções">...</button>
            </div>
            <div id="delete-item" role="menuitem">Excluir conversa</div>
            <button id="confirm-delete">Excluir</button>
        `);
        document.getElementById('options-btn').scrollIntoView = jest.fn();
        document.getElementById('options-btn').click = jest.fn();
        document.getElementById('delete-item').click = jest.fn();
        document.getElementById('confirm-delete').click = jest.fn();

        await seedJob();
        await storageMock.set({ debugMode: false, geminiExecutionMode: 'minimized_window' });
        installResponder({
            GET_TAB_ID: () => ({ tabId: 321 }),
            REQUEST_IMAGE_DATA: () => ({ srcData: 'data:image/png;base64,QUJDRA==' }),
            FETCH_IMAGE_AS_BASE64: () => ({ dataUrl: 'data:image/png;base64,UkVTVUxU' }),
        });

        const mod = loadContentGeminiModule();
        mod.processGeminiJob();

        await waitFor(() => sentMessages.find(message => message.action === 'GEMINI_IMAGE_EXTRACTED'), { timeout: 12000 });
        await waitFor(() => sentMessages.find(message =>
            message.action === 'LOG_ENTRY' && message.action_name === 'DELETE_OK'
        ), { timeout: 4000 });

        expect(document.getElementById('options-btn').click).toHaveBeenCalled();
        expect(document.getElementById('delete-item').click).toHaveBeenCalled();
        expect(document.getElementById('confirm-delete').click).toHaveBeenCalled();
    }, 16000);
});
