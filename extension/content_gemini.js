// content_gemini.js — Manga Translator v6.0

const sleep = ms => new Promise(r => setTimeout(r, ms));

const GeminiDom = globalThis.MangaTranslatorGeminiDom;
const GeminiObserver = globalThis.MangaTranslatorGeminiObserver;
const GeminiEditor = globalThis.MangaTranslatorGeminiEditor;
const GeminiAttachment = globalThis.MangaTranslatorGeminiAttachment;
const GeminiTemporaryChat = globalThis.MangaTranslatorGeminiTemporaryChat;
const GeminiResultExtractor = globalThis.MangaTranslatorGeminiResultExtractor;
const GeminiDeletion = globalThis.MangaTranslatorGeminiDeletion;
if (!GeminiDom || !GeminiObserver || !GeminiEditor || !GeminiAttachment || !GeminiTemporaryChat || !GeminiResultExtractor || !GeminiDeletion) {
    throw new Error('Módulos Gemini obrigatórios não foram carregados antes de content_gemini.js');
}

// ── Keep-alive sob demanda ───────────────────────────────────────────────────
// Antes a porta era aberta no carregamento do script, ou seja, QUALQUER aba do
// Gemini que o usuário abrisse manualmente mantinha o Service Worker acordado.
// Agora a porta só é aberta depois que esta aba reivindica um job real.
let keepAlivePort = null;
let keepAliveJobActive = false;
let keepAliveClosing = false;
let keepAliveReconnectAttempted = false;

function connectKeepAlive({ reconnect = false } = {}) {
    if (!keepAliveJobActive || keepAlivePort) return keepAlivePort;
    try {
        const port = chrome.runtime.connect({ name: 'gemini-keep-alive' });
        keepAlivePort = port;
        if (port && port.onDisconnect && typeof port.onDisconnect.addListener === 'function') {
            port.onDisconnect.addListener(() => {
                if (keepAlivePort === port) keepAlivePort = null;
                if (keepAliveClosing || !keepAliveJobActive || keepAliveReconnectAttempted) return;
                keepAliveReconnectAttempted = true;
                setTimeout(() => {
                    if (!keepAliveClosing && keepAliveJobActive && !keepAlivePort) {
                        connectKeepAlive({ reconnect: true });
                    }
                }, 250);
            });
        }
        return port;
    } catch (_e) {
        keepAlivePort = null;
        // Uma falha durante a única reconexão permitida encerra a tentativa.
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
        try { port.disconnect(); } catch (_e) {}
    }
    keepAliveReconnectAttempted = false;
}

function sanitizeLogExtra(value, key = '') {
    const sensitiveKey = /(url|uri|src|prompt|preview|hash|base64|dataurl|image|token|cookie|authorization)/i;
    if (sensitiveKey.test(key)) return '[redacted]';
    if (typeof value === 'string') {
        if (value.startsWith('data:') || value.startsWith('blob:') || /^https?:/i.test(value)) return '[redacted]';
        return value.length > 160 ? `${value.slice(0, 160)}…` : value;
    }
    if (Array.isArray(value)) return value.map(item => sanitizeLogExtra(item));
    if (value && typeof value === 'object') return Object.entries(value).reduce((safe, [entryKey, entryValue]) => {
        safe[entryKey] = sanitizeLogExtra(entryValue, entryKey);
        return safe;
    }, {});
    return value;
}

function sendLog(level, action_name, detail, extra = {}) {
    // Content scripts must never forward signed URLs, prompt text, image data or
    // visual fingerprints to the background log store.
    const safeDetail = sanitizeLogExtra(String(detail || ''));
    chrome.runtime.sendMessage({ action: 'LOG_ENTRY', level, source: 'gemini', action_name, detail: safeDetail, extra: sanitizeLogExtra(extra) }, () => { if (chrome.runtime.lastError) {} });
}

function getUrlLogMetadata(value) {
    const rawUrl = String(value || '');
    if (rawUrl.startsWith('data:')) return { urlKind: 'data', host: null, hasQuery: false };
    if (rawUrl.startsWith('blob:')) return { urlKind: 'blob', host: null, hasQuery: false };

    try {
        const parsed = new URL(rawUrl);
        return { urlKind: parsed.protocol.replace(':', ''), host: parsed.hostname || null, hasQuery: Boolean(parsed.search) };
    } catch (_error) {
        return { urlKind: 'invalid', host: null, hasQuery: false };
    }
}

// ── Console de depuração — gated por debug mode ─────────────────────────────
// console.log/warn/error escrevem direto no DevTools, fora do pipeline
// sanitizado de sendLog()/sanitizeLogExtra(). Antes rodavam incondicionalmente
// (mesmo com debug mode desligado) e alguns argumentos carregavam dado bruto
// (jobId completo, objeto Error inteiro, referência DOM com src de imagem).
// Este helper: (1) só escreve no console quando debugMode está ativo, e
// (2) sempre passa argumentos estruturados por sanitizeLogExtra antes de
// imprimir, nunca o objeto bruto.
let _debugModeEnabled = false;
chrome.storage.local.get(['debugMode'], data => { _debugModeEnabled = data && data.debugMode === true; });
if (chrome.storage && chrome.storage.onChanged) {
    chrome.storage.onChanged.addListener((changes, area) => {
        if (area === 'local' && changes.debugMode) _debugModeEnabled = changes.debugMode.newValue === true;
    });
}

function debugConsole(level, ...args) {
    if (!_debugModeEnabled) return;
    const safeArgs = args.map(arg => (typeof arg === 'object' && arg !== null ? sanitizeLogExtra(arg) : arg));
    console[level](...safeArgs);
}

function reportProgress(text, mangaTabId = null) {
    chrome.runtime.sendMessage({ action: 'GEMINI_PROGRESS', text, mangaTabId }, () => { if (chrome.runtime.lastError) {} });
}

