'use strict';

const path = require('path');

const SELECTORS_PATH = path.resolve(__dirname, '../../../extension/gemini/selectors.js');
const DOM_PATH = path.resolve(__dirname, '../../../extension/gemini/dom.js');

function loadModules() {
  let selectors;
  let dom;
  jest.isolateModules(() => {
    selectors = require(SELECTORS_PATH);
    dom = require(DOM_PATH);
  });
  return { selectors, dom };
}

function visibleRect(element, width = 120, height = 40) {
  element.getBoundingClientRect = () => ({
    x: 0,
    y: 0,
    top: 0,
    left: 0,
    right: width,
    bottom: height,
    width,
    height,
    toJSON() { return this; },
  });
}

describe('gemini/selectors.js + gemini/dom.js', () => {
  beforeEach(() => {
    document.documentElement.innerHTML = '<head></head><body></body>';
  });

  afterEach(() => {
    jest.restoreAllMocks();
    document.documentElement.innerHTML = '<head></head><body></body>';
  });

  test('centraliza seletores críticos de input, send, stop, response e error', () => {
    const { selectors } = loadModules();

    expect(selectors.SELECTORS.INPUT).toContain('contenteditable');
    expect(selectors.SELECTORS.SEND).toContain('send-button');
    expect(selectors.SELECTORS.STOP).toMatch(/Stop|stop-generating/);
    expect(selectors.SELECTORS.RESPONSE).toContain('model-response');
    expect(selectors.SELECTORS.ERROR).toContain('[role="alert"]');
  });

  test('isElementVisible rejeita display:none, aria-hidden e aceita retângulo visível', () => {
    const { dom } = loadModules();
    const element = document.createElement('button');
    document.body.appendChild(element);
    visibleRect(element);

    expect(dom.isElementVisible(element)).toBe(true);

    element.style.display = 'none';
    expect(dom.isElementVisible(element)).toBe(false);

    element.style.display = '';
    element.setAttribute('aria-hidden', 'true');
    expect(dom.isElementVisible(element)).toBe(false);
  });

  test('isControlEnabled respeita disabled e aria-disabled sem mutar o controle', () => {
    const { dom } = loadModules();
    const button = document.createElement('button');

    expect(dom.isControlEnabled(button)).toBe(true);

    button.disabled = true;
    expect(dom.isControlEnabled(button)).toBe(false);
    expect(button.disabled).toBe(true);

    button.disabled = false;
    button.setAttribute('aria-disabled', 'true');
    expect(dom.isControlEnabled(button)).toBe(false);
    expect(button.getAttribute('aria-disabled')).toBe('true');
  });

  test('findAllDeep atravessa shadow roots sem depender de splice textual do monólito', () => {
    const { dom } = loadModules();
    const host = document.createElement('div');
    document.body.appendChild(host);
    const shadow = host.attachShadow({ mode: 'open' });
    const nested = document.createElement('button');
    nested.setAttribute('data-test-id', 'inside-shadow');
    shadow.appendChild(nested);

    const found = dom.findAllDeep(document.body, element =>
      element.getAttribute && element.getAttribute('data-test-id') === 'inside-shadow'
    );

    expect(found).toEqual([nested]);
  });

  test('getEditableElement preserva a semântica histórica de ql-editor/contenteditable', () => {
    const { dom } = loadModules();
    const root = document.createElement('rich-textarea');
    const editable = document.createElement('div');
    editable.className = 'ql-editor';
    editable.setAttribute('contenteditable', 'true');
    root.appendChild(editable);

    expect(dom.getEditableElement(root)).toBe(editable);
    expect(dom.getEditableElement(editable)).toBe(editable);
  });

  test('helpers de imagem preservam source, blacklist e ownership por resposta do modelo', () => {
    const { dom } = loadModules();
    const response = document.createElement('model-response');
    const img = document.createElement('img');
    img.dataset.src = 'https://cdn.example/result.png';
    response.appendChild(img);
    document.body.appendChild(response);

    expect(dom.getImageSource(img)).toContain('https://cdn.example/result.png');
    expect(dom.isIgnoredGeminiImageSource('https://example.com/avatar.png')).toBe(true);
    expect(dom.isIgnoredGeminiImageSource('https://cdn.example/result.png')).toBe(false);
    expect(dom.isModelResponseImage(img)).toBe(true);
  });

  test('findSendButton prefere candidato semântico e ignora stop/feedback', () => {
    const { dom } = loadModules();

    const stop = document.createElement('button');
    stop.setAttribute('aria-label', 'Stop generating');
    document.body.appendChild(stop);

    const feedback = document.createElement('button');
    feedback.setAttribute('aria-label', 'Send feedback');
    document.body.appendChild(feedback);

    const send = document.createElement('button');
    send.setAttribute('aria-label', 'Send message');
    document.body.appendChild(send);

    expect(dom.findSendButton(document.body)).toBe(send);
  });

  test('findVisibleStopButton ignora nó Stop oculto', () => {
    const { dom } = loadModules();

    const hidden = document.createElement('button');
    hidden.setAttribute('aria-label', 'Stop');
    hidden.style.display = 'none';
    visibleRect(hidden);
    document.body.appendChild(hidden);

    expect(dom.findVisibleStopButton(document)).toBeNull();

    const visible = document.createElement('button');
    visible.setAttribute('aria-label', 'Stop');
    visibleRect(visible);
    document.body.appendChild(visible);

    expect(dom.findVisibleStopButton(document)).toBe(visible);
  });
});
