/**
 * resolution-elevation.test.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Testa a elevação automática da resolução das imagens do Google CDN para =s0
 * (qualidade máxima original sem recompressão) no RPA do content_gemini.js.
 */

const path = require('path');
const { getRuntimeMock, getStorageMock } = require('../../mocks/chrome-api.mock.js');

const CONTENT_GEMINI_PATH = path.resolve(__dirname, '../../../extension/content_gemini.js');
const GEMINI_SELECTORS_PATH = path.resolve(__dirname, '../../../extension/gemini/selectors.js');
const GEMINI_DOM_PATH = path.resolve(__dirname, '../../../extension/gemini/dom.js');
const GEMINI_OBSERVER_PATH = path.resolve(__dirname, '../../../extension/gemini/observer.js');
const GEMINI_EDITOR_PATH = path.resolve(__dirname, '../../../extension/gemini/editor.js');
const GEMINI_ATTACHMENT_PATH = path.resolve(__dirname, '../../../extension/gemini/attachment.js');
const GEMINI_TEMP_CHAT_PATH = path.resolve(__dirname, '../../../extension/gemini/temporary-chat.js');
const GEMINI_RESULT_EXTRACTOR_PATH = path.resolve(__dirname, '../../../extension/gemini/result-extractor.js');

function delay(ms = 0) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitFor(predicate, { timeout = 8000, step = 50 } = {}) {
    let elapsed = 0;
    while (elapsed <= timeout) {
        const result = await predicate();
        if (result) return result;
        await delay(step);
        elapsed += step;
    }
    throw new Error('Timeout aguardando condicao');
}

