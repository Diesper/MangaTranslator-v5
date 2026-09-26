'use strict';

const path = require('path');

const SELECTORS_PATH = path.resolve(__dirname, '../../../extension/gemini/selectors.js');
const DOM_PATH = path.resolve(__dirname, '../../../extension/gemini/dom.js');
const OBSERVER_PATH = path.resolve(__dirname, '../../../extension/gemini/observer.js');
const EDITOR_PATH = path.resolve(__dirname, '../../../extension/gemini/editor.js');

function loadModules() {
  let observerApi;
  let editorApi;
  jest.isolateModules(() => {
    require(SELECTORS_PATH);
    require(DOM_PATH);
    observerApi = require(OBSERVER_PATH);
    editorApi = require(EDITOR_PATH);
  });
  return { observerApi, editorApi };
}

function visibleRect(element, width = 40, height = 40) {
  element.getBoundingClientRect = () => ({
    x: 0, y: 0, top: 0, left: 0,
    right: width, bottom: height, width, height,
    toJSON() { return this; },
  });
}

function mountEditor(text = 'prompt') {
  const editor = document.createElement('div');
  editor.className = 'ql-editor';
  editor.setAttribute('contenteditable', 'true');
  editor.textContent = text;
  document.body.appendChild(editor);
  return editor;
}

function mountSend({ disabled = false, onClick = null } = {}) {
  const button = document.createElement('button');
  button.setAttribute('aria-label', 'Send message');
  button.disabled = disabled;
  visibleRect(button);
  button.addEventListener('click', () => {
    if (typeof onClick === 'function') onClick();
  });
  document.body.appendChild(button);
  return button;
}

function mountStop() {
  const stop = document.createElement('button');
  stop.setAttribute('aria-label', 'Stop generating');
  visibleRect(stop);
  document.body.appendChild(stop);
  return stop;
}

