'use strict';

const path = require('path');

const SELECTORS_PATH = path.resolve(__dirname, '../../../extension/gemini/selectors.js');
const DOM_PATH = path.resolve(__dirname, '../../../extension/gemini/dom.js');
const ATTACHMENT_PATH = path.resolve(__dirname, '../../../extension/gemini/attachment.js');

function installDataTransferMock() {
  class MockDataTransfer {
    constructor() {
      const files = [];
      const items = [];
      items.add = item => {
        files.push(item);
        return item;
      };
      this.files = files;
      this.items = items;
    }
  }
  window.DataTransfer = MockDataTransfer;
  global.DataTransfer = MockDataTransfer;
}

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

function makeVisible(element, width = 120, height = 80) {
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
  return element;
}

function addPreview({ parent = document.body, withImage = false, src = 'blob:https://gemini.test/attachment' } = {}) {
  const preview = makeVisible(document.createElement('file-preview'));
  if (withImage) {
    const image = document.createElement('img');
    image.src = src;
    preview.appendChild(image);
  }
  parent.appendChild(preview);
  return preview;
}

describe('gemini/attachment.js', () => {
  beforeEach(() => {
    document.documentElement.innerHTML = '<head></head><body></body>';
    installDataTransferMock();
  });

  afterEach(() => {
    jest.restoreAllMocks();
    document.documentElement.innerHTML = '<head></head><body></body>';
  });

  test('ATT-01: paste só é confirmado quando surge evidência nova no DOM', async () => {
    const api = loadAttachment();
    const editor = document.createElement('div');
    editor.setAttribute('contenteditable', 'true');
    document.body.appendChild(editor);

    editor.addEventListener('paste', () => {
      if (!document.querySelector('file-preview')) addPreview();
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
      methodsAttempted: expect.arrayContaining(['paste']),
    }));
  });

  test('ATT-02: disparar paste/drop sem mudança observável não declara sucesso', async () => {
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
    expect(result.methodsAttempted).toEqual(expect.arrayContaining(['paste', 'drop']));
  });

  test('ATT-03: thumbnail antigo no baseline não é confundido com o upload atual', async () => {
    const api = loadAttachment();
    const editor = document.createElement('div');
    editor.setAttribute('contenteditable', 'true');
    document.body.appendChild(editor);
    const oldPreview = addPreview({ withImage: true, src: 'blob:https://gemini.test/old' });

    const result = await api.attachFile({
      file: file(),
      editor,
      root: document,
      timeoutMs: 35,
      retryAfterMs: 5,
      maxDispatches: 2,
    });

    expect(oldPreview.isConnected).toBe(true);
    expect(result.confirmed).toBe(false);
    expect(result.evidence).toBeNull();
  });

  test('ATT-04: mudança observável em container já existente conta como novo attachment', async () => {
    const api = loadAttachment();
    const editor = document.createElement('div');
    editor.setAttribute('contenteditable', 'true');
    document.body.appendChild(editor);
    const preview = addPreview();

    editor.addEventListener('paste', () => {
      if (preview.querySelector('img')) return;
      const image = document.createElement('img');
      image.src = 'blob:https://gemini.test/new-file';
      preview.appendChild(image);
    });

    const result = await api.attachFile({
      file: file(),
      editor,
      root: document,
      timeoutMs: 300,
      retryAfterMs: 20,
      maxDispatches: 2,
    });

    expect(result.confirmed).toBe(true);
    expect(result.evidence.el).toBe(preview);
  });

  test('ATT-05: input[type=file] funciona como fallback e pode confirmar por preview posterior', async () => {
    const api = loadAttachment();
    const editor = document.createElement('div');
    editor.setAttribute('contenteditable', 'true');
    document.body.appendChild(editor);

    const input = document.createElement('input');
    input.type = 'file';
    // JSDOM exige FileList no setter nativo; nesta fixture queremos observar
    // apenas o contrato do módulo ao atribuir os arquivos do DataTransfer.
    Object.defineProperty(input, 'files', {
      value: [],
      writable: true,
      configurable: true,
    });
    input.addEventListener('change', () => addPreview());
    document.body.appendChild(input);

    const result = await api.attachFile({
      file: file(),
      editor,
      root: document,
      timeoutMs: 300,
      retryAfterMs: 20,
      maxDispatches: 2,
    });

    expect(result.confirmed).toBe(true);
    expect(result.methodsAttempted).toContain('file_input');
    expect(input.files).toHaveLength(1);
  });

  test('ATT-06: drag/drop permanece como fallback inicial', async () => {
    const api = loadAttachment();
    const editor = document.createElement('div');
    editor.setAttribute('contenteditable', 'true');
    document.body.appendChild(editor);

    editor.addEventListener('drop', event => {
      expect(event.dataTransfer).toBeTruthy();
      addPreview();
    });

    const result = await api.attachFile({
      file: file(),
      editor,
      editorRoot: editor,
      root: document,
      timeoutMs: 300,
      retryAfterMs: 20,
      maxDispatches: 2,
    });

    expect(result.confirmed).toBe(true);
    expect(result.methodsAttempted).toContain('drop');
  });

  test('ATT-07: retries preservam paste + file input sem repetir drag/drop', async () => {
    const api = loadAttachment();
    const editor = document.createElement('div');
    editor.setAttribute('contenteditable', 'true');
    document.body.appendChild(editor);

    let pasteCount = 0;
    let dropCount = 0;
    editor.addEventListener('paste', () => { pasteCount += 1; });
    editor.addEventListener('drop', () => { dropCount += 1; });

    const result = await api.attachFile({
      file: file(),
      editor,
      root: document,
      timeoutMs: 40,
      retryAfterMs: 0,
      maxDispatches: 3,
      sleep: async () => {},
    });

    expect(result.confirmed).toBe(false);
    expect(pasteCount).toBe(3);
    expect(dropCount).toBe(1);
  });

  test('ATT-08: input[type=file] é localizado também em shadow root', () => {
    const api = loadAttachment();
    const host = document.createElement('div');
    const shadow = host.attachShadow({ mode: 'open' });
    const input = document.createElement('input');
    input.type = 'file';
    shadow.appendChild(input);
    document.body.appendChild(host);

    expect(api.findFileInputsDeep(document.body)).toContain(input);
  });

  test('ATT-09: baseline ignora mudança cosmética e aceita mudança estrutural de mídia', () => {
    const api = loadAttachment();
    const preview = addPreview({ withImage: true });
    const baseline = api.captureAttachmentBaseline(document);

    expect(api.findAttachmentThumbnailDeep(document, baseline)).toBeNull();

    preview.classList.add('upload-complete');
    expect(api.findAttachmentThumbnailDeep(document, baseline)).toBeNull();

    const image = preview.querySelector('img');
    image.src = 'blob:https://gemini.test/new-attachment';
    expect(api.findAttachmentThumbnailDeep(document, baseline)).toEqual(
      expect.objectContaining({ el: preview, type: 'container' })
    );
  });
});
