// content_manga.js — Manga Translator (fingerprint schema visual-v4)

if (!window.__manga_translator_content_injected) {
    window.__manga_translator_content_injected = true;
    const CONTENT_INSTANCE_ID = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    window.__manga_translator_active_instance = CONTENT_INSTANCE_ID;

    function isActiveContentInstance() {
        return window.__manga_translator_active_instance === CONTENT_INSTANCE_ID;
    }

    function sendLog(level, action_name, detail, extra = {}) {
        chrome.runtime.sendMessage({ action: 'LOG_ENTRY', level, source: 'manga', action_name, detail, extra }, () => { if (chrome.runtime.lastError) {} });
    }

    let contentTabId = null;

    function sendAudioLog(level, action_name, detail, extra = {}) {
        chrome.runtime.sendMessage({
            action: 'LOG_ENTRY',
            level,
            source: 'audio',
            action_name,
            detail,
            extra: {
                originTabId: contentTabId,
                originTabRole: 'manga_reader',
                pageHost: window.location.hostname || null,
                ...extra,
            },
        }, () => { if (chrome.runtime.lastError) {} });
    }

    // O sender do content script é a fonte confiável do tabId. Guardamos o
    // valor apenas para telemetria: cada evento de áudio fica atribuível à aba
    // leitora que o emitiu, inclusive quando há várias abas traduzindo.
    chrome.runtime.sendMessage({ action: 'GET_TAB_ID' }, (response) => {
        if (chrome.runtime.lastError) return;
        if (response && Number.isInteger(response.tabId)) contentTabId = response.tabId;
    });

    const domReplaceApi = window.MangaTranslatorDomReplace;
    if (!domReplaceApi) {
        throw new Error('cm-dom-replace.js deve ser carregado antes de content_manga.js');
    }

    const gtcFingerprintApi =
        (typeof window !== 'undefined' && window.MangaTranslatorGtcFingerprint)
        || (typeof self !== 'undefined' && self.MangaTranslatorGtcFingerprint)
        || null;

    function generateContentId(prefix = '') {
        if (gtcFingerprintApi && typeof gtcFingerprintApi.generateId === 'function') {
            return gtcFingerprintApi.generateId(prefix);
        }
        const cryptoRef = typeof globalThis !== 'undefined' ? globalThis.crypto : null;
        if (cryptoRef && typeof cryptoRef.randomUUID === 'function') return prefix + cryptoRef.randomUUID();
        if (cryptoRef && typeof cryptoRef.getRandomValues === 'function') {
            const bytes = cryptoRef.getRandomValues(new Uint8Array(16));
            return `${prefix}${Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')}`;
        }
        return `${prefix}${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 14)}`;
    }

    function sendRuntimeMessageAsync(message) {
        return new Promise((resolve) => {
            chrome.runtime.sendMessage(message, (response) => {
                if (chrome.runtime.lastError) resolve({ ok: false, error: chrome.runtime.lastError.message });
                else resolve(response || { ok: false });
            });
        });
    }

    const STOP_SIGN_SVG = `<svg style="width:1em;height:1em;vertical-align:middle;margin-right:5px;flex-shrink:0" viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">
      <polygon points="29,4 71,4 96,29 96,71 71,96 29,96 4,71 4,29" fill="#CC1111" stroke="white" stroke-width="7"/>
      <text x="50" y="66" text-anchor="middle" font-family="Arial Black,Impact,sans-serif" font-size="36" font-weight="900" fill="white" letter-spacing="-1">STOP</text>
    </svg>`;

    const BUTTON_MIN_WIDTH = 130;
    const BUTTON_MIN_HEIGHT = 48;
    const BUTTON_MAX_HEIGHT = 96;
    let imageMinDimensions = { minWidth: 300, minHeight: 400 };

    function normalizeImageMinDimensions(data = {}) {
        const normalize = (value, fallback) => {
            const parsed = Number.parseInt(value, 10);
            return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
        };
        return {
            minWidth: normalize(data.imageMinWidth, 300),
            minHeight: normalize(data.imageMinHeight, 400),
        };
    }

    chrome.storage.local.get(['imageMinWidth', 'imageMinHeight'], (data) => {
        imageMinDimensions = normalizeImageMinDimensions(data);
    });
    chrome.storage.onChanged.addListener((changes, areaName) => {
        if (areaName !== 'local' || (!changes.imageMinWidth && !changes.imageMinHeight)) return;
        imageMinDimensions = normalizeImageMinDimensions({
            imageMinWidth: changes.imageMinWidth ? changes.imageMinWidth.newValue : imageMinDimensions.minWidth,
            imageMinHeight: changes.imageMinHeight ? changes.imageMinHeight.newValue : imageMinDimensions.minHeight,
        });
    });

    function clampButtonHeight(btn) {
        if (!btn) return;
        const currentHeight = parseFloat(btn.style.height);
        if (Number.isFinite(currentHeight) && currentHeight > BUTTON_MAX_HEIGHT) {
            btn.style.height = `${BUTTON_MAX_HEIGHT}px`;
        }
    }

    // NOTA [P2 — inventário]: esta função recebe `text` vindo de dados variáveis
    // (progresso do pipeline, e de request.text propagado por mensagens do
    // background/Gemini — ver L1816). Por isso o rótulo é montado via
    // `textContent`/DOM API em vez de concatenar em innerHTML. O SVG do ícone
    // de stop (`STOP_SIGN_SVG`) é markup 100% estático e fixo no código-fonte,
    // sem qualquer interpolação de dado externo, então segue via innerHTML de
    // um nó isolado — não representa risco de injeção.
    function setBtnHTML(btn, text, showStop) {
        if (!btn) return;
        const mainContent = document.getElementById('manga-main-content');
        clampButtonHeight(btn);
        const target = mainContent || btn;

        while (target.firstChild) target.removeChild(target.firstChild);

        const label = document.createElement('span');
        label.style.cssText = 'display:block;min-width:0;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;line-height:1.15';
        label.textContent = text;

        if (!showStop) {
            target.appendChild(label);
            return;
        }

        const wrapper = document.createElement('span');
        wrapper.style.cssText = 'display:flex;align-items:center;justify-content:center;gap:4px;min-width:0;max-width:100%;overflow:hidden;white-space:nowrap';

        const iconHolder = document.createElement('span');
        iconHolder.style.cssText = 'display:inline-flex;flex-shrink:0';
        iconHolder.innerHTML = STOP_SIGN_SVG; // markup estático, sem dados variáveis — ver nota acima
        wrapper.appendChild(iconHolder);
        wrapper.appendChild(label);
        target.appendChild(wrapper);
    }

    let isPageEnabled = false;
    let selectedImagesIndices = new Set();
    let isTranslating = false;
    let _countedJobIndices = new Set();
    let _currentBatchId = null;
    // Um contexto por página é importante: Chromium impõe um limite baixo de
    // AudioContexts simultâneos. Criar um a cada lote fazia o som parar depois
    // de algumas traduções e o catch abaixo escondia a causa.
    let notificationAudioContext = null;

    function getNotificationAudioContext() {
        if (notificationAudioContext && notificationAudioContext.state !== 'closed') {
            return { audioCtx: notificationAudioContext, created: false };
        }
        const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
        if (!AudioContextCtor) return { audioCtx: null, created: false };
        notificationAudioContext = new AudioContextCtor();
        return { audioCtx: notificationAudioContext, created: true };
    }

    function audioErrorExtra(error) {
        return {
            errorName: error && error.name ? error.name : 'Error',
            errorMessage: error && error.message ? String(error.message).slice(0, 160) : '',
        };
    }

    function getLoggedNotificationAudioContext(trigger) {
        const result = getNotificationAudioContext();
        if (result.created) {
            sendAudioLog('info', 'AUDIO_CONTEXT_CREATED', 'Contexto de áudio criado para notificações.', {
                trigger,
                contextState: result.audioCtx.state,
            });
        }
        if (!result.audioCtx) {
            sendAudioLog('error', 'AUDIO_UNAVAILABLE', 'O navegador não disponibilizou AudioContext.', { trigger });
        }
        return result.audioCtx;
    }

    // Deve ser chamado no clique real que inicia o lote, enquanto a ativação do
    // usuário ainda é válida para a política de autoplay do navegador.
    function unlockNotificationAudio() {
        try {
            const audioCtx = getLoggedNotificationAudioContext('reader_button');
            if (!audioCtx) return;
            if (audioCtx.state === 'running') {
                sendAudioLog('success', 'AUDIO_UNLOCKED', 'Áudio já estava liberado pelo gesto do usuário.', { contextState: audioCtx.state });
            } else if (audioCtx.state === 'suspended') {
                Promise.resolve(audioCtx.resume()).then(() => {
                    if (audioCtx.state === 'running') {
                        sendAudioLog('success', 'AUDIO_UNLOCKED', 'Áudio liberado pelo gesto do usuário.', { contextState: audioCtx.state });
                    } else {
                        sendAudioLog('warn', 'AUDIO_UNLOCK_INCOMPLETE', 'A retomada terminou, mas o contexto não ficou em execução.', { contextState: audioCtx.state });
                    }
                }).catch((error) => {
                    sendAudioLog('warn', 'AUDIO_UNLOCK_FAILED', 'O navegador recusou liberar o áudio no gesto do usuário.', audioErrorExtra(error));
                });
            } else {
                sendAudioLog('warn', 'AUDIO_UNLOCK_INCOMPLETE', 'O contexto de áudio não está disponível para reprodução.', { contextState: audioCtx.state });
            }
        } catch (error) {
            sendAudioLog('error', 'AUDIO_UNLOCK_FAILED', 'Falha ao preparar o áudio de notificação.', audioErrorExtra(error));
        }
    }

    function scheduleSuccessSound(audioCtx) {
        try {
            let lastOscillator = null;
            [0, 0.18, 0.36].forEach((t, i) => {
                const osc = audioCtx.createOscillator(), gain = audioCtx.createGain();
                osc.connect(gain); gain.connect(audioCtx.destination);
                osc.type = 'sine'; osc.frequency.setValueAtTime([660, 880, 1100][i], audioCtx.currentTime + t);
                gain.gain.setValueAtTime(0, audioCtx.currentTime + t); gain.gain.linearRampToValueAtTime(0.4, audioCtx.currentTime + t + 0.04); gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + t + 0.28);
                osc.start(audioCtx.currentTime + t); osc.stop(audioCtx.currentTime + t + 0.3);
                lastOscillator = osc;
            });
            if (lastOscillator) {
                lastOscillator.onended = () => {
                    sendAudioLog('success', 'AUDIO_SUCCESS_FINISHED', 'Som de conclusão terminou sem erro.', { contextState: audioCtx.state, notes: 3 });
                };
            }
            sendAudioLog('success', 'AUDIO_SUCCESS_SCHEDULED', 'Som de conclusão agendado com sucesso.', { contextState: audioCtx.state, notes: 3 });
        } catch (error) {
            sendAudioLog('error', 'AUDIO_SUCCESS_FAILED', 'Não foi possível agendar o som de conclusão.', audioErrorExtra(error));
        }
    }

    function playSuccessSound() {
        try {
            const audioCtx = getLoggedNotificationAudioContext('batch_complete');
            if (!audioCtx) return;
            if (audioCtx.state === 'running') {
                scheduleSuccessSound(audioCtx);
            } else if (audioCtx.state === 'suspended') {
                Promise.resolve(audioCtx.resume()).then(() => {
                    if (audioCtx.state === 'running') scheduleSuccessSound(audioCtx);
                    else sendAudioLog('warn', 'AUDIO_SUCCESS_SKIPPED', 'Som não foi agendado: contexto permaneceu suspenso.', { contextState: audioCtx.state });
                }).catch((error) => {
                    sendAudioLog('error', 'AUDIO_SUCCESS_FAILED', 'O navegador recusou retomar o áudio de conclusão.', audioErrorExtra(error));
                });
            } else {
                sendAudioLog('warn', 'AUDIO_SUCCESS_SKIPPED', 'Som não foi agendado: contexto indisponível.', { contextState: audioCtx.state });
            }
        } catch (error) {
            sendAudioLog('error', 'AUDIO_SUCCESS_FAILED', 'Falha inesperada ao preparar o som de conclusão.', audioErrorExtra(error));
        }
    }

    // Mantém os pontos de chamada do pipeline enquanto a implementação DOM
    // permanece isolada em cm-dom-replace.js.
    const getCleanUrl = domReplaceApi.getCleanUrl;

    // ── generateImageFingerprint (visual-v3) ─────────────────────────────────
    //
    // Retorna { sha256, dHash, wHash, pHash, wHashCrop, pHashCrop, regionalHashes }
    //
    // Estratégia de hashes complementares:
    //
    //   SHA-256 de 8×8  (visual-v1/v2, criptográfico):
    //     Canvas 8×8 → 256 bytes RGBA → SHA-256
    //     Igualdade exata. Fallback backward-compat com entradas v1.
    //
    //   dHash de 9×8  (visual-v2, perceptual):
    //     Canvas 9×8 → grayscale → 64 comparações horizontais → 16 hex
    //     LIMITAÇÃO: corrompido pelo texto nos balões em matching cross-language.
    //     Mantido para backward-compat com entradas v2 no IndexedDB.
    //
    //   wHash de 32×32  (visual-v3, Haar Wavelet):
    //     Canvas 32×32 → Haar DWT 2D → LL 16×16 → mediana → 256 bits → 64 hex
    //     O texto (alta frequência) fica na sub-banda HH → descartado.
    //     Arte e layout (baixa frequência) dominam a sub-banda LL.
    //     Threshold cross-language: Hamming ≤ 40/256 (≤ 15.6%)
    //
    //   pHash de 32×32  (visual-v3, DCT):
    //     Canvas 32×32 → DCT-II 2D separável → top-left 16×16 → mediana → 256 bits → 64 hex
    //     DCT concentra texto em altos coeficientes → descartados.
    //     Complemento ao wHash: robustez a variações globais de tonalidade.
    //     Threshold cross-language: Hamming ≤ 35/256 (≤ 13.7%)
    //
    //   regionalHashes de 48×48  (visual-v3, Haar dos 4 cantos):
    //     Canvas 48×48 → 4 regiões de canto (16×16 cada) → wHash 64-bit por canto
    //     Texto raramente aparece nos cantos → hashes de canto mais estáveis.
    //     Confirmação regional: match em ≥ 3/4 cantos (Hamming ≤ 8/64 ≤ 12.5%)
    //     Análogo ao RANSAC em JS puro: usa conhecimento de domínio sobre texto.
    //
    // Fluxo de canvas (falha se cross-origin / CORS):
    //   1. Tenta drawImage no content script (8×8, 9×8, 32×32, 48×48)
    //   2. Se CORS bloqueia: delega ao Service Worker via CALCULATE_VISUAL_FINGERPRINT
    //      (SW usa fetch cross-origin com <all_urls> + OffscreenCanvas)
    //   3. SW retorna { pixelSample, dHash, wHash, pHash, regionalHashes }
    //   4. Se SW também falha: SHA-256 url-based + demais hashes null
    // ─────────────────────────────────────────────────────────────────────────
    async function generateImageFingerprint(imgEl) {
        try {
            const cleanUrl   = getCleanUrl(imgEl.src) || '';
            const imgWidth   = imgEl.naturalWidth  || 0;
            const imgHeight  = imgEl.naturalHeight || 0;
            let pixelSample  = 'nopixels';
            let dHash        = null;
            let wHash        = null;
            let pHash        = null;
            let wHashCrop    = null;
            let pHashCrop    = null;
            let regionalHashes = null;

            // ── Tentativa de canvas (falha se cross-origin / CORS) ────────────
            try {
                // Canvas 8×8 → SHA-256 pixel sample
                const sc8  = document.createElement('canvas');
                sc8.width  = 8; sc8.height = 8;
                const ctx8 = sc8.getContext('2d');
                ctx8.drawImage(imgEl, 0, 0, 8, 8);
                pixelSample = Array.from(ctx8.getImageData(0, 0, 8, 8).data)
                    .map(b => b.toString(16).padStart(2, '0')).join('');

                // Canvas 9×8 → dHash (visual-v2)
                if (gtcFingerprintApi && typeof gtcFingerprintApi.calculateDHash === 'function') {
                    const sc9 = document.createElement('canvas');
                    sc9.width = 9; sc9.height = 8;
                    sc9.getContext('2d').drawImage(imgEl, 0, 0, 9, 8);
                    dHash = gtcFingerprintApi.calculateDHash(
                        sc9.getContext('2d').getImageData(0, 0, 9, 8).data
                    );
                }

                // Canvas 32×32 → wHash + pHash (visual-v3)
                // Um único drawImage 32×32 alimenta ambos os hashes.
                if (gtcFingerprintApi &&
                    (typeof gtcFingerprintApi.calculateWHash === 'function' ||
                     typeof gtcFingerprintApi.calculatePHash === 'function')) {
                    const sc32  = document.createElement('canvas');
                    sc32.width  = 32; sc32.height = 32;
                    sc32.getContext('2d').drawImage(imgEl, 0, 0, 32, 32);
                    const id32 = sc32.getContext('2d').getImageData(0, 0, 32, 32);

                    if (typeof gtcFingerprintApi.calculateWHash === 'function') {
                        wHash = gtcFingerprintApi.calculateWHash(id32.data);
                    }
                    if (typeof gtcFingerprintApi.calculatePHash === 'function') {
                        pHash = gtcFingerprintApi.calculatePHash(id32.data);
                    }
                }

                // Canvas 32×32 sobre center-crop quadrado → fallback visual-v4.
                // Só agrega valor quando a imagem original não é quadrada.
                if (gtcFingerprintApi &&
                    (typeof gtcFingerprintApi.calculateWHash === 'function' ||
                     typeof gtcFingerprintApi.calculatePHash === 'function')) {
                    const W    = imgEl.naturalWidth  || imgEl.width  || 0;
                    const H    = imgEl.naturalHeight || imgEl.height || 0;
                    const side = Math.min(W, H);
                    if (side > 0 && W !== H) {
                        const cropX  = Math.floor((W - side) / 2);
                        const cropY  = Math.floor((H - side) / 2);
                        const scCrop = document.createElement('canvas');
                        scCrop.width = 32; scCrop.height = 32;
                        const ctxCrop = scCrop.getContext('2d');
                        ctxCrop.drawImage(imgEl, cropX, cropY, side, side, 0, 0, 32, 32);
                        const idCrop = ctxCrop.getImageData(0, 0, 32, 32);

                        if (typeof gtcFingerprintApi.calculateWHash === 'function') {
                            wHashCrop = gtcFingerprintApi.calculateWHash(idCrop.data);
                        }
                        if (typeof gtcFingerprintApi.calculatePHash === 'function') {
                            pHashCrop = gtcFingerprintApi.calculatePHash(idCrop.data);
                        }
                    }
                }

                // Canvas 48×48 → regionalHashes dos 4 cantos (visual-v3)
                if (gtcFingerprintApi && typeof gtcFingerprintApi.calculateRegionalHashes === 'function') {
                    const sc48 = document.createElement('canvas');
                    sc48.width = 48; sc48.height = 48;
                    sc48.getContext('2d').drawImage(imgEl, 0, 0, 48, 48);
                    const id48 = sc48.getContext('2d').getImageData(0, 0, 48, 48);
                    regionalHashes = gtcFingerprintApi.calculateRegionalHashes(id48.data);
                }

            } catch (corsErr) {
                // CORS bloqueou o canvas.
                // Delega todos os hashes ao Service Worker (fetch cross-origin).
                if (imgEl.src && !imgEl.src.startsWith('data:') && !imgEl.src.startsWith('blob:')) {
                    try {
                        const fpResp = await sendRuntimeMessageAsync({
                            action: 'CALCULATE_VISUAL_FINGERPRINT',
                            url: imgEl.src,
                        });
                        if (fpResp && fpResp.ok) {
                            if (fpResp.pixelSample)   pixelSample   = fpResp.pixelSample;
                            if (fpResp.dHash)         dHash         = fpResp.dHash;
                            if (fpResp.wHash)         wHash         = fpResp.wHash;
                            if (fpResp.pHash)         pHash         = fpResp.pHash;
                            if (fpResp.wHashCrop)     wHashCrop     = fpResp.wHashCrop;
                            if (fpResp.pHashCrop)     pHashCrop     = fpResp.pHashCrop;
                            if (fpResp.regionalHashes) regionalHashes = fpResp.regionalHashes;
                        }
                    } catch (_e) {
                        // SW também falhou → pixelSample='nopixels', demais null
                    }
                }
            }

            // ── SHA-256 fingerprint ───────────────────────────────────────────
            let sha256 = null;
            if (gtcFingerprintApi && gtcFingerprintApi.createFingerprintFromDescriptor) {
                sha256 = await gtcFingerprintApi.createFingerprintFromDescriptor({
                    width:          imgWidth,
                    height:         imgHeight,
                    cleanUrl,
                    pixelSample,
                    hasVisualPixels: pixelSample !== 'nopixels',
                });
            } else {
                // Fallback inline (gtc-fingerprint.js não carregou)
                const combined = pixelSample !== 'nopixels'
                    ? `${imgWidth}:${imgHeight}:pixels:${pixelSample}`
                    : `${imgWidth}:${imgHeight}:url:${cleanUrl}:nopixels`;
                const hashBuffer = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(combined));
                sha256 = Array.from(new Uint8Array(hashBuffer))
                    .map(b => b.toString(16).padStart(2, '0')).join('');
            }

            // Determina a versão do fingerprint baseado nos hashes disponíveis
            let fingerprintVersion = 'visual-v1';
            if (wHashCrop || pHashCrop) fingerprintVersion = 'visual-v4';
            else if (wHash || pHash) fingerprintVersion = 'visual-v3';
            else if (dHash)      fingerprintVersion = 'visual-v2';

            return { sha256, dHash, wHash, pHash, wHashCrop, pHashCrop, regionalHashes, fingerprintVersion };
        } catch (e) {
            return null;
        }
    }

    // ── queryGlobalTranslationCache (SHA-256, chave primária) ────────────────
    async function queryGlobalTranslationCache(hashes) {
        const normalizedHashes = Array.from(new Set((hashes || []).filter(Boolean)));
        if (normalizedHashes.length === 0) return {};

        const response = await sendRuntimeMessageAsync({
            action: 'GTC_QUERY_MANY',
            hashes: normalizedHashes,
        });

        if (response && response.ok && response.entriesByHash) {
            return response.entriesByHash;
        }

        // Fallback legacy (storage.local, entradas visual-v1)
        const legacyKeys   = normalizedHashes.map(hash => `gtc_${hash}`);
        const legacyResult = await new Promise(resolve => chrome.storage.local.get(legacyKeys, resolve));
        const entriesByHash = {};
        normalizedHashes.forEach(hash => {
            const cached = legacyResult[`gtc_${hash}`];
            if (cached) entriesByHash[hash] = cached;
        });
        return entriesByHash;
    }

    // ── queryGlobalTranslationCacheByDHash (índice by_dhash) ─────────────────
    // Lookup secundário por dHash perceptual (visual-v2).
    // Chamado apenas para misses do SHA-256.
    // Não tem fallback para storage legado (entradas v1 não têm dHash).
    // ─────────────────────────────────────────────────────────────────────────
    async function queryGlobalTranslationCacheByDHash(dHashes) {
        const normalizedDHashes = Array.from(new Set((dHashes || []).filter(Boolean)));
        if (normalizedDHashes.length === 0) return {};

        const response = await sendRuntimeMessageAsync({
            action: 'GTC_QUERY_BY_DHASH',
            dHashes: normalizedDHashes,
        });

        if (response && response.ok && response.entriesByDHash) {
            return response.entriesByDHash;
        }
        return {};
    }

    // ── COMPATIBILIDADE DE API PERCEPTUAL ──────────────────────────────────────
    // As três funções abaixo consultavam o cache por LISTAS independentes de
    // wHash e pHash, o que permitia produto cruzado entre páginas diferentes.
    // O pipeline agora usa queryPerceptualCorrelated(). Elas ficam aqui apenas
    // para não quebrar integrações/testes que ainda as chamem.
    // ── queryGlobalTranslationCacheByPerceptual (wHash + pHash, visual-v3) ────
    //
    // Lookup terciário por wHash + pHash combinados (visual-v3).
    // Chamado apenas para misses do SHA-256 E do dHash.
    //
    // Estratégia de lookup no IndexedDB (implementada no gtc-indexeddb.js):
    //   Fase 1 (rápida, O(log n)): busca hash exato nos índices by_whash e by_phash
    //   Fase 2 (varredura, O(n)):  se fase 1 falhar, cursor com filtro Hamming
    //
    // A fase 2 é o mecanismo de matching cross-language:
    //   EN-scanlation salva wHash_en; PT-scanlation busca wHash_pt ≈ wHash_en
    //   Se Hamming(wHash_en, wHash_pt) ≤ 40 bits → match → cache hit
    //
    // Resultado: { [`${wHash}:${pHash}`]: { translatedDataUrl, confidence, ... } }
    //
    // O campo confidence [0..1] é usado para confirmação regional opcional:
    //   confidence < 0.8 → verifica regionalHashes antes de aplicar
    //   confidence ≥ 0.8 → confiança alta, aplica diretamente
    // ─────────────────────────────────────────────────────────────────────────
    async function queryGlobalTranslationCacheByPerceptual(wHashes, pHashes) {
        const normWHashes = Array.from(new Set((wHashes || []).filter(Boolean)));
        const normPHashes = Array.from(new Set((pHashes  || []).filter(Boolean)));

        if (normWHashes.length === 0 && normPHashes.length === 0) return {};

        const response = await sendRuntimeMessageAsync({
            action:  'GTC_QUERY_BY_PERCEPTUAL',
            wHashes: normWHashes,
            pHashes: normPHashes,
        });

        if (response && response.ok && response.entriesByPerceptual) {
            return response.entriesByPerceptual;
        }
        return {};
    }

    // ── queryPerceptualCorrelated — consultas correlacionadas ─────────────────
    //
    // Substitui as consultas por listas independentes. Cada imagem vira uma
    // query com o SEU par de hashes e as SUAS dimensões; a resposta volta
    // indexada pelo índice da imagem. Isso elimina o produto cruzado que podia
    // casar o wHash de uma página com o pHash de outra.
    //
    // `mode`: 'strict' | 'crop' | 'relaxed'
    async function queryPerceptualCorrelated(candidates, mode = 'strict') {
        const queries = (candidates || [])
            .filter(c => c && (c.wHash || c.pHash))
            .map(c => ({
                queryId: String(c.i),
                wHash:   c.wHash || '',
                pHash:   c.pHash || '',
                width:   c.width  || 0,
                height:  c.height || 0,
            }));

        if (queries.length === 0) return {};

        const response = await sendRuntimeMessageAsync({
            action: 'GTC_QUERY_PERCEPTUAL_V2',
            queries,
            mode,
        });

        if (response && response.ok && response.entriesByQueryId) {
            return response.entriesByQueryId;
        }
        return {};
    }

    async function queryGlobalTranslationCacheByPerceptualCrop(wHashesCrop, pHashesCrop) {
        const normWHashes = Array.from(new Set((wHashesCrop || []).filter(Boolean)));
        const normPHashes = Array.from(new Set((pHashesCrop || []).filter(Boolean)));

        if (normWHashes.length === 0 && normPHashes.length === 0) return {};

        const response = await sendRuntimeMessageAsync({
            action: 'GTC_QUERY_BY_PERCEPTUAL_CROP',
            wHashesCrop: normWHashes,
            pHashesCrop: normPHashes,
        });

        if (response && response.ok && response.entriesByPerceptualCrop) {
            return response.entriesByPerceptualCrop;
        }
        return {};
    }

    async function queryGlobalTranslationCacheByPerceptualRelaxed(wHashes, pHashes) {
        const normWHashes = Array.from(new Set((wHashes || []).filter(Boolean)));
        const normPHashes = Array.from(new Set((pHashes  || []).filter(Boolean)));

        if (normWHashes.length === 0 && normPHashes.length === 0) return {};

        const response = await sendRuntimeMessageAsync({
            action: 'GTC_QUERY_BY_PERCEPTUAL_RELAXED',
            wHashes: normWHashes,
            pHashes: normPHashes,
        });

        if (response && response.ok && response.entriesByPerceptualRelaxed) {
            return response.entriesByPerceptualRelaxed;
        }
        return {};
    }

    // ── saveGlobalTranslationCacheEntry (visual-v3) ───────────────────────────
    // Agora aceita wHash, pHash, regionalHashes e fingerprintVersion.
    // Todos os campos são opcionais — entradas v1/v2 continuam funcionando.
    // ─────────────────────────────────────────────────────────────────────────
    async function saveGlobalTranslationCacheEntry(hash, translatedDataUrl, metadata = {}) {
        if (!hash || !translatedDataUrl) return false;

        const response = await sendRuntimeMessageAsync({
            action:             'GTC_SAVE',
            hash,
            translatedDataUrl,
            dHash:              metadata.dHash              || null,
            wHash:              metadata.wHash              || null,
            pHash:              metadata.pHash              || null,
            wHashCrop:          metadata.wHashCrop          || null,
            pHashCrop:          metadata.pHashCrop          || null,
            regionalHashes:     metadata.regionalHashes     || null,
            cleanUrl:           metadata.cleanUrl           || null,
            width:              metadata.width              || 0,
            height:             metadata.height             || 0,
            fingerprintVersion: metadata.fingerprintVersion || 'visual-v3',
            mimeType:           metadata.mimeType           || null,
        });

        if (response && response.ok) return true;

        // Fallback: storage.local para backward-compat
        await chrome.storage.local.set({ [`gtc_${hash}`]: translatedDataUrl });
        return false;
    }

    // ── Confirmação regional (aproximação do RANSAC em JS puro) ─────────────
    //
    // Usada quando confidence do perceptual match < 0.8.
    // Verifica se ≥ 3/4 cantos da imagem coincidem (Hamming ≤ 8/64 ≤ 12.5%).
    // Se o match não for confirmado, o hit perceptual é descartado.
    //
    // Por que é necessária:
    //   matches com 0.6 ≤ confidence < 0.8 são borderline —
    //   dois mangás diferentes podem ter layouts parecidos (ex: splash pages)
    //   e passar no threshold combinado. Os cantos são mais discriminativos
    //   porque raramente contêm texto e têm arte específica de cada página.
    // ─────────────────────────────────────────────────────────────────────────
    function confirmWithRegionalHashes(queryRegional, entryRegional) {
        // Ausência de dados regionais NÃO é confirmação — retornar false
        // para forçar que matches incertos não sejam aceitos sem evidência.
        if (!queryRegional || !entryRegional) return false;
        if (!gtcFingerprintApi) return false;
        if (typeof gtcFingerprintApi.matchRegionalHashes !== 'function') return true;

        const result = gtcFingerprintApi.matchRegionalHashes(
            queryRegional,
            entryRegional,
            { threshold: 8, minMatches: 3 }
        );
        return result.match;
    }

    // The GTC implementation is injected immediately before this script. Keep
    // these local bindings so the rest of this content script preserves
    // its existing call sites while the cache boundary lives in one module.
    const cmGtcClient = window.MangaTranslatorGtcClient;
    if (!cmGtcClient) {
        throw new Error('MangaTranslatorGtcClient was not loaded before content_manga.js');
    }
    generateImageFingerprint = cmGtcClient.generateImageFingerprint;
    queryGlobalTranslationCache = cmGtcClient.queryGlobalTranslationCache;
    queryGlobalTranslationCacheByDHash = cmGtcClient.queryGlobalTranslationCacheByDHash;
    queryGlobalTranslationCacheByPerceptual = cmGtcClient.queryGlobalTranslationCacheByPerceptual;
    queryPerceptualCorrelated = cmGtcClient.queryPerceptualCorrelated;
    queryGlobalTranslationCacheByPerceptualCrop = cmGtcClient.queryGlobalTranslationCacheByPerceptualCrop;
    queryGlobalTranslationCacheByPerceptualRelaxed = cmGtcClient.queryGlobalTranslationCacheByPerceptualRelaxed;
    saveGlobalTranslationCacheEntry = cmGtcClient.saveGlobalTranslationCacheEntry;
    confirmWithRegionalHashes = cmGtcClient.confirmWithRegionalHashes;

    if (window.location.hostname.includes('googleusercontent.com') || window.location.hostname.includes('google.com')) {
        chrome.runtime.sendMessage({ action: 'CHECK_IF_EXTRACTION_TAB' }, (response) => {
            if (response && response.isExtractionTab) {
                const MAX_ATTEMPTS = 60; let attempts = 0;
                const extractAndSend = () => {
                    attempts++; if (attempts > MAX_ATTEMPTS) return;
                    const img = document.querySelector('img');
                    if (!img) { setTimeout(extractAndSend, 500); return; }
                    
                    const MAX_EXTRACTION_PASSES = 3;
                    let extractionPass = 0;
                    let imageDelivered = false;
                    const deliverImage = (src) => {
                        if (imageDelivered) return;
                        imageDelivered = true;
                        chrome.runtime.sendMessage({ action: 'IMAGE_READY_FROM_NEW_TAB', mangaTabId: response.mangaTabId, index: response.index, src, geminiTabId: response.geminiTabId, jobId: response.jobId, batchId: response.batchId });
                    };
                    const scheduleRetry = () => {
                        if (imageDelivered) return;
                        if (extractionPass >= MAX_EXTRACTION_PASSES) {
                            sendLog('warn', 'AUXILIARY_EXTRACT_FAILED', 'Aba auxiliar esgotou as tentativas de extração.', { attempts: extractionPass });
                            return;
                        }
                        sendLog('warn', 'AUXILIARY_EXTRACT_RETRY', 'Aba auxiliar repetirá a cadeia canvas e fetch.', { nextAttempt: extractionPass + 1 });
                        setTimeout(sendImage, 700);
                    };
                    const sendImage = () => {
                        if (imageDelivered) return;
                        extractionPass++;
                        try {
                            const canvas = document.createElement('canvas');
                            canvas.width = img.naturalWidth; canvas.height = img.naturalHeight;
                            canvas.getContext('2d').drawImage(img, 0, 0);
                            deliverImage(canvas.toDataURL('image/png'));
                        } catch (e) {
                            chrome.runtime.sendMessage({ action: 'FETCH_IMAGE_AS_BASE64', url: img.src }, (resp) => {
                                if (resp && resp.dataUrl) deliverImage(resp.dataUrl);
                                else scheduleRetry();
                            });
                        }
                    };
                    
                    if (img.complete && img.naturalHeight !== 0) sendImage();
                    else {
                        img.addEventListener('load', sendImage, { once: true });
                        img.addEventListener('error', () => {
                            sendImage();
                        }, { once: true });
                        const pollLoaded = setInterval(() => { if (img.naturalHeight > 0) { clearInterval(pollLoaded); sendImage(); } }, 100);
                        setTimeout(() => clearInterval(pollLoaded), 20000);
                    }
                };
                extractAndSend();
                return;
            }
        });
    }

    if (window === window.top && !window.location.hostname.includes('googleusercontent.com') && !window.location.hostname.includes('gemini.google.com')) {
        const hostname = window.location.hostname;
        let processedCount = 0; let totalToProcess = 0; let batchHasErrors = false;
        let _closeInterval = null; let _closeCountdown = 0;
        let _activeRestoreMap = {};   
        let _restoreObserver = null;    
        let _restoreDebounceTimer = null; 
        let _autoRestoreConfig = {
            enabled: true,
            disabledSites: [],
            blockedImages: {},
        };
        let autoRestorer = null;

        function normalizeBlockedImagesStore(value) {
            if (Array.isArray(value)) {
                return value.reduce((acc, cleanUrl) => {
                    if (cleanUrl) acc[cleanUrl] = { cleanUrl };
                    return acc;
                }, {});
            }
            if (value && typeof value === 'object') return value;
            return {};
        }

        function loadAutoRestoreConfig() {
            return new Promise(resolve => {
                chrome.storage.local.get([
                    'autoRestoreEnabled',
                    'autoRestoreDisabledSites',
                    'autoRestoreBlockedImages',
                ], data => {
                    _autoRestoreConfig = {
                        enabled: data.autoRestoreEnabled !== false,
                        disabledSites: Array.isArray(data.autoRestoreDisabledSites) ? data.autoRestoreDisabledSites : [],
                        blockedImages: normalizeBlockedImagesStore(data.autoRestoreBlockedImages),
                    };
                    resolve(_autoRestoreConfig);
                });
            });
        }

        function isAutoRestoreAllowedFor(cleanUrl) {
            if (!_autoRestoreConfig.enabled) return false;
            if (_autoRestoreConfig.disabledSites.includes(hostname)) return false;
            if (cleanUrl && _autoRestoreConfig.blockedImages[cleanUrl]) return false;
            return true;
        }

        function disconnectAutoRestorer() {
            if (_restoreObserver) {
                _restoreObserver.disconnect();
                _restoreObserver = null;
            }
            clearTimeout(_restoreDebounceTimer);
            _restoreDebounceTimer = null;
        }

        function playErrorSound() {
            try {
                const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
                [0, 0.2].forEach((t, i) => {
                    const osc = audioCtx.createOscillator(), gain = audioCtx.createGain();
                    osc.connect(gain); gain.connect(audioCtx.destination);
                    osc.type = 'sawtooth'; osc.frequency.setValueAtTime([300, 150][i], audioCtx.currentTime + t);
                    gain.gain.setValueAtTime(0, audioCtx.currentTime + t);
                    gain.gain.linearRampToValueAtTime(0.4, audioCtx.currentTime + t + 0.04);
                    gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + t + 0.28);
                    osc.start(audioCtx.currentTime + t); osc.stop(audioCtx.currentTime + t + 0.3);
                });
            } catch (e) {}
        }

        function showIntegratedError(errorMsg, imgIndex, isDebug) {
            let btn = document.getElementById('manga-translator-trigger');
            if (!btn) { createTranslatorButton(); btn = document.getElementById('manga-translator-trigger'); if (!btn) return; }
            const collapsibleContent  = document.getElementById('manga-error-collapsible-content');
            const collapsibleContainer = document.getElementById('manga-error-collapsible-container');
            const errorLine = document.getElementById('manga-error-line');
            const icon = errorLine ? errorLine.querySelector('#manga-error-toggle-icon') : null;
            
            if (!collapsibleContent || !collapsibleContainer || !errorLine) return;
            const message = String(errorMsg || '');
            collapsibleContent.replaceChildren();
            if (imgIndex !== null && imgIndex !== undefined) {
                const title = document.createElement('strong');
                title.style.fontSize = '13px';
                title.textContent = `⚠️ ERRO — IMAGEM ${imgIndex}`;
                const detail = document.createElement('span');
                detail.style.cssText = 'font-size:12px;font-weight:normal;line-height:1.4';
                detail.textContent = message;
                collapsibleContent.append(title, document.createElement('br'), detail);
            } else {
                const detail = document.createElement('span');
                detail.style.fontSize = '12px';
                detail.textContent = `✅ ${message}`;
                collapsibleContent.appendChild(detail);
            }
            collapsibleContent.style.padding = '12px 15px';

            if (imgIndex !== null && imgIndex !== undefined) {
                errorLine.style.display = 'flex'; btn.dataset.hasError = 'true'; 
                playErrorSound(); sendLog('error', 'BATCH_ERROR', `UI Error: ${errorMsg}`, { imgIndex });
            }
            btn.style.display = 'flex'; btn.style.opacity = '1';
            const staticPart = document.getElementById('manga-error-static-part');
            
            collapsibleContainer.style.maxHeight = '300px'; collapsibleContainer.style.opacity = '1';
            if (staticPart) staticPart.style.setProperty('border-radius', '0 0 8px 8px', 'important');
            if (icon) icon.innerText = '▼'; btn.dataset.collapsed = 'false';
        }

        chrome.storage.local.get(['enabledDomains'], (data) => {
            if ((data.enabledDomains || []).includes(hostname)) {
                isPageEnabled = true;
                createTranslatorButton();
                initializeAutoRestorer();
            }
        });

        function createTranslatorButton() {
            if (document.getElementById('manga-translator-trigger')) return;
            if (!document.getElementById('manga-error-style')) {
                const style = document.createElement('style'); style.id = 'manga-error-style';
                style.textContent = `@keyframes pulseErrorLine { 0% { background-color: #ff0000; } 50% { background-color: #b30000; } 100% { background-color: #ff0000; } } @keyframes mangaErrorSlideIn { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: translateY(0); } }`;
                document.documentElement.appendChild(style);
            }

            const btn = document.createElement('div');
            btn.id = 'manga-translator-trigger'; btn.dataset.collapsed = 'true'; btn.dataset.hasError = 'false';
            btn.style.cssText = `position: fixed !important; z-index: 2147483647 !important; display: flex !important; flex-direction: column !important; width: 220px !important; min-width: ${BUTTON_MIN_WIDTH}px !important; min-height: ${BUTTON_MIN_HEIGHT}px !important; max-height: ${BUTTON_MAX_HEIGHT}px !important; border-radius: 8px !important; box-shadow: 0 4px 15px rgba(0,0,0,0.5) !important; font-family: sans-serif !important; pointer-events: auto !important; user-select: none !important; overflow: visible !important; box-sizing: border-box !important;`;

            const drawerContainer = document.createElement('div'); drawerContainer.id = 'manga-error-drawer-container';
            drawerContainer.style.cssText = `position: absolute !important; bottom: 100% !important; left: 0 !important; width: 100% !important; display: flex !important; flex-direction: column !important; z-index: 0 !important; border-radius: 8px 8px 0 0 !important; overflow: hidden !important;`;

            const errorLine = document.createElement('div'); errorLine.id = 'manga-error-line';
            errorLine.style.cssText = `display: none !important; background: linear-gradient(135deg, #cc0000, #880000) !important; color: white !important; padding: 6px 12px !important; font-size: 11px !important; font-weight: bold !important; text-align: center !important; cursor: pointer !important; justify-content: space-between !important; align-items: center !important; border-bottom: 1px solid rgba(255,255,255,0.3) !important; flex-shrink: 0 !important; animation: mangaErrorSlideIn 0.25s ease !important; flex-direction: row !important;`;
            errorLine.innerHTML = `<span>🚨 VER ÚLTIMO ERRO</span><span id="manga-error-toggle-icon">▲</span>`;

            const collapsibleContainer = document.createElement('div'); collapsibleContainer.id = 'manga-error-collapsible-container';
            collapsibleContainer.style.cssText = `background: #222 !important; color: #fff !important; font-size: 14px !important; text-align: center !important; transition: max-height 0.3s ease-in-out, opacity 0.3s ease-in-out, padding 0.3s ease-in-out !important; max-height: 0px !important; opacity: 0 !important; overflow: hidden !important;`;
            const collapsibleContent = document.createElement('div'); collapsibleContent.id = 'manga-error-collapsible-content'; collapsibleContent.style.cssText = 'padding: 0px 15px !important;';
            collapsibleContainer.appendChild(collapsibleContent);

            drawerContainer.appendChild(errorLine);
            drawerContainer.appendChild(collapsibleContainer);

            const staticPart = document.createElement('div'); staticPart.id = 'manga-error-static-part';
            staticPart.style.cssText = `display: flex !important; flex-direction: column !important; flex: 1 1 auto !important; width: 100% !important; min-height: 0 !important; border-radius: 8px !important; overflow: hidden !important; background: #FF4444 !important; z-index: 1 !important; position: relative !important;`;

            const mainContent = document.createElement('div'); mainContent.id = 'manga-main-content';
            mainContent.style.cssText = `flex: 1 1 auto !important; display: flex !important; align-items: center !important; justify-content: center !important; padding: 10px 16px !important; font-weight: bold !important; font-size: 14px !important; text-align: center !important; color: white !important; cursor: move !important; box-sizing: border-box !important; line-height: 1.15 !important; word-break: normal !important; overflow-wrap: normal !important; white-space: nowrap !important; min-height: 44px !important; min-width: 0 !important; max-width: 100% !important; overflow: hidden !important; text-overflow: ellipsis !important;`;

            staticPart.appendChild(mainContent); 
            btn.appendChild(drawerContainer); btn.appendChild(staticPart);

            const EDGE = '8px', CORNER = '14px';
            [ { dir:'n', s:`top:-4px;left:${CORNER};right:${CORNER};height:${EDGE};cursor:n-resize;` }, { dir:'s', s:`bottom:-4px;left:${CORNER};right:${CORNER};height:${EDGE};cursor:s-resize;` }, { dir:'e', s:`top:${CORNER};bottom:${CORNER};right:-4px;width:${EDGE};cursor:e-resize;` }, { dir:'w', s:`top:${CORNER};bottom:${CORNER};left:-4px;width:${EDGE};cursor:w-resize;` }, { dir:'ne', s:`top:-4px;right:-4px;width:${CORNER};height:${CORNER};cursor:ne-resize;` }, { dir:'nw', s:`top:-4px;left:-4px;width:${CORNER};height:${CORNER};cursor:nw-resize;` }, { dir:'sw', s:`bottom:-4px;left:-4px;width:${CORNER};height:${CORNER};cursor:sw-resize;` } ].forEach(({ dir, s }) => {
                const h = document.createElement('div'); h.className = 'manga-rsz'; h.dataset.dir = dir; h.style.cssText = `position:absolute !important;z-index:2147483648 !important;${s}`; btn.appendChild(h);
            });

            const seHandle = document.createElement('div'); seHandle.className = 'manga-rsz'; seHandle.dataset.dir = 'se';
            seHandle.style.cssText = `position:absolute !important; z-index:2147483648 !important; bottom:-4px !important; right:-4px !important; width:${CORNER} !important; height:${CORNER} !important; cursor:se-resize !important; display:flex !important; align-items:flex-end !important; justify-content:flex-end !important; padding:2px !important;`;
            seHandle.innerHTML = `<svg style="width:10px;height:10px;pointer-events:none;display:block" viewBox="0 0 10 10" xmlns="http://www.w3.org/2000/svg"><line x1="9" y1="1" x2="1" y2="9" stroke="rgba(255,255,255,0.9)" stroke-width="1.6" stroke-linecap="round"/><line x1="9" y1="4" x2="4" y2="9" stroke="rgba(255,255,255,0.9)" stroke-width="1.6" stroke-linecap="round"/><line x1="9" y1="7" x2="7" y2="9" stroke="rgba(255,255,255,0.9)" stroke-width="1.6" stroke-linecap="round"/></svg>`;
            btn.appendChild(seHandle);

            let isDragging = false, isResizing = false, resizeDir = '';
            let dragStartX = 0, dragStartY = 0, dragInitLeft = 0, dragInitTop = 0; let rszStartX = 0, rszStartY = 0, rszInitRect = null;
            let _savedLeft = 0, _savedTop = 0, _savedWidth = 0, _savedHeight = 0;
            function pinToTopLeft() { const r = btn.getBoundingClientRect(); btn.style.left = r.left + 'px'; btn.style.top = r.top + 'px'; btn.style.right = ''; btn.style.bottom = ''; }

            mainContent.addEventListener('mousedown', (e) => {
                if (e.button !== 0) return; isDragging = true; dragStartX = e.clientX; dragStartY = e.clientY; pinToTopLeft(); dragInitLeft = parseFloat(btn.style.left) || 0; dragInitTop = parseFloat(btn.style.top) || 0; _savedLeft = dragInitLeft; _savedTop = dragInitTop; _savedWidth = btn.offsetWidth; _savedHeight = btn.offsetHeight; e.preventDefault();
            });

            btn.querySelectorAll('.manga-rsz').forEach(h => {
                h.addEventListener('mousedown', (e) => {
                    if (e.button !== 0) return; isResizing = true; resizeDir = h.dataset.dir; rszStartX = e.clientX; rszStartY = e.clientY; pinToTopLeft();
                    rszInitRect = { left: parseFloat(btn.style.left) || 0, top: parseFloat(btn.style.top) || 0, width: btn.offsetWidth, height: btn.offsetHeight };
                    _savedLeft = rszInitRect.left; _savedTop = rszInitRect.top; _savedWidth = rszInitRect.width; _savedHeight = rszInitRect.height;
                    e.preventDefault(); e.stopPropagation();
                });
            });

            document.addEventListener('mousemove', (e) => {
                if (isDragging) { btn.style.left = (dragInitLeft + e.clientX - dragStartX) + 'px'; btn.style.top = (dragInitTop + e.clientY - dragStartY) + 'px'; }
                if (isResizing) {
                    const dx = e.clientX - rszStartX; const dy = e.clientY - rszStartY; const d = resizeDir;
                    let nL = rszInitRect.left, nT = rszInitRect.top, nW = rszInitRect.width, nH = rszInitRect.height;
                    const maxButtonHeight = Math.min(BUTTON_MAX_HEIGHT, Math.max(BUTTON_MIN_HEIGHT, window.innerHeight - 16));
                    if (d.includes('e')) nW = Math.max(BUTTON_MIN_WIDTH, rszInitRect.width + dx); if (d.includes('w')) { nW = Math.max(BUTTON_MIN_WIDTH, rszInitRect.width - dx); nL = rszInitRect.left + rszInitRect.width - nW; }
                    if (d.includes('s')) nH = Math.min(maxButtonHeight, Math.max(BUTTON_MIN_HEIGHT, rszInitRect.height + dy)); if (d.includes('n')) { nH = Math.min(maxButtonHeight, Math.max(BUTTON_MIN_HEIGHT, rszInitRect.height - dy)); nT = rszInitRect.top + rszInitRect.height - nH; }
                    btn.style.left = nL + 'px'; btn.style.top = nT + 'px'; btn.style.width = nW + 'px'; btn.style.height = nH + 'px';
                }
            });

            document.addEventListener('mouseup', () => {
                if (isDragging || isResizing) {
                    isDragging = false; isResizing = false; resizeDir = '';
                    const moved = Math.abs((parseFloat(btn.style.left) || 0) - _savedLeft) > 2 || Math.abs((parseFloat(btn.style.top) || 0) - _savedTop) > 2 || Math.abs(btn.offsetWidth - _savedWidth) > 2 || Math.abs(btn.offsetHeight - _savedHeight) > 2;
                    if (moved) chrome.storage.local.set({ btnPos: { top: btn.style.top || '', left: btn.style.left || '', width: btn.style.width || '', height: btn.style.height || '' } });
                }
            });

            mainContent.addEventListener('click', (e) => {
                if (Math.abs(e.clientX - dragStartX) > 5 || Math.abs(e.clientY - dragStartY) > 5) return; 
                if (isTranslating) { chrome.runtime.sendMessage({ action: 'STOP_BATCH' }); isTranslating = false; updateBtnStatus(); return; }
                unlockNotificationAudio();
                if (selectedImagesIndices.size === 0) {
                    chrome.storage.local.get([`bannedImages_${hostname}`], (data) => {
                        const banned = data[`bannedImages_${hostname}`] || [];
                        const validImages = getScanEligibleImages(banned, imageMinDimensions);
                        validImages.forEach(img => selectedImagesIndices.add(img.index));
                        sendLog('info', 'UI_ACTION', `Botão FLUTUANTE vermelho na página apertado! (${selectedImagesIndices.size} imagens elegíveis)`);
                        extractAndSendImages(Array.from(selectedImagesIndices));
                    });
                } else {
                    sendLog('info', 'UI_ACTION', `Botão FLUTUANTE vermelho na página apertado!`);
                    extractAndSendImages(Array.from(selectedImagesIndices));
                }
            });

            errorLine.addEventListener('click', (e) => {
                e.stopPropagation(); const isCollapsed = btn.dataset.collapsed === 'true';
                const icon = errorLine.querySelector('#manga-error-toggle-icon');
                const textSpan = errorLine.querySelector('span:first-child');
                
                if (isCollapsed) { 
                    collapsibleContainer.style.maxHeight = '300px'; collapsibleContainer.style.opacity = '1'; collapsibleContent.style.padding = '12px 15px'; 
                    if (staticPart) staticPart.style.setProperty('border-radius', '0 0 8px 8px', 'important'); 
                    if (icon) icon.innerText = '▼'; 
                    btn.dataset.collapsed = 'false'; 
                    
                    if (_closeInterval) { clearInterval(_closeInterval); _closeInterval = null; }
                    chrome.storage.local.get(['debugMode'], (data) => {
                        if (textSpan) {
                            textSpan.innerText = data.debugMode ? '🟠 DEBUG MODE ATIVO' : '🚨 VER ÚLTIMO ERRO';
                        }
                    });
                } 
                else { 
                    collapsibleContainer.style.maxHeight = '0px'; collapsibleContainer.style.opacity = '0'; collapsibleContent.style.padding = '0px 15px'; 
                    if (staticPart) staticPart.style.setProperty('border-radius', '0 0 8px 8px', 'important'); 
                    if (icon) icon.innerText = '▲'; 
                    btn.dataset.collapsed = 'true'; 

                    chrome.storage.local.get(['debugMode'], (data) => {
                        if (!data.debugMode && btn.dataset.hasError === 'true') {
                            _closeCountdown = 30;
                            if (textSpan) textSpan.innerText = `FECHANDO EM ${_closeCountdown}S`;
                            if (_closeInterval) clearInterval(_closeInterval);
                            _closeInterval = setInterval(() => {
                                _closeCountdown--;
                                if (_closeCountdown <= 0) {
                                    clearInterval(_closeInterval); _closeInterval = null;
                                    if (btn.dataset.collapsed === 'true') {
                                        errorLine.style.display = 'none'; btn.dataset.hasError = 'false';
                                        if (staticPart) staticPart.style.setProperty('border-radius', '8px', 'important');
                                        if (textSpan) textSpan.innerText = '🚨 VER ÚLTIMO ERRO';
                                    }
                                } else {
                                    if (textSpan) textSpan.innerText = `FECHANDO EM ${_closeCountdown}S`;
                                }
                            }, 1000);
                        } else if (data.debugMode) {
                            if (textSpan) textSpan.innerText = '🟠 DEBUG MODE ATIVO';
                        }
                    });
                }
            });

            if (typeof ResizeObserver !== 'undefined') {
                new ResizeObserver(() => {
                    const H = mainContent.offsetHeight - 20, W = mainContent.offsetWidth - 32;
                    if (H <= 0 || W <= 0) return;
                    const textLen = Math.max(8, Math.min(32, (mainContent.textContent || '').replace(/^STOP\s*/i, '').trim().length || 20));
                    let lo = 11, hi = 16, best = 11;
                    while (lo <= hi) { const mid = (lo + hi) >> 1, charsPerLine = W / (mid * 0.58), lines = Math.max(1, Math.ceil(textLen / charsPerLine)); if (lines * mid * 1.25 <= H) { best = mid; lo = mid + 1; } else hi = mid - 1; }
                    mainContent.style.fontSize = best + 'px';
                }).observe(mainContent);
            }

            chrome.storage.local.get(['btnPos', 'debugMode'], (data) => {
                if (data.btnPos) {
                    btn.style.top = data.btnPos.top;
                    btn.style.left = data.btnPos.left;
                    btn.style.width = data.btnPos.width;
                    const savedHeight = parseFloat(data.btnPos.height);
                    btn.style.height = Number.isFinite(savedHeight)
                        ? `${Math.min(BUTTON_MAX_HEIGHT, Math.max(BUTTON_MIN_HEIGHT, savedHeight))}px`
                        : (data.btnPos.height || '');
                } else { btn.style.bottom = '20px'; btn.style.right = '20px'; }
                document.documentElement.appendChild(btn);
                setBtnHTML(btn, 'TRADUZIR PÁGINAS', false);
                if (data.debugMode === true) applyDebugDrawer(true);
            });
        }

        function applyDebugDrawer(on) {
            const errLine = document.getElementById('manga-error-line'), errContent = document.getElementById('manga-error-collapsible-content'), errCont = document.getElementById('manga-error-collapsible-container'), btn = document.getElementById('manga-translator-trigger'), staticPart = document.getElementById('manga-error-static-part');
            const icon = errLine ? errLine.querySelector('#manga-error-toggle-icon') : null;
            const textSpan = errLine ? errLine.querySelector('span:first-child') : null;
            if (!errLine || !errContent || !errCont) return;
            
            if (on) {
                if (_closeInterval) { clearInterval(_closeInterval); _closeInterval = null; }
                errLine.style.display = 'flex'; 
                errContent.innerHTML = '<span style="font-size:12px">🟠 DEBUG MODE ATIVO — abas não serão fechadas</span>'; 
                errCont.style.maxHeight = '300px'; errCont.style.opacity = '1'; errContent.style.padding = '10px 15px'; 
                if (staticPart) staticPart.style.setProperty('border-radius', '0 0 8px 8px', 'important'); 
                if (icon) icon.innerText = '▼'; 
                if (btn) btn.dataset.collapsed = 'false';
                if (textSpan) textSpan.innerText = '🟠 DEBUG MODE ATIVO';
            } else {
                if (btn && btn.dataset.hasError !== 'true') { 
                    errLine.style.display = 'none'; errCont.style.maxHeight = '0px'; errCont.style.opacity = '0'; errContent.style.padding = '0px 15px';
                    if (staticPart) staticPart.style.setProperty('border-radius', '8px', 'important'); 
                    if (btn) btn.dataset.collapsed = 'true'; 
                    if (icon) icon.innerText = '▲'; 
                    if (textSpan) textSpan.innerText = '🚨 VER ÚLTIMO ERRO';
                } else if (btn && btn.dataset.hasError === 'true') {
                    if (textSpan) textSpan.innerText = '🚨 VER ÚLTIMO ERRO';
                    if (staticPart) staticPart.style.setProperty('border-radius', '0 0 8px 8px', 'important');
                }
            }
        }

        function updateBtnStatus() {
            const btn = document.getElementById('manga-translator-trigger'), staticPart = document.getElementById('manga-error-static-part');
            if (btn && !isTranslating) {
                const count = selectedImagesIndices.size;
                setBtnHTML(btn, count > 0 ? `TRADUZIR ${count} PÁGINA${count > 1 ? 'S' : ''}` : 'TRADUZIR PÁGINAS', false);
                if (staticPart) staticPart.style.background = '#FF4444'; else btn.style.background = '#FF4444';
            }
        }

        const isBackdropOrBlurredImage = domReplaceApi.isBackdropOrBlurredImage;
        const getScanEligibleImages = domReplaceApi.getScanEligibleImages;
        const applyImageReplacement = (img, translatedBase64, fromCache = false) => (
            domReplaceApi.applyImageReplacement(img, translatedBase64, fromCache, { sendLog })
        );

        // ── applyAutoRestore ─────────────────────────────────────────────────
        // O mapa agora guarda { assetId, index }. Primeiro descobrimos QUAIS
        // imagens do DOM casam; só então buscamos o Base64 de cada uma. Uma
        // página de 200 imagens não carrega 200 Base64 para restaurar 3.
        let _autoRestoreRunning = false;

        async function applyAutoRestore() {
            if (!isActiveContentInstance()) { disconnectAutoRestorer(); return; }
            if (isTranslating) return;
            if (!_autoRestoreConfig.enabled || _autoRestoreConfig.disabledSites.includes(hostname)) return;
            if (!_activeRestoreMap || Object.keys(_activeRestoreMap).length === 0) return;
            if (_autoRestoreRunning) return; // evita reentrância durante o await
            _autoRestoreRunning = true;

            try {
                const allImgs = document.querySelectorAll('img:not([data-translated="true"])');
                const pending = [];
                let blockedCount = 0;

                for (const img of allImgs) {
                    const rawUrl = img.getAttribute('src') || img.dataset.src || img.dataset.lazySrc || img.getAttribute('data-original') || '';
                    const cleanUrl = getCleanUrl(rawUrl);
                    if (!cleanUrl || !_activeRestoreMap[cleanUrl]) continue;
                    if (!isAutoRestoreAllowedFor(cleanUrl)) { blockedCount++; continue; }
                    pending.push({ img, cleanUrl });
                }

                let restoredCount = 0;
                for (const { img, cleanUrl } of pending) {
                    if (!isActiveContentInstance() || isTranslating) break;
                    if (img.dataset.translated === 'true') continue; // pode ter mudado durante o await

                    const dataUrl = await resolveRestoreAsset(_activeRestoreMap[cleanUrl]);
                    if (!dataUrl) continue;

                    if (isBackdropOrBlurredImage(img)) {
                        img.src = dataUrl;
                        img.dataset.translated = 'true';
                        img.style.setProperty('z-index', '0', 'important');
                        img.style.setProperty('pointer-events', 'none', 'important');
                    } else {
                        applyImageReplacement(img, dataUrl, true);
                        restoredCount++;
                    }
                }

                if (restoredCount > 0) {
                    sendLog('info', 'AUTO_RESTORE', `Auto-restauração: ${restoredCount} página(s) restauradas silenciosamente`, { restoredCount });
                }
                if (blockedCount > 0) {
                    sendLog('info', 'AUTO_RESTORE_BLOCKED', `Auto-restauração: ${blockedCount} imagem(ns) bloqueadas pelas opções`, { blockedCount });
                }
            } finally {
                _autoRestoreRunning = false;
            }
        }

        // ── initializeAutoRestorer ───────────────────────────────────────────
        // Lê o índice de restauração do IndexedDB (sem blobs). Antes de tudo,
        // dispara a migração idempotente das chaves legadas daquele capítulo —
        // só as daquele capítulo, nunca um get(null) no acervo inteiro.
        function initializeAutoRestorer() {
            if (!isActiveContentInstance() || isTranslating) return;
            loadAutoRestoreConfig()
                .then(() => getOrCreateChapterId())
                .then(async (chapterId) => {
                    if (!isActiveContentInstance() || isTranslating) return;

                    const migration = await sendRuntimeMessageAsync({ action: 'SM_MIGRATE_CHAPTER', chapterId });
                    if (migration && migration.ok && migration.migrated > 0) {
                        sendLog('success', 'SM_MIGRATED', `Capítulo migrado para o novo armazenamento: ${migration.migrated} página(s)`, { chapterId, migrated: migration.migrated });
                    }

                    const resp = await sendRuntimeMessageAsync({ action: 'SM_RESTORE_INDEX', chapterId });
                    const entries = (resp && resp.ok && resp.entries) ? resp.entries : {};

                    if (!isActiveContentInstance() || isTranslating) return;

                    // Merge preserva entradas escritas durante a janela assíncrona
                    _activeRestoreMap = { ...(_activeRestoreMap || {}), ...entries };
                    if (!_activeRestoreMap || Object.keys(_activeRestoreMap).length === 0) return;

                    if (!_autoRestoreConfig.enabled || _autoRestoreConfig.disabledSites.includes(hostname)) {
                        disconnectAutoRestorer();
                        sendLog('info', 'AUTO_RESTORE_DISABLED', 'Auto-restauração desativada pelas opções', {
                            hostname,
                            global: !_autoRestoreConfig.enabled,
                            site: _autoRestoreConfig.disabledSites.includes(hostname),
                        });
                        return;
                    }

                    applyAutoRestore();

                    disconnectAutoRestorer();
                    _restoreObserver = new MutationObserver((mutations) => {
                        let needsCheck = false;
                        for (const m of mutations) {
                            if (m.addedNodes.length > 0) { needsCheck = true; break; }
                            if (m.type === 'attributes' && ['src','data-src','data-lazy'].includes(m.attributeName)) {
                                needsCheck = true; break;
                            }
                        }
                        if (!needsCheck) return;
                        clearTimeout(_restoreDebounceTimer);
                        _restoreDebounceTimer = setTimeout(applyAutoRestore, 150);
                    });
                    _restoreObserver.observe(document.body, {
                        childList: true, subtree: true, attributes: true,
                        attributeFilter: ['src', 'data-src', 'data-lazy']
                    });
                    sendLog('info', 'AUTO_RESTORE_INIT', `Restaurador ativo: ${Object.keys(_activeRestoreMap).length} página(s) no mapa`);
                })
                .catch(() => {});
        }

        const storageChanged = (chrome.storage && chrome.storage.onChanged)
            || (chrome.storage && chrome.storage.local && chrome.storage.local.onChanged)
            || null;
        if (storageChanged && typeof storageChanged.addListener === 'function') {
            storageChanged.addListener((changes, areaName) => {
                if (autoRestorer) {
                    autoRestorer.onStorageChanged(changes, areaName);
                    return;
                }
                if (!isActiveContentInstance()) return;
                if (areaName && areaName !== 'local') return;
                const watched = ['autoRestoreEnabled', 'autoRestoreDisabledSites', 'autoRestoreBlockedImages'];
                if (!watched.some(key => changes[key])) return;
                loadAutoRestoreConfig().then(() => {
                    if (!isActiveContentInstance() || isTranslating) return;
                    if (!_autoRestoreConfig.enabled || _autoRestoreConfig.disabledSites.includes(hostname)) {
                        disconnectAutoRestorer();
                        return;
                    }
                    initializeAutoRestorer();
                }).catch(() => {});
            });
        }

        // ── extractAndSendImages — Pipeline de Cache em 6 Fases ──────────────
        //
        // Fase 1: Gera todos os hashes visuais em paralelo
        //   SHA-256 (8×8), dHash (9×8), wHash (32×32), pHash (32×32), regional (48×48)
        //   Para imagens CORS-blocked: delega ao SW via CALCULATE_VISUAL_FINGERPRINT
        //
        // Fase 2: Lookup SHA-256 em lote (chave primária, O(log n) por hash)
        //   Máxima precisão: igualdade exata, zero falsos positivos
        //
        // Fase 3: Lookup dHash em lote (visual-v2, apenas para misses do SHA-256)
        //   Hash perceptual, backward-compat com entradas v2
        //   Limitação: afetado por texto cross-language (mantido para v2 entries)
        //
        // Fase 4: Lookup wHash+pHash combinado (visual-v3, apenas para misses do dHash)
        //   Haar Wavelet (wHash) + DCT (pHash): matching cross-language
        //   Match se: (wDist ≤ 40 OU pDist ≤ 35) E NOT (wDist > 80 E pDist > 70)
        //   Para confidence < 0.8: confirmação com regionalHashes antes de aplicar
        //
        // Fase 5-B: Lookup wHashCrop+pHashCrop sobre center-crop quadrado
        //
        // Fase 5-C: Lookup wHash+pHash com thresholds relaxados
        //
        // Fase 6: Decisão final por imagem
        //   SHA-256, dHash, perceptual, crop ou relaxed → cache (flash verde)
        //   Todos falharam → fila para o Gemini
        // ─────────────────────────────────────────────────────────────────────
        async function extractAndSendImages(indicesToTranslate) {
            disconnectAutoRestorer();
            isTranslating = true; processedCount = 0; batchHasErrors = false; _countedJobIndices.clear();

            const images = Array.from(document.querySelectorAll('img'));
            const btn = document.getElementById('manga-translator-trigger');
            const staticPart = document.getElementById('manga-error-static-part');
            const indicatesSet = new Set(indicesToTranslate);
            const N = indicesToTranslate.length;

            images.forEach((img, i) => { if (indicatesSet.has(i)) img.dataset.mangaIndex = i; });

            // ─────────────────────────────────────────────────────────────────
            // Helpers de log do cache — formatam e emitem entradas granulares
            // visíveis no painel Logs do popup.
            // ─────────────────────────────────────────────────────────────────

            function _logFaseInicio(fase, descricao, extra = {}) {
                sendLog('info', `GTC_F${fase}_INICIO`, descricao, extra);
            }

            function _logFaseFim(fase, hits, misses, extra = {}) {
                const nivel = hits > 0 ? 'success' : 'info';
                sendLog(nivel, `GTC_F${fase}_FIM`,
                    `Fase ${fase}: ${hits} hit${hits !== 1 ? 's' : ''}, ${misses} miss${misses !== 1 ? 'es' : ''}`,
                    { hits, misses, ...extra });
            }

            function _logImgHit(fase, nomeHash, imgIdx, extra = {}) {
                sendLog('success', `GTC_HIT_F${fase}`,
                    `✅ HIT ${nomeHash} — img ${imgIdx}`, extra);
            }

            function _logImgMiss(fase, nomeHash, imgIdx, extra = {}) {
                sendLog('info', `GTC_MISS_F${fase}`,
                    `❌ MISS ${nomeHash} — img ${imgIdx}`, extra);
            }

            // ── Fase 1: Gera todos os hashes visuais em paralelo ─────────────
            if(btn) {
                setBtnHTML(btn, '🕵️ [1/6] Calculando hashes...', true);
                if (staticPart) staticPart.style.background = '#1565C0'; else btn.style.background = '#1565C0';
            }

            _logFaseInicio(1, `Calculando fingerprints para ${N} imagem${N !== 1 ? 'ns' : ''}`, { total: N });

            const _fase1Inicio = performance.now();
            const fingerprintResults = await Promise.all(
                indicesToTranslate.map(async (i) => {
                    const img = images[i];
                    if (!img || img.dataset.translated === 'true') {
                        sendLog('info', 'GTC_F1_SKIP', `Img ${i} ignorada (já traduzida ou ausente)`, { imgIdx: i });
                        return { i, sha256: null, dHash: null, wHash: null, pHash: null, wHashCrop: null, pHashCrop: null, regionalHashes: null, skip: true };
                    }
                    const fp = await generateImageFingerprint(img);
                    const versao = fp ? fp.fingerprintVersion : 'falha';
                    sendLog('info', 'GTC_F1_HASH', `Img ${i}: fingerprint calculado (${versao})`, {
                        imgIdx:  i,
                        versao,
                        temSha256:   !!(fp && fp.sha256),
                        temDHash:    !!(fp && fp.dHash),
                        temWHash:    !!(fp && fp.wHash),
                        temPHash:    !!(fp && fp.pHash),
                        temCrop:     !!(fp && (fp.wHashCrop || fp.pHashCrop)),
                        temRegional: !!(fp && fp.regionalHashes),
                        sha256Prefix: fp && fp.sha256 ? fp.sha256.slice(0, 10) + '…' : null,
                    });
                    return {
                        i,
                        sha256:         fp ? fp.sha256         : null,
                        dHash:          fp ? fp.dHash          : null,
                        wHash:          fp ? fp.wHash          : null,
                        pHash:          fp ? fp.pHash          : null,
                        wHashCrop:      fp ? fp.wHashCrop      : null,
                        pHashCrop:      fp ? fp.pHashCrop      : null,
                        regionalHashes: fp ? fp.regionalHashes : null,
                        fingerprintVersion: fp ? fp.fingerprintVersion : 'visual-v1',
                    };
                })
            );
            const _fase1Ms = Math.round(performance.now() - _fase1Inicio);
            sendLog('info', 'GTC_F1_FIM', `Fase 1 concluída: ${N} fingerprint${N !== 1 ? 's' : ''} em ${_fase1Ms}ms`, { totalMs: _fase1Ms, total: N });

            // ── Fase 2: Lookup SHA-256 em lote ───────────────────────────────
            if(btn) setBtnHTML(btn, '🕵️ [2/6] SHA-256...', true);

            const sha256Keys = fingerprintResults.filter(r => r.sha256).map(r => r.sha256);
            _logFaseInicio(2, `SHA-256: consultando ${sha256Keys.length} hash${sha256Keys.length !== 1 ? 'es' : ''} no cache`, { total: sha256Keys.length });

            const _fase2Inicio = performance.now();
            const gtcBySha256 = sha256Keys.length > 0
                ? await queryGlobalTranslationCache(sha256Keys)
                : {};
            const _fase2Ms = Math.round(performance.now() - _fase2Inicio);

            let _f2hits = 0, _f2misses = 0;
            for (const r of fingerprintResults) {
                if (r.skip || !r.sha256) continue;
                if (gtcBySha256[r.sha256]) {
                    _f2hits++;
                    _logImgHit(2, 'SHA-256', r.i, {
                        sha256: r.sha256.slice(0, 10) + '…',
                    });
                } else {
                    _f2misses++;
                    _logImgMiss(2, 'SHA-256', r.i, {
                        sha256: r.sha256.slice(0, 10) + '…',
                    });
                }
            }
            _logFaseFim(2, _f2hits, _f2misses, { totalMs: _fase2Ms });

            // ── Fase 3: Lookup dHash em lote (misses do SHA-256) ─────────────
            const sha256Misses = fingerprintResults.filter(r =>
                r.sha256 && !gtcBySha256[r.sha256]
            );
            const sha256MissesWithDHash = sha256Misses.filter(r => r.dHash);
            const dHashKeys = [...new Set(sha256MissesWithDHash.map(r => r.dHash))];

            let gtcByDHash = {};
            if (dHashKeys.length > 0) {
                if(btn) setBtnHTML(btn, '🕵️ [3/6] dHash...', true);
                _logFaseInicio(3, `dHash: consultando ${dHashKeys.length} hash${dHashKeys.length !== 1 ? 'es' : ''} (${sha256Misses.length} misses do SHA-256)`, {
                    totalDHashes: dHashKeys.length,
                    totalMissesSha256: sha256Misses.length,
                });
                const _fase3Inicio = performance.now();
                gtcByDHash = await queryGlobalTranslationCacheByDHash(dHashKeys);
                const _fase3Ms = Math.round(performance.now() - _fase3Inicio);

                let _f3hits = 0, _f3misses = 0;
                for (const r of sha256MissesWithDHash) {
                    if (gtcByDHash[r.dHash]) {
                        _f3hits++;
                        _logImgHit(3, 'dHash', r.i, {
                            dHash: r.dHash,
                        });
                    } else {
                        _f3misses++;
                        _logImgMiss(3, 'dHash', r.i, {
                            dHash: r.dHash,
                        });
                    }
                }
                // Imagens sem dHash: registra como não verificadas nesta fase
                const semDHash = sha256Misses.filter(r => !r.dHash);
                if (semDHash.length > 0) {
                    sendLog('info', 'GTC_F3_SKIP', `${semDHash.length} img${semDHash.length !== 1 ? 's' : ''} sem dHash, puladas nesta fase`, {
                        imgIdxs: semDHash.map(r => r.i),
                    });
                }
                _logFaseFim(3, _f3hits, _f3misses, { totalMs: _fase3Ms });
            } else {
                sendLog('info', 'GTC_F3_SKIP', `Fase 3 (dHash): pulada — ${sha256Misses.length === 0 ? 'sem misses do SHA-256' : 'nenhuma img tem dHash'}`, {
                    missesF2: sha256Misses.length,
                });
            }

            // ── Fase 4: Lookup wHash+pHash combinado (misses do dHash) ───────
            const dHashMisses = sha256Misses.filter(r =>
                !(r.dHash && gtcByDHash[r.dHash])
            );
            // Cada imagem vira uma query com o SEU par de hashes e as SUAS
            // dimensões — nada de listas independentes cruzando entre páginas.
            const buildCandidates = (rows, wField, pField) => rows
                .filter(r => r[wField] || r[pField])
                .map(r => {
                    const el = images[r.i];
                    return {
                        i:      r.i,
                        wHash:  r[wField] || '',
                        pHash:  r[pField] || '',
                        width:  el ? (el.naturalWidth  || 0) : 0,
                        height: el ? (el.naturalHeight || 0) : 0,
                    };
                });

            const perceptualCandidates = buildCandidates(dHashMisses, 'wHash', 'pHash');

            let gtcByPerceptual = {};
            if (perceptualCandidates.length > 0) {
                if(btn) setBtnHTML(btn, '🕵️ [4/6] Perceptual (wHash+pHash)...', true);
                _logFaseInicio(4, `Perceptual: ${perceptualCandidates.length} consulta(s) correlacionada(s) (${dHashMisses.length} misses acumulados)`, {
                    consultas: perceptualCandidates.length,
                    totalMisses: dHashMisses.length,
                    modo: 'cross-language Haar+DCT Hamming (par correlacionado)',
                });
                const _fase4Inicio = performance.now();
                gtcByPerceptual = await queryPerceptualCorrelated(perceptualCandidates, 'strict');
                const _fase4Ms = Math.round(performance.now() - _fase4Inicio);
                const _f4resultados = Object.keys(gtcByPerceptual).length;
                sendLog(_f4resultados > 0 ? 'success' : 'info', 'GTC_F4_RESP',
                    `Fase 4: ${_f4resultados} resultado${_f4resultados !== 1 ? 's' : ''} retornado${_f4resultados !== 1 ? 's' : ''} pelo IDB em ${_fase4Ms}ms`,
                    { resultados: _f4resultados, totalMs: _fase4Ms });

                for (const [queryId, entry] of Object.entries(gtcByPerceptual)) {
                    sendLog('info', 'GTC_F4_ENTRY', `Candidato perceptual para img ${queryId}: confidence=${(entry.confidence || 0).toFixed(3)}, reason=${entry.reason || '?'}`, {
                        imgIdx: Number(queryId),
                        confidence: entry.confidence,
                        reason: entry.reason,
                        wDist: entry.wDist,
                        pDist: entry.pDist,
                    });
                }
            } else {
                sendLog('info', 'GTC_F4_SKIP', `Fase 4 (perceptual): pulada — ${dHashMisses.length === 0 ? 'sem misses' : 'nenhuma img tem wHash/pHash'}`, {
                    missesAcumulados: dHashMisses.length,
                });
            }

            // Resultado indexado pelo índice da imagem, nunca por hash isolado.
            const _hitForImage = (cacheMap, imgIdx) => (cacheMap && cacheMap[String(imgIdx)]) || null;

            // ── Fase 5-B: Lookup wHashCrop+pHashCrop (misses da Fase 4) ──────
            const phase4Misses = dHashMisses.filter(r => !_hitForImage(gtcByPerceptual, r.i));
            const cropCandidates = buildCandidates(phase4Misses, 'wHashCrop', 'pHashCrop');

            let gtcByCrop = {};
            if (cropCandidates.length > 0) {
                if(btn) setBtnHTML(btn, '🕵️ [5/6] Center-crop...', true);
                _logFaseInicio('5B', `Center-crop: ${cropCandidates.length} consulta(s) correlacionada(s) (${phase4Misses.length} misses da Fase 4)`, {
                    consultas: cropCandidates.length,
                    totalMisses: phase4Misses.length,
                });

                const _fase5bInicio = performance.now();
                gtcByCrop = await queryPerceptualCorrelated(cropCandidates, 'crop');
                const _fase5bMs = Math.round(performance.now() - _fase5bInicio);
                const _f5bResultados = Object.keys(gtcByCrop).length;
                sendLog(_f5bResultados > 0 ? 'success' : 'info', 'GTC_F5B_RESP',
                    `Fase 5-B: ${_f5bResultados} resultado${_f5bResultados !== 1 ? 's' : ''} em ${_fase5bMs}ms`,
                    { resultados: _f5bResultados, totalMs: _fase5bMs });
            } else {
                sendLog('info', 'GTC_F5B_SKIP', `Fase 5-B (center-crop): pulada — ${phase4Misses.length === 0 ? 'sem misses' : 'nenhuma img tem crop hash'}`, {
                    missesF4: phase4Misses.length,
                });
            }

            // ── Fase 5-C: Lookup wHash+pHash com thresholds relaxados ─────────
            const phase5bMisses = phase4Misses.filter(r => !_hitForImage(gtcByCrop, r.i));
            const relaxedCandidates = buildCandidates(phase5bMisses, 'wHash', 'pHash');

            let gtcByRelaxed = {};
            if (relaxedCandidates.length > 0) {
                if(btn) setBtnHTML(btn, '🕵️ [5-C/6] Thresholds relaxados...', true);
                _logFaseInicio('5C', `Relaxado: ${relaxedCandidates.length} consulta(s) correlacionada(s) (${phase5bMisses.length} misses após 5-B)`, {
                    consultas: relaxedCandidates.length,
                    totalMisses: phase5bMisses.length,
                    thresholds: { wMatch: 50, pMatch: 45 },
                });

                const _fase5cInicio = performance.now();
                gtcByRelaxed = await queryPerceptualCorrelated(relaxedCandidates, 'relaxed');
                const _fase5cMs = Math.round(performance.now() - _fase5cInicio);
                const _f5cResultados = Object.keys(gtcByRelaxed).length;
                sendLog(_f5cResultados > 0 ? 'success' : 'info', 'GTC_F5C_RESP',
                    `Fase 5-C: ${_f5cResultados} resultado${_f5cResultados !== 1 ? 's' : ''} em ${_fase5cMs}ms`,
                    { resultados: _f5cResultados, totalMs: _fase5cMs });
            } else {
                sendLog('info', 'GTC_F5C_SKIP', `Fase 5-C (relaxado): pulada — ${phase5bMisses.length === 0 ? 'sem misses' : 'nenhuma img tem wHash/pHash'}`, {
                    missesApos5B: phase5bMisses.length,
                });
            }

            // ── Salva todos os hashes no dataset da imagem ───────────────────
            fingerprintResults.forEach(({ i, sha256, dHash, wHash, pHash, wHashCrop, pHashCrop, regionalHashes, fingerprintVersion }) => {
                const img = images[i];
                if (!img) return;
                if (sha256)         img.dataset.origHash            = sha256;
                if (dHash)          img.dataset.origDHash           = dHash;
                if (wHash)          img.dataset.origWHash           = wHash;
                if (pHash)          img.dataset.origPHash           = pHash;
                if (wHashCrop)      img.dataset.origWHashCrop       = wHashCrop;
                if (pHashCrop)      img.dataset.origPHashCrop       = pHashCrop;
                if (regionalHashes) img.dataset.origRegionalHashes  = JSON.stringify(regionalHashes);
                if (fingerprintVersion) img.dataset.origFpVersion   = fingerprintVersion;
            });

            const payloadToGemini = [];
            let instantCacheHits = 0;

            // ── Fase 6: Decisão final por imagem ─────────────────────────────
            // Prioridade: SHA-256 > dHash > perceptual strict > crop > relaxed.
            const _decisoes = { sha256: 0, dHash: 0, perceptual: 0, crop: 0, relaxed: 0, gemini: 0 };
            sendLog('info', 'GTC_F6_INICIO', `Fase 6: decisão final para ${fingerprintResults.filter(r => !r.skip).length} imagem${fingerprintResults.filter(r => !r.skip).length !== 1 ? 'ns' : ''}`, {
                candidatos: fingerprintResults.filter(r => !r.skip).length,
            });

            for (const { i, sha256, dHash, wHash, pHash, wHashCrop, pHashCrop, regionalHashes, skip } of fingerprintResults) {
                if (skip) continue;

                // --- SHA-256 hit ---
                const cachedBySha256 = sha256 ? gtcBySha256[sha256] : null;
                if (cachedBySha256) {
                    const img = images[i];
                    if (img) {
                        applyImageReplacement(img, cachedBySha256, true);
                        instantCacheHits++;
                        _decisoes.sha256++;
                        sendLog('success', 'GTC_HIT', `✅ Cache hit SHA-256 — img ${i}`, {
                            hitType: 'SHA-256',
                            imgIdx:  i,
                            sha256:  sha256 ? sha256.slice(0, 12) + '…' : null,
                        });
                        _persistCacheHit(i, cachedBySha256, img);
                    }
                    continue;
                }

                // --- dHash hit ---
                const cachedByDHash = dHash ? gtcByDHash[dHash] : null;
                if (cachedByDHash) {
                    const img = images[i];
                    if (img) {
                        applyImageReplacement(img, cachedByDHash, true);
                        instantCacheHits++;
                        _decisoes.dHash++;
                        sendLog('success', 'GTC_HIT', `✅ Cache hit dHash — img ${i}`, {
                            hitType: 'dHash',
                            imgIdx:  i,
                            dHash,
                        });
                        _persistCacheHit(i, cachedByDHash, img);
                    }
                    continue;
                }

                // --- wHash+pHash hit (perceptual, visual-v3) ---
                const perceptualHit = _hitForImage(gtcByPerceptual, i);
                const perceptualConfidence = perceptualHit ? (perceptualHit.confidence || 0) : 0;

                if (perceptualHit && perceptualHit.translatedDataUrl) {
                    // Log de pré-confirmação regional (matches borderline)
                    let regionalOk = true;
                    if (perceptualConfidence < 0.8 && regionalHashes) {
                        sendLog('info', 'GTC_F4_REGIONAL', `Img ${i}: confidence borderline (${perceptualConfidence.toFixed(3)}) — verificando cantos regionais`, {
                            imgIdx:     i,
                            confidence: perceptualConfidence,
                            reason:     perceptualHit.reason,
                        });
                        regionalOk = confirmWithRegionalHashes(regionalHashes, perceptualHit.regionalHashes);
                        sendLog(
                            regionalOk ? 'success' : 'warn',
                            'GTC_F4_REGIONAL_RESULT',
                            `Img ${i}: confirmação regional ${regionalOk ? 'PASSOU' : 'FALHOU — descartando hit'}`,
                            { imgIdx: i, regionalOk }
                        );
                    }

                    if (!regionalOk) {
                        _decisoes.gemini++;
                        sendLog('warn', 'GTC_GEMINI', `Match perceptual rejeitado por confirmação regional — img ${i} → Gemini`, {
                            imgIdx: i,
                            confidence: perceptualConfidence,
                            reason: perceptualHit.reason,
                        });
                        payloadToGemini.push({ index: i });
                        continue;
                    }

                    const img = images[i];
                    if (img) {
                        applyImageReplacement(img, perceptualHit.translatedDataUrl, true);
                        instantCacheHits++;
                        _decisoes.perceptual++;
                        sendLog('success', 'GTC_HIT', `✅ Cache hit perceptual (wHash+pHash) — img ${i}`, {
                            hitType:    'wHash+pHash',
                            imgIdx:     i,
                            reason:     perceptualHit.reason || 'perceptual',
                            confidence: perceptualConfidence.toFixed(3),
                            wDist:      perceptualHit.wDist,
                            pDist:      perceptualHit.pDist,
                            crossLanguage: perceptualHit.reason ? perceptualHit.reason.includes('scan') : false,
                            wHash:      wHash ? wHash.slice(0, 12) + '…' : null,
                            pHash:      pHash ? pHash.slice(0, 12) + '…' : null,
                        });
                        _persistCacheHit(i, perceptualHit.translatedDataUrl, img);
                    }
                    continue;
                }

                // --- wHashCrop+pHashCrop hit (center-crop, visual-v4) ---
                const cropHit = _hitForImage(gtcByCrop, i);
                if (cropHit && cropHit.translatedDataUrl) {
                    const cropConfidence = cropHit.confidence || 0;
                    let cropOk = true;
                    if (cropConfidence < 0.8 && regionalHashes) {
                        cropOk = confirmWithRegionalHashes(regionalHashes, cropHit.regionalHashes);
                        sendLog(
                            cropOk ? 'success' : 'warn',
                            'GTC_F5B_REGIONAL_RESULT',
                            `Img ${i}: confirmação regional do center-crop ${cropOk ? 'PASSOU' : 'FALHOU — descartando hit'}`,
                            { imgIdx: i, confidence: cropConfidence, reason: cropHit.reason }
                        );
                    }

                    if (!cropOk) {
                        _decisoes.gemini++;
                        payloadToGemini.push({ index: i });
                        continue;
                    }

                    const img = images[i];
                    if (img) {
                        applyImageReplacement(img, cropHit.translatedDataUrl, true);
                        instantCacheHits++;
                        _decisoes.crop++;
                        sendLog('success', 'GTC_HIT', `✅ Cache hit center-crop — img ${i}`, {
                            hitType: 'wHashCrop+pHashCrop',
                            imgIdx: i,
                            reason: cropHit.reason || 'crop',
                            confidence: cropConfidence.toFixed(3),
                            wDist: cropHit.wDist,
                            pDist: cropHit.pDist,
                        });
                        _persistCacheHit(i, cropHit.translatedDataUrl, img);
                    }
                    continue;
                }

                // --- wHash+pHash hit com thresholds relaxados (visual-v4) ---
                const relaxedHit = _hitForImage(gtcByRelaxed, i);
                if (relaxedHit && relaxedHit.translatedDataUrl) {
                    let relaxedOk = true;
                    if (regionalHashes) {
                        relaxedOk = confirmWithRegionalHashes(regionalHashes, relaxedHit.regionalHashes);
                        sendLog(
                            relaxedOk ? 'success' : 'warn',
                            'GTC_F5C_REGIONAL_RESULT',
                            `Img ${i}: confirmação regional do relaxado ${relaxedOk ? 'PASSOU' : 'FALHOU — descartando hit'}`,
                            { imgIdx: i, confidence: relaxedHit.confidence || 0, reason: relaxedHit.reason }
                        );
                    }

                    if (!relaxedOk) {
                        _decisoes.gemini++;
                        payloadToGemini.push({ index: i });
                        continue;
                    }

                    const img = images[i];
                    if (img) {
                        applyImageReplacement(img, relaxedHit.translatedDataUrl, true);
                        instantCacheHits++;
                        _decisoes.relaxed++;
                        sendLog('success', 'GTC_HIT', `✅ Cache hit threshold relaxado — img ${i}`, {
                            hitType: 'relaxed_wHash+pHash',
                            imgIdx: i,
                            reason: relaxedHit.reason || 'relaxed',
                            confidence: (relaxedHit.confidence || 0).toFixed(3),
                            wDist: relaxedHit.wDist,
                            pDist: relaxedHit.pDist,
                        });
                        _persistCacheHit(i, relaxedHit.translatedDataUrl, img);
                    }
                    continue;
                }

                // --- Nenhum cache hit: enfileira para o Gemini ---
                _decisoes.gemini++;
                sendLog('info', 'GTC_GEMINI', `⚙️ Sem cache — img ${i} → Gemini`, {
                    imgIdx:    i,
                    temWHash:  !!wHash,
                    temPHash:  !!pHash,
                    temDHash:  !!dHash,
                    temSha256: !!sha256,
                });
                payloadToGemini.push({ index: i });
            }

            // ── Resumo final da pipeline de cache ────────────────────────────
            const _totalVerificados = _decisoes.sha256 + _decisoes.dHash + _decisoes.perceptual + _decisoes.crop + _decisoes.relaxed + _decisoes.gemini;
            sendLog(
                instantCacheHits > 0 ? 'success' : 'info',
                'GTC_RESUMO',
                `Cache: ${instantCacheHits}/${_totalVerificados} hits  |  SHA-256: ${_decisoes.sha256}  dHash: ${_decisoes.dHash}  Perceptual: ${_decisoes.perceptual}  Crop: ${_decisoes.crop}  Relaxado: ${_decisoes.relaxed}  Gemini: ${_decisoes.gemini}`,
                {
                    totalVerificados: _totalVerificados,
                    hitsTotal:        instantCacheHits,
                    hitsSha256:       _decisoes.sha256,
                    hitsDHash:        _decisoes.dHash,
                    hitsPerceptual:   _decisoes.perceptual,
                    hitsCrop:         _decisoes.crop,
                    hitsRelaxed:      _decisoes.relaxed,
                    paraGemini:       _decisoes.gemini,
                    taxaCache:        _totalVerificados > 0
                        ? (instantCacheHits / _totalVerificados * 100).toFixed(1) + '%'
                        : '0%',
                }
            );

            totalToProcess = payloadToGemini.length + instantCacheHits;
            for (let k = 0; k < instantCacheHits; k++) processedCount++;
            chrome.storage.local.set({
                mt_popup_state: {
                    status: payloadToGemini.length === 0 ? 'complete' : 'processing',
                    total: totalToProcess,
                    geminiTotal: payloadToGemini.length,
                    cacheHits: instantCacheHits,
                    completed: payloadToGemini.length === 0,
                    updatedAt: Date.now(),
                }
            });

            if (payloadToGemini.length === 0) {
                if (instantCacheHits > 0) {
                    sendLog('success', 'GTC_BATCH_HIT', `Lote completo via cache: ${instantCacheHits} imagem${instantCacheHits !== 1 ? 'ns' : ''} (0 para o Gemini)`, { instantCacheHits });
                    checkIfComplete(true);
                } else {
                    isTranslating = false; updateBtnStatus();
                    const toast = document.createElement('div');
                    toast.textContent = '⚠️ Nenhuma página de mangá detectada ou selecionada.';
                    toast.style.cssText = `position:fixed;top:24px;left:50%;transform:translateX(-50%);background:#b35000;color:#fff;padding:10px 20px;border-radius:8px;font-weight:bold;font-size:13px;font-family:sans-serif;z-index:2147483647;box-shadow:0 4px 16px rgba(0,0,0,0.4);pointer-events:none;opacity:1;transition:opacity 0.4s ease;`;
                    document.body.appendChild(toast);
                    setTimeout(() => { toast.style.opacity = '0'; setTimeout(() => toast.remove(), 420); }, 3000);
                }
                return;
            }

            const geminiCount = payloadToGemini.length;
            if (instantCacheHits > 0) {
                sendLog('info', 'GTC_PARTIAL_HIT', `${instantCacheHits} do cache, ${geminiCount} para o Gemini`, {
                    cache: instantCacheHits, gemini: geminiCount,
                });
            } else {
                sendLog('info', 'BATCH_INITIATED', `Iniciando ${geminiCount} traduções no Gemini (0 cache hits)`, { gemini: geminiCount });
            }

            if(btn) { setBtnHTML(btn, 'INICIANDO...', true); if (staticPart) staticPart.style.background = '#ff9800'; else btn.style.background = '#ff9800'; }

            chrome.storage.local.get(['customPrompt', 'defaultPrompt'], (result) => {
                _currentBatchId = generateContentId();
                chrome.runtime.sendMessage({
                    action: 'START_BATCH',
                    images: payloadToGemini,
                    prompt: result.customPrompt || result.defaultPrompt || "",
                    batchId: _currentBatchId
                }, (resp) => {
                    // Background may return a different batchId if it overrides
                    if (resp && resp.batchId) _currentBatchId = resp.batchId;
                    if(btn) setBtnHTML(btn, `TRADUZINDO (${instantCacheHits}✓ + 0/${geminiCount})...`, true);
                });
            });
        }

        const chapterApi = window.MangaTranslatorChapter;
        if (!chapterApi) throw new Error('cm-chapter.js deve ser carregado antes de content_manga.js');
        const chapterManager = chapterApi.createChapterManager({
            hostname,
            generateId: generateContentId,
            sendRuntimeMessageAsync,
            onRestoreEntry: (cleanUrl, entry) => {
                _activeRestoreMap[cleanUrl] = entry;
                if (autoRestorer) autoRestorer.setEntry(cleanUrl, entry);
            },
        });
        const enqueueChapterWrite = chapterManager.enqueueChapterWrite;
        const storageGetAsync = chapterManager.storageGetAsync;
        const storageSetAsync = chapterManager.storageSetAsync;
        const cacheAsset = chapterManager.cacheAsset;
        const resolveRestoreAsset = chapterManager.resolveRestoreAsset;
        const getOrCreateChapterId = chapterManager.getOrCreateChapterId;
        const persistTranslatedPage = chapterManager.persistTranslatedPage;

        const autoRestoreApi = window.MangaTranslatorAutoRestore;
        if (!autoRestoreApi) throw new Error('cm-auto-restore.js deve ser carregado antes de content_manga.js');
        autoRestorer = autoRestoreApi.createAutoRestorer({
            hostname,
            isActive: isActiveContentInstance,
            isTranslating: () => isTranslating,
            getChapterId: getOrCreateChapterId,
            resolveAsset: resolveRestoreAsset,
            getCleanUrl,
            isBackdropOrBlurredImage,
            applyImageReplacement,
            sendRuntimeMessageAsync,
            sendLog,
        });
        loadAutoRestoreConfig = autoRestorer.loadConfig;
        isAutoRestoreAllowedFor = autoRestorer.isAllowed;
        disconnectAutoRestorer = autoRestorer.disconnect;
        applyAutoRestore = autoRestorer.apply;
        initializeAutoRestorer = autoRestorer.initialize;

        // ── _persistCacheHit ─────────────────────────────────────────────────
        // Cache hits também geram entrada de restore agora (antes só gravavam a
        // página): depois de um F5, uma página vinda do cache volta sozinha.
        function _persistCacheHit(imgIndex, base64, imgEl) {
            const rawUrl = imgEl
                ? (imgEl.getAttribute('src') || imgEl.dataset.src || imgEl.dataset.lazySrc || imgEl.getAttribute('data-original') || '')
                : '';
            const cleanUrl = rawUrl ? getCleanUrl(rawUrl) : null;
            persistTranslatedPage(imgIndex, base64, {
                cleanUrl:  cleanUrl || undefined,
                sourceUrl: rawUrl || undefined,
                width:     imgEl ? (imgEl.naturalWidth  || 0) : 0,
                height:    imgEl ? (imgEl.naturalHeight || 0) : 0,
            }).catch(() => {});
        }

        function checkIfComplete(force = false, jobIndex = null) {
            if (!isTranslating) return;
            if (!force) {
                if (jobIndex !== null && _countedJobIndices.has(jobIndex)) return;
                if (jobIndex !== null) _countedJobIndices.add(jobIndex);
                processedCount++;
            }
            if ((processedCount >= totalToProcess && totalToProcess > 0) || force) {
                isTranslating = false; updateBtnStatus(); 
                _currentBatchId = null;
                playSuccessSound();
                sendLog('success', 'BATCH_COMPLETE', 'Lote de tradução concluído');

                const toast = document.createElement('div');
                toast.innerHTML = `<span style="font-size:20px;">✅</span><span>${batchHasErrors ? 'Concluído com erros — veja a gaveta' : 'Tradução Concluída!'}</span>`;
                toast.style.cssText = `position: fixed; top: 28px; left: 50%; transform: translateX(-50%) scale(1); background: linear-gradient(135deg, ${batchHasErrors ? '#b35000, #8a3a00' : '#23a94b, #1db954'}); color: white; padding: 14px 30px; border-radius: 50px; font-weight: bold; font-size: 15px; font-family: sans-serif; z-index: 2147483647; box-shadow: 0 6px 24px rgba(0,0,0,0.35); display: flex; align-items: center; gap: 10px; transition: opacity 0.4s ease, transform 0.4s ease; opacity: 1; pointer-events: none; border: 1.5px solid rgba(255,255,255,0.25); backdrop-filter: blur(4px);`;
                document.body.appendChild(toast);
                setTimeout(() => { toast.style.opacity = '0'; toast.style.transform = 'translateX(-50%) scale(0.92)'; setTimeout(() => toast.remove(), 400); }, 3000);
                chrome.storage.local.get(['debugMode'], (data) => { if (data.debugMode && !batchHasErrors) showIntegratedError('Nenhum erro encontrado no lote.', null, true); });
                totalToProcess = 0; processedCount = 0; _countedJobIndices.clear();
                if (isPageEnabled) initializeAutoRestorer();
            }
        }

        chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
            if (request.action === 'UPDATE_IMAGE') {
                // O background agora aguarda um ACK em vez de esperar 1,5 s fixos.
                // Só respondemos depois que a imagem foi aplicada E persistida.
                const wantsAck = request.expectAck === true;
                const ack = (payload) => {
                    if (!wantsAck) return;
                    try { sendResponse(payload); } catch (_e) {}
                };

                // Rejeitar resultados de batches antigos/cancelados
                if (request.batchId && _currentBatchId && request.batchId !== _currentBatchId) {
                    sendLog('warn', 'STALE_UPDATE', `UPDATE_IMAGE ignorado de batch antigo`, { received: (request.batchId||'').slice(0,8), current: (_currentBatchId||'').slice(0,8) });
                    ack({ ok: false, reason: 'stale_batch' });
                    return wantsAck;
                }

                const images = document.querySelectorAll('img');
                let foundImage = false;
                let persistPromise = null;

                for (let img of images) {
                    if (img.dataset.mangaIndex == request.index) {
                        const origSourceUrl    = img.getAttribute('src') || img.dataset.src || img.dataset.lazySrc || img.getAttribute('data-original') || '';
                        const origCleanUrl     = getCleanUrl(origSourceUrl);
                        const origHash         = img.dataset.origHash         || null;
                        const origDHash        = img.dataset.origDHash        || null;
                        const origWHash        = img.dataset.origWHash        || null;
                        const origPHash        = img.dataset.origPHash        || null;
                        const origWHashCrop    = img.dataset.origWHashCrop    || null;
                        const origPHashCrop    = img.dataset.origPHashCrop    || null;
                        const origFpVersion    = img.dataset.origFpVersion    || 'visual-v1';
                        let   origRegional     = null;
                        try {
                            if (img.dataset.origRegionalHashes)
                                origRegional = JSON.parse(img.dataset.origRegionalHashes);
                        } catch (_e) {}

                        const newImg = applyImageReplacement(img, request.newSrc, false);
                        if (!newImg) break;
                        foundImage = true;

                        const width  = newImg.naturalWidth  || img.naturalWidth  || 0;
                        const height = newImg.naturalHeight || img.naturalHeight || 0;

                        // O GTC é um cache global independente da persistência
                        // da página/capítulo. Não o deixe atrás de SM_SAVE_PAGE:
                        // uma falha transitória no storage de assets não deve
                        // desperdiçar uma tradução que já foi entregue ao DOM.
                        if (origHash) {
                            saveGlobalTranslationCacheEntry(origHash, request.newSrc, {
                                dHash:              origDHash,
                                wHash:              origWHash,
                                pHash:              origPHash,
                                wHashCrop:          origWHashCrop,
                                pHashCrop:          origPHashCrop,
                                regionalHashes:     origRegional,
                                cleanUrl:           origCleanUrl,
                                width,
                                height,
                                mimeType:           (request.newSrc.match(/^data:([^;]+);/) || [])[1] || null,
                                fingerprintVersion: origFpVersion,
                            }).catch(() => {});
                        }

                        persistPromise = persistTranslatedPage(request.index, request.newSrc, {
                            cleanUrl:  origCleanUrl,
                            sourceUrl: origSourceUrl,
                            width,
                            height,
                        }).then(({ chapterId, chapter }) => {

                            chrome.storage.local.get(['autoDownload'], (settings) => {
                                if (settings.autoDownload !== true) return;
                                chrome.runtime.sendMessage({
                                    action: 'DOWNLOAD_IMAGE',
                                    url: request.newSrc,
                                    filename: `MangaTranslator/${chapter ? chapter.title.replace(/[^a-z0-9]/gi, '_') : 'Manga_Page'}/pagina_${String(request.index).padStart(3, '0')}.png`
                                }, (resp) => {
                                    if (!resp || !resp.filePath) return;
                                    // Também serializado: `_paths` sofria a mesma corrida.
                                    enqueueChapterWrite(chapterId, async () => {
                                        const d = await storageGetAsync([`${chapterId}_paths`]);
                                        const paths = d[`${chapterId}_paths`] || {};
                                        paths[request.index] = resp.filePath;
                                        const toSet2 = { [`${chapterId}_paths`]: paths, mangaTranslatorLastPath: resp.filePath };
                                        if (resp.downloadId) toSet2[`${chapterId}_dlId`] = resp.downloadId;
                                        await storageSetAsync(toSet2);
                                    }).catch(() => {});
                                });
                            });
                        });
                        break;
                    }
                }

                // A imagem pode não estar mais no DOM (usuário navegou, lazy-load
                // trocou o nó). O resultado não pode ser perdido: gravamos mesmo assim.
                if (!foundImage) {
                    sendLog('warn', 'UPDATE_IMAGE_NO_DOM', `Imagem ${request.index} não está no DOM; resultado será apenas persistido`, { index: request.index });
                    persistPromise = persistTranslatedPage(request.index, request.newSrc);
                }

                persistPromise
                    .then(() => {
                        ack({ ok: true, persisted: true, domApplied: foundImage });
                        if (foundImage) checkIfComplete(false, request.index);
                    })
                    .catch((err) => {
                        sendLog('error', 'PERSIST_FAIL', `Falha ao persistir a página ${request.index}: ${err && err.message}`, { index: request.index });
                        ack({ ok: false, reason: 'persist_failed' });
                        if (foundImage) checkIfComplete(false, request.index);
                    });

                return wantsAck;
            } else if (request.action === 'BATCH_COMPLETE') {
                // Rejeitar BATCH_COMPLETE de batch antigo
                if (request.batchId && _currentBatchId && request.batchId !== _currentBatchId) {
                    sendLog('warn', 'STALE_COMPLETE', `BATCH_COMPLETE ignorado de batch antigo`, { received: (request.batchId||'').slice(0,8) });
                    return;
                }
                checkIfComplete(true);
            } else if (request.action === 'SHOW_ERROR_INTEGRATED') {
                if (request.batchId && _currentBatchId && request.batchId !== _currentBatchId) return;
                batchHasErrors = true; showIntegratedError(request.errorMsg, request.imgIndex, request.isDebug); checkIfComplete(false, request.imgIndex);
            } else if (request.action === 'PROGRESS') {
                const btn = document.getElementById('manga-translator-trigger'), staticPart = document.getElementById('manga-error-static-part');
                if (btn) { setBtnHTML(btn, request.text, true); if (staticPart) staticPart.style.background = '#ff9800'; else btn.style.background = '#ff9800'; }
            } else if (request.action === 'DEBUG_MODE_CHANGED') {
                applyDebugDrawer(request.debugOn);
            } else if (request.action === 'GET_PAGE_IMAGES') {
                chrome.storage.local.get([`bannedImages_${hostname}`], (data) => {
                    const banned = data[`bannedImages_${hostname}`] || [];
                    const validImages = getScanEligibleImages(banned, imageMinDimensions);
                    sendResponse({ images: validImages, total: validImages.length });
                });
                return true; 
            } else if (request.action === 'SET_SELECTED_IMAGES') {
                selectedImagesIndices = new Set(request.indices); updateBtnStatus(); sendResponse({ success: true });
            } else if (request.action === 'ENABLE_PAGE') {
                isPageEnabled = true; createTranslatorButton(); initializeAutoRestorer(); sendResponse({ success: true });
            } else if (request.action === 'START_TRANSLATION_FROM_POPUP') {
                if (request.indices && request.indices.length > 0) {
                    selectedImagesIndices = new Set(request.indices);
                    updateBtnStatus();
                    chrome.storage.local.set({
                        mt_popup_state: {
                            status: 'starting',
                            total: request.indices.length,
                            geminiTotal: null,
                            cacheHits: 0,
                            completed: false,
                            updatedAt: Date.now(),
                        }
                    });
                    sendResponse({ ok: true });
                    extractAndSendImages(request.indices);
                } else {
                    sendResponse({ ok: false });
                }
            } else if (request.action === 'HIGHLIGHT_IMAGE') {
                document.querySelectorAll('img').forEach((img, i) => {
                    if (img.dataset.mangaIndex == request.index || i == request.index) {
                        if (request.highlight) { img.style.transition = 'outline 0.25s ease, box-shadow 0.25s ease, border-radius 0.25s ease'; img.style.outline = '4px solid rgba(220, 38, 38, 0.9)'; img.style.boxShadow = '0 0 0 6px rgba(220, 38, 38, 0.25), 0 0 30px rgba(220, 38, 38, 0.5)'; img.style.borderRadius = '3px'; const rect = img.getBoundingClientRect(); window.scrollTo({ top: Math.max(0, window.scrollY + rect.top + rect.height / 2 - window.innerHeight / 2), behavior: 'smooth' }); } 
                        else { img.style.transition = 'outline 0.4s ease, box-shadow 0.4s ease, border-radius 0.4s ease'; img.style.outline = ''; img.style.boxShadow = ''; img.style.borderRadius = ''; setTimeout(() => { img.style.transition = ''; }, 420); }
                    }
                });
                sendResponse({ success: true });
            } else if (request.action === 'REQUEST_IMAGE_DATA') {
                let targetImg = null;
                document.querySelectorAll('img').forEach(img => { if (img.dataset.mangaIndex == request.index) targetImg = img; });
                if (targetImg) {
                    try {
                        const canvas = document.createElement('canvas'); 
                        canvas.width = targetImg.naturalWidth; 
                        canvas.height = targetImg.naturalHeight; 
                        canvas.getContext('2d').drawImage(targetImg, 0, 0);
                        // Preservar formato original quando possível
                        const origSrc = (targetImg.src || '').toLowerCase();
                        let mimeType = 'image/png';
                        let quality = undefined;
                        if (origSrc.includes('.jpg') || origSrc.includes('.jpeg') || origSrc.includes('image/jpeg')) {
                            mimeType = 'image/jpeg'; quality = 0.92;
                        } else if (origSrc.includes('.webp') || origSrc.includes('image/webp')) {
                            mimeType = 'image/webp'; quality = 0.92;
                        }
                        sendResponse({ srcData: canvas.toDataURL(mimeType, quality) }); 
                        return false;
                    } catch (e) {
                        chrome.runtime.sendMessage({ action: 'FETCH_IMAGE_AS_BASE64', url: targetImg.src }, (resp) => { 
                            if (resp && resp.dataUrl) sendResponse({ srcData: resp.dataUrl }); 
                            else sendResponse({ error: 'Failed' }); 
                        }); 
                        return true;
                    }
                } else { sendResponse({ error: 'Image not found' }); return false; }
            }
        });
    }
}

