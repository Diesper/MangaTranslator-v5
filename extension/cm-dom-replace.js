// cm-dom-replace.js — seleção e substituição visual de páginas do mangá.
// Content scripts clássicos não suportam imports; a API é carregada antes de
// content_manga.js pelo manifest e fica privada ao mundo isolado da extensão.
(function exposeMangaTranslatorDomReplace(globalScope) {
    'use strict';

    function getCleanUrl(rawUrl) {
        if (!rawUrl || rawUrl.startsWith('data:') || rawUrl.startsWith('blob:')) return null;
        try {
            const base = (window.location && (window.location.origin || window.location.href))
                || document.baseURI
                || 'https://manga-translator.invalid/';
            const url = new URL(rawUrl, base);

            if (url.hostname === 'preview.redd.it' || url.hostname === 'external-preview.redd.it') {
                const match = url.pathname.match(/[-]([a-z0-9]{8,})(\.[a-z]+)$/i);
                if (match) return `https://i.redd.it/${match[1]}${match[2].toLowerCase()}`;
                return `https://i.redd.it${url.pathname}`.toLowerCase();
            }
            if (url.hostname === 'i.redd.it') return `${url.protocol}//${url.hostname}${url.pathname}`.toLowerCase();
            if (url.hostname.includes('imgur.com')) {
                const cleanedPath = url.pathname.replace(/([a-zA-Z0-9]{5,})[bmlhts](\.[a-z]+)$/i, '$1$2');
                return `${url.protocol}//${url.hostname}${cleanedPath}`.toLowerCase();
            }

            const resizeParams = ['width', 'w', 'h', 'height', 'size', 'quality', 'q', 'format', 'auto', 'crop', 'fit', 'resize', 'scale', 'dpr', 'webp', 'avif', 'thumb', 'thumbnail', 'tr', 'im'];
            let changed = false;
            resizeParams.forEach((param) => {
                if (url.searchParams.has(param)) {
                    url.searchParams.delete(param);
                    changed = true;
                }
            });
            const query = changed && url.search ? url.search : '';
            return `${url.protocol}//${url.host}${url.pathname}${query}`.toLowerCase();
        } catch (_error) {
            return String(rawUrl).split('?')[0].split('#')[0].toLowerCase();
        }
    }

    function getRawImageUrl(img) {
        return img.getAttribute('src') || img.dataset.src || img.dataset.lazySrc || img.getAttribute('data-original') || img.src || '';
    }

    function isBackdropOrBlurredImage(img) {
        if (!img) return false;
        try {
            if (img.getAttribute('aria-hidden') === 'true' || (img.closest && img.closest('[aria-hidden="true"]'))) return true;

            const backdropClassRegex = /(^|\s|__|-)(blur|backdrop|ambient|shreddit-aspect-ratio__blur|media-lightbox-img-background|preview-blur)($|\s|__|-)/i;
            let current = img;
            let depth = 0;
            while (current && depth < 5 && current !== document.body) {
                const className = typeof current.className === 'string' ? current.className : '';
                if (backdropClassRegex.test(className)) return true;
                if (current.hasAttribute && (current.hasAttribute('ambient') || current.hasAttribute('backdrop'))) return true;
                current = current.parentElement;
                depth++;
            }

            const compStyle = window.getComputedStyle ? window.getComputedStyle(img) : null;
            if (compStyle) {
                const filter = compStyle.filter || '';
                const backdropFilter = compStyle.backdropFilter || '';
                if (filter.includes('blur') || backdropFilter.includes('blur')) return true;
                if (compStyle.pointerEvents === 'none' && (filter !== 'none' || (img.style && img.style.filter && img.style.filter.includes('blur')))) return true;
            }
        } catch (_error) {}
        return false;
    }

    function getScanEligibleImages(banned = []) {
        const candidates = [];
        Array.from(document.querySelectorAll('img')).forEach((img, index) => {
            if (img.naturalWidth >= 300 && img.naturalHeight >= 400 && img.dataset.translated !== 'true' && !banned.includes(img.src)) {
                candidates.push({
                    element: img,
                    index,
                    src: img.src,
                    cleanUrl: getCleanUrl(getRawImageUrl(img)),
                    width: img.naturalWidth,
                    height: img.naturalHeight,
                    isBackdrop: isBackdropOrBlurredImage(img),
                });
            }
        });

        const urlGroups = new Map();
        candidates.forEach((candidate) => {
            const key = candidate.cleanUrl || candidate.src;
            if (!urlGroups.has(key)) urlGroups.set(key, []);
            urlGroups.get(key).push(candidate);
        });

        const valid = [];
        for (const group of urlGroups.values()) {
            if (group.length === 1) {
                const single = group[0];
                if (!(single.isBackdrop && single.element.getAttribute('aria-hidden') === 'true')) valid.push(single);
                continue;
            }
            const nonBackdrops = group.filter((candidate) => !candidate.isBackdrop);
            if (nonBackdrops.length > 0) {
                valid.push(nonBackdrops.find((candidate) => {
                    try { return window.getComputedStyle(candidate.element).pointerEvents !== 'none'; } catch (_error) { return true; }
                }) || nonBackdrops[0]);
            } else {
                valid.push(group[group.length - 1]);
            }
        }

        return valid.sort((a, b) => a.index - b.index).map(({ index, src, width, height }) => ({ index, src, width, height }));
    }

    function applyImageReplacement(img, translatedBase64, fromCache = false, { sendLog } = {}) {
        if (!img || !translatedBase64 || img.dataset.translated === 'true') return null;
        if (!img.parentNode) {
            if (typeof sendLog === 'function') sendLog('warn', 'REPLACE_DETACHED', 'Imagem desconectada do DOM, ignorando', {});
            return null;
        }

        const origCleanUrl = getCleanUrl(getRawImageUrl(img));
        const pictureParent = img.closest('picture');
        if (pictureParent) pictureParent.querySelectorAll('source').forEach((source) => source.remove());
        ['loading', 'data-src', 'data-lazy', 'data-original', 'srcset', 'sizes'].forEach((attribute) => img.removeAttribute(attribute));
        if (img.dataset.src) delete img.dataset.src;
        if (img.dataset.lazySrc) delete img.dataset.lazySrc;

        const newImg = img.cloneNode(true);
        newImg.src = translatedBase64;
        newImg.dataset.translated = 'true';
        try {
            const classesToRemove = [];
            newImg.classList.forEach((className) => { if (/blur|backdrop/i.test(className)) classesToRemove.push(className); });
            classesToRemove.forEach((className) => newImg.classList.remove(className));
        } catch (_error) {}
        try {
            if (window.getComputedStyle(img).position === 'static') newImg.style.setProperty('position', 'relative', 'important');
        } catch (_error) {}
        newImg.style.setProperty('z-index', '2', 'important');
        newImg.style.setProperty('filter', 'none', 'important');
        newImg.style.setProperty('backdrop-filter', 'none', 'important');
        newImg.style.setProperty('visibility', 'visible', 'important');
        newImg.style.setProperty('opacity', '1', 'important');
        newImg.style.setProperty('background', 'transparent', 'important');
        img.parentNode.replaceChild(newImg, img);

        if (origCleanUrl) {
            try {
                document.querySelectorAll('img').forEach((twin) => {
                    if (twin !== newImg && twin !== img && twin.dataset.translated !== 'true' && getCleanUrl(getRawImageUrl(twin)) === origCleanUrl && isBackdropOrBlurredImage(twin)) {
                        twin.src = translatedBase64;
                        twin.dataset.translated = 'true';
                        twin.style.setProperty('z-index', '0', 'important');
                        twin.style.setProperty('pointer-events', 'none', 'important');
                    }
                });
            } catch (_error) {}
        }

        const flashColor = fromCache ? 'rgba(76,175,80,0.5)' : 'rgba(200,30,30,0.55)';
        const flashDuration = fromCache ? 1200 : 2300;
        const overlay = document.createElement('div');
        document.body.appendChild(overlay);
        const positionOverlay = () => {
            const rect = newImg.getBoundingClientRect();
            overlay.style.top = `${rect.top}px`; overlay.style.left = `${rect.left}px`;
            overlay.style.width = `${rect.width}px`; overlay.style.height = `${rect.height}px`;
        };
        overlay.style.cssText = `position:fixed;background:${flashColor};border-radius:3px;z-index:2147483646;pointer-events:none;opacity:0;transition:opacity 0.35s ease;`;
        positionOverlay();
        const onScroll = () => positionOverlay();
        window.addEventListener('scroll', onScroll, { passive: true });
        requestAnimationFrame(() => requestAnimationFrame(() => { overlay.style.opacity = '1'; }));
        setTimeout(() => {
            overlay.style.transition = 'opacity 0.7s ease'; overlay.style.opacity = '0';
            setTimeout(() => { window.removeEventListener('scroll', onScroll); overlay.remove(); }, 720);
        }, flashDuration);
        return newImg;
    }

    globalScope.MangaTranslatorDomReplace = Object.freeze({ getCleanUrl, isBackdropOrBlurredImage, getScanEligibleImages, applyImageReplacement });
})(typeof window !== 'undefined' ? window : self);