function dataURLtoFile(dataurl, filename) {
    const commaIdx = dataurl.indexOf(',');
    if (commaIdx === -1) throw new Error(`dataURL malformada: sem vírgula separadora`);
    const header = dataurl.slice(0, commaIdx);
    const mimeMatch = header.match(/:(.*?);/);
    if (!mimeMatch || !mimeMatch[1]) throw new Error(`dataURL malformada: MIME não encontrado`);
    const mime = mimeMatch[1];
    const bstr = atob(dataurl.slice(commaIdx + 1));
    let n = bstr.length;
    const u8arr = new Uint8Array(n);
    while (n--) u8arr[n] = bstr.charCodeAt(n);
    return new File([u8arr], filename, { type: mime });
}

function waitForElement(selector, timeout = 20000) {
    const existing = document.querySelector(selector);
    if (existing) return Promise.resolve(existing);

    return new Promise((resolve) => {
        let timer = null;
        let observer = null;

        const cleanup = () => {
            if (timer) clearTimeout(timer);
            if (observer) observer.disconnect();
        };

        timer = setTimeout(() => {
            cleanup();
            resolve(document.querySelector(selector) || null);
        }, timeout);

        observer = new MutationObserver(() => {
            const el = document.querySelector(selector);
            if (el) {
                cleanup();
                resolve(el);
            }
        });

        const root = document.body || document.documentElement;
        if (root) {
            observer.observe(root, { childList: true, subtree: true });
        }
    });
}

// Compatibilidade temporária com testes/chamadas existentes. A implementação
// real vive em gemini/temporary-chat.js e retorna estados verificáveis.
const TemporaryChatActivator = GeminiTemporaryChat.createLegacyAdapter({ root: document });

function getImageSource(img) {
    return GeminiDom.getImageSource(img);
}

function isIgnoredGeminiImageSource(src) {
    return GeminiDom.isIgnoredGeminiImageSource(src);
}

function isModelResponseImage(img) {
    return GeminiDom.isModelResponseImage(img);
}

function tryClickModelImageCards() {
    const cardSelectors = [
        'model-response button[aria-label*="imagem" i]',
        'model-response button[aria-label*="image" i]',
        'model-response .image-card',
        'model-response [data-test-id*="image"]',
        'model-response [data-test-id*="generated-image"]',
        'model-response img',
        '[data-message-author="model"] button[aria-label*="imagem" i]',
        '[data-message-author="model"] [data-test-id*="image"]',
        '[data-message-author="model"] img'
    ];
    for (const sel of cardSelectors) {
        const el = document.querySelector(sel);
        if (el) {
            const btn = el.closest('button, [role="button"]') || el;
            try {
                btn.click();
                return true;
            } catch (e) {}
        }
    }
    return false;
}

function isLikelyGeneratedImage(img, ignoreImages = new Set()) {
    const src = getImageSource(img);
    if (!src || ignoreImages.has(src) || isIgnoredGeminiImageSource(src)) return false;

    // Se estiver explicitamente dentro da resposta do modelo, aceita como candidata imediata
    if (isModelResponseImage(img)) {
        return true;
    }

    // Assinaturas inequívocas de imagem gerada pelo Gemini
    if (src.includes('gemini-result-image') || src.includes('googleusercontent.com/gg-dl/') || src.startsWith('blob:https://gemini.google.com/') || src.startsWith('blob:http://127.0.0.1/')) {
        return true;
    }

    const width = img.naturalWidth || img.width || 0;
    const height = img.naturalHeight || img.height || 0;

    // Em abas de background o Chrome pode adiar o cálculo de width/height do DOM.
    // Se for de googleusercontent e nova, aceita como candidata:
    if (src.includes('googleusercontent.com') && !isIgnoredGeminiImageSource(src)) {
        if (width <= 0 && height <= 0) return true;
    }

    if (width <= 0 || height <= 0) return false;
    if (img.complete === false && height <= 0) return false;

    const maxSide = Math.max(width, height);
    const minSide = Math.min(width, height);
    const area = width * height;
    return maxSide >= 256 && minSide >= 40 && area >= 12000;
}

function isManualSelectableImage(img, ignoreImages = new Set()) {
    const src = getImageSource(img);
    if (!src || ignoreImages.has(src) || isIgnoredGeminiImageSource(src)) return false;
    const width = img.naturalWidth || img.width || 0;
    const height = img.naturalHeight || img.height || 0;
    return width > 0 && height > 0 && Math.max(width, height) >= 40;
}

function findAllElementsDeep(root, matcher) {
    return GeminiDom.findAllDeep(root, matcher);
}

function findFileInputsDeep(root = document.body) {
    return GeminiAttachment.findFileInputsDeep(root);
}

function findAttachmentThumbnailDeep(root = document.body) {
    return GeminiAttachment.findAttachmentThumbnailDeep(root);
}

function findSendButtonDeep(root = document.body) {
    return GeminiDom.findSendButton(root);
}

function clickSendButton(btn) {
    return GeminiEditor.clickSendButton(btn);
}

