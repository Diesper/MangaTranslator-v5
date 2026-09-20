'use strict';

// ── Estado Global ─────────────────────────────────────────
let jobQueue        = [];
let isProcessing    = false;
let stopRequested   = false;
let activeMangaTabId = null;
let currentBatchId = null;
let extractionTabs  = {};   
let totalJobs       = 0;
let completedJobs   = 0;
let activeJobsCount = 0;

// ── Índice durável de jobs abertos ───────────────────────────────────────────
// Evita varrer chrome.storage.local com get(null) (que carrega todas as imagens
// Base64 do acervo para a memória do Service Worker). Cada entrada:
//   { geminiTabId, jobId, batchId, mangaTabId, index }
let jobIndex = [];

const JOB_TIMEOUT_MINUTES = 4;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let gtcIndexedDbApi = null;
let gtcRepository = null;
let gtcRuntimeHandler = null;
let storageManagerApi = null;

// Nem todo ambiente (Service Worker antigo, Node/Jest sem webcrypto global)
// expõe crypto.randomUUID. Sem fallback, processNextJob lança e o lote morre.
function generateId(prefix = '') {
    try {
        if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
            return prefix + crypto.randomUUID();
        }
    } catch (_e) {}
    return `${prefix}${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}-${Math.random().toString(36).slice(2, 10)}`;
}

const _finalizedTabs = new Set();
const FINALIZATION_MARKER_TTL_MINUTES = 10;

function finalizationMarkerKey(geminiTabId) {
    return `gemini_finalized_${geminiTabId}`;
}

function armFinalizationMarkerCleanup(geminiTabId) {
    chrome.alarms.create(`finalization_marker_${geminiTabId}`, {
        delayInMinutes: FINALIZATION_MARKER_TTL_MINUTES,
    });
}

function _markFinalized(geminiTabId) {
    _finalizedTabs.add(geminiTabId);
    const cleanupTimer = setTimeout(() => _finalizedTabs.delete(geminiTabId), 30_000);
    if (cleanupTimer && typeof cleanupTimer.unref === 'function') cleanupTimer.unref();
}

if (typeof importScripts === 'function') {
    try {
        importScripts('background/router.js');
        importScripts('background/actions/log-entry.js');
        importScripts('background/actions/get-tab-id.js');
        importScripts('background/actions/relay-progress.js');
        importScripts('background/actions/check-extraction-tab.js');
        importScripts('background/actions/set-debug-mode.js');
        importScripts('background/actions/fetch-image-base64.js');
        importScripts('background/actions/calculate-visual-fingerprint.js');
        importScripts('background/actions/force-send-activation.js');
        importScripts('background/actions/request-image-data.js');
        importScripts('background/actions/open-manga-root.js');
        importScripts('background/actions/download-image.js');
        importScripts('background/actions/open-existing-folder.js');
        importScripts('background/actions/download-chapter.js');
        importScripts('background/actions/export-all.js');
        importScripts('background/actions/deliver-result-url.js');
        importScripts('background/actions/deliver-result-from-tab.js');
        importScripts('background/actions/report-error.js');
        importScripts('background/actions/deliver-result.js');
        importScripts('background/actions/start-batch.js');
        importScripts('background/actions/stop-batch.js');
    } catch (e) {}
    try {
        // gtc-fingerprint.js expõe self.MangaTranslatorGtcFingerprint:
        //   - SHA-256 (visual-v1/v2)
        //   - dHash   (visual-v2)
        //   - wHash   (visual-v3 — Haar Wavelet, 32×32 → 64 hex / 256 bits)
        //   - pHash   (visual-v3 — DCT, 32×32 → 64 hex / 256 bits)
        //   - Regional hashes (visual-v3 — 4 cantos, 48×48)
        //   - matchPerceptualHashes / Relaxed (decisão combinada wHash+pHash)
        importScripts('gtc-fingerprint.js');
        importScripts('gtc-indexeddb.js');
        // storage-manager.js roda SÓ aqui: o banco de páginas/assets precisa da
        // origem da extensão. Num content script ele criaria um banco por site.
        importScripts('storage-manager.js');
        if (typeof self !== 'undefined' && self.MangaTranslatorGtcIndexedDb) {
            gtcIndexedDbApi = self.MangaTranslatorGtcIndexedDb;
        }
        if (typeof self !== 'undefined' && self.MangaTranslatorStorageManager) {
            storageManagerApi = self.MangaTranslatorStorageManager;
        }
    } catch (e) {}
} else if (typeof require === 'function') {
    try {
        require('./background/router.js');
        require('./background/actions/log-entry.js');
        require('./background/actions/get-tab-id.js');
        require('./background/actions/relay-progress.js');
        require('./background/actions/check-extraction-tab.js');
        require('./background/actions/set-debug-mode.js');
        require('./background/actions/fetch-image-base64.js');
        require('./background/actions/calculate-visual-fingerprint.js');
        require('./background/actions/force-send-activation.js');
        require('./background/actions/request-image-data.js');
        require('./background/actions/open-manga-root.js');
        require('./background/actions/download-image.js');
        require('./background/actions/open-existing-folder.js');
        require('./background/actions/download-chapter.js');
        require('./background/actions/export-all.js');
        require('./background/actions/deliver-result-url.js');
        require('./background/actions/deliver-result-from-tab.js');
        require('./background/actions/report-error.js');
        require('./background/actions/deliver-result.js');
        require('./background/actions/start-batch.js');
        require('./background/actions/stop-batch.js');
    } catch (e) {}
    try {
        gtcIndexedDbApi = require('./gtc-indexeddb.js');
    } catch (e) {}
    try {
        storageManagerApi = require('./storage-manager.js');
    } catch (e) {}
}

function getGtcRepository() {
    if (!gtcRepository && gtcIndexedDbApi && gtcIndexedDbApi.createIndexedDbRepository) {
        gtcRepository = gtcIndexedDbApi.createIndexedDbRepository();
    }
    return gtcRepository;
}

// ── handleGtcRuntimeMessage ──────────────────────────────────────────────────
// Passa o fingerprintApi (self.MangaTranslatorGtcFingerprint) para o handler
// para que GTC_QUERY_BY_PERCEPTUAL possa invocar matchPerceptualHashes no SW,
// onde o banco IndexedDB também reside (mesmo processo do Service Worker).
//
// Sem o fingerprintApi, o lookup perceptual retorna vazio mas não quebra o fluxo
// (conteúdo do manga continua sendo tratado por SHA-256 e dHash como fallback).
// ─────────────────────────────────────────────────────────────────────────────
// ── handleStorageManagerMessage ──────────────────────────────────────────────
// O background é o ÚNICO dono da persistência de páginas traduzidas. O content
// script deixou de gravar direto em chrome.storage.local; agora ele envia o
// resultado e recebe confirmação. Isso elimina a corrida na raiz e permite que
// leitor/popup consultem metadados sem carregar Base64 nenhum.
//
// Síncrona por contrato (igual ao handler do GTC): retornar uma Promise faria o
// listener devolver sempre truthy e bloquearia todas as outras mensagens.
function handleStorageManagerMessage(request, sender, sendResponse) {
    if (!request || typeof request.action !== 'string' || request.action.indexOf('SM_') !== 0) return false;

    const sm = storageManagerApi;
    if (!sm) {
        sendResponse({ ok: false, error: 'storage-manager indisponível' });
        return true;
    }

    const run = (promise) => {
        promise
            .then(result => sendResponse({ ok: true, ...(result || {}) }))
            .catch(error => {
                const message = error && error.message ? error.message : String(error);
                log('error', 'bg', 'SM_ERROR', `Falha em ${request.action}: ${message}`, {});
                sendResponse({ ok: false, error: message });
            });
        return true;
    };

    switch (request.action) {
        case 'SM_SAVE_PAGE':
            return run(sm.savePageResult(
                request.chapterId, request.pageIndex, request.dataUrl,
                request.originalUrl || '', request.cleanUrl || '', request.meta || {}
            ));
        case 'SM_GET_ASSET':
            return run(sm.getAssetDataUrl(request.assetId).then(dataUrl => ({ dataUrl })));
        case 'SM_GET_PAGE':
            return run(sm.getPageDataUrl(request.chapterId, request.pageIndex).then(dataUrl => ({ dataUrl })));
        case 'SM_PAGE_INDEX':
            return run(sm.getChapterPageIndex(request.chapterId).then(pages => ({ pages })));
        case 'SM_RESTORE_INDEX':
            return run(sm.getRestoreIndex(request.chapterId).then(entries => ({ entries })));
        case 'SM_LIST_RESTORE':
            return run(sm.listRestoreEntries(request.chapterIds || null).then(entries => ({ entries })));
        case 'SM_CHAPTERS_STATS':
            return run(sm.getChaptersStats(request.chapterIds || []).then(stats => ({ stats })));
        case 'SM_DELETE_CLEAN_URL':
            return run(sm.deleteByCleanUrl(request.cleanUrl));
        case 'SM_DELETE_CHAPTER':
            return run(sm.deleteChapter(request.chapterId));
        case 'SM_MIGRATE_CHAPTER':
            return run(sm.migrateChapterFromLegacy(request.chapterId));
        case 'SM_STATS':
            return run(sm.stats().then(stats => ({ stats })));
        default:
            return false;
    }
}

