'use strict';

// ── Estado Global ─────────────────────────────────────────
// O estado de jobs pertence exclusivamente a background/state.js.  Não manter
// cópias locais aqui é essencial no MV3: um worker reidratado não pode escolher
// acidentalmente entre um espelho antigo e o snapshot durável.
let backgroundState = null;

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
        importScripts('background/state.js');
        importScripts('background/tab-identity.js');
        importScripts('background/jobs-watchdog.js');
        importScripts('background/jobs-reconciliation.js');
        importScripts('background/jobs-dom-ack.js');
        importScripts('background/jobs-lifecycle.js');
        importScripts('background/actions/log-entry.js');
        importScripts('background/actions/get-tab-id.js');
        importScripts('background/actions/claim-gemini-job.js');
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
    } catch (e) {
        console.error('[MangaTranslator background] Falha ao carregar módulos obrigatórios do background.', e);
        throw e;
    }
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
    } catch (e) {
        console.error('[MangaTranslator background] Falha ao carregar cache/storage obrigatórios.', e);
        throw e;
    }
} else if (typeof require === 'function') {
    try {
        require('./background/router.js');
        require('./background/state.js');
        require('./background/tab-identity.js');
        require('./background/jobs-watchdog.js');
        require('./background/jobs-reconciliation.js');
        require('./background/jobs-dom-ack.js');
        require('./background/jobs-lifecycle.js');
        require('./background/actions/log-entry.js');
        require('./background/actions/get-tab-id.js');
        require('./background/actions/claim-gemini-job.js');
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

function getBackgroundStateApi() {
    const scope = typeof self !== 'undefined' ? self : globalThis;
    return scope && scope.MangaTranslatorState;
}

function state() {
    if (!backgroundState) backgroundState = getBackgroundStateApi();
    if (!backgroundState) throw new Error('MangaTranslatorState indisponível');
    return backgroundState;
}

function getStateSnapshot() {
    return state().get();
}

function applyStateSnapshot(snapshot = {}) {
    return state().patch(snapshot);
}

async function restoreState() {
    const stateApi = state();
    if (stateApi && typeof stateApi.restoreState === 'function') {
        const restored = await stateApi.restoreState();
        if (restored) applyStateSnapshot(restored);
        return;
    }
    await stateApi.restoreState();
}

async function syncState() {
    await state().syncState();
}

// ── Manutenção do índice de jobs ─────────────────────────────────────────────
function indexAddJob(entry) {
    state().indexAddJob(entry);
}
function indexRemoveJob(geminiTabId) {
    return state().indexRemoveJob(geminiTabId);
}
function indexJobsOfBatch(batchId) {
    return state().indexJobsOfBatch(batchId);
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

let tabIdentity = null;
let jobsWatchdog = null;
let jobsReconciler = null;
let jobsDomAck = null;
let jobsLifecycle = null;

function moveFinalizedTabId(oldTabId, newTabId) {
    if (_finalizedTabs.has(oldTabId)) {
        _finalizedTabs.delete(oldTabId);
        _finalizedTabs.add(newTabId);
    }
}

function initializeTabIdentity() {
    if (tabIdentity) return tabIdentity;
    const scope = typeof self !== 'undefined' ? self : globalThis;
    if (!scope.MangaTranslatorTabIdentity) throw new Error('MangaTranslatorTabIdentity indisponível');
    tabIdentity = scope.MangaTranslatorTabIdentity.createTabIdentity({
        state: state(),
        log,
        moveFinalizedTabId,
    });
    return tabIdentity;
}

function initializeJobsModules() {
    if (jobsWatchdog && jobsReconciler && jobsDomAck && jobsLifecycle) return;
    const scope = typeof self !== 'undefined' ? self : globalThis;
    const identity = initializeTabIdentity();
    jobsWatchdog = scope.MangaTranslatorJobsWatchdog.createWatchdog({
        getJobIndex: () => state().jobIndex,
        getExtractionTabs: () => state().extractionTabs,
        finalizeJob: (...args) => finalizeJob(...args),
        log,
        timeoutMinutes: JOB_TIMEOUT_MINUTES,
        resolveCanonicalTabId: tabId => identity.resolveCanonicalTabId(tabId),
    });
    jobsReconciler = scope.MangaTranslatorJobsReconciliation.createReconciler({
        state: state(),
        tabExists,
        log,
        resolveCanonicalTabId: tabId => identity.resolveCanonicalTabId(tabId),
        migrateTabIdentity: (oldTabId, newTabId, options) => identity.migrateTabIdentity(oldTabId, newTabId, options),
        syncState,
        processNextJob: () => processNextJob(),
        recoverPendingFinalization: entry => jobsLifecycle.recoverPendingFinalization(entry),
    });
    jobsDomAck = scope.MangaTranslatorJobsDomAck.createDomAckDelivery({
        updateJobState: (...args) => updateJobState(...args),
        finalizeJob: (...args) => finalizeJob(...args),
        log,
        timeoutMs: DOM_ACK_TIMEOUT_MS,
    });
    jobsLifecycle = scope.MangaTranslatorJobsLifecycle.createLifecycle({
        state: state(),
        log, syncState, sendProgress, armWatchdog, clearWatchdog,
        indexAddJob, indexRemoveJob, indexJobsOfBatch, delay, generateId,
        markFinalized: _markFinalized,
        isFinalized: tabId => _finalizedTabs.has(tabId),
        finalizedMarkerTtlMinutes: FINALIZATION_MARKER_TTL_MINUTES,
        resolveCanonicalTabId: tabId => identity.resolveCanonicalTabId(tabId),
        migrateTabIdentity: (oldTabId, newTabId, options) => identity.migrateTabIdentity(oldTabId, newTabId, options),
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
    initializeJobsModules();
    return jobsReconciler.reconcile();
}

async function ensureInitialized() {
    if (state()._initialized) return;
    // Um alarme pode disparar enquanto este worker já detém um lote vivo. Não
    // sobrescreva essa fila/extractionTabs com um snapshot antigo ou vazio.
    const hasResidentWork = state().jobQueue.length > 0 || state().activeJobsCount > 0 ||
        state().jobIndex.length > 0 || Object.keys(state().extractionTabs).length > 0;
    if (!hasResidentWork) await restoreState();

    // A reconciliação é canonical-aware e por isso é o gate síncrono
    // necessário para mensagens. O replay de journals residuais não bloqueia
    // ações normais; ele roda logo depois e continua crash-recoverable.
    const identity = initializeTabIdentity();
    state()._initialized = true;
    try {
        const result = await reconcileJobs();
        if (result.dropped > 0 || result.alive > 0 || result.recovered > 0) {
            await syncState();
            if (result.dropped > 0 || result.recovered > 0) processNextJob();
        }
    } catch (_e) {}

    identity.recoverPendingMigrations()
        .then(() => identity.cleanupExpiredAliases())
        .catch(error => log('warn', 'bg', 'TAB_REKEY_RECOVERY_DEFERRED_ERROR',
            'Falha no replay assíncrono de migração de aba', {
                errorName: error && error.name ? error.name : 'Error',
            }));
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
                state: state(),
                log,
                handleMarkerAndShow,
                waitForDownload,
                downloadImagesAndShow,
                syncState,
                assertJobOwnership,
                ensureInitialized,
                tabIdentity: initializeTabIdentity(),
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
    initializeJobsModules();
    return jobsWatchdog.arm(mangaTabId, index, geminiTabId, jobId);
}
function clearWatchdog(geminiTabId, jobId) {
    initializeJobsModules();
    return jobsWatchdog.clear(geminiTabId, jobId);
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
    initializeJobsModules();
    return jobsDomAck.deliver({ mangaTabId, index, src, jobId, batchId, geminiTabId });
}

// SEC-05: Constante nomeada para prompt padrão em vez de string longa inline
const DEFAULT_TRANSLATION_PROMPT = "Objetivo primário: voce vai criar uma imagem , exata da imagem fornecida e traduzir ela pro português brasileiro . \nNão altere nenhum pixel fora das áreas de texto e Remova o texto original dos balões de fala, preenchendo o fundo com a cor correspondente. \nConverta os diálogos para PT-BR, mantendo a informalidade do contexto. Tipografia: Renderize o novo texto em caixa alta, fonte padrão de HQ (sans-serif), alinhamento centralizado.\nEfeitos Sonoros: Traduza e recrie as onomatopeias  mantendo as fontes estilizadas, cores, contornos e inclinação originais. lembre-se que todas as palavras devem sem traduzidas sem exceção";

chrome.runtime.onInstalled.addListener(() => {
    chrome.storage.local.get(['defaultPrompt'], (data) => {
        if (!data.defaultPrompt) {
            chrome.storage.local.set({ defaultPrompt: DEFAULT_TRANSLATION_PROMPT });
        }
    });
});

chrome.runtime.onStartup.addListener(async () => {
    await restoreState();
    const identity = initializeTabIdentity();
    await identity.recoverPendingMigrations();
    await identity.cleanupExpiredAliases();
    state()._initialized = true;
    
    // FIX M-5
    state().extractionTabs = {};

    const hadWork = state().jobQueue.length > 0 || state().activeJobsCount > 0 || state().jobIndex.length > 0;

    // Em onStartup o navegador foi reiniciado: nenhuma aba do Gemini sobrevive,
    // então a reconciliação sempre descarta os jobs órfãos e libera os slots.
    const reconciled = await reconcileJobs();

    if (hadWork) {
        log('warn', 'bg', 'STARTUP_RECOVERY', `Service worker reiniciado: ${state().jobQueue.length} jobs na fila, ${reconciled.alive} ativos preservados, ${reconciled.dropped} órfãos descartados, ${reconciled.recovered || 0} finalizações reconciliadas`, {
            jobQueue: state().jobQueue.length,
            alive: reconciled.alive,
            dropped: reconciled.dropped,
            recovered: reconciled.recovered || 0,
        });
        state().isProcessing = state().jobQueue.length > 0;
        await syncState();
        processNextJob();
    } else {
        await syncState();
    }
});

chrome.runtime.onConnect.addListener(port => {
    if (port.name === 'gemini-keep-alive') port.onDisconnect.addListener(() => {});
});

// Diagnóstico de identidade de aba. PR 0 apenas observa a transição; a
// canonicalização/rekey durável é implementada no PR 1.
if (chrome.tabs && chrome.tabs.onReplaced) {
    chrome.tabs.onReplaced.addListener((addedTabId, removedTabId) => {
        log('info', 'bg', 'TAB_REPLACED', 'Aba substituída pelo Chromium', {
            oldTabId: removedTabId,
            newTabId: addedTabId,
        });
        try {
            initializeTabIdentity().recordReplacement(addedTabId, removedTabId)
                .catch(error => log('error', 'bg', 'TAB_REKEY_ERROR', 'Falha ao migrar identidade de aba', {
                    oldTabId: removedTabId,
                    newTabId: addedTabId,
                    errorName: error && error.name ? error.name : 'Error',
                }));
        } catch (error) {
            log('error', 'bg', 'TAB_REKEY_ERROR', 'Falha ao iniciar migração de identidade de aba', {
                oldTabId: removedTabId,
                newTabId: addedTabId,
                errorName: error && error.name ? error.name : 'Error',
            });
        }
    });
}

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

    initializeJobsModules();
    if (jobsWatchdog.handleAlarm(alarm)) return;

    if (alarm.name.startsWith('watchdog_')) {
        // O nome do alarme agora pode ser watchdog_${jobId} (UUID) ou watchdog_${tabId} (legado)
        // Buscar wd_data pelo sufixo — pode ser jobId ou tabId
        const suffix = alarm.name.replace('watchdog_', '');

        // O alarme pode se chamar watchdog_<jobId> (UUID) ou watchdog_<tabId> (legado).
        // O índice durável resolve jobId → geminiTabId sem precisar de get(null),
        // que carregaria todas as imagens Base64 do acervo na memória do worker.
        const indexed = state().jobIndex.find(j => j && (String(j.jobId) === suffix || String(j.geminiTabId) === suffix));
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
            const orphanIds = Object.keys(state().extractionTabs).filter(tabId => state().extractionTabs[tabId] && state().extractionTabs[tabId].geminiTabId === geminiTabId);
            orphanIds.forEach(tabId => {
                const numId = Number(tabId);
                chrome.tabs.remove(numId, () => { if (chrome.runtime.lastError) {} });
                delete state().extractionTabs[numId];
            });
        });
    }
});

function sendProgress(mangaTabId, text) {
    if (!mangaTabId) return;
    chrome.tabs.sendMessage(mangaTabId, { action: 'PROGRESS', text }, () => { if (chrome.runtime.lastError) {} });
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
    const runtimeState = state();
    runtimeState.currentBatchId = batchId;
    runtimeState.stopRequested = false;
    runtimeState.jobQueue = [];
    runtimeState.completedJobs = 0;
    runtimeState.activeJobsCount = runtimeState.jobIndex.length;
    runtimeState.totalJobs = request.images.length;
    runtimeState.activeMangaTabId = sender && sender.tab ? sender.tab.id : request.mangaTabId;
    runtimeState.isProcessing = true;

    request.images.forEach(img => {
        runtimeState.jobQueue.push({ mangaTabId: runtimeState.activeMangaTabId, index: img.index, prompt: request.prompt, batchId });
    });
    log('info', 'bg', 'BATCH_START', `Iniciando ${runtimeState.totalJobs} imagens (batch: ${batchId.slice(0, 8)})`);
    await Promise.all([_refreshMaxCon(), syncState()]);
    processNextJob();
    return { batchId };
}

async function stopBatch(request) {
    await ensureInitialized();
    const runtimeState = state();
    const targetBatchId = request.batchId || runtimeState.currentBatchId;
    const stopsCurrentBatch = !targetBatchId || targetBatchId === runtimeState.currentBatchId;
    runtimeState.jobQueue = runtimeState.jobQueue.filter(job => targetBatchId && job.batchId !== targetBatchId);
    if (stopsCurrentBatch) {
        runtimeState.stopRequested = true;
        runtimeState.isProcessing = false;
        runtimeState.activeMangaTabId = null;
        runtimeState.currentBatchId = null;
    }
    log('warn', 'bg', 'BATCH_STOP', `Batch parado (batch: ${(targetBatchId || '').slice(0, 8)})`);

    // O jobIndex é a fonte de verdade: o único ponto que cria um registro
    // `gemini_job_*` (jobs-lifecycle.js) sempre chama indexAddJob() em seguida,
    // e reconcileJobs() já reconstrói a contabilidade após reinício do worker
    // usando exclusivamente o jobIndex persistido (sem varredura). Por isso o
    // fallback de storage.get(null) foi removido — ver P3 do plano de
    // refatoração (índice comprovadamente confiável).
    let entries = indexJobsOfBatch(targetBatchId);

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

    Object.keys(runtimeState.extractionTabs).map(Number).forEach(tabId => {
        const info = runtimeState.extractionTabs[tabId];
        if (targetBatchId && info && info.batchId && info.batchId !== targetBatchId) return;
        chrome.tabs.remove(tabId, () => { if (chrome.runtime.lastError) {} });
        delete runtimeState.extractionTabs[tabId];
    });

    runtimeState.activeJobsCount = runtimeState.jobIndex.length;
    await syncState();
    if (!stopsCurrentBatch && runtimeState.isProcessing) processNextJob();
    return {};
}

// Fachadas compatíveis: ações e testes existentes continuam chamando os nomes
// históricos, mas a implementação canônica agora vive em jobs-lifecycle.js.
// A remoção física dos corpos antigos fica segura porque estas referências são
// também o contrato temporário dos módulos já extraídos.
const updateJobState = (...args) => {
    initializeJobsModules();
    return jobsLifecycle.updateJobState(...args);
};
const assertJobOwnership = (sender, jobId, callback) => {
    initializeJobsModules();
    jobsLifecycle.assertJobOwnership(sender, jobId)
        .then(({ owns, tabId }) => callback(owns, tabId))
        .catch(() => callback(false, sender && sender.tab ? sender.tab.id : null));
};
const processNextJob = (...args) => {
    initializeJobsModules();
    return jobsLifecycle.processNextJob(...args);
};
const finalizeJob = (...args) => {
    initializeJobsModules();
    return jobsLifecycle.finalizeJob(...args);
};
const _refreshMaxCon = (...args) => {
    initializeJobsModules();
    return jobsLifecycle.refreshMaxConcurrency(...args);
};

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {

    if (request && request.action === 'GET_TAB_ID') {
        log('info', 'bg', 'TAB_ID_OBSERVED', 'tabId observado em GET_TAB_ID', {
            tabId: sender && sender.tab ? sender.tab.id : null,
        });
    }

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

});
