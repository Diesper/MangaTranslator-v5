// content_gemini.js — Manga Translator v6.0

const sleep = ms => new Promise(r => setTimeout(r, ms));

const GeminiDom = globalThis.MangaTranslatorGeminiDom;
const GeminiObserver = globalThis.MangaTranslatorGeminiObserver;
const GeminiEditor = globalThis.MangaTranslatorGeminiEditor;
const GeminiTemporaryChat = globalThis.MangaTranslatorGeminiTemporaryChat;
if (!GeminiDom || !GeminiObserver || !GeminiEditor || !GeminiTemporaryChat) {
    throw new Error('Módulos Gemini DOM/Observer/Editor/TemporaryChat não foram carregados antes de content_gemini.js');
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
    return findAllElementsDeep(root, el => el.tagName === 'INPUT' && (el.type === 'file' || el.getAttribute('type') === 'file'));
}

function findAttachmentThumbnailDeep(root = document.body) {
    const containers = findAllElementsDeep(root, el => {
        const tag = (el.tagName || '').toLowerCase();
        const tid = (el.getAttribute('data-test-id') || el.getAttribute('data-testid') || '').toLowerCase();
        const cls = (typeof el.className === 'string' ? el.className : '').toLowerCase();
        return tag === 'file-preview' || tag === 'attachment-card' ||
               tid.includes('attachment') || tid.includes('preview') ||
               cls.includes('file-preview') || cls.includes('attachment-preview') || cls.includes('image-preview') ||
               cls.includes('attachment-container');
    });

    for (const c of containers) {
        const rect = c.getBoundingClientRect();
        if (rect.width > 20 && rect.height > 20) {
            const img = c.querySelector ? c.querySelector('img') : null;
            return { el: c, img, type: 'container', selector: c.tagName.toLowerCase() };
        }
    }

    const allImgs = findAllElementsDeep(root, el => el.tagName === 'IMG');
    for (const img of allImgs) {
        const src = img.src || '';
        if (src.startsWith('blob:') || (src.startsWith('data:image/') && src.length > 500)) {
            return { el: img, img, type: 'blob-img', selector: 'img[src^="blob:"]' };
        }
        const parentArea = img.closest ? img.closest('rich-textarea, .input-area, .chat-input, input-area') : null;
        if (parentArea && !isIgnoredGeminiImageSource(src)) {
            const w = img.naturalWidth || img.width || 0;
            const h = img.naturalHeight || img.height || 0;
            if (w > 20 && h > 20) {
                return { el: img, img, type: 'input-img', selector: 'input-area img' };
            }
        }
    }

    return null;
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

function imageElementToDataUrl(image) {
    if (!image || !image.complete || !image.naturalWidth || !image.naturalHeight) {
        return Promise.reject(new Error('Imagem renderizada ainda não está pronta'));
    }
    const canvas = document.createElement('canvas');
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const context = canvas.getContext('2d');
    context.drawImage(image, 0, 0);
    return Promise.resolve(canvas.toDataURL('image/png'));
}

function fetchImageThroughGeminiPage(url, timeoutMs = 20_000) {
    return new Promise((resolve, reject) => {
        const requestId = `mt-image-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        const timer = setTimeout(() => finish(new Error('Tempo limite ao extrair imagem na página Gemini')), timeoutMs);
        const onResult = event => {
            const detail = event.detail || {};
            if (detail.requestId !== requestId) return;
            finish(detail.dataUrl ? null : new Error(detail.error || 'Página Gemini não retornou a imagem'), detail.dataUrl);
        };
        const finish = (error, dataUrl) => {
            clearTimeout(timer);
            window.removeEventListener('MANGA_TRANSLATOR_FETCH_IMAGE_RESULT', onResult);
            if (error) reject(error); else resolve(dataUrl);
        };
        window.addEventListener('MANGA_TRANSLATOR_FETCH_IMAGE_RESULT', onResult);
        window.dispatchEvent(new CustomEvent('MANGA_TRANSLATOR_FETCH_IMAGE', { detail: { requestId, url } }));
    });
}

function fetchGeminiImageThroughExtension(url) {
    return new Promise((resolve, reject) => {
        chrome.runtime.sendMessage({
            action: 'FETCH_IMAGE_AS_BASE64',
            url,
            // O Service Worker só envia cookies quando a requisição parte de
            // uma aba Gemini e o host é um asset Google validado no router.
            geminiSession: true,
        }, response => {
            if (chrome.runtime.lastError) {
                reject(new Error(chrome.runtime.lastError.message || 'Falha no Service Worker'));
                return;
            }
            if (response && response.dataUrl) {
                resolve(response.dataUrl);
                return;
            }
            reject(new Error((response && response.error) || 'Service Worker não retornou a imagem'));
        });
    });
}

function getExtractionFailureKind(error) {
    const message = String(error && error.message || '').toLowerCase();
    if (/taint|cors|security|cross-origin/.test(message)) return 'canvas_or_cors';
    if (/failed to fetch|network|load failed/.test(message)) return 'network';
    if (/tempo limite|timeout|abort/.test(message)) return 'timeout';
    if (/http \d{3}/.test(message)) return 'http';
    return 'unknown';
}

function logExtractionStage(level, stage, url, attempt, error = null) {
    const extra = { ...getUrlLogMetadata(url), stage, attempt };
    if (error) {
        extra.errorName = error.name || 'Error';
        extra.failureKind = getExtractionFailureKind(error);
        extra.messageLength = String(error.message || '').length;
    }
    sendLog(level, 'GEMINI_EXTRACT_STAGE', error
        ? `Etapa ${stage} falhou durante a extração.`
        : `Etapa ${stage} concluiu a extração.`, extra);
}

function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => resolve(reader.result);
        reader.onerror = reject;
        reader.readAsDataURL(blob);
    });
}

async function extractImageInGeminiTab(image, url, attempt = 0) {
    try {
        const dataUrl = await imageElementToDataUrl(image);
        logExtractionStage('info', 'canvas', url, attempt);
        return dataUrl;
    } catch (canvasError) {
        logExtractionStage('warn', 'canvas', url, attempt, canvasError);
        try {
            const dataUrl = await fetchImageThroughGeminiPage(url);
            logExtractionStage('info', 'gemini_page_fetch', url, attempt);
            return dataUrl;
        } catch (pageFetchError) {
            logExtractionStage('warn', 'gemini_page_fetch', url, attempt, pageFetchError);
            // Fallback privilegiado, ainda sem aba auxiliar: o Service Worker
            // possui host permission e pode fazer a leitura com a sessão do
            // Gemini, somente para assets googleusercontent validados.
            try {
                const dataUrl = await fetchGeminiImageThroughExtension(url);
                logExtractionStage('info', 'service_worker_session', url, attempt);
                return dataUrl;
            } catch (serviceWorkerError) {
                logExtractionStage('warn', 'service_worker_session', url, attempt, serviceWorkerError);
                throw serviceWorkerError;
            }
        }
    }
}

async function extractResultImage(resultImageElement, resultUrl, executionMode, attempt = 0) {
    if (resultUrl.startsWith('data:image/')) return resultUrl;
    if (resultUrl.startsWith('blob:')) {
        const response = await fetch(resultUrl);
        return blobToDataUrl(await response.blob());
    }
    if (executionMode === 'background_delete') {
        return extractImageInGeminiTab(resultImageElement, resultUrl, attempt);
    }
    return new Promise((resolve, reject) => {
        chrome.runtime.sendMessage({ action: 'FETCH_IMAGE_AS_BASE64', url: resultUrl }, response => {
            if (response && response.dataUrl) resolve(response.dataUrl);
            else reject(new Error('Falha base64 background'));
        });
    });
}

async function extractResultImageWithRetry(resultImageElement, resultUrl, executionMode, maxAttempts = 4, retryDelayMs = 1000) {
    let lastError = null;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
        if (attempt > 0) {
            sendLog('warn', 'GEMINI_EXTRACT_RETRY_ALL', 'Repetindo toda a cadeia de extração por possível instabilidade.', {
                ...getUrlLogMetadata(resultUrl),
                attempt,
            });
            await sleep(retryDelayMs);
        }
        try {
            return await extractResultImage(resultImageElement, resultUrl, executionMode, attempt);
        } catch (error) {
            lastError = error;
        }
    }
    throw lastError || new Error('Todas as tentativas de extração falharam');
}

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
    const recoveryKey = `gemini_delete_recovery_${myTabId}`;
    const recoveryData = await new Promise(resolve => chrome.storage.local.get([recoveryKey], resolve));
    const recovery = recoveryData[recoveryKey];
    if (recovery && recovery.delivery) {
        const deleted = await deleteCurrentConversation({ lockScroll: true });
        await chrome.storage.local.remove(recoveryKey);
        sendLog(deleted ? 'success' : 'warn', 'DELETE_RECOVERY', deleted
            ? 'Conversa excluída após recarregar a aba.'
            : 'Exclusão continuou sem confirmação após a recuperação.', { chatId: recovery.chatId || null });
        chrome.runtime.sendMessage(recovery.delivery);
        return;
    }

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
        if (await deleteCurrentConversation()) {
            chrome.runtime.sendMessage(delivery);
            return true;
        }

        // Preserva a entrega e refaz a página. Na nova injeção, o bloco de
        // recuperação acima usa os métodos 1–3 com rolagem bloqueada.
        await chrome.storage.local.set({ [recoveryKey]: {
            chatId: window.location.pathname.match(/\/app\/([a-z0-9_-]+)/i)?.[1] || null,
            delivery,
            createdAt: Date.now(),
        } });
        window.location.reload();
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

        const clipboardData = new DataTransfer();
        clipboardData.items.add(file);

        if (typeof liveEditable.focus === 'function') liveEditable.focus({ preventScroll: true });
        if (typeof liveEditor.focus === 'function' && liveEditor !== liveEditable) liveEditor.focus({ preventScroll: true });
        liveEditable.dispatchEvent(new FocusEvent('focus', { bubbles: true, composed: true }));
        liveEditable.dispatchEvent(new FocusEvent('focusin', { bubbles: true, composed: true }));
        window.dispatchEvent(new Event('focus'));

        // Método A: Disparo de evento paste com composed: true
        const pasteEvt = new ClipboardEvent('paste', { bubbles: true, cancelable: true, composed: true, clipboardData });
        liveEditable.dispatchEvent(pasteEvt);
        if (liveEditor !== liveEditable) {
            liveEditor.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, composed: true, clipboardData }));
        }
        document.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, composed: true, clipboardData }));

        // Método B: Injeção direta em input[type="file"] em Light DOM e Shadow Roots
        const fileInputs = findFileInputsDeep(document.body);
        for (const fi of fileInputs) {
            try {
                fi.files = clipboardData.files;
                fi.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
                fi.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
            } catch (e) {}
        }

        // Método C: Drag and Drop fallback
        try {
            const dragEvt = new DragEvent('drop', { bubbles: true, cancelable: true, composed: true, dataTransfer: clipboardData });
            liveEditor.dispatchEvent(dragEvt);
        } catch (e) {}

        // Confirmação de Thumbnail sem falsos positivos (até 15s)
        let thumbResult = null;
        for (let i = 0; i < 30; i++) { 
            await sleep(500);
            thumbResult = findAttachmentThumbnailDeep(document.body);
            if (thumbResult) break;

            // A cada 4 tentativas (2s), repete o paste e atribuição de arquivo
            if (i > 0 && i % 4 === 0) {
                try {
                    liveEditable.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, composed: true, clipboardData }));
                    const currentFIs = findFileInputsDeep(document.body);
                    for (const fi of currentFIs) {
                        try {
                            fi.files = clipboardData.files;
                            fi.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
                        } catch (e) {}
                    }
                } catch (e) {}
            }
        }

        if (!thumbResult) {
            debugConsole('warn', '[MangaTranslator Gemini] Thumbnail não detectado após 15s, prosseguindo com envio...');
            sendLog('warn', 'GEMINI_STEP_3_WARN', 'Thumb não detectado explicitamente, prosseguindo com envio', {});
        } else {
            debugConsole('log', '[MangaTranslator Gemini] Thumbnail confirmado:', thumbResult && { type: thumbResult.type, selector: thumbResult.selector });
            sendLog('success', 'GEMINI_STEP_3_OK', 'Thumbnail confirmado', { type: thumbResult.type, selector: thumbResult.selector });
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

            let base64 = null;
            let extractionError = null;
            try {
                // Preserva as quatro tentativas históricas da extensão. Cada
                // passagem percorre a cadeia completa sem abrir uma aba.
                base64 = await extractResultImageWithRetry(resultImageElement, resultUrl, executionMode);
            } catch (error) {
                extractionError = error;
            }

            if (base64) {
                await deliverWithSecureDeletion({ action: 'GEMINI_IMAGE_EXTRACTED', mangaTabId: job.mangaTabId, index: job.index, src: base64, jobId: job.jobId, batchId: job.batchId }, executionMode, shouldDeleteConversation);
                return;
            }

            // O diagnóstico é propositalmente apenas no log: a tradução ainda
            // continua pela compatibilidade histórica da aba auxiliar.
            sendLog('warn', 'GEMINI_EXTRACT_DIAGNOSTIC', 'Todas as rotas sem aba auxiliar falharam; diagnóstico registrado.', {
                ...getUrlLogMetadata(resultUrl),
                attempts: 4,
                finalErrorName: extractionError && extractionError.name ? extractionError.name : 'Error',
                finalFailureKind: getExtractionFailureKind(extractionError),
                finalMessageLength: String(extractionError && extractionError.message || '').length,
            });
            sendLog('warn', 'GEMINI_AUXILIARY_FALLBACK', 'Último recurso: usando aba auxiliar. Este não é o comportamento padrão e deve ser investigado.', {
                ...getUrlLogMetadata(resultUrl),
                reason: 'all_direct_paths_failed',
            });
            await deliverWithSecureDeletion({ action: 'GEMINI_RESULT_URL', mangaTabId: job.mangaTabId, index: job.index, url: resultUrl, jobId: job.jobId, batchId: job.batchId }, executionMode, shouldDeleteConversation);
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
    if (!el) return '';
    return [
        el.innerText,
        el.textContent,
        el.getAttribute && el.getAttribute('aria-label'),
        el.getAttribute && el.getAttribute('mattooltip'),
        el.getAttribute && el.getAttribute('title'),
        el.getAttribute && el.getAttribute('data-test-id'),
        el.getAttribute && el.getAttribute('data-testid'),
    ].filter(Boolean).join(' ').toLowerCase().trim();
}

function hoverElement(el) {
    if (!el) return;
    el.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
    el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
}

function clickElement(el) {
    if (!el) return;
    try {
        if (typeof PointerEvent === 'function') {
            el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'mouse' }));
            el.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerType: 'mouse' }));
        }
        el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
        el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    } catch (_e) {}
    el.click();
}

function findDeleteMenuItemCandidate() {
    const selectors = [
        'menu-item',
        'mat-menu-item',
        '[role="menuitem"]',
        'li[role="option"]',
        'div[role="option"]',
        'button[role="menuitem"]',
        '[class*="menu-item"]',
        '[class*="dropdown"] li',
        '[class*="dropdown"] button',
        '.mat-mdc-menu-item',
        '.cdk-overlay-pane button',
        '.cdk-overlay-pane [role="menuitem"]',
    ].join(',');
    const deleteWords = ['excluir', 'delete', 'apagar', 'remover', 'remove', 'deletar'];
    const candidates = Array.from(document.querySelectorAll(selectors));
    const item = candidates.find(el => {
        const text = getElementText(el);
        return deleteWords.some(word => text.includes(word));
    });
    return { item, candidateCount: candidates.length };
}

async function waitForDeleteMenuItem(timeout = 2600) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
        const result = findDeleteMenuItemCandidate();
        if (result.item) return result.item;
        await sleep(100);
    }
    return null;
}

function findConfirmButtonCandidate(excludeEl = null) {
    const confirmWords = ['excluir', 'delete', 'confirmar', 'confirm', 'apagar', 'sim', 'yes', 'ok', 'deletar'];
    const cancelWords = ['cancel', 'cancelar', 'não', 'nao', 'no', 'back', 'voltar', 'dismiss'];
    const dialogs = Array.from(document.querySelectorAll('[role="dialog"], mat-dialog-container, .mat-mdc-dialog-container, .cdk-overlay-pane'));
    const scopes = dialogs.length > 0 ? dialogs : [document];
    const buttons = scopes
        .flatMap(scope => Array.from(scope.querySelectorAll('button, [role="button"]')))
        .filter(el => el !== excludeEl && !(excludeEl && excludeEl.contains && excludeEl.contains(el)) && el.getAttribute('role') !== 'menuitem');
    const item = buttons.find(el => {
        const text = getElementText(el);
        if (!text || cancelWords.some(word => text.includes(word))) return false;
        return confirmWords.some(word => text === word || text.includes(word));
    });
    return { item, candidateCount: buttons.length };
}

async function waitForConfirmButton(excludeEl = null, timeout = 2600) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
        const result = findConfirmButtonCandidate(excludeEl);
        if (result.item) return result.item;
        await sleep(100);
    }
    return null;
}

function escapeCssAttributeValue(value) {
    const input = String(value || '');
    if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') return CSS.escape(input);
    // chatId usa [a-z0-9_-], mas o fallback mantém o seletor seguro em
    // runtimes de teste ou navegadores sem CSS.escape.
    return input.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

let _deletionInProgress = false;

async function waitForElementToSettle(element, samples = 3, interval = 300) {
    if (!element || !element.isConnected) return false;
    let previous = null;
    for (let sample = 0; sample < samples; sample++) {
        if (!element.isConnected) return false;
        const rect = element.getBoundingClientRect();
        const position = `${Math.round(rect.top)}:${Math.round(rect.left)}:${Math.round(rect.width)}:${Math.round(rect.height)}`;
        if (previous !== null && position !== previous) {
            sample = 0; // A lista se moveu; reinicia a janela de estabilidade.
        }
        previous = position;
        await sleep(interval);
    }
    return element.isConnected;
}

async function deleteCurrentConversation({ lockScroll = false } = {}) {
    if (_deletionInProgress) return false;
    _deletionInProgress = true;
    let releaseScrollLock = () => {};

    try {
        const debugData = await new Promise(r => chrome.storage.local.get(['debugMode'], r));
        if (debugData.debugMode === true) {
            sendLog('info', 'DEBUG_MODE_SKIP', 'Modo debug ativo, pulando deleção da conversa');
            return true;
        }

        const chatMatch = window.location.pathname.match(/\/app\/([a-z0-9_-]+)/i);
        const chatId = chatMatch && chatMatch[1];
        if (!chatId) throw new Error('A URL não possui o ID da conversa ativa.');

        // A barra lateral pode estar fechada em abas ocultas. O clique nativo é
        // deliberado: evita coordenadas sintéticas e funciona sem cursor físico.
        const sidebarToggle = document.querySelector('button[data-test-id="side-nav-toggle"], button[aria-label*="menu" i], button[aria-label*="barra lateral" i]');
        if (!document.querySelector(`a[href*="${escapeCssAttributeValue(chatId)}"]`) && sidebarToggle) {
            sidebarToggle.click();
            await sleep(700); // Tempo para a animação e os itens da barra lateral aparecerem.
        }

        let activeLink = null;
        for (let attempt = 0; attempt < 16; attempt++) {
            activeLink = document.querySelector(`a[href*="${escapeCssAttributeValue(chatId)}"]`);
            if (activeLink) break;
            await sleep(250);
        }
        if (!activeLink) throw new Error('A conversa ativa não foi localizada na barra lateral.');

        // Método 2: estabiliza no viewport a linha que já foi validada pelo ID.
        activeLink.scrollIntoView({ block: 'center', behavior: 'instant' });
        await sleep(700);
        if (!await waitForElementToSettle(activeLink)) {
            throw new Error('A conversa alvo não estabilizou na barra lateral.');
        }

        // Para jamais abrir o menu de uma conversa vizinha, sobe somente até o
        // primeiro pai que contém mais de um link /app/.
        let rowContainer = activeLink;
        while (rowContainer.parentElement) {
            const parent = rowContainer.parentElement;
            if (parent.querySelectorAll('a[href*="/app/"]').length > 1) break;
            rowContainer = parent;
        }

        if (lockScroll) {
            // Método 4 (fallback após reload): mantém a posição da página e do
            // contêiner rolável da conversa enquanto o menu/modal é acionado.
            const targets = [document.scrollingElement];
            for (let parent = rowContainer.parentElement; parent && parent !== document.body; parent = parent.parentElement) {
                const style = getComputedStyle(parent);
                if (/(auto|scroll)/.test(style.overflowY)) targets.push(parent);
            }
            const cleanups = [...new Set(targets.filter(Boolean))].map(target => {
                const top = target.scrollTop;
                const left = target.scrollLeft;
                const restore = () => { target.scrollTop = top; target.scrollLeft = left; };
                target.addEventListener('scroll', restore, { passive: true });
                return () => target.removeEventListener('scroll', restore);
            });
            const preventScrollInput = event => event.preventDefault();
            window.addEventListener('wheel', preventScrollInput, { passive: false });
            window.addEventListener('touchmove', preventScrollInput, { passive: false });
            releaseScrollLock = () => {
                cleanups.forEach(cleanup => cleanup());
                window.removeEventListener('wheel', preventScrollInput);
                window.removeEventListener('touchmove', preventScrollInput);
            };
        }
        const rowButtons = Array.from(rowContainer.querySelectorAll('button, [role="button"]'))
            .filter(button => button !== activeLink && !activeLink.contains(button));
        const menuButton = rowButtons.find(button => button.hasAttribute('aria-haspopup') || button.hasAttribute('aria-expanded'))
            || rowButtons[rowButtons.length - 1];
        if (!menuButton) throw new Error('Menu de opções da conversa não encontrado.');

        await sleep(400); // Evita abrir o menu durante um reflow tardio da lista.
        menuButton.click();
        await sleep(700); // Aguarda o Angular CDK terminar de montar o overlay.
        // Método 3: após abrir o menu, confirma que a mesma linha ainda está
        // conectada e ainda representa o chatId do job antes de clicar Excluir.
        if (!rowContainer.isConnected || !rowContainer.querySelector(`a[href*="${escapeCssAttributeValue(chatId)}"]`)) {
            throw new Error('A lista mudou enquanto o menu era aberto.');
        }
        let deleteItem = null;
        for (let attempt = 0; attempt < 20; attempt++) {
            const candidates = Array.from(document.querySelectorAll('div[role="menuitem"], [role="menu"] button, .mat-mdc-menu-item, button'));
            deleteItem = candidates.find(element => /^(excluir|delete)$/i.test((element.textContent || '').trim()));
            if (deleteItem) break;
            await sleep(100);
        }
        if (!deleteItem) throw new Error('Opção Excluir não encontrada no menu.');
        if (!await waitForElementToSettle(deleteItem, 2, 250)) {
            throw new Error('A opção Excluir não permaneceu estável no menu.');
        }

        // Não use clickElement aqui: eventos MouseEvent sintéticos podem fazer o
        // Angular CDK ativar o primeiro item do menu, e não o item Excluir.
        (deleteItem.closest('div[role="menuitem"], li, button') || deleteItem).click();
        await sleep(800); // Aguarda o diálogo de confirmação ser posicionado.

        let confirmButton = null;
        for (let attempt = 0; attempt < 25; attempt++) {
            const deleteButtons = Array.from(document.querySelectorAll('button'))
                .filter(button => /^(excluir|delete)$/i.test((button.textContent || '').trim()));
            if (deleteButtons.length) {
                // O diálogo é anexado por último no body; o último botão é a
                // confirmação, não a opção recém-clicada do menu.
                confirmButton = deleteButtons[deleteButtons.length - 1];
                break;
            }
            await sleep(200);
        }
        if (!confirmButton) throw new Error('Confirmação da exclusão não encontrada.');
        if (!await waitForElementToSettle(confirmButton, 2, 300)) {
            throw new Error('O botão de confirmação não estabilizou no diálogo.');
        }

        confirmButton.click();
        await sleep(1200); // Dá tempo de a requisição batchexecute persistir.
        sendLog('success', 'DELETE_OK', 'Conversa excluída com segurança!', { chatId });
        return true;
    } catch (e) {
        sendLog('warn', 'DELETE_ERROR', `Erro na deleção: ${e.message}`, {});
        return false;
    } finally {
        releaseScrollLock();
        _deletionInProgress = false;
    }
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