function handleGtcRuntimeMessage(request, sender, sendResponse) {
    if (!gtcIndexedDbApi || !gtcIndexedDbApi.createGtcRuntimeHandler) return false;
    if (!gtcRuntimeHandler) {
        const fpApi = (typeof self !== 'undefined' && self.MangaTranslatorGtcFingerprint)
                   || null;
        gtcRuntimeHandler = gtcIndexedDbApi.createGtcRuntimeHandler({
            repository:    getGtcRepository(),
            fingerprintApi: fpApi,
            logger: (level, action, detail, extra = {}) => log(level, 'bg', action, detail, extra),
        });
    }
    return gtcRuntimeHandler(request, sender, sendResponse);
}

async function restoreState() {
    const d = await chrome.storage.local.get(['mt_state']);
    if (d.mt_state) {
        jobQueue          = d.mt_state.jobQueue || [];
        isProcessing      = d.mt_state.isProcessing || false;
        stopRequested     = d.mt_state.stopRequested || false;
        activeMangaTabId  = d.mt_state.activeMangaTabId || null;
        currentBatchId = d.mt_state.currentBatchId || null;
        extractionTabs    = d.mt_state.extractionTabs || {};  
        totalJobs         = d.mt_state.totalJobs || 0;
        completedJobs     = d.mt_state.completedJobs || 0;
        activeJobsCount   = d.mt_state.activeJobsCount || 0;
        jobIndex          = Array.isArray(d.mt_state.jobIndex) ? d.mt_state.jobIndex : [];
    }
}

async function syncState() {
    await chrome.storage.local.set({
        mt_state: { jobQueue, isProcessing, stopRequested, activeMangaTabId, currentBatchId, extractionTabs, totalJobs, completedJobs, activeJobsCount, jobIndex }
    });
}

// ── Manutenção do índice de jobs ─────────────────────────────────────────────
function indexAddJob(entry) {
    jobIndex = jobIndex.filter(j => j && j.geminiTabId !== entry.geminiTabId);
    jobIndex.push(entry);
}
function indexRemoveJob(geminiTabId) {
    const before = jobIndex.length;
    jobIndex = jobIndex.filter(j => j && j.geminiTabId !== geminiTabId);
    return jobIndex.length !== before;
}
function indexJobsOfBatch(batchId) {
    if (!batchId) return jobIndex.slice();
    return jobIndex.filter(j => j && j.batchId === batchId);
}

function tabExists(tabId) {
    return new Promise(resolve => {
        if (!tabId && tabId !== 0) { resolve(false); return; }
        try {
            chrome.tabs.get(tabId, (tab) => {
                if (chrome.runtime.lastError || !tab) resolve(false);
                else resolve(true);
            });
        } catch (_e) { resolve(false); }
    });
}

// ── reconcileJobs ────────────────────────────────────────────────────────────
// Um Service Worker MV3 pode ser descartado e recriado sem reiniciar o Chrome.
// Nesse caso as variáveis voltam vazias enquanto abas do Gemini continuam vivas.
// Antes, o código simplesmente zerava activeJobsCount — o que fazia o lote ser
// declarado concluído com jobs ainda em execução. Agora reconstruímos o estado
// a partir do índice durável e conferimos cada aba com chrome.tabs.get:
//   - aba viva   → job continua ativo (conta no activeJobsCount)
//   - aba morta  → job é descartado (chave + watchdog removidos, slot liberado)
async function reconcileJobs() {
    if (!Array.isArray(jobIndex) || jobIndex.length === 0) {
        activeJobsCount = Math.min(activeJobsCount, 0);
        return { alive: 0, dropped: 0 };
    }

    const alive = [];
    const dropped = [];
    for (const entry of jobIndex) {
        if (!entry) continue;
        const exists = await tabExists(entry.geminiTabId);
        if (exists) alive.push(entry);
        else dropped.push(entry);
    }

    if (dropped.length > 0) {
        const keys = [];
        dropped.forEach(entry => {
            keys.push(`gemini_job_${entry.geminiTabId}`);
            keys.push(`wd_data_${entry.geminiTabId}`);
            const alarmName = entry.jobId ? `watchdog_${entry.jobId}` : `watchdog_${entry.geminiTabId}`;
            chrome.alarms.clear(alarmName, () => {});
        });
        try { await chrome.storage.local.remove(keys); } catch (_e) {}
        log('warn', 'bg', 'JOB_RECONCILE_DROP', `${dropped.length} job(s) órfão(s) descartado(s) após reinício do worker`, {
            dropped: dropped.map(j => j.geminiTabId),
        });
    }

    jobIndex = alive;
    activeJobsCount = alive.length;
    if (alive.length > 0 && !activeMangaTabId) {
        activeMangaTabId = alive[0].mangaTabId || null;
    }
    return { alive: alive.length, dropped: dropped.length };
}

let _initialized = false;
async function ensureInitialized() {
    if (_initialized) return;
    await restoreState();
    _initialized = true;
    try {
        const result = await reconcileJobs();
        if (result.dropped > 0 || result.alive > 0) {
            await syncState();
            if (result.dropped > 0) processNextJob();
        }
    } catch (_e) {}
}

let _logQueue = [];
let _logFlushing = false;

function log(level, source, action, detail, extra = {}) {
    _logQueue.push({ id: `${Date.now()}_${Math.random()}`, ts: Date.now(), level: level || 'info', source: source || 'bg', action: action || 'UNKNOWN', detail: detail || '', extra: extra || {} });
    if (!_logFlushing) _flushLog();
}

async function _flushLog() {
    _logFlushing = true;
    try {
        while (_logQueue.length > 0) {
            const batch = _logQueue.splice(0, _logQueue.length);
            const data = await chrome.storage.local.get(['translatorLog']);
            const entries = data.translatorLog || [];
            entries.push(...batch);
            if (entries.length > 500) entries.splice(0, entries.length - 500);
            await chrome.storage.local.set({ translatorLog: entries });
        }
    } catch (e) {}
    _logFlushing = false;
}

// As ações migradas continuam lendo o estado que o worker legado já mantém.
// A fachada evita criar uma segunda fonte de verdade antes da extração completa.
const legacyActionState = {
    get activeMangaTabId() { return activeMangaTabId; },
    get currentBatchId() { return currentBatchId; },
    get extractionTabs() { return extractionTabs; },
};
let registeredActionRouter = null;

