'use strict';

// Stateful auto-restore coordinator. It intentionally receives the chapter,
// asset and DOM operations as dependencies: those responsibilities move in
// their own cuts and this module must not duplicate their caches or state.
(function attachAutoRestoreApi(rootScope) {
    function normalizeBlockedImagesStore(value) {
        if (Array.isArray(value)) return value.reduce((store, cleanUrl) => {
            if (cleanUrl) store[cleanUrl] = { cleanUrl };
            return store;
        }, {});
        return value && typeof value === 'object' ? value : {};
    }

    function createAutoRestorer(deps) {
        const { hostname, isActive, isTranslating, getChapterId, resolveAsset, getCleanUrl,
            isBackdropOrBlurredImage, applyImageReplacement, sendRuntimeMessageAsync, sendLog } = deps;
        let restoreMap = {};
        let observer = null;
        let debounceTimer = null;
        let running = false;
        let config = { enabled: true, disabledSites: [], blockedImages: {} };

        function loadConfig() {
            return new Promise(resolve => chrome.storage.local.get([
                'autoRestoreEnabled', 'autoRestoreDisabledSites', 'autoRestoreBlockedImages',
            ], data => {
                config = {
                    enabled: data.autoRestoreEnabled !== false,
                    disabledSites: Array.isArray(data.autoRestoreDisabledSites) ? data.autoRestoreDisabledSites : [],
                    blockedImages: normalizeBlockedImagesStore(data.autoRestoreBlockedImages),
                };
                resolve(config);
            }));
        }
        function isAllowed(cleanUrl) {
            return config.enabled && !config.disabledSites.includes(hostname) && !(cleanUrl && config.blockedImages[cleanUrl]);
        }
        function disconnect() {
            if (observer) { observer.disconnect(); observer = null; }
            clearTimeout(debounceTimer); debounceTimer = null;
        }
        async function apply() {
            if (!isActive()) { disconnect(); return; }
            if (isTranslating() || !config.enabled || config.disabledSites.includes(hostname) || !Object.keys(restoreMap).length || running) return;
            running = true;
            try {
                const pending = [];
                let blockedCount = 0;
                rootScope.document.querySelectorAll('img:not([data-translated="true"])').forEach(img => {
                    const rawUrl = img.getAttribute('src') || img.dataset.src || img.dataset.lazySrc || img.getAttribute('data-original') || '';
                    const cleanUrl = getCleanUrl(rawUrl);
                    if (!cleanUrl || !restoreMap[cleanUrl]) return;
                    if (!isAllowed(cleanUrl)) { blockedCount += 1; return; }
                    pending.push({ img, cleanUrl });
                });
                let restoredCount = 0;
                for (const { img, cleanUrl } of pending) {
                    if (!isActive() || isTranslating()) break;
                    if (img.dataset.translated === 'true') continue;
                    const dataUrl = await resolveAsset(restoreMap[cleanUrl]);
                    if (!dataUrl) continue;
                    if (isBackdropOrBlurredImage(img)) {
                        img.src = dataUrl; img.dataset.translated = 'true';
                        img.style.setProperty('z-index', '0', 'important');
                        img.style.setProperty('pointer-events', 'none', 'important');
                    } else {
                        applyImageReplacement(img, dataUrl, true); restoredCount += 1;
                    }
                }
                if (restoredCount) sendLog('info', 'AUTO_RESTORE', `Auto-restauração: ${restoredCount} página(s) restauradas silenciosamente`, { restoredCount });
                if (blockedCount) sendLog('info', 'AUTO_RESTORE_BLOCKED', `Auto-restauração: ${blockedCount} imagem(ns) bloqueadas pelas opções`, { blockedCount });
            } finally { running = false; }
        }
        async function initialize() {
            if (!isActive() || isTranslating()) return;
            try {
                await loadConfig();
                const chapterId = await getChapterId();
                if (!isActive() || isTranslating()) return;
                const migration = await sendRuntimeMessageAsync({ action: 'SM_MIGRATE_CHAPTER', chapterId });
                if (migration && migration.ok && migration.migrated > 0) sendLog('success', 'SM_MIGRATED', `Capítulo migrado para o novo armazenamento: ${migration.migrated} página(s)`, { chapterId, migrated: migration.migrated });
                const response = await sendRuntimeMessageAsync({ action: 'SM_RESTORE_INDEX', chapterId });
                if (!isActive() || isTranslating()) return;
                let entries = (response && response.ok && response.entries) || {};
                // The IndexedDB bridge is deliberately preferred, but old
                // chapters can still exist while migration is unavailable or
                // has not produced an index. Preserve their restore contract.
                if (!Object.keys(entries).length) {
                    const legacy = await new Promise(resolve => chrome.storage.local.get([`${chapterId}_restoreMap`], resolve));
                    entries = legacy[`${chapterId}_restoreMap`] || {};
                }
                restoreMap = { ...restoreMap, ...entries };
                if (!Object.keys(restoreMap).length) return;
                if (!config.enabled || config.disabledSites.includes(hostname)) {
                    disconnect();
                    sendLog('info', 'AUTO_RESTORE_DISABLED', 'Auto-restauração desativada pelas opções', { hostname, global: !config.enabled, site: config.disabledSites.includes(hostname) });
                    return;
                }
                apply(); disconnect();
                observer = new MutationObserver(mutations => {
                    const changed = mutations.some(m => m.addedNodes.length > 0 || (m.type === 'attributes' && ['src', 'data-src', 'data-lazy'].includes(m.attributeName)));
                    if (!changed) return;
                    clearTimeout(debounceTimer); debounceTimer = setTimeout(apply, 150);
                });
                observer.observe(rootScope.document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['src', 'data-src', 'data-lazy'] });
                sendLog('info', 'AUTO_RESTORE_INIT', `Restaurador ativo: ${Object.keys(restoreMap).length} página(s) no mapa`);
            } catch (_) { /* existing flow intentionally treats restore as best-effort */ }
        }
        function setEntry(cleanUrl, entry) { if (cleanUrl && entry) restoreMap[cleanUrl] = entry; }
        function onStorageChanged(changes, areaName) {
            if (!isActive() || (areaName && areaName !== 'local')) return;
            if (!['autoRestoreEnabled', 'autoRestoreDisabledSites', 'autoRestoreBlockedImages'].some(key => changes[key])) return;
            loadConfig().then(() => {
                if (!isActive() || isTranslating()) return;
                if (!config.enabled || config.disabledSites.includes(hostname)) { disconnect(); return; }
                initialize();
            }).catch(() => {});
        }
        return Object.freeze({ loadConfig, isAllowed, disconnect, apply, initialize, setEntry, onStorageChanged, getMap: () => ({ ...restoreMap }) });
    }
    rootScope.MangaTranslatorAutoRestore = Object.freeze({ normalizeBlockedImagesStore, createAutoRestorer });
})(typeof window !== 'undefined' ? window : self);
