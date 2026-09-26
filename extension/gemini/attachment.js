'use strict';
// gemini/attachment.js — Upload de imagem com confirmação orientada a mutation.

(function(scope) {
  let domApi = scope.MangaTranslatorGeminiDom || null;
  if (!domApi && typeof require === 'function') {
    try { domApi = require('./dom.js'); } catch (_e) {}
  }
  if (!domApi) throw new Error('MangaTranslatorGeminiDom indisponível');

  function findFileInputsDeep(root) {
    return domApi.findAllDeep(root, element =>
      String(element.tagName || '').toUpperCase() === 'INPUT' &&
      String(element.type || element.getAttribute?.('type') || '').toLowerCase() === 'file'
    );
  }

  function findAttachmentThumbnailDeep(root) {
    const containers = domApi.findAllDeep(root, element => {
      const tag = String(element.tagName || '').toLowerCase();
      const tid = String(
        element.getAttribute?.('data-test-id') ||
        element.getAttribute?.('data-testid') ||
        ''
      ).toLowerCase();
      const className = typeof element.className === 'string' ? element.className.toLowerCase() : '';
      return tag === 'file-preview' ||
        tag === 'attachment-card' ||
        tid.includes('attachment') ||
        tid.includes('preview') ||
        className.includes('file-preview') ||
        className.includes('attachment-preview') ||
        className.includes('image-preview') ||
        className.includes('attachment-container');
    });

    for (const container of containers) {
      let rect = null;
      try { rect = container.getBoundingClientRect(); } catch (_e) {}
      if (rect && rect.width > 20 && rect.height > 20) {
        const img = container.querySelector ? container.querySelector('img') : null;
        return {
          el: container,
          img,
          type: 'container',
          selector: String(container.tagName || '').toLowerCase(),
        };
      }
    }

    const images = domApi.findAllDeep(root, element =>
      String(element.tagName || '').toUpperCase() === 'IMG'
    );
    for (const img of images) {
      const src = domApi.getImageSource(img);
      if (src.startsWith('blob:') || (src.startsWith('data:image/') && src.length > 500)) {
        return { el: img, img, type: 'blob-img', selector: 'img[src^="blob:"]' };
      }

      const parentArea = img.closest
        ? img.closest('rich-textarea, .input-area, .chat-input, input-area')
        : null;
      if (parentArea && !domApi.isIgnoredGeminiImageSource(src)) {
        const width = Number(img.naturalWidth || img.width || 0);
        const height = Number(img.naturalHeight || img.height || 0);
        if (width > 20 && height > 20) {
          return { el: img, img, type: 'input-img', selector: 'input-area img' };
        }
      }
    }

    return null;
  }

  function buildDataTransfer(file) {
    const transfer = new DataTransfer();
    transfer.items.add(file);
    return transfer;
  }

  function dispatchAttachmentAttempt({ editor, editorRoot, root, transfer }) {
    let attempted = false;

    try {
      const paste = new ClipboardEvent('paste', {
        bubbles: true,
        cancelable: true,
        composed: true,
        clipboardData: transfer,
      });
      editor.dispatchEvent(paste);
      attempted = true;
    } catch (_e) {}

    if (editorRoot && editorRoot !== editor) {
      try {
        editorRoot.dispatchEvent(new ClipboardEvent('paste', {
          bubbles: true,
          cancelable: true,
          composed: true,
          clipboardData: transfer,
        }));
        attempted = true;
      } catch (_e) {}
    }

    try {
      root.dispatchEvent(new ClipboardEvent('paste', {
        bubbles: true,
        cancelable: true,
        composed: true,
        clipboardData: transfer,
      }));
      attempted = true;
    } catch (_e) {}

    for (const input of findFileInputsDeep(root.body || root.documentElement || root)) {
      try {
        input.files = transfer.files;
        input.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
        input.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
        attempted = true;
      } catch (_e) {}
    }

    try {
      editorRoot.dispatchEvent(new DragEvent('drop', {
        bubbles: true,
        cancelable: true,
        composed: true,
        dataTransfer: transfer,
      }));
      attempted = true;
    } catch (_e) {}

    return attempted;
  }

  function waitForAttachment({
    root,
    timeoutMs,
    MutationObserverImpl,
    setTimeoutFn,
    clearTimeoutFn,
  }) {
    return new Promise(resolve => {
      let settled = false;
      let observer = null;
      let timer = null;

      const finish = result => {
        if (settled) return;
        settled = true;
        if (observer) observer.disconnect();
        if (timer) clearTimeoutFn(timer);
        resolve(result);
      };

      const inspect = () => {
        const evidence = findAttachmentThumbnailDeep(root.body || root.documentElement || root);
        if (evidence) finish({ confirmed: true, evidence });
      };

      observer = new MutationObserverImpl(inspect);
      observer.observe(root.body || root.documentElement || root, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['src', 'class', 'data-test-id', 'data-testid'],
      });
      timer = setTimeoutFn(() => finish({ confirmed: false, evidence: null }), timeoutMs);
      inspect();
    });
  }

  async function attachFile({
    file,
    editor,
    editorRoot = editor,
    root = document,
    timeoutMs = 15000,
    retryAfterMs = 2000,
    maxDispatches = 3,
    sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
    MutationObserverImpl = typeof MutationObserver !== 'undefined' ? MutationObserver : null,
    setTimeoutFn = setTimeout,
    clearTimeoutFn = clearTimeout,
  } = {}) {
    if (!file || !editor || !root || !MutationObserverImpl) {
      return { confirmed: false, attempted: false, evidence: null };
    }

    try { editor.focus?.({ preventScroll: true }); } catch (_e) {}
    try { editorRoot?.focus?.({ preventScroll: true }); } catch (_e) {}

    const transfer = buildDataTransfer(file);
    const waiting = waitForAttachment({
      root,
      timeoutMs,
      MutationObserverImpl,
      setTimeoutFn,
      clearTimeoutFn,
    });

    let attempted = dispatchAttachmentAttempt({ editor, editorRoot, root, transfer });

    // MutationObserver é a fonte primária. Retries são poucos e apenas repetem
    // a tentativa de upload se o framework não reagiu imediatamente.
    for (let dispatch = 1; dispatch < maxDispatches; dispatch += 1) {
      const early = await Promise.race([
        waiting.then(result => ({ kind: 'result', result })),
        sleep(retryAfterMs).then(() => ({ kind: 'retry' })),
      ]);
      if (early.kind === 'result') {
        return { ...early.result, attempted };
      }
      attempted = dispatchAttachmentAttempt({ editor, editorRoot, root, transfer }) || attempted;
    }

    const result = await waiting;
    return { ...result, attempted };
  }

  const api = {
    findFileInputsDeep,
    findAttachmentThumbnailDeep,
    dispatchAttachmentAttempt,
    attachFile,
  };

  scope.MangaTranslatorGeminiAttachment = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof self !== 'undefined' ? self : globalThis);