function routeRegisteredAction(request, sender, sendResponse) {
    const scope = typeof self !== 'undefined' ? self : globalThis;
    const routerApi = scope && scope.MangaTranslatorRouter;
    if (!routerApi || !request || typeof request.action !== 'string') return null;

    const actionName = routerApi.resolveActionName(request.action);
    if (!actionName || !routerApi.getAction(actionName)) return null;

    if (!registeredActionRouter) {
        registeredActionRouter = routerApi.createMessageRouter({
            contextFactory: () => ({
                state: legacyActionState,
                log,
                handleMarkerAndShow,
                waitForDownload,
                downloadImagesAndShow,
                syncState,
                assertJobOwnership,
                ensureInitialized,
                deliverResultToManga,
                finalizeJob,
                startBatch,
                stopBatch,
            }),
        });
    }

    const legacyResponseActions = new Set([
        'GET_TAB_ID',
        'CHECK_IF_EXTRACTION_TAB',
        'REQUEST_IMAGE_DATA',
        'FETCH_IMAGE_AS_BASE64',
        'DOWNLOAD_IMAGE',
    ]);
    const sendResponseCompat = response => {
        if (legacyResponseActions.has(request.action) && response && response.ok === true) {
            const { ok: _ok, ...legacyResponse } = response;
            sendResponse(legacyResponse);
            return;
        }
        if (request.action === 'FETCH_IMAGE_AS_BASE64' && response && response.ok === false && response.error) {
            const error = typeof response.error === 'object'
                ? response.error.message || response.error.code
                : response.error;
            sendResponse({ error });
            return;
        }
        sendResponse(response);
    };

    return {
        handled: true,
        keepAlive: registeredActionRouter(request, sender, sendResponseCompat),
    };
}

function armWatchdog(mangaTabId, index, geminiTabId, jobId) {
    const alarmName = jobId ? `watchdog_${jobId}` : `watchdog_${geminiTabId}`;
    chrome.alarms.clear(alarmName, () => {
        chrome.storage.local.set({ [`wd_data_${geminiTabId}`]: { mangaTabId, index, geminiTabId, jobId } }, () => {
            chrome.alarms.create(alarmName, { delayInMinutes: JOB_TIMEOUT_MINUTES });
        });
    });
}
function clearWatchdog(geminiTabId, jobId) {
    const alarmName = jobId ? `watchdog_${jobId}` : `watchdog_${geminiTabId}`;
    chrome.alarms.clear(alarmName, () => {
        chrome.storage.local.remove(`wd_data_${geminiTabId}`);
    });
}

// ── Máquina de estados do job ────────────────────────────────────────────────
// queued → opening → running → result_received → dom_applied → completed
//                            ↘ failed / cancelled
// O estado fica no próprio registro gemini_job_<tabId>, de modo que uma
// reidratação do Service Worker sabe exatamente em que ponto o job parou.
function updateJobState(geminiTabId, patch = {}) {
    if (geminiTabId === null || geminiTabId === undefined) return;
    const jobKey = `gemini_job_${geminiTabId}`;
    chrome.storage.local.get([jobKey], (data) => {
        const job = data && data[jobKey];
        if (!job) return;
        chrome.storage.local.set({
            [jobKey]: { ...job, ...patch, updatedAt: Date.now() }
        }, () => { if (chrome.runtime.lastError) {} });
    });
}

// ── Validação do remetente ───────────────────────────────────────────────────
// Só aceitamos resultados/erros vindos da aba que realmente detém o job.
// Mensagens legadas (sem jobId) continuam aceitas para compatibilidade.
function assertJobOwnership(sender, jobId, callback) {
    const tabId = sender && sender.tab ? sender.tab.id : null;
    if (!jobId) { callback(true, tabId); return; }
    if (tabId === null) { callback(false, tabId); return; }
    chrome.storage.local.get([`gemini_job_${tabId}`], (data) => {
        const job = data && data[`gemini_job_${tabId}`];
        if (!job) { callback(false, tabId); return; }
        callback(job.jobId === jobId, tabId);
    });
}

// ── deliverResultToManga ─────────────────────────────────────────────────────
// Substitui o antigo `setTimeout(() => finalizeJob(...), 1500)`.
//
// Antes: o resultado era enviado à página e, 1,5 s depois, o job era declarado
// concluído — sem nenhuma garantia de que a imagem tinha sido aplicada ou
// persistida. Com concorrência C e N páginas, isso somava ~1,5 × N / C segundos
// ociosos ao caminho crítico e podia marcar sucesso antes da gravação terminar.
//
// Agora: enviamos o resultado, o content script grava/aplica e só então responde.
// O slot de concorrência é liberado no instante do ACK.
//
// O timer aqui é apenas um guarda-chuva contra um content script que aceita a
// mensagem e nunca responde; a garantia durável continua sendo o alarme watchdog.
const DOM_ACK_TIMEOUT_MS = 30_000;

function deliverResultToManga({ mangaTabId, index, src, jobId, batchId, geminiTabId }) {
    updateJobState(geminiTabId, { state: 'result_received' });

    let settled = false;
    let guard = null;

    const settle = (ok, reason) => {
        if (settled) return;
        settled = true;
        if (guard) clearTimeout(guard);
        if (ok) {
            updateJobState(geminiTabId, { state: 'dom_applied' });
        } else {
            log('warn', 'bg', 'DOM_APPLY_FAIL', `Resultado não confirmado pela aba do mangá: ${reason}`, { index, reason });
        }
        finalizeJob(geminiTabId, mangaTabId, !ok);
    };

    guard = setTimeout(() => settle(false, 'ack_timeout'), DOM_ACK_TIMEOUT_MS);
    if (guard && typeof guard.unref === 'function') guard.unref();

    try {
        chrome.tabs.sendMessage(
            mangaTabId,
            { action: 'UPDATE_IMAGE', index, newSrc: src, jobId, batchId, expectAck: true },
            (resp) => {
                const err = chrome.runtime.lastError;
                if (err) {
                    // "message channel closed" = a mensagem chegou, mas o content
                    // script é de uma versão antiga que não devolve ACK.
                    // Nesse caso a imagem foi aplicada; contamos como sucesso.
                    const legacyNoAck = /message channel closed/i.test(err.message || '');
                    settle(legacyNoAck, legacyNoAck ? 'legacy_no_ack' : (err.message || 'send_failed'));
                    return;
                }
                if (resp && resp.ok === false) {
                    settle(false, resp.reason || 'rejected_by_page');
                    return;
                }
                settle(true);
            }
        );
    } catch (e) {
        settle(false, e && e.message ? e.message : 'send_exception');
    }
}

chrome.runtime.onInstalled.addListener(() => {
    chrome.storage.local.get(['defaultPrompt'], (data) => {
        if (!data.defaultPrompt) {
            chrome.storage.local.set({ defaultPrompt: "Objetivo primário: voce vai criar uma imagem , exata da imagem fornecida e traduzir ela pro português brasileiro . \nNão altere nenhum pixel fora das áreas de texto e Remova o texto original dos balões de fala, preenchendo o fundo com a cor correspondente. \nConverta os diálogos para PT-BR, mantendo a informalidade do contexto. Tipografia: Renderize o novo texto em caixa alta, fonte padrão de HQ (sans-serif), alinhamento centralizado.\nEfeitos Sonoros: Traduza e recrie as onomatopeias  mantendo as fontes estilizadas, cores, contornos e inclinação originais. lembre-se que todas as palavras devem sem traduzidas sem exceção" });
        }
    });
});

