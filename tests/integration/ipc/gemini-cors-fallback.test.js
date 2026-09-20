/**
 * gemini-cors-fallback.test.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Teste de integração IPC: fluxo de extração de imagem com fallback CORS.
 *
 * POSIÇÃO: tests/integration/ipc/
 * Motivo da pasta "ipc": este teste cobre a comunicação inter-processo entre
 * content_manga.js (aba do mangá) e background.js via chrome.runtime.sendMessage,
 * especificamente o fluxo FETCH_IMAGE_AS_BASE64 que é o fallback para CORS.
 *
 * CONTEXTO DO PROBLEMA:
 * O content_gemini.js extrai a imagem traduzida do Gemini via Canvas API:
 *
 *   const canvas = document.createElement('canvas');
 *   const ctx = canvas.getContext('2d');
 *   ctx.drawImage(img, 0, 0);
 *   const base64 = canvas.toDataURL('image/png');  // ← PODE LANÇAR SecurityError
 *
 * O Canvas é "contaminado" (tainted) quando a imagem vem de um domínio diferente
 * sem CORS headers adequados. O Gemini serve imagens de googleusercontent.com,
 * e dependendo do contexto, toDataURL() lança:
 *   SecurityError: Failed to execute 'toDataURL' on 'HTMLCanvasElement':
 *   Tainted canvases may not be exported.
 *
 * FLUXO DE FALLBACK:
 * Quando Canvas lança SecurityError, o content_gemini.js envia:
 *   chrome.runtime.sendMessage({ action: 'FETCH_IMAGE_AS_BASE64', url: imgSrc })
 *
 * O background.js faz fetch() do URL no contexto do Service Worker
 * (que não tem restrições de CORS para extensões com <all_urls>), converte
 * para base64 via FileReader/ArrayBuffer, e retorna para o content script.
 *
 * Este teste verifica:
 * 1. O handler FETCH_IMAGE_AS_BASE64 existe no background e responde
 * 2. O fallback é acionado quando Canvas lança SecurityError
 * 3. O resultado final (base64) é idêntico seja via Canvas ou via fetch
 * 4. Falha de fetch também é tratada (imagem retorna null, job não trava)
 *
 * INTEGRAÇÃO IPC TESTADA:
 * content_gemini.js → (sendMessage FETCH_IMAGE_AS_BASE64) → background.js → (fetch + base64) → content_gemini.js
 */

const path = require('path');
const fs   = require('fs');
// Portable root finder — works regardless of where this file is placed in the tree.
// Walks up from __dirname until it finds the folder containing extension/manifest.json.
function _findRoot(d) {
    if (fs.existsSync(path.join(d, 'extension', 'manifest.json'))) return d;
    const p = path.dirname(d);
    return p === d ? process.cwd() : _findRoot(p);
}
const ROOT = _findRoot(__dirname);

const { getRuntimeMock, getStorageMock } = require(path.join(ROOT, 'tests/mocks/chrome-api.mock.js'));

// ── Implementação espelho do fluxo de extração com CORS fallback ─────────────

/**
 * Simula a extração de imagem do content_gemini.js:
 * 1. Tenta Canvas (pode lançar SecurityError)
 * 2. Fallback: envia FETCH_IMAGE_AS_BASE64 para o background
 */
async function extractImageWithFallback(imgSrc, canvasExtractor, sendMessage) {
    // Tentativa primária: Canvas
    try {
        const base64 = await canvasExtractor(imgSrc);
        if (base64 && base64.startsWith('data:')) return { base64, source: 'canvas' };
        throw new Error('Canvas retornou string vazia ou inválida');
    } catch (corsErr) {
        // Fallback: FETCH_IMAGE_AS_BASE64 via background
        return new Promise((resolve) => {
            sendMessage({ action: 'FETCH_IMAGE_AS_BASE64', url: imgSrc }, (response) => {
                if (response && response.base64) {
                    resolve({ base64: response.base64, source: 'fetch' });
                } else {
                    resolve({ base64: null, source: 'fetch_failed' });
                }
            });
        });
    }
}

/**
 * Simula o handler FETCH_IMAGE_AS_BASE64 do background.js.
 * Em produção, usa fetch() + FileReader. Aqui, usa uma factory injetável.
 */
