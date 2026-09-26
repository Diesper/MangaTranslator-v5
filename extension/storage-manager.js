// storage-manager.js — Manga Translator
//
// Camada de persistência de páginas traduzidas. Roda EXCLUSIVAMENTE no
// Service Worker (background.js) e nas páginas da extensão — nunca como
// content script.
//
// POR QUE ISSO IMPORTA:
//   Content scripts compartilham a origem da PÁGINA, não da extensão. Se este
//   módulo fosse injetado numa página de mangá, o banco `manga_translator_data`
//   seria criado por site e ficaria invisível para popup, leitor e background —
//   um bug de perda de dados pior que o original. O background e as páginas da
//   extensão compartilham a origem chrome-extension://<id>, que é a única
//   origem onde este banco faz sentido.
//
// O QUE ESTE MÓDULO RESOLVE:
//   1. Perda por read-modify-write: cada página é um REGISTRO próprio
//      (chave [chapterId, pageIndex]); gravar a página 7 nunca toca a página 3.
//   2. Múltiplas cópias Base64: um único Blob por resultado, em `assets`,
//      referenciado por assetId em `chapterPages` e `restoreEntries`.
//   3. Deleção incompleta: deleteChapter remove páginas, restores e assets.
//   4. Memória do leitor/popup: dá para listar metadados sem carregar blob algum.
//
// O `chapterList` continua em chrome.storage.local — é metadado pequeno,
// consultado por vários contextos; movê-lo não traria ganho.

'use strict';

(function attachStorageManager(rootScope) {

const SM_DB_NAME = 'manga_translator_data';
const SM_DB_VERSION = 1;

const SM_STORE_CHAPTERS      = 'chapters';
const SM_STORE_CHAPTER_PAGES = 'chapterPages';
const SM_STORE_RESTORE       = 'restoreEntries';
const SM_STORE_ASSETS        = 'assets';

// ── Abertura do banco ────────────────────────────────────────────────────────
let _smDbPromise = null;

function getIndexedDb() {
    if (rootScope && rootScope.indexedDB) return rootScope.indexedDB;
    return (typeof indexedDB !== 'undefined') ? indexedDB : null;
}

function openStorageDb() {
    if (_smDbPromise) return _smDbPromise;
    _smDbPromise = new Promise((resolve, reject) => {
        const idb = getIndexedDb();
        if (!idb || typeof idb.open !== 'function') {
            reject(new Error('IndexedDB indisponível neste contexto'));
            return;
        }
        const req = idb.open(SM_DB_NAME, SM_DB_VERSION);
        req.onupgradeneeded = (event) => {
            const db = event.target.result;

            if (!db.objectStoreNames.contains(SM_STORE_CHAPTERS)) {
                db.createObjectStore(SM_STORE_CHAPTERS, { keyPath: 'chapterId' });
            }
            if (!db.objectStoreNames.contains(SM_STORE_CHAPTER_PAGES)) {
                const pages = db.createObjectStore(SM_STORE_CHAPTER_PAGES, { keyPath: ['chapterId', 'pageIndex'] });
                pages.createIndex('by_chapter', 'chapterId', { unique: false });
            }
            if (!db.objectStoreNames.contains(SM_STORE_RESTORE)) {
                const restore = db.createObjectStore(SM_STORE_RESTORE, { keyPath: ['chapterId', 'cleanUrl'] });
                restore.createIndex('by_chapter',  'chapterId', { unique: false });
                restore.createIndex('by_cleanUrl', 'cleanUrl',  { unique: false });
            }
            if (!db.objectStoreNames.contains(SM_STORE_ASSETS)) {
                db.createObjectStore(SM_STORE_ASSETS, { keyPath: 'assetId' });
            }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => { _smDbPromise = null; reject(req.error || new Error('Falha ao abrir IndexedDB')); };
    });
    return _smDbPromise;
}

// ── Helpers IDB ──────────────────────────────────────────────────────────────
function _idbGet(store, key) {
    return new Promise((resolve, reject) => {
        const req = store.get(key);
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => reject(req.error);
    });
}
function _idbGetAll(storeOrIndex, query) {
    return new Promise((resolve, reject) => {
        const req = query ? storeOrIndex.getAll(query) : storeOrIndex.getAll();
        req.onsuccess = () => resolve(req.result || []);
        req.onerror = () => reject(req.error);
    });
}
function _idbTxComplete(tx) {
    return new Promise((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error || new Error('Transação IDB abortada'));
    });
}

// ── Utilitários ──────────────────────────────────────────────────────────────
function generateAssetId() {
    try {
        if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
            return 'asset_' + crypto.randomUUID();
        }
    } catch (_e) {}
    return `asset_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 12)}`;
}

/** Data URL → Blob. Já sendo Blob, retorna como está. */
function dataUrlToBlob(dataUrl) {
    if (typeof Blob !== 'undefined' && dataUrl instanceof Blob) return dataUrl;
    if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:')) {
        throw new Error('Entrada inválida para dataUrlToBlob');
    }
    const commaIdx = dataUrl.indexOf(',');
    if (commaIdx === -1) throw new Error('Data URL malformada: sem vírgula');
    const header = dataUrl.slice(0, commaIdx);
    const mimeMatch = header.match(/:(.*?)[;,]/);
    const mime = (mimeMatch && mimeMatch[1]) || 'application/octet-stream';
    const isBase64 = header.includes('base64');

    if (isBase64) {
        const bstr = atob(dataUrl.slice(commaIdx + 1));
        const len = bstr.length;
        const u8 = new Uint8Array(len);
        for (let i = 0; i < len; i++) u8[i] = bstr.charCodeAt(i);
        return new Blob([u8], { type: mime });
    }
    const decoded = decodeURIComponent(dataUrl.slice(commaIdx + 1));
    return new Blob([decoded], { type: mime });
}