function setPromptInEditor(currentEditable, currentEditor, actualPrompt) {
    if (!currentEditable) return false;
    const existing = (currentEditable.textContent || '').trim();
    if (existing === actualPrompt.trim()) return true;

    if (typeof currentEditable.focus === 'function') currentEditable.focus();
    if (currentEditor && typeof currentEditor.focus === 'function' && currentEditor !== currentEditable) currentEditor.focus();
    currentEditable.dispatchEvent(new FocusEvent('focus', { bubbles: true, composed: true }));
    currentEditable.dispatchEvent(new FocusEvent('focusin', { bubbles: true, composed: true }));

    const q = currentEditable.__quill
           || (currentEditor && currentEditor.__quill)
           || (window.Quill && typeof window.Quill.find === 'function' && (window.Quill.find(currentEditable) || window.Quill.find(currentEditor)));
    if (q) {
        try {
            if (typeof q.setText === 'function') q.setText(actualPrompt, 'user');
            if (typeof q.update === 'function') q.update('user');
        } catch (e) {}
    }

    let pTag = document.createElement('p');
    pTag.textContent = actualPrompt;
    if (typeof currentEditable.replaceChildren === 'function') {
        currentEditable.replaceChildren(pTag);
    } else {
        while (currentEditable.firstChild) {
            currentEditable.removeChild(currentEditable.firstChild);
        }
        currentEditable.appendChild(pTag);
    }

    try {
        currentEditable.dispatchEvent(new InputEvent('beforeinput', {
            bubbles: true, cancelable: true, composed: true, inputType: 'insertText', data: actualPrompt
        }));
        currentEditable.dispatchEvent(new InputEvent('input', {
            bubbles: true, cancelable: true, composed: true, inputType: 'insertText', data: actualPrompt
        }));
        currentEditable.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
        currentEditable.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
    } catch (e) {}

    if (currentEditor && 'value' in currentEditor) {
        try { currentEditor.value = actualPrompt; } catch (e) {}
        try { currentEditor.dispatchEvent(new Event('input', { bubbles: true, composed: true })); } catch (e) {}
    }

    return currentEditable.textContent.trim().length >= 5;
}

function findGeneratedResultImages(ignoreImages = new Set()) {
    const allImages = findAllElementsDeep(document.body, el => el.tagName === 'IMG');
    allImages.forEach(img => {
        if (img.getAttribute('loading') === 'lazy') {
            img.removeAttribute('loading');
            img.setAttribute('loading', 'eager');
        }
        if (img.dataset && img.dataset.src) img.src = img.dataset.src;
    });
    return allImages.filter(img => isLikelyGeneratedImage(img, ignoreImages));
}

function setManualGeminiResultUrl(url, source = 'manual') {
    window.__mangaTranslatorManualGeminiResultUrl = url;
    if (
        window.__mangaTranslatorActiveGeminiObserver &&
        typeof window.__mangaTranslatorActiveGeminiObserver.acceptResult === 'function'
    ) {
        window.__mangaTranslatorActiveGeminiObserver.acceptResult(null, url);
    }
    const status = document.getElementById('mt-gemini-assist-status');
    if (status) status.textContent = 'Imagem marcada. A extensão vai usar esse resultado.';
    sendLog('info', 'GEMINI_MANUAL_RESULT', 'Imagem marcada manualmente no Gemini', { source, ...getUrlLogMetadata(url) });
}

function removeGeminiManualPanel() {
    const existing = document.getElementById('mt-gemini-assist');
    if (existing) existing.remove();
    if (window.__mangaTranslatorManualPickHandler) {
        document.removeEventListener('click', window.__mangaTranslatorManualPickHandler, true);
        window.__mangaTranslatorManualPickHandler = null;
    }
    document.querySelectorAll('[data-mt-gemini-pickable="true"]').forEach(img => {
        img.style.outline = '';
        img.removeAttribute('data-mt-gemini-pickable');
    });
}

function createGeminiManualPanel(job, getIgnoreImages) {
    removeGeminiManualPanel();
    window.__mangaTranslatorManualGeminiResultUrl = '';

    const panel = document.createElement('div');
    panel.id = 'mt-gemini-assist';
    panel.style.cssText = [
        'position:fixed',
        'right:16px',
        'bottom:16px',
        'z-index:2147483647',
        'width:260px',
        'background:#111',
        'color:#fff',
        'border:1px solid #333',
        'border-radius:8px',
        'box-shadow:0 10px 28px rgba(0,0,0,0.45)',
        'font-family:Arial,sans-serif',
        'font-size:12px',
        'padding:12px',
        'line-height:1.35',
    ].join(';');
    panel.innerHTML = `
        <div style="font-weight:700;margin-bottom:4px;">Manga Translator</div>
        <div id="mt-gemini-assist-description" style="color:#aaa;margin-bottom:8px;"></div>
        <div style="display:flex;gap:6px;margin-bottom:8px;">
            <button id="mt-gemini-use-last" style="flex:1;background:#FF4444;color:#fff;border:none;border-radius:5px;padding:7px;cursor:pointer;font-weight:700;">Usar última</button>
            <button id="mt-gemini-pick" style="flex:1;background:#2b5f9c;color:#fff;border:none;border-radius:5px;padding:7px;cursor:pointer;font-weight:700;">Selecionar</button>
        </div>
        <div id="mt-gemini-assist-status" style="color:#888;">Aguardando imagem gerada.</div>
    `;
    const imageNumber = Number.isFinite(Number(job.index)) ? Number(job.index) + 1 : 1;
    panel.querySelector('#mt-gemini-assist-description').textContent = `Imagem ${imageNumber}: marque o resultado correto se a detecção automática não pegar.`;
    panel.addEventListener('click', event => event.stopPropagation());
    document.documentElement.appendChild(panel);

    panel.querySelector('#mt-gemini-use-last').addEventListener('click', () => {
        const images = findGeneratedResultImages(getIgnoreImages());
        const candidate = images[images.length - 1];
        if (candidate) setManualGeminiResultUrl(getImageSource(candidate), 'last-button');
        else panel.querySelector('#mt-gemini-assist-status').textContent = 'Ainda não encontrei uma imagem candidata.';
    });

    panel.querySelector('#mt-gemini-pick').addEventListener('click', () => {
        const status = panel.querySelector('#mt-gemini-assist-status');
        status.textContent = 'Clique diretamente na imagem correta gerada pelo Gemini.';
        document.querySelectorAll('img').forEach(img => {
            if (isManualSelectableImage(img, getIgnoreImages())) {
                img.dataset.mtGeminiPickable = 'true';
                img.style.outline = '3px solid #FF4444';
                img.style.outlineOffset = '2px';
            }
        });
        if (window.__mangaTranslatorManualPickHandler) {
            document.removeEventListener('click', window.__mangaTranslatorManualPickHandler, true);
        }
        window.__mangaTranslatorManualPickHandler = (event) => {
            const img = event.target && event.target.closest ? event.target.closest('img') : null;
            if (!img || !isManualSelectableImage(img, getIgnoreImages())) return;
            event.preventDefault();
            event.stopPropagation();
            setManualGeminiResultUrl(getImageSource(img), 'image-click');
            document.removeEventListener('click', window.__mangaTranslatorManualPickHandler, true);
            window.__mangaTranslatorManualPickHandler = null;
            document.querySelectorAll('[data-mt-gemini-pickable="true"]').forEach(candidate => {
                candidate.style.outline = '';
                candidate.removeAttribute('data-mt-gemini-pickable');
            });
        };
        document.addEventListener('click', window.__mangaTranslatorManualPickHandler, true);
    });
}

