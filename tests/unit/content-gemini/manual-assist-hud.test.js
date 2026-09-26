/**
 * manual-assist-hud.test.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Testa o painel flutuante de assistência manual (#mt-gemini-assist)
 * implementado em content_gemini.js na arquitetura atual.
 */

const { loadContentGeminiModule } = require('../../helpers/load-content-gemini-module.js');

describe('Manual Assist HUD (#mt-gemini-assist) — content_gemini.js', () => {
    let geminiMod;

    beforeEach(() => {
        document.documentElement.innerHTML = '<head></head><body></body>';
        geminiMod = loadContentGeminiModule({ skipAutoProcess: true });
    });

    afterEach(() => {
        geminiMod.removeGeminiManualPanel();
        document.documentElement.innerHTML = '<head></head><body></body>';
        delete window.__mangaTranslatorManualGeminiResultUrl;
    });

    test('cria o painel #mt-gemini-assist com botões de ação e status inicial', () => {
        geminiMod.createGeminiManualPanel({ index: 2 }, () => new Set());

        const panel = document.getElementById('mt-gemini-assist');
        expect(panel).not.toBeNull();
        expect(panel.textContent).toContain('Imagem 3');

        const btnUseLast = document.getElementById('mt-gemini-use-last');
        const btnPick = document.getElementById('mt-gemini-pick');
        const status = document.getElementById('mt-gemini-assist-status');

        expect(btnUseLast).not.toBeNull();
        expect(btnPick).not.toBeNull();
        expect(status.textContent).toBe('Aguardando imagem gerada.');
    });

    test('botão "Usar última" marca a URL da imagem candidata mais recente', () => {
        const candidateImg = document.createElement('img');
        candidateImg.src = 'https://lh3.googleusercontent.com/result_image_123=s1024';
        Object.defineProperty(candidateImg, 'naturalWidth', { value: 800, configurable: true });
        Object.defineProperty(candidateImg, 'naturalHeight', { value: 1200, configurable: true });
        document.body.appendChild(candidateImg);

        geminiMod.createGeminiManualPanel({ index: 0 }, () => new Set());

        const btnUseLast = document.getElementById('mt-gemini-use-last');
        btnUseLast.click();

        expect(window.__mangaTranslatorManualGeminiResultUrl).toBe('https://lh3.googleusercontent.com/result_image_123=s1024');
        const status = document.getElementById('mt-gemini-assist-status');
        expect(status.textContent).toContain('Imagem marcada');
    });

    test('botão "Usar última" atualiza status se não houver candidatos', () => {
        geminiMod.createGeminiManualPanel({ index: 0 }, () => new Set());

        const btnUseLast = document.getElementById('mt-gemini-use-last');
        btnUseLast.click();

        const status = document.getElementById('mt-gemini-assist-status');
        expect(status.textContent).toContain('Ainda não encontrei uma imagem candidata');
    });

    test('botão "Selecionar" destaca imagens candidatas e captura clique manual', () => {
        const candidateImg = document.createElement('img');
        candidateImg.src = 'https://lh3.googleusercontent.com/picked_image=s1024';
        Object.defineProperty(candidateImg, 'naturalWidth', { value: 800, configurable: true });
        Object.defineProperty(candidateImg, 'naturalHeight', { value: 1200, configurable: true });
        document.body.appendChild(candidateImg);

        geminiMod.createGeminiManualPanel({ index: 0 }, () => new Set());

        const btnPick = document.getElementById('mt-gemini-pick');
        btnPick.click();

        const status = document.getElementById('mt-gemini-assist-status');
        expect(status.textContent).toContain('Clique diretamente na imagem correta');
        expect(candidateImg.dataset.mtGeminiPickable).toBe('true');
        expect(candidateImg.style.outline).toContain('solid');

        // Simula o clique do usuário diretamente na imagem candidata
        candidateImg.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));

        // Verifica que a URL foi gravada
        expect(window.__mangaTranslatorManualGeminiResultUrl).toBe('https://lh3.googleusercontent.com/picked_image=s1024');

        // Verifica que o destaque visual foi removido
        expect(candidateImg.dataset.mtGeminiPickable).toBeUndefined();
        expect(candidateImg.style.outline).toBe('');
    });

    test('removeGeminiManualPanel remove o HUD e limpa listeners residuais', () => {
        geminiMod.createGeminiManualPanel({ index: 1 }, () => new Set());
        expect(document.getElementById('mt-gemini-assist')).not.toBeNull();

        geminiMod.removeGeminiManualPanel();
        expect(document.getElementById('mt-gemini-assist')).toBeNull();
    });
});