chrome.runtime.onStartup.addListener(async () => {
    await restoreState();
    _initialized = true;
    
    // FIX M-5
    extractionTabs = {};

    const hadWork = jobQueue.length > 0 || activeJobsCount > 0 || jobIndex.length > 0;

    // Em onStartup o navegador foi reiniciado: nenhuma aba do Gemini sobrevive,
    // então a reconciliação sempre descarta os jobs órfãos e libera os slots.
    const reconciled = await reconcileJobs();

    if (hadWork) {
        log('warn', 'bg', 'STARTUP_RECOVERY', `Service worker reiniciado: ${jobQueue.length} jobs na fila, ${reconciled.alive} ativos preservados, ${reconciled.dropped} órfãos descartados`, {
            jobQueue: jobQueue.length,
            alive: reconciled.alive,
            dropped: reconciled.dropped,
        });
        isProcessing = jobQueue.length > 0 || reconciled.alive > 0;
        await syncState();
        processNextJob();
    } else {
        await syncState();
    }
});

chrome.runtime.onConnect.addListener(port => {
    if (port.name === 'gemini-keep-alive') port.onDisconnect.addListener(() => {});
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
    await ensureInitialized();
    if (alarm.name.startsWith('finalization_marker_')) {
        const geminiTabId = alarm.name.replace('finalization_marker_', '');
        chrome.storage.local.remove(finalizationMarkerKey(geminiTabId));
        return;
    }
    if (alarm.name === 'nextJobAlarm') {
        processNextJob();
        return;
    }

    if (alarm.name.startsWith('watchdog_')) {
        // O nome do alarme agora pode ser watchdog_${jobId} (UUID) ou watchdog_${tabId} (legado)
        // Buscar wd_data pelo sufixo — pode ser jobId ou tabId
        const suffix = alarm.name.replace('watchdog_', '');

        // O alarme pode se chamar watchdog_<jobId> (UUID) ou watchdog_<tabId> (legado).
        // O índice durável resolve jobId → geminiTabId sem precisar de get(null),
        // que carregaria todas as imagens Base64 do acervo na memória do worker.
        const indexed = jobIndex.find(j => j && (String(j.jobId) === suffix || String(j.geminiTabId) === suffix));
        const candidateKeys = [];
        if (indexed) candidateKeys.push(`wd_data_${indexed.geminiTabId}`);
        if (!candidateKeys.includes(`wd_data_${suffix}`)) candidateKeys.push(`wd_data_${suffix}`);

        chrome.storage.local.get(candidateKeys, (data) => {
            const storageKey = candidateKeys.find(k => data && data[k]);
            const wd = storageKey
                ? data[storageKey]
                : (indexed ? { geminiTabId: indexed.geminiTabId, mangaTabId: indexed.mangaTabId, index: indexed.index, jobId: indexed.jobId } : null);

            if (!wd) return;

            if (storageKey) chrome.storage.local.remove(storageKey);
            const parsedSuffix = parseInt(suffix, 10);
            const geminiTabId = wd.geminiTabId
                || (indexed && indexed.geminiTabId)
                || (Number.isFinite(parsedSuffix) ? parsedSuffix : null);
            if (geminiTabId === null) return;
            log('warn', 'bg', 'JOB_TIMEOUT', `Timeout de ${JOB_TIMEOUT_MINUTES} min no index ${wd.index}`, { geminiTabId });

            if (wd.mangaTabId) {
                chrome.tabs.sendMessage(wd.mangaTabId, {
                    action: 'SHOW_ERROR_INTEGRATED', errorMsg: `⏰ LIMITE DE TEMPO (${JOB_TIMEOUT_MINUTES} min)`, imgIndex: wd.index, isDebug: false
                }, () => { if (chrome.runtime.lastError) {} });
            }

            finalizeJob(geminiTabId, wd.mangaTabId, true);
            const orphanIds = Object.keys(extractionTabs).filter(tabId => extractionTabs[tabId] && extractionTabs[tabId].geminiTabId === geminiTabId);
            orphanIds.forEach(tabId => {
                const numId = Number(tabId);
                chrome.tabs.remove(numId, () => { if (chrome.runtime.lastError) {} });
                delete extractionTabs[numId];
            });
        });
    }
});

function sendProgress(mangaTabId, text) {
    if (!mangaTabId) return;
    chrome.tabs.sendMessage(mangaTabId, { action: 'PROGRESS', text }, () => { if (chrome.runtime.lastError) {} });
}

function buildGeminiJobUrl(baseUrl, jobIndex) {
    try {
        const parsed = new URL(baseUrl);
        parsed.searchParams.set('mangatranslator', 'true');
        if (parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost') {
            parsed.searchParams.set('jobIndex', String(jobIndex));
        }
        return parsed.toString();
    } catch (e) {
        return baseUrl;
    }
}

async function deleteGeminiConversation(geminiTabId) {
    if (!geminiTabId) return Promise.resolve();
    for (let attempt = 1; attempt <= 3; attempt++) {
        const response = await new Promise(resolve => {
            chrome.tabs.sendMessage(geminiTabId, { action: 'DELETE_CONVERSATION' }, (resp) => {
                if (chrome.runtime.lastError) resolve({ ok: false, error: chrome.runtime.lastError.message });
                else resolve(resp || { ok: true });
            });
        });
        if (response && response.ok !== false) return response;
        log('warn', 'bg', 'DELETE_RETRY', `Tentativa ${attempt} de apagar conversa falhou`, { geminiTabId, error: response && response.error });
        await delay(700);
    }
    return { ok: false };
}

// ── Scripts de automação do Gemini registrados estaticamente no manifest.json ─
// inject.js roda em MAIN world no document_start para garantir que o Gemini
// execute perfeitamente em segundo plano sem exigir foco manual da aba.
function scriptingAvailable() { return false; }
async function registerGeminiScripts() { return true; }
async function unregisterGeminiScripts() { return true; }
function releaseGeminiScriptsIfIdle() {}

let _cachedMaxCon = 1;

// Retorna Promise: START_BATCH precisa esperar o valor real antes de despachar,
// senão o primeiro lote após o worker acordar roda com concorrência 1 mesmo que
// o usuário tenha configurado 10 (o cache ainda não tinha sido preenchido).
function _refreshMaxCon() {
    return new Promise(resolve => {
        chrome.storage.local.get('maxConcurrentJobs', d => {
            _cachedMaxCon = parseInt(d && d.maxConcurrentJobs) || 1;
            resolve(_cachedMaxCon);
        });
    });
}
_refreshMaxCon();