function getEditableElement(root) {
    return GeminiDom.getEditableElement(root);
}

const resultExtractor = GeminiResultExtractor.createResultExtractor({
    sendLog,
    getUrlLogMetadata,
    sleep,
    runtime: chrome.runtime,
    pageWindow: window,
    pageDocument: document,
    fetchImpl: (...args) => fetch(...args),
});

function imageElementToDataUrl(image) {
    return resultExtractor.imageElementToDataUrl(image);
}

function fetchImageThroughGeminiPage(url, timeoutMs) {
    return resultExtractor.fetchImageThroughGeminiPage(url, timeoutMs);
}

function fetchGeminiImageThroughExtension(url) {
    return resultExtractor.fetchGeminiImageThroughExtension(url);
}

function getExtractionFailureKind(error) {
    return resultExtractor.getExtractionFailureKind(error);
}

function logExtractionStage(level, stage, url, attempt, error = null) {
    return resultExtractor.logExtractionStage(level, stage, url, attempt, error);
}

function blobToDataUrl(blob) {
    return resultExtractor.blobToDataUrl(blob);
}

function extractImageInGeminiTab(image, url, attempt = 0) {
    return resultExtractor.extractImageInGeminiTab(image, url, attempt);
}

function extractResultImage(resultImageElement, resultUrl, executionMode, attempt = 0) {
    return resultExtractor.extractResultImage(resultImageElement, resultUrl, executionMode, attempt);
}

function extractResultImageWithRetry(resultImageElement, resultUrl, executionMode, maxAttempts = 4, retryDelayMs = 1000) {
    return resultExtractor.extractResultImageWithRetry(
        resultImageElement,
        resultUrl,
        executionMode,
        maxAttempts,
        retryDelayMs
    );
}

const deletionController = GeminiDeletion.createDeletionController({
    root: document,
    pageWindow: window,
    storage: chrome.storage.local,
    sleep,
    sendLog,
});

async function shouldKeepConversationForDebug(delivery, executionMode) {
    if (executionMode !== 'background_delete' || !delivery || delivery.action !== 'GEMINI_ERROR') {
        return false;
    }
    const debugData = await new Promise(resolve => chrome.storage.local.get(['debugMode'], resolve));
    return debugData.debugMode === true;
}

function getExpectedGeminiJobId() {
    try {
        const parsed = new URL(window.location.href);
        const jobId = parsed.searchParams.get('jobId');
        return jobId && jobId.trim() ? jobId.trim() : null;
    } catch (_e) {
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
        } catch (_e) {
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

        if (response && response.ok === true && response.job) {
            return response.job;
        }

        if (response && response.ok === true && Object.prototype.hasOwnProperty.call(response, 'job')) {
            // Uma aba manual não possui jobId de correlação. Claim nulo é
            // definitivo e deve deixá-la completamente inerte.
            if (!expectedJobId) return null;
        } else if (!response) {
            // Compatibilidade transitória com fixtures/background antigo.
            // Em runtime atual CLAIM_GEMINI_JOB existe; este caminho nunca faz
            // full scan e será removido junto com o legado.
            claimUnsupported = true;
            break;
        }

        if (Date.now() - startedAt >= timeoutMs) return null;
        await sleep(500);
    } while (Date.now() - startedAt < timeoutMs);

    if (!claimUnsupported) return null;

    // Fallback estritamente direcionado: GET_TAB_ID + chave específica.
    // Não usa storage.get(null), não reivindica jobs de outras abas e não abre
    // keep-alive até encontrar exatamente o registro desta aba.
    let tabResponse = null;
    for (let attempt = 0; attempt < 5; attempt++) {
        tabResponse = await sendRuntimeMessage({ action: 'GET_TAB_ID' });
        if (tabResponse && Number.isInteger(tabResponse.tabId)) break;
        await sleep(500);
    }
    if (!tabResponse || !Number.isInteger(tabResponse.tabId)) return null;

    const tabId = tabResponse.tabId;
    const jobKey = `gemini_job_${tabId}`;
    const legacyStartedAt = Date.now();
    do {
        const data = await new Promise(resolve => chrome.storage.local.get([jobKey], resolve));
        const job = data && data[jobKey];
        if (job && (!expectedJobId || job.jobId === expectedJobId)) {
            return { ...job, geminiTabId: tabId };
        }
        // O fallback existe apenas para compatibilidade com background/fixtures
        // anteriores ao claim. Mantém retry limitado para cobrir a corrida em
        // que a aba nasce antes da persistência do job, sem procurar outras chaves.
        if (Date.now() - legacyStartedAt >= timeoutMs) return null;
        await sleep(500);
    } while (Date.now() - legacyStartedAt < timeoutMs);

    return null;
}

