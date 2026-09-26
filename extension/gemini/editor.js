'use strict';
// gemini/editor.js — Interações de editor/submit sem falsificar estado da UI.
//
// Contrato: ações deste módulo representam TENTATIVAS. Sucesso de envio só pode
// ser declarado pelo Observer V2 após uma transição observável do Gemini.

(function(scope) {
  let domApi = scope.MangaTranslatorGeminiDom || null;
  if (!domApi && typeof require === 'function') {
    try { domApi = require('./dom.js'); } catch (_e) {}
  }
  if (!domApi) throw new Error('MangaTranslatorGeminiDom indisponível');

  function focusElement(element) {
    if (!element || typeof element.focus !== 'function') return false;
    try {
      element.focus({ preventScroll: true });
      return true;
    } catch (_e) {
      try { element.focus(); return true; } catch (_e2) { return false; }
    }
  }

  function nudgeEditor(editor) {
    if (!editor) return false;
    focusElement(editor);

    try {
      if (typeof InputEvent === 'function') {
        editor.dispatchEvent(new InputEvent('input', {
          bubbles: true,
          cancelable: false,
          composed: true,
          inputType: 'insertText',
          data: null,
        }));
      } else {
        editor.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
      }
    } catch (_e) {
      try { editor.dispatchEvent(new Event('input', { bubbles: true, composed: true })); } catch (_e2) {}
    }

    try { editor.dispatchEvent(new Event('change', { bubbles: true, composed: true })); } catch (_e) {}
    return true;
  }

  function clickSendButton(button) {
    if (!button || !domApi.isControlEnabled(button)) return false;
    focusElement(button);

    try {
      const opts = { bubbles: true, cancelable: true, composed: true, view: scope.window || scope };
      if (typeof PointerEvent === 'function') {
        button.dispatchEvent(new PointerEvent('pointerdown', opts));
      }
      if (typeof MouseEvent === 'function') {
        button.dispatchEvent(new MouseEvent('mousedown', opts));
        button.dispatchEvent(new MouseEvent('mouseup', opts));
      }
      if (typeof PointerEvent === 'function') {
        button.dispatchEvent(new PointerEvent('pointerup', opts));
      }
      if (typeof button.click === 'function') button.click();
      return true;
    } catch (_e) {
      return false;
    }
  }

  function pressEnter(editor) {
    if (!editor) return false;
    focusElement(editor);
    try {
      editor.dispatchEvent(new KeyboardEvent('keydown', {
        bubbles: true,
        cancelable: true,
        composed: true,
        key: 'Enter',
        code: 'Enter',
        keyCode: 13,
        which: 13,
      }));
      return true;
    } catch (_e) {
      return false;
    }
  }

  async function submitWithConfirmation({
    observer,
    getEditor,
    getSendButton,
    mainWorldFallback,
    onAttempt,
    sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
    maxAttempts = 2,
    confirmationTimeoutMs = 5000,
  } = {}) {
    if (!observer || typeof observer.waitForSubmission !== 'function') {
      throw new Error('Observer de submit é obrigatório');
    }
    if (typeof getEditor !== 'function' || typeof getSendButton !== 'function') {
      throw new Error('getEditor/getSendButton são obrigatórios');
    }

    let lastError = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      if (typeof onAttempt === 'function') {
        try { onAttempt(attempt); } catch (_e) {}
      }

      let editor = getEditor();
      let button = getSendButton();

      // Não altere disabled/aria-disabled. Em vez disso, provoque o framework
      // a reavaliar o conteúdo e reobtenha o controle.
      if (!button || !domApi.isControlEnabled(button)) {
        nudgeEditor(editor);
        await sleep(150);
        editor = getEditor();
        button = getSendButton();
      }

      let attempted = false;
      if (button && domApi.isControlEnabled(button)) {
        attempted = clickSendButton(button);
      } else if (attempt === 1) {
        // Fallback semântico local: Enter. Ainda é apenas uma tentativa.
        attempted = pressEnter(editor);
      } else if (typeof mainWorldFallback === 'function') {
        // MAIN world é último recurso porque pode conhecer o estado interno do
        // framework. O retorno indica somente que a tentativa foi disparada.
        try { attempted = Boolean(await mainWorldFallback()); } catch (_e) { attempted = false; }
      }

      // Mesmo que o click/Enter não possa ser disparado, uma transição já pode
      // ter ocorrido (por exemplo, outro bridge iniciou geração). O observer é
      // a única fonte de verdade.
      try {
        const confirmation = await observer.waitForSubmission(confirmationTimeoutMs);
        return {
          confirmed: true,
          reason: confirmation.reason,
          attempt,
          attempted,
        };
      } catch (error) {
        lastError = error;
        if (error && error.code && error.code !== 'GEMINI_SUBMISSION_NOT_CONFIRMED') {
          throw error;
        }
      }
    }

    const error = new Error('GEMINI_SUBMISSION_NOT_CONFIRMED');
    error.code = 'GEMINI_SUBMISSION_NOT_CONFIRMED';
    error.cause = lastError || null;
    throw error;
  }

  const api = {
    focusElement,
    nudgeEditor,
    clickSendButton,
    pressEnter,
    submitWithConfirmation,
  };

  scope.MangaTranslatorGeminiEditor = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof self !== 'undefined' ? self : globalThis);
