'use strict';
// gemini/temporary-chat.js — Ativação verificável de conversa temporária.

(function(scope) {
  const KEYWORDS = ['momentân', 'momentan', 'temporár', 'temporar', 'temporary'];

  function textOf(element) {
    if (!element) return '';
    return [
      element.innerText,
      element.textContent,
      element.getAttribute && element.getAttribute('aria-label'),
      element.getAttribute && element.getAttribute('title'),
      element.getAttribute && element.getAttribute('data-test-id'),
      element.getAttribute && element.getAttribute('data-testid'),
    ].filter(Boolean).join(' ').trim().toLowerCase();
  }

  function hasTemporarySemantics(element) {
    const text = textOf(element);
    return KEYWORDS.some(keyword => text.includes(keyword)) ||
      text.includes('conversa moment') ||
      text.includes('temp chat');
  }

  function findInTree(root, predicate) {
    if (!root) return null;
    try {
      if (predicate(root)) return root;
    } catch (_e) {}

    try {
      if (root.shadowRoot) {
        const found = findInTree(root.shadowRoot, predicate);
        if (found) return found;
      }
    } catch (_e) {}

    const children = root.children || [];
    for (let index = 0; index < children.length; index += 1) {
      const found = findInTree(children[index], predicate);
      if (found) return found;
    }
    return null;
  }

  function findTempChatButton(root = document) {
    const all = Array.from(root.querySelectorAll(
      'button, [role="button"], [role="switch"], a, div[tabindex], span[tabindex]'
    ));
    for (const element of all) {
      if (hasTemporarySemantics(element)) {
        return element.closest('button, [role="button"], [role="switch"], a') || element;
      }
    }

    const selectors = [
      'button[data-test-id="temp-chat-button"]',
      '[data-test-id="temp-chat-button"]',
      'button[data-test-id*="temp-chat"]',
      '[data-test-id*="temp-chat"]',
      'button[data-testid*="temp-chat"]',
      '[data-testid*="temp-chat"]',
      'button[data-test-id*="moment"]',
      '[data-test-id*="moment"]',
    ];
    for (const selector of selectors) {
      const element = root.querySelector(selector);
      if (element) return element;
    }

    return findInTree(root.body || root, node => {
      if (!node || !node.getAttribute) return false;
      if (!hasTemporarySemantics(node)) return false;
      const tag = String(node.tagName || '').toLowerCase();
      const role = String(node.getAttribute('role') || '').toLowerCase();
      return tag === 'button' || role === 'button' || role === 'switch' || tag === 'a';
    });
  }

  function isAlreadyActive(button, root = document) {
    if (button) {
      const text = textOf(button);
      if (
        (text.includes('desativar') || text.includes('turn off') || text.includes('disable')) &&
        (hasTemporarySemantics(button) || text.includes('chat'))
      ) {
        return true;
      }
      if (text.includes('ativar') || text.includes('turn on') || text.includes('enable')) return false;

      if (button.getAttribute('aria-checked') === 'true') return true;
      if (button.getAttribute('aria-pressed') === 'true') return true;
      if (button.getAttribute('data-state') === 'active') return true;

      const className = String(button.className || '').toLowerCase();
      if (/(^|\s)(active|selected|checked)(\s|$)/.test(className)) return true;
    }

    const indicators = root.querySelectorAll(
      '[data-test-id*="moment"], [data-testid*="moment"], [data-test-id*="temp-chat"], [data-testid*="temp-chat"], .momentary-indicator, .temp-chat-indicator'
    );
    for (const indicator of indicators) {
      if (hasTemporarySemantics(indicator)) return true;
    }

    const closeControls = root.querySelectorAll('button[aria-label], [role="button"][aria-label]');
    for (const control of closeControls) {
      const label = String(control.getAttribute('aria-label') || '').trim().toLowerCase();
      const close = label.includes('fechar') || label.includes('close');
      const temporary = KEYWORDS.some(keyword => label.includes(keyword));
      if (close && temporary) return true;
    }

    const pageText = String(
      root.body && (root.body.innerText || root.body.textContent) || ''
    ).replace(/\s+/g, ' ').trim().toLowerCase();

    const ptPassing =
      (pageText.includes('só dando uma passadinha') || pageText.includes('so dando uma passadinha')) &&
      (pageText.includes('não aparecem nas conversas recentes') || pageText.includes('nao aparecem nas conversas recentes'));

    const ptHistory =
      (
        pageText.includes('conversas temporárias') ||
        pageText.includes('conversas temporarias') ||
        pageText.includes('conversas momentâneas') ||
        pageText.includes('conversas momentaneas')
      ) &&
      (pageText.includes('não aparecem no seu histórico') || pageText.includes('nao aparecem no seu historico'));

    const enPassing =
      pageText.includes('just passing through') &&
      (
        pageText.includes("temporary chats don’t appear in recent chats") ||
        pageText.includes("temporary chats don't appear in recent chats")
      );

    return Boolean(ptPassing || ptHistory || enPassing);
  }

  function triggerClick(element) {
    if (!element) return false;
    try { element.focus({ preventScroll: true }); } catch (_e) {}
    let rect = { left: 0, top: 0, width: 0, height: 0 };
    try { rect = element.getBoundingClientRect() || rect; } catch (_e) {}
    const clientX = rect.width > 0 ? rect.left + rect.width / 2 : 0;
    const clientY = rect.height > 0 ? rect.top + rect.height / 2 : 0;
    const options = { bubbles: true, cancelable: true, view: window, clientX, clientY };

    try { element.dispatchEvent(new PointerEvent('pointerdown', options)); } catch (_e) {}
    try { element.dispatchEvent(new MouseEvent('mousedown', options)); } catch (_e) {}
    try { element.dispatchEvent(new PointerEvent('pointerup', options)); } catch (_e) {}
    try { element.dispatchEvent(new MouseEvent('mouseup', options)); } catch (_e) {}
    try { element.click(); } catch (_e) { return false; }
    return true;
  }

  async function ensureActive({
    root = document,
    timeoutMs = 12000,
    signal = null,
    sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
  } = {}) {
    const start = Date.now();
    let clicked = false;
    let sawSemanticButton = false;

    while (Date.now() - start < timeoutMs) {
      if (signal && signal.aborted) {
        return { status: 'verification_failed', reason: 'aborted' };
      }

      const button = findTempChatButton(root);
      if (button) sawSemanticButton = true;

      if (isAlreadyActive(button, root)) {
        return { status: clicked ? 'activated_verified' : 'already_active' };
      }

      if (button && !clicked) {
        clicked = triggerClick(button);
        await sleep(600);
        continue;
      }

      // Depois do clique, nunca clica novamente sem certeza: somente observa a
      // transição. Isso elimina o risco de alternar ativo->inativo em loop.
      if (clicked) {
        await sleep(250);
        continue;
      }

      await sleep(500);
    }

    if (clicked) return { status: 'verification_failed', reason: 'state_not_verified' };
    if (!sawSemanticButton) return { status: 'unavailable' };
    return { status: 'verification_failed', reason: 'control_not_actionable' };
  }

  const api = {
    ensureActive,
    findInTree,
    findTempChatButton,
    isAlreadyActive,
    triggerClick,
    hasTemporarySemantics,
  };

  scope.MangaTranslatorGeminiTemporaryChat = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof self !== 'undefined' ? self : globalThis);
