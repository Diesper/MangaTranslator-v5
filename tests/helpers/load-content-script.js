/**
 * load-content-script.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Configura o ambiente JSDOM para testes comportamentais do content_manga.js.
 *
 * PROBLEMA: content_manga.js é um IIFE que:
 * 1. Roda imediatamente ao ser carregado (via require)
 * 2. Registra listeners no chrome.runtime.onMessage
 * 3. Acessa window.location.hostname para verificar whitelist
 * 4. Chama chrome.storage.local.get(['enabledDomains']) assincronamente
 *
 * Esta função configura tudo na ordem certa para que os testes funcionem.
 */

const path = require('path');
const fs   = require('fs');
// Portable root finder — works regardless of where this file is placed in the tree.
function _findRoot(d) {
    if (fs.existsSync(path.join(d, 'extension', 'manifest.json'))) return d;
    const p = path.dirname(d);
    return p === d ? process.cwd() : _findRoot(p);
}
const ROOT = _findRoot(__dirname);


const GTC_FINGERPRINT_PATH = path.join(ROOT, 'extension/gtc-fingerprint.js');
const CM_GTC_CLIENT_PATH = path.join(ROOT, 'extension/cm-gtc-client.js');
const CM_DOM_REPLACE_PATH = path.join(ROOT, 'extension/cm-dom-replace.js');
const CM_CHAPTER_PATH = path.join(ROOT, 'extension/cm-chapter.js');
const CM_AUTO_RESTORE_PATH = path.join(ROOT, 'extension/cm-auto-restore.js');
const CONTENT_MANGA_PATH = path.join(ROOT, 'extension/content_manga.js');

/**
 * Carrega o content script em ambiente JSDOM com estado controlado.
 *
 * @param {Object} options
 * @param {string}   options.hostname         - Hostname simulado (default: 'testmanga.com')
 * @param {string[]} options.enabledDomains   - Domínios na whitelist (default: [hostname])
 * @param {string[]} options.bannedImages     - URLs banidas para o hostname
 * @param {Array}    options.domImages        - Array de { src, width, height, className, attributes } para criar no DOM
 * @returns {Promise<Object>}  { listeners, getState }
 */
async function loadContentScript({
    hostname = 'testmanga.com',
    enabledDomains = null,
    bannedImages = [],
    domImages = [],
} = {}) {
    // 1. Configura window.location
    Object.defineProperty(window, 'location', {
        value: {
            hostname,
            href: `https://${hostname}/chapter/1`,
            pathname: '/chapter/1',
        },
        writable: true,
        configurable: true,
    });

    // 2. window === window.top (garantido em JSDOM — boa prática tornar explícito)
    // Em JSDOM, window.top === window por padrão.

    // 3. Configura storage com whitelist e banidas
    const domains = enabledDomains ?? [hostname];
    const storageInit = {
        enabledDomains: domains,
        [`bannedImages_${hostname}`]: bannedImages,
        customPrompt: 'Teste prompt',
    };
    await global.chrome.storage.local.set(storageInit);

    // 4. Constrói DOM com imagens de teste
    const imgTags = domImages.map(({ src, width, height, className = '', attributes = {} }, i) => {
        const extraAttrs = Object.entries(attributes)
            .map(([key, value]) => `${key}="${String(value)}"`)
            .join(' ');
        const classAttr = className ? ` class="${className}"` : '';
        const extra = extraAttrs ? ` ${extraAttrs}` : '';
        return `<img src="${src}" data-testid="img-${i}"${classAttr}${extra} width="${width}" height="${height}">`;
    }).join('\n');
    document.body.innerHTML = imgTags || '';

    // 5. Injeta naturalWidth/naturalHeight (JSDOM não renderiza imagens reais)
    document.querySelectorAll('img').forEach((img, i) => {
        const spec = domImages[i] || {};
        Object.defineProperty(img, 'naturalWidth',  { value: spec.width  || 0, configurable: true });
        Object.defineProperty(img, 'naturalHeight', { value: spec.height || 0, configurable: true });
        Object.defineProperty(img, 'complete',      { value: true,             configurable: true });
    });

    // 6. Espelha dependências globais da extensão no contexto de janela do JSDOM
    if (typeof global.crypto !== 'undefined' && !window.crypto) {
        Object.defineProperty(window, 'crypto', {
            value: global.crypto,
            configurable: true,
        });
    }
    if (typeof global.TextEncoder !== 'undefined' && !window.TextEncoder) {
        Object.defineProperty(window, 'TextEncoder', {
            value: global.TextEncoder,
            configurable: true,
        });
    }

    // 7. Limpa flag de idempotência para permitir re-injeção
    delete window.__manga_translator_content_injected;

    // 8. Carrega os módulos injetados pela extensão na ordem real do manifest
    jest.isolateModules(() => {
        require(GTC_FINGERPRINT_PATH);
        require(CM_GTC_CLIENT_PATH);
        require(CM_DOM_REPLACE_PATH);
        require(CM_CHAPTER_PATH);
        require(CM_AUTO_RESTORE_PATH);
        require(CONTENT_MANGA_PATH);
    });

    // 9. Aguarda a inicialização assíncrona do content script de forma determinística
    const shouldCreateButton = domains.includes(hostname);
    const startedAt = Date.now();
    while (Date.now() - startedAt < 250) {
        if (!shouldCreateButton || document.getElementById('manga-translator-trigger')) break;
        await new Promise(r => setTimeout(r, 10));
    }

    // 10. Retorna helpers para os testes
    return {
        /**
         * Dispara uma mensagem para o listener do content script.
         * Simula chrome.tabs.sendMessage do background ou popup.
         */
        sendMessage(action, extra = {}) {
            return new Promise((resolve) => {
                const listeners = global.chrome.runtime._messageListeners ?? [];
                const payload = { action, ...extra };
                listeners.forEach(fn => fn(payload, { tab: { id: 1 } }, resolve));
                // Se nenhum listener chamou resolve, resolve em null
                setTimeout(() => resolve(null), 50);
            });
        },

        /** Retorna o elemento DOM do botão flutuante (se existir) */
        getButton() {
            return document.getElementById('manga-translator-trigger');
        },

        /** Retorna o mainContent do botão */
        getMainContent() {
            return document.getElementById('manga-main-content');
        },
    };
}

module.exports = { loadContentScript };
