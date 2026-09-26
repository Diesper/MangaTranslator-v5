'use strict';
// gemini/dom.js — Helpers de DOM puros/testáveis para a automação Gemini.

(function(scope) {
  let selectorsApi = scope.MangaTranslatorGeminiSelectors || null;
  if (!selectorsApi && typeof require === 'function') {
    try { selectorsApi = require('./selectors.js'); } catch (_e) {}
  }
  const SELECTORS = selectorsApi && selectorsApi.SELECTORS ? selectorsApi.SELECTORS : {};

  function isElementVisible(element) {
    if (!element || element.nodeType !== 1) return false;
    if (element.getAttribute && element.getAttribute('aria-hidden') === 'true') return false;

    let style = null;
    try {
      const view = element.ownerDocument && element.ownerDocument.defaultView;
      if (view && typeof view.getComputedStyle === 'function') {
        style = view.getComputedStyle(element);
      }
    } catch (_e) {}

    if (style && (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse')) {
      return false;
    }

    try {
      const rect = element.getBoundingClientRect ? element.getBoundingClientRect() : null;
      const hasRectSize = rect && rect.width > 0 && rect.height > 0;
      const hasLayoutSize = Number(element.offsetWidth) > 0 || Number(element.offsetHeight) > 0;
      const hasClientRect = typeof element.getClientRects === 'function' && element.getClientRects().length > 0;
      return Boolean(hasRectSize || hasLayoutSize || hasClientRect);
    } catch (_e) {
      return false;
    }
  }

  function isControlEnabled(element) {
    return Boolean(element) &&
      element.disabled !== true &&
      element.getAttribute('disabled') === null &&
      element.getAttribute('aria-disabled') !== 'true';
  }

  function findVisible(selector, root) {
    const base = root || (typeof document !== 'undefined' ? document : null);
    if (!base || !selector || typeof base.querySelectorAll !== 'function') return null;
    const elements = base.querySelectorAll(selector);
    for (const element of elements) {
      if (isElementVisible(element)) return element;
    }
    return null;
  }

  function findAllDeep(root, matcher) {
    const list = [];
    if (!root || typeof matcher !== 'function') return list;

    function walk(node) {
      if (!node) return;
      if (node.nodeType === 1) {
        try {
          if (matcher(node)) list.push(node);
        } catch (_e) {}
        try {
          if (node.shadowRoot) walk(node.shadowRoot);
        } catch (_e) {}
      }

      let child = node.firstChild;
      while (child) {
        walk(child);
        child = child.nextSibling;
      }
    }

    walk(root);
    return list;
  }

  function getEditableElement(root) {
    if (!root) return null;
    const editable = root.querySelector
      ? root.querySelector('.ql-editor, [contenteditable="true"]')
      : null;
    if (editable) return editable;

    if (
      root.getAttribute &&
      (
        root.getAttribute('contenteditable') === 'true' ||
        (typeof root.className === 'string' && root.className.includes('ql-editor'))
      )
    ) {
      return root;
    }

    return (root.querySelector && root.querySelector('p')) || root;
  }

  function getImageSource(img) {
    if (!img) return '';
    if (img.dataset && img.dataset.src && !img.src) img.src = img.dataset.src;
    return img.currentSrc ||
      img.src ||
      (img.dataset && img.dataset.src) ||
      (img.getAttribute && img.getAttribute('src')) ||
      '';
  }

  function isIgnoredGeminiImageSource(src) {
    const lower = String(src || '').toLowerCase();
    return !lower ||
      lower.includes('avatar') ||
      lower.includes('favicon') ||
      lower.includes('emoji') ||
      lower.includes('profile') ||
      lower.includes('googleusercontent.com/a/') ||
      lower.includes('gstatic.com/images/branding');
  }

  function isModelResponseImage(img) {
    if (!img) return false;
    const selector = SELECTORS.RESPONSE || [
      'model-response',
      '[data-test-id*="model-response"]',
      '.model-response-text',
      '.response-container',
      '.model-turn',
      '[data-message-author="model"]',
      'message-content.model',
      '.presented-turn-content',
      'bard-model-response',
      'div[data-turn-role="model"]',
      '.model-response-container',
    ].join(', ');

    try {
      return Boolean(img.closest && img.closest(selector));
    } catch (_e) {
      return false;
    }
  }

  function findSendButton(root) {
    const base = root || (typeof document !== 'undefined' ? document.body : null);
    if (!base) return null;

    const allClickables = findAllDeep(base, element => {
      if (!element || element.nodeType !== 1) return false;
      const tag = String(element.tagName || '').toLowerCase();
      const role = String(element.getAttribute('role') || '').toLowerCase();
      return tag === 'button' || role === 'button' || tag.includes('button') || tag === 'mat-icon-button';
    });

    const blacklist = [
      'feedback', 'report', 'survey', 'bug', 'cancel', 'cancelar', 'close',
      'fechar', 'dismiss', 'reject', 'mic', 'microfone', 'voice', 'audio',
      'stop', 'help', 'ajuda', 'clear', 'limpar',
    ];

    for (let index = allClickables.length - 1; index >= 0; index -= 1) {
      const btn = allClickables[index];
      const label = String(btn.getAttribute('aria-label') || '').toLowerCase().trim();
      const tooltip = String(btn.getAttribute('mattooltip') || '').toLowerCase().trim();
      const dataTooltip = String(btn.getAttribute('data-tooltip') || '').toLowerCase().trim();
      const title = String(btn.getAttribute('title') || '').toLowerCase().trim();
      const testId = String(btn.getAttribute('data-test-id') || btn.getAttribute('data-testid') || '').toLowerCase().trim();
      const className = (typeof btn.className === 'string' ? btn.className : '').toLowerCase();
      const text = String(btn.innerText || btn.textContent || '').toLowerCase().trim();

      const combined = `${label} ${tooltip} ${dataTooltip} ${title} ${testId} ${className}`;
      if (blacklist.some(bad => combined.includes(bad))) continue;

      const hasArrowIcon =
        text.includes('arrow_upward') ||
        text.includes('send') ||
        Boolean(btn.querySelector('mat-icon, svg, [data-icon-name*="send"], [data-icon-name*="arrow"]'));

      const isExact =
        label === 'enviar' ||
        label === 'enviar mensagem' ||
        label === 'enviar prompt' ||
        label === 'enviar consulta' ||
        label === 'send' ||
        label === 'send message' ||
        label === 'send prompt' ||
        tooltip === 'enviar' ||
        tooltip === 'enviar mensagem' ||
        tooltip === 'send' ||
        tooltip === 'send message' ||
        dataTooltip === 'enviar' ||
        dataTooltip === 'send' ||
        testId === 'send-button' ||
        className.includes('send-button');

      if (isExact || (hasArrowIcon && (label.includes('enviar') || label.includes('send') || label === ''))) {
        return btn;
      }
    }

    for (let index = allClickables.length - 1; index >= 0; index -= 1) {
      const btn = allClickables[index];
      const label = String(btn.getAttribute('aria-label') || '').toLowerCase().trim();
      const tooltip = String(btn.getAttribute('mattooltip') || '').toLowerCase().trim();
      const className = (typeof btn.className === 'string' ? btn.className : '').toLowerCase();
      const text = String(btn.innerText || btn.textContent || '').toLowerCase().trim();

      const combined = `${label} ${tooltip} ${className} ${text}`;
      if (blacklist.some(bad => combined.includes(bad))) continue;
      if (combined.includes('enviar') || combined.includes('send') || text.includes('arrow_upward')) {
        return btn;
      }
    }

    const doc = base.ownerDocument || (typeof document !== 'undefined' ? document : null);
    const inputArea = doc && doc.querySelector
      ? doc.querySelector(SELECTORS.INPUT_AREA || 'rich-textarea, .input-area, chat-window, .chat-input-container')
      : null;

    if (inputArea) {
      const cRect = inputArea.getBoundingClientRect();
      for (let index = allClickables.length - 1; index >= 0; index -= 1) {
        const btn = allClickables[index];
        const bRect = btn.getBoundingClientRect();
        if (
          bRect.width >= 24 &&
          bRect.height >= 24 &&
          bRect.bottom <= cRect.bottom + 80 &&
          bRect.top >= cRect.top - 20 &&
          bRect.right <= cRect.right + 40 &&
          bRect.left >= cRect.right - 140
        ) {
          const label = String(btn.getAttribute('aria-label') || '').toLowerCase();
          if (!blacklist.some(bad => label.includes(bad))) return btn;
        }
      }
    }

    return null;
  }

  function findVisibleStopButton(root) {
    return findVisible(SELECTORS.STOP, root);
  }

  const api = {
    isElementVisible,
    isControlEnabled,
    findVisible,
    findAllDeep,
    getEditableElement,
    getImageSource,
    isIgnoredGeminiImageSource,
    isModelResponseImage,
    findVisibleStopButton,
    findSendButton,
  };

  scope.MangaTranslatorGeminiDom = api;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})(typeof self !== 'undefined' ? self : globalThis);