function initMocks() {
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
            setData(type, value) { this._data.set(type, value); }
            getData(type) { return this._data.get(type) || ''; }
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

function mountGeminiEditor({ onSubmit } = {}) {
    document.body.innerHTML = '<div class="ql-editor" contenteditable="true"><p></p></div><div class="momentary-indicator">conversa momentânea</div>';

    const editor = document.querySelector('.ql-editor');
    editor.focus = jest.fn();
    editor.scrollIntoView = jest.fn();

    editor.addEventListener('paste', (event) => {
        const clipboardData = event.clipboardData;
        if (clipboardData && clipboardData.items && clipboardData.items.length > 0) {
            let preview = document.querySelector('file-preview');
            if (!preview) {
                preview = document.createElement('file-preview');
                const thumbImg = document.createElement('img');
                thumbImg.src = 'blob:https://gemini.test/mock-attachment';
                Object.defineProperty(thumbImg, 'naturalWidth', { value: 50, configurable: true });
                Object.defineProperty(thumbImg, 'naturalHeight', { value: 50, configurable: true });
                preview.appendChild(thumbImg);
                document.body.appendChild(preview);
            }
        }
    });

    const sendButton = document.createElement('button');
    sendButton.setAttribute('aria-label', 'send message');
    sendButton.click = jest.fn(() => {
        editor.textContent = '';
        onSubmit();
    });
    document.body.appendChild(sendButton);

    return { editor, sendButton };
}

describe('v6.0 Elevação de Resolução CDN (=s0) — content_gemini.js', () => {
    let runtimeMock;
    let storageMock;
    let sentMessages = [];

    beforeEach(async () => {
        jest.resetModules();
        initMocks();
        Element.prototype.scrollIntoView = jest.fn();
        runtimeMock = getRuntimeMock();
        storageMock = getStorageMock();
        sentMessages = [];
        await storageMock.clear();
        document.documentElement.innerHTML = '<head></head><body></body>';
    });

    afterEach(() => {
        jest.restoreAllMocks();
        document.documentElement.innerHTML = '<head></head><body></body>';
    });

    test('eleva URLs do Google User Content substituindo parâmetros =s1024, =s512 por =s0', () => {
        function elevateUrl(url) {
            if (url.includes('googleusercontent.com') && /=s\d+/.test(url)) {
                return url.replace(/=s\d+[^?#]*/, '=s0');
            }
            return url;
        }

        const cases = [
            {
                input: 'https://lh3.googleusercontent.com/drive-storage/AJ6_test=s1024',
                expected: 'https://lh3.googleusercontent.com/drive-storage/AJ6_test=s0',
            },
            {
                input: 'https://lh3.googleusercontent.com/fife/ABX_test=s512-rw',
                expected: 'https://lh3.googleusercontent.com/fife/ABX_test=s0',
            },
            {
                input: 'https://lh3.googleusercontent.com/fife/ABX_test=s2048?authuser=0',
                expected: 'https://lh3.googleusercontent.com/fife/ABX_test=s0?authuser=0',
            },
            {
                input: 'https://lh3.googleusercontent.com/img=s1200-c-rj-v1-e365#frag',
                expected: 'https://lh3.googleusercontent.com/img=s0#frag',
            },
            {
                input: 'https://example.com/cdn/image=s1024.png',
                expected: 'https://example.com/cdn/image=s1024.png',
            },
            {
                input: 'blob:https://gemini.google.com/1234-5678',
                expected: 'blob:https://gemini.google.com/1234-5678',
            },
        ];

        cases.forEach(({ input, expected }) => {
            expect(elevateUrl(input)).toBe(expected);
        });
    });

    test('processGeminiJob solicita FETCH_IMAGE_AS_BASE64 com a URL elevada para =s0', async () => {
        const cdnUrlLowRes = 'https://lh3.googleusercontent.com/drive-storage/SAMPLE_MANGA=s1024-rw';
        const expectedElevatedUrl = 'https://lh3.googleusercontent.com/drive-storage/SAMPLE_MANGA=s0';

        mountGeminiEditor({
            onSubmit: () => {
                setTimeout(() => {
                    appendGeneratedImage(cdnUrlLowRes);
                }, 1300);
            },
        });

        const tabId = 99;
        delete window.location;
        window.location = new URL(`https://gemini.google.com/app?mangatranslator=true&tabId=${tabId}`);

        await storageMock.set({
            [`gemini_job_${tabId}`]: {
                jobId: 'job-resolution',
                batchId: 'batch-test',
                mangaTabId: 10,
                index: 0,
                prompt: 'Traduza o texto mantendo balões.',
                geminiExecutionMode: 'temp_chat',
            },
            debugMode: true,
        });

        runtimeMock.sendMessage = jest.fn((message, callback) => {
            sentMessages.push(message);
            if (message.action === 'GET_TAB_ID') {
                if (callback) callback({ tabId });
            } else if (message.action === 'REQUEST_IMAGE_DATA') {
                if (callback) callback({ srcData: 'data:image/png;base64,QUJDRA==' });
            } else if (message.action === 'FETCH_IMAGE_AS_BASE64') {
                if (callback) callback({ dataUrl: 'data:image/png;base64,UkVTVUxUX0VMRVZBVEVE' });
            } else {
                if (callback) callback(undefined);
            }
        });

        jest.isolateModules(() => {
            require(GEMINI_SELECTORS_PATH);
            require(GEMINI_DOM_PATH);
            require(GEMINI_OBSERVER_PATH);
            require(GEMINI_EDITOR_PATH);
            require(GEMINI_ATTACHMENT_PATH);
            require(GEMINI_TEMP_CHAT_PATH);
            require(GEMINI_RESULT_EXTRACTOR_PATH);
            require(CONTENT_GEMINI_PATH);
        });

        await waitFor(() => sentMessages.find(m => m.action === 'FETCH_IMAGE_AS_BASE64'));

        const fetchCall = sentMessages.find(m => m.action === 'FETCH_IMAGE_AS_BASE64');
        expect(fetchCall).toBeDefined();
        expect(fetchCall.url).toBe(expectedElevatedUrl);

        const extractedMsg = sentMessages.find(m => m.action === 'GEMINI_IMAGE_EXTRACTED');
        expect(extractedMsg).toBeDefined();
        expect(extractedMsg.src).toBe('data:image/png;base64,UkVTVUxUX0VMRVZBVEVE');
    });
});
