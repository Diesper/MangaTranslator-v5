// reader.js — Manga Translator v3.1

const urlParams  = new URLSearchParams(window.location.search);
const chapterId  = urlParams.get('id');
const container  = document.getElementById('reader-container');
const titleEl    = document.getElementById('chapter-title');
const counterEl  = document.getElementById('page-counter');
const fillEl     = document.getElementById('read-progress-fill');
const sliderEl   = document.getElementById('width-slider');
const widthValEl = document.getElementById('width-val');

let pageWraps  = []; 
let totalPages = 0;
let currentReadWidth = 800;

document.getElementById('close-btn').addEventListener('click', (e) => {
    e.preventDefault();
    window.close();
});

function applyWidth(px) {
    currentReadWidth = px;
    widthValEl.textContent = px + 'px';
    container.style.maxWidth = px + 'px';
    container.style.margin = '0 auto';
    try { localStorage.setItem('readerWidth', px); } catch(e) {}
}

sliderEl.addEventListener('input', () => applyWidth(parseInt(sliderEl.value)));

try {
    const saved = parseInt(localStorage.getItem('readerWidth'));
    if (saved >= 400 && saved <= 1200) {
        sliderEl.value = saved;
        applyWidth(saved);
    } else { applyWidth(800); }
} catch(e) { applyWidth(800); }

const pageVisibilityRatios = new Map();

const observer = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
        const idx = parseInt(entry.target.dataset.pageIdx, 10);
        if (!isNaN(idx)) {
            pageVisibilityRatios.set(idx, entry.isIntersecting ? entry.intersectionRatio : 0);
        }
    });

    let mostVisibleIdx = null;
    let maxRatio = 0;
    pageVisibilityRatios.forEach((ratio, idx) => {
        if (ratio > maxRatio) {
            maxRatio = ratio;
            mostVisibleIdx = idx;
        }
    });

    if (mostVisibleIdx !== null) updateCounter(mostVisibleIdx + 1);
}, { threshold: Array.from({ length: 21 }, (_, i) => i * 0.05) });

function updateCounter(currentPage) {
    counterEl.textContent = `${currentPage} / ${totalPages}`;
    if (totalPages > 0) {
        fillEl.style.width = Math.round((currentPage / totalPages) * 100) + '%';
    }
}

document.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
        e.preventDefault();
        window.scrollBy({ top: window.innerHeight * 0.88, behavior: 'smooth' });
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
        e.preventDefault();
        window.scrollBy({ top: -window.innerHeight * 0.88, behavior: 'smooth' });
    } else if (e.key === 'f' || e.key === 'F') {
        if (!document.fullscreenElement) {
            document.documentElement.requestFullscreen().catch(() => {});
        } else {
            document.exitFullscreen().catch(() => {});
        }
    } else if (e.key === 'Home') {
        e.preventDefault();
        window.scrollTo({ top: 0, behavior: 'smooth' });
    } else if (e.key === 'End') {
        e.preventDefault();
        window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
    }
});

