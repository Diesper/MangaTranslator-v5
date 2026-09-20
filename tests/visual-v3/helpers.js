'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// helpers.js — Fábricas de imageData controladas para os testes
// Gera Uint8ClampedArray RGBA representando padrões de pixel determinísticos.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Cria uma imageData RGBA sólida de uma cor.
 * @param {number} width
 * @param {number} height
 * @param {number} r 0-255
 * @param {number} g 0-255
 * @param {number} b 0-255
 * @param {number} a 0-255
 * @returns {Uint8ClampedArray}
 */
function solidColor(width, height, r = 128, g = 128, b = 128, a = 255) {
    const data = new Uint8ClampedArray(width * height * 4);
    for (let i = 0; i < width * height; i++) {
        data[i * 4]     = r;
        data[i * 4 + 1] = g;
        data[i * 4 + 2] = b;
        data[i * 4 + 3] = a;
    }
    return data;
}

/**
 * Cria uma imageData com gradiente horizontal (esquerda escura → direita clara).
 * Simula arte de mangá (traços, screentones).
 */
function horizontalGradient(width, height) {
    const data = new Uint8ClampedArray(width * height * 4);
    for (let r = 0; r < height; r++) {
        for (let c = 0; c < width; c++) {
            const v = Math.round((c / (width - 1)) * 255);
            const i = (r * width + c) * 4;
            data[i]     = v;
            data[i + 1] = v;
            data[i + 2] = v;
            data[i + 3] = 255;
        }
    }
    return data;
}

/**
 * Cria uma imageData com padrão de xadrez (preto e branco).
 * Simula screentone de mangá.
 */
function checkerboard(width, height, cellSize = 4) {
    const data = new Uint8ClampedArray(width * height * 4);
    for (let r = 0; r < height; r++) {
        for (let c = 0; c < width; c++) {
            const v = ((Math.floor(r / cellSize) + Math.floor(c / cellSize)) % 2 === 0) ? 255 : 0;
            const i = (r * width + c) * 4;
            data[i]     = v;
            data[i + 1] = v;
            data[i + 2] = v;
            data[i + 3] = 255;
        }
    }
    return data;
}

/**
 * Cria imageData de uma "página de mangá" sintética:
 *   - Fundo branco (arte): toda a imagem
 *   - Balão de texto no centro: pixels pretos simulando texto
 *
 * Usado para testar que wHash/pHash são robustos ao texto no balão.
 *
 * @param {number} width
 * @param {number} height
 * @param {string} textPattern  'EN' (padrão H-e-l-l-o) ou 'PT' (padrão O-l-á)
 * @returns {Uint8ClampedArray}
 */
function mangaPage(width, height, textPattern = 'EN') {
    // Base: arte com gradiente suave (baixa frequência = dominante na LL Haar)
    const data = new Uint8ClampedArray(width * height * 4);
    for (let r = 0; r < height; r++) {
        for (let c = 0; c < width; c++) {
            // Arte: gradiente diagonal suave simulando sombreamento
            const artValue = Math.round(180 + 60 * Math.sin(r / height * Math.PI) * Math.cos(c / width * Math.PI));
            const i = (r * width + c) * 4;
            data[i] = data[i+1] = data[i+2] = artValue;
            data[i+3] = 255;
        }
    }

    // Balão de texto no centro (região de alta frequência)
    // EN: padrão de pixels representando "HELLO" (mais pixels preenchidos à esquerda)
    // PT: padrão de pixels representando "OLÁ"  (menos pixels, distribuição diferente)
    const balloonTop    = Math.floor(height * 0.35);
    const balloonBottom = Math.floor(height * 0.65);
    const balloonLeft   = Math.floor(width  * 0.25);
    const balloonRight  = Math.floor(width  * 0.75);

    // Fundo do balão: branco
    for (let r = balloonTop; r < balloonBottom; r++) {
        for (let c = balloonLeft; c < balloonRight; c++) {
            const i = (r * width + c) * 4;
            data[i] = data[i+1] = data[i+2] = 255; // branco
        }
    }

    // Texto simulado: sequência de pixels pretos em padrão diferente por idioma
    // EN: preenche colunas ímpares da metade esquerda (simula H-E-L-L-O mais largo)
    // PT: preenche colunas pares da metade direita (simula O-L-Á mais estreito)
    const textRow = Math.floor((balloonTop + balloonBottom) / 2);
    const textHeight = Math.max(1, Math.floor((balloonBottom - balloonTop) * 0.4));

    if (textPattern === 'EN') {
        // "HELLO!" — texto longo, ocupa 70% da largura do balão
        for (let dr = -textHeight; dr <= textHeight; dr++) {
            for (let dc = 0; dc < Math.floor((balloonRight - balloonLeft) * 0.7); dc++) {
                if (dc % 3 !== 1) { // padrão de letra
                    const r = textRow + dr;
                    const c = balloonLeft + dc;
                    if (r >= 0 && r < height && c >= 0 && c < width) {
                        const i = (r * width + c) * 4;
                        data[i] = data[i+1] = data[i+2] = 10; // quase preto
                    }
                }
            }
        }
    } else {
        // "OLÁ!" — texto curto, ocupa 40% da largura do balão
        for (let dr = -textHeight; dr <= textHeight; dr++) {
            for (let dc = 0; dc < Math.floor((balloonRight - balloonLeft) * 0.4); dc++) {
                if (dc % 4 !== 2) { // padrão de letra diferente
                    const r = textRow + dr;
                    const c = balloonLeft + Math.floor((balloonRight - balloonLeft) * 0.3) + dc;
                    if (r >= 0 && r < height && c >= 0 && c < width) {
                        const i = (r * width + c) * 4;
                        data[i] = data[i+1] = data[i+2] = 15; // quase preto
                    }
                }
            }
        }
    }

    return data;
}

