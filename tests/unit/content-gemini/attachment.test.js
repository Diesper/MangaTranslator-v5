'use strict';

const path = require('path');

const SELECTORS_PATH = path.resolve(__dirname, '../../../extension/gemini/selectors.js');
const DOM_PATH = path.resolve(__dirname, '../../../extension/gemini/dom.js');
const ATTACHMENT_PATH = path.resolve(__dirname, '../../../extension/gemini/attachment.js');

function loadAttachment() {
  let api;
  jest.isolateModules(() => {
    require(SELECTORS_PATH);
    require(DOM_PATH);
    api = require(ATTACHMENT_PATH);
  });
  return api;
}

function file() {
  return new File([new Uint8Array([1, 2, 3])], 'page.png', { type: 'image/png' });
}

describe('gemini/attachment.js', () => {
  beforeEach(() => {
    document.documentElement.innerHTML = '<head></head><body></body>';
  });

  afterEach(() => {
    jest.restoreAllMocks();
    document.documentElement.innerHTML = '<head></head><body></body>';
  });

  test('confirma attachment somente quando surge evidência observável no DOM', async () => {
    const api = loadAttachment();
    const editor = document.createElement('div');
    editor.setAttribute('contenteditable', 'true');
    document.body.appendChild(editor);

    editor.addEventListener('paste', () => {
      if (document.querySelector('[data-test-id="attachment-preview"]')) return;
      const preview = document.createElement('div');
      preview.setAttribute('data-test-id', 'attachment-preview');
      preview.getBoundingClientRect = () => ({
        top: 0, left: 0, right: 120, bottom: 80, width: 120, height: 80,
      });
      document.body.appendChild(preview);
    });

    await expect(api.attachFile({
      file: file(),
      editor,
      editorRoot: editor,
      root: document,
      timeoutMs: 500,
      retryAfterMs: 50,
      maxDispatches: 2,
    })).resolves.toEqual(expect.objectContaining({
      attempted: true,
      confirmed: true,
      evidence: expect.objectContaining({ type: 'container' }),
    }));
  });

  test('disparar paste/drop sem mudança do DOM não declara sucesso', async () => {
    const api = loadAttachment();
    const editor = document.createElement('div');
    editor.setAttribute('contenteditable', 'true');
    document.body.appendChild(editor);

    const result = await api.attachFile({
      file: file(),
      editor,
      editorRoot: editor,
      root: document,
      timeoutMs: 40,
      retryAfterMs: 5,
      maxDispatches: 2,
    });

    expect(result.attempted).toBe(true);
    expect(result.confirmed).toBe(false);
    expect(result.evidence).toBeNull();
  });

  test('input[type=file] é localizado também em shadow root', () => {
    const api = loadAttachment();
    const host = document.createElement('div');
    const shadow = host.attachShadow({ mode: 'open' });
    const input = document.createElement('input');
    input.type = 'file';
    shadow.appendChild(input);
    document.body.appendChild(host);

    expect(api.findFileInputsDeep(document.body)).toContain(input);
  });
});
