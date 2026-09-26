// inject.js — Manga Translator v6.0 (Anti-Hibernation, Foco Contínuo & Flush RAF)
(function() {
    if (window.__anti_hibernation_injected) return;
    window.__anti_hibernation_injected = true;

    // 0. Guarda de Isolamento: Executar apenas se for aba de tradução
    const isTranslatorTab = window.location.href.includes('mangatranslator') ||
                            sessionStorage.getItem('mangatranslator_tab') === 'true';
    if (!isTranslatorTab) {
        return;
    }
    try { sessionStorage.setItem('mangatranslator_tab', 'true'); } catch (e) {}

    // 1. Anti-throttling progressivo.
    //
    // O modo padrão é minimal: mantém os shims necessários para o Gemini não
    // congelar em background, mas não simula atividade humana nem dispara foco
    // continuamente. O content script pode elevar temporariamente para
    // balanced/legacy quando o modo de execução ou uma segunda tentativa de
    // submit realmente precisar.
    const ANTI_THROTTLE_MODES = new Set(['minimal', 'balanced', 'legacy']);
    const RAF_CADENCE_MS = {
        minimal: 250,
        balanced: 100,
        legacy: 50,
    };
    const FOCUS_CADENCE_MS = {
        minimal: 0,
        balanced: 5000,
        legacy: 1000,
    };

    let antiThrottleMode = 'minimal';
    try {
        const storedMode = sessionStorage.getItem('mangaTranslatorAntiThrottleMode');
        if (ANTI_THROTTLE_MODES.has(storedMode)) antiThrottleMode = storedMode;
    } catch (_e) {}

    // Visibilidade permanece falsificada enquanto esta aba é um worker válido.
    // Isso evita que frameworks da página parem pipelines internos ao receber
    // visibilitychange/blur, sem gerar mousemove sintético.
    try {
        Object.defineProperty(document, 'visibilityState', {
            get: () => 'visible',
            configurable: true
        });
        Object.defineProperty(document, 'hidden', {
            get: () => false,
            configurable: true
        });
        if (Document.prototype) Document.prototype.hasFocus = () => true;
    } catch(e) {}
    document.hasFocus = () => true;

    const stopProp = e => e.stopImmediatePropagation();
    document.addEventListener('visibilitychange', stopProp, true);
    window.addEventListener('visibilitychange', stopProp, true);
    window.addEventListener('blur', stopProp, true);
    window.addEventListener('pagehide', stopProp, true);

    const dispatchFocusEvents = () => {
        try {
            window.dispatchEvent(new Event('focus'));
            document.dispatchEvent(new Event('focus'));
            document.dispatchEvent(new FocusEvent('focusin', {
                bubbles: true,
                composed: true
            }));
        } catch (_e) {}
    };

    let focusIntervalId = null;
    function refreshFocusEscalation() {
        if (focusIntervalId !== null) {
            clearInterval(focusIntervalId);
            focusIntervalId = null;
        }

        const cadence = FOCUS_CADENCE_MS[antiThrottleMode] || 0;
        if (cadence <= 0) return;

        focusIntervalId = setInterval(dispatchFocusEvents, cadence);
    }

    function setAntiThrottleMode(nextMode) {
        const normalized = ANTI_THROTTLE_MODES.has(nextMode)
            ? nextMode
            : 'minimal';

        antiThrottleMode = normalized;
        try {
            sessionStorage.setItem(
                'mangaTranslatorAntiThrottleMode',
                antiThrottleMode
            );
        } catch (_e) {}

        refreshFocusEscalation();
        dispatchFocusEvents();
        return antiThrottleMode;
    }

    // Pulso inicial único. Não existe mais loop de foco permanente no baseline.
    dispatchFocusEvents();
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', dispatchFocusEvents, {
            once: true
        });
    }
    refreshFocusEscalation();

    window.addEventListener('MANGA_TRANSLATOR_ANTI_THROTTLE_SET_MODE', event => {
        const requestedMode = event.detail && event.detail.mode;
        setAntiThrottleMode(requestedMode);
    });

    window.addEventListener('MANGA_TRANSLATOR_ANTI_THROTTLE_PULSE', () => {
        dispatchFocusEvents();
    });

    window.__mangaTranslatorAntiThrottle = {
        getMode: () => antiThrottleMode,
        setMode: setAntiThrottleMode,
        pulse: dispatchFocusEvents,
    };

    // 2. requestAnimationFrame progressivo.
    // Em vez de acordar a fila a cada 50ms para sempre, o próximo flush usa a
    // cadência do nível atual. Uma escalada passa a valer no tick seguinte.
    let nextRafId = 1;
    const rafCallbacks = new Map();
    const origRaf = typeof window.requestAnimationFrame === 'function'
        ? window.requestAnimationFrame.bind(window)
        : null;
    const origCancelRaf = typeof window.cancelAnimationFrame === 'function'
        ? window.cancelAnimationFrame.bind(window)
        : null;

    window.requestAnimationFrame = function(cb) {
        const id = nextRafId++;
        rafCallbacks.set(id, cb);

        if (origRaf && document.visibilityState === 'visible') {
            try {
                origRaf(now => {
                    if (!rafCallbacks.has(id)) return;
                    rafCallbacks.delete(id);
                    try { cb(now); } catch(_e) {}
                });
            } catch(_e) {}
        }
        return id;
    };

    window.cancelAnimationFrame = function(id) {
        rafCallbacks.delete(id);
        if (origCancelRaf) {
            try { origCancelRaf(id); } catch (_e) {}
        }
    };

    const flushRaf = () => {
        if (rafCallbacks.size === 0) return;
        const entries = Array.from(rafCallbacks.entries());
        rafCallbacks.clear();
        const now = performance.now();
        for (const [, cb] of entries) {
            try { cb(now); } catch(_e) {}
        }
    };

    let rafFlushTimer = null;
    function scheduleRafFlush() {
        const cadence = RAF_CADENCE_MS[antiThrottleMode] || RAF_CADENCE_MS.minimal;
        rafFlushTimer = setTimeout(() => {
            flushRaf();
            scheduleRafFlush();
        }, cadence);
    }
    scheduleRafFlush();

    // 2.1. requestIdleCallback com fallback adaptativo.
    let nextIdleId = 1;
    const idleCallbacks = new Map();
    const origIdle = typeof window.requestIdleCallback === 'function'
        ? window.requestIdleCallback.bind(window)
        : null;
    const origCancelIdle = typeof window.cancelIdleCallback === 'function'
        ? window.cancelIdleCallback.bind(window)
        : null;

    window.requestIdleCallback = function(cb, options) {
        const id = nextIdleId++;
        let executed = false;
        const modeBudget = RAF_CADENCE_MS[antiThrottleMode] || RAF_CADENCE_MS.minimal;
        const requestedTimeout =
            options && typeof options.timeout === 'number'
                ? options.timeout
                : modeBudget;
        const maxWait = Math.min(requestedTimeout, modeBudget);

        const timerId = setTimeout(() => {
            if (executed) return;
            executed = true;
            idleCallbacks.delete(id);
            try {
                cb({
                    didTimeout: true,
                    timeRemaining: () => Math.max(
                        0,
                        modeBudget - (performance.now() % modeBudget)
                    )
                });
            } catch(_e) {}
        }, maxWait);

        idleCallbacks.set(id, timerId);

        if (origIdle && document.visibilityState === 'visible') {
            try {
                origIdle(deadline => {
                    if (executed) return;
                    executed = true;
                    clearTimeout(timerId);
                    idleCallbacks.delete(id);
                    try { cb(deadline); } catch(_e) {}
                }, options);
            } catch(_e) {}
        }
        return id;
    };

    window.cancelIdleCallback = function(id) {
        if (idleCallbacks.has(id)) {
            clearTimeout(idleCallbacks.get(id));
            idleCallbacks.delete(id);
        }
        if (origCancelIdle) {
            try { origCancelIdle(id); } catch (_e) {}
        }
    };

    // 3. Audio silencioso apenas após gesto real do usuário.
    let audioContextAtivo = false;
    const activateAudio = e => {
        if (audioContextAtivo || (e && !e.isTrusted)) return;
        try {
            const ctx = new (window.AudioContext || window.webkitAudioContext)();
            if (ctx.state === 'suspended') ctx.resume();
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();
            gain.gain.value = 0;
            osc.connect(gain);
            gain.connect(ctx.destination);
            osc.start();
            audioContextAtivo = true;
            ['click', 'pointerdown', 'keydown'].forEach(evt =>
                document.removeEventListener(evt, activateAudio, true)
            );
        } catch(_e) {}
    };
    ['click', 'pointerdown', 'keydown'].forEach(evt =>
        document.addEventListener(evt, activateAudio, true)
    );

    // Ghost mousemove removido. Atividade sintética aleatória não é necessária
    // para manter rAF/idle vivos e pode interferir com menus, tooltips e seleção.

    // Helper: busca profunda atravessando Shadow Roots
    function findAllDeep(root, predicate) {
        const list = [];
        function walk(node) {
            if (!node) return;
            if (node.nodeType === Node.ELEMENT_NODE) {
                try { if (predicate(node)) list.push(node); } catch(e) {}
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

    // 5. Ponte entre Isolated World e Main World (Gemini Input / BardChatUi)
    window.addEventListener('MANGA_TRANSLATOR_SET_PROMPT', (e) => {
        try {
            const text = e.detail && e.detail.prompt;
            if (!text) return;
            
            const rta = document.querySelector('rich-textarea');
            const target = (rta && rta.querySelector ? rta.querySelector('[contenteditable="true"], .ql-editor') : null)
                        || document.querySelector('[contenteditable="true"], .ql-editor');
            
            if (!target) return;

            // Previne duplicação do prompt se já estiver preenchido com o texto exato
            if (target.textContent.trim() === text.trim()) return;
            
            // 1. Tenta acessar Quill se disponível
            const q = (target && target.__quill)
                   || (rta && rta.__quill)
                   || (window.Quill && typeof window.Quill.find === 'function' && (window.Quill.find(target) || window.Quill.find(rta)));
                   
            if (q) {
                try {
                    if (typeof q.setText === 'function') q.setText(text, 'user');
                    if (typeof q.update === 'function') q.update('user');
                } catch(e) {}
            } else {
                try {
                    const dt = new DataTransfer();
                    dt.setData('text/plain', text);
                    const safeHtml = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
                    dt.setData('text/html', `<p>${safeHtml}</p>`);
                    target.dispatchEvent(new ClipboardEvent('paste', {
                        bubbles: true, cancelable: true, composed: true, clipboardData: dt
                    }));
                } catch(e) {}
            }
            
            // 2. Garante o elemento de parágrafo no DOM caso vazio
            if ((target.textContent || '').trim().length === 0) {
                const p = document.createElement('p');
                p.textContent = text;
                if (typeof target.replaceChildren === 'function') {
                    target.replaceChildren(p);
                } else {
                    while (target.firstChild) {
                        target.removeChild(target.firstChild);
                    }
                    target.appendChild(p);
                }
            }
            
            if (typeof target.focus === 'function') target.focus({ preventScroll: true });
            
            // 3. Dispara eventos de Input com composed: true
            try {
                target.dispatchEvent(new InputEvent('beforeinput', {
                    bubbles: true, cancelable: true, composed: true, inputType: 'insertText', data: text
                }));
                target.dispatchEvent(new InputEvent('input', {
                    bubbles: true, cancelable: true, composed: true, inputType: 'insertText', data: text
                }));
                target.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
                target.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
            } catch(e) {}
            
            if (rta) {
                try { if ('value' in rta) rta.value = text; } catch(e) {}
                try { rta.dispatchEvent(new Event('input', { bubbles: true, composed: true })); } catch(e) {}
            }
            
            console.log("⚡ [inject.js] Prompt injetado com sucesso no modelo do Gemini!");
        } catch(err) {
            console.warn("❌ [inject.js] Erro ao injetar prompt:", err);
        }
    });

    // A imagem do resultado já está acessível dentro da sessão autenticada do
    // Gemini. Esta ponte permite que o content script a converta sem abrir uma
    // aba auxiliar e sem usar o fetch anônimo do Service Worker.
    window.addEventListener('MANGA_TRANSLATOR_FETCH_IMAGE', async (event) => {
        const detail = event.detail || {};
        if (!detail.requestId || !detail.url) return;
        try {
            const response = await fetch(detail.url, { credentials: 'include', cache: 'no-store' });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const blob = await response.blob();
            if (!blob.type.startsWith('image/')) throw new Error(`Tipo inválido: ${blob.type || 'desconhecido'}`);
            const dataUrl = await new Promise((resolve, reject) => {
                const reader = new FileReader();
                reader.onloadend = () => resolve(reader.result);
                reader.onerror = () => reject(reader.error || new Error('Falha ao ler imagem'));
                reader.readAsDataURL(blob);
            });
            window.dispatchEvent(new CustomEvent('MANGA_TRANSLATOR_FETCH_IMAGE_RESULT', {
                detail: { requestId: detail.requestId, dataUrl }
            }));
        } catch (error) {
            window.dispatchEvent(new CustomEvent('MANGA_TRANSLATOR_FETCH_IMAGE_RESULT', {
                detail: { requestId: detail.requestId, error: error && error.message ? error.message : 'Falha ao buscar imagem' }
            }));
        }
    });

    let _lastTriggerSendTime = 0;
    window.addEventListener('MANGA_TRANSLATOR_TRIGGER_SEND', () => {
        const now = Date.now();
        if (now - _lastTriggerSendTime < 3000) return; // Debounce de 3s para evitar envios duplicados
        _lastTriggerSendTime = now;
        try {
            window.dispatchEvent(new Event('focus'));
            document.dispatchEvent(new Event('focus'));
            
            // 1. Dispara Enter no container e editores
            const rta = document.querySelector('rich-textarea');
            if (rta) {
                try {
                    rta.dispatchEvent(new KeyboardEvent('keydown', {
                        bubbles: true, cancelable: true, composed: true, key: 'Enter', code: 'Enter', keyCode: 13, which: 13
                    }));
                } catch(e) {}
            }
            const targets = findAllDeep(document.body, el => el.getAttribute && (el.getAttribute('contenteditable') === 'true' || (el.className && typeof el.className === 'string' && el.className.includes('ql-editor'))));
            for (const target of targets) {
                try {
                    if (typeof target.focus === 'function') target.focus({ preventScroll: true });
                    target.dispatchEvent(new KeyboardEvent('keydown', {
                        bubbles: true, cancelable: true, composed: true, key: 'Enter', code: 'Enter', keyCode: 13, which: 13
                    }));
                } catch(e) {}
            }
            
            // 2. Busca profunda por botões de envio em Light DOM e Shadow Roots
            const allButtons = findAllDeep(document.body, el => {
                if (!el || el.nodeType !== Node.ELEMENT_NODE) return false;
                const tag = el.tagName.toLowerCase();
                const role = (el.getAttribute('role') || '').toLowerCase();
                return tag === 'button' || role === 'button' || tag.includes('button') || tag === 'mat-icon-button';
            });

            const blacklist = ['feedback', 'report', 'survey', 'bug', 'cancel', 'cancelar', 'close', 'fechar', 'dismiss', 'mic', 'microfone', 'voice', 'audio', 'stop'];

            for (let i = allButtons.length - 1; i >= 0; i--) {
                const btn = allButtons[i];
                const label       = (btn.getAttribute('aria-label')   || '').toLowerCase().trim();
                const tooltip     = (btn.getAttribute('mattooltip')   || '').toLowerCase().trim();
                const dataTooltip = (btn.getAttribute('data-tooltip') || '').toLowerCase().trim();
                const testId      = (btn.getAttribute('data-test-id') || btn.getAttribute('data-testid') || '').toLowerCase().trim();
                const className   = (typeof btn.className === 'string' ? btn.className : '').toLowerCase();
                const text        = (btn.innerText || btn.textContent || '').toLowerCase().trim();

                const combined = `${label} ${tooltip} ${dataTooltip} ${testId} ${className}`;
                if (blacklist.some(b => combined.includes(b))) continue;

                const hasSendIcon = text.includes('arrow_upward') || text.includes('send') ||
                                    !!btn.querySelector('mat-icon, svg, [data-icon-name*="send"], [data-icon-name*="arrow"]');

                const isSend = label === 'enviar' || label === 'enviar mensagem' || label === 'enviar prompt' || label === 'enviar consulta' ||
                               label === 'send' || label === 'send message' || label === 'send prompt' ||
                               tooltip === 'enviar' || tooltip === 'enviar mensagem' || tooltip === 'send' ||
                               dataTooltip === 'enviar' || dataTooltip === 'send' ||
                               testId === 'send-button' || className.includes('send-button') ||
                               (hasSendIcon && (label.includes('enviar') || label.includes('send') || label === ''));

                const enabled = btn.disabled !== true &&
                                !btn.hasAttribute('disabled') &&
                                btn.getAttribute('aria-disabled') !== 'true';

                if (isSend && enabled) {
                    if (typeof btn.focus === 'function') btn.focus();

                    const eventOpts = { bubbles: true, cancelable: true, composed: true, view: window };
                    btn.dispatchEvent(new PointerEvent('pointerdown', eventOpts));
                    btn.dispatchEvent(new MouseEvent('mousedown', eventOpts));
                    btn.dispatchEvent(new MouseEvent('mouseup', eventOpts));
                    btn.dispatchEvent(new PointerEvent('pointerup', eventOpts));
                    btn.click();
                    break;
                }
            }
        } catch(err) {}
    });

    console.log("⚡ Anti-throttling progressivo ativo no Gemini (modo " + antiThrottleMode + ").");
})();

