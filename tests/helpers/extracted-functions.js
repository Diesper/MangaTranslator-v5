/**
 * extracted-functions.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Re-implementa as funções puras do content_manga.js para testes isolados.
 *
 * MOTIVO: content_manga.js é um IIFE que roda em ambiente de extensão Chrome.
 * Funções como `canonicalTitle` e `playErrorSound` ficam dentro do escopo da
 * closure e não são exportadas. Este arquivo espelha essas implementações para
 * que possam ser testadas sem carregar o content script inteiro.
 *
 * MANUTENÇÃO: Se canonicalTitle ou playErrorSound mudarem em content_manga.js,
 * atualize aqui também. A suíte de testes detectará divergências.
 */

// ── canonicalTitle ────────────────────────────────────────────────────────────
// Normaliza o título da aba para uso como chave de agrupamento de capítulos.
// Versão v3.2 — regex expandida para tratar variações reais de sites de mangá.
function canonicalTitle(t) {
    return (t || '')
        // CORREÇÃO v3.2: Antes a regex era /^\d+[\s.\-–—:|]+/ — só removia prefixos
        // NUMÉRICOS PUROS (ex: "1050 - Title"). Não funcionava para "Cap 5: Title"
        // porque "Cap" começa com letra, não dígito.
        // NOVO: (?:[A-Za-z]+\.?\s+)? torna o prefixo textual opcional, permitindo
        // remover "Cap 5: ", "Ch. 12 ", "Vol. 3: " além dos numéricos puros.
        .replace(/^(?:[A-Za-z]+\.?\s+)?\d+[\s.\-–—:|]+/, '')
        // CORREÇÃO v3.2: Remove sufixo de site no final "| Site" ou " - Site"
        // Exemplo: "One Piece Cap 1050 | Ler" → "One Piece Cap 1050"
        //          "One Piece Cap 1050 - Mangás" → "One Piece Cap 1050"
        // Isso garante que o mesmo capítulo visitado em sessões com títulos
        // ligeiramente diferentes (sufixo do site variando) produza a mesma chave.
        .replace(/\s+[-|–—]\s+.+$/, '')
        .replace(/[|–—•·\[\]()\u00AB\u00BB]/g, ' ') // Substitui separadores por espaço
        .replace(/\s*[-:]\s*$/, '')                  // Remove traço/dois-pontos no fim
        .replace(/\s{2,}/g, ' ')                     // Colapsa espaços múltiplos
        .trim()
        .toLowerCase()
        .slice(0, 80);
}

// ── playErrorSound ────────────────────────────────────────────────────────────
// Síntese procedural: dois pulsos sawtooth descendentes (300Hz → 150Hz).
// Versão simplificada para verificação de assinatura da API de áudio.
function playErrorSound(audioCtxFactory) {
    try {
        const audioCtx = audioCtxFactory
            ? audioCtxFactory()
            : new (window.AudioContext || window.webkitAudioContext)();

        [0, 0.2].forEach((t, i) => {
            const osc  = audioCtx.createOscillator();
            const gain = audioCtx.createGain();
            osc.connect(gain);
            gain.connect(audioCtx.destination);
            osc.type = 'sawtooth';
            osc.frequency.setValueAtTime([300, 150][i], audioCtx.currentTime + t);
            gain.gain.setValueAtTime(0, audioCtx.currentTime + t);
            gain.gain.linearRampToValueAtTime(0.4,   audioCtx.currentTime + t + 0.04);
            gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + t + 0.28);
            osc.start(audioCtx.currentTime + t);
            osc.stop(audioCtx.currentTime + t + 0.3);
        });
    } catch (e) { /* silencioso por design */ }
}

// ── waitForDownload (background.js) ──────────────────────────────────────────
// Extração para testar o padrão de listener com cleanup garantido.
function waitForDownload(downloadsMock, id, onComplete, onError) {
    let safetyTimer;
    function handler(delta) {
        if (delta.id !== id) return;
        if (delta.state?.current === 'complete') {
            clearTimeout(safetyTimer);
            downloadsMock.onChanged.removeListener(handler);
            onComplete(id);
        } else if (delta.state?.current === 'interrupted') {
            clearTimeout(safetyTimer);
            downloadsMock.onChanged.removeListener(handler);
            if (onError) onError(new Error(`Download ${id} interrupted`));
        }
    }
    downloadsMock.onChanged.addListener(handler);
    safetyTimer = setTimeout(() => {
        downloadsMock.onChanged.removeListener(handler);
        if (onError) onError(new Error('Timeout'));
    }, 600_000);
    return handler; // retorna para inspeção em testes
}

// ── fallbackSearchRegex ───────────────────────────────────────────────────────
// Isola a lógica de escape de regex do fallbackSearch (background.js).
// Bug #14 Fix: regex /[.*+?^${}()|[\]\\]/g — correta para todos os paths.
function escapeForRegex(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

module.exports = {
    canonicalTitle,
    playErrorSound,
    waitForDownload,
    escapeForRegex,
};
