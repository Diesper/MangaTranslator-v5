// content_gemini.js — Manga Translator
//
// Bootstrap/orquestração do worker Gemini.
// Implementação detalhada vive em extension/gemini/*.js.

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const GeminiDom = globalThis.MangaTranslatorGeminiDom;
const GeminiObserver = globalThis.MangaTranslatorGeminiObserver;
const GeminiEditor = globalThis.MangaTranslatorGeminiEditor;
const GeminiAttachment = globalThis.MangaTranslatorGeminiAttachment;
const GeminiTemporaryChat = globalThis.MangaTranslatorGeminiTemporaryChat;
const GeminiResultExtractor = globalThis.MangaTranslatorGeminiResultExtractor;
const GeminiDeletion = globalThis.MangaTranslatorGeminiDeletion;
const GeminiJobRunner = globalThis.MangaTranslatorGeminiJobRunner;

if (
    !GeminiDom ||
    !GeminiObserver ||
    !GeminiEditor ||
    !GeminiAttachment ||
    !GeminiTemporaryChat ||
    !GeminiResultExtractor ||
    !GeminiDeletion ||
    !GeminiJobRunner
) {
    throw new Error('Módulos Gemini obrigatórios não foram carregados antes de content_gemini.js');
}

// ── Keep-alive sob demanda ───────────────────────────────────────────────────
let keepAlivePort = null;
let keepAliveJobActive = false;
let keepAliveClosing = false;
let keepAliveReconnectAttempted = false;

function connectKeepAlive({ reconnect = false } = {}) {
    if (!keepAliveJobActive || keepAlivePort) return keepAlivePort;

    try {
        const port = chrome.runtime.connect({ name: 'gemini-keep-alive' });
        keepAlivePort = port;

        if (port?.onDisconnect?.addListener) {
            port.onDisconnect.addListener(() => {
                if (keepAlivePort === port) keepAlivePort = null;
                if (
                    keepAliveClosing ||
                    !keepAliveJobActive ||
                    keepAliveReconnectAttempted
                ) {
                    return;
                }

                keepAliveReconnectAttempted = true;
                setTimeout(() => {
                    if (
                        !keepAliveClosing &&
                        keepAliveJobActive &&
                        !keepAlivePort
                    ) {
                        connectKeepAlive({ reconnect: true });
                    }
                }, 250);
            });
        }

        return port;
    } catch (_error) {
        keepAlivePort = null;
        if (reconnect) keepAliveReconnectAttempted = true;
        return null;
    }
}

function openKeepAlive() {
    keepAliveJobActive = true;
    keepAliveClosing = false;
    keepAliveReconnectAttempted = false;
    return connectKeepAlive();
}

function closeKeepAlive() {
    keepAliveClosing = true;
    keepAliveJobActive = false;

    const port = keepAlivePort;
    keepAlivePort = null;
    if (port) {
        try { port.disconnect(); } catch (_error) {}
    }

    keepAliveReconnectAttempted = false;
}

// ── Logs sanitizados ─────────────────────────────────────────────────────────
function sanitizeLogExtra(value, key = '') {
    const sensitiveKey =
        /(url|uri|src|prompt|preview|hash|base64|dataurl|image|token|cookie|authorization)/i;

    if (sensitiveKey.test(key)) return '[redacted]';

    if (typeof value === 'string') {
        if (
            value.startsWith('data:') ||
            value.startsWith('blob:') ||
            /^https?:/i.test(value)
        ) {
            return '[redacted]';
        }
        return value.length > 160 ? `${value.slice(0, 160)}…` : value;
    }

    if (Array.isArray(value)) {
        return value.map(item => sanitizeLogExtra(item));
    }

    if (value && typeof value === 'object') {
        return Object.entries(value).reduce((safe, [entryKey, entryValue]) => {
            safe[entryKey] = sanitizeLogExtra(entryValue, entryKey);
            return safe;
        }, {});
    }

    return value;
}

function sendLog(level, action_name, detail, extra = {}) {
    chrome.runtime.sendMessage({
        action: 'LOG_ENTRY',
        level,
        source: 'gemini',
        action_name,
        detail: sanitizeLogExtra(String(detail || '')),
        extra: sanitizeLogExtra(extra),
    }, () => {
        if (chrome.runtime.lastError) {}
    });
}

function getUrlLogMetadata(value) {
    const rawUrl = String(value || '');
    if (rawUrl.startsWith('data:')) {
        return { urlKind: 'data', host: null, hasQuery: false };
    }
    if (rawUrl.startsWith('blob:')) {
        return { urlKind: 'blob', host: null, hasQuery: false };
    }

    try {
        const parsed = new URL(rawUrl);
        return {
            urlKind: parsed.protocol.replace(':', ''),
            host: parsed.hostname || null,
            hasQuery: Boolean(parsed.search),
        };
    } catch (_error) {
        return { urlKind: 'invalid', host: null, hasQuery: false };
    }
}

