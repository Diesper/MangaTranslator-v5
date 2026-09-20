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
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate, { timeout = 5000, step = 25 } = {}) {
    let elapsed = 0;
    while (elapsed <= timeout) {
        const result = await predicate();
        if (result) return result;
        await delay(step);
        elapsed += step;
    }
    throw new Error('Timeout aguardando condicao');
}

function mountGeminiEditor({
    sendMode = 'exact',
    promptPasteBehavior = 'insert',
    onSubmit = () => {},
} = {}) {
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
            if (promptPasteBehavior === 'insert') {
                const pTag = editor.querySelector('p') || editor;
                pTag.textContent = pastedText;
            }
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
        if (sendMode === 'enter' && event.key === 'Enter') onSubmit();
    });

    let sendButton = null;
    if (sendMode !== 'enter') {
        sendButton = document.createElement('button');
        sendButton.setAttribute('aria-label', sendMode === 'fuzzy' ? 'enviar agora' : 'send message');
        sendButton.click = jest.fn(() => {
            editor.textContent = '';
            onSubmit();
        });
        document.body.appendChild(sendButton);
    }

    return { editor, sendButton };
}

function appendGeneratedImage(src, { width = 1024, height = 1536 } = {}) {
    const img = document.createElement('img');
    img.src = src;
    img.scrollIntoView = jest.fn();
    Object.defineProperty(img, 'naturalWidth', { value: width, configurable: true });
    Object.defineProperty(img, 'naturalHeight', { value: height, configurable: true });
    Object.defineProperty(img, 'complete', { value: true, configurable: true });
    document.body.appendChild(img);
    return img;
}