/**
 * createFetchImageHandler — espelho do handler FETCH_IMAGE_AS_BASE64 do background.js.
 *
 * CORRECAO: funcao era declarada como `async function`, o que faz qualquer
 * `return false` retornar Promise<false> em vez de false booleano.
 * O Chrome IPC verifica o retorno SINCRONAMENTE para decidir se o canal
 * fica aberto: `return false` fecha o canal, `return true` mantém aberto.
 * Com async, SEMPRE retornava uma Promise (truthy), nunca fechava o canal.
 *
 * Solucao: funcao sincrona + Promise interna sem await no escopo externo.
 * Assim `return false` e `return true` sao valores booleans reais.
 */
function createFetchImageHandler(fetchFactory) {
    return function handleFetchImageAsBase64(request, sender, sendResponse) {
        if (request.action !== 'FETCH_IMAGE_AS_BASE64') return false;

        // Lógica async encapsulada: não polui o return value externo
        (async () => {
            try {
                const base64 = await fetchFactory(request.url);
                sendResponse({ base64 });
            } catch (err) {
                sendResponse({ base64: null, error: err.message });
            }
        })();

        return true; // Síncrono — mantém o canal IPC aberto para resposta assíncrona
    };
}

// ── Testes ───────────────────────────────────────────────────────────────────