// ── Debug gated ──────────────────────────────────────────────────────────────
let _debugModeEnabled = false;

chrome.storage.local.get(['debugMode'], data => {
    _debugModeEnabled = data?.debugMode === true;
});

if (chrome.storage?.onChanged) {
    chrome.storage.onChanged.addListener((changes, area) => {
        if (area === 'local' && changes.debugMode) {
            _debugModeEnabled = changes.debugMode.newValue === true;
        }
    });
}

function debugConsole(level, ...args) {
    if (!_debugModeEnabled) return;
    const safeArgs = args.map(arg =>
        typeof arg === 'object' && arg !== null
            ? sanitizeLogExtra(arg)
            : arg
    );
    console[level](...safeArgs);
}

function reportProgress(text, mangaTabId = null) {
    chrome.runtime.sendMessage({
        action: 'GEMINI_PROGRESS',
        text,
        mangaTabId,
    }, () => {
        if (chrome.runtime.lastError) {}
    });
}

// ── Módulos com dependências de runtime ─────────────────────────────────────
const resultExtractor = GeminiResultExtractor.createResultExtractor({
    sendLog,
    getUrlLogMetadata,
    sleep,
    runtime: chrome.runtime,
    pageWindow: window,
    pageDocument: document,
    fetchImpl: (...args) => fetch(...args),
});

const deletionController = GeminiDeletion.createDeletionController({
    root: document,
    pageWindow: window,
    storage: chrome.storage.local,
    sleep,
    sendLog,
});

const jobRunner = GeminiJobRunner.createGeminiJobRunner({
    root: document,
    pageWindow: window,
    runtime: chrome.runtime,
    storage: chrome.storage.local,
    domApi: GeminiDom,
    observerApi: GeminiObserver,
    editorApi: GeminiEditor,
    attachmentApi: GeminiAttachment,
    temporaryChatApi: GeminiTemporaryChat,
    resultExtractor,
    deletionController,
    sleep,
    sendLog,
    getUrlLogMetadata,
    debugConsole,
    reportProgress,
    openKeepAlive,
    closeKeepAlive,
});

// ── Claim seguro ─────────────────────────────────────────────────────────────
function getExpectedGeminiJobId() {
    try {
        const parsed = new URL(window.location.href);
        const jobId = parsed.searchParams.get('jobId');
        return jobId?.trim() ? jobId.trim() : null;
    } catch (_error) {
        return null;
    }
}

function sendRuntimeMessage(message) {
    return new Promise(resolve => {
        try {
            chrome.runtime.sendMessage(message, response => {
                if (chrome.runtime.lastError) resolve(null);
                else resolve(response || null);
            });
        } catch (_error) {
            resolve(null);
        }
    });
}

async function claimGeminiJob({ timeoutMs = 5000 } = {}) {
    const expectedJobId = getExpectedGeminiJobId();
    const startedAt = Date.now();
    let claimUnsupported = false;

    do {
        const response = await sendRuntimeMessage({
            action: 'CLAIM_GEMINI_JOB',
            jobId: expectedJobId || undefined,
        });

        if (response?.ok === true && response.job) {
            return response.job;
        }

        if (
            response?.ok === true &&
            Object.prototype.hasOwnProperty.call(response, 'job')
        ) {
            if (!expectedJobId) return null;
        } else if (!response) {
            // Compatibilidade transitória com background/fixtures anteriores.
            // Nunca faz full scan.
            claimUnsupported = true;
            break;
        }

        if (Date.now() - startedAt >= timeoutMs) return null;
        await sleep(500);
    } while (Date.now() - startedAt < timeoutMs);

    if (!claimUnsupported) return null;

    let tabResponse = null;
    for (let attempt = 0; attempt < 5; attempt += 1) {
        tabResponse = await sendRuntimeMessage({ action: 'GET_TAB_ID' });
        if (tabResponse && Number.isInteger(tabResponse.tabId)) break;
        await sleep(500);
    }

    if (!tabResponse || !Number.isInteger(tabResponse.tabId)) return null;

    const tabId = tabResponse.tabId;
    const jobKey = `gemini_job_${tabId}`;
    const legacyStartedAt = Date.now();

    do {
        const data = await new Promise(resolve =>
            chrome.storage.local.get([jobKey], resolve)
        );
        const job = data?.[jobKey];

        if (job && (!expectedJobId || job.jobId === expectedJobId)) {
            return { ...job, geminiTabId: tabId };
        }

        if (Date.now() - legacyStartedAt >= timeoutMs) return null;
        await sleep(500);
    } while (Date.now() - legacyStartedAt < timeoutMs);

    return null;
}

