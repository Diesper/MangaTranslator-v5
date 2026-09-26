'use strict';

const path = require('path');

const TEMP_PATH = path.resolve(__dirname, '../../../extension/gemini/temporary-chat.js');

function loadTempChat() {
  let api;
  jest.isolateModules(() => {
    api = require(TEMP_PATH);
  });
  return api;
}

describe('gemini/temporary-chat.js — estados verificáveis', () => {
  beforeEach(() => {
    document.documentElement.innerHTML = '<head></head><body></body>';
    if (typeof window.PointerEvent !== 'function') window.PointerEvent = window.MouseEvent;
    if (typeof global.PointerEvent !== 'function') global.PointerEvent = window.PointerEvent;
  });

  afterEach(() => {
    jest.restoreAllMocks();
    document.documentElement.innerHTML = '<head></head><body></body>';
  });

  test('TEMP-01: já ativa retorna already_active sem clicar', async () => {
    const api = loadTempChat();
    const button = document.createElement('button');
    button.textContent = 'Desativar conversa temporária';
    document.body.appendChild(button);
    const clickSpy = jest.spyOn(button, 'click');

    await expect(api.ensureActive({
      root: document,
      timeoutMs: 100,
      sleep: async () => {},
    })).resolves.toEqual({ status: 'already_active' });

    expect(clickSpy).not.toHaveBeenCalled();
  });

  test('TEMP-02: clique só retorna activated_verified depois de reler estado ativo', async () => {
    const api = loadTempChat();
    const button = document.createElement('button');
    button.textContent = 'Ativar conversa momentânea';
    button.addEventListener('click', () => {
      button.textContent = 'Desativar conversa momentânea';
      button.setAttribute('aria-pressed', 'true');
    });
    document.body.appendChild(button);

    await expect(api.ensureActive({
      root: document,
      timeoutMs: 500,
      sleep: async () => {},
    })).resolves.toEqual({ status: 'activated_verified' });
  });

  test('TEMP-03: clique sem mudança real nunca retorna sucesso', async () => {
    const api = loadTempChat();
    const button = document.createElement('button');
    button.textContent = 'Ativar conversa momentânea';
    document.body.appendChild(button);

    let tick = 0;
    const nowSpy = jest.spyOn(Date, 'now').mockImplementation(() => {
      tick += 100;
      return tick;
    });

    const result = await api.ensureActive({
      root: document,
      timeoutMs: 350,
      sleep: async () => {},
    });

    expect(result).toEqual({
      status: 'verification_failed',
      reason: 'state_not_verified',
    });
    expect(nowSpy).toHaveBeenCalled();
  });

  test('TEMP-04: ausência do controle retorna unavailable', async () => {
    const api = loadTempChat();
    document.body.innerHTML = '<button>Enviar</button><button>Ajuda</button>';

    let tick = 0;
    jest.spyOn(Date, 'now').mockImplementation(() => {
      tick += 100;
      return tick;
    });

    await expect(api.ensureActive({
      root: document,
      timeoutMs: 250,
      sleep: async () => {},
    })).resolves.toEqual({ status: 'unavailable' });
  });

  test('TEMP-05: sem fallback geométrico, botão genérico permanece unavailable', async () => {
    const api = loadTempChat();

    const generic = document.createElement('button');
    generic.textContent = 'Menu';
    generic.getBoundingClientRect = () => ({
      top: 20, left: 1050, right: 1150, bottom: 60,
      width: 100, height: 40,
    });
    document.body.appendChild(generic);

    expect(api.findButtonByPosition).toBeUndefined();

    await expect(api.ensureActive({
      root: document,
      timeoutMs: 0,
      sleep: async () => {},
    })).resolves.toEqual({ status: 'unavailable' });
  });

  test('não alterna o toggle repetidamente após um clique não confirmado', async () => {
    const api = loadTempChat();
    const button = document.createElement('button');
    button.textContent = 'Ativar conversa temporária';
    const clickSpy = jest.spyOn(button, 'click');
    document.body.appendChild(button);

    let tick = 0;
    jest.spyOn(Date, 'now').mockImplementation(() => {
      tick += 100;
      return tick;
    });

    await api.ensureActive({
      root: document,
      timeoutMs: 450,
      sleep: async () => {},
    });

    expect(clickSpy).toHaveBeenCalledTimes(1);
  });
});
