/**
 * temp-chat-activator.test.js
 * Testa diretamente gemini/temporary-chat.js sem adapter legado.
 */

const path = require('path');

const TEMP_CHAT_PATH = path.resolve(
    __dirname,
    '../../../extension/gemini/temporary-chat.js'
);

function loadTemporaryChat() {
    let api;
    jest.isolateModules(() => {
        api = require(TEMP_CHAT_PATH);
    });
    return api;
}

describe('Temporary Chat — módulo semântico', () => {
    let temporaryChat;

    beforeEach(() => {
        if (!window.PointerEvent) {
            window.PointerEvent = class PointerEvent extends MouseEvent {};
        }
        document.documentElement.innerHTML = '<head></head><body></body>';
        temporaryChat = loadTemporaryChat();
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

            expect(temporaryChat.findTempChatButton(document)).toBe(btn);
        });

        test('localiza botão pelo aria-label em inglês "temporary chat"', () => {
            const btn = document.createElement('div');
            btn.setAttribute('role', 'button');
            btn.setAttribute('aria-label', 'Toggle temporary chat');
            document.body.appendChild(btn);

            expect(temporaryChat.findTempChatButton(document)).toBe(btn);
        });

        test('localiza pelo data-test-id "temp-chat-button"', () => {
            const btn = document.createElement('button');
            btn.setAttribute('data-test-id', 'temp-chat-button');
            btn.textContent = 'Modo privado';
            document.body.appendChild(btn);

            expect(temporaryChat.findTempChatButton(document)).toBe(btn);
        });

        test('retorna null quando nenhum controle semanticamente compatível existe', () => {
            document.body.innerHTML =
                '<button>Enviar</button><button>Ajuda</button>';

            expect(temporaryChat.findTempChatButton(document)).toBeNull();
        });
    });

    describe('isAlreadyActive()', () => {
        test('detecta ativo via indicador .momentary-indicator no DOM', () => {
            const indicator = document.createElement('div');
            indicator.className = 'momentary-indicator';
            indicator.textContent = 'Conversa momentânea ativada';
            document.body.appendChild(indicator);

            expect(
                temporaryChat.isAlreadyActive(null, document)
            ).toBe(true);
        });

        test('detecta ativo via atributo aria-checked="true"', () => {
            const btn = document.createElement('button');
            btn.setAttribute('aria-checked', 'true');
            btn.textContent = 'Conversa momentânea';
            document.body.appendChild(btn);

            expect(
                temporaryChat.isAlreadyActive(btn, document)
            ).toBe(true);
        });

        test('detecta ativo via texto "desativar conversa momentânea"', () => {
            const btn = document.createElement('button');
            btn.textContent = 'Desativar conversa momentânea';
            document.body.appendChild(btn);

            expect(
                temporaryChat.isAlreadyActive(btn, document)
            ).toBe(true);
        });

        test('retorna false para controle que oferece ativação', () => {
            const btn = document.createElement('button');
            btn.textContent = 'Ativar conversa momentânea';
            document.body.appendChild(btn);

            expect(
                temporaryChat.isAlreadyActive(btn, document)
            ).toBe(false);
        });

        test('detecta banner nativo em português', () => {
            const banner = document.createElement('div');
            banner.textContent =
                'As conversas temporárias não aparecem no seu histórico nem são usadas para treinar modelos.';
            document.body.appendChild(banner);

            expect(
                temporaryChat.isAlreadyActive(null, document)
            ).toBe(true);
        });

        test('detecta tela nativa "Está só dando uma passadinha?"', () => {
            const container = document.createElement('div');
            container.innerHTML = `
                <h2>Está só dando uma passadinha?</h2>
                <p>As conversas momentâneas não aparecem nas conversas recentes e não são usadas para aprimorar a IA do Google.</p>
            `;
            document.body.appendChild(container);

            expect(
                temporaryChat.isAlreadyActive(null, document)
            ).toBe(true);
        });

        test('detecta tela nativa em inglês', () => {
            const container = document.createElement('div');
            container.innerHTML = `
                <h2>Just passing through?</h2>
                <p>Temporary chats don’t appear in Recent chats and aren’t used to improve Google AI.</p>
            `;
            document.body.appendChild(container);

            expect(
                temporaryChat.isAlreadyActive(null, document)
            ).toBe(true);
        });

        test('detecta botão de fechar conversa momentânea', () => {
            const closeBtn = document.createElement('button');
            closeBtn.setAttribute(
                'aria-label',
                'Fechar a conversa momentânea'
            );
            document.body.appendChild(closeBtn);

            expect(
                temporaryChat.isAlreadyActive(null, document)
            ).toBe(true);
        });
    });

    describe('triggerClick()', () => {
        test('dispara pointer/mouse e click uma única vez', () => {
            const btn = document.createElement('button');
            document.body.appendChild(btn);

            const events = [];
            [
                'pointerdown',
                'mousedown',
                'pointerup',
                'mouseup',
                'click',
            ].forEach(type => {
                btn.addEventListener(type, () => events.push(type));
            });

            expect(temporaryChat.triggerClick(btn)).toBe(true);
            expect(events).toEqual([
                'pointerdown',
                'mousedown',
                'pointerup',
                'mouseup',
                'click',
            ]);
        });
    });

    describe('ensureActive()', () => {
        test('retorna already_active sem clicar', async () => {
            const btn = document.createElement('button');
            btn.textContent = 'Desativar conversa momentânea';
            document.body.appendChild(btn);

            const clickSpy = jest.spyOn(btn, 'click');
            const result = await temporaryChat.ensureActive({
                root: document,
                timeoutMs: 50,
                sleep: async () => {},
            });

            expect(result.status).toBe('already_active');
            expect(clickSpy).not.toHaveBeenCalled();
        });

        test('clica uma vez e exige verificação de estado', async () => {
            const btn = document.createElement('button');
            btn.textContent = 'Ativar conversa momentânea';
            document.body.appendChild(btn);

            let clicks = 0;
            btn.addEventListener('click', () => {
                clicks += 1;
                btn.textContent = 'Desativar conversa momentânea';
                btn.classList.add('active');
            });

            const result = await temporaryChat.ensureActive({
                root: document,
                timeoutMs: 100,
                sleep: async () => {},
            });

            expect(result.status).toBe('activated_verified');
            expect(clicks).toBe(1);
        });

        test('sem controle semântico retorna unavailable', async () => {
            document.body.innerHTML =
                '<button style="position:absolute;right:0;top:0">Enviar</button>';

            const result = await temporaryChat.ensureActive({
                root: document,
                timeoutMs: 1,
                sleep: async () => {},
            });

            expect(result.status).toBe('unavailable');
        });

        test('não existe mais fallback posicional', () => {
            expect(temporaryChat.findButtonByPosition).toBeUndefined();
            expect(temporaryChat.createLegacyAdapter).toBeUndefined();
        });
    });
});