/**
 * Cria imageData completamente diferente (ruído pseudo-aleatório determinístico).
 */
function noise(width, height, seed = 42) {
    const data = new Uint8ClampedArray(width * height * 4);
    let s = seed;
    for (let i = 0; i < width * height; i++) {
        // LCG simples para determinismo
        s = (s * 1664525 + 1013904223) & 0xffffffff;
        const v = (s >>> 24) & 0xff;
        data[i * 4]     = v;
        data[i * 4 + 1] = (v + 85) & 0xff;
        data[i * 4 + 2] = (v + 170) & 0xff;
        data[i * 4 + 3] = 255;
    }
    return data;
}

/**
 * Cria imageData idêntica mas com brilho globalmente alterado (+delta).
 * Usado para testar robustez do pHash (DC excluído).
 */
function brightnessShifted(baseData, delta = 30) {
    const data = new Uint8ClampedArray(baseData.length);
    for (let i = 0; i < baseData.length; i++) {
        if ((i % 4) === 3) { data[i] = baseData[i]; continue; } // alpha inalterado
        data[i] = Math.min(255, Math.max(0, baseData[i] + delta));
    }
    return data;
}

/**
 * Extrai a sub-imageData de um bloco dentro de um canvas maior.
 * Usado para verificar que _blockWHash16 processa a região correta.
 */
function extractBlock(fullData, fullWidth, startRow, startCol, blockH, blockW) {
    const out = new Uint8ClampedArray(blockH * blockW * 4);
    for (let r = 0; r < blockH; r++) {
        for (let c = 0; c < blockW; c++) {
            const srcIdx = ((startRow + r) * fullWidth + (startCol + c)) * 4;
            const dstIdx = (r * blockW + c) * 4;
            out[dstIdx]     = fullData[srcIdx];
            out[dstIdx + 1] = fullData[srcIdx + 1];
            out[dstIdx + 2] = fullData[srcIdx + 2];
            out[dstIdx + 3] = fullData[srcIdx + 3];
        }
    }
    return out;
}

/**
 * Injeta "texto" no centro de uma imageData existente (destrói pixels centrais).
 * Simula a diferença entre versão EN e PT da mesma página.
 */
function injectTextInCenter(data, width, height, textSeed = 0) {
    const out = new Uint8ClampedArray(data);
    const midR = Math.floor(height * 0.4);
    const midC = Math.floor(width  * 0.25);
    const textW = Math.floor(width * 0.5);
    const textH = Math.floor(height * 0.2);
    let s = textSeed;
    for (let r = midR; r < midR + textH; r++) {
        for (let c = midC; c < midC + textW; c++) {
            s = (s * 1664525 + 1013904223) & 0xffffffff;
            const v = (s >>> 26) < 3 ? 0 : 255; // maioria branca, alguns pixels pretos (texto)
            const i = (r * width + c) * 4;
            out[i] = out[i+1] = out[i+2] = v;
        }
    }
    return out;
}

/**
 * Verifica se uma string é hex lowercase válida de comprimento esperado.
 */
function isValidHex(str, expectedLen) {
    if (typeof str !== 'string') return false;
    if (expectedLen !== undefined && str.length !== expectedLen) return false;
    return /^[0-9a-f]+$/.test(str);
}

/**
 * Conta quantos bits são 1 em uma string hex.
 */
function countSetBits(hexStr) {
    let count = 0;
    for (const ch of hexStr) {
        let n = parseInt(ch, 16);
        while (n) { count += n & 1; n >>>= 1; }
    }
    return count;
}

module.exports = {
    solidColor, horizontalGradient, checkerboard, mangaPage,
    noise, brightnessShifted, extractBlock, injectTextInCenter,
    isValidHex, countSetBits,
};
