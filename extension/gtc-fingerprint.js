'use strict';

(function attachGtcFingerprintApi(rootScope) {

    let fallbackIdCounter = 0;

    function utf8Encode(input) {
        const text = String(input);
        const bytes = [];
        for (let i = 0; i < text.length; i += 1) {
            let codePoint = text.charCodeAt(i);
            if (codePoint >= 0xD800 && codePoint <= 0xDBFF && i + 1 < text.length) {
                const low = text.charCodeAt(i + 1);
                if (low >= 0xDC00 && low <= 0xDFFF) {
                    codePoint = 0x10000 + ((codePoint - 0xD800) << 10) + (low - 0xDC00);
                    i += 1;
                }
            }
            if (codePoint <= 0x7F) bytes.push(codePoint);
            else if (codePoint <= 0x7FF) bytes.push(0xC0 | (codePoint >> 6), 0x80 | (codePoint & 0x3F));
            else if (codePoint <= 0xFFFF) bytes.push(0xE0 | (codePoint >> 12), 0x80 | ((codePoint >> 6) & 0x3F), 0x80 | (codePoint & 0x3F));
            else bytes.push(0xF0 | (codePoint >> 18), 0x80 | ((codePoint >> 12) & 0x3F), 0x80 | ((codePoint >> 6) & 0x3F), 0x80 | (codePoint & 0x3F));
        }
        return bytes;
    }

    function sha256Fallback(input) {
        const bytes = utf8Encode(input);
        const bitLength = bytes.length * 8;
        bytes.push(0x80);
        while ((bytes.length % 64) !== 56) bytes.push(0);
        const high = Math.floor(bitLength / 0x100000000);
        const low = bitLength >>> 0;
        [high, low].forEach(word => bytes.push((word >>> 24) & 0xFF, (word >>> 16) & 0xFF, (word >>> 8) & 0xFF, word & 0xFF));

        const constants = [
            0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
            0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
            0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
            0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
            0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
            0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
            0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
            0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
        ];
        let h0 = 0x6a09e667, h1 = 0xbb67ae85, h2 = 0x3c6ef372, h3 = 0xa54ff53a;
        let h4 = 0x510e527f, h5 = 0x9b05688c, h6 = 0x1f83d9ab, h7 = 0x5be0cd19;
        const words = new Uint32Array(64);
        for (let offset = 0; offset < bytes.length; offset += 64) {
            for (let i = 0; i < 16; i += 1) {
                const j = offset + i * 4;
                words[i] = (bytes[j] << 24) | (bytes[j + 1] << 16) | (bytes[j + 2] << 8) | bytes[j + 3];
            }
            for (let i = 16; i < 64; i += 1) {
                const x = words[i - 15];
                const y = words[i - 2];
                const s0 = ((x >>> 7) | (x << 25)) ^ ((x >>> 18) | (x << 14)) ^ (x >>> 3);
                const s1 = ((y >>> 17) | (y << 15)) ^ ((y >>> 19) | (y << 13)) ^ (y >>> 10);
                words[i] = (words[i - 16] + s0 + words[i - 7] + s1) >>> 0;
            }
            let a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, h = h7;
            for (let i = 0; i < 64; i += 1) {
                const s1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
                const choose = (e & f) ^ (~e & g);
                const temp1 = (h + s1 + choose + constants[i] + words[i]) >>> 0;
                const s0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
                const majority = (a & b) ^ (a & c) ^ (b & c);
                const temp2 = (s0 + majority) >>> 0;
                h = g; g = f; f = e; e = (d + temp1) >>> 0;
                d = c; c = b; b = a; a = (temp1 + temp2) >>> 0;
            }
            h0 = (h0 + a) >>> 0; h1 = (h1 + b) >>> 0; h2 = (h2 + c) >>> 0; h3 = (h3 + d) >>> 0;
            h4 = (h4 + e) >>> 0; h5 = (h5 + f) >>> 0; h6 = (h6 + g) >>> 0; h7 = (h7 + h) >>> 0;
        }
        return [h0, h1, h2, h3, h4, h5, h6, h7].map(word => word.toString(16).padStart(8, '0')).join('');
    }

    function generateId(prefix = '', { cryptoImpl } = {}) {
        const cryptoRef = cryptoImpl === undefined ? rootScope.crypto : cryptoImpl;
        if (cryptoRef && typeof cryptoRef.randomUUID === 'function') return prefix + cryptoRef.randomUUID();
        if (cryptoRef && typeof cryptoRef.getRandomValues === 'function') {
            const bytes = cryptoRef.getRandomValues(new Uint8Array(16));
            bytes[6] = (bytes[6] & 0x0F) | 0x40;
            bytes[8] = (bytes[8] & 0x3F) | 0x80;
            const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
            return `${prefix}${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
        }
        fallbackIdCounter = (fallbackIdCounter + 1) >>> 0;
        return `${prefix}${Date.now().toString(36)}-${fallbackIdCounter.toString(36)}-${Math.random().toString(36).slice(2, 14)}`;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // SHA-256 fingerprint (visual-v1 / visual-v2)
    // ─────────────────────────────────────────────────────────────────────────

    function buildFingerprintSource({
        width = 0,
        height = 0,
        visualHash = '',
        pixelSample = '',
        cleanUrl = '',
        hasVisualPixels = false,
    } = {}) {
        const dims = `${width || 0}:${height || 0}`;
        if (visualHash) {
            return `v2:${dims}:${visualHash}`;
        }
        if (hasVisualPixels && pixelSample && pixelSample !== 'nopixels') {
            return `${dims}:pixels:${pixelSample}`;
        }
        return `${dims}:url:${cleanUrl || ''}:nopixels`;
    }

    async function hashStringSha256(input, { cryptoImpl, TextEncoderImpl } = {}) {
        const cryptoRef = cryptoImpl === undefined ? rootScope.crypto : cryptoImpl;
        const Encoder = TextEncoderImpl === undefined ? rootScope.TextEncoder : TextEncoderImpl;
        if (!cryptoRef || !cryptoRef.subtle || !Encoder) return sha256Fallback(input);
        const msgBuffer = new Encoder().encode(String(input));
        const hashBuffer = await cryptoRef.subtle.digest('SHA-256', msgBuffer);
        return Array.from(new Uint8Array(hashBuffer))
            .map(b => b.toString(16).padStart(2, '0'))
            .join('');
    }

    async function createFingerprintFromDescriptor(descriptor, deps = {}) {
        const source = buildFingerprintSource(descriptor);
        return hashStringSha256(source, deps);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // dHash — Difference Hash  (perceptual, 9×8 → 64 bits → 16 hex chars)
    //
    // visual-v2: complemento ao SHA-256 para lookup CORS-resiliente.
    // LIMITAÇÃO CONHECIDA: gradientes horizontais são afetados por texto em
    // balões → 50-75% do hash corrompido em matching cross-language.
    // Para matching cross-language, usar wHash (visual-v3).
    // ─────────────────────────────────────────────────────────────────────────

    function calculateDHash(imageData) {
        if (!imageData || imageData.length < 9 * 8 * 4) {
            throw new Error('calculateDHash: imageData precisa de pelo menos 9×8×4=288 bytes (canvas 9×8 RGBA)');
        }

        const W = 9;
        const H = 8;

        const gray = new Float32Array(W * H);
        for (let i = 0; i < W * H; i++) {
            const b = i * 4;
            gray[i] = 0.299 * imageData[b]
                    + 0.587 * imageData[b + 1]
                    + 0.114 * imageData[b + 2];
        }

        let hex = '';
        for (let row = 0; row < H; row++) {
            let rowByte = 0;
            for (let col = 0; col < H; col++) {
                rowByte = (rowByte << 1) | (gray[row * W + col] > gray[row * W + col + 1] ? 1 : 0);
            }
            hex += rowByte.toString(16).padStart(2, '0');
        }

        return hex; // 16 chars hex lowercase
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Haar Wavelet 1D/2D — primitivas internas
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Transformada Haar 1D: [a0,a1,...,aN-1] → [avg0,...,avgN/2-1, diff0,...,diffN/2-1]
     * Low-pass (médias) ficam na primeira metade; high-pass (diferenças) na segunda.
     *
     * @param {Float32Array|ArrayLike} arr  array de entrada (tamanho n, potência de 2)
     * @param {number} n  tamanho do array
     * @returns {Float32Array}
     */
    function _haarDWT1D(arr, n) {
        const out  = new Float32Array(n);
        const half = n >> 1;
        for (let i = 0; i < half; i++) {
            out[i]        = (arr[2 * i]     + arr[2 * i + 1]) * 0.5; // low-pass
            out[i + half] = (arr[2 * i]     - arr[2 * i + 1]) * 0.5; // high-pass
        }
        return out;
    }

    /**
     * Transformada Haar 2D (1 nível) sobre matriz N×N (Float32Array, row-major).
     *
     * Resultado:
     *   quadrante superior esquerdo  (N/2 × N/2)  = LL  (low-low, aproximação)
     *   quadrante superior direito   (N/2 × N/2)  = LH  (bordas horizontais)
     *   quadrante inferior esquerdo  (N/2 × N/2)  = HL  (bordas verticais)
     *   quadrante inferior direito   (N/2 × N/2)  = HH  (detalhes diagonais — texto)
     *
     * Por que a LL captura arte e descarta texto:
     *   - Arte (traços, composição, painéis): energia concentrada em baixas frequências → LL
     *   - Texto em balões: detalhes locais de alta frequência → HH, descartado
     *
     * @param {Float32Array} matrix  array N×N row-major
     * @param {number} N  lado da matriz (potência de 2)
     * @returns {Float32Array}  mesma estrutura N×N com sub-bandas reorganizadas
     */
    function _haarDWT2D(matrix, N) {
        const buf = matrix.slice(); // cópia para não alterar o original

        // Passo 1: transformada 1D em cada linha
        for (let row = 0; row < N; row++) {
            const rowSlice = buf.subarray(row * N, (row + 1) * N);
            const transformed = _haarDWT1D(rowSlice, N);
            buf.set(transformed, row * N);
        }

        // Passo 2: transformada 1D em cada coluna
        const colBuf = new Float32Array(N);
        for (let col = 0; col < N; col++) {
            for (let row = 0; row < N; row++) colBuf[row] = buf[row * N + col];
            const transformed = _haarDWT1D(colBuf, N);
            for (let row = 0; row < N; row++) buf[row * N + col] = transformed[row];
        }

        return buf;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // wHash — Haar Wavelet Hash  (perceptual, 32×32 → LL 16×16 → 256 bits → 64 hex)
    //
    // Por que é melhor que dHash para matching cross-language em mangá:
    //   1. Preserva topologia espacial (DCT não preserva): painéis no mesmo lugar
    //      → LL idêntico mesmo com texto diferente
    //   2. Texto nos balões é energia de alta frequência → sub-banda HH → descartada
    //   3. Arte (traços, screentones, composição) é baixa frequência → sub-banda LL
    //
    // Threshold ótimo (256 bits, texto ~12% da imagem):
    //   Bits afetados pelo texto: 256 × 0.12 ≈ 30 bits
    //   Threshold para "mesma imagem cross-language": ≤ 40 bits (≤ 15.6%)
    //   Threshold conservador (deduplicação): ≤ 20 bits (≤ 7.8%)
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Calcula wHash (Haar Wavelet Hash) 256-bit a partir de imageData 32×32.
     *
     * Pipeline:
     *   imageData (32×32 RGBA, 4096 bytes)
     *   → grayscale BT.601 (Float32, 0–255)
     *   → Haar DWT 2D 1 nível (32×32 → sub-bandas LL/LH/HL/HH cada 16×16)
     *   → extrair sub-banda LL (primeiros 16×16 = 256 coeficientes)
     *   → mediana dos 256 coeficientes LL
     *   → bit[i] = 1 se LL[i] > mediana, 0 caso contrário
     *   → 256 bits empacotados como nibbles → 64 hex chars lowercase
     *
     * @param {Uint8ClampedArray} imageData  getImageData(0, 0, 32, 32).data  (4096 bytes)
     * @returns {string}  64 chars hex lowercase (256 bits)
     */
    function calculateWHash(imageData) {
        if (!imageData || imageData.length < 32 * 32 * 4) {
            throw new Error('calculateWHash: imageData precisa de pelo menos 32×32×4=4096 bytes');
        }

        const N = 32;

        // RGBA → grayscale (luminância BT.601)
        const gray = new Float32Array(N * N);
        for (let i = 0; i < N * N; i++) {
            const b = i * 4;
            gray[i] = 0.299 * imageData[b]
                    + 0.587 * imageData[b + 1]
                    + 0.114 * imageData[b + 2];
        }

        // Haar DWT 2D (1 nível): 32×32 → LL está no quadrante 16×16 superior esquerdo
        const dwt = _haarDWT2D(gray, N);

        // Extrair sub-banda LL: linhas 0..15, colunas 0..15
        const LL = new Float32Array(16 * 16);
        for (let row = 0; row < 16; row++) {
            for (let col = 0; col < 16; col++) {
                LL[row * 16 + col] = dwt[row * N + col];
            }
        }

        // Mediana dos 256 coeficientes LL (ordenação parcial para performance)
        const sorted = LL.slice().sort();
        const median = (sorted[127] + sorted[128]) * 0.5;

        // 256 bits → 64 hex chars (4 bits por char, nibble)
        let hex = '';
        for (let i = 0; i < 256; i += 4) {
            const nibble = ((LL[i]     > median ? 8 : 0) |
                            (LL[i + 1] > median ? 4 : 0) |
                            (LL[i + 2] > median ? 2 : 0) |
                            (LL[i + 3] > median ? 1 : 0));
            hex += nibble.toString(16);
        }

        return hex; // sempre 64 chars hex lowercase
    }

    // ─────────────────────────────────────────────────────────────────────────
    // pHash — DCT Perceptual Hash  (visual-v3, 32×32 → DCT → top-left 16×16 → 256 bits)
    //
    // Implementação separável DCT-II 2D:
    //   Fase 1: DCT 1D em cada linha (32 linhas × 16 frequências × 32 ops = 16384 ops)
    //   Fase 2: DCT 1D em cada coluna de frequência 0..15 (16 cols × 16 freq × 32 ops = 8192 ops)
    //   Total: ~25K multiply-adds → <0.5ms no content script
    //
    // Por que o DCT suprime texto em mangá:
    //   O texto nos balões é concentrado localmente → energia em altos coeficientes AC
    //   Os 16×16 coeficientes de baixa frequência capturam layout global (arte)
    //   O DC[0,0] representa brilho médio → excluído para robustez a variações de exposição
    //
    // Complemento ao wHash:
    //   wHash: preserva topologia espacial via Haar (melhor para layout estruturado)
    //   pHash: robusto a variações globais de cor/tonalidade via DCT
    //   Juntos: cobrem casos onde um hash falha isoladamente
    // ─────────────────────────────────────────────────────────────────────────

    // Tabela de cossenos pré-computada para DCT 32×32
    // cosTable[k * N + n] = cos(π·k·(2n+1)/(2N)), N=32
    // Lazy-initialized para não impactar carregamento da extensão
    let _dctCosTable = null;

    function _getDctCosTable() {
        if (_dctCosTable) return _dctCosTable;
        const N = 32;
        _dctCosTable = new Float32Array(N * N);
        for (let k = 0; k < N; k++) {
            for (let n = 0; n < N; n++) {
                _dctCosTable[k * N + n] = Math.cos(Math.PI * k * (2 * n + 1) / (2 * N));
            }
        }
        return _dctCosTable;
    }

    /**
     * Calcula pHash (DCT Perceptual Hash) 256-bit a partir de imageData 32×32.
     *
     * Pipeline:
     *   imageData (32×32 RGBA, 4096 bytes)
     *   → grayscale BT.601
     *   → DCT-II 2D separável (32×32) — tabela de cossenos pré-computada
     *   → coeficientes AC top-left 16×16 (excluindo DC[0,0] em [0,0])
     *   → mediana dos 255 coeficientes AC
     *   → bit[0]=0 (DC fixo), bit[1..255] = AC[i] > mediana
     *   → 256 bits → 64 hex chars
     *
     * @param {Uint8ClampedArray} imageData  getImageData(0, 0, 32, 32).data  (4096 bytes)
     * @returns {string}  64 chars hex lowercase (256 bits)
     */
    function calculatePHash(imageData) {
        if (!imageData || imageData.length < 32 * 32 * 4) {
            throw new Error('calculatePHash: imageData precisa de pelo menos 32×32×4=4096 bytes');
        }

        const N        = 32;
        const cosTable = _getDctCosTable();

        // RGBA → grayscale BT.601
        const gray = new Float32Array(N * N);
        for (let i = 0; i < N * N; i++) {
            const b = i * 4;
            gray[i] = 0.299 * imageData[b]
                    + 0.587 * imageData[b + 1]
                    + 0.114 * imageData[b + 2];
        }

        // Fatores de normalização DCT-II ortogonal
        const scale0 = 1.0 / Math.sqrt(N);    // α(k=0)
        const scale1 = Math.sqrt(2.0 / N);    // α(k>0)

        // ── Fase 1: DCT 1D em cada linha (j-dimension → frequência v) ────────
        // G[row][v] = α(v) · Σ_j f[row][j] · cos(π·v·(2j+1)/(2N))
        // Armazenado em dctRowPartial[row * 16 + v], apenas v=0..15
        const dctRowPartial = new Float32Array(N * 16);
        for (let row = 0; row < N; row++) {
            const rowOff = row * N;
            for (let v = 0; v < 16; v++) {
                let sum    = 0;
                const cosV = v * N;
                for (let j = 0; j < N; j++) {
                    sum += gray[rowOff + j] * cosTable[cosV + j];
                }
                dctRowPartial[row * 16 + v] = (v === 0 ? scale0 : scale1) * sum;
            }
        }

        // ── Fase 2: DCT 1D em cada coluna de frequência v (i-dimension → freq u) ─
        // F[u][v] = α(u) · Σ_i G[i][v] · cos(π·u·(2i+1)/(2N))
        // Armazenado em dct16[u * 16 + v]
        const dct16 = new Float32Array(16 * 16);
        for (let v = 0; v < 16; v++) {
            for (let u = 0; u < 16; u++) {
                let sum    = 0;
                const cosU = u * N;
                for (let i = 0; i < N; i++) {
                    sum += dctRowPartial[i * 16 + v] * cosTable[cosU + i];
                }
                dct16[u * 16 + v] = (u === 0 ? scale0 : scale1) * sum;
            }
        }

        // ── Mediana dos 255 coeficientes AC (exclui DC = dct16[0]) ───────────
        const acCoeffs = new Float32Array(255);
        for (let i = 1; i < 256; i++) {
            acCoeffs[i - 1] = dct16[i];
        }
        const sortedAC = acCoeffs.slice().sort((a, b) => a - b);
        const median   = (sortedAC[126] + sortedAC[127]) * 0.5;

        // ── 256 bits → 64 hex chars ──────────────────────────────────────────
        // bit[0] = 0 (DC excluído); bit[1..255] = AC[i] > mediana
        let hex = '';
        for (let i = 0; i < 256; i += 4) {
            let nibble = 0;
            for (let j = 0; j < 4; j++) {
                const idx = i + j;
                const bit = (idx === 0) ? 0 : (dct16[idx] > median ? 1 : 0);
                nibble    = (nibble << 1) | bit;
            }
            hex += nibble.toString(16);
        }

        return hex; // sempre 64 chars hex lowercase
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Hashes Regionais — Cantos (aproximação do RANSAC em JS puro)
    //
    // Divide a imagem em grid 3×3 de regiões 16×16 (canvas 48×48).
    // Calcula wHash 64-bit (8×8 LL) apenas dos 4 cantos onde texto raramente aparece.
    //
    // Complemento ao RANSAC:
    //   RANSAC (AKAZE): exclui keypoints de texto como outliers geometricamente inconsistentes
    //   Approach regional: usa conhecimento de domínio — texto fica no centro/balões, não nos cantos
    //   Implementável em JS puro sem OpenCV
    //
    // Grid de regiões 16×16 em canvas 48×48:
    //   [TL: (0,0)]    [TM: (0,16)]   [TR: (0,32)]
    //   [ML: (16,0)]   [MM: (16,16)]  [MR: (16,32)]
    //   [BL: (32,0)]   [BM: (32,16)]  [BR: (32,32)]
    //
    // Apenas TL, TR, BL, BR são usados (cantos com raridade de texto).
    // Match em ≥ 3/4 cantos = confirmação de identidade visual.
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * wHash simplificado (64-bit) de um bloco 16×16 extraído de imageData 48×48.
     * 1 nível Haar 2D → LL 8×8 → 64 bits → 16 hex chars.
     *
     * @param {Uint8ClampedArray} imageData  48×48×4 = 9216 bytes
     * @param {number} startRow  linha inicial do bloco no canvas 48×48
     * @param {number} startCol  coluna inicial do bloco no canvas 48×48
     * @returns {string}  16 chars hex lowercase (64 bits)
     */
    function _blockWHash16(imageData, startRow, startCol) {
        const FULL_W = 48;
        const BLOCK  = 16;

        // Extrair bloco 16×16 → grayscale
        const gray = new Float32Array(BLOCK * BLOCK);
        for (let r = 0; r < BLOCK; r++) {
            for (let c = 0; c < BLOCK; c++) {
                const pix = ((startRow + r) * FULL_W + (startCol + c)) * 4;
                gray[r * BLOCK + c] = 0.299 * imageData[pix]
                                    + 0.587 * imageData[pix + 1]
                                    + 0.114 * imageData[pix + 2];
            }
        }

        // Haar 2D 16×16 → LL está no quadrante 8×8 superior esquerdo
        const dwt = _haarDWT2D(gray, BLOCK);

        // Extrair LL 8×8
        const LL = new Float32Array(8 * 8);
        for (let r = 0; r < 8; r++) {
            for (let c = 0; c < 8; c++) {
                LL[r * 8 + c] = dwt[r * BLOCK + c];
            }
        }

        // Mediana → 64 bits → 16 hex chars
        const sorted = LL.slice().sort();
        const median = (sorted[31] + sorted[32]) * 0.5;

        let hex = '';
        for (let i = 0; i < 64; i += 4) {
            const nibble = ((LL[i]     > median ? 8 : 0) |
                            (LL[i + 1] > median ? 4 : 0) |
                            (LL[i + 2] > median ? 2 : 0) |
                            (LL[i + 3] > median ? 1 : 0));
            hex += nibble.toString(16);
        }

        return hex; // 16 chars hex
    }

    /**
     * Calcula wHash dos 4 cantos a partir de imageData 48×48.
     *
     * @param {Uint8ClampedArray} imageData  getImageData(0,0,48,48).data (9216 bytes)
     * @returns {{ topLeft: string, topRight: string, bottomLeft: string, bottomRight: string }}
     *   Cada campo: 16 chars hex (64 bits)
     */
    function calculateRegionalHashes(imageData) {
        if (!imageData || imageData.length < 48 * 48 * 4) {
            throw new Error('calculateRegionalHashes: imageData precisa de pelo menos 48×48×4=9216 bytes');
        }
        return {
            topLeft:     _blockWHash16(imageData, 0,  0),
            topRight:    _blockWHash16(imageData, 0,  32),
            bottomLeft:  _blockWHash16(imageData, 32, 0),
            bottomRight: _blockWHash16(imageData, 32, 32),
        };
    }

    /**
     * Verifica match regional: retorna true se ≥ minMatches dos 4 cantos coincidem
     * com Hamming ≤ threshold (default: 8 bits de 64 = 12.5%).
     *
     * @param {object} regionalA  { topLeft, topRight, bottomLeft, bottomRight }
     * @param {object} regionalB  { topLeft, topRight, bottomLeft, bottomRight }
     * @param {{ threshold?: number, minMatches?: number }} opts
     * @returns {{ match: boolean, matchCount: number, details: object }}
     */
    function matchRegionalHashes(regionalA, regionalB, { threshold = 8, minMatches = 3 } = {}) {
        if (!regionalA || !regionalB) return { match: false, matchCount: 0, details: {} };

        const corners = ['topLeft', 'topRight', 'bottomLeft', 'bottomRight'];
        let matchCount = 0;
        const details  = {};

        for (const corner of corners) {
            const dist = hammingDistance(regionalA[corner], regionalB[corner]);
            const ok   = dist >= 0 && dist <= threshold;
            if (ok) matchCount++;
            details[corner] = { dist, match: ok };
        }

        return { match: matchCount >= minMatches, matchCount, details };
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Distância de Hamming generalizada
    //
    // Aceita hashes hex de qualquer comprimento par (múltiplo de 4 bits):
    //   16 chars → dHash 64-bit
    //   64 chars → wHash / pHash 256-bit
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * @param {string} hashA  hex lowercase, qualquer comprimento par
     * @param {string} hashB  hex lowercase, mesmo comprimento de hashA
     * @returns {number}  bits diferentes (0 a len*4), ou -1 se input inválido
     */
    function hammingDistance(hashA, hashB) {
        if (!hashA || !hashB || hashA.length !== hashB.length) return -1;
        let dist = 0;
        for (let i = 0; i < hashA.length; i++) {
            let xor = (parseInt(hashA[i], 16) ^ parseInt(hashB[i], 16));
            while (xor) { dist += xor & 1; xor >>>= 1; }
        }
        return dist;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // matchPerceptualHashes — Decisão combinada wHash + pHash
    //
    // Implementação direta do pipeline descrito na análise matemática:
    //
    //   MATCH se: (Hamming_wHash ≤ 40 OU Hamming_pHash ≤ 35)
    //             E NOT (Hamming_wHash > 80 E Hamming_pHash > 70)
    //
    //   Rejeição absoluta: ambos os hashes muito distantes (imagem diferente)
    //
    // Thresholds (base: 256 bits):
    //   wHash match:          ≤ 40 bits (≤ 15.6%) — threshold cross-language
    //   pHash match:          ≤ 35 bits (≤ 13.7%)
    //   wHash rejeição:       > 80 bits (> 31.3%)
    //   pHash rejeição:       > 70 bits (> 27.3%)
    //
    // Confidence score [0..1]:
    //   confidence = max(wConf, pConf)
    //   wConf = 1 - wDist / WHASH_REJECT_THRESHOLD  (quando wMatch)
    //   pConf = 1 - pDist / PHASH_REJECT_THRESHOLD  (quando pMatch)
    // ─────────────────────────────────────────────────────────────────────────

    const WHASH_MATCH_THRESHOLD  = 40;  // Hamming ≤ 40/256 → wHash match
    const PHASH_MATCH_THRESHOLD  = 35;  // Hamming ≤ 35/256 → pHash match
    const WHASH_REJECT_THRESHOLD = 80;  // Hamming > 80 → componente wHash rejeita
    const PHASH_REJECT_THRESHOLD = 70;  // Hamming > 70 → componente pHash rejeita

    // ── Thresholds relaxados (visual-v4 / Solução C) ────────────────────────
    //
    // Usados apenas como fallback depois de SHA-256, dHash, perceptual strict e
    // center-crop falharem. A confidence é limitada a 0.75 para forçar a
    // confirmação regional no content script antes de qualquer substituição.
    const WHASH_MATCH_THRESHOLD_RELAXED  = 50;
    const PHASH_MATCH_THRESHOLD_RELAXED  = 45;
    const WHASH_REJECT_THRESHOLD_RELAXED = 90;
    const PHASH_REJECT_THRESHOLD_RELAXED = 82;

    /**
     * @param {string|null} wHashA  64 chars hex (256 bits) ou null
     * @param {string|null} pHashA  64 chars hex (256 bits) ou null
     * @param {string|null} wHashB  64 chars hex (256 bits) ou null
     * @param {string|null} pHashB  64 chars hex (256 bits) ou null
     * @returns {{
     *   match:      boolean,
     *   confidence: number,   // [0..1]
     *   reason:     string,
     *   wDist:      number,   // -1 se hash ausente
     *   pDist:      number,
     * }}
     */
    function matchPerceptualHashes(wHashA, pHashA, wHashB, pHashB) {
        const wDist = (wHashA && wHashB) ? hammingDistance(wHashA, wHashB) : -1;
        const pDist = (pHashA && pHashB) ? hammingDistance(pHashA, pHashB) : -1;

        // ── Ambos disponíveis: lógica combinada ──────────────────────────────
        if (wDist >= 0 && pDist >= 0) {
            // Rejeição absoluta: ambos sinalizando imagem diferente
            if (wDist > WHASH_REJECT_THRESHOLD && pDist > PHASH_REJECT_THRESHOLD) {
                return { match: false, confidence: 0, reason: 'both_reject', wDist, pDist };
            }

            const wMatch = wDist <= WHASH_MATCH_THRESHOLD;
            const pMatch = pDist <= PHASH_MATCH_THRESHOLD;

            if (wMatch || pMatch) {
                const wConf = wMatch ? (1 - wDist / WHASH_REJECT_THRESHOLD) : 0;
                const pConf = pMatch ? (1 - pDist / PHASH_REJECT_THRESHOLD) : 0;
                const confidence = Math.min(1, Math.max(wConf, pConf));
                const reason = (wMatch && pMatch) ? 'both_match'
                             : wMatch             ? 'whash_match'
                             :                      'phash_match';
                return { match: true, confidence, reason, wDist, pDist };
            }

            return { match: false, confidence: 0, reason: 'both_miss', wDist, pDist };
        }

        // ── Apenas wHash ─────────────────────────────────────────────────────
        if (wDist >= 0) {
            const wMatch = wDist <= WHASH_MATCH_THRESHOLD;
            return {
                match:      wMatch,
                confidence: wMatch ? (1 - wDist / WHASH_REJECT_THRESHOLD) : 0,
                reason:     wMatch ? 'whash_only_match' : 'whash_only_miss',
                wDist,
                pDist: -1,
            };
        }

        // ── Apenas pHash ─────────────────────────────────────────────────────
        if (pDist >= 0) {
            const pMatch = pDist <= PHASH_MATCH_THRESHOLD;
            return {
                match:      pMatch,
                confidence: pMatch ? (1 - pDist / PHASH_REJECT_THRESHOLD) : 0,
                reason:     pMatch ? 'phash_only_match' : 'phash_only_miss',
                wDist: -1,
                pDist,
            };
        }

        // ── Nenhum hash disponível ────────────────────────────────────────────
        return { match: false, confidence: 0, reason: 'no_hashes', wDist: -1, pDist: -1 };
    }

    function matchPerceptualHashesRelaxed(wHashA, pHashA, wHashB, pHashB) {
        const wDist = (wHashA && wHashB) ? hammingDistance(wHashA, wHashB) : -1;
        const pDist = (pHashA && pHashB) ? hammingDistance(pHashA, pHashB) : -1;

        if (wDist >= 0 && pDist >= 0) {
            if (wDist > WHASH_REJECT_THRESHOLD_RELAXED && pDist > PHASH_REJECT_THRESHOLD_RELAXED) {
                return { match: false, confidence: 0, reason: 'relaxed_both_reject', wDist, pDist };
            }

            const wMatch = wDist <= WHASH_MATCH_THRESHOLD_RELAXED;
            const pMatch = pDist <= PHASH_MATCH_THRESHOLD_RELAXED;

            if (wMatch || pMatch) {
                const wConf = wMatch ? (1 - wDist / WHASH_REJECT_THRESHOLD_RELAXED) : 0;
                const pConf = pMatch ? (1 - pDist / PHASH_REJECT_THRESHOLD_RELAXED) : 0;
                const confidence = Math.min(0.75, Math.max(wConf, pConf));
                const reason = (wMatch && pMatch) ? 'relaxed_both_match'
                             : wMatch             ? 'relaxed_whash_match'
                             :                      'relaxed_phash_match';
                return { match: true, confidence, reason, wDist, pDist };
            }

            return { match: false, confidence: 0, reason: 'relaxed_both_miss', wDist, pDist };
        }

        if (wDist >= 0) {
            const wMatch = wDist <= WHASH_MATCH_THRESHOLD_RELAXED;
            return {
                match:      wMatch,
                confidence: wMatch ? Math.min(0.75, 1 - wDist / WHASH_REJECT_THRESHOLD_RELAXED) : 0,
                reason:     wMatch ? 'relaxed_whash_only_match' : 'relaxed_whash_only_miss',
                wDist,
                pDist: -1,
            };
        }

        if (pDist >= 0) {
            const pMatch = pDist <= PHASH_MATCH_THRESHOLD_RELAXED;
            return {
                match:      pMatch,
                confidence: pMatch ? Math.min(0.75, 1 - pDist / PHASH_REJECT_THRESHOLD_RELAXED) : 0,
                reason:     pMatch ? 'relaxed_phash_only_match' : 'relaxed_phash_only_miss',
                wDist: -1,
                pDist,
            };
        }

        return { match: false, confidence: 0, reason: 'no_hashes', wDist: -1, pDist: -1 };
    }

    // ─────────────────────────────────────────────────────────────────────────
    // API pública
    // ─────────────────────────────────────────────────────────────────────────

    const api = {
        // SHA-256 (visual-v1/v2, inalterado)
        buildFingerprintSource,
        hashStringSha256,
        createFingerprintFromDescriptor,
        generateId,

        // dHash (visual-v2) — 9×8 → 16 hex chars
        calculateDHash,

        // wHash (visual-v3) — Haar Wavelet, 32×32 → 64 hex chars (256 bits)
        calculateWHash,

        // pHash (visual-v3) — DCT, 32×32 → 64 hex chars (256 bits)
        calculatePHash,

        // Hashes regionais dos 4 cantos (48×48 canvas, aproximação do RANSAC)
        calculateRegionalHashes,
        matchRegionalHashes,

        // Hamming distance generalizada (16, 64, ou qualquer comprimento par)
        hammingDistance,

        // Match combinado wHash + pHash com thresholds calibrados para mangá
        matchPerceptualHashes,
        matchPerceptualHashesRelaxed,

        // Thresholds públicos (para uso no content script, SW e IndexedDB)
        WHASH_MATCH_THRESHOLD,
        PHASH_MATCH_THRESHOLD,
        WHASH_REJECT_THRESHOLD,
        PHASH_REJECT_THRESHOLD,
        WHASH_MATCH_THRESHOLD_RELAXED,
        PHASH_MATCH_THRESHOLD_RELAXED,
        WHASH_REJECT_THRESHOLD_RELAXED,
        PHASH_REJECT_THRESHOLD_RELAXED,
    };

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    }

    rootScope.MangaTranslatorGtcFingerprint = api;

})(typeof self !== 'undefined' ? self : globalThis);
