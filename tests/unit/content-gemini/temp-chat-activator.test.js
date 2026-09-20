/**
 * temp-chat-activator.test.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Testa o TemporaryChatActivator real de content_gemini.js na arquitetura atual.
 * Verifica detecção de botões, checagem de estado ativo, despacho de eventos
 * e fallback gracioso sem quebrar o pipeline RPA.
 */

const { loadContentGeminiModule } = require('../../helpers/load-content-gemini-module.js');

describe('v6.0 TemporaryChatActivator — content_gemini.js', () => {
    let geminiMod;
    let activator;

    beforeEach(() => {
        if (!window.PointerEvent) {
            window.PointerEvent = class PointerEvent extends MouseEvent {};
        }
        document.documentElement.innerHTML = '<head></head><body></body>';
        geminiMod = loadContentGeminiModule({ skipAutoProcess: true });
        activator = geminiMod.TemporaryChatActivator;
    });

    afterEach(() => {
        jest.restoreAllMocks();
        document.documentElement.innerHTML = '<head></head><body></body>';
    });

    describe('findTempChatButton()', () => {
        test('localiza botão pelo texto "conversa momentânea"', () => {
            const btn = document.createElement('button');
            btn.textContent = 'Ativar conversa momentânea';
            document.body.appendChild(btn);

            const found = activator.findTempChatButton();
            expect(found).toBe(btn);
        });

        test('localiza botão pelo aria-label em inglês "temporary chat"', () => {
            const btn = document.createElement('div');
            btn.setAttribute('role', 'button');
            btn.setAttribute('aria-label', 'Toggle temporary chat');
            document.body.appendChild(btn);

            const found = activator.findTempChatButton();
            expect(found).toBe(btn);
        });

        test('localiza pelo data-test-id "temp-chat-button"', () => {
            const btn = document.createElement('button');
            btn.setAttribute('data-test-id', 'temp-chat-button');
            btn.textContent = 'Modo privado';
            document.body.appendChild(btn);

            const found = activator.findTempChatButton();
            expect(found).toBe(btn);
        });

        test('retorna null quando nenhum botão correspondente existe', () => {
            document.body.innerHTML = '<button>Enviar</button><button>Ajuda</button>';
            expect(activator.findTempChatButton()).toBeNull();
        });
    });

    describe('isAlreadyActive()', () => {
        test('detecta ativo via indicador .momentary-indicator no DOM', () => {
            const indicator = document.createElement('div');
            indicator.className = 'momentary-indicator';
            indicator.textContent = 'Conversa momentânea ativada';
            document.body.appendChild(indicator);

            expect(activator.isAlreadyActive()).toBe(true);
        });

        test('detecta ativo via atributo aria-checked="true" no botão', () => {
            const btn = document.createElement('button');
            btn.setAttribute('aria-checked', 'true');
            btn.textContent = 'Conversa momentânea';
            document.body.appendChild(btn);

            expect(activator.isAlreadyActive(btn)).toBe(true);
        });

        test('detecta ativo via texto "desativar conversa momentânea"', () => {
            const btn = document.createElement('button');
            btn.textContent = 'Desativar conversa momentânea';
            document.body.appendChild(btn);

            expect(activator.isAlreadyActive(btn)).toBe(true);
        });

        test('retorna false quando o botão está desativado ("ativar conversa momentânea")', () => {
            const btn = document.createElement('button');
            btn.textContent = 'Ativar conversa momentânea';
            document.body.appendChild(btn);

            expect(activator.isAlreadyActive(btn)).toBe(false);
        });
    });

    describe('triggerClick()', () => {
        test('dispara eventos de pointerdown, mousedown, pointerup, mouseup e click', () => {
            const btn = document.createElement('button');
            document.body.appendChild(btn);

            const eventsFired = [];
            ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'].forEach(evtType => {
                btn.addEventListener(evtType, () => eventsFired.push(evtType));
            });

            const result = activator.triggerClick(btn);
            expect(result).toBe(true);
            expect(eventsFired).toEqual(['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']);
        });
    });

    describe('ensureTemporaryChatActive()', () => {
        test('retorna { success: true, alreadyActive: true } sem clicar se já estiver ativo', async () => {
            const indicator = document.createElement('div');
            indicator.className = 'momentary-indicator';
            indicator.textContent = 'Conversa momentânea';
            document.body.appendChild(indicator);

            const btn = document.createElement('button');
            btn.textContent = 'Desativar conversa momentânea';
            document.body.appendChild(btn);

            const clickSpy = jest.spyOn(btn, 'click');
            const result = await activator.ensureTemporaryChatActive(1);

            expect(result.success).toBe(true);
            expect(result.alreadyActive).toBe(true);
            expect(clickSpy).not.toHaveBeenCalled();
        });

        test('clica no botão e ativa quando não estava ativo', async () => {
            const btn = document.createElement('button');
            btn.textContent = 'Ativar conversa momentânea';
            document.body.appendChild(btn);

            btn.addEventListener('click', () => {
                btn.textContent = 'Desativar conversa momentânea';
                btn.classList.add('active');
            });

            // Reduz o tempo de sleep interno para o teste rodar instantaneamente
            activator.sleep = () => Promise.resolve();

            const result = await activator.ensureTemporaryChatActive(1);
            expect(result.success).toBe(true);
            expect(result.activated).toBe(true);
        });

        test('esgota timeout graciosamente retornando notFound sem quebrar o pipeline', async () => {
            activator.sleep = () => Promise.resolve();
            const result = await activator.ensureTemporaryChatActive(0.01);

            expect(result.success).toBe(false);
            expect(result.notFound).toBe(true);
        });

        test('detecta ativo via aria-label "Desativar o chat temporário" em botão de ícone sem texto', () => {
            const btn = document.createElement('button');
            btn.setAttribute('aria-label', 'Desativar o chat temporário');
            document.body.appendChild(btn);

            expect(activator.isAlreadyActive(btn)).toBe(true);
        });

        test('detecta ativo via aviso/banner "As conversas temporárias não aparecem no seu histórico"', () => {
            const banner = document.createElement('div');
            banner.textContent = 'As conversas temporárias não aparecem no seu histórico nem são usadas para treinar modelos.';
            document.body.appendChild(banner);

            expect(activator.isAlreadyActive()).toBe(true);
        });

        test('não clica repetidamente no botão em loop caso já tenha clicado uma vez (evita loop toggle)', async () => {
            const btn = document.createElement('button');
            btn.setAttribute('aria-label', 'Ativar conversa temporária');
            document.body.appendChild(btn);

            let clicks = 0;
            btn.addEventListener('click', () => {
                clicks++;
                btn.setAttribute('aria-label', 'Desativar conversa temporária');
            });

            activator.sleep = () => Promise.resolve();
            const result = await activator.ensureTemporaryChatActive(1);

            expect(result.success).toBe(true);
            expect(result.activated).toBe(true);
            expect(clicks).toBe(1); // Exatamente 1 clique, nunca repetido em loop!
        });

        test('detecta ativo via tela nativa do Gemini "Está só dando uma passadinha?" e "não aparecem nas conversas recentes"', () => {
            const container = document.createElement('div');
            container.innerHTML = `
                <h2>Está só dando uma passadinha?</h2>
                <p>As conversas momentâneas não aparecem nas conversas recentes e não são usadas para aprimorar a IA do Google. Elas são armazenadas por 72 horas por motivos de segurança.</p>
            `;
            document.body.appendChild(container);

            expect(activator.isAlreadyActive()).toBe(true);
        });

        test('detecta ativo via tela nativa do Gemini em inglês "Just passing through?"', () => {
            const container = document.createElement('div');
            container.innerHTML = `
                <h2>Just passing through?</h2>
                <p>Temporary chats don’t appear in Recent chats and aren’t used to improve Google AI. They are stored for 72 hours for safety reasons.</p>
            `;
            document.body.appendChild(container);

            expect(activator.isAlreadyActive()).toBe(true);
        });

        test('detecta ativo via botão X de fechar conversa momentânea', () => {
            const closeBtn = document.createElement('button');
            closeBtn.setAttribute('aria-label', 'Fechar a conversa momentânea');
            document.body.appendChild(closeBtn);

            expect(activator.isAlreadyActive()).toBe(true);
        });
    });
});