/** Blob → Data URL. FileReader não existe em Service Worker: usamos arrayBuffer. */
async function blobToDataUrl(blob) {
    if (!blob) return null;
    const buffer = await blob.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    let binary = '';
    const CHUNK = 0x8000; // evita "Maximum call stack size exceeded" em imagens grandes
    for (let i = 0; i < bytes.length; i += CHUNK) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    }
    const mime = blob.type || 'image/png';
    return `data:${mime};base64,${btoa(binary)}`;
}

// ── Escritor serializado por capítulo ────────────────────────────────────────
// Mesmo com registros individuais, duas gravações do MESMO capítulo podem
// disputar a troca de asset. A fila garante ordem determinística.
const _chapterWriters = new Map();

function enqueueChapterOp(chapterId, operation) {
    const previous = _chapterWriters.get(chapterId) || Promise.resolve();
    const next = previous.then(() => operation(), () => operation());
    _chapterWriters.set(chapterId, next.catch(() => {}));
    return next;
}

// ── API ──────────────────────────────────────────────────────────────────────

/**
 * Grava o resultado de uma página em UMA transação atômica:
 * asset (Blob) + registro da página + registro de restore.
 * Assets substituídos são removidos na mesma transação (sem órfãos).
 */
async function savePageResult(chapterId, pageIndex, imageData, originalUrl, cleanUrl, metadata = {}) {
    if (!chapterId) throw new Error('savePageResult: chapterId obrigatório');
    const index = Number(pageIndex);
    if (!Number.isFinite(index)) throw new Error('savePageResult: pageIndex inválido');

    return enqueueChapterOp(chapterId, async () => {
        const db = await openStorageDb();
        const assetId = generateAssetId();
        const blob = dataUrlToBlob(imageData);
        const now = Date.now();

        const tx = db.transaction(
            [SM_STORE_ASSETS, SM_STORE_CHAPTER_PAGES, SM_STORE_RESTORE, SM_STORE_CHAPTERS],
            'readwrite'
        );
        const assetStore   = tx.objectStore(SM_STORE_ASSETS);
        const pageStore    = tx.objectStore(SM_STORE_CHAPTER_PAGES);
        const restoreStore = tx.objectStore(SM_STORE_RESTORE);

        // Assets que este save substitui
        const obsolete = new Set();
        const previousPage = await _idbGet(pageStore, [chapterId, index]);
        if (previousPage && previousPage.assetId) obsolete.add(previousPage.assetId);
        if (cleanUrl) {
            const previousRestore = await _idbGet(restoreStore, [chapterId, cleanUrl]);
            if (previousRestore && previousRestore.assetId) obsolete.add(previousRestore.assetId);
        }

        assetStore.put({
            assetId,
            blob,
            mimeType: blob.type || 'image/png',
            size: blob.size,
            createdAt: now,
        });

        pageStore.put({
            chapterId,
            pageIndex: index,
            assetId,
            originalUrl: originalUrl || '',
            cleanUrl: cleanUrl || '',
            width: metadata.width || 0,
            height: metadata.height || 0,
            updatedAt: now,
        });

        if (cleanUrl) {
            restoreStore.put({
                chapterId,
                cleanUrl,
                assetId,
                sourceUrl: metadata.sourceUrl || originalUrl || '',
                host: metadata.host || '',
                index,
                width: metadata.width || 0,
                height: metadata.height || 0,
                updatedAt: now,
            });
        }

        obsolete.forEach(id => { if (id !== assetId) assetStore.delete(id); });

        tx.objectStore(SM_STORE_CHAPTERS).put({ chapterId, updatedAt: now });

        await _idbTxComplete(tx);
        return { assetId, chapterId, pageIndex: index };
    });
}