async function processNextJob() {
    if (stopRequested || (jobQueue.length === 0 && activeJobsCount === 0)) {
        // Nunca declarar o lote concluído enquanto houver job registrado no índice
        // durável: isso significa que uma aba do Gemini ainda está processando,
        // mesmo que o contador em memória tenha sido perdido/zerado.
        const stillOpen = !stopRequested ? indexJobsOfBatch(currentBatchId).length : 0;
        if (stillOpen > 0) {
            log('info', 'bg', 'BATCH_WAIT', `Lote ainda tem ${stillOpen} job(s) aberto(s); conclusão adiada`, { stillOpen });
            activeJobsCount = Math.max(activeJobsCount, stillOpen);
            await syncState();
            return;
        }
        if (!stopRequested && jobQueue.length === 0 && activeJobsCount === 0) {
            if (activeMangaTabId) {
                chrome.tabs.sendMessage(activeMangaTabId, { action: 'BATCH_COMPLETE', batchId: currentBatchId }, () => {
                    if (chrome.runtime.lastError) {}
                });
            }
            log('success', 'bg', 'BATCH_DONE', `Lote finalizado com sucesso!`);
            isProcessing = false;
            activeMangaTabId = null;
            releaseGeminiScriptsIfIdle();
        }
        await syncState();
        return;
    }

    if (stopRequested || jobQueue.length === 0) return;

    if (activeJobsCount >= _cachedMaxCon) return;

    activeJobsCount++;
    const job = jobQueue.shift();
    if (!job) {
        activeJobsCount--;
        await syncState(); 
        return;
    }

    const { mangaTabId, index, prompt } = job;
    const jobId = generateId();
    const batchId = job.batchId || currentBatchId;
    activeMangaTabId = mangaTabId;
    await syncState();
    
    log('info', 'bg', 'JOB_START', `Iniciando Imagem ${index}`, { completedJobs, totalJobs, activeJobsCount });
    sendProgress(mangaTabId, `🔄 ABRINDO GEMINI (${completedJobs + 1}/${totalJobs})...`);

    try {
        const storageData = await chrome.storage.local.get(['geminiBaseUrl', 'geminiExecutionMode']);
        let geminiBaseUrl = storageData.geminiBaseUrl || 'https://gemini.google.com/app';
        if (geminiBaseUrl === 'https://gemini.google.com/' || geminiBaseUrl === 'https://gemini.google.com') {
            geminiBaseUrl = 'https://gemini.google.com/app';
        }
        const geminiJobUrl = buildGeminiJobUrl(geminiBaseUrl, index);
        const executionMode = storageData.geminiExecutionMode || 'temp_chat';

        let geminiTab = null;
        let geminiWindowId = null;

        if (executionMode === 'minimized_window') {
            try {
                // Modo Janela Minimizada: Cria o Gemini em janela separada minimizada
                const geminiWindow = await chrome.windows.create({
                    url: geminiJobUrl,
                    focused: false,
                    state: 'minimized'
                });
                geminiWindowId = geminiWindow.id;
                geminiTab = (geminiWindow.tabs && geminiWindow.tabs[0]) || null;
                if (!geminiTab) {
                    const tabs = await chrome.tabs.query({ windowId: geminiWindowId });
                    geminiTab = tabs[0];
                }
            } catch (winErr) {
                geminiTab = await chrome.tabs.create({ url: geminiJobUrl, active: false });
                geminiWindowId = geminiTab.windowId;
            }
        } else {
            // Modo Padrão: Conversa Temporária em aba normal em segundo plano (sem janela minimizada)
            geminiTab = await chrome.tabs.create({ url: geminiJobUrl, active: false });
            geminiWindowId = geminiTab.windowId;
        }

        if (!geminiTab) throw new Error('Não foi possível obter a aba do Gemini');

        await chrome.storage.local.set({
            [`gemini_job_${geminiTab.id}`]: {
                jobId,
                batchId,
                mangaTabId,
                index,
                prompt,
                geminiTabId: geminiTab.id,
                windowId: geminiWindowId,
                executionMode,
                state: 'opening',
                attempt: 1,
                createdAt: Date.now(),
                updatedAt: Date.now()
            }
        });
        indexAddJob({ geminiTabId: geminiTab.id, jobId, batchId, mangaTabId, index });
        await syncState();
        armWatchdog(mangaTabId, index, geminiTab.id, jobId);
        processNextJob();
    } catch (e) {
        activeJobsCount = Math.max(0, activeJobsCount - 1);
        log('error', 'bg', 'JOB_ERROR', `Erro ao abrir`, { index, error: e.message });
        chrome.tabs.sendMessage(mangaTabId, { action: 'SHOW_ERROR_INTEGRATED', errorMsg: `Erro ao abrir: ${e.message}`, imgIndex: index, isDebug: false }, () => {});
        await syncState();
        processNextJob();
    }
}

function finalizeJob(geminiTabId, mangaTabId, fromError = false) {
    if (_finalizedTabs.has(geminiTabId)) {
        log('warn', 'bg', 'FINALIZE_DUPLICATE', `finalizeJob ignorado (já finalizado)`, { geminiTabId });
        return;
    }

    const jobKey = `gemini_job_${geminiTabId}`;
    const markerKey = finalizationMarkerKey(geminiTabId);
    chrome.storage.local.get([jobKey, markerKey, 'geminiExecutionMode', 'debugMode'], (stData) => {
        const jobInfo = stData[jobKey] || {};
        const finalized = stData[markerKey];
        const sameJob = !jobInfo.jobId || !finalized || finalized.jobId === jobInfo.jobId;
        if (finalized && sameJob && finalized.expiresAt > Date.now()) {
            _markFinalized(geminiTabId);
            log('warn', 'bg', 'FINALIZE_DUPLICATE', `finalizeJob ignorado (marca durável)`, { geminiTabId, jobId: finalized.jobId });
            return;
        }

        _markFinalized(geminiTabId);
        const marker = {
            jobId: jobInfo.jobId || null,
            fromError: Boolean(fromError),
            finalizedAt: Date.now(),
            expiresAt: Date.now() + FINALIZATION_MARKER_TTL_MINUTES * 60_000,
        };
        chrome.storage.local.set({ [markerKey]: marker }, () => {
            if (chrome.runtime.lastError) return;
            armFinalizationMarkerCleanup(geminiTabId);
            indexRemoveJob(geminiTabId);
        clearWatchdog(geminiTabId, jobInfo.jobId);
        if (!fromError) {
            completedJobs++;
            log('success', 'bg', 'JOB_DONE', `Processada ok`, { activeJobsCount, jobId: jobInfo.jobId });
        }
        
        activeJobsCount = Math.max(0, activeJobsCount - 1);
        const executionMode = jobInfo.executionMode || stData.geminiExecutionMode || 'temp_chat';
        chrome.storage.local.remove(jobKey, () => { syncState(); });

        if (stData.debugMode === true) {
            log('success', 'bg', 'TEST_PASS_BG_FINALIZE', `Debug: mantendo aba`, { geminiTabId });
            processNextJob();
            return;
        }

        if (executionMode === 'temp_chat') {
            // No modo Conversa Temporária, o Gemini não salva a conversa no histórico da conta.
            // Fechamos a aba do Gemini de forma limpa e rápida após 600ms, sem reloads nem 18s de espera.
            setTimeout(() => {
                chrome.tabs.remove(geminiTabId, () => {
                    if (chrome.runtime.lastError) {}
                });
                log('info', 'bg', 'TAB_CLOSED', `Aba Gemini (conversa temporária) fechada limpa`, { geminiTabId });
            }, 600);
            processNextJob();
            return;
        }

        // Modo Janela Minimizada (ou exclusão via menu)
        chrome.tabs.get(geminiTabId, (tab) => {
            if (chrome.runtime.lastError || !tab || !tab.url || (!tab.url.includes('/app/') && !tab.url.includes('gemini.google.com'))) {
                if (tab && tab.windowId && executionMode === 'minimized_window') {
                    chrome.windows.remove(tab.windowId, () => {
                        if (chrome.runtime.lastError) {
                            chrome.tabs.remove(geminiTabId, () => { if (chrome.runtime.lastError) {} });
                        }
                    });
                } else {
                    chrome.tabs.remove(geminiTabId, () => { if (chrome.runtime.lastError) {} });
                }
                processNextJob();
                return;
            }

            const activeUrl = tab.url;
            chrome.storage.local.get(['deleting_urls'], (st) => {
                const pendingDels = st.deleting_urls || [];
                if (!pendingDels.includes(activeUrl)) pendingDels.push(activeUrl);
                
                chrome.storage.local.set({ deleting_urls: pendingDels }, () => {
                    log('info', 'bg', 'CLEANUP_START', `Limpando url ${activeUrl}...`);
                    processNextJob();
                    deleteGeminiConversation(geminiTabId); 
                    
                    // FIX A-2
                    const cleanupTimer = setTimeout(() => {
                        chrome.storage.local.get(['deleting_urls'], (st2) => {
                            const newDels = (st2.deleting_urls || []).filter(u => u !== activeUrl);
                            chrome.storage.local.set({ deleting_urls: newDels });
                        });
                        if (tab && tab.windowId) {
                            chrome.windows.remove(tab.windowId, () => {
                                if (chrome.runtime.lastError) {
                                    chrome.tabs.remove(geminiTabId, () => { if (chrome.runtime.lastError) {} });
                                }
                            });
                        } else {
                            chrome.tabs.remove(geminiTabId, () => { if (chrome.runtime.lastError) {} });
                        }
                        log('info', 'bg', 'TAB_CLOSED', `Aba/Janela Gemini fechada após deleção`, { geminiTabId });
                    }, 18_000);
                    if (cleanupTimer && typeof cleanupTimer.unref === 'function') cleanupTimer.unref();
                });
            });
        });
        });
    });
}