async function processGeminiJob() {
    debugConsole('log', '[MangaTranslator Gemini] processGeminiJob iniciado na aba');

    const currentPath = window.location.pathname;
    if (currentPath && currentPath.length > 8 && currentPath.startsWith('/app/')) {
        const st = await new Promise(r => chrome.storage.local.get(['deleting_urls'], r));
        const deleting = st.deleting_urls || [];
        const isBeingDeleted = deleting.some(u => {
            try { return new URL(u).pathname === currentPath; } catch { return u.includes(currentPath); }
        });
        if (isBeingDeleted) return;
    }

    const job = await claimGeminiJob({ timeoutMs: 5000 });
    const isExistingChat = currentPath.startsWith('/app/');
    if (!job) {
        if (!isExistingChat) {
            sendLog('warn', 'JOB_NOT_FOUND', 'Nenhum job válido foi reivindicado para esta aba — script desativado', {
                path: currentPath,
            });
        }
        closeKeepAlive();
        return;
    }

    const myTabId = job.geminiTabId;
    const recoveryResult = await deletionController.recoverPending({
        tabId: myTabId,
        sendDelivery: async delivery => {
            chrome.runtime.sendMessage(delivery);
        },
    });
    if (recoveryResult.handled) return;

    // Só um claim válido transforma esta aba em worker do MangaTranslator.
    openKeepAlive();
    debugConsole('log', '[MangaTranslator Gemini] Job confirmado por claim:', {
        jobId: (job.jobId || '').slice(0, 8),
        index: job.index,
        geminiTabId: myTabId,
    });

    let activeGeminiObserver = null;

    const scrollInterval = setInterval(() => {
        window.scrollTo(0, document.body.scrollHeight);
        const images = document.querySelectorAll('img');
        if (images.length > 0) images[images.length - 1].scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, 2000);

    async function deliverWithSecureDeletion(delivery, executionMode, shouldDeleteConversation) {
        if (executionMode !== 'background_delete') {
            if (shouldDeleteConversation) deleteCurrentConversation().catch(() => {});
            chrome.runtime.sendMessage(delivery);
            return true;
        }

        // Em debug, um erro de extração preserva a conversa e a aba para que o
        // usuário possa inspecionar exatamente o estado que causou a falha.
        // Fora de debug o comportamento permanece idêntico: entrega o erro e
        // executa a exclusão segura normalmente.
        if (await shouldKeepConversationForDebug(delivery, executionMode)) {
            sendLog('info', 'DEBUG_KEEP_CONVERSATION', 'Modo debug: conversa preservada após erro de extração.', {});
            chrome.runtime.sendMessage(delivery);
            return true;
        }

        // A lista automática deixa de se mover antes de procurar a conversa.
        clearInterval(scrollInterval);
        const deletion = await deletionController.deleteOrScheduleRecovery({
            tabId: myTabId,
            delivery,
        });
        if (deletion.deleted) {
            chrome.runtime.sendMessage(delivery);
            return true;
        }
        return false;
    }

    const assert = (condition, errorMessage, step, successMsg = '') => {
        if (!condition) {
            const fullError = `[ERRO CRÍTICO - ETAPA ${step}] ${errorMessage}`;
            debugConsole('error', fullError);
            sendLog('error', `TEST_FAIL_STEP_${step}`, errorMessage, { path: window.location.pathname });
            throw new Error(fullError); 
        } else {
            sendLog('success', `TEST_PASS_STEP_${step}`, successMsg || `Etapa ${step} com sucesso`, { path: window.location.pathname });
        }
    };

    try {
        reportProgress(`📡 OBTENDO IMAGEM...`, job.mangaTabId);
        debugConsole('log', '[MangaTranslator Gemini] Obtendo imagem da aba do mangá...', { index: job.index });
        sendLog('info', 'GEMINI_STEP_1', 'Obtendo imagem', { index: job.index });

        let imgResponse = null;
        for (let attempt = 1; attempt <= 5; attempt++) {
            imgResponse = await new Promise((resolve) => {
                chrome.runtime.sendMessage({ action: 'REQUEST_IMAGE_DATA', mangaTabId: job.mangaTabId, index: job.index }, (response) => {
                    if (chrome.runtime.lastError) resolve(null);
                    else resolve(response);
                });
            });
            if (imgResponse && imgResponse.srcData) break;
            await sleep(1000);
        }

        assert(imgResponse && imgResponse.srcData, 'Sem resposta da aba do mangá.', 1, 'Resposta inicial carregada com sucesso.');
        assert(imgResponse.srcData.startsWith('data:image/'), 'Os dados não são imagem válida.', 1, 'Base64 validada.');
        job.srcData = imgResponse.srcData;

        reportProgress(`⏳ AGUARDANDO INTERFACE...`, job.mangaTabId);
        debugConsole('log', '[MangaTranslator Gemini] Aguardando interface do Gemini...');
        let editor = await waitForElement('rich-textarea, .ql-editor, [contenteditable="true"]', 20000);
        assert(editor !== null, 'Editor não carregou.', 2, 'Editor alvo detectado');

        // Estimula o foco e remoção de restrição inicial no editor
        try {
            if (typeof editor.focus === 'function') editor.focus({ preventScroll: true });
            editor.dispatchEvent(new FocusEvent('focus', { bubbles: true, composed: true }));
            editor.dispatchEvent(new FocusEvent('focusin', { bubbles: true, composed: true }));
            window.dispatchEvent(new Event('focus'));
        } catch (e) {}

        // ── ETAPA 2.5: Ativar Conversa Momentânea / Temporária (Modo Padrão) ──
        const executionMode = job.executionMode
            || (await new Promise(r => chrome.storage.local.get(['geminiExecutionMode'], r))).geminiExecutionMode
            || 'temp_chat';

        let tempChatResult = { success: false };
        if (executionMode === 'temp_chat') {
            reportProgress(`🔒 ATIVANDO CONVERSA TEMPORÁRIA...`, job.mangaTabId);
            debugConsole('log', '[MangaTranslator Gemini] Ativando conversa temporária...');
            sendLog('info', 'GEMINI_STEP_TEMP_CHAT', 'Ativando conversa temporária no Gemini', {});
            try {
                const tempStatus = await GeminiTemporaryChat.ensureActive({
                    root: document,
                    timeoutMs: 12000,
                    sleep,
                    onLegacyFallback: () => {
                        sendLog('warn', 'GEMINI_TEMP_CHAT_POSITIONAL_FALLBACK', 'Fallback posicional semântico utilizado', {});
                    },
                });

                tempChatResult = {
                    success: tempStatus.status === 'already_active' || tempStatus.status === 'activated_verified',
                    alreadyActive: tempStatus.status === 'already_active',
                    activated: tempStatus.status === 'activated_verified',
                    notFound: tempStatus.status === 'unavailable',
                    verificationFailed: tempStatus.status === 'verification_failed',
                    status: tempStatus.status,
                };
                sendLog('info', 'GEMINI_TEMP_CHAT_STATUS', 'Status da conversa temporária', {
                    status: tempStatus.status,
                });

                if (tempStatus.status === 'activated_verified' || tempStatus.status === 'already_active') {
                    await sleep(1500);
                } else if (tempStatus.status === 'verification_failed') {
                    sendLog('warn', 'GEMINI_TEMP_CHAT_VERIFY_FAILED', 'Clique não confirmou ativação da conversa temporária', {});
                }
            } catch (tempErr) {
                debugConsole('warn', '[MangaTranslator Gemini] Aviso ao ativar conversa temporária:', tempErr && tempErr.message);
                sendLog('warn', 'GEMINI_TEMP_CHAT_ERR', `Aviso ao ativar conversa temporária: ${tempErr.message}`, {});
            }
        }

        // Re-obtém o editor mais atualizado do DOM após a transição da conversa temporária
        const liveEditor = document.querySelector('rich-textarea, .ql-editor, [contenteditable="true"]') || editor;
        const liveEditable = getEditableElement(liveEditor) || liveEditor;

        // O Gemini pode manter o editor no DOM enquanto ele ainda está bloqueado.
        // Não tente colar/injetar conteúdo em um editor explicitamente desabilitado:
        // além de falhar silenciosamente, isso prolonga o job até o watchdog.
        const editorIsDisabled = [liveEditor, liveEditable].some(el => el && (
            el.disabled === true ||
            (el.getAttribute && el.getAttribute('aria-disabled') === 'true') ||
            (el.getAttribute && el.getAttribute('contenteditable') === 'false')
        ));
        assert(!editorIsDisabled, 'Editor do Gemini está desabilitado.', 2);

        reportProgress(`📎 ANEXANDO IMAGEM...`, job.mangaTabId);
        debugConsole('log', '[MangaTranslator Gemini] Anexando imagem...');
        const file = dataURLtoFile(job.srcData, 'manga_page.png');
        assert(file.size > 0, 'Imagem gerada vazia.', 3, 'PNG verificado no buffer');

        const attachmentResult = await GeminiAttachment.attachFile({
            file,
            editor: liveEditable,
            editorRoot: liveEditor,
            root: document,
            timeoutMs: 15000,
            retryAfterMs: 2000,
            maxDispatches: 8,
            sleep,
        });

        if (!attachmentResult.confirmed) {
            debugConsole('warn', '[MangaTranslator Gemini] Attachment não foi confirmado após 15s; prosseguindo sem declarar sucesso.');
            sendLog('warn', 'GEMINI_STEP_3_WARN', 'Attachment não confirmado por evidência de DOM', {
                attempted: attachmentResult.attempted,
            });
        } else {
            const evidence = attachmentResult.evidence || {};
            debugConsole('log', '[MangaTranslator Gemini] Attachment confirmado:', {
                type: evidence.type,
                selector: evidence.selector,
            });
            sendLog('success', 'GEMINI_STEP_3_OK', 'Attachment confirmado por evidência de DOM', {
                type: evidence.type,
                selector: evidence.selector,
            });
        }
        await sleep(1000);

        reportProgress(`📤 ENVIANDO PROMPT...`, job.mangaTabId);
        debugConsole('log', '[MangaTranslator Gemini] Injetando prompt e enviando...');
        const fallbackPrompt = "Crie uma imagem traduzindo todas as falas desta imagem para o Português. Mantenha o sentido original e apenas altere ou modifique o texto na imagem.";
        let actualPrompt = fallbackPrompt;
        let usedFallback = true;
        
        if (job.prompt && job.prompt.trim().length > 0) {
            actualPrompt = job.prompt;
            usedFallback = false;
        }

        if (usedFallback) sendLog('error', 'PROMPT_FALLBACK', 'Prompt falhou ou está vazio. Usando emergência!', { fallbackLength: fallbackPrompt.length });

        // Re-obtém os elementos mais recentes do DOM
        const activeEditor = document.querySelector('rich-textarea, .ql-editor, [contenteditable="true"]') || liveEditor;
        const activeEditable = document.querySelector('rich-textarea [contenteditable="true"], .ql-editor[contenteditable="true"], [contenteditable="true"]')
                             || getEditableElement(activeEditor) 
                             || liveEditable;

        // Injeção limpa no MAIN world via inject.js
        window.dispatchEvent(new CustomEvent('MANGA_TRANSLATOR_SET_PROMPT', { detail: { prompt: actualPrompt } }));
        await sleep(200);

        // Injeção direta no contenteditable sem duplicar texto
        setPromptInEditor(activeEditable, activeEditor, actualPrompt);

        const promptLen = (activeEditable.textContent || '').trim().length;
        assert(promptLen >= 5, `O prompt não foi inserido. Comprimento: ${promptLen}`, 4, 'Prompt injetado com sucesso.');
        sendLog('success', 'PROMPT_INJECTED', 'Prompt confirmado no DOM', { promptLen });
        await sleep(1000);

        // Baseline precisa existir ANTES do submit para que imagens/respostas
        // antigas nunca sejam reivindicadas pelo job atual.
        const ignoreImages = new Set(
            Array.from(document.querySelectorAll('img'))
                .map(img => getImageSource(img))
                .filter(Boolean)
        );

        activeGeminiObserver = GeminiObserver.createGeminiObserver({
            jobId: job.jobId,
            root: document,
            editor: activeEditable,
            getEditor: () =>
                document.querySelector('rich-textarea [contenteditable="true"], .ql-editor[contenteditable="true"], [contenteditable="true"]')
                || activeEditable,
            ignoreImages,
            onStateChange: (type, detail) => {
                if (type === 'generation_started') {
                    sendLog('info', 'GEMINI_GENERATION_ACTIVE', 'Geração observada na UI', {
                        reason: detail && detail.reason,
                    });
                }
            },
        }).start();
        window.__mangaTranslatorActiveGeminiObserver = activeGeminiObserver;

        sendLog('info', 'GEMINI_OBSERVER_READY', 'Observer instalado antes do submit', {
            jobIdPrefix: String(job.jobId || '').slice(0, 8),
        });

        let submission = null;
        try {
            submission = await GeminiEditor.submitWithConfirmation({
                observer: activeGeminiObserver,
                getEditor: () =>
                    document.querySelector('rich-textarea [contenteditable="true"], .ql-editor[contenteditable="true"], [contenteditable="true"]')
                    || activeEditable,
                getSendButton: () => findSendButtonDeep(document.body),
                maxAttempts: 2,
                confirmationTimeoutMs: 5000,
                sleep,
                onAttempt: attempt => {
                    sendLog('info', 'GEMINI_SUBMIT_ATTEMPT', 'Tentativa de submit iniciada', { attempt });
                    if (attempt === 2) {
                        // Escalada única: pede foco temporário ao background. O
                        // DO_SEND_NOW continua sendo somente uma tentativa.
                        chrome.runtime.sendMessage({
                            action: 'FORCE_SEND_ACTIVATION',
                            geminiTabId: myTabId,
                            mangaTabId: job.mangaTabId,
                            windowId: job.windowId,
                            executionMode: job.executionMode,
                        }, () => { if (chrome.runtime.lastError) {} });
                    }
                },
                mainWorldFallback: async () => {
                    window.dispatchEvent(new CustomEvent('MANGA_TRANSLATOR_TRIGGER_SEND'));
                    sendLog('warn', 'GEMINI_SEND_FALLBACK', 'Fallback MAIN-world tentado; aguardando confirmação observável', {});
                    return true;
                },
            });
        } catch (submitError) {
            if (submitError && submitError.code === 'GEMINI_SUBMISSION_NOT_CONFIRMED') {
                sendLog('error', 'GEMINI_SUBMISSION_NOT_CONFIRMED', 'Nenhuma transição da UI confirmou o envio após duas tentativas', {});
                const error = new Error('GEMINI_SUBMISSION_NOT_CONFIRMED');
                error.code = 'GEMINI_SUBMISSION_NOT_CONFIRMED';
                throw error;
            }
            throw submitError;
        }

        // Esta flag permanece apenas para compatibilidade interna, mas agora é
        // escrita SOMENTE após confirmação externa do Observer V2.
        window.__mangaTranslatorJobSent = true;
        sendLog('success', 'GEMINI_SEND_SUCCESS', 'Envio confirmado por transição observável da UI', {
            attempt: submission.attempt,
            reason: submission.reason,
        });
        debugConsole('log', '[MangaTranslator Gemini] Envio confirmado pelo Observer V2.', {
            attempt: submission.attempt,
            reason: submission.reason,
        });

        assert(submission && submission.confirmed, 'Envio não foi confirmado pela interface.', 4, 'Submit confirmado pela UI');

            reportProgress(`🧠 GEMINI PROCESSANDO...`, job.mangaTabId);
            createGeminiManualPanel(job, () => ignoreImages);

            const shouldDeleteConversation = executionMode === 'minimized_window'
                || executionMode === 'background_delete'
                || (executionMode === 'temp_chat' && tempChatResult.notFound && !tempChatResult.alreadyActive);

            const configuredGenerationTimeout = Number(globalThis.__MT_GEMINI_GENERATION_TIMEOUT_MS__);
            const WAIT_TIMEOUT_MS = Number.isFinite(configuredGenerationTimeout) && configuredGenerationTimeout > 0
                ? configuredGenerationTimeout
                : 4 * 60 * 1000;
            const waitStartedAt = Date.now();
            const progressTimer = setInterval(() => {
                const elapsedSec = Math.floor((Date.now() - waitStartedAt) / 1000);
                reportProgress(`🧠 GEMINI PROCESSANDO (${elapsedSec}s)...`, job.mangaTabId);
            }, 5000);
            const cardNudgeTimer = setInterval(() => {
                try { tryClickModelImageCards(); } catch (_e) {}
            }, 3000);

            let resultUrl = null;
            let resultImageElement = null;
            try {
                const observedResult = await activeGeminiObserver.waitForResult(WAIT_TIMEOUT_MS);
                resultUrl = observedResult && observedResult.url;
                resultImageElement = observedResult && observedResult.image;
            } catch (waitError) {
                if (waitError && waitError.code === 'GEMINI_UI_ERROR') {
                    sendLog('error', 'GEMINI_ERROR', 'Erro visível da UI detectado pelo Observer V2', {
                        messageLength: String(waitError.message || '').length,
                    });
                    await deliverWithSecureDeletion({
                        action: 'GEMINI_ERROR',
                        mangaTabId: job.mangaTabId,
                        index: job.index,
                        error: `Retornou erro interface: ${String(waitError.message || 'Erro da interface do Gemini')}`,
                        jobId: job.jobId,
                        batchId: job.batchId,
                    }, executionMode, shouldDeleteConversation);
                    return;
                }

                if (waitError && waitError.code === 'GEMINI_RESULT_TIMEOUT') {
                    sendLog('error', 'GEMINI_TIMEOUT', 'Timeout de geração aguardando Observer V2', {});
                    await deliverWithSecureDeletion({
                        action: 'GEMINI_ERROR',
                        mangaTabId: job.mangaTabId,
                        index: job.index,
                        error: 'Tempo limite (4 min)',
                        jobId: job.jobId,
                        batchId: job.batchId,
                    }, executionMode, shouldDeleteConversation);
                    return;
                }
                throw waitError;
            } finally {
                clearInterval(progressTimer);
                clearInterval(cardNudgeTimer);
            }

            assert(resultUrl.startsWith('http') || resultUrl.startsWith('blob') || resultUrl.startsWith('data:image/'), 'URL Imagem inválida', 5, 'Mídia extraída blob');
            sendLog('success', 'GEMINI_IMG_FOUND', 'Imagem gerada!', getUrlLogMetadata(resultUrl));
            reportProgress(`📥 EXTRAINDO IMAGEM...`, job.mangaTabId);
            
            // Eleva a resolução da imagem CDN do Google para =s0 (original sem compressão)
            if (resultUrl.includes('googleusercontent.com') && /=s\d+/.test(resultUrl)) {
                resultUrl = resultUrl.replace(/=s\d+[^?#]*/, '=s0');
            }

            const extraction = await resultExtractor.extractOrAuxiliaryFallback({
                resultImageElement,
                resultUrl,
                executionMode,
                maxAttempts: 4,
                retryDelayMs: 1000,
                onAuxiliaryFallback: async ({ url }) => {
                    return deliverWithSecureDeletion({
                        action: 'GEMINI_RESULT_URL',
                        mangaTabId: job.mangaTabId,
                        index: job.index,
                        url,
                        jobId: job.jobId,
                        batchId: job.batchId,
                    }, executionMode, shouldDeleteConversation);
                },
            });

            if (extraction.kind === 'extracted' && extraction.dataUrl) {
                await deliverWithSecureDeletion({
                    action: 'GEMINI_IMAGE_EXTRACTED',
                    mangaTabId: job.mangaTabId,
                    index: job.index,
                    src: extraction.dataUrl,
                    jobId: job.jobId,
                    batchId: job.batchId,
                }, executionMode, shouldDeleteConversation);
            }
            return;
        } catch (error) {
            chrome.runtime.sendMessage({ action: 'GEMINI_ERROR', mangaTabId: job.mangaTabId, index: job.index, error: error.message, jobId: job.jobId, batchId: job.batchId });
        } finally {
            if (activeGeminiObserver) {
                try { activeGeminiObserver.stop(); } catch (_e) {}
                activeGeminiObserver = null;
            }
            if (window.__mangaTranslatorActiveGeminiObserver) {
                delete window.__mangaTranslatorActiveGeminiObserver;
            }
            clearInterval(scrollInterval);
            closeKeepAlive();
            removeGeminiManualPanel();
            // Limpar qualquer handler de seleção manual pendente
            if (window.__mangaTranslatorManualPickHandler) {
                document.removeEventListener('click', window.__mangaTranslatorManualPickHandler, true);
                delete window.__mangaTranslatorManualPickHandler;
            }
            // Remover outlines de seleção
            document.querySelectorAll('img').forEach(img => {
                if (img.style.outline && img.style.outline.includes('#FF4444')) {
                    img.style.outline = '';
                    img.style.outlineOffset = '';
                }
            });
    }
}
// Guarda de execução única: com registro dinâmico de content scripts, uma
// recarga ou uma dupla injeção acidental faria duas reivindicações do mesmo job
// e dois envios ao Gemini.
if (!window.__mt_gemini_started) {
    window.__mt_gemini_started = true;
    processGeminiJob();
}

function getElementText(el) {
    return deletionController.getElementText(el);
}

function findDeleteMenuItemCandidate() {
    return deletionController.findDeleteMenuItemCandidate();
}

function waitForDeleteMenuItem(timeout = 2000) {
    return deletionController.waitForDeleteMenuItem(timeout);
}

function findConfirmButtonCandidate(excludeEl = null) {
    return deletionController.findConfirmButtonCandidate(excludeEl);
}

function waitForConfirmButton(excludeEl = null, timeout = 5000) {
    return deletionController.waitForConfirmButton(excludeEl, timeout);
}

function escapeCssAttributeValue(value) {
    return deletionController.escapeCssAttributeValue(value);
}

function waitForElementToSettle(element, samples = 3, interval = 300) {
    return deletionController.waitForElementToSettle(element, samples, interval);
}

function deleteCurrentConversation(options = {}) {
    return deletionController.deleteCurrentConversation(options);
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'DO_SEND_NOW') {
        const stopBtn = GeminiDom.findVisibleStopButton(document);
        if (stopBtn) {
            sendResponse({ ok: true, alreadyGenerating: true });
            return false;
        }

        const editor = document.querySelector('rich-textarea [contenteditable="true"], .ql-editor[contenteditable="true"], [contenteditable="true"]');
        const sendBtn = findSendButtonDeep(document.body);
        let attempted = false;

        if (sendBtn && GeminiDom.isControlEnabled(sendBtn)) {
            attempted = clickSendButton(sendBtn);
        } else {
            GeminiEditor.nudgeEditor(editor);
            window.dispatchEvent(new CustomEvent('MANGA_TRANSLATOR_TRIGGER_SEND'));
            attempted = true;
        }

        // attempted != submitted. O caller deve aguardar o Observer V2.
        sendResponse({ ok: true, attempted });
        return false;
    }

    if (request.action === 'DELETE_CONVERSATION') {
        deleteCurrentConversation().then(ok => sendResponse({ ok })).catch((e) => sendResponse({ ok: false, error: e.message }));
        return true; 
    }
});