// ── Bootstrap / claim / runner ───────────────────────────────────────────────
async function processGeminiJob() {
    debugConsole(
        'log',
        '[MangaTranslator Gemini] processGeminiJob iniciado na aba'
    );

    const currentPath = window.location.pathname;
    if (
        currentPath &&
        currentPath.length > 8 &&
        currentPath.startsWith('/app/')
    ) {
        const data = await new Promise(resolve =>
            chrome.storage.local.get(['deleting_urls'], resolve)
        );
        const deletingUrls = data.deleting_urls || [];
        const isBeingDeleted = deletingUrls.some(value => {
            try {
                return new URL(value).pathname === currentPath;
            } catch (_error) {
                return String(value).includes(currentPath);
            }
        });

        if (isBeingDeleted) return;
    }

    const job = await claimGeminiJob({ timeoutMs: 5000 });
    const isExistingChat = currentPath.startsWith('/app/');

    if (!job) {
        if (!isExistingChat) {
            sendLog(
                'warn',
                'JOB_NOT_FOUND',
                'Nenhum job válido foi reivindicado para esta aba — script desativado',
                { path: currentPath }
            );
        }
        closeKeepAlive();
        return;
    }

    return jobRunner.run(job);
}

// ── Runtime handlers ─────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'DO_SEND_NOW') {
        const stopButton = GeminiDom.findVisibleStopButton(document);
        if (stopButton) {
            sendResponse({ ok: true, alreadyGenerating: true });
            return false;
        }

        const editor = document.querySelector(
            'rich-textarea [contenteditable="true"], .ql-editor[contenteditable="true"], [contenteditable="true"]'
        );
        const sendButton = GeminiDom.findSendButton(document.body);
        let attempted = false;

        if (sendButton && GeminiDom.isControlEnabled(sendButton)) {
            attempted = GeminiEditor.clickSendButton(sendButton);
        } else {
            GeminiEditor.nudgeEditor(editor);
            window.dispatchEvent(
                new CustomEvent('MANGA_TRANSLATOR_TRIGGER_SEND')
            );
            attempted = true;
        }

        sendResponse({ ok: true, attempted });
        return false;
    }

    if (request.action === 'DELETE_CONVERSATION') {
        deletionController.deleteCurrentConversation()
            .then(ok => sendResponse({ ok }))
            .catch(error => sendResponse({
                ok: false,
                error: error.message,
            }));
        return true;
    }
});

const contentGeminiApi = {
    sleep,
    getExpectedGeminiJobId,
    claimGeminiJob,
    openKeepAlive,
    closeKeepAlive,
    processGeminiJob,
    dataURLtoFile: (...args) => jobRunner.dataURLtoFile(...args),
    waitForElement: (...args) => jobRunner.waitForElement(...args),
    createGeminiManualPanel: (...args) => jobRunner.createGeminiManualPanel(...args),
    removeGeminiManualPanel: (...args) => jobRunner.removeGeminiManualPanel(...args),
    setManualGeminiResultUrl: (...args) => jobRunner.setManualGeminiResultUrl(...args),
    findGeneratedResultImages: (...args) => jobRunner.findGeneratedResultImages(...args),
    isManualSelectableImage: (...args) => jobRunner.isManualSelectableImage(...args),
    shouldKeepConversationForDebug: (...args) => jobRunner.shouldKeepConversationForDebug(...args),
    imageElementToDataUrl: (...args) => resultExtractor.imageElementToDataUrl(...args),
    fetchImageThroughGeminiPage: (...args) => resultExtractor.fetchImageThroughGeminiPage(...args),
    fetchImageThroughExtension: (...args) => resultExtractor.fetchGeminiImageThroughExtension(...args),
    fetchImageThroughGeminiExtension: (...args) => resultExtractor.fetchGeminiImageThroughExtension(...args),
    fetchGeminiImageThroughExtension: (...args) => resultExtractor.fetchGeminiImageThroughExtension(...args),
    extractImageInGeminiTab: (...args) => resultExtractor.extractImageInGeminiTab(...args),
    extractResultImage: (...args) => resultExtractor.extractResultImage(...args),
    extractResultImageWithRetry: (...args) => resultExtractor.extractResultImageWithRetry(...args),
    getExtractionFailureKind: (...args) => resultExtractor.getExtractionFailureKind(...args),
    deleteCurrentConversation: (...args) => deletionController.deleteCurrentConversation(...args),
    waitForElementToSettle: (...args) => deletionController.waitForElementToSettle(...args),
    escapeCssAttributeValue: (...args) => deletionController.escapeCssAttributeValue(...args),
    __getDeletionInProgress: () => deletionController.isDeletionInProgress(),
}

const isCommonJsTest =
    typeof module !== 'undefined' &&
    module &&
    module.exports;

if (isCommonJsTest) {
    module.exports = contentGeminiApi;
} else if (!window.__mt_gemini_started) {
    window.__mt_gemini_started = true;
    processGeminiJob();
}