async function getAssetBlob(assetId) {
    if (!assetId) return null;
    const db = await openStorageDb();
    const tx = db.transaction(SM_STORE_ASSETS, 'readonly');
    const asset = await _idbGet(tx.objectStore(SM_STORE_ASSETS), assetId);
    return asset ? asset.blob : null;
}

async function getAssetDataUrl(assetId) {
    const blob = await getAssetBlob(assetId);
    return blob ? blobToDataUrl(blob) : null;
}

async function getPageAsset(chapterId, pageIndex) {
    const db = await openStorageDb();
    const tx = db.transaction([SM_STORE_CHAPTER_PAGES, SM_STORE_ASSETS], 'readonly');
    const page = await _idbGet(tx.objectStore(SM_STORE_CHAPTER_PAGES), [chapterId, Number(pageIndex)]);
    if (!page || !page.assetId) return null;
    const asset = await _idbGet(tx.objectStore(SM_STORE_ASSETS), page.assetId);
    return asset ? asset.blob : null;
}

async function getPageDataUrl(chapterId, pageIndex) {
    const blob = await getPageAsset(chapterId, pageIndex);
    return blob ? blobToDataUrl(blob) : null;
}

/** Metadados das páginas, SEM carregar nenhum blob. */
async function getChapterPageIndex(chapterId) {
    const db = await openStorageDb();
    const tx = db.transaction(SM_STORE_CHAPTER_PAGES, 'readonly');
    const rows = await _idbGetAll(
        tx.objectStore(SM_STORE_CHAPTER_PAGES).index('by_chapter'),
        IDBKeyRange.only(chapterId)
    );
    return rows
        .map(r => ({ pageIndex: r.pageIndex, assetId: r.assetId, width: r.width, height: r.height, updatedAt: r.updatedAt }))
        .sort((a, b) => a.pageIndex - b.pageIndex);
}

async function getChapterPageCount(chapterId) {
    const rows = await getChapterPageIndex(chapterId);
    return rows.length;
}

/** Contagem de páginas de vários capítulos numa transação só (popup). */
async function getChaptersStats(chapterIds = []) {
    const db = await openStorageDb();
    const tx = db.transaction(SM_STORE_CHAPTER_PAGES, 'readonly');
    const idx = tx.objectStore(SM_STORE_CHAPTER_PAGES).index('by_chapter');
    const stats = {};
    for (const chapterId of chapterIds) {
        const rows = await _idbGetAll(idx, IDBKeyRange.only(chapterId));
        stats[chapterId] = {
            pageCount: rows.length,
            indices: rows.map(r => r.pageIndex).sort((a, b) => a - b),
        };
    }
    return stats;
}

/**
 * Mapa de restauração SEM blobs: { [cleanUrl]: { assetId, index } }.
 * O content script só busca o asset da imagem que realmente apareceu no DOM —
 * é isso que desliga o consumo de memória do tamanho do capítulo.
 */
async function getRestoreIndex(chapterId) {
    const db = await openStorageDb();
    const tx = db.transaction(SM_STORE_RESTORE, 'readonly');
    const rows = await _idbGetAll(
        tx.objectStore(SM_STORE_RESTORE).index('by_chapter'),
        IDBKeyRange.only(chapterId)
    );
    const map = {};
    rows.forEach(r => { map[r.cleanUrl] = { assetId: r.assetId, index: r.index }; });
    return map;
}