function waitForDownload(id, onComplete, onError) {
    let safetyTimer;
    function handler(delta) {
        if (delta.id !== id) return;
        if (delta.state?.current === 'complete') {
            clearTimeout(safetyTimer);
            chrome.downloads.onChanged.removeListener(handler);
            onComplete(id);
        } else if (delta.state?.current === 'interrupted') {
            clearTimeout(safetyTimer);
            chrome.downloads.onChanged.removeListener(handler);
            if (onError) onError(new Error(`Download ${id} interrupted`));
        }
    }
    chrome.downloads.onChanged.addListener(handler);
    safetyTimer = setTimeout(() => {
        chrome.downloads.onChanged.removeListener(handler);
        if (onError) onError(new Error(`Temp timeout (10min)`));
    }, 600_000);
}

function downloadImagesAndShow(images, safeTitle, chapId) {
    const indices = Object.keys(images).map(Number).sort((a, b) => a - b);
    let completed = 0;
    let lastCompletedId = null;
    const pathsUpdate = {};

    return new Promise((resolve) => {
        if (indices.length === 0) return resolve(true);

        indices.forEach((idx) => {
            const fname = `MangaTranslator/${safeTitle}/pagina_${String(idx).padStart(3, '0')}.png`;
            chrome.downloads.download({ url: images[idx], filename: fname, saveAs: false }, (id) => {
                if (chrome.runtime.lastError || id === undefined) { 
                    completed++; if (completed === indices.length) finalize();
                    return; 
                }
                waitForDownload(id, 
                    (doneId) => {
                        chrome.downloads.search({ id: doneId }, (results) => {
                            if (results?.[0]) pathsUpdate[idx] = results[0].filename;
                            lastCompletedId = doneId;
                            completed++;
                            if (completed === indices.length) finalize();
                        });
                    },
                    (err) => {
                        log('error', 'bg', 'DOWNLOAD_INTERRUPTED', 'Download interrompido', { fname });
                        completed++;
                        if (completed === indices.length) finalize();
                    }
                );
            });
        });

        function finalize() {
            chrome.storage.local.get([`${chapId}_paths`], (d) => {
                if (Object.keys(pathsUpdate).length > 0) {
                    const toSet = {
                        [`${chapId}_paths`]: { ...(d[`${chapId}_paths`] || {}), ...pathsUpdate },
                        mangaTranslatorLastPath: pathsUpdate[indices[indices.length - 1]] || null
                    };
                    if (lastCompletedId) toSet[`${chapId}_dlId`] = lastCompletedId;
                    chrome.storage.local.set(toSet);
                }
                if (lastCompletedId) chrome.downloads.show(lastCompletedId);
                resolve(true);
            });
        }
    });
}

function handleMarkerAndShow(safeTitle, sendResponse) {
    const query = safeTitle ? `MangaTranslator(?:\\\\|/)${safeTitle}` : 'MangaTranslator';
    
    chrome.downloads.search({ filenameRegex: query }, (results) => {
        if (results && results.length > 0) {
            const valid = results.find(r => r.exists && r.state === 'complete');
            if (valid) {
                chrome.downloads.show(valid.id);
                log('success', 'bg', 'FOLDER_OPEN_OK', 'Pasta nativa', { safeTitle });
                if(sendResponse) sendResponse({ ok: true });
                return;
            }
        }
        
        const MARKER = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVQI12NgAAIABQAABjE+ibYAAAAASUVORK5CYII=';
        const markerPath = safeTitle ? `MangaTranslator/${safeTitle}/_anchor.png` : 'MangaTranslator/_anchor.png';

        chrome.downloads.download({ url: MARKER, filename: markerPath, saveAs: false, conflictAction: 'overwrite' }, (id) => {
            if (chrome.runtime.lastError || id === undefined) {
                if(sendResponse) sendResponse({ ok: false, error: 'Falha.' });
                return;
            }
            waitForDownload(id, 
                (doneId) => {
                    chrome.downloads.show(doneId);
                    setTimeout(() => { chrome.downloads.removeFile(doneId, () => { chrome.downloads.erase({ id: doneId }); }); }, 4000);
                    log('success', 'bg', 'FOLDER_OPEN_OK', 'Marcador aberto', { safeTitle });
                    if(sendResponse) sendResponse({ ok: true });
                },
                (err) => { if(sendResponse) sendResponse({ ok: false, error: 'Interrompido' }); }
            );
        });
    });
}

async function startBatch(request, sender) {
    await ensureInitialized();
    const batchId = request.batchId || generateId();
    currentBatchId = batchId;
    stopRequested = false;
    jobQueue = [];
    completedJobs = 0;
    activeJobsCount = jobIndex.length;
    totalJobs = request.images.length;
    activeMangaTabId = sender && sender.tab ? sender.tab.id : request.mangaTabId;
    isProcessing = true;

    request.images.forEach(img => {
        jobQueue.push({ mangaTabId: activeMangaTabId, index: img.index, prompt: request.prompt, batchId });
    });
    log('info', 'bg', 'BATCH_START', `Iniciando ${totalJobs} imagens (batch: ${batchId.slice(0, 8)})`);
    await Promise.all([_refreshMaxCon(), syncState()]);
    processNextJob();
    return { batchId };
}