describe('content_gemini.js - helpers, delecao e regressao real', () => {
    let runtimeMock;
    let storageMock;
    let sentMessages;
    let originalSendMessage;
    let originalFetch;

    beforeEach(async () => {
        jest.resetModules();
        installDomApis();
        setWindowLocation('/app/chat-1');

        runtimeMock = getRuntimeMock();
        storageMock = getStorageMock();
        originalSendMessage = runtimeMock.sendMessage;
        originalFetch = global.fetch;
        sentMessages = [];

        runtimeMock._messageListeners = [];
        runtimeMock._connectListeners = [];
        runtimeMock.lastError = null;

        document.documentElement.innerHTML = '<head></head><body></body>';
        if (typeof document.execCommand !== 'function') {
            document.execCommand = () => false;
        }
        await storageMock.clear();
    });

    afterEach(async () => {
        runtimeMock.sendMessage = originalSendMessage;
        global.fetch = originalFetch;
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

    test('CG-01/CG-02: dataURLtoFile cria File com MIME correto para PNG e JPEG', () => {
        const mod = loadContentGeminiModule();

        const png = mod.dataURLtoFile('data:image/png;base64,QUJDRA==', 'page.png');
        const jpg = mod.dataURLtoFile('data:image/jpeg;base64,QUJDRA==', 'page.jpg');

        expect(png).toBeInstanceOf(File);
        expect(png.type).toBe('image/png');
        expect(png.size).toBeGreaterThan(0);
        expect(jpg.type).toBe('image/jpeg');
    });

    test('CG-03/CG-04: dataURLtoFile rejeita dataURL sem virgula ou sem MIME', () => {
        const mod = loadContentGeminiModule();

        expect(() => mod.dataURLtoFile('data:image/png;base64QUJDRA==', 'broken.png')).toThrow('dataURL malformada: sem vírgula');
        expect(() => mod.dataURLtoFile('data:;base64,QUJDRA==', 'broken.png')).toThrow('dataURL malformada: MIME não encontrado');
    });

    test('CG-05/CG-06/CG-07: waitForElement resolve imediato, resolve tardio e retorna null no timeout', async () => {
        const mod = loadContentGeminiModule();

        document.body.innerHTML = '<div class="already-here"></div>';
        await expect(mod.waitForElement('.already-here', 50)).resolves.toBe(document.querySelector('.already-here'));

        setTimeout(() => {
            const late = document.createElement('span');
            late.className = 'late-node';
            document.body.appendChild(late);
        }, 120);

        const lateEl = await mod.waitForElement('.late-node', 600);
        expect(lateEl).toBe(document.querySelector('.late-node'));
        await expect(mod.waitForElement('.never-here', 120)).resolves.toBeNull();
    });

    test('CG-08: sleep resolve apenas depois do tempo solicitado', async () => {
        jest.useFakeTimers();
        const mod = loadContentGeminiModule();
        const marker = jest.fn();

        const pending = mod.sleep(100).then(marker);
        await jest.advanceTimersByTimeAsync(99);
        expect(marker).not.toHaveBeenCalled();

        await jest.advanceTimersByTimeAsync(1);
        await pending;

        expect(marker).toHaveBeenCalledTimes(1);
        jest.useRealTimers();
    });

    test('REG-03/CG-22: paste valido nao chama execCommand em duplicidade', async () => {
        mountGeminiEditor({
            sendMode: 'exact',
            promptPasteBehavior: 'insert',
            onSubmit: () => {
                setTimeout(() => appendGeneratedImage('https://cdn.gemini.test/result-reg-03.png'), 1300);
            },
        });

        await storageMock.set({
            gemini_job_321: {
                jobId: 'job-321',
                batchId: 'batch-test',
                mangaTabId: 77,
                index: 4,
                prompt: 'Traduzir sem duplicar texto',
            },
        });

        installResponder({
            GET_TAB_ID: () => ({ tabId: 321 }),
            REQUEST_IMAGE_DATA: () => ({ srcData: 'data:image/png;base64,QUJDRA==' }),
            FETCH_IMAGE_AS_BASE64: () => ({ dataUrl: 'data:image/png;base64,UkVTVUxU' }),
        });

        const execCommandSpy = jest.spyOn(document, 'execCommand').mockReturnValue(true);
        const mod = loadContentGeminiModule();
        mod.processGeminiJob();

        await waitFor(() => (
            document.querySelector('.ql-editor')
            && document.querySelector('.ql-editor').textContent.includes('Traduzir sem duplicar texto')
        ));

        expect(execCommandSpy).not.toHaveBeenCalled();
    });

    test('CG-23: usa execCommand como fallback quando o paste nao injeta o prompt', async () => {
        const { editor } = mountGeminiEditor({
            sendMode: 'exact',
            promptPasteBehavior: 'ignore',
            onSubmit: () => {
                setTimeout(() => appendGeneratedImage('https://cdn.gemini.test/result-exec-command.png'), 1300);
            },
        });

        await storageMock.set({
            gemini_job_321: {
                jobId: 'job-321',
                batchId: 'batch-test',
                mangaTabId: 77,
                index: 9,
                prompt: 'Traduzir usando execCommand',
            },
        });

        installResponder({
            GET_TAB_ID: () => ({ tabId: 321 }),
            REQUEST_IMAGE_DATA: () => ({ srcData: 'data:image/png;base64,QUJDRA==' }),
            FETCH_IMAGE_AS_BASE64: () => ({ dataUrl: 'data:image/png;base64,UkVTVUxU' }),
        });

        let customEventDetail = null;
        const setPromptListener = (e) => { customEventDetail = e.detail; };
        window.addEventListener('MANGA_TRANSLATOR_SET_PROMPT', setPromptListener);

        const mod = loadContentGeminiModule();
        mod.processGeminiJob();

        await waitFor(() => (
            document.querySelector('.ql-editor')
            && document.querySelector('.ql-editor').textContent.includes('Traduzir usando execCommand')
        ));
        await waitFor(() => sentMessages.find((message) => message.action === 'GEMINI_IMAGE_EXTRACTED'));
        window.removeEventListener('MANGA_TRANSLATOR_SET_PROMPT', setPromptListener);

        expect(customEventDetail).toEqual({ prompt: 'Traduzir usando execCommand' });
        expect(editor.textContent).toContain('Traduzir usando execCommand');
    });

    test('CG-24: usa fallback DOM direto quando paste e execCommand falham', async () => {
        mountGeminiEditor({
            sendMode: 'exact',
            promptPasteBehavior: 'ignore',
            onSubmit: () => {
                setTimeout(() => appendGeneratedImage('https://cdn.gemini.test/result-dom-direct.png'), 1300);
            },
        });

        await storageMock.set({
            gemini_job_321: {
                jobId: 'job-321',
                batchId: 'batch-test',
                mangaTabId: 77,
                index: 11,
                prompt: 'Traduzir via fallback DOM',
            },
        });

        installResponder({
            GET_TAB_ID: () => ({ tabId: 321 }),
            REQUEST_IMAGE_DATA: () => ({ srcData: 'data:image/png;base64,QUJDRA==' }),
            FETCH_IMAGE_AS_BASE64: () => ({ dataUrl: 'data:image/png;base64,UkVTVUxU' }),
        });

        jest.spyOn(document, 'execCommand').mockReturnValue(false);

        const mod = loadContentGeminiModule();
        mod.processGeminiJob();

        await waitFor(() => (
            document.querySelector('.ql-editor')
            && document.querySelector('.ql-editor').textContent.includes('Traduzir via fallback DOM')
        ));

        expect(document.querySelector('.ql-editor').textContent).toContain('Traduzir via fallback DOM');
    });

    test('CG-14: nao processa job quando a URL atual esta em deleting_urls', async () => {
        document.body.innerHTML = '<div class="ql-editor" contenteditable="true"></div>';
        await storageMock.set({
            gemini_job_321: {
                jobId: 'job-321',
                batchId: 'batch-test',
                mangaTabId: 77,
                index: 2,
                prompt: 'Nao deve rodar',
            },
            deleting_urls: ['https://gemini.test/app/chat-1'],
        });

        installResponder({
            GET_TAB_ID: () => ({ tabId: 321 }),
            REQUEST_IMAGE_DATA: () => ({ srcData: 'data:image/png;base64,QUJDRA==' }),
        });

        const mod = loadContentGeminiModule();
        mod.processGeminiJob();
        await delay(100);

        expect(sentMessages.some((message) => message.action === 'REQUEST_IMAGE_DATA')).toBe(false);
        expect(sentMessages.some((message) => message.action === 'GEMINI_ERROR')).toBe(false);
    });

    test('CG-45/CG-48/CG-49: deleteCurrentConversation usa a estrategia do item selecionado quando nao ha link atual', async () => {
        document.body.innerHTML = `
            <div aria-selected="true" id="selected-row">
                <button id="selected-options" aria-haspopup="menu">...</button>
            </div>
            <div id="delete-item" role="menuitem">Excluir conversa</div>
            <button id="confirm-delete">Excluir</button>
        `;

        const optionsBtn = document.getElementById('selected-options');
        const deleteItem = document.getElementById('delete-item');
        const confirmBtn = document.getElementById('confirm-delete');

        optionsBtn.scrollIntoView = jest.fn();
        optionsBtn.click = jest.fn();
        deleteItem.click = jest.fn();
        confirmBtn.click = jest.fn();

        await storageMock.set({ debugMode: false });
        installResponder();

        const mod = loadContentGeminiModule();
        await mod.deleteCurrentConversation();

        expect(optionsBtn.click).toHaveBeenCalled();
        expect(deleteItem.click).toHaveBeenCalled();
        expect(confirmBtn.click).toHaveBeenCalled();
    });

    test('CG-46/CG-48/CG-49: deleteCurrentConversation usa a heuristica da sidebar quando nao encontra conversa ativa', async () => {
        document.body.innerHTML = `
            <nav>
                <button id="sidebar-menu">
                    <svg><path></path><path></path><circle></circle></svg>
                </button>
            </nav>
            <div id="delete-item" role="menuitem">Delete conversation</div>
            <button id="confirm-delete">Confirm delete</button>
        `;

        const optionsBtn = document.getElementById('sidebar-menu');
        const deleteItem = document.getElementById('delete-item');
        const confirmBtn = document.getElementById('confirm-delete');

        optionsBtn.scrollIntoView = jest.fn();
        optionsBtn.click = jest.fn();
        deleteItem.click = jest.fn();
        confirmBtn.click = jest.fn();

        await storageMock.set({ debugMode: false });
        installResponder();

        const mod = loadContentGeminiModule();
        await mod.deleteCurrentConversation();

        expect(optionsBtn.click).toHaveBeenCalled();
        expect(deleteItem.click).toHaveBeenCalled();
        expect(confirmBtn.click).toHaveBeenCalled();
    });

    test('CG-50: deleteCurrentConversation registra DELETE_NO_CONFIRM e fecha o modal quando falta confirmacao', async () => {
        document.body.innerHTML = `
            <div id="conversation-row">
                <a href="/app/chat-1">Conversa atual</a>
                <button id="options-btn" aria-haspopup="menu" aria-label="opções">...</button>
            </div>
            <div id="delete-item" role="menuitem">Excluir conversa</div>
        `;

        const optionsBtn = document.getElementById('options-btn');
        const deleteItem = document.getElementById('delete-item');
        const bodyClickSpy = jest.spyOn(document.body, 'click');

        optionsBtn.scrollIntoView = jest.fn();
        optionsBtn.click = jest.fn();
        deleteItem.click = jest.fn();

        await storageMock.set({ debugMode: false });
        installResponder();

        const mod = loadContentGeminiModule();
        await mod.deleteCurrentConversation();

        expect(deleteItem.click).toHaveBeenCalled();
        expect(bodyClickSpy).toHaveBeenCalled();
        expect(sentMessages).toContainEqual(expect.objectContaining({
            action: 'LOG_ENTRY',
            action_name: 'DELETE_NO_CONFIRM',
        }));
    });

    test('deleteCurrentConversation aguarda menu e confirmacao renderizados com atraso no Gemini', async () => {
        document.body.innerHTML = `
            <div id="conversation-row">
                <a href="/app/chat-1">Conversa atual</a>
                <button id="options-btn" aria-haspopup="menu" aria-label="opções">...</button>
            </div>
        `;

        const optionsBtn = document.getElementById('options-btn');
        optionsBtn.scrollIntoView = jest.fn();
        optionsBtn.click = jest.fn(() => {
            setTimeout(() => {
                const deleteItem = document.createElement('button');
                deleteItem.id = 'delete-item';
                deleteItem.setAttribute('role', 'menuitem');
                deleteItem.textContent = 'Excluir conversa';
                deleteItem.click = jest.fn(() => {
                    setTimeout(() => {
                        const dialog = document.createElement('div');
                        dialog.setAttribute('role', 'dialog');
                        const confirm = document.createElement('button');
                        confirm.id = 'confirm-delete';
                        confirm.textContent = 'Excluir';
                        confirm.click = jest.fn();
                        dialog.appendChild(confirm);
                        document.body.appendChild(dialog);
                    }, 350);
                });
                document.body.appendChild(deleteItem);
            }, 350);
        });

        await storageMock.set({ debugMode: false });
        installResponder();

        const mod = loadContentGeminiModule();
        await mod.deleteCurrentConversation();

        expect(optionsBtn.click).toHaveBeenCalled();
        expect(document.getElementById('delete-item').click).toHaveBeenCalled();
        expect(document.getElementById('confirm-delete').click).toHaveBeenCalled();
        expect(sentMessages).toContainEqual(expect.objectContaining({
            action: 'LOG_ENTRY',
            action_name: 'DELETE_OK',
        }));
    });

    test('deleteCurrentConversation registra DELETE_NO_ITEM quando o menu nao tem a acao de excluir', async () => {
        document.body.innerHTML = `
            <div id="conversation-row">
                <a href="/app/chat-1">Conversa atual</a>
                <button id="options-btn" aria-haspopup="menu" aria-label="opções">...</button>
            </div>
            <div role="menuitem">Compartilhar</div>
        `;

        const optionsBtn = document.getElementById('options-btn');
        const bodyClickSpy = jest.spyOn(document.body, 'click');

        optionsBtn.scrollIntoView = jest.fn();
        optionsBtn.click = jest.fn();

        await storageMock.set({ debugMode: false });
        installResponder();

        const mod = loadContentGeminiModule();
        await mod.deleteCurrentConversation();

        expect(optionsBtn.click).toHaveBeenCalled();
        expect(bodyClickSpy).toHaveBeenCalled();
        expect(sentMessages).toContainEqual(expect.objectContaining({
            action: 'LOG_ENTRY',
            action_name: 'DELETE_NO_ITEM',
        }));
    });

    test('CG-47: deleteCurrentConversation registra DELETE_NOT_FOUND quando nao encontra botao de opcoes', async () => {
        document.body.innerHTML = '<div>sem sidebar e sem conversa ativa</div>';
        await storageMock.set({ debugMode: false });
        installResponder();

        const mod = loadContentGeminiModule();
        await mod.deleteCurrentConversation();

        expect(sentMessages).toContainEqual(expect.objectContaining({
            action: 'LOG_ENTRY',
            action_name: 'DELETE_NOT_FOUND',
        }));
    });

    test('CG-42/CG-51: deleteCurrentConversation protege contra reentrada concorrente e reseta o guard', async () => {
        document.body.innerHTML = `
            <div id="conversation-row">
                <a href="/app/chat-1">Conversa atual</a>
                <button id="options-btn" aria-haspopup="menu" aria-label="opções">...</button>
            </div>
            <div id="delete-item" role="menuitem">Excluir conversa</div>
            <button id="confirm-delete">Excluir</button>
        `;

        const optionsBtn = document.getElementById('options-btn');
        const deleteItem = document.getElementById('delete-item');
        const confirmBtn = document.getElementById('confirm-delete');

        optionsBtn.scrollIntoView = jest.fn();
        optionsBtn.click = jest.fn();
        deleteItem.click = jest.fn();
        confirmBtn.click = jest.fn();

        await storageMock.set({ debugMode: false });
        installResponder();

        const mod = loadContentGeminiModule();
        const p1 = mod.deleteCurrentConversation();
        const p2 = mod.deleteCurrentConversation();

        await Promise.all([p1, p2]);

        expect(optionsBtn.click).toHaveBeenCalledTimes(1);
        expect(deleteItem.click).toHaveBeenCalledTimes(1);
        expect(confirmBtn.click).toHaveBeenCalledTimes(1);
        expect(mod.__getDeletionInProgress()).toBe(false);
    });
});
