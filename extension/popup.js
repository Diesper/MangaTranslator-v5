// popup.js — Manga Translator

document.addEventListener('DOMContentLoaded', async () => {

    const styleFix = document.createElement('style');
    styleFix.textContent = `
        html { width: auto; height: auto; }
        body {
            min-width: 400px; min-height: 400px;
            max-width: 800px; max-height: 600px;
            overflow: hidden; margin: 0; padding: 0;
            position: relative;
        }
        #root { width: 100% !important; height: 100% !important; }

        #resizer-r {
            position: absolute; top: 0; right: 0; bottom: 14px; width: 6px;
            cursor: e-resize; z-index: 999999;
        }
        #resizer-b {
            position: absolute; bottom: 0; left: 6px; right: 14px; height: 6px;
            cursor: s-resize; z-index: 999999;
        }
        #resizer-br {
            position: absolute; bottom: 0; right: 0; width: 14px; height: 14px;
            cursor: nwse-resize; z-index: 999999;
            background: linear-gradient(135deg, transparent 50%, #666 50%);
        }
        #resizer-r:hover, #resizer-b:hover { background: rgba(255,255,255,0.05); }

        #banned-tab { flex: 1 1 0; min-height: 0; display: none; flex-direction: column; overflow: hidden; }
        #banned-tab.active { display: flex !important; }
        #banned-site-list { flex: 1 1 0 !important; min-height: 0 !important; overflow-y: auto !important; overflow-x: hidden; padding-right: 4px; display: flex; flex-direction: column; gap: 8px; }
        .site-folder { flex-shrink: 0 !important; }
        .site-folder-body .image-scroll-box {
            flex: 0 0 auto !important; min-height: 120px !important; max-height: 320px !important;
            overflow-y: auto !important; overflow-x: hidden !important;
        }

        .text-btn { padding: 8px 12px !important; margin: -8px 0 !important; border-radius: 4px; transition: background 0.15s; }
        .text-btn:hover { background-color: rgba(255, 255, 255, 0.08); }

        .site-folder-name-container { flex: 1; display: flex; align-items: center; min-width: 0; margin-right: 8px; }
        .site-folder-name { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-size: 13px; font-weight: 700; color: #fff; }
        .folder-edit-btn { background: none; border: none; cursor: pointer; font-size: 13px; margin-left: 6px; padding: 4px; border-radius: 4px; opacity: 0.5; transition: all 0.15s; }
        .folder-edit-btn:hover { opacity: 1; background: rgba(255,255,255,0.1); }
        .folder-name-input {
            flex: 1; background: #222; color: #fff; border: 1px solid #FF4444; border-radius: 3px; 
            padding: 2px 6px; font-size: 13px; font-weight: 700; outline: none; min-width: 0;
        }
    `;
    document.head.appendChild(styleFix);

    chrome.storage.local.get(['popupSize'], (data) => {
        if (data.popupSize) {
            document.body.style.width = data.popupSize.width + 'px';
            document.body.style.height = Math.min(data.popupSize.height, 600) + 'px';
        } else {
            document.body.style.width = '500px';
            document.body.style.height = '600px';
        }
    });

    const resizerR = document.createElement('div'); resizerR.id = 'resizer-r';
    const resizerB = document.createElement('div'); resizerB.id = 'resizer-b';
    const resizerBR = document.createElement('div'); resizerBR.id = 'resizer-br';
    
    document.body.appendChild(resizerR);
    document.body.appendChild(resizerB);
    document.body.appendChild(resizerBR);

    let resizeAxis = null; 
    let startX, startY, startWidth, startHeight;

    const startResize = (axis) => (e) => {
        resizeAxis = axis;
        startX = e.screenX; 
        startY = e.screenY;
        startWidth = document.body.offsetWidth;
        startHeight = document.body.offsetHeight;
        e.preventDefault();
    };

    resizerR.addEventListener('mousedown', startResize('x-right'));
    resizerB.addEventListener('mousedown', startResize('y'));
    resizerBR.addEventListener('mousedown', startResize('both'));

    document.addEventListener('mousemove', (e) => {
        if (!resizeAxis) return;
        
        window.requestAnimationFrame(() => {
            if (resizeAxis === 'x-right' || resizeAxis === 'both') {
                let newWidth = startWidth + (e.screenX - startX);
                newWidth = Math.max(400, Math.min(newWidth, 800));
                document.body.style.width = newWidth + 'px';
            }
            if (resizeAxis === 'y' || resizeAxis === 'both') {
                let newHeight = startHeight + (e.screenY - startY);
                newHeight = Math.max(400, Math.min(newHeight, 600));
                document.body.style.height = newHeight + 'px';
            }
        });
    });

    document.addEventListener('mouseup', () => {
        if (resizeAxis) {
            resizeAxis = null;
            chrome.storage.local.set({
                popupSize: {
                    width: document.body.offsetWidth,
                    height: document.body.offsetHeight
                }
            });
        }
    });

    const enablePage    = document.getElementById('enable-page');
    const loadingPage   = document.getElementById('loading-page');
    const appContent    = document.getElementById('app-content');
    const settingsPage  = document.getElementById('settings-page');
    const btnEnable     = document.getElementById('btn-enable');
    const btnOptions    = document.getElementById('btn-options');
    const badgeSettings = document.getElementById('badge-settings');

    const imageGrid       = document.getElementById('image-grid');
    const btnTranslate    = document.getElementById('btn-translate');
    const selectionCount  = document.getElementById('selection-count');
    const btnSelectAll    = document.getElementById('btn-select-all');
    const btnSelectNone   = document.getElementById('btn-select-none');
    const btnBanSelected  = document.getElementById('btn-ban-selected');
    const btnScrollTop    = document.getElementById('btn-scroll-top');
    const btnScrollBottom = document.getElementById('btn-scroll-bottom');

    const btnUnbanSelected       = document.getElementById('btn-unban-selected');
    const bannedSiteList         = document.getElementById('banned-site-list');
    const bannedSelectionCount   = document.getElementById('banned-selection-count');
    const btnBannedScrollTop     = document.getElementById('btn-banned-scroll-top');
    const btnBannedScrollBottom  = document.getElementById('btn-banned-scroll-bottom');
    const btnBannedSelectAll     = document.getElementById('btn-banned-select-all');
    const btnBannedSelectNone    = document.getElementById('btn-banned-select-none');

    const settingsPrompt  = document.getElementById('settings-prompt');
    const charCount       = document.getElementById('char-count');
    const sBtnSave        = document.getElementById('s-btn-save');
    const sBtnRestore     = document.getElementById('s-btn-restore');
    const settingsStatus  = document.getElementById('settings-status');
    const settingsSites   = document.getElementById('settings-sites-list');
    const settingsAutoRestoreEnabled = document.getElementById('settings-auto-restore-enabled');
    const settingsRefreshAutoImages = document.getElementById('settings-refresh-auto-images');
    const settingsClearAutoBlocks = document.getElementById('settings-clear-auto-blocks');

    const tabBtns     = document.querySelectorAll('.tab-btn');
    const tabContents = document.querySelectorAll('.tab-content');

    let pageImages         = [];
    let selectedIndices    = new Set();
    let selectedBannedUrls = new Set();
    let bannedUrls         = [];
    let bannedKey          = 'bannedImages';
    let currentTabId       = null;
    let settingsOpen       = false;
    let justEnabledSite    = false;
    const expandedSettingsSites = new Set();

    function showPopupToast(msg, type = 'success') {
        const t = document.createElement('div');
        t.innerText = msg;
        t.style.cssText = `
            position: fixed;
            bottom: 20px;
            left: 50%;
            transform: translateX(-50%);
            background: ${type === 'error' ? '#D32F2F' : '#388E3C'};
            color: white;
            padding: 8px 16px;
            border-radius: 4px;
            font-size: 13px;
            font-weight: bold;
            z-index: 10000;
            box-shadow: 0 2px 10px rgba(0,0,0,0.5);
            opacity: 0;
            transition: opacity 0.3s;
        `;
        document.body.appendChild(t);
        t.offsetHeight; 
        t.style.opacity = '1';
        setTimeout(() => {
            t.style.opacity = '0';
            setTimeout(() => t.remove(), 300);
        }, 3000);
    }

    // ── Ponte com o armazenamento do background ──────────────────────────────
    // As páginas traduzidas vivem no IndexedDB da extensão (storage-manager.js).
    // O popup nunca carrega Base64 para montar listas: pede só metadados.
    /** Base64 de uma página, sob demanda (exportação/download). */
    async function smGetPage(chapterId, pageIndex) {
        const resp = await smRequest({ action: 'SM_GET_PAGE', chapterId, pageIndex });
        return (resp && resp.ok && resp.dataUrl) ? resp.dataUrl : null;
    }

    /**
     * Todas as páginas de um capítulo como { [index]: dataUrl }.
     * Usado só quando o usuário pede download/exportação — nunca para renderizar.
     * Cai no formato legado enquanto o capítulo não tiver sido migrado.
     */
    async function smChapterImages(chapterId) {
        const resp = await smRequest({ action: 'SM_PAGE_INDEX', chapterId });
        const pages = (resp && resp.ok && resp.pages) || [];
        if (pages.length === 0) {
            const legacy = await new Promise(r => chrome.storage.local.get([`${chapterId}_images`], r));
            return legacy[`${chapterId}_images`] || {};
        }
        const out = {};
        for (const page of pages) {
            const dataUrl = await smGetPage(chapterId, page.pageIndex);
            if (dataUrl) out[page.pageIndex] = dataUrl;
        }
        return out;
    }

    /**
     * Contagem de páginas por capítulo. Primeiro o armazenamento novo; para os
     * capítulos ainda não migrados, lê a chave legada apenas daqueles.
     */
    async function smChapterCounts(chapterIds) {
        const resp = await smRequest({ action: 'SM_CHAPTERS_STATS', chapterIds });
        const stats = (resp && resp.ok && resp.stats) || {};
        const counts = {};
        const pendingLegacy = [];
        chapterIds.forEach(id => {
            const n = stats[id] ? stats[id].pageCount : 0;
            counts[id] = n;
            if (n === 0) pendingLegacy.push(id);
        });
        if (pendingLegacy.length > 0) {
            const keys = pendingLegacy.map(id => `${id}_images`);
            const legacy = await new Promise(r => chrome.storage.local.get(keys, r));
            pendingLegacy.forEach(id => {
                counts[id] = Object.keys(legacy[`${id}_images`] || {}).length;
            });
        }
        return counts;
    }

    /**
     * Entradas de restauração (aba de configurações). Une o armazenamento novo
     * com o legado dos capítulos que ainda não foram abertos desde a migração —
     * assim nada some da lista antes de o usuário revisitar o capítulo.
     */
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.url || tab.url.startsWith('chrome://') || tab.url.startsWith('edge://')) {
        showPage(enablePage);
        const p = document.querySelector('#enable-section p');
        if(p) p.innerHTML = 'Não suportado nesta página.';
        btnEnable.style.display = 'none';
        return;
    }
    currentTabId = tab.id;
    const url      = new URL(tab.url);
    const hostname = url.hostname;
    bannedKey = `bannedImages_${hostname}`;

    function showPage(el) {
        [enablePage, appContent, settingsPage].forEach(p => {
            p.classList.remove('active');
            p.style.display = 'none';
        });
        loadingPage.style.display = 'none';
        loadingPage.classList.remove('active');

        el.style.display = 'flex';
        el.classList.add('active');
    }

    function showReloadRequired(reason = 'A extensão foi ativada, mas a página ainda não entregou imagens ao content script.') {
        showPage(enablePage);
        document.getElementById('enable-section').innerHTML = `
            <div class="enable-icon">⚠️</div>
            <p>${reason}</p>
            <p class="enable-sub">Atualize a página com Ctrl+F5 ou use o botão abaixo para recarregar sem cache.</p>
            <button id="btn-force-reload" class="btn" style="max-width:280px;margin-top:16px;">
                🔄 Recarregar Página
            </button>
        `;
        document.getElementById('btn-force-reload').addEventListener('click', () => {
            chrome.scripting.executeScript({ target: { tabId: currentTabId }, func: () => window.location.reload(true) })
                .then(() => window.close())
                .catch(() => { chrome.tabs.reload(currentTabId, { bypassCache: true }); window.close(); });
        });
    }

    btnOptions.addEventListener('click', () => {
        settingsOpen = !settingsOpen;
        btnOptions.classList.toggle('active', settingsOpen);
        badgeSettings.classList.toggle('visible', settingsOpen);
        if (settingsOpen) {
            showPage(settingsPage);
            loadSettingsPanel();
        } else {
            if (window.logPoller) {
                clearInterval(window.logPoller);
                window.logPoller = null;
            }
            chrome.storage.local.get(['enabledDomains'], (data) => {
                if ((data.enabledDomains || []).includes(hostname)) {
                    showPage(appContent);
                    // Reconsulta a página porque o usuário pode ter acabado de
                    // alterar o filtro dimensional nos ajustes.
                    loadMainImages();
                } else {
                    showPage(enablePage);
                }
            });
        }
    });

    function initAutoDownload() {
        const el = document.getElementById('chk-auto-download');
        if (!el || el._bound) return;
        el._bound = true;
        chrome.storage.local.get(['autoDownload'], (data) => { el.checked = data.autoDownload === true; });
        el.addEventListener('change', () => chrome.storage.local.set({ autoDownload: el.checked }));
    }
    
    const translatedTabBtn = document.querySelector('[data-target="translated-tab"]');
    if(translatedTabBtn) {
        translatedTabBtn.addEventListener('click', () => {
            setTimeout(initAutoDownload, 0);
        });
    }

    const imageScrollBox = document.querySelector('.image-scroll-box');
    if(btnScrollTop) btnScrollTop.addEventListener('click', () => (imageScrollBox || imageGrid).scrollTo({ top: 0, behavior: 'smooth' }));
    if(btnScrollBottom) btnScrollBottom.addEventListener('click', () => { const el = imageScrollBox || imageGrid; el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' }); });

    if (btnBannedScrollTop) btnBannedScrollTop.addEventListener('click', () => bannedSiteList.scrollTo({ top: 0, behavior: 'smooth' }));
    if (btnBannedScrollBottom) btnBannedScrollBottom.addEventListener('click', () => bannedSiteList.scrollTo({ top: bannedSiteList.scrollHeight, behavior: 'smooth' }));

    if (btnBannedSelectAll) {
        btnBannedSelectAll.addEventListener('click', () => {
            bannedSiteList.querySelectorAll('.image-card').forEach(card => {
                const key = `${card.dataset.host}::${card.dataset.src}`;
                selectedBannedUrls.add(key);
                card.classList.add('selected');
            });
            updateBannedSelection();
        });
    }

    if (btnBannedSelectNone) {
        btnBannedSelectNone.addEventListener('click', () => {
            selectedBannedUrls.clear();
            bannedSiteList.querySelectorAll('.image-card').forEach(card => card.classList.remove('selected'));
            updateBannedSelection();
        });
    }

    const sendMessageToTab = (message, callback) => {
        chrome.tabs.sendMessage(currentTabId, message, (response) => {
            if (chrome.runtime.lastError) {
                if (message.action === 'HIGHLIGHT_IMAGE') return;
                if (message.action === 'START_TRANSLATION_FROM_POPUP') {
                    if (callback) callback({ ok: true });
                    return;
                }
                console.log('Content script not ready:', chrome.runtime.lastError.message);
                showReloadRequired('A extensão precisa ser injetada nesta página.');
                return;
            }
            if (callback) callback(response);
        });
    };

    chrome.storage.local.get(['enabledDomains', bannedKey], (data) => {
        bannedUrls = data[bannedKey] || [];
        if ((data.enabledDomains || []).includes(hostname)) {
            initApp();
        } else {
            showPage(enablePage);
        }
    });

    btnEnable.addEventListener('click', () => {
        chrome.storage.local.get(['enabledDomains'], (data) => {
            const domains = data.enabledDomains || [];
            if (domains.includes(hostname)) return;
            domains.push(hostname);
            const metaKey  = `siteMeta_${hostname}`;
            const siteMeta = { title: tab.title || hostname, addedAt: Date.now() };
            chrome.storage.local.set({ enabledDomains: domains, [metaKey]: siteMeta }, () => {
                sendMessageToTab({ action: 'ENABLE_PAGE' }, () => {
                    justEnabledSite = true;
                    initApp();
                });
            });
        });
    });

    function initApp() {
        showPage(loadingPage);
        loadMainImages();
        loadBannedImages();
        initAutoDownload();
        chrome.storage.local.get(['mt_state'], (d) => {
            if (d.mt_state && d.mt_state.activeJobsCount > 0) {
                const dot   = document.getElementById('translating-dot');
                const label = document.getElementById('translating-label');
                if (dot)   dot.classList.add('visible');
                if (label) label.classList.add('visible');
            }
        });
    }

    tabBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            tabBtns.forEach(b => b.classList.remove('active'));
            tabContents.forEach(c => c.classList.remove('active'));
            btn.classList.add('active');
            document.getElementById(btn.dataset.target).classList.add('active');
            if (btn.dataset.target === 'translated-tab') loadTranslatedChapters();
        });
    });

    function attachEditFolderLogic(header, host, originalTitle) {
        const editBtn = header.querySelector('.folder-edit-btn');
        const nameContainer = header.querySelector('.site-folder-name-container');
        const nameSpan = header.querySelector('.site-folder-name');

        editBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            const input = document.createElement('input');
            input.type = 'text';
            input.className = 'folder-name-input';
            input.value = nameSpan.textContent;

            nameContainer.replaceChild(input, nameSpan);
            editBtn.style.display = 'none';
            input.focus();

            const saveName = () => {
                const newName = input.value.trim() || host;
                nameSpan.textContent = newName;
                if (input.parentNode === nameContainer) nameContainer.replaceChild(nameSpan, input);
                editBtn.style.display = 'inline-block';

                chrome.storage.local.get([`siteMeta_${host}`], (d) => {
                    const meta = d[`siteMeta_${host}`] || { hostname: host, addedAt: Date.now() };
                    meta.title = newName;
                    chrome.storage.local.set({ [`siteMeta_${host}`]: meta });
                });
            };

            input.addEventListener('blur', saveName);
            input.addEventListener('keydown', (evt) => {
                if (evt.key === 'Enter') { evt.preventDefault(); input.blur(); }
                if (evt.key === 'Escape') { input.value = originalTitle; input.blur(); }
            });
            input.addEventListener('click', e => e.stopPropagation());
        });
    }

    function tryGetImages(retries, delayMs, callback) {
        chrome.tabs.sendMessage(currentTabId, { action: 'GET_PAGE_IMAGES' }, (response) => {
            if (!chrome.runtime.lastError && response?.images) { callback(response); return; }
            if (retries <= 1) { callback(null); return; }
            setTimeout(() => tryGetImages(retries - 1, delayMs, callback), delayMs);
        });
    }

    function loadMainImages() {
        tryGetImages(3, 800, (response) => {
            const images = response?.images || [];
            if (!response?.images) {
                showReloadRequired('A extensão foi ativada, mas o script da página ainda não respondeu.');
                justEnabledSite = false;
                return;
            }
            if (justEnabledSite && images.length === 0) {
                showReloadRequired('Site ativado, mas nenhuma imagem foi identificada nesta leitura inicial.');
                justEnabledSite = false;
                return;
            }
            justEnabledSite = false;
            showPage(appContent);
            pageImages = images.filter(img => !bannedUrls.includes(img.src));
            if (pageImages.length === 0) {
                imageGrid.innerHTML = '<p class="empty-msg">Nenhuma imagem detectada (ou todas estão banidas).</p>';
                updateSelection();
                return;
            }
            renderMainGrid();
        });
    }

    function renderMainGrid() {
        imageGrid.innerHTML = '';
        selectedIndices.clear();

        pageImages.forEach((img, gridIdx) => {
            selectedIndices.add(img.index);

            const card = document.createElement('div');
            card.className     = 'image-card selected';
            card.dataset.index = img.index;
            card.dataset.src   = img.src;
            card.innerHTML = `
                <img src="${img.src}" alt="Pág. ${gridIdx + 1}" loading="lazy">
                <div class="check">✓</div>
                <div class="image-info">Pág. ${gridIdx + 1} · ${img.width}×${img.height}</div>
            `;

            card.addEventListener('click', () => {
                if (selectedIndices.has(img.index)) {
                    selectedIndices.delete(img.index); card.classList.remove('selected');
                } else {
                    selectedIndices.add(img.index); card.classList.add('selected');
                }
                updateSelection();
            });
            card.addEventListener('mouseenter', () => sendMessageToTab({ action: 'HIGHLIGHT_IMAGE', index: img.index, highlight: true }));
            card.addEventListener('mouseleave', () => sendMessageToTab({ action: 'HIGHLIGHT_IMAGE', index: img.index, highlight: false }));

            imageGrid.appendChild(card);
        });
        updateSelection();
    }

    function updateSelection() {
        const n = selectedIndices.size;
        selectionCount.textContent = `${n} ${n !== 1 ? 'imagens' : 'imagem'} ${n !== 1 ? 'selecionadas' : 'selecionada'}`;
        btnTranslate.textContent = n > 0 ? `Traduzir ${n} Página${n !== 1 ? 's' : ''}` : 'Traduzir Selecionadas';
        btnTranslate.disabled   = n === 0;
        btnBanSelected.disabled = n === 0;
        sendMessageToTab({ action: 'SET_SELECTED_IMAGES', indices: Array.from(selectedIndices) });
    }

    btnSelectAll.addEventListener('click', () => {
        imageGrid.querySelectorAll('.image-card').forEach(card => {
            selectedIndices.add(parseInt(card.dataset.index)); card.classList.add('selected');
        });
        updateSelection();
    });
    btnSelectNone.addEventListener('click', () => {
        imageGrid.querySelectorAll('.image-card').forEach(card => {
            selectedIndices.delete(parseInt(card.dataset.index)); card.classList.remove('selected');
        });
        updateSelection();
    });
    btnBanSelected.addEventListener('click', () => {
        imageGrid.querySelectorAll('.image-card.selected').forEach(card => {
            if (!bannedUrls.includes(card.dataset.src)) bannedUrls.push(card.dataset.src);
        });
        chrome.storage.local.set({ [bannedKey]: bannedUrls }, () => { loadMainImages(); loadBannedImages(); });
    });
    
    btnTranslate.addEventListener('click', () => {
        const indices = Array.from(selectedIndices);
        if (indices.length === 0) return;

        // FIX A-1 and M-3
        sendMessageToTab({ action: 'START_TRANSLATION_FROM_POPUP', indices }, () => {
            const progressPanel = document.getElementById('progress-panel');
            const progressText  = document.getElementById('progress-text');
            const progressFill  = document.getElementById('progress-bar-fill');
            const progressSub   = document.getElementById('progress-sub');
            const tabsEl        = document.querySelector('.tabs');
            const tabContentsEl = document.querySelectorAll('.tab-content');

            if (progressPanel) {
                if (tabsEl) tabsEl.style.display = 'none';
                tabContentsEl.forEach(t => { t.classList.remove('active'); t.style.display = 'none'; });
                progressPanel.classList.add('active');

                const total = indices.length;
                progressText.textContent = `Traduzindo páginas...`;
                progressSub.textContent  = `0 / ${total} páginas`;
                progressFill.style.width = '0%';

                let pollStarted = false;
                let backgroundStarted = false;
                const pollProgress = setInterval(() => {
                    chrome.storage.local.get(['mt_state', 'mt_popup_state'], (d) => {
                        const state = d.mt_state || {};
                        const popupState = d.mt_popup_state || {};
                        const popupStatus = popupState.status || null;
                        const popupStarted = popupStatus === 'starting' || popupStatus === 'processing' || popupStatus === 'complete';
                        if (state.isProcessing) backgroundStarted = true;
                        if (!pollStarted && !state.isProcessing && !popupStarted) return;
                        pollStarted = true;
                        if (!state.isProcessing && !backgroundStarted && popupStatus !== 'complete') return;

                        const geminiDone = state.completedJobs || 0;
                        const geminiTotal = state.totalJobs || popupState.geminiTotal || 0;
                        const cacheHits = Number.isFinite(popupState.cacheHits)
                            ? popupState.cacheHits
                            : Math.max(0, total - geminiTotal);
                        const queued = (state.jobQueue && state.jobQueue.length) || 0;
                        const active = state.activeJobsCount || 0;
                        
                        const processed = Math.max(0, total - queued - active);
                        const pct = total > 0 ? Math.round((Math.min(total, processed) / total) * 100) : 0;
                        
                        progressFill.style.width = pct + '%';
                        progressSub.textContent = geminiTotal > 0
                            ? `${geminiDone} / ${geminiTotal} Gemini + ${cacheHits} cache`
                            : `${processed} / ${total} páginas`;
                        const allDone = popupStatus === 'complete' || (backgroundStarted && active === 0 && queued === 0);
                        
                        if (allDone) {
                            clearInterval(pollProgress);
                            chrome.storage.local.remove('mt_popup_state');
                            progressText.textContent = geminiDone > 0 || cacheHits > 0
                                ? '✅ Tradução concluída!'
                                : '⚠️ Concluído com erros';

                            if (!progressPanel.querySelector('.progress-close-btn')) {
                                const btnClose = document.createElement('button');
                                btnClose.className = 'btn progress-close-btn';
                                btnClose.style.cssText = 'width:auto;padding:6px 24px;margin-top:8px;font-size:12px;';
                                btnClose.textContent = '✓ Fechar';
                                btnClose.addEventListener('click', () => {
                                    progressPanel.classList.remove('active');
                                    if (tabsEl) tabsEl.style.display = '';
                                    tabContentsEl.forEach(t => { t.style.display = ''; });
                                    document.querySelector('.tab-btn')?.click();
                                    window.close();
                                });
                                progressPanel.appendChild(btnClose);
                            }
                            setTimeout(() => window.close(), 1500);
                        }
                    });
                }, 800);

                const stopBtn = document.getElementById('btn-progress-stop');
                if (stopBtn) stopBtn.addEventListener('click', () => {
                    clearInterval(pollProgress);
                    chrome.runtime.sendMessage({ action: 'STOP_BATCH' });
                    window.close();
                });
            } else {
                window.close();
            }
        });

        const dot   = document.getElementById('translating-dot');
        const label = document.getElementById('translating-label');
        if (dot)   dot.classList.add('visible');
        if (label) label.classList.add('visible');
    });

    function loadBannedImages() {
        selectedBannedUrls.clear();
        updateBannedSelection();
        bannedSiteList.innerHTML = '<div class="empty-msg">Carregando...</div>';

        chrome.storage.local.get(['enabledDomains'], (initData) => {
            const domains = initData.enabledDomains || [];
            const keysToFetch = ['enabledDomains', `bannedImages_${hostname}`, `siteMeta_${hostname}`];
            domains.forEach(host => {
                keysToFetch.push(`bannedImages_${host}`);
                keysToFetch.push(`siteMeta_${host}`);
            });

            chrome.storage.local.get(keysToFetch, (data) => {
                const siteGroups = [];
                const processedHosts = new Set();

                domains.forEach(host => {
                    processedHosts.add(host);
                    const urls = data[`bannedImages_${host}`] || [];
                    if (urls.length > 0) siteGroups.push({ host, urls });
                });

                if (!processedHosts.has(hostname)) {
                    const urls = data[`bannedImages_${hostname}`] || [];
                    if (urls.length > 0) siteGroups.push({ host: hostname, urls });
                }

                bannedSiteList.innerHTML = '';
                if (siteGroups.length === 0) {
                    bannedSiteList.innerHTML = '<div class="empty-msg">Nenhuma imagem banida.</div>';
                    return;
                }

                siteGroups.forEach(({ host, urls }) => {
                    const siteMeta = data[`siteMeta_${host}`];
                    const siteTitle = siteMeta?.title || host.replace(/^www\./, '');
                    const isCurrentSite = host === hostname;

                    const folder = document.createElement('div');
                    folder.className = 'site-folder' + (isCurrentSite ? ' open' : '');

                    const header = document.createElement('div');
                    header.className = 'site-folder-header';
                    header.innerHTML = `
                        ${getSiteMarker(host, 'site-folder-favicon')}
                        <span class="site-folder-name-container">
                            <span class="site-folder-name" title="${escapeHTML(host)}">${escapeHTML(siteTitle)}</span>
                            <button class="folder-edit-btn" title="Editar nome da pasta">✏️</button>
                        </span>
                        <span class="site-folder-count">${urls.length} ban.</span>
                        <div class="folder-actions">
                            <button class="folder-nav-btn btn-folder-top" title="Topo">▲</button>
                            <button class="folder-nav-btn btn-folder-bottom" title="Fundo">▼</button>
                            <button class="text-btn text-btn-green btn-folder-all">Todas</button>
                            <button class="text-btn text-btn-red btn-folder-none">Nenhuma</button>
                        </div>
                        <span class="site-folder-arrow">▶</span>
                    `;
                    
                    header.addEventListener('click', (e) => {
                        if (e.target.closest('button') || e.target.closest('input')) return;
                        folder.classList.toggle('open');
                    });
                    
                    attachEditFolderLogic(header, host, siteTitle);

                    const body = document.createElement('div');
                    body.className = 'site-folder-body';

                    const scrollBox = document.createElement('div');
                    scrollBox.className = 'image-scroll-box';

                    const grid = document.createElement('div');
                    grid.className = 'image-grid';

                    urls.forEach(url => {
                        const card = document.createElement('div');
                        card.className = 'image-card';
                        card.dataset.src = url;
                        card.dataset.host = host;
                        card.innerHTML = `<img src="${url}" loading="lazy"><div class="check">✓</div>`;
                        card.addEventListener('click', () => {
                            const key = `${host}::${url}`;
                            if (selectedBannedUrls.has(key)) {
                                selectedBannedUrls.delete(key);
                                card.classList.remove('selected');
                            } else {
                                selectedBannedUrls.add(key);
                                card.classList.add('selected');
                            }
                            updateBannedSelection();
                        });
                        grid.appendChild(card);
                    });

                    scrollBox.appendChild(grid);
                    body.appendChild(scrollBox);
                    folder.appendChild(header);
                    folder.appendChild(body);
                    bannedSiteList.appendChild(folder);

                    const btnTop = header.querySelector('.btn-folder-top');
                    const btnBottom = header.querySelector('.btn-folder-bottom');
                    const btnAll = header.querySelector('.btn-folder-all');
                    const btnNone = header.querySelector('.btn-folder-none');

                    btnTop.addEventListener('click', () => scrollBox.scrollTo({ top: 0, behavior: 'smooth' }));
                    btnBottom.addEventListener('click', () => scrollBox.scrollTo({ top: scrollBox.scrollHeight, behavior: 'smooth' }));

                    btnAll.addEventListener('click', () => {
                        grid.querySelectorAll('.image-card').forEach(card => {
                            const key = `${host}::${card.dataset.src}`;
                            selectedBannedUrls.add(key);
                            card.classList.add('selected');
                        });
                        updateBannedSelection();
                    });

                    btnNone.addEventListener('click', () => {
                        grid.querySelectorAll('.image-card').forEach(card => {
                            const key = `${host}::${card.dataset.src}`;
                            selectedBannedUrls.delete(key);
                            card.classList.remove('selected');
                        });
                        updateBannedSelection();
                    });
                });
            });
        });
    }

    function updateBannedSelection() {
        const count = selectedBannedUrls.size;
        bannedSelectionCount.textContent = `${count} ${count !== 1 ? 'imagens' : 'imagem'} ${count !== 1 ? 'selecionadas' : 'selecionada'}`;
        btnUnbanSelected.disabled = selectedBannedUrls.size === 0;
    }

    btnUnbanSelected.addEventListener('click', () => {
        if (selectedBannedUrls.size === 0) return;
        const byHost = {};
        selectedBannedUrls.forEach(key => {
            const sep = key.indexOf('::');
            const host = key.slice(0, sep);
            const url  = key.slice(sep + 2);
            if (!byHost[host]) byHost[host] = [];
            byHost[host].push(url);
        });
        const hosts = Object.keys(byHost);
        const storageKeys = hosts.map(h => `bannedImages_${h}`);
        chrome.storage.local.get(storageKeys, (data) => {
            const updates = {};
            hosts.forEach(h => {
                const current = data[`bannedImages_${h}`] || [];
                updates[`bannedImages_${h}`] = current.filter(u => !byHost[h].includes(u));
            });
            if (byHost[hostname]) {
                bannedUrls = (data[`bannedImages_${hostname}`] || []).filter(u => !byHost[hostname].includes(u));
            }
            chrome.storage.local.set(updates, () => {
                loadBannedImages();
                loadMainImages();
            });
        });
    });

    function openMangaTranslatorRoot() {
        chrome.runtime.sendMessage({ action: 'OPEN_MANGA_ROOT' }, resp => {
            if(!resp?.ok && resp?.error) showPopupToast(resp.error, 'error');
        });
    }

    function getSiteMarker(host, className) {
        const initial = String(host || '?').replace(/^www\./, '').charAt(0).toUpperCase() || '?';
        return `<span class="${className}" aria-hidden="true">${escapeHTML(initial)}</span>`;
    }

    let _toolbarBound = false;
    function initToolbarOnce() {
        if (_toolbarBound) return;
        _toolbarBound = true;

        const btnExportAll  = document.getElementById('btn-export-all');
        const btnOpenFolder = document.getElementById('btn-open-folder');

        if (btnExportAll) {
            btnExportAll.addEventListener('click', () => {
                chrome.storage.local.get(['chapterList'], (listData) => {
                    const list = listData.chapterList || [];
                    if (!list.length) { alert('Nenhum capítulo salvo.'); return; }

                    // Exportar é o único fluxo que realmente precisa dos Base64.
                    // Buscamos capítulo por capítulo, sob demanda, em vez de
                    // carregar o acervo inteiro de uma vez.
                    (async () => {
                        btnExportAll.textContent = '⏱️';
                        btnExportAll.disabled = true;

                        const allDownloads = [];
                        for (const chap of list) {
                            const imgs = await smChapterImages(chap.id);
                            const safe = chap.title.replace(/[^a-z0-9]/gi, '_');
                            Object.keys(imgs).map(Number).sort((a,b)=>a-b).forEach(idx => {
                                allDownloads.push({ url: imgs[idx], filename: `${safe}/pagina_${String(idx).padStart(3,'0')}.png` });
                            });
                        }

                        if (!allDownloads.length) {
                            btnExportAll.textContent = '💾 Exportar Tudo';
                            btnExportAll.disabled = false;
                            alert('Nenhuma imagem para exportar.');
                            return;
                        }

                        chrome.runtime.sendMessage({ action: 'EXPORT_ALL_AND_SHOW', allDownloads }, (resp) => {
                            btnExportAll.textContent = '💾 Exportar Tudo';
                            btnExportAll.disabled = false;
                            if(resp?.ok) showPopupToast('Exportação concluída', 'success');
                            else showPopupToast('Falha na exportação', 'error');
                        });
                    })();
                });
            });
        }

        if (btnOpenFolder) {
            btnOpenFolder.addEventListener('click', openMangaTranslatorRoot);
        }
    }

    function loadTranslatedChapters() {
        initToolbarOnce();

        const chapterListEl = document.getElementById('chapter-list');
        chapterListEl.innerHTML = '<div class="empty-msg">Carregando...</div>';

        chrome.storage.local.get(['chapterList'], (listData) => {
            const list = listData.chapterList || [];
            if (!list.length) { chapterListEl.innerHTML = '<div class="empty-msg">Nenhuma pasta salva ainda.</div>'; return; }

            // A lista de capítulos não carrega mais `${chap.id}_images` (o Base64
            // de todo o acervo só para exibir "N pág."). A contagem vem do
            // armazenamento novo, em metadados.
            const keysToFetch = ['chapterList'];
            list.forEach(chap => {
                const host = chap.url ? getHostFromUrl(chap.url) : 'desconhecido';
                keysToFetch.push(`siteMeta_${host}`);
            });

            chrome.storage.local.get(keysToFetch, async (data) => {
                const pageCounts = await smChapterCounts(list.map(c => c.id));
                const groups = {};
                list.forEach(chap => {
                    const host = chap.url ? getHostFromUrl(chap.url) : 'desconhecido';
                    if (!groups[host]) groups[host] = { host, chapters: [] };
                    groups[host].chapters.push(chap);
                });

                chapterListEl.innerHTML = '';
                const sortedHosts = Object.keys(groups).sort((a, b) => {
                    if (a === hostname) return -1; if (b === hostname) return 1;
                    return Math.max(...groups[b].chapters.map(c=>c.timestamp||0)) - Math.max(...groups[a].chapters.map(c=>c.timestamp||0));
                });

                sortedHosts.forEach(host => {
                    const group      = groups[host];
                    const siteMeta   = data[`siteMeta_${host}`];
                    const siteTitle  = siteMeta?.title || host.replace(/^www\./, '');
                    const folder     = document.createElement('div');
                    folder.className = 'site-folder' + (host === hostname ? ' open' : '');

                    const header = document.createElement('div');
                    header.className = 'site-folder-header';
                    header.innerHTML = `
                        ${getSiteMarker(host, 'site-folder-favicon')}
                        <span class="site-folder-name-container">
                            <span class="site-folder-name" title="${escapeHTML(host)}">${escapeHTML(siteTitle)}</span>
                            <button class="folder-edit-btn" title="Editar nome da pasta">✏️</button>
                        </span>
                        <span class="site-folder-count">${group.chapters.length} cap.</span>
                        <span class="site-folder-arrow">▶</span>
                    `;
                    header.addEventListener('click', (e) => {
                        if (e.target.closest('button') || e.target.closest('input')) return;
                        folder.classList.toggle('open');
                    });
                    
                    attachEditFolderLogic(header, host, siteTitle);

                    const body = document.createElement('div');
                    body.className = 'site-folder-body';
                    group.chapters.sort((a,b) => a.title.localeCompare(b.title, 'pt', { numeric: true })).forEach(chap => {
                        const pageCount = pageCounts[chap.id] || 0;
                        const pageBadge = pageCount > 0
                            ? `<span style="font-size:10px;color:#4fc3f7;background:rgba(79,195,247,0.12);border:1px solid rgba(79,195,247,0.3);border-radius:8px;padding:1px 7px;margin-left:6px;font-weight:700;flex-shrink:0;">${pageCount} pág.</span>`
                            : `<span style="font-size:10px;color:#555;margin-left:6px;flex-shrink:0;">sem páginas</span>`;

                        const item = document.createElement('div');
                        item.className = 'chapter-item';
                        item.innerHTML = `
                            <div style="display:flex;align-items:center;gap:4px;">
                                <input type="text" class="chap-title-input" value="${escapeHTML(chap.title)}" style="flex:1;">
                                ${pageBadge}
                            </div>
                            <div class="chap-disk-path" style="font-size:10px;color:#555;padding:2px 4px 4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;" title="Caminho no disco">⏳ verificando...</div>
                            <div class="chapter-item-btns">
                                <button class="btn-read-chap">📖 Ler Offline</button>
                                <button class="btn-open-chap-folder" title="Abrir pasta">📁</button>
                                <button class="btn-export-chap" title="Exportar">💾</button>
                                <button class="btn-delete-chap" title="Apagar">🗑️</button>
                            </div>
                        `;

                        const pathLabel = item.querySelector('.chap-disk-path');
                        chrome.storage.local.get([chap.id + '_paths'], (pd) => {
                            const paths = pd[chap.id + '_paths'] || {};
                            const idxs = Object.keys(paths).map(Number).sort((a,b)=>a-b);
                            if (!idxs.length) {
                                pathLabel.textContent = '💾 Não baixado ainda';
                                return;
                            }
                            const samplePath = paths[idxs[idxs.length - 1]];
                            const sep = samplePath.includes('\\\\') ? '\\\\' : '/';
                            const parts = samplePath.split(sep);
                            parts.pop();
                            const folderPath = parts.join(sep);
                            pathLabel.textContent = '📂 ' + folderPath;
                            pathLabel.title = folderPath;
                        });

                        const ti = item.querySelector('.chap-title-input');
                        ti.addEventListener('change', (e) => { chap.title = e.target.value; chrome.storage.local.set({ chapterList: list }); });
                        item.querySelector('.btn-read-chap').addEventListener('click', () => chrome.tabs.create({ url: chrome.runtime.getURL(`reader.html?id=${chap.id}`) }));
                        item.querySelector('.btn-open-chap-folder').addEventListener('click', (e) => {
                            
                            const originalText = e.target.textContent;
                            e.target.textContent = '⏱️';
                            e.target.disabled = true;

                            const handleResp = (resp) => {
                                e.target.textContent = originalText;
                                e.target.disabled = false;
                                if (!resp?.ok) showPopupToast(resp?.error || 'Não foi possível abrir a pasta.', 'error');
                            }

                            chrome.storage.local.get(['autoDownload', chap.id + '_paths', chap.id + '_dlId'], async (d) => {
                                const paths = d[chap.id + '_paths'] || {};
                                const idxs = Object.keys(paths).map(Number).sort((a,b)=>a-b);
                                const safe = chap.title.replace(/[^a-z0-9]/gi, '_');
                                const dlId = d[chap.id + '_dlId'];

                                // As imagens só são materializadas quando há
                                // download de verdade a fazer.
                                const needsImages = d.autoDownload === true || idxs.length === 0;
                                const imgs = needsImages ? await smChapterImages(chap.id) : {};

                                if (d.autoDownload === true) {
                                    chrome.runtime.sendMessage({
                                        action: 'OPEN_CHAPTER_FOLDER',
                                        chapId: chap.id,
                                        images: imgs,
                                        safeTitle: safe,
                                        anchorId: dlId
                                    }, handleResp);
                                } else {
                                    if (idxs.length > 0) {
                                        const samplePath = paths[idxs[idxs.length - 1]];
                                        const sep = samplePath.includes('\\\\') ? '\\\\' : '/';
                                        const parts = samplePath.split(sep);
                                        parts.pop();
                                        const folderPath = parts.join(sep);
                                        chrome.runtime.sendMessage({
                                            action: 'SHOW_EXISTING_FOLDER',
                                            folderPath: folderPath,
                                            safeTitle: safe,
                                            anchorId: dlId
                                        }, handleResp);
                                    } else if (Object.keys(imgs).length > 0) {
                                        const ok = confirm('📂 Nenhuma imagem deste capítulo foi salva no computador ainda.\\n\\nDeseja baixar e abrir a pasta?');
                                        if (ok) {
                                            chrome.runtime.sendMessage({
                                                action: 'DOWNLOAD_CHAPTER_AND_SHOW',
                                                images: imgs,
                                                chapId: chap.id,
                                                safeTitle: safe
                                            }, handleResp);
                                        } else handleResp({ ok: true });
                                    } else {
                                        handleResp({ ok: false, error: 'Este capítulo não possui imagens.' });
                                    }
                                }
                            });
                        });
                        item.querySelector('.btn-export-chap').addEventListener('click', (e) => {
                            const btnEl = e.target;
                            const originalText = btnEl.textContent;
                            btnEl.textContent = '⏱️';
                            btnEl.disabled = true;

                            chrome.storage.local.get([`${chap.id}_dlId`], async (d) => {
                                const imgs = await smChapterImages(chap.id);
                                const dlId = d[`${chap.id}_dlId`] || null;
                                const idxs = Object.keys(imgs).map(Number).sort((a,b)=>a-b);
                                if (!idxs.length) { 
                                    alert('Sem imagens.'); 
                                    btnEl.textContent = originalText;
                                    btnEl.disabled = false;
                                    return; 
                                }
                                const safe = chap.title.replace(/[^a-z0-9]/gi, '_');
                                chrome.runtime.sendMessage({
                                    action: 'DOWNLOAD_CHAPTER_AND_SHOW',
                                    images: imgs,
                                    chapId: chap.id,
                                    safeTitle: safe,
                                    anchorId: dlId
                                }, (response) => {
                                    btnEl.textContent = originalText;
                                    btnEl.disabled = false;
                                    if (!response?.ok) showPopupToast('Falha na exportação', 'error');
                                    else showPopupToast('Exportação concluída', 'success');
                                });
                            });
                        });
                        let deleteInProgress = false;
                        item.querySelector('.btn-delete-chap').addEventListener('click', () => {
                            if (deleteInProgress) return;
                            if (!confirm(
                                'Apagar este capítulo da extensão?\\n\\n' +
                                '⚠️ Os arquivos salvos no seu computador NÃO serão apagados.\\n\\n' +
                                'Apenas o registro interno e as imagens armazenadas dentro da extensão serão removidos.'
                            )) return;

                            deleteInProgress = true;
                            const newList = list.filter(c => c.id !== chap.id);
                            chrome.storage.local.set({ chapterList: newList }, () => {
                                // Remove o capítulo nos DOIS armazenamentos: o novo
                                // (páginas + restores + assets, em uma transação) e
                                // os resíduos legados em chrome.storage.local.
                                smRequest({ action: 'SM_DELETE_CHAPTER', chapterId: chap.id }).then(() => {
                                    chrome.storage.local.remove([
                                        `${chap.id}_images`, `${chap.id}_paths`, `${chap.id}_dlId`,
                                        `${chap.id}_restoreMap`, `${chap.id}_restoreMeta`, `_sm_migrated_${chap.id}`
                                    ], () => {
                                        deleteInProgress = false;
                                        loadTranslatedChapters();
                                    });
                                });
                            });
                        });
                        body.appendChild(item);
                    });
                    folder.appendChild(header);
                    folder.appendChild(body);
                    chapterListEl.appendChild(folder);
                });
            });
        });
    }

    function loadSettingsPanel() {
        settingsTabBtns.forEach(btn => {
            const isAjustes = btn.getAttribute('data-target') === 'settings-generic';
            btn.classList.toggle('active', isAjustes);
            btn.style.color = isAjustes ? '#FF4444' : '#555';
            btn.style.borderBottomColor = isAjustes ? '#FF4444' : 'transparent';
        });
        settingsTabContents.forEach(content => {
            const isAjustes = content.id === 'settings-generic';
            content.classList.toggle('active', isAjustes);
            content.style.display = isAjustes ? 'flex' : 'none';
        });
        if (window.logPoller) {
            clearInterval(window.logPoller);
            window.logPoller = null;
        }

        chrome.storage.local.get(['customPrompt', 'defaultPrompt'], (data) => {
            const val = data.customPrompt || data.defaultPrompt || '';
            settingsPrompt.value = val;
            updateCharCount(val);
        });
        renderSettingsAutoRestore();
        renderSettingsSites();
        initGeminiExecutionMode();
        initDebugToggle();
        initImageMinimumFilter();
    }

    function initImageMinimumFilter() {
        const widthInput = document.getElementById('settings-image-min-width');
        const heightInput = document.getElementById('settings-image-min-height');
        const widthRange = document.getElementById('settings-image-min-width-range');
        const heightRange = document.getElementById('settings-image-min-height-range');
        const resetButton = document.getElementById('settings-image-min-reset');
        const shape = document.getElementById('image-filter-shape');
        if (!widthInput || !heightInput || !widthRange || !heightRange || !resetButton || !shape) return;

        const clamp = (value, fallback) => {
            const number = Number.parseInt(value, 10);
            return Number.isFinite(number) ? Math.max(0, Math.min(3000, number)) : fallback;
        };
        const render = (width, height) => {
            widthInput.value = width;
            heightInput.value = height;
            widthRange.value = width;
            heightRange.value = height;
            // A prévia é proporcional, mas limitada para continuar legível no popup.
            const scale = Math.min(118 / Math.max(width, 1), 128 / Math.max(height, 1), 1);
            shape.style.setProperty('--filter-preview-width', `${Math.max(18, Math.round(width * scale))}px`);
            shape.style.setProperty('--filter-preview-height', `${Math.max(18, Math.round(height * scale))}px`);
            shape.textContent = `${width} × ${height}`;
        };
        const save = (width, height) => {
            chrome.storage.local.set({ imageMinWidth: width, imageMinHeight: height });
        };
        const updateFrom = (source) => {
            const width = clamp(source === 'width' ? widthInput.value : widthRange.value, 300);
            const height = clamp(source === 'height' ? heightInput.value : heightRange.value, 400);
            render(width, height);
            save(width, height);
        };

        chrome.storage.local.get(['imageMinWidth', 'imageMinHeight'], (data) => {
            render(clamp(data.imageMinWidth, 300), clamp(data.imageMinHeight, 400));
        });

        if (widthInput._imageFilterBound) return;
        widthInput._imageFilterBound = true;
        widthInput.addEventListener('input', () => updateFrom('width'));
        heightInput.addEventListener('input', () => updateFrom('height'));
        widthRange.addEventListener('input', () => updateFrom('widthRange'));
        heightRange.addEventListener('input', () => updateFrom('heightRange'));
        resetButton.addEventListener('click', () => {
            render(300, 400);
            save(300, 400);
            showSettingsStatus('Tamanho mínimo restaurado para 300 × 400 px.', '#4CAF50');
        });
    }

    function renderSettingsAutoRestore() {
        if (!settingsAutoRestoreEnabled) return;
        chrome.storage.local.get(['autoRestoreEnabled'], data => {
            settingsAutoRestoreEnabled.checked = data.autoRestoreEnabled !== false;
        });

        if (!settingsAutoRestoreEnabled._autoRestoreBound) {
            settingsAutoRestoreEnabled._autoRestoreBound = true;
            settingsAutoRestoreEnabled.addEventListener('change', () => {
                chrome.storage.local.set({ autoRestoreEnabled: settingsAutoRestoreEnabled.checked }, () => {
                    showSettingsStatus(
                        settingsAutoRestoreEnabled.checked
                            ? 'Auto-substituição global ativada.'
                            : 'Auto-substituição global desligada.',
                        settingsAutoRestoreEnabled.checked ? '#4CAF50' : '#FF9800'
                    );
                });
            });
        }
    }

    function renderSettingsAutoImages() {
        renderSettingsSites();
    }

    function createSettingsAutoImageItem(entry, blockedImages) {
        const isBlocked = !!blockedImages[entry.cleanUrl];
        const item = document.createElement('div');
        item.className = 'settings-auto-image-item';

        const preview = document.createElement('img');
        preview.className = 'settings-auto-image-preview';
        // O preview tenta a URL remota original primeiro. A imagem traduzida só
        // é buscada do armazenamento se a remota falhar — evita trazer Base64 de
        // dezenas de páginas só para montar a lista.
        preview.src = entry.sourceUrl || entry.legacyDataUrl || '';
        preview.alt = '';
        preview.loading = 'lazy';
        let previewFallbackTried = false;
        preview.onerror = async () => {
            if (previewFallbackTried) return;
            previewFallbackTried = true;
            if (entry.legacyDataUrl) { preview.src = entry.legacyDataUrl; return; }
            if (!entry.assetId) return;
            const resp = await smRequest({ action: 'SM_GET_ASSET', assetId: entry.assetId });
            if (resp && resp.ok && resp.dataUrl) preview.src = resp.dataUrl;
        };

        const info = document.createElement('div');
        info.className = 'settings-auto-image-info';
        info.innerHTML = `
            <div class="settings-auto-image-title" title="${escapeHTML(entry.chapterTitle)}">${escapeHTML(entry.chapterTitle)}</div>
            <div class="settings-auto-image-url" title="${escapeHTML(entry.cleanUrl)}">${entry.index !== undefined ? `pág. ${entry.index} · ` : ''}${escapeHTML(entry.cleanUrl)}</div>
            <div class="settings-auto-image-state" style="color:${isBlocked ? '#FF9800' : '#4CAF50'};">${isBlocked ? 'Bloqueada para auto-substituição' : 'Permitida automaticamente'}</div>
        `;

        const blockBtn = document.createElement('button');
        blockBtn.className = 'settings-auto-image-btn settings-auto-image-block-btn';
        blockBtn.textContent = isBlocked ? 'Permitir' : 'Bloquear';
        blockBtn.style.background = isBlocked ? '#2d7a38' : '#8a1c1c';
        blockBtn.addEventListener('click', () => {
            chrome.storage.local.get(['autoRestoreBlockedImages'], d => {
                const current = normalizeBlockedImages(d.autoRestoreBlockedImages);
                if (current[entry.cleanUrl]) {
                    delete current[entry.cleanUrl];
                } else {
                    current[entry.cleanUrl] = {
                        cleanUrl: entry.cleanUrl,
                        host: entry.host,
                        sourceUrl: entry.sourceUrl,
                        chapterTitle: entry.chapterTitle,
                        blockedAt: Date.now(),
                    };
                }
                chrome.storage.local.set({ autoRestoreBlockedImages: current }, () => {
                    renderSettingsSites();
                    showSettingsStatus(
                        current[entry.cleanUrl] ? 'Imagem bloqueada para auto-substituição.' : 'Imagem permitida novamente.',
                        current[entry.cleanUrl] ? '#FF9800' : '#4CAF50'
                    );
                });
            });
        });

        const redoBtn = document.createElement('button');
        redoBtn.className = 'settings-auto-image-btn settings-auto-image-redo-btn';
        redoBtn.textContent = 'Refazer';
        redoBtn.title = 'Apagar a tradução salva desta imagem para gerar outra tradução depois';
        redoBtn.addEventListener('click', () => {
            deleteSavedTranslationForEntry(entry, {
                refresh: renderSettingsSites,
                showStatus: showSettingsStatus,
            });
        });

        item.appendChild(preview);
        item.appendChild(info);
        item.appendChild(blockBtn);
        item.appendChild(redoBtn);
        return item;
    }

    // ── Refazer ──────────────────────────────────────────────────────────────
    // Apaga tudo que faria a tradução errada reaparecer: o registro no
    // armazenamento novo (página + restore + asset), os resíduos legados do
    // capítulo, o bloqueio de auto-substituição e a entrada no cache global.
    function initDebugToggle() {
        const track = document.getElementById('debug-toggle-track');
        const text  = document.getElementById('debug-toggle-text');
        const row   = document.getElementById('debug-toggle-label');
        if (!row || row._debugBound) return;
        row._debugBound = true;

        let debugOn = false;

        function applyState(on) {
            debugOn = on;
            track.classList.toggle('on', on);
            text.classList.toggle('on', on);
            text.textContent = on ? '🟠 Debug ATIVADO — abas não serão fechadas' : 'Debug desativado';
        }

        chrome.storage.local.get(['debugMode'], d => applyState(d.debugMode === true));

        row.addEventListener('click', () => {
            const next = !debugOn;
            chrome.runtime.sendMessage({ action: 'SET_DEBUG_MODE', debugOn: next }, () => {
                applyState(next);
            });
        });

        const parallelSlider = document.getElementById('settings-parallel');
        const parallelVal = document.getElementById('settings-parallel-val');
        if (parallelSlider && parallelVal) {
            chrome.storage.local.get(['maxConcurrentJobs'], d => {
                const maxCon = parseInt(d.maxConcurrentJobs) || 1;
                parallelSlider.value = maxCon;
                parallelVal.textContent = maxCon;
            });
            parallelSlider.addEventListener('input', (e) => {
                const val = e.target.value;
                parallelVal.textContent = val;
                chrome.storage.local.set({ maxConcurrentJobs: parseInt(val) });
            });
        }
    }

    function initGeminiExecutionMode() {
        const popupGeminiTempRadio = document.getElementById('popup-gemini-mode-temp');
        const popupGeminiMinRadio  = document.getElementById('popup-gemini-mode-minimized');
        const popupGeminiDeleteRadio = document.getElementById('popup-gemini-mode-delete');
        if (!popupGeminiTempRadio && !popupGeminiMinRadio && !popupGeminiDeleteRadio) return;

        chrome.storage.local.get(['geminiExecutionMode'], (d) => {
            const mode = d.geminiExecutionMode || 'temp_chat';
            if (mode === 'minimized_window') {
                if (popupGeminiMinRadio) popupGeminiMinRadio.checked = true;
            } else if (mode === 'background_delete') {
                if (popupGeminiDeleteRadio) popupGeminiDeleteRadio.checked = true;
            } else {
                if (popupGeminiTempRadio) popupGeminiTempRadio.checked = true;
            }
        });

        if (!popupGeminiTempRadio._bound) {
            popupGeminiTempRadio._bound = true;
            document.querySelectorAll('input[name="popup-gemini-execution-mode"]').forEach(radio => {
                radio.addEventListener('change', () => {
                    if (radio.checked) {
                        const val = radio.value;
                        chrome.storage.local.set({ geminiExecutionMode: val }, () => {
                            const label = val === 'minimized_window'
                                ? 'Janela Minimizada'
                                : val === 'background_delete'
                                    ? 'Conversa Normal com Exclusão Segura'
                                    : 'Conversa Temporária';
                            showSettingsStatus(`Modo: ${label}`, '#4CAF50');
                        });
                    }
                });
            });
        }
    }

    function updateCharCount(text) {
        charCount.textContent = `${text.length} caractere${text.length !== 1 ? 's' : ''}`;
    }
    settingsPrompt.addEventListener('input', () => updateCharCount(settingsPrompt.value));

    sBtnSave.addEventListener('click', () => {
        const val = settingsPrompt.value.trim();
        chrome.storage.local.set({ customPrompt: val || null }, () => {
            if (!val) chrome.storage.local.remove('customPrompt');
            showSettingsStatus('✔ Salvo com sucesso!', '#4CAF50');
        });
    });

    sBtnRestore.addEventListener('click', () => {
        if (!confirm('Restaurar o prompt padrão?')) return;
        chrome.storage.local.remove('customPrompt', () => {
            chrome.storage.local.get(['defaultPrompt'], (data) => {
                const HD_PROMPT = typeof DEFAULT_HD_PROMPT !== 'undefined'
                    ? DEFAULT_HD_PROMPT
                    : "Objetivo primário: voce vai criar uma imagem , exata da imagem fornecida e traduzir ela pro português brasileiro . \nNão altere nenhum pixel fora das áreas de texto e Remova o texto original dos balões de fala, preenchendo o fundo com a cor correspondente. \nConverta os diálogos para PT-BR, mantendo a informalidade do contexto. Tipografia: Renderize o novo texto em caixa alta, fonte padrão de HQ (sans-serif), alinhamento centralizado.\nEfeitos Sonoros: Traduza e recrie as onomatopeias  mantendo as fontes estilizadas, cores, contornos e inclinação originais. lembre-se que todas as palavras devem sem traduzidas sem exceção";
                settingsPrompt.value = data.defaultPrompt || HD_PROMPT;
                updateCharCount(settingsPrompt.value);
                chrome.storage.local.set({ defaultPrompt: HD_PROMPT, customPrompt: HD_PROMPT });
                showSettingsStatus('✔ Prompt restaurado para o padrão.', '#FF9800');
            });
        });
    });

    function showSettingsStatus(msg, color = '#4CAF50') {
        settingsStatus.style.color = color;
        settingsStatus.textContent = msg;
        setTimeout(() => { settingsStatus.textContent = ''; }, 3000);
    }

    if (settingsRefreshAutoImages) {
        settingsRefreshAutoImages.addEventListener('click', renderSettingsAutoImages);
    }

    if (settingsClearAutoBlocks) {
        settingsClearAutoBlocks.addEventListener('click', () => {
            if (!confirm('Remover todos os bloqueios de imagens específicas?')) return;
            chrome.storage.local.set({ autoRestoreBlockedImages: {} }, () => {
                renderSettingsSites();
                showSettingsStatus('Bloqueios de imagem removidos.', '#FF9800');
            });
        });
    }

    function renderSettingsSites() {
        // Não puxa mais `${chapterId}_restoreMap` de todos os capítulos (cada um
        // carregava as imagens Base64 inteiras). Agora só metadados.
        chrome.storage.local.get(['enabledDomains', 'autoRestoreDisabledSites', 'autoRestoreBlockedImages', 'chapterList'], async (initData) => {
            const data = initData;
            const chapterList = initData.chapterList || [];
            {
                const domains = data.enabledDomains || [];
                const disabledSites = Array.isArray(data.autoRestoreDisabledSites) ? data.autoRestoreDisabledSites : [];
                const blockedImages = normalizeBlockedImages(data.autoRestoreBlockedImages);
                const entries = await loadRestoreEntries(chapterList);
                const entriesByHost = entries.reduce((acc, entry) => {
                    const host = entry.host || 'desconhecido';
                    if (!acc.has(host)) acc.set(host, []);
                    acc.get(host).push(entry);
                    return acc;
                }, new Map());
                const hosts = Array.from(new Set(domains));

            settingsSites.innerHTML = '';

            if (hosts.length === 0) {
                settingsSites.innerHTML = '<div class="settings-empty">Nenhum site habilitado ainda.</div>';
                return;
            }

            hosts.forEach(host => {
                const hostEntries = entriesByHost.get(host) || [];
                const item = document.createElement('div');
                item.className = 'settings-site-item';
                const isOpen = expandedSettingsSites.has(host);
                item.classList.toggle('open', isOpen);

                const main = document.createElement('div');
                main.className = 'settings-site-main';
                main.setAttribute('role', 'button');
                main.setAttribute('tabindex', '0');
                main.setAttribute('aria-expanded', isOpen ? 'true' : 'false');

                const arrow = document.createElement('span');
                arrow.className = 'settings-site-arrow';
                arrow.textContent = '▶';
                arrow.setAttribute('aria-hidden', 'true');

                const favicon = document.createElement('span');
                favicon.className = 'settings-site-favicon';
                favicon.setAttribute('aria-hidden', 'true');
                favicon.textContent = String(host || '?').replace(/^www\./, '').charAt(0).toUpperCase() || '?';

                const hostSpan = document.createElement('span');
                hostSpan.className = 'settings-site-host';
                hostSpan.textContent = host;
                hostSpan.title = host;

                const imageSummary = document.createElement('span');
                imageSummary.className = 'settings-site-image-summary';
                imageSummary.textContent = `${hostEntries.length} image${hostEntries.length === 1 ? 'm' : 'ns'}`;

                const autoLabel = document.createElement('label');
                autoLabel.className = 'settings-site-auto';
                autoLabel.title = `Permitir auto-substituição em ${host}`;
                const autoCheck = document.createElement('input');
                autoCheck.type = 'checkbox';
                autoCheck.checked = !disabledSites.includes(host);
                autoCheck.addEventListener('click', event => event.stopPropagation());
                autoCheck.addEventListener('change', (event) => {
                    event.stopPropagation();
                    chrome.storage.local.get(['autoRestoreDisabledSites'], d => {
                        const current = Array.isArray(d.autoRestoreDisabledSites) ? d.autoRestoreDisabledSites : [];
                        const next = autoCheck.checked
                            ? current.filter(h => h !== host)
                            : Array.from(new Set([...current, host]));
                        chrome.storage.local.set({ autoRestoreDisabledSites: next }, () => {
                            renderSettingsSites();
                            showSettingsStatus(
                                autoCheck.checked
                                    ? `Auto-substituição ativada em ${host}.`
                                    : `Auto-substituição bloqueada em ${host}.`,
                                autoCheck.checked ? '#4CAF50' : '#FF9800'
                            );
                        });
                    });
                });
                autoLabel.appendChild(autoCheck);
                autoLabel.appendChild(document.createTextNode('Auto'));
                autoLabel.addEventListener('click', event => event.stopPropagation());

                const removeBtn = document.createElement('button');
                removeBtn.className = 'settings-site-remove';
                removeBtn.innerHTML = '&#x2715;';
                removeBtn.title = `Remover ${host}`;
                removeBtn.addEventListener('click', (event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    chrome.storage.local.get(['enabledDomains', 'autoRestoreDisabledSites'], (d) => {
                        const updated = (d.enabledDomains || []).filter(h => h !== host);
                        const updatedDisabledSites = (d.autoRestoreDisabledSites || []).filter(h => h !== host);
                        chrome.storage.local.set({
                            enabledDomains: updated,
                            autoRestoreDisabledSites: updatedDisabledSites,
                        }, () => {
                            expandedSettingsSites.delete(host);
                            chrome.storage.local.remove([`siteMeta_${host}`], () => {
                                renderSettingsSites();
                                showSettingsStatus(`Permissão de "${host}" removida.`, '#FF9800');
                            });
                        });
                    });
                });

                function toggleSite() {
                    if (expandedSettingsSites.has(host)) expandedSettingsSites.delete(host);
                    else expandedSettingsSites.add(host);
                    renderSettingsSites();
                }
                main.addEventListener('click', toggleSite);
                main.addEventListener('keydown', event => {
                    if (event.key !== 'Enter' && event.key !== ' ') return;
                    event.preventDefault();
                    toggleSite();
                });

                main.appendChild(arrow);
                main.appendChild(favicon);
                main.appendChild(hostSpan);
                main.appendChild(imageSummary);
                main.appendChild(autoLabel);
                main.appendChild(removeBtn);
                item.appendChild(main);

                const imagesWrap = document.createElement('div');
                imagesWrap.className = 'settings-site-images';
                const imagesTitle = document.createElement('div');
                imagesTitle.className = 'settings-site-images-title';
                imagesTitle.textContent = 'Imagens específicas';
                imagesWrap.appendChild(imagesTitle);

                if (hostEntries.length === 0) {
                    const empty = document.createElement('div');
                    empty.className = 'settings-site-no-images';
                    empty.textContent = 'Nenhuma imagem salva para este site ainda.';
                    imagesWrap.appendChild(empty);
                } else {
                    hostEntries.forEach(entry => {
                        imagesWrap.appendChild(createSettingsAutoImageItem(entry, blockedImages));
                    });
                }
                item.appendChild(imagesWrap);
                settingsSites.appendChild(item);
            });
            }
        });
    }

    const settingsTabBtns = document.querySelectorAll('.settings-tab-btn');
    const settingsTabContents = document.querySelectorAll('.settings-tab-content');
    
    settingsTabBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            settingsTabBtns.forEach(b => {
                b.classList.remove('active');
                b.style.color = '#555';
                b.style.borderBottomColor = 'transparent';
            });
            settingsTabContents.forEach(c => {
                c.classList.remove('active');
                c.style.display = 'none';
            });
            
            btn.classList.add('active');
            btn.style.color = '#FF4444';
            btn.style.borderBottomColor = '#FF4444';
            
            const targetId = btn.getAttribute('data-target');
            const targetEl = document.getElementById(targetId);
            targetEl.classList.add('active');
            targetEl.style.display = 'flex';

            if (targetId === 'settings-logs') {
                renderLogs();
                if (!window.logListenerAdded) {
                    window.logListenerAdded = true;
                    if (chrome?.storage?.onChanged?.addListener) {
                        chrome.storage.onChanged.addListener((changes, area) => {
                            if (area === 'local' && changes.translatorLog) {
                                renderLogs();
                            }
                        });
                    }
                }
            } else {
                if (window.logPoller) {
                    clearInterval(window.logPoller);
                    window.logPoller = null;
                }
            }
        });
    });

    const btnClearLog = document.getElementById('btn-log-clear');
    const btnCopyLog = document.getElementById('btn-log-copy');
    const btnExportLog = document.getElementById('btn-log-export');
    const logContainer = document.getElementById('log-container');
    const filterLevel = document.getElementById('log-filter-level');
    const autoScroll = document.getElementById('log-autoscroll');
    const logCount = document.getElementById('log-count');

    let currentLogData = [];

    function formatTime(ts) {
        const d = new Date(ts);
        return d.toTimeString().split(' ')[0];
    }

    function updateLogView() {
        if (!logContainer) return;
        const levelMode = filterLevel.value;

        const filtered = currentLogData.filter(e => {
            if (levelMode !== 'all' && e.level !== levelMode) return false;
            return true;
        });

        const needScroll = autoScroll.checked && (logContainer.scrollHeight - logContainer.scrollTop <= logContainer.clientHeight + 10);

        logContainer.innerHTML = '';
        filtered.forEach(e => {
            const d = document.createElement('div');
            d.style.marginBottom = '6px';
            d.style.paddingBottom = '6px';
            d.style.borderBottom = '1px solid #222';
            d.style.display = 'flex';
            d.style.gap = '8px';
            d.style.wordBreak = 'break-all';

            let extraStr = '';
            if (e.extra && Object.keys(e.extra).length > 0) {
                extraStr = `<div style="color:#777; font-size:10px; margin-top:4px; background:#1b1b1b; padding:4px; border-radius:4px;">${escapeHTML(typeof e.extra === 'string' ? e.extra : JSON.stringify(e.extra))}</div>`;
            }

            let color = '#ccc';
            if (e.level === 'error') color = '#FF5252';
            if (e.level === 'warn') color = '#FFC107';
            if (e.level === 'success') color = '#4CAF50';
            if (e.level === 'info') color = '#4fc3f7';

            d.innerHTML = `
                <div style="color:#888; flex-shrink:0; width:55px;">${escapeHTML(formatTime(e.ts))}</div>
                <div style="flex:1;">
                    <div style="color:${color};"><strong style="text-transform:uppercase;">[${escapeHTML(e.source)}] ${escapeHTML(e.action)}</strong></div>
                    <div style="color:#eee; margin-top:2px;">${escapeHTML(e.detail || '')}</div>
                    ${extraStr}
                </div>
            `;
            logContainer.appendChild(d);
        });

        if (logCount) logCount.textContent = `${filtered.length} / ${currentLogData.length} registros`;
        
        if (needScroll || (autoScroll.checked && logContainer.scrollTop === 0)) {
            logContainer.scrollTop = logContainer.scrollHeight;
        }
    }

    function renderLogs() {
        chrome.storage.local.get(['translatorLog'], (result) => {
            currentLogData = result.translatorLog || [];
            updateLogView();
        });
    }

    if(filterLevel) filterLevel.addEventListener('change', updateLogView);
    if(autoScroll) autoScroll.addEventListener('change', () => {
        if (autoScroll.checked && logContainer) logContainer.scrollTop = logContainer.scrollHeight;
    });

    if(btnClearLog) btnClearLog.addEventListener('click', () => {
        if (!confirm('Apagar todo o log de atividades?')) return;
        chrome.storage.local.set({ translatorLog: [] }, () => {
            renderLogs();
        });
    });

    function serializeLogs(entries) {
        let txt = "=== Manga Translator System Log ===\n\n";
        entries.forEach(e => {
            let msg = `[${new Date(e.ts).toISOString()}] [${e.level.toUpperCase()}] [${e.source}] ${e.action}: ${e.detail}`;
            if (e.extra && Object.keys(e.extra).length > 0) {
                msg += ` | Extra: ${JSON.stringify(e.extra)}`;
            }
            txt += msg + "\n";
        });
        return txt;
    }

    async function copyLogText(text) {
        if (navigator.clipboard && navigator.clipboard.writeText) {
            await navigator.clipboard.writeText(text);
            return;
        }
        const textarea = document.createElement('textarea');
        textarea.value = text;
        textarea.setAttribute('readonly', '');
        textarea.style.position = 'fixed';
        textarea.style.opacity = '0';
        document.body.appendChild(textarea);
        textarea.select();
        const copied = document.execCommand('copy');
        textarea.remove();
        if (!copied) throw new Error('O navegador bloqueou a cópia para a área de transferência');
    }

    if(btnCopyLog) btnCopyLog.addEventListener('click', async () => {
        if (currentLogData.length === 0) {
            alert('Nenhum log para copiar.');
            return;
        }
        const originalLabel = btnCopyLog.textContent;
        try {
            await copyLogText(serializeLogs(currentLogData));
            btnCopyLog.textContent = 'Copiado!';
        } catch (error) {
            alert('Não foi possível copiar o log. Use Exportar para salvar o arquivo.');
        }
        setTimeout(() => { btnCopyLog.textContent = originalLabel; }, 1400);
    });

    if(btnExportLog) btnExportLog.addEventListener('click', () => {
        if (currentLogData.length === 0) {
            alert('Nenhum log para exportar.');
            return;
        }
        const txt = serializeLogs(currentLogData);
        const blob = new Blob([txt], { type: 'text/plain;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        chrome.downloads.download({
            url: url,
            filename: 'mangatranslator_log.txt',
            saveAs: true
        });
    });

    window.addEventListener('beforeunload', () => {
        if (window.logPoller) { clearInterval(window.logPoller); window.logPoller = null; }
    });

});