async function stopBatch(request) {
    await ensureInitialized();
    const targetBatchId = request.batchId || currentBatchId;
    const stopsCurrentBatch = !targetBatchId || targetBatchId === currentBatchId;
    jobQueue = jobQueue.filter(job => targetBatchId && job.batchId !== targetBatchId);
    if (stopsCurrentBatch) {
        stopRequested = true;
        isProcessing = false;
        activeMangaTabId = null;
        currentBatchId = null;
    }
    log('warn', 'bg', 'BATCH_STOP', `Batch parado (batch: ${(targetBatchId || '').slice(0, 8)})`);

    let entries = indexJobsOfBatch(targetBatchId);
    if (entries.length === 0) {
        const allStorage = await chrome.storage.local.get(null);
        entries = Object.keys(allStorage)
            .filter(key => key.startsWith('gemini_job_'))
            .map(key => allStorage[key])
            .filter(job => job && (!targetBatchId || job.batchId === targetBatchId));
    }

    const keysToRemove = [];
    entries.forEach(entry => {
        if (!entry) return;
        if (entry.geminiTabId || entry.geminiTabId === 0) {
            chrome.tabs.remove(entry.geminiTabId, () => { if (chrome.runtime.lastError) {} });
            keysToRemove.push(`gemini_job_${entry.geminiTabId}`, `wd_data_${entry.geminiTabId}`);
        }
        const alarmName = entry.jobId ? `watchdog_${entry.jobId}` : `watchdog_${entry.geminiTabId}`;
        chrome.alarms.clear(alarmName, () => {});
        indexRemoveJob(entry.geminiTabId);
    });
    if (keysToRemove.length > 0) await chrome.storage.local.remove(keysToRemove);

    Object.keys(extractionTabs).map(Number).forEach(tabId => {
        const info = extractionTabs[tabId];
        if (targetBatchId && info && info.batchId && info.batchId !== targetBatchId) return;
        chrome.tabs.remove(tabId, () => { if (chrome.runtime.lastError) {} });
        delete extractionTabs[tabId];
    });

    activeJobsCount = jobIndex.length;
    releaseGeminiScriptsIfIdle();
    await syncState();
    if (!stopsCurrentBatch && isProcessing) processNextJob();
    return {};
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {

    const routedAction = routeRegisteredAction(request, sender, sendResponse);
    if (routedAction && routedAction.handled) {
        return routedAction.keepAlive;
    }

    if (handleGtcRuntimeMessage(request, sender, sendResponse)) {
        return true;
    }

    if (handleStorageManagerMessage(request, sender, sendResponse)) {
        return true;
    }

    if (request.action === 'LOG_ENTRY') {
        log(request.level, request.source, request.action_name, request.detail, request.extra);
        sendResponse({ ok: true }); return false;
    }

    if (request.action === 'FORCE_SEND_ACTIVATION') {
        const { geminiTabId, mangaTabId, windowId, executionMode } = request;
        chrome.storage.local.get(['geminiExecutionMode'], (st) => {
            const mode = executionMode || st.geminiExecutionMode || 'temp_chat';
            if (mode === 'minimized_window' && windowId) {
                chrome.windows.update(windowId, { focused: true }, () => {
                    chrome.tabs.sendMessage(geminiTabId, { action: 'DO_SEND_NOW' }, () => { if (chrome.runtime.lastError) {} });
                    setTimeout(() => {
                        chrome.windows.update(windowId, { state: 'minimized', focused: false }, () => { if (chrome.runtime.lastError) {} });
                        if (mangaTabId) {
                            chrome.tabs.get(mangaTabId, (mt) => {
                                if (mt && mt.windowId) chrome.windows.update(mt.windowId, { focused: true }, () => { if (chrome.runtime.lastError) {} });
                            });
                        }
                    }, 250);
                });
            } else if (geminiTabId) {
                chrome.tabs.update(geminiTabId, { active: true }, () => {
                    chrome.tabs.sendMessage(geminiTabId, { action: 'DO_SEND_NOW' }, () => { if (chrome.runtime.lastError) {} });
                    setTimeout(() => {
                        if (mangaTabId) chrome.tabs.update(mangaTabId, { active: true }, () => { if (chrome.runtime.lastError) {} });
                    }, 250);
                });
            }
        });
        sendResponse({ ok: true }); return false;
    }

    if (request.action === 'GET_TAB_ID') {
        sendResponse({ tabId: sender.tab ? sender.tab.id : null }); return false;
    }

    if (request.action === 'GEMINI_PROGRESS') {
        const targetTabId = request.mangaTabId || activeMangaTabId;
        if (targetTabId) sendProgress(targetTabId, request.text);
        if (sender && sender.tab) updateJobState(sender.tab.id, { state: 'running' });
        sendResponse({ ok: true }); return false;
    }

    if (request.action === 'REQUEST_IMAGE_DATA') {
        chrome.tabs.sendMessage(request.mangaTabId, { action: 'REQUEST_IMAGE_DATA', index: request.index }, (response) => {
            if (chrome.runtime.lastError) sendResponse({ error: chrome.runtime.lastError.message });
            else sendResponse(response);
        });
        return true;
    }

    if (request.action === 'CHECK_IF_EXTRACTION_TAB') {
        const tabId = sender.tab ? sender.tab.id : -1;
        if (extractionTabs[tabId]) sendResponse({ isExtractionTab: true, ...extractionTabs[tabId] });
        else sendResponse({ isExtractionTab: false });
        return false;
    }

    if (request.action === 'FETCH_IMAGE_AS_BASE64') {
        try {
            const parsedUrl = new URL(request.url);
            if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
                sendResponse({ error: 'Protocolo inválido' });
                return false;
            }
        } catch (_e) {
            sendResponse({ error: 'URL inválida' });
            return false;
        }
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 30000); // 30s timeout
        fetch(request.url, { signal: controller.signal })
            .then(r => {
                if (!r.ok) throw new Error(`HTTP ${r.status}`);
                const ct = r.headers.get('content-type') || '';
                if (!ct.startsWith('image/')) throw new Error(`Content-Type inválido: ${ct}`);
                return r.blob();
            })
            .then(blob => {
                clearTimeout(timeout);
                if (blob.size > 50 * 1024 * 1024) throw new Error('Imagem muito grande (>50MB)');
                const reader = new FileReader();
                reader.onloadend = () => sendResponse({ dataUrl: reader.result });
                reader.readAsDataURL(blob);
            })
            .catch(e => {
                clearTimeout(timeout);
                sendResponse({ error: e.message });
            });
        return true;
    }

    // ── CALCULATE_VISUAL_FINGERPRINT (visual-v3) ─────────────────────────────
    //
    // Calcula todos os hashes visuais para imagens CORS-blocked no content script.
    // O SW consegue fazer fetch cross-origin (host_permissions: <all_urls>).
    //
    // Hashes calculados via OffscreenCanvas no Service Worker:
    //   pixelSample  (8×8)   → SHA-256 visual (visual-v1/v2, backward-compat)
    //   dHash        (9×8)   → dHash 16-hex 64-bit (visual-v2)
    //   wHash        (32×32) → Haar Wavelet 64-hex 256-bit (visual-v3, NOVO)
    //   pHash        (32×32) → DCT Perceptual 64-hex 256-bit (visual-v3, NOVO)
    //   wHashCrop/pHashCrop (center-crop 32×32) → fallback visual-v4
    //   regionalHashes (48×48) → wHash dos 4 cantos 16-hex 64-bit (visual-v3)
    //
    // Por que o SW calcula os hashes em vez do content script:
    //   - SW tem <all_urls> → fetch() não tem bloqueio CORS
    //   - OffscreenCanvas está disponível em Workers (Chrome 69+)
    //   - createImageBitmap disponível no SW (Chrome 59+)
    //   - content script não pode drawImage em imagens cross-origin → tainted canvas
    //
    // Custo computacional no SW (não bloqueia o content script):
    //   - wHash: Haar DWT 2D 32×32 + sort 256 elementos → ~1ms
    //   - pHash: DCT-II separável 32×32 (tabela pré-computada) → ~0.5ms
    //   - regionalHashes: 4× Haar DWT 2D 16×16 → ~0.4ms
    //   - Total: ~2ms por imagem
    // ─────────────────────────────────────────────────────────────────────────
    if (request.action === 'CALCULATE_VISUAL_FINGERPRINT') {
        (async () => {
            try {
                const { url } = request;
                if (!url || url.startsWith('data:') || url.startsWith('blob:')) {
                    sendResponse({ ok: false, error: 'URL inválida para fingerprint visual' });
                    return;
                }

                // Fetch via SW (bypassa CORS — extensão tem <all_urls>)
                const resp = await fetch(url, { credentials: 'omit', cache: 'no-store' });
                if (!resp.ok) throw new Error(`HTTP ${resp.status} ao buscar imagem`);
                const blob = await resp.blob();

                // createImageBitmap disponível no SW (Chrome 59+)
                const bitmap = await createImageBitmap(blob);

                const fpApi = (typeof self !== 'undefined' && self.MangaTranslatorGtcFingerprint)
                           || null;

                // ── Canvas 8×8 → pixel sample para SHA-256 ───────────────────
                const oc8  = new OffscreenCanvas(8, 8);
                const ctx8 = oc8.getContext('2d');
                ctx8.drawImage(bitmap, 0, 0, 8, 8);
                const id8  = ctx8.getImageData(0, 0, 8, 8);
                const pixelSample = Array.from(id8.data)
                    .map(b => b.toString(16).padStart(2, '0'))
                    .join('');

                // ── Canvas 9×8 → dHash (visual-v2) ───────────────────────────
                let dHash = null;
                if (fpApi && typeof fpApi.calculateDHash === 'function') {
                    const oc9  = new OffscreenCanvas(9, 8);
                    const ctx9 = oc9.getContext('2d');
                    ctx9.drawImage(bitmap, 0, 0, 9, 8);
                    const id9 = ctx9.getImageData(0, 0, 9, 8);
                    dHash = fpApi.calculateDHash(id9.data);
                }

                // ── Canvas 32×32 → wHash + pHash (visual-v3, NOVO) ───────────
                // Um único canvas 32×32 alimenta tanto wHash quanto pHash.
                // Isso economiza um drawImage vs usar dois canvas separados.
                let wHash = null;
                let pHash = null;
                let wHashCrop = null;
                let pHashCrop = null;
                if (fpApi && (typeof fpApi.calculateWHash === 'function' || typeof fpApi.calculatePHash === 'function')) {
                    const oc32  = new OffscreenCanvas(32, 32);
                    const ctx32 = oc32.getContext('2d');
                    ctx32.drawImage(bitmap, 0, 0, 32, 32);
                    const id32 = ctx32.getImageData(0, 0, 32, 32);

                    if (typeof fpApi.calculateWHash === 'function') {
                        wHash = fpApi.calculateWHash(id32.data);
                    }
                    if (typeof fpApi.calculatePHash === 'function') {
                        pHash = fpApi.calculatePHash(id32.data);
                    }

                    const W = bitmap.width || 0;
                    const H = bitmap.height || 0;
                    const side = Math.min(W, H);
                    if (side > 0 && W !== H) {
                        const cropX = Math.floor((W - side) / 2);
                        const cropY = Math.floor((H - side) / 2);
                        const ocCrop = new OffscreenCanvas(32, 32);
                        const ctxCrop = ocCrop.getContext('2d');
                        ctxCrop.drawImage(bitmap, cropX, cropY, side, side, 0, 0, 32, 32);
                        const idCrop = ctxCrop.getImageData(0, 0, 32, 32);
                        if (typeof fpApi.calculateWHash === 'function') {
                            wHashCrop = fpApi.calculateWHash(idCrop.data);
                        }
                        if (typeof fpApi.calculatePHash === 'function') {
                            pHashCrop = fpApi.calculatePHash(idCrop.data);
                        }
                    }
                }

                // ── Canvas 48×48 → regionalHashes dos 4 cantos (visual-v3, NOVO) ──
                // Divide em grid 3×3 de regiões 16×16; usa apenas os 4 cantos.
                // Aproximação do RANSAC em JS puro: texto raramente aparece nos cantos.
                let regionalHashes = null;
                if (fpApi && typeof fpApi.calculateRegionalHashes === 'function') {
                    const oc48  = new OffscreenCanvas(48, 48);
                    const ctx48 = oc48.getContext('2d');
                    ctx48.drawImage(bitmap, 0, 0, 48, 48);
                    const id48 = ctx48.getImageData(0, 0, 48, 48);
                    regionalHashes = fpApi.calculateRegionalHashes(id48.data);
                }

                bitmap.close();

                log('info', 'bg', 'VISUAL_FP_OK', `Fingerprint visual-v3 calculado via SW`, {
                    url:              url.slice(0, 80),
                    hasDHash:         dHash         !== null,
                    hasWHash:         wHash         !== null,
                    hasPHash:         pHash         !== null,
                    hasCrop:          wHashCrop !== null || pHashCrop !== null,
                    hasRegional:      regionalHashes !== null,
                });

                sendResponse({
                    ok: true,
                    pixelSample,
                    dHash,
                    wHash,
                    pHash,
                    wHashCrop,
                    pHashCrop,
                    regionalHashes,
                });
            } catch (e) {
                log('warn', 'bg', 'VISUAL_FP_FAIL', `Falha no fingerprint visual-v3 via SW: ${e.message}`, {
                    url: (request.url || '').slice(0, 80),
                });
                sendResponse({ ok: false, error: e.message });
            }
        })();
        return true;
    }

    if (request.action === 'DOWNLOAD_IMAGE') {
        const filename = request.filename.startsWith('MangaTranslator/') ? request.filename : `MangaTranslator/${request.filename}`;
        chrome.downloads.download({ url: request.url, filename, saveAs: false }, (id) => {
            if (chrome.runtime.lastError || id === undefined) { sendResponse({ error: chrome.runtime.lastError?.message || 'Falha no download' }); return; }
            waitForDownload(id, 
                (doneId) => {
                    chrome.downloads.search({ id: doneId }, (results) => {
                        if (results?.[0]) sendResponse({ filePath: results[0].filename, downloadId: doneId });
                        else sendResponse({ error: 'Arquivo não encontrado' });
                    });
                },
                (err) => sendResponse({ error: err.message })
            );
        });
        return true;
    }

    if (request.action === 'SHOW_EXISTING_FOLDER') {
        const { folderPath, safeTitle, anchorId } = request;
        if (anchorId) {
            chrome.downloads.search({ id: anchorId }, (res) => {
                if (res && res.length > 0 && res[0].exists) {
                    chrome.downloads.show(anchorId);
                    sendResponse({ ok: true });
                } else fallbackSearch(folderPath, safeTitle, sendResponse);
            });
        } else fallbackSearch(folderPath, safeTitle, sendResponse);

        function fallbackSearch(fPath, sTitle, sendResp) {
            const escapedPath = fPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            chrome.downloads.search({ filenameRegex: escapedPath }, (results) => {
                if (results && results.length > 0) {
                    chrome.downloads.show(results[0].id);
                    sendResp({ ok: true });
                } else handleMarkerAndShow(sTitle, sendResp);
            });
        }
        return true;
    }

    if (request.action === 'OPEN_CHAPTER_FOLDER' || request.action === 'DOWNLOAD_CHAPTER_AND_SHOW') {
        if (request.anchorId) {
            chrome.downloads.search({ id: request.anchorId }, (res) => {
                if (res && res.length > 0 && res[0].exists) { chrome.downloads.show(request.anchorId); sendResponse({ ok: true }); }
                else fallbackDownload();
            });
        } else fallbackDownload();

        function fallbackDownload() {
            if (Object.keys(request.images).length === 0) { handleMarkerAndShow(request.safeTitle, sendResponse); return; }
            downloadImagesAndShow(request.images, request.safeTitle, request.chapId).then(() => { sendResponse({ ok: true }); });
        }
        return true;
    }

    if (request.action === 'OPEN_MANGA_ROOT') {
        handleMarkerAndShow(null, sendResponse);
        return true;
    }

    if (request.action === 'EXPORT_ALL_AND_SHOW') {
        if (!request.allDownloads || request.allDownloads.length === 0) {
            sendResponse({ ok: true }); return true;
        }
        let lastCompletedId = null; let completed = 0;
        request.allDownloads.forEach(({ url, filename }) => {
            const fname = filename.startsWith('MangaTranslator/') ? filename : `MangaTranslator/${filename}`;
            chrome.downloads.download({ url, filename: fname, saveAs: false }, (id) => {
                if (chrome.runtime.lastError || id === undefined) { completed++; checkFinalize(); return; }
                waitForDownload(id, (doneId) => { lastCompletedId = doneId; completed++; checkFinalize(); }, () => { completed++; checkFinalize(); });
            });
        });
        function checkFinalize() {
            if (completed === request.allDownloads.length) {
                if (lastCompletedId) chrome.downloads.show(lastCompletedId);
                sendResponse({ ok: true });
            }
        }
        return true;
    }

    if (request.action === 'SET_DEBUG_MODE') {
        chrome.storage.local.set({ debugMode: !!request.debugOn }, () => {
            chrome.tabs.query({}, (tabs) => {
                tabs.forEach(tab => {
                    chrome.tabs.sendMessage(tab.id, { action: 'DEBUG_MODE_CHANGED', debugOn: !!request.debugOn }, () => { if (chrome.runtime.lastError) {} });
                });
            });
            sendResponse({ ok: true });
        });
        return true;
    }
});