/** Metadados de restore (popup/opções) — sem blobs. */
async function listRestoreEntries(chapterIds = null) {
    const db = await openStorageDb();
    const tx = db.transaction(SM_STORE_RESTORE, 'readonly');
    const store = tx.objectStore(SM_STORE_RESTORE);
    let rows;
    if (Array.isArray(chapterIds) && chapterIds.length > 0) {
        const idx = store.index('by_chapter');
        rows = [];
        for (const chapterId of chapterIds) {
            rows = rows.concat(await _idbGetAll(idx, IDBKeyRange.only(chapterId)));
        }
    } else {
        rows = await _idbGetAll(store);
    }
    return rows.map(r => ({
        chapterId: r.chapterId,
        cleanUrl:  r.cleanUrl,
        assetId:   r.assetId,
        sourceUrl: r.sourceUrl,
        host:      r.host,
        index:     r.index,
        width:     r.width,
        height:    r.height,
        updatedAt: r.updatedAt,
    })).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

/**
 * "Refazer": apaga tudo que faria a tradução errada voltar — entrada de restore,
 * página correspondente e os assets, em todos os capítulos que tenham essa URL.
 */
async function deleteByCleanUrl(cleanUrl) {
    if (!cleanUrl) return { deleted: 0 };
    const db = await openStorageDb();

    const txRead = db.transaction(SM_STORE_RESTORE, 'readonly');
    const rows = await _idbGetAll(
        txRead.objectStore(SM_STORE_RESTORE).index('by_cleanUrl'),
        IDBKeyRange.only(cleanUrl)
    );
    if (rows.length === 0) return { deleted: 0 };

    const tx = db.transaction([SM_STORE_RESTORE, SM_STORE_CHAPTER_PAGES, SM_STORE_ASSETS], 'readwrite');
    const restoreStore = tx.objectStore(SM_STORE_RESTORE);
    const pageStore    = tx.objectStore(SM_STORE_CHAPTER_PAGES);
    const assetStore   = tx.objectStore(SM_STORE_ASSETS);

    for (const row of rows) {
        restoreStore.delete([row.chapterId, row.cleanUrl]);
        if (row.assetId) assetStore.delete(row.assetId);
        if (Number.isFinite(row.index)) {
            const page = await _idbGet(pageStore, [row.chapterId, row.index]);
            if (page && page.cleanUrl === cleanUrl) {
                pageStore.delete([row.chapterId, row.index]);
                if (page.assetId) assetStore.delete(page.assetId);
            }
        }
    }

    await _idbTxComplete(tx);
    return { deleted: rows.length };
}

/** Remove capítulo inteiro: páginas, restores e assets. */
async function deleteChapter(chapterId) {
    if (!chapterId) return { deleted: 0 };
    return enqueueChapterOp(chapterId, async () => {
        const db = await openStorageDb();

        const txRead = db.transaction([SM_STORE_CHAPTER_PAGES, SM_STORE_RESTORE], 'readonly');
        const pages = await _idbGetAll(
            txRead.objectStore(SM_STORE_CHAPTER_PAGES).index('by_chapter'), IDBKeyRange.only(chapterId));
        const restores = await _idbGetAll(
            txRead.objectStore(SM_STORE_RESTORE).index('by_chapter'), IDBKeyRange.only(chapterId));

        const assetIds = new Set();
        pages.forEach(p => { if (p.assetId) assetIds.add(p.assetId); });
        restores.forEach(r => { if (r.assetId) assetIds.add(r.assetId); });

        const tx = db.transaction(
            [SM_STORE_CHAPTERS, SM_STORE_CHAPTER_PAGES, SM_STORE_RESTORE, SM_STORE_ASSETS], 'readwrite');
        tx.objectStore(SM_STORE_CHAPTERS).delete(chapterId);
        pages.forEach(p => tx.objectStore(SM_STORE_CHAPTER_PAGES).delete([p.chapterId, p.pageIndex]));
        restores.forEach(r => tx.objectStore(SM_STORE_RESTORE).delete([r.chapterId, r.cleanUrl]));
        assetIds.forEach(id => tx.objectStore(SM_STORE_ASSETS).delete(id));

        await _idbTxComplete(tx);
        return { deleted: pages.length + restores.length, assets: assetIds.size };
    });
}

// ── Migração de dados legados ────────────────────────────────────────────────
//
// Idempotente e POR CAPÍTULO: só lê as chaves daquele capítulo (nada de get(null)).
// As chaves antigas só são removidas depois que a gravação nova confirmou — é
// isso que devolve a cota de chrome.storage.local ocupada por Base64 duplicado.
async function migrateChapterFromLegacy(chapterId) {
    if (!chapterId) return { migrated: 0, skipped: true };

    const flagKey = `_sm_migrated_${chapterId}`;
    const keys = [flagKey, `${chapterId}_images`, `${chapterId}_restoreMap`, `${chapterId}_restoreMeta`];
    const data = await new Promise(resolve => chrome.storage.local.get(keys, resolve));

    if (data[flagKey]) return { migrated: 0, skipped: true };

    const images      = data[`${chapterId}_images`] || {};
    const restoreMap  = data[`${chapterId}_restoreMap`] || {};
    const restoreMeta = data[`${chapterId}_restoreMeta`] || {};

    let migrated = 0;

    // Índice reverso: pageIndex → cleanUrl
    const urlByIndex = {};
    Object.keys(restoreMeta).forEach(url => {
        const meta = restoreMeta[url];
        if (meta && meta.index !== undefined && meta.index !== null) urlByIndex[String(meta.index)] = url;
    });

    for (const indexStr of Object.keys(images)) {
        const dataUrl = images[indexStr];
        if (!dataUrl || typeof dataUrl !== 'string') continue;
        const pageIndex = parseInt(indexStr, 10);
        if (!Number.isFinite(pageIndex)) continue;

        const cleanUrl = urlByIndex[indexStr] || '';
        const meta = (cleanUrl && restoreMeta[cleanUrl]) || {};
        try {
            await savePageResult(chapterId, pageIndex, dataUrl, meta.sourceUrl || '', cleanUrl, {
                host: meta.host || '', width: meta.width || 0, height: meta.height || 0,
                sourceUrl: meta.sourceUrl || '',
            });
            migrated++;
        } catch (_e) { /* segue para a próxima página */ }
    }

    // Restores sem página correspondente
    let orphanSlot = -1;
    for (const cleanUrl of Object.keys(restoreMap)) {
        const dataUrl = restoreMap[cleanUrl];
        if (!dataUrl || typeof dataUrl !== 'string') continue;
        const meta = restoreMeta[cleanUrl] || {};
        const declaredIndex = Number(meta.index);
        const hasPage = Number.isFinite(declaredIndex) && images[String(declaredIndex)];
        if (hasPage) continue; // já migrado acima
        const pageIndex = Number.isFinite(declaredIndex) ? declaredIndex : (orphanSlot--);
        try {
            await savePageResult(chapterId, pageIndex, dataUrl, meta.sourceUrl || '', cleanUrl, {
                host: meta.host || '', width: meta.width || 0, height: meta.height || 0,
                sourceUrl: meta.sourceUrl || '',
            });
            migrated++;
        } catch (_e) {}
    }

    await new Promise(resolve => chrome.storage.local.set({ [flagKey]: true }, resolve));
    if (migrated > 0) {
        await new Promise(resolve => chrome.storage.local.remove(
            [`${chapterId}_images`, `${chapterId}_restoreMap`, `${chapterId}_restoreMeta`], resolve));
    }

    return { migrated, skipped: false };
}

async function stats() {
    const db = await openStorageDb();
    const tx = db.transaction([SM_STORE_CHAPTER_PAGES, SM_STORE_ASSETS], 'readonly');
    const pages = await _idbGetAll(tx.objectStore(SM_STORE_CHAPTER_PAGES));
    const assets = await _idbGetAll(tx.objectStore(SM_STORE_ASSETS));
    const bytes = assets.reduce((sum, a) => sum + (a.size || 0), 0);
    return { pages: pages.length, assets: assets.length, bytes };
}

const api = {
    openStorageDb,
    savePageResult,
    getAssetBlob,
    getAssetDataUrl,
    getPageAsset,
    getPageDataUrl,
    getChapterPageIndex,
    getChapterPageCount,
    getChaptersStats,
    getRestoreIndex,
    listRestoreEntries,
    deleteByCleanUrl,
    deleteChapter,
    migrateChapterFromLegacy,
    stats,
    dataUrlToBlob,
    blobToDataUrl,
    SM_DB_NAME,
    SM_DB_VERSION,
};

if (typeof module !== 'undefined' && module.exports) module.exports = api;
rootScope.MangaTranslatorStorageManager = api;

})(typeof self !== 'undefined' ? self : globalThis);
