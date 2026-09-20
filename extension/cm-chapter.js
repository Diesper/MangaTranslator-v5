// cm-chapter.js — identidade, persistência e memória temporária de capítulos.
(function attachMangaTranslatorChapterApi(rootScope) {
    'use strict';

    function canonicalTitle(value) {
        return (value || '')
            .replace(/^\d+[\s.\-–—:|]+/, '')
            .replace(/[|–—•·\[\]()\u00AB\u00BB]/g, ' ')
            .replace(/\s*[-:]\s*$/, '')
            .replace(/\s{2,}/g, ' ')
            .trim()
            .toLowerCase()
            .slice(0, 80);
    }

    function createChapterManager({ hostname, generateId, sendRuntimeMessageAsync, onRestoreEntry } = {}) {
        if (typeof generateId !== 'function') throw new Error('cm-chapter requer generateId');
        if (typeof sendRuntimeMessageAsync !== 'function') throw new Error('cm-chapter requer sendRuntimeMessageAsync');

        const writeQueues = new Map();
        const assetCache = new Map();
        const assetCacheMax = 12;
        let chapterIdPromise = null;
        let chapterIdUrl = null;

        function storageGetAsync(keys) {
            return new Promise((resolve, reject) => {
                chrome.storage.local.get(keys, (data) => {
                    if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
                    else resolve(data || {});
                });
            });
        }

        function storageSetAsync(items) {
            return new Promise((resolve, reject) => {
                chrome.storage.local.set(items, () => {
                    if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
                    else resolve();
                });
            });
        }

        function enqueueChapterWrite(chapterId, task) {
            const previous = writeQueues.get(chapterId) || Promise.resolve();
            const next = previous.then(() => task(), () => task());
            writeQueues.set(chapterId, next.catch(() => {}));
            return next;
        }

        function cacheAsset(assetId, dataUrl) {
            if (!assetId || !dataUrl) return dataUrl;
            assetCache.delete(assetId);
            assetCache.set(assetId, dataUrl);
            while (assetCache.size > assetCacheMax) assetCache.delete(assetCache.keys().next().value);
            return dataUrl;
        }

        async function resolveRestoreAsset(entry) {
            if (!entry) return null;
            if (typeof entry === 'string') return entry;
            if (!entry.assetId) return null;
            if (assetCache.has(entry.assetId)) return assetCache.get(entry.assetId);
            const response = await sendRuntimeMessageAsync({ action: 'SM_GET_ASSET', assetId: entry.assetId });
            if (!response || !response.ok || !response.dataUrl) return null;
            return cacheAsset(entry.assetId, response.dataUrl);
        }

        function getOrCreateChapterId() {
            if (chapterIdUrl !== window.location.href) {
                chapterIdPromise = null;
                chapterIdUrl = window.location.href;
            }
            if (!chapterIdPromise) chapterIdPromise = getOrCreateChapterIdImpl().catch((error) => {
                chapterIdPromise = null;
                throw error;
            });
            return chapterIdPromise;
        }

        function getOrCreateChapterIdImpl() {
            return new Promise((resolve, reject) => {
                chrome.storage.local.get(['chapterList'], (data) => {
                    if (chrome.runtime.lastError) {
                        reject(new Error(`storage.get falhou: ${chrome.runtime.lastError.message}`));
                        return;
                    }
                    const list = data.chapterList || [];
                    let chapter = list.find((item) => item.url === window.location.href);
                    if (!chapter) {
                        chapter = list.find((item) => {
                            if (!item.url) return false;
                            try {
                                return new URL(item.url).hostname === hostname
                                    && canonicalTitle(item.title || '').replace(/[^a-z0-9]/gi, '_') === canonicalTitle(document.title || 'Capítulo sem título').replace(/[^a-z0-9]/gi, '_');
                            } catch (_error) { return false; }
                        });
                        if (chapter) {
                            chapter.url = window.location.href;
                            chapter.title = canonicalTitle(document.title || 'Capítulo sem título');
                            chrome.storage.local.set({ chapterList: list });
                        }
                    }
                    if (chapter) { resolve(chapter.id); return; }
                    const newId = generateId('chap_');
                    list.push({ id: newId, url: window.location.href, title: canonicalTitle(document.title || 'Capítulo sem título'), timestamp: Date.now() });
                    chrome.storage.local.set({ chapterList: list }, () => {
                        if (chrome.runtime.lastError) reject(new Error(`storage.set falhou: ${chrome.runtime.lastError.message}`));
                        else resolve(newId);
                    });
                });
            });
        }

        function persistTranslatedPage(pageIndex, dataUrl, meta = {}) {
            return getOrCreateChapterId().then(async (chapterId) => {
                const response = await sendRuntimeMessageAsync({
                    action: 'SM_SAVE_PAGE', chapterId, pageIndex, dataUrl,
                    originalUrl: meta.sourceUrl || '', cleanUrl: meta.cleanUrl || '',
                    meta: { host: hostname, width: meta.width || 0, height: meta.height || 0, sourceUrl: meta.sourceUrl || '' },
                });
                if (!response || !response.ok) throw new Error((response && response.error) || 'SM_SAVE_PAGE não confirmou a gravação');
                if (meta.cleanUrl && response.assetId) {
                    const entry = { assetId: response.assetId, index: pageIndex };
                    if (typeof onRestoreEntry === 'function') onRestoreEntry(meta.cleanUrl, entry);
                    cacheAsset(response.assetId, dataUrl);
                } else if (meta.cleanUrl) {
                    if (typeof onRestoreEntry === 'function') onRestoreEntry(meta.cleanUrl, dataUrl);
                    const restoreKey = `${chapterId}_restoreMap`;
                    const imagesKey = `${chapterId}_images`;
                    storageGetAsync([restoreKey, imagesKey]).then((legacy) => {
                        const restoreMap = legacy[restoreKey] || {};
                        const images = legacy[imagesKey] || {};
                        restoreMap[meta.cleanUrl] = dataUrl;
                        images[pageIndex] = dataUrl;
                        return storageSetAsync({ [restoreKey]: restoreMap, [imagesKey]: images });
                    }).catch(() => {});
                }
                const listData = await storageGetAsync(['chapterList']);
                const chapter = (listData.chapterList || []).find((item) => item.id === chapterId) || null;
                return { chapterId, chapter, assetId: response.assetId };
            });
        }

        return Object.freeze({ canonicalTitle, enqueueChapterWrite, storageGetAsync, storageSetAsync, cacheAsset, resolveRestoreAsset, getOrCreateChapterId, persistTranslatedPage });
    }

    const api = Object.freeze({ canonicalTitle, createChapterManager });
    rootScope.MangaTranslatorChapter = api;
    // Jest/Node carregam scripts clássicos em um escopo global diferente do
    // `window` do JSDOM; publicar nos dois preserva a semântica do content script.
    if (typeof globalThis !== 'undefined') globalThis.MangaTranslatorChapter = api;
    if (typeof window !== 'undefined') window.MangaTranslatorChapter = api;
})(typeof window !== 'undefined' ? window : self);