// ── Ponte com o armazenamento do background ──────────────────────────────────
// As páginas vivem no IndexedDB da extensão (storage-manager.js), gravadas pelo
// background. O leitor pede só o ÍNDICE (metadados, sem Base64) e busca cada
// página quando ela entra na janela de pré-carregamento.
if (!chapterId) {
    titleEl.textContent = 'ID inválido';
    container.innerHTML = '<div id="empty-msg">Nenhum capítulo especificado na URL.</div>';
} else {
    chrome.storage.local.get(['chapterList', `${chapterId}_images`], async (data) => {
        const list    = data.chapterList || [];
        const chapter = list.find(c => c.id === chapterId);

        if (chapter) {
            titleEl.textContent = chapter.title;
            document.title      = chapter.title + ' — Leitor Offline';
        } else {
            titleEl.textContent = 'Capítulo não encontrado';
        }

        // Migração idempotente e índice de páginas (sem blobs)
        await smRequest({ action: 'SM_MIGRATE_CHAPTER', chapterId });
        const pageIndexResp = await smRequest({ action: 'SM_PAGE_INDEX', chapterId });

        // Fallback legado: instalação que ainda não migrou este capítulo
        const legacyImages = data[`${chapterId}_images`] || {};
        const hasNewStore = !!(pageIndexResp && pageIndexResp.ok && (pageIndexResp.pages || []).length > 0);

        const indices = hasNewStore
            ? pageIndexResp.pages.map(p => p.pageIndex)
            : Object.keys(legacyImages).map(Number).sort((a, b) => a - b);

        totalPages = indices.length;

        // Resolve o Base64 de UMA página, sob demanda.
        async function loadPageDataUrl(imgIdx) {
            if (hasNewStore) {
                const resp = await smRequest({ action: 'SM_GET_PAGE', chapterId, pageIndex: imgIdx });
                return (resp && resp.ok && resp.dataUrl) ? resp.dataUrl : null;
            }
            return legacyImages[imgIdx] || null;
        }

        if (indices.length === 0) {
            container.innerHTML = '<div id="empty-msg">Nenhuma imagem salva neste capítulo.</div>';
            counterEl.textContent = '0 / 0';
            return;
        }

        updateCounter(1);

        const PRELOAD_MARGIN = '200%'; // Load images 2 viewport heights ahead
        const UNLOAD_MARGIN = '500%';  // Unload images 5 viewport heights away
        const loadedUrls = new Map(); // pageIdx -> objectURL

        // Create all wrappers but defer image loading
        indices.forEach((idx, arrayPos) => {
            const wrap = document.createElement('div');
            wrap.className = 'reader-page-wrap';
            wrap.dataset.pageIdx = arrayPos;
            wrap.dataset.imgIdx = idx;
            // Set minimum height for scroll estimation
            wrap.style.minHeight = '400px';

            const img = document.createElement('img');
            img.className = 'reader-page';
            img.alt = 'Página ' + (arrayPos + 1);
            img.draggable = false;
            img.loading = 'lazy';
            // Don't set src yet — observer will handle it
            img.dataset.pendingSrc = '1';
            wrap.appendChild(img);

            const label = document.createElement('div');
            label.className = 'page-label';
            label.textContent = `Página ${arrayPos + 1}`;
            wrap.appendChild(label);

            container.appendChild(wrap);
            pageWraps.push(wrap);
            
            observer.observe(wrap);
        });

        // Lazy loading observer
        const loadObserver = new IntersectionObserver((entries) => {
            entries.forEach(async (entry) => {
                if (!entry.isIntersecting) return;
                const wrap = entry.target;
                const imgIdx = parseInt(wrap.dataset.imgIdx, 10);
                const img = wrap.querySelector('img');
                if (!img || !img.dataset.pendingSrc) return;

                // Marca antes do await: o observer pode disparar de novo enquanto
                // a página ainda está sendo buscada no background.
                img.dataset.pendingSrc = 'loading';
                const dataUrl = await loadPageDataUrl(imgIdx);
                if (!dataUrl) { img.dataset.pendingSrc = '1'; return; }

                // A página pode ter saído da tela durante a busca
                if (img.dataset.pendingSrc !== 'loading') return;

                img.src = dataUrl;
                delete img.dataset.pendingSrc;
                img.onload = () => { wrap.style.minHeight = ''; };
            });
        }, { rootMargin: PRELOAD_MARGIN });

        // ── Descarregamento (virtualização real) ─────────────────────────────
        // Sem isto, rolar um capítulo de 200 páginas acabava com TODAS as páginas
        // em memória: o consumo passava a depender do tamanho do capítulo, não da
        // janela visível. Páginas que saem de 5 viewports de distância têm o src
        // liberado e voltam a ser placeholders com altura preservada.
        const unloadObserver = new IntersectionObserver((entries) => {
            entries.forEach(entry => {
                if (entry.isIntersecting) return;
                const wrap = entry.target;
                const img = wrap.querySelector('img');
                if (!img || img.dataset.pendingSrc || !img.getAttribute('src')) return;

                // Congela a altura atual para o scroll não "pular" ao descarregar
                const currentHeight = wrap.offsetHeight;
                if (currentHeight > 0) wrap.style.minHeight = currentHeight + 'px';

                img.removeAttribute('src');
                img.dataset.pendingSrc = '1';
            });
        }, { rootMargin: UNLOAD_MARGIN });

        pageWraps.forEach(wrap => {
            loadObserver.observe(wrap);
            unloadObserver.observe(wrap);
        });
    });
}

