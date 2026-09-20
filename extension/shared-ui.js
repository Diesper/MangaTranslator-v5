'use strict';
// shared-ui.js — Funções utilitárias compartilhadas entre popup, options e reader
// Extraídas para eliminar duplicação de código

function escapeHTML(str) {
    return String(str || '').replace(/[&<>'"]/g, tag => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        "'": '&#39;',
        '"': '&quot;',
    }[tag]));
}

function normalizeBlockedImages(value) {
    if (Array.isArray(value)) {
        return value.reduce((acc, cleanUrl) => {
            if (cleanUrl) acc[cleanUrl] = { cleanUrl };
            return acc;
        }, {});
    }
    return value && typeof value === 'object' ? value : {};
}

function getHostFromUrl(urlStr, fallback = 'desconhecido') {
    try { return new URL(urlStr).hostname; } catch (_e) { return fallback; }
}

function smRequest(message) {
    return new Promise(resolve => {
        try {
            chrome.runtime.sendMessage(message, (response) => {
                if (chrome.runtime.lastError) resolve(null);
                else resolve(response || null);
            });
        } catch (_e) { resolve(null); }
    });
}

async function loadRestoreEntries(chapterList) {
    const chapters = chapterList || [];
    const chaptersById = new Map(chapters.map(c => [c.id, c]));

    const resp = await smRequest({ action: 'SM_LIST_RESTORE' });
    const rows = (resp && resp.ok && resp.entries) || [];

    const entries = rows.map(r => {
        const chapter = chaptersById.get(r.chapterId) || {};
        return {
            chapterId:    r.chapterId,
            cleanUrl:     r.cleanUrl,
            assetId:      r.assetId,
            sourceUrl:    r.sourceUrl || r.cleanUrl,
            host:         r.host || getHostFromUrl(chapter.url || r.cleanUrl),
            chapterTitle: chapter.title || 'Capítulo sem título',
            index:        r.index,
            width:        r.width  || 0,
            height:       r.height || 0,
            updatedAt:    r.updatedAt || chapter.timestamp || 0,
        };
    });

    const chaptersWithEntries = new Set(entries.map(e => e.chapterId));
    const pending = chapters.filter(c => !chaptersWithEntries.has(c.id));
    if (pending.length > 0) {
        const keys = [];
        pending.forEach(c => keys.push(`${c.id}_restoreMap`, `${c.id}_restoreMeta`));
        const legacy = await new Promise(r => chrome.storage.local.get(keys, r));
        pending.forEach(chapter => {
            const restoreMap  = legacy[`${chapter.id}_restoreMap`]  || {};
            const restoreMeta = legacy[`${chapter.id}_restoreMeta`] || {};
            Object.keys(restoreMap).forEach(cleanUrl => {
                const meta = restoreMeta[cleanUrl] || {};
                entries.push({
                    chapterId:     chapter.id,
                    cleanUrl,
                    legacyDataUrl: restoreMap[cleanUrl],
                    sourceUrl:     meta.sourceUrl || cleanUrl,
                    host:          meta.host || getHostFromUrl(chapter.url || cleanUrl),
                    chapterTitle:  chapter.title || 'Capítulo sem título',
                    index:         meta.index,
                    width:         meta.width  || 0,
                    height:        meta.height || 0,
                    updatedAt:     meta.updatedAt || chapter.timestamp || 0,
                });
            });
        });
    }

    return entries.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

function removeIndexFromStoredCollection(value, index) {
    if (index === undefined || index === null) return { changed: false, value };
    const key = String(index);

    if (Array.isArray(value)) {
        if (!Object.prototype.hasOwnProperty.call(value, index) || value[index] === null) {
            return { changed: false, value };
        }
        const next = value.slice();
        next[index] = null;
        return { changed: true, value: next };
    }

    if (value && typeof value === 'object' && Object.prototype.hasOwnProperty.call(value, key)) {
        const next = { ...value };
        delete next[key];
        return { changed: true, value: next };
    }

    return { changed: false, value };
}

function sendRuntimeMessageSafe(message, callback) {
    try {
        chrome.runtime.sendMessage(message, (response) => {
            const error = chrome.runtime.lastError ? chrome.runtime.lastError.message : null;
            if (callback) callback(response, error);
        });
    } catch (error) {
        if (callback) callback(null, error.message);
    }
}

function deleteSavedTranslationForEntry(entry) {
    if (!entry || !entry.cleanUrl) return;
    if (!confirm(`Apagar a tradução salva desta imagem?\n\nDepois disso, selecione/traduza a imagem novamente para gerar a versão correta.`)) return;

    (async () => {
        const smResult = await smRequest({ action: 'SM_DELETE_CLEAN_URL', cleanUrl: entry.cleanUrl });

        const initData = await new Promise(r => chrome.storage.local.get(['chapterList', 'autoRestoreBlockedImages'], r));
        const chapterList = initData.chapterList || [];
        const chapterIds = entry.chapterId ? [entry.chapterId] : chapterList.map(c => c.id);

        const keysToFetch = [];
        chapterIds.forEach(id => keysToFetch.push(`${id}_restoreMap`, `${id}_restoreMeta`, `${id}_images`, `${id}_paths`));
        const data = keysToFetch.length
            ? await new Promise(r => chrome.storage.local.get(keysToFetch, r))
            : {};

        const updates = {};
        const blockedImages = normalizeBlockedImages(initData.autoRestoreBlockedImages);
        if (blockedImages[entry.cleanUrl]) {
            delete blockedImages[entry.cleanUrl];
            updates.autoRestoreBlockedImages = blockedImages;
        }

        chapterIds.forEach(chapterId => {
            const restoreMapKey = `${chapterId}_restoreMap`;
            const restoreMap = data[restoreMapKey] || {};
            if (Object.prototype.hasOwnProperty.call(restoreMap, entry.cleanUrl)) {
                const next = { ...restoreMap };
                delete next[entry.cleanUrl];
                updates[restoreMapKey] = next;
            }

            const restoreMetaKey = `${chapterId}_restoreMeta`;
            const restoreMeta = data[restoreMetaKey] || {};
            if (Object.prototype.hasOwnProperty.call(restoreMeta, entry.cleanUrl)) {
                const next = { ...restoreMeta };
                delete next[entry.cleanUrl];
                updates[restoreMetaKey] = next;
            }

            const imageResult = removeIndexFromStoredCollection(data[`${chapterId}_images`], entry.index);
            if (imageResult.changed) updates[`${chapterId}_images`] = imageResult.value;

            const pathResult = removeIndexFromStoredCollection(data[`${chapterId}_paths`], entry.index);
            if (pathResult.changed) updates[`${chapterId}_paths`] = pathResult.value;
        });

        if (Object.keys(updates).length > 0) {
            await new Promise(r => chrome.storage.local.set(updates, r));
        }

        sendRuntimeMessageSafe({
            action: 'GTC_DELETE_BY_CLEAN_URL',
            cleanUrl: entry.cleanUrl,
        }, (_response, error) => {
            if (typeof renderSites === 'function') renderSites();
            else if (typeof renderSettingsSites === 'function') renderSettingsSites();
            
            const smOk = smResult && smResult.ok;
            const msg = error
                    ? 'Tradução local apagada. Cache global não respondeu.'
                    : (smOk
                        ? 'Tradução apagada. Agora você pode refazer essa imagem.'
                        : 'Tradução apagada do storage local. Armazenamento novo não respondeu.');
            const color = error || !smOk ? '#FF9800' : '#4CAF50';
            
            if (typeof showStatus === 'function') showStatus(msg, color);
            else if (typeof showSettingsStatus === 'function') showSettingsStatus(msg, color);
        });
    })().catch(() => {
        if (typeof showStatus === 'function') showStatus('Falha ao apagar a tradução salva.', '#FF9800');
        else if (typeof showSettingsStatus === 'function') showSettingsStatus('Falha ao apagar a tradução salva.', '#FF9800');
    });
}
