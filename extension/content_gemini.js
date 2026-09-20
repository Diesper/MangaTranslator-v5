// content_gemini.js — Manga Translator v4.0

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── Keep-alive sob demanda ───────────────────────────────────────────────────
// Antes a porta era aberta no carregamento do script, ou seja, QUALQUER aba do
// Gemini que o usuário abrisse manualmente mantinha o Service Worker acordado.
// Agora a porta só é aberta depois que esta aba reivindica um job real.
let keepAlivePort = null;
function openKeepAlive() {
    if (keepAlivePort) return;
    try { keepAlivePort = chrome.runtime.connect({ name: 'gemini-keep-alive' }); } catch (_e) { keepAlivePort = null; }
}
function closeKeepAlive() {
    if (!keepAlivePort) return;
    try { keepAlivePort.disconnect(); } catch (_e) {}
    keepAlivePort = null;
}
openKeepAlive();

function sendLog(level, action_name, detail, extra = {}) {
    chrome.runtime.sendMessage({ action: 'LOG_ENTRY', level, source: 'gemini', action_name, detail, extra }, () => { if (chrome.runtime.lastError) {} });
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

// ── TemporaryChatActivator (Conversa Momentânea / Modo Temporário do Gemini) ──
const TemporaryChatActivator = {
    sleep(ms) {
        return new Promise((r) => setTimeout(r, ms));
    },

    triggerClick(el) {
        if (!el) return false;
        try { el.focus({ preventScroll: true }); } catch (e) {}
        const rect = el.getBoundingClientRect();
        const clientX = (rect && rect.width > 0) ? rect.left + rect.width / 2 : 0;
        const clientY = (rect && rect.height > 0) ? rect.top + rect.height / 2 : 0;
        const opts = { bubbles: true, cancelable: true, view: window, clientX, clientY };

        try { el.dispatchEvent(new PointerEvent('pointerdown', opts)); } catch (e) {}
        try { el.dispatchEvent(new MouseEvent('mousedown', opts)); } catch (e) {}
        try { el.dispatchEvent(new PointerEvent('pointerup', opts)); } catch (e) {}
        try { el.dispatchEvent(new MouseEvent('mouseup', opts)); } catch (e) {}
        try { el.click(); } catch (e) {}
        return true;
    },

    findInTree(root, predicate) {
        if (!root) return null;
        try {
            if (predicate(root)) return root;
        } catch (e) {}

        try {
            if (root.shadowRoot) {
                const found = this.findInTree(root.shadowRoot, predicate);
                if (found) return found;
            }
        } catch (e) {}

        const children = root.children || [];
        for (let i = 0; i < children.length; i++) {
            const found = this.findInTree(children[i], predicate);
            if (found) return found;
        }
        return null;
    },

    findTempChatButton() {
        const keywords = [
            'momentân',
            'momentan',
            'temporár',
            'temporar',
            'temporary'
        ];

        const allButtons = Array.from(document.querySelectorAll('button, [role="button"], [role="switch"], a, div[tabindex], span[tabindex]'));
        for (const b of allButtons) {
            const txt = (b.innerText || b.textContent || '').trim().toLowerCase();
            const label = (b.getAttribute('aria-label') || '').toLowerCase();
            const title = (b.getAttribute('title') || '').toLowerCase();

            for (const kw of keywords) {
                if (txt.includes(kw) || label.includes(kw) || title.includes(kw)) {
                    return b.closest('button, [role="button"], a') || b;
                }
            }
        }

        const testIdSelectors = [
            'button[data-test-id="temp-chat-button"]',
            '[data-test-id="temp-chat-button"]',
            'button[data-test-id*="temp-chat"]',
            '[data-test-id*="temp-chat"]',
            'button[data-test-id*="moment"]',
            '[data-test-id*="moment"]'
        ];
        for (const sel of testIdSelectors) {
            const el = document.querySelector(sel);
            if (el) return el;
        }

        return this.findInTree(document.body, (node) => {
            if (!node) return false;
            const txt = (node.innerText || node.textContent || '').toLowerCase();
            const label = (node.getAttribute ? node.getAttribute('aria-label') || '' : '').toLowerCase();
            const title = (node.getAttribute ? node.getAttribute('title') || '' : '').toLowerCase();
            const tid = (node.getAttribute ? node.getAttribute('data-test-id') || '' : '').toLowerCase();

            if (keywords.some(kw => txt.includes(kw) || label.includes(kw) || title.includes(kw) || tid.includes(kw))) return true;
            return false;
        });
    },

    findButtonByPosition() {
        const winW = window.innerWidth;
        const candidates = [];

        const allClickables = Array.from(document.querySelectorAll('button, [role="button"], a, div[tabindex], span[tabindex]'));
        for (const el of allClickables) {
            const rect = el.getBoundingClientRect();
            if (rect.top >= 0 && rect.top <= 90 && rect.right >= (winW - 450) && rect.left <= winW) {
                const txt = (el.innerText || el.textContent || '').trim().toLowerCase();
                const isPill = rect.width >= 70 && rect.height >= 24;
                const hasMomentKeyword = txt.includes('moment') || txt.includes('conversa') || txt.includes('ativar');

                if (isPill || hasMomentKeyword) {
                    candidates.push({
                        el: el.closest('button, [role="button"]') || el,
                        rect,
                        priority: hasMomentKeyword ? 10 : (isPill ? 5 : 1)
                    });
                }
            }
        }

        if (candidates.length > 0) {
            candidates.sort((a, b) => b.priority - a.priority);
            return candidates[0].el;
        }

        const testPoints = [
            { x: winW - 140, y: 35 },
            { x: winW - 180, y: 35 },
            { x: winW - 100, y: 35 },
            { x: winW - 220, y: 35 }
        ];

        for (const pt of testPoints) {
            try {
                const elAtPt = document.elementFromPoint(pt.x, pt.y);
                if (elAtPt) {
                    const btn = elAtPt.closest('button, [role="button"], a, div[tabindex]') || elAtPt;
                    const txt = (btn.innerText || btn.textContent || '').toLowerCase();
                    if (txt.includes('moment') || txt.includes('conversa') || txt.includes('ativar') || btn.tagName === 'BUTTON') {
                        return btn;
                    }
                }
            } catch (e) {}
        }

        return null;
    },

    isAlreadyActive(btn) {
        if (btn) {
            const txt = (btn.innerText || btn.textContent || '').trim().toLowerCase();
            // Se o texto é "Desativar conversa momentânea", então já está ATIVO!
            if (txt.includes('desativar') && (txt.includes('moment') || txt.includes('conversa') || txt.includes('temporár') || txt.includes('temporary'))) {
                return true;
            }
            // Se diz explicitamente "Ativar", está INATIVO
            if (txt.includes('ativar') || txt.includes('turn on') || txt.includes('enable')) {
                return false;
            }

            if (btn.getAttribute('aria-checked') === 'true') return true;
            if (btn.getAttribute('aria-pressed') === 'true') return true;
            if (btn.getAttribute('data-state') === 'active') return true;

            const cls = (btn.className || '').toString().toLowerCase();
            if (cls.includes('active') || cls.includes('selected') || cls.includes('checked')) {
                return true;
            }
        }

        // Checa indicadores ou chips específicos de conversa momentânea na página
        const indicators = document.querySelectorAll('[data-test-id*="moment"], [data-test-id*="temp-chat"], .momentary-indicator, .temp-chat-indicator');
        for (const ind of indicators) {
            const txt = (ind.innerText || ind.textContent || '').toLowerCase();
            if (txt.includes('momentân') || txt.includes('momentan') || txt.includes('temporár') || txt.includes('temporary')) {
                return true;
            }
        }

        return false;
    },

    async ensureTemporaryChatActive(maxSeconds = 12) {
        console.log('[MangaTranslator Gemini] Verificando status da "Conversa momentânea/temporária"...');
        const startTime = Date.now();

        while (Date.now() - startTime < maxSeconds * 1000) {
            let btn = this.findTempChatButton() || this.findButtonByPosition();

            if (btn) {
                if (this.isAlreadyActive(btn)) {
                    console.log('[MangaTranslator Gemini] Conversa temporária já está ATIVADA na página.');
                    return { success: true, alreadyActive: true };
                }

                const label = (btn.innerText || btn.textContent || btn.getAttribute('aria-label') || '').trim();
                console.log(`[MangaTranslator Gemini] Botão de conversa temporária encontrado ("${label}"). Acionando clique...`);
                this.triggerClick(btn);
                await this.sleep(600);

                const btnAfter = this.findTempChatButton() || this.findButtonByPosition();
                const activeNow = this.isAlreadyActive(btnAfter) || !((btnAfter?.innerText || '').toLowerCase().includes('ativar'));
                console.log('[MangaTranslator Gemini] Conversa temporária acionada com sucesso.', { activeNow });
                return { success: true, activated: true };
            }

            await this.sleep(500);
        }

        console.warn('[MangaTranslator Gemini] Não foi possível localizar o botão de Conversa Momentânea após tentativas.');
        return { success: false, notFound: true };
    }
};

function getImageSource(img) {
    if (!img) return '';
    if (img.dataset && img.dataset.src && !img.src) img.src = img.dataset.src;
    return img.currentSrc || img.src || (img.dataset && img.dataset.src) || img.getAttribute('src') || '';
}

function isIgnoredGeminiImageSource(src) {
    const lower = String(src || '').toLowerCase();
    return !lower
        || lower.includes('avatar')
        || lower.includes('favicon')
        || lower.includes('emoji')
        || lower.includes('profile')
        || lower.includes('googleusercontent.com/a/')
        || lower.includes('gstatic.com/images/branding');
}

function isModelResponseImage(img) {
    if (!img) return false;
    const modelSelector = [
        'model-response',
        '[data-test-id*="model-response"]',
        '.model-response-text',
        '.response-container',
        '.model-turn',
        '[data-message-author="model"]',
        'message-content.model',
        '.presented-turn-content',
        'bard-model-response',
        'div[data-turn-role="model"]',
        '.model-response-container'
    ].join(', ');

    try {
        if (img.closest && img.closest(modelSelector)) return true;
    } catch(e) {}
    return false;
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
    if (src.includes('googleusercontent.com/gg-dl/') || src.startsWith('blob:https://gemini.google.com/') || src.startsWith('blob:http://127.0.0.1/')) {
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
    const list = [];
    if (!root) return list;
    function walk(node) {
        if (!node) return;
        if (node.nodeType === Node.ELEMENT_NODE) {
            try { if (matcher(node)) list.push(node); } catch(e) {}
            try { if (node.shadowRoot) walk(node.shadowRoot); } catch(e) {}
        }
        let child = node.firstChild;
        while (child) {
            walk(child);
            child = child.nextSibling;
        }
    }
    walk(root);
    return list;
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
    const allClickables = findAllElementsDeep(root, el => {
        if (!el || el.nodeType !== Node.ELEMENT_NODE) return false;
        const tag = el.tagName.toLowerCase();
        const role = (el.getAttribute('role') || '').toLowerCase();
        return tag === 'button' || role === 'button' || tag.includes('button') || tag === 'mat-icon-button';
    });

    const blacklist = ['feedback', 'report', 'survey', 'bug', 'cancel', 'cancelar', 'close', 'fechar', 'dismiss', 'reject', 'mic', 'microfone', 'voice', 'audio', 'stop', 'help', 'ajuda', 'clear', 'limpar'];

    for (let i = allClickables.length - 1; i >= 0; i--) {
        const btn = allClickables[i];
        const label       = (btn.getAttribute('aria-label')   || '').toLowerCase().trim();
        const tooltip     = (btn.getAttribute('mattooltip')   || '').toLowerCase().trim();
        const dataTooltip = (btn.getAttribute('data-tooltip') || '').toLowerCase().trim();
        const title       = (btn.getAttribute('title')        || '').toLowerCase().trim();
        const testId      = (btn.getAttribute('data-test-id') || btn.getAttribute('data-testid') || '').toLowerCase().trim();
        const className   = (typeof btn.className === 'string' ? btn.className : '').toLowerCase();
        const text        = (btn.innerText || btn.textContent || '').toLowerCase().trim();

        const combined = `${label} ${tooltip} ${dataTooltip} ${title} ${testId} ${className}`;
        if (blacklist.some(bad => combined.includes(bad))) continue;

        const hasArrowIcon = text.includes('arrow_upward') || text.includes('send') ||
                             !!btn.querySelector('mat-icon, svg, [data-icon-name*="send"], [data-icon-name*="arrow"]');

        const isExact = label === 'enviar' || label === 'enviar mensagem' || label === 'enviar prompt' || label === 'enviar consulta' ||
                        label === 'send' || label === 'send message' || label === 'send prompt' ||
                        tooltip === 'enviar' || tooltip === 'enviar mensagem' || tooltip === 'send' || tooltip === 'send message' ||
                        dataTooltip === 'enviar' || dataTooltip === 'send' ||
                        testId === 'send-button' || className.includes('send-button');

        if (isExact || (hasArrowIcon && (label.includes('enviar') || label.includes('send') || label === ''))) {
            return btn;
        }
    }

    for (let i = allClickables.length - 1; i >= 0; i--) {
        const btn = allClickables[i];
        const label     = (btn.getAttribute('aria-label') || '').toLowerCase().trim();
        const tooltip   = (btn.getAttribute('mattooltip') || '').toLowerCase().trim();
        const className = (typeof btn.className === 'string' ? btn.className : '').toLowerCase();
        const text      = (btn.innerText || btn.textContent || '').toLowerCase().trim();

        const combined = `${label} ${tooltip} ${className} ${text}`;
        if (blacklist.some(bad => combined.includes(bad))) continue;

        if (combined.includes('enviar') || combined.includes('send') || text.includes('arrow_upward')) {
            return btn;
        }
    }

    const inputArea = document.querySelector('rich-textarea, .input-area, chat-window, .chat-input-container');
    if (inputArea) {
        const cRect = inputArea.getBoundingClientRect();
        for (let i = allClickables.length - 1; i >= 0; i--) {
            const btn = allClickables[i];
            const bRect = btn.getBoundingClientRect();
            if (bRect.width >= 24 && bRect.height >= 24 &&
                bRect.bottom <= (cRect.bottom + 80) && bRect.top >= (cRect.top - 20) &&
                bRect.right <= (cRect.right + 40) && bRect.left >= (cRect.right - 140)) {
                const label = (btn.getAttribute('aria-label') || '').toLowerCase();
                if (!blacklist.some(bad => label.includes(bad))) {
                    return btn;
                }
            }
        }
    }

    return null;
}

function clickSendButton(btn) {
    if (!btn) return false;
    try {
        if (btn.hasAttribute('disabled')) btn.removeAttribute('disabled');
        btn.disabled = false;
        if (btn.getAttribute('aria-disabled') === 'true') btn.setAttribute('aria-disabled', 'false');
        if (typeof btn.focus === 'function') btn.focus();

        const opts = { bubbles: true, cancelable: true, composed: true, view: window };
        btn.dispatchEvent(new PointerEvent('pointerdown', opts));
        btn.dispatchEvent(new MouseEvent('mousedown', opts));
        btn.dispatchEvent(new MouseEvent('mouseup', opts));
        btn.dispatchEvent(new PointerEvent('pointerup', opts));
        btn.click();
        return true;
    } catch (e) {
        return false;
    }
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
    const status = document.getElementById('mt-gemini-assist-status');
    if (status) status.textContent = 'Imagem marcada. A extensão vai usar esse resultado.';
    sendLog('info', 'GEMINI_MANUAL_RESULT', 'Imagem marcada manualmente no Gemini', { source, url: String(url || '').substring(0, 80) });
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
        <div style="color:#aaa;margin-bottom:8px;">Imagem ${Number(job.index) + 1}: marque o resultado correto se a detecção automática não pegar.</div>
        <div style="display:flex;gap:6px;margin-bottom:8px;">
            <button id="mt-gemini-use-last" style="flex:1;background:#FF4444;color:#fff;border:none;border-radius:5px;padding:7px;cursor:pointer;font-weight:700;">Usar última</button>
            <button id="mt-gemini-pick" style="flex:1;background:#2b5f9c;color:#fff;border:none;border-radius:5px;padding:7px;cursor:pointer;font-weight:700;">Selecionar</button>
        </div>
        <div id="mt-gemini-assist-status" style="color:#888;">Aguardando imagem gerada.</div>
    `;
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
    if (!root) return null;
    const editable = root.querySelector ? root.querySelector('.ql-editor, [contenteditable="true"]') : null;
    if (editable) return editable;
    if (root.getAttribute && (root.getAttribute('contenteditable') === 'true' || (typeof root.className === 'string' && root.className.includes('ql-editor')))) {
        return root;
    }
    return (root.querySelector && root.querySelector('p')) || root;
}

async function processGeminiJob() {
    console.log('[MangaTranslator Gemini] processGeminiJob iniciado na aba');
    // 1. Obter Tab ID com tolerância a atrasos de reidratação do Service Worker
    let response = null;
    for (let t = 0; t < 5; t++) {
        response = await new Promise((resolve) => {
            chrome.runtime.sendMessage({ action: 'GET_TAB_ID' }, (resp) => {
                if (chrome.runtime.lastError) resolve(null);
                else resolve(resp);
            });
        });
        if (response && response.tabId) break;
        await sleep(500);
    }

    if (!response || !response.tabId) {
        console.warn('[MangaTranslator Gemini] Falha ao obter tabId após 5 tentativas');
        return;
    }

    const currentPath = window.location.pathname;
    if (currentPath && currentPath.length > 8 && currentPath.startsWith('/app/')) {
        const st = await new Promise(r => chrome.storage.local.get(['deleting_urls'], r));
        const deleting = st.deleting_urls || [];
        const isBeingDeleted = deleting.some(u => {
            try { return new URL(u).pathname === currentPath; } catch { return u.includes(currentPath); }
        });
        if (isBeingDeleted) return;
    }

    let job = null;
    const myTabId = response.tabId;
    const jobKey = `gemini_job_${myTabId}`;
    const isExistingChat = currentPath.startsWith('/app/');
    const maxAttempts = 30; 

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
        const data = await new Promise(r => chrome.storage.local.get([jobKey], r));
        if (data[jobKey]) { job = data[jobKey]; break; }

        // Resgate de job órfão APENAS se esta aba for do MangaTranslator
        const isTranslatorTab = window.location.href.includes('mangatranslator');
        if (isTranslatorTab) {
            const all = await new Promise(r => chrome.storage.local.get(null, r));
            const orphanKey = Object.keys(all).find(k => k.startsWith('gemini_job_') && all[k] && !all[k]._claimed);
            if (orphanKey) {
                job = all[orphanKey];
                job._claimed = true;
                console.log('[MangaTranslator Gemini] Job resgatado via orphan fallback:', orphanKey);
                await new Promise(r => chrome.storage.local.set({ [jobKey]: job }, r));
                break;
            }
        }

        await sleep(500);
    }
    
    if (!job) {
        if (!isExistingChat) sendLog('warn', 'JOB_NOT_FOUND', 'Job não encontrado no storage após 15s — script desativado', { path: currentPath });
        closeKeepAlive();
        return;
    }

    // Job confirmado: só a partir daqui vale manter o Service Worker acordado.
    openKeepAlive();
    console.log('[MangaTranslator Gemini] Job confirmado:', { jobId: job.jobId, index: job.index });

    // Sinalizar inject.js para ativar anti-hibernação
    window.dispatchEvent(new CustomEvent('MANGA_TRANSLATOR_ACTIVATE_ANTI_HIBERNATION'));

    const scrollInterval = setInterval(() => {
        window.scrollTo(0, document.body.scrollHeight);
        const images = document.querySelectorAll('img');
        if (images.length > 0) images[images.length - 1].scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, 2000);

    const assert = (condition, errorMessage, step, successMsg = '') => {
        if (!condition) {
            const fullError = `[ERRO CRÍTICO - ETAPA ${step}] ${errorMessage}`;
            console.error(fullError);
            sendLog('error', `TEST_FAIL_STEP_${step}`, errorMessage, { path: window.location.pathname });
            throw new Error(fullError); 
        } else {
            sendLog('success', `TEST_PASS_STEP_${step}`, successMsg || `Etapa ${step} com sucesso`, { path: window.location.pathname });
        }
    };

    try {
        reportProgress(`📡 OBTENDO IMAGEM...`, job.mangaTabId);
        console.log('[MangaTranslator Gemini] Obtendo imagem da aba do mangá...', { index: job.index });
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
        console.log('[MangaTranslator Gemini] Aguardando interface do Gemini...');
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
            console.log('[MangaTranslator Gemini] Ativando conversa temporária...');
            sendLog('info', 'GEMINI_STEP_TEMP_CHAT', 'Ativando conversa temporária no Gemini', {});
            try {
                tempChatResult = await TemporaryChatActivator.ensureTemporaryChatActive(12);
                sendLog('info', 'GEMINI_TEMP_CHAT_STATUS', 'Status da conversa temporária', tempChatResult);
                if (tempChatResult && (tempChatResult.activated || tempChatResult.alreadyActive)) {
                    await sleep(1500);
                }
            } catch (tempErr) {
                console.warn('[MangaTranslator Gemini] Aviso ao ativar conversa temporária:', tempErr);
                sendLog('warn', 'GEMINI_TEMP_CHAT_ERR', `Aviso ao ativar conversa temporária: ${tempErr.message}`, {});
            }
        }

        // Re-obtém o editor mais atualizado do DOM após a transição da conversa temporária
        const liveEditor = document.querySelector('rich-textarea, .ql-editor, [contenteditable="true"]') || editor;
        const liveEditable = getEditableElement(liveEditor) || liveEditor;

        reportProgress(`📎 ANEXANDO IMAGEM...`, job.mangaTabId);
        console.log('[MangaTranslator Gemini] Anexando imagem...');
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
            console.warn('[MangaTranslator Gemini] Thumbnail não detectado após 15s, prosseguindo com envio...');
            sendLog('warn', 'GEMINI_STEP_3_WARN', 'Thumb não detectado explicitamente, prosseguindo com envio', {});
        } else {
            console.log('[MangaTranslator Gemini] Thumbnail confirmado:', thumbResult);
            sendLog('success', 'GEMINI_STEP_3_OK', 'Thumbnail confirmado', { type: thumbResult.type, selector: thumbResult.selector });
        }
        await sleep(1000);

        reportProgress(`📤 ENVIANDO PROMPT...`, job.mangaTabId);
        console.log('[MangaTranslator Gemini] Injetando prompt e enviando...');
        const fallbackPrompt = "Crie uma imagem traduzindo todas as falas desta imagem para o Português. Mantenha o sentido original e apenas altere ou modifique o texto na imagem.";
        let actualPrompt = fallbackPrompt;
        let usedFallback = true;
        
        if (job.prompt && job.prompt.trim().length > 0) {
            actualPrompt = job.prompt;
            usedFallback = false;
        }

        if (usedFallback) sendLog('error', 'PROMPT_FALLBACK', `Prompt falhou ou está vazio. Usando emergência!`, { fallbackPrompt });

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
        sendLog('success', 'PROMPT_INJECTED', 'Prompt confirmado no DOM', { promptLen, preview: activeEditable.textContent.trim().slice(0, 35) });
        await sleep(1000);

        let sendClicked = false;
        const MAX_SEND_ATTEMPTS = 50;
        for (let wait = 0; wait < MAX_SEND_ATTEMPTS; wait++) { 
            window.dispatchEvent(new Event('focus'));
            document.dispatchEvent(new Event('focus'));

            const currentText = (activeEditable ? activeEditable.textContent || '' : '').trim();
            const stopBtn = document.querySelector('button[aria-label*="Interromper"], button[aria-label*="Stop"], button[aria-label*="Parar"], [data-test-id="stop-generating-button"]');

            // Se o texto foi limpo pelo Gemini ou o botão de Stop já surgiu, o envio foi consumido com sucesso!
            if (currentText.length === 0 || stopBtn) {
                sendClicked = true;
                window.__mangaTranslatorJobSent = true;
                console.log('[MangaTranslator Gemini] Envio verificado no DOM (campo limpo ou gerando)!');
                sendLog('success', 'GEMINI_SEND_VERIFIED', 'Envio confirmado no DOM (campo limpo ou gerando)', { wait });
                break;
            }

            const sendBtn = findSendButtonDeep(document.body);
            if (sendBtn) {
                const isDisabled = sendBtn.disabled || sendBtn.getAttribute('aria-disabled') === 'true';
                if (!isDisabled) {
                    clickSendButton(sendBtn);
                    console.log('[MangaTranslator Gemini] Botão de envio acionado. Aguardando confirmação no DOM...');
                    await sleep(1000);
                    const afterText = (activeEditable ? activeEditable.textContent || '' : '').trim();
                    const afterStop = document.querySelector('button[aria-label*="Interromper"], button[aria-label*="Stop"], button[aria-label*="Parar"], [data-test-id="stop-generating-button"]');
                    if (afterText.length === 0 || afterStop) {
                        sendClicked = true;
                        window.__mangaTranslatorJobSent = true;
                        console.log('[MangaTranslator Gemini] Envio confirmado após disparo do botão!');
                        sendLog('success', 'GEMINI_SEND_SUCCESS', 'Botão de envio acionado com sucesso', { wait, label: sendBtn.getAttribute('aria-label') || 'send' });
                        break;
                    }
                }
            }

            // Se o botão permanecer desabilitado após algumas tentativas,
            // solicita ativação temporária (250ms) do background para destravar validação do Angular
            if (wait === 5 || wait === 15 || wait === 25) {
                console.log('[MangaTranslator Gemini] Solicitando FORCE_SEND_ACTIVATION para segundo plano...', { wait });
                chrome.runtime.sendMessage({
                    action: 'FORCE_SEND_ACTIVATION',
                    geminiTabId: myTabId,
                    mangaTabId: job.mangaTabId,
                    windowId: job.windowId,
                    executionMode: job.executionMode
                }, () => { if (chrome.runtime.lastError) {} });
            }

            // Estimula foco e input a cada 4 tentativas sem disparar cliques prematuros
            if (wait > 0 && wait % 4 === 0) {
                try {
                    if (typeof activeEditable.focus === 'function') activeEditable.focus({ preventScroll: true });
                    activeEditable.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
                } catch(e) {}
            }

            await sleep(500);

            // Checagem imediata após sleep
            const afterText = (activeEditable ? activeEditable.textContent || '' : '').trim();
            const afterStop = document.querySelector('button[aria-label*="Interromper"], button[aria-label*="Stop"], button[aria-label*="Parar"], [data-test-id="stop-generating-button"]');
            if (afterText.length === 0 || afterStop) {
                sendClicked = true;
                window.__mangaTranslatorJobSent = true;
                console.log('[MangaTranslator Gemini] Envio confirmado após disparo!');
                sendLog('success', 'GEMINI_SEND_SUCCESS', 'Envio confirmado após disparo', { wait });
                break;
            }
        }

        if (!sendClicked) {
            window.dispatchEvent(new CustomEvent('MANGA_TRANSLATOR_TRIGGER_SEND'));
            sendClicked = true;
            window.__mangaTranslatorJobSent = true;
            console.log('[MangaTranslator Gemini] Envio com fallback TRIGGER_SEND finalizado.');
            sendLog('warn', 'GEMINI_SEND_FALLBACK', 'Envio com fallback TRIGGER_SEND finalizado', {});
        }

        assert(sendClicked, 'Não possível clicar no enviar.', 4, 'Botão de enviar acionado');

            reportProgress(`🧠 GEMINI PROCESSANDO...`, job.mangaTabId);
            const ignoreImages = new Set(Array.from(document.querySelectorAll('img')).map(img => getImageSource(img)).filter(Boolean));
            createGeminiManualPanel(job, () => ignoreImages);
            let resultUrl = null;
            let errorText = null;

            const WAIT_TIMEOUT_MS = 4 * 60 * 1000;
            const waitStart = Date.now();
            let lastReportSec = -1;

            while (!resultUrl) {
                await sleep(1000);
                window.scrollTo(0, 999999);
                
                document.querySelectorAll('infinite-scroller, message-list, main, [role="main"], [class*="conversation"], .chat-history, .zoom-container').forEach(el => {
                    if (el.scrollHeight > el.clientHeight) el.scrollTop = el.scrollHeight;
                });

                const elapsedSec = Math.floor((Date.now() - waitStart) / 1000);
                if (elapsedSec % 5 === 0 && elapsedSec !== lastReportSec) {
                    lastReportSec = elapsedSec;
                    reportProgress(`🧠 GEMINI PROCESSANDO (${elapsedSec}s)...`, job.mangaTabId);
                }

                // Tenta acionar card de imagem caso o Gemini exija clique para exibir/expandir
                if (elapsedSec >= 5 && elapsedSec % 3 === 0) {
                    tryClickModelImageCards();
                }

                if (window.__mangaTranslatorManualGeminiResultUrl) {
                    resultUrl = window.__mangaTranslatorManualGeminiResultUrl;
                    break;
                }

                const newImages = findGeneratedResultImages(ignoreImages);

                if (newImages.length > 0) {
                    const candidate = newImages[newImages.length - 1];
                    const candSrc = getImageSource(candidate) || '';
                    if (candSrc && (candidate.naturalHeight > 0 || candSrc.includes('googleusercontent.com/gg-dl/') || candSrc.startsWith('blob:'))) {
                        resultUrl = candSrc;
                        break;
                    }
                }

                const errorMsg = document.querySelector('.message-error, .error-text');
                if (errorMsg && errorMsg.innerText.trim().length > 0) { errorText = errorMsg.innerText.trim(); break; }
                if (Date.now() - waitStart >= WAIT_TIMEOUT_MS) break;
            }

            if (errorText) {
                sendLog('error', 'GEMINI_ERROR', `UI Error: ${errorText}`, {});
                assert(!errorText, `Retornou erro interface: ${errorText}`, 5);
            }
            
            const shouldDeleteConversation = executionMode === 'minimized_window'
                || (executionMode === 'temp_chat' && tempChatResult.notFound && !tempChatResult.alreadyActive);

            if (!resultUrl) {
                sendLog('error', 'GEMINI_TIMEOUT', `Timeout 4 min estourou`, {});
                if (shouldDeleteConversation) deleteCurrentConversation().catch(() => {});
                chrome.runtime.sendMessage({ action: 'GEMINI_ERROR', mangaTabId: job.mangaTabId, index: job.index, error: 'Tempo limite (4 min)', jobId: job.jobId, batchId: job.batchId });
                return;
            }
            
            assert(resultUrl.startsWith('http') || resultUrl.startsWith('blob') || resultUrl.startsWith('data:image/'), 'URL Imagem inválida', 5, 'Mídia extraída blob');
            sendLog('success', 'GEMINI_IMG_FOUND', 'Imagem gerada!', { url: resultUrl.substring(0, 50) + '...' });
            reportProgress(`📥 EXTRAINDO IMAGEM...`, job.mangaTabId);
            
            // Eleva a resolução da imagem CDN do Google para =s0 (original sem compressão)
            if (resultUrl.includes('googleusercontent.com') && /=s\d+/.test(resultUrl)) {
                resultUrl = resultUrl.replace(/=s\d+[^?#]*/, '=s0');
            }

            try {
                let base64 = null;
                if (resultUrl.startsWith('data:image/')) {
                    base64 = resultUrl;
                } else if (resultUrl.startsWith('blob:')) {
                    const response = await fetch(resultUrl);
                    const blob = await response.blob();
                    base64 = await new Promise((resolve, reject) => {
                        const reader = new FileReader();
                        reader.onloadend = () => resolve(reader.result);
                        reader.onerror = reject;
                        reader.readAsDataURL(blob);
                    });
                } else {
                    base64 = await new Promise((resolve, reject) => {
                        chrome.runtime.sendMessage({ action: 'FETCH_IMAGE_AS_BASE64', url: resultUrl }, (resp) => {
                            if (resp && resp.dataUrl) resolve(resp.dataUrl); else reject(new Error('Falha base64 background'));
                        });
                    });
                }
                if (shouldDeleteConversation) deleteCurrentConversation().catch(() => {});
                chrome.runtime.sendMessage({ action: 'GEMINI_IMAGE_EXTRACTED', mangaTabId: job.mangaTabId, index: job.index, src: base64, jobId: job.jobId, batchId: job.batchId });
            } catch(e) {
                sendLog('warn', 'GEMINI_EXTRACT_ERR', 'Extração direta falhou, fallback bypass.', { err: e.message });
                if (shouldDeleteConversation) deleteCurrentConversation().catch(() => {});
                chrome.runtime.sendMessage({ action: 'GEMINI_RESULT_URL', mangaTabId: job.mangaTabId, index: job.index, url: resultUrl, jobId: job.jobId, batchId: job.batchId });
            }
        } catch (error) {
            chrome.runtime.sendMessage({ action: 'GEMINI_ERROR', mangaTabId: job.mangaTabId, index: job.index, error: error.message, jobId: job.jobId, batchId: job.batchId });
        } finally {
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

let _deletionInProgress = false;

async function deleteCurrentConversation() {
    if (_deletionInProgress) return;
    _deletionInProgress = true;

    try {
        const debugData = await new Promise(r => chrome.storage.local.get(['debugMode'], r));
        if (debugData.debugMode === true) {
            sendLog('info', 'DEBUG_MODE_SKIP', 'Modo debug ativo, pulando deleção da conversa');
            return;
        }

        await sleep(300);

        const currentPath = window.location.pathname;
        let optionsBtn = null;
        let containerEl = null;

        const allLinks = Array.from(document.querySelectorAll('a[href]'));
        const currentLink = allLinks.find(a => {
            const href = a.getAttribute('href') || '';
            if (!href || href === '/' || href === '/app' || href === '/app/') return false;
            return currentPath.endsWith(href) || href.endsWith(currentPath);
        });

        if (currentLink) {
            let parent = currentLink.parentElement;
            for (let i = 0; i < 8 && parent; i++, parent = parent.parentElement) {
                hoverElement(parent);

                const btns = Array.from(parent.querySelectorAll('button')).filter(b => {
                    if (currentLink.contains(b)) return false;
                    if (b.hasAttribute('aria-haspopup')) return true;
                    const meta = [b.getAttribute('aria-label'), b.getAttribute('mattooltip'), b.getAttribute('title'), b.getAttribute('data-test-id')].join(" ").toLowerCase();
                    if (meta.includes('opç') || meta.includes('option') || meta.includes('more') || meta.includes('mais') || meta.includes('menu')) return true;
                    return false;
                });

                if (btns.length > 0) {
                    optionsBtn = btns.find(b => (b.getAttribute('aria-label') || '').toLowerCase().includes('opç')) || btns[btns.length - 1];
                    containerEl = parent;
                    break;
                }
            }
        }

        if (!optionsBtn) {
            const selectors = ['[aria-selected="true"]', '[aria-current="page"]', '[data-active="true"]', '.active'];
            for (const sel of selectors) {
                const selected = document.querySelector(sel);
                if (!selected) continue;
                hoverElement(selected);
                const btns = Array.from(selected.querySelectorAll('button')).filter(b => b.hasAttribute('aria-haspopup') || b.querySelector('svg'));
                if (btns.length > 0) {
                    optionsBtn = btns[btns.length - 1];
                    containerEl = selected;
                    break;
                }
            }
        }

        if (!optionsBtn) {
            const sidebarCandidates = document.querySelectorAll('nav button, aside button, [class*="sidebar"] button, [class*="history"] button, [class*="conversation"] button');
            for (const btn of Array.from(sidebarCandidates).reverse()) {
                const svg = btn.querySelector('svg');
                if (!svg) continue;
                const paths = svg.querySelectorAll('path, circle');
                if (paths.length >= 2 && paths.length <= 5) {
                    hoverElement(btn);
                    optionsBtn = btn;
                    break;
                }
            }
        }

        if (!optionsBtn) {
            sendLog('warn', 'DELETE_NOT_FOUND', 'Botão de opções não encontrado no DOM', { path: currentPath });
            return;
        }

        if (containerEl) {
            hoverElement(containerEl);
        }
        hoverElement(optionsBtn);
        await sleep(50); 
        optionsBtn.scrollIntoView({ block: 'nearest', behavior: 'instant' });
        clickElement(optionsBtn);
        await sleep(120);

        const deleteItem = await waitForDeleteMenuItem();

        if (deleteItem) {
            clickElement(deleteItem);
            await sleep(120);
            const confirmBtn = await waitForConfirmButton(deleteItem);
            
            if (confirmBtn) {
                clickElement(confirmBtn);
                sendLog('success', 'DELETE_OK', 'Conversa excluída!', { path: currentPath });
            } else {
                sendLog('warn', 'DELETE_NO_CONFIRM', 'Botão de confirmação não encontrado', { path: currentPath });
                document.body.click();
            }
        } else {
            sendLog('warn', 'DELETE_NO_ITEM', 'Item excluir não encontrado no menu', { path: currentPath });
            document.body.click();
        }
    } catch (e) {
        sendLog('warn', 'DELETE_ERROR', `Erro na deleção: ${e.message}`, {});
    } finally {
        _deletionInProgress = false;
    }
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'DO_SEND_NOW') {
        const stopBtn = document.querySelector('button[aria-label*="Interromper"], button[aria-label*="Stop"], button[aria-label*="Parar"], [data-test-id="stop-generating-button"]');
        const editor = document.querySelector('rich-textarea [contenteditable="true"], .ql-editor[contenteditable="true"], [contenteditable="true"]');
        const text = (editor ? editor.textContent || '' : '').trim();

        // Se já estiver gerando ou o texto já foi enviado / campo vazio, não re-envia
        if (stopBtn || text.length === 0) {
            sendResponse({ ok: true, alreadySent: true });
            return false;
        }

        const sendBtn = findSendButtonDeep(document.body);
        if (sendBtn && !sendBtn.disabled && sendBtn.getAttribute('aria-disabled') !== 'true') {
            clickSendButton(sendBtn);
            window.__mangaTranslatorJobSent = true;
        } else {
            window.dispatchEvent(new CustomEvent('MANGA_TRANSLATOR_TRIGGER_SEND'));
        }
        sendResponse({ ok: true });
        return false;
    }

    if (request.action === 'DELETE_CONVERSATION') {
        deleteCurrentConversation().then(() => sendResponse({ ok: true })).catch((e) => sendResponse({ ok: false, error: e.message }));
        return true; 
    }
});