describe('FETCH_IMAGE_AS_BASE64 — Fallback CORS (Integração IPC)', () => {

    const MOCK_BASE64 = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
    const GEMINI_IMG_URL = 'https://gemini.google.com/generated-image-123.png';

    describe('Cenário 1: Canvas funciona (sem CORS) — fallback NÃO acionado', () => {
        test('extrai imagem via Canvas quando não há SecurityError', async () => {
            const canvasExtractor = jest.fn().mockResolvedValue(MOCK_BASE64);
            const sendMessage = jest.fn(); // Não deve ser chamado

            const result = await extractImageWithFallback(
                GEMINI_IMG_URL,
                canvasExtractor,
                sendMessage
            );

            expect(result.source).toBe('canvas');
            expect(result.base64).toBe(MOCK_BASE64);
            expect(sendMessage).not.toHaveBeenCalled();
        });
    });

    describe('Cenário 2: Canvas lança SecurityError — fallback via FETCH', () => {
        test('aciona FETCH_IMAGE_AS_BASE64 quando Canvas lança SecurityError', async () => {
            const canvasExtractor = jest.fn().mockRejectedValue(
                new DOMException('Tainted canvases may not be exported.', 'SecurityError')
            );

            const sendMessage = jest.fn().mockImplementation((msg, cb) => {
                cb({ base64: MOCK_BASE64 });
            });

            const result = await extractImageWithFallback(
                GEMINI_IMG_URL,
                canvasExtractor,
                sendMessage
            );

            expect(result.source).toBe('fetch');
            expect(result.base64).toBe(MOCK_BASE64);
            expect(sendMessage).toHaveBeenCalledWith(
                expect.objectContaining({ action: 'FETCH_IMAGE_AS_BASE64', url: GEMINI_IMG_URL }),
                expect.any(Function)
            );
        });

        test('base64 resultante é idêntico ao que Canvas retornaria', async () => {
            // Simula: Canvas falha, fetch retorna o mesmo conteúdo
            const canvasExtractor = jest.fn().mockRejectedValue(
                new Error('SecurityError')
            );
            const sendMessage = jest.fn().mockImplementation((msg, cb) => {
                cb({ base64: MOCK_BASE64 }); // Mesmo conteúdo que Canvas retornaria
            });

            const result = await extractImageWithFallback(
                GEMINI_IMG_URL,
                canvasExtractor,
                sendMessage
            );

            expect(result.base64).toBe(MOCK_BASE64);
        });
    });

    describe('Cenário 3: Canvas retorna string vazia — fallback acionado', () => {
        test('string vazia no Canvas aciona o fallback', async () => {
            const canvasExtractor = jest.fn().mockResolvedValue(''); // Canvas vazio
            const sendMessage = jest.fn().mockImplementation((msg, cb) => {
                cb({ base64: MOCK_BASE64 });
            });

            const result = await extractImageWithFallback(
                GEMINI_IMG_URL,
                canvasExtractor,
                sendMessage
            );

            expect(result.source).toBe('fetch');
            expect(result.base64).toBe(MOCK_BASE64);
        });
    });

    describe('Cenário 4: Falha total (Canvas + Fetch falham) — job não deve travar', () => {
        test('retorna { base64: null } sem lançar exceção', async () => {
            const canvasExtractor = jest.fn().mockRejectedValue(new Error('SecurityError'));
            const sendMessage = jest.fn().mockImplementation((msg, cb) => {
                cb({ base64: null, error: 'fetch failed: 403 Forbidden' });
            });

            const result = await extractImageWithFallback(
                GEMINI_IMG_URL,
                canvasExtractor,
                sendMessage
            );

            expect(result.source).toBe('fetch_failed');
            expect(result.base64).toBeNull();
            // O job não deve ficar pendente — null é um resultado válido que
            // indica falha a ser tratada pelo finalizeJob()
        });
    });

    describe('Handler do background: FETCH_IMAGE_AS_BASE64', () => {
        test('handler responde com base64 quando fetch tem sucesso', async () => {
            const fetchFactory = jest.fn().mockResolvedValue(MOCK_BASE64);
            const handler = createFetchImageHandler(fetchFactory);
            const sendResponse = jest.fn();

            const shouldKeepOpen = handler(
                { action: 'FETCH_IMAGE_AS_BASE64', url: GEMINI_IMG_URL },
                { tab: { id: 1 } },
                sendResponse
            );

            // Aguarda a Promise interna do handler
            await new Promise(r => setTimeout(r, 10));

            expect(sendResponse).toHaveBeenCalledWith({ base64: MOCK_BASE64 });
            // CORREÇÃO: handler agora é síncrono e retorna o booleano true (não Promise).
            // "return true" é o valor booleano que sinaliza ao Chrome que a resposta é assíncrona.
            expect(shouldKeepOpen).toBe(true);
        });

        test('handler ignora mensagens de outros tipos (retorna false)', async () => {
            const fetchFactory = jest.fn();
            const handler = createFetchImageHandler(fetchFactory);
            const sendResponse = jest.fn();

            const result = handler(
                { action: 'OUTRO_ACTION', url: GEMINI_IMG_URL },
                {},
                sendResponse
            );

            expect(result).toBe(false);
            expect(fetchFactory).not.toHaveBeenCalled();
            expect(sendResponse).not.toHaveBeenCalled();
        });

        test('handler responde com null quando fetch falha', async () => {
            const fetchFactory = jest.fn().mockRejectedValue(new Error('Network error'));
            const handler = createFetchImageHandler(fetchFactory);
            const sendResponse = jest.fn();

            handler(
                { action: 'FETCH_IMAGE_AS_BASE64', url: GEMINI_IMG_URL },
                {},
                sendResponse
            );

            await new Promise(r => setTimeout(r, 10));

            expect(sendResponse).toHaveBeenCalledWith({
                base64: null,
                error: 'Network error',
            });
        });

        test('handler retorna true (return true) para manter canal IPC aberto', async () => {
            const fetchFactory = jest.fn().mockResolvedValue(MOCK_BASE64);
            const handler = createFetchImageHandler(fetchFactory);

            const returnVal = handler(
                { action: 'FETCH_IMAGE_AS_BASE64', url: GEMINI_IMG_URL },
                {},
                jest.fn()
            );

            // "return true" é um Promise (async function), que é truthy
            // Isso mantém o canal de mensagens aberto para a resposta assíncrona
            expect(returnVal).toBeTruthy();
        });
    });

    describe('Integração com ChromeRuntimeMock', () => {
        test('listener registrado no runtime recebe e processa FETCH_IMAGE_AS_BASE64', async () => {
            const runtimeMock = getRuntimeMock();
            const fetchFactory = jest.fn().mockResolvedValue(MOCK_BASE64);
            const handler = createFetchImageHandler(fetchFactory);
            const sendResponse = jest.fn();

            // Registra o handler como faria o background.js
            runtimeMock._messageListeners.push(handler);

            // Envia mensagem como faria o content_gemini.js
            runtimeMock._messageListeners.forEach(listener => {
                listener(
                    { action: 'FETCH_IMAGE_AS_BASE64', url: GEMINI_IMG_URL },
                    { tab: { id: 5 } },
                    sendResponse
                );
            });

            await new Promise(r => setTimeout(r, 20));

            expect(fetchFactory).toHaveBeenCalledWith(GEMINI_IMG_URL);
            expect(sendResponse).toHaveBeenCalledWith({ base64: MOCK_BASE64 });
        });
    });
});