describe('gemini/editor.js — submit confirmado', () => {
  beforeEach(() => {
    document.documentElement.innerHTML = '<head></head><body></body>';
    delete window.__mtGeminiObservers;
  });

  afterEach(() => {
    jest.restoreAllMocks();
    delete window.__mtGeminiObservers;
    document.documentElement.innerHTML = '<head></head><body></body>';
  });

  test('SEND-01: botão habilitado + editor consumido confirma submission', async () => {
    const { observerApi, editorApi } = loadModules();
    const editor = mountEditor('prompt');
    const button = mountSend({ onClick: () => { editor.textContent = ''; } });
    const observer = observerApi.createGeminiObserver({
      jobId: 'send-01',
      editor,
      getEditor: () => editor,
    }).start();

    await expect(editorApi.submitWithConfirmation({
      observer,
      getEditor: () => editor,
      getSendButton: () => button,
      maxAttempts: 2,
      confirmationTimeoutMs: 250,
      sleep: async () => {},
    })).resolves.toEqual(expect.objectContaining({
      confirmed: true,
      reason: 'editor_consumed',
      attempt: 1,
    }));

    observer.stop();
  });

  test('SEND-02: click sem qualquer transição observável não é confirmado', async () => {
    const { observerApi, editorApi } = loadModules();
    const editor = mountEditor('prompt');
    const button = mountSend();
    const observer = observerApi.createGeminiObserver({
      jobId: 'send-02',
      editor,
      getEditor: () => editor,
    }).start();

    await expect(editorApi.submitWithConfirmation({
      observer,
      getEditor: () => editor,
      getSendButton: () => button,
      maxAttempts: 1,
      confirmationTimeoutMs: 30,
      sleep: async () => {},
    })).rejects.toMatchObject({ code: 'GEMINI_SUBMISSION_NOT_CONFIRMED' });

    expect(editor.textContent).toBe('prompt');
    observer.stop();
  });

  test('SEND-03: fallback MAIN disparado sem mudança da UI continua não confirmado', async () => {
    const { observerApi, editorApi } = loadModules();
    const editor = mountEditor('prompt');
    const button = mountSend({ disabled: true });
    const fallback = jest.fn(async () => true);
    const observer = observerApi.createGeminiObserver({
      jobId: 'send-03',
      editor,
      getEditor: () => editor,
    }).start();

    await expect(editorApi.submitWithConfirmation({
      observer,
      getEditor: () => editor,
      getSendButton: () => button,
      mainWorldFallback: fallback,
      maxAttempts: 2,
      confirmationTimeoutMs: 30,
      sleep: async () => {},
    })).rejects.toMatchObject({ code: 'GEMINI_SUBMISSION_NOT_CONFIRMED' });

    expect(fallback).toHaveBeenCalledTimes(1);
    observer.stop();
  });

  test('SEND-04: fallback MAIN + Stop visível é confirmado pelo observer', async () => {
    const { observerApi, editorApi } = loadModules();
    const editor = mountEditor('prompt');
    const button = mountSend({ disabled: true });
    const observer = observerApi.createGeminiObserver({
      jobId: 'send-04',
      editor,
      getEditor: () => editor,
    }).start();

    const fallback = jest.fn(async () => {
      mountStop();
      observer.inspect();
      return true;
    });

    await expect(editorApi.submitWithConfirmation({
      observer,
      getEditor: () => editor,
      getSendButton: () => button,
      mainWorldFallback: fallback,
      maxAttempts: 2,
      confirmationTimeoutMs: 30,
      sleep: async () => {},
    })).resolves.toEqual(expect.objectContaining({
      confirmed: true,
      reason: 'stop_visible',
      attempt: 2,
    }));

    observer.stop();
  });

  test('SEND-05: controle disabled jamais é alterado à força', async () => {
    const { observerApi, editorApi } = loadModules();
    const editor = mountEditor('prompt');
    const button = mountSend({ disabled: true });
    button.setAttribute('aria-disabled', 'true');
    button.setAttribute('disabled', '');
    const observer = observerApi.createGeminiObserver({
      jobId: 'send-05',
      editor,
      getEditor: () => editor,
    }).start();

    await expect(editorApi.submitWithConfirmation({
      observer,
      getEditor: () => editor,
      getSendButton: () => button,
      mainWorldFallback: async () => true,
      maxAttempts: 2,
      confirmationTimeoutMs: 20,
      sleep: async () => {},
    })).rejects.toMatchObject({ code: 'GEMINI_SUBMISSION_NOT_CONFIRMED' });

    expect(button.disabled).toBe(true);
    expect(button.hasAttribute('disabled')).toBe(true);
    expect(button.getAttribute('aria-disabled')).toBe('true');
    observer.stop();
  });

  test('SEND-06: nudge do editor pode habilitar o botão sem mutação forçada', async () => {
    const { observerApi, editorApi } = loadModules();
    const editor = mountEditor('prompt');
    const button = mountSend({
      disabled: true,
      onClick: () => { editor.textContent = ''; },
    });
    editor.addEventListener('input', () => {
      button.disabled = false;
      button.removeAttribute('disabled');
    });
    const observer = observerApi.createGeminiObserver({
      jobId: 'send-06',
      editor,
      getEditor: () => editor,
    }).start();

    await expect(editorApi.submitWithConfirmation({
      observer,
      getEditor: () => editor,
      getSendButton: () => button,
      maxAttempts: 2,
      confirmationTimeoutMs: 250,
      sleep: async () => {},
    })).resolves.toEqual(expect.objectContaining({
      confirmed: true,
      attempt: 1,
    }));
    expect(button.disabled).toBe(false);
    observer.stop();
  });

  test('SEND-07: exatamente duas tentativas falhas terminam cedo', async () => {
    const { observerApi, editorApi } = loadModules();
    const editor = mountEditor('prompt');
    const button = mountSend();
    const attempts = [];
    const observer = observerApi.createGeminiObserver({
      jobId: 'send-07',
      editor,
      getEditor: () => editor,
    }).start();

    const startedAt = Date.now();
    await expect(editorApi.submitWithConfirmation({
      observer,
      getEditor: () => editor,
      getSendButton: () => button,
      onAttempt: attempt => attempts.push(attempt),
      maxAttempts: 2,
      confirmationTimeoutMs: 30,
      sleep: async () => {},
    })).rejects.toMatchObject({ code: 'GEMINI_SUBMISSION_NOT_CONFIRMED' });

    expect(attempts).toEqual([1, 2]);
    expect(Date.now() - startedAt).toBeLessThan(1000);
    observer.stop();
  });
});
