'use strict';
// gemini/observer.js — Observer orientado a eventos por job Gemini.
//
// Este módulo não envia mensagens nem clica na UI. Ele observa transições
// verificáveis e expõe Promises para confirmação de submit e resultado.

(function(scope) {
  let selectorsApi = scope.MangaTranslatorGeminiSelectors || null;
  let domApi = scope.MangaTranslatorGeminiDom || null;

  if (typeof require === 'function') {
    if (!selectorsApi) {
      try { selectorsApi = require('./selectors.js'); } catch (_e) {}
    }
    if (!domApi) {
      try { domApi = require('./dom.js'); } catch (_e) {}
    }
  }

  if (!selectorsApi || !selectorsApi.SELECTORS) {
    throw new Error('MangaTranslatorGeminiSelectors indisponível');
  }
  if (!domApi) {
    throw new Error('MangaTranslatorGeminiDom indisponível');
  }

  const { SELECTORS } = selectorsApi;

  function createError(code, message) {
    const error = new Error(message || code);
    error.code = code;
    return error;
  }

  function safeQueryAll(root, selector) {
    if (!root || !selector || typeof root.querySelectorAll !== 'function') return [];
    try { return Array.from(root.querySelectorAll(selector)); } catch (_e) { return []; }
  }

  function createGeminiObserver({
    jobId,
    root = typeof document !== 'undefined' ? document : null,
    editor = null,
    getEditor = null,
    ignoreImages = new Set(),
    onStateChange = null,
    MutationObserverImpl = typeof MutationObserver !== 'undefined' ? MutationObserver : null,
    setTimeoutFn = setTimeout,
    clearTimeoutFn = clearTimeout,
    queueMicrotaskFn = typeof queueMicrotask === 'function'
      ? queueMicrotask
      : callback => Promise.resolve().then(callback),
  } = {}) {
    if (!jobId) throw new Error('jobId é obrigatório');
    if (!root) throw new Error('root é obrigatório');
    if (!MutationObserverImpl) throw new Error('MutationObserver indisponível');

    const registryOwner = root.defaultView || root.ownerDocument?.defaultView || scope;
    registryOwner.__mtGeminiObservers = registryOwner.__mtGeminiObservers || {};

    const existing = registryOwner.__mtGeminiObservers[jobId];
    if (existing && typeof existing.stop === 'function') {
      try { existing.stop(); } catch (_e) {}
    }

    const initialResponses = new Set(safeQueryAll(root, SELECTORS.RESPONSE));
    const initialImageSources = new Set();
    safeQueryAll(root, 'img').forEach(img => {
      const src = domApi.getImageSource(img);
      if (src) initialImageSources.add(src);
    });
    for (const src of ignoreImages || []) {
      if (src) initialImageSources.add(src);
    }

    const initialErrors = new Set();
    safeQueryAll(root, SELECTORS.ERROR).forEach(element => {
      if (!domApi.isElementVisible(element)) return;
      const text = String(element.innerText || element.textContent || '').trim();
      if (text) initialErrors.add(text);
    });

    const initialEditor = typeof getEditor === 'function' ? getEditor() : editor;
    const initialEditorText = String(initialEditor?.textContent || '').trim();
    const initialSendControls = safeQueryAll(root, SELECTORS.SEND)
      .filter(domApi.isElementVisible);
    const initialSendEnabled = initialSendControls.some(domApi.isControlEnabled);

    const state = {
      jobId,
      initialResponseCount: initialResponses.size,
      initialImageSources,
      responseContainer: null,
      ready: false,
      submissionConfirmed: false,
      submissionReason: null,
      generationActiveObserved: false,
      generationStarted: false,
      generationFinished: false,
      sendEnabledObserved: initialSendEnabled,
      resultImage: null,
      resultUrl: null,
      error: null,
      done: false,
      cleanedUp: false,
      observer: null,
      responseObserver: null,
      timers: new Set(),
      inspectionScheduled: false,
      inspectCount: 0,
    };

    const submissionWaiters = new Set();
    const resultWaiters = new Set();

    function emitState(type, extra = {}) {
      if (typeof onStateChange !== 'function') return;
      try {
        onStateChange(type, {
          jobId,
          ...extra,
          submissionConfirmed: state.submissionConfirmed,
          generationActiveObserved: state.generationActiveObserved,
          responseContainer: state.responseContainer,
          resultUrl: state.resultUrl,
          error: state.error,
        });
      } catch (_e) {}
    }

    function removeTimer(timer) {
      if (timer === null || timer === undefined) return;
      state.timers.delete(timer);
      try { clearTimeoutFn(timer); } catch (_e) {}
    }

    function settleWaiters(waiters, mode, payload) {
      for (const waiter of Array.from(waiters)) {
        waiters.delete(waiter);
        removeTimer(waiter.timer);
        try {
          if (mode === 'resolve') waiter.resolve(payload);
          else waiter.reject(payload);
        } catch (_e) {}
      }
    }

    function confirmSubmission(reason) {
      if (state.cleanedUp || state.done || state.submissionConfirmed) return false;
      state.submissionConfirmed = true;
      state.submissionReason = reason;
      emitState('submission_confirmed', { reason });
      settleWaiters(submissionWaiters, 'resolve', {
        confirmed: true,
        reason,
      });
      return true;
    }

    function markGenerationActive(reason) {
      if (state.cleanedUp || state.done) return;
      const wasObserved = state.generationActiveObserved;
      state.generationActiveObserved = true;
      state.generationStarted = true;
      if (!wasObserved) emitState('generation_started', { reason });
      if (!state.submissionConfirmed) confirmSubmission(reason === 'stop_visible' ? 'stop_visible' : 'generation_started');
    }

    function fail(errorText) {
      if (state.cleanedUp || state.done || state.error) return;
      state.error = String(errorText || 'Erro desconhecido do Gemini');
      state.done = true;
      const error = createError('GEMINI_UI_ERROR', state.error);
      emitState('ui_error', { error: state.error });
      settleWaiters(submissionWaiters, 'reject', error);
      settleWaiters(resultWaiters, 'reject', error);
    }

    function setResult(image, url) {
      if (state.cleanedUp || state.done || !url) return false;
      state.resultImage = image || null;
      state.resultUrl = url;
      state.done = true;
      emitState('result_image', { urlKind: String(url).split(':', 1)[0] || 'unknown' });
      settleWaiters(resultWaiters, 'resolve', {
        image: state.resultImage,
        url: state.resultUrl,
      });
      return true;
    }

    function acquireResponseContainer() {
      if (state.responseContainer && state.responseContainer.isConnected !== false) {
        return state.responseContainer;
      }

      const responses = safeQueryAll(root, SELECTORS.RESPONSE);
      const candidates = responses.filter(element => !initialResponses.has(element));
      if (!candidates.length) return null;

      const container = candidates[candidates.length - 1];
      state.responseContainer = container;
      state.generationStarted = true;
      emitState('response_container', { responseIndex: responses.length - 1 });
      confirmSubmission('response_created');

      if (state.responseObserver) {
        try { state.responseObserver.disconnect(); } catch (_e) {}
      }
      state.responseObserver = new MutationObserverImpl(scheduleInspect);
      try {
        state.responseObserver.observe(container, {
          childList: true,
          subtree: true,
          characterData: true,
          attributes: true,
          attributeFilter: ['src', 'aria-hidden', 'style', 'class'],
        });
      } catch (_e) {}

      return container;
    }

    function inspectEditor() {
      if (state.submissionConfirmed || !initialEditorText) return;
      let current = null;
      try {
        current = typeof getEditor === 'function' ? getEditor() : editor;
      } catch (_e) {}
      if (!current) return;
      const currentText = String(current.textContent || '').trim();
      if (currentText.length === 0) confirmSubmission('editor_consumed');
    }

    function inspectControls() {
      const visibleStop = domApi.findVisibleStopButton(root);
      if (visibleStop) {
        markGenerationActive('stop_visible');
      } else if (
        state.generationActiveObserved &&
        state.responseContainer &&
        state.responseContainer.isConnected !== false
      ) {
        if (!state.generationFinished) {
          state.generationFinished = true;
          emitState('generation_finished');
        }
      }

      const sendControls = safeQueryAll(root, SELECTORS.SEND)
        .filter(domApi.isElementVisible);
      const hasEnabledSend = sendControls.some(domApi.isControlEnabled);
      if (hasEnabledSend) state.sendEnabledObserved = true;

      // "Send busy" só é evidência de submit quando houve transição real.
      // Um botão que já nasceu disabled no baseline NÃO confirma envio.
      const transitionedToBusy =
        state.sendEnabledObserved &&
        sendControls.length > 0 &&
        sendControls.every(element => !domApi.isControlEnabled(element));

      if (transitionedToBusy) {
        confirmSubmission('send_busy');
        markGenerationActive('send_busy');
      }
    }

    function inspectErrors() {
      const errors = safeQueryAll(root, SELECTORS.ERROR);
      for (const element of errors) {
        if (!domApi.isElementVisible(element)) continue;
        const text = String(element.innerText || element.textContent || '').trim();
        if (!text || initialErrors.has(text)) continue;
        fail(text);
        return;
      }
    }

    function strongImageUrl(src) {
      return src.startsWith('blob:') ||
        src.startsWith('data:image/') ||
        src.includes('googleusercontent.com/gg-dl/') ||
        src.includes('gemini-result-image');
    }

    function isCandidateImage(image) {
      const src = domApi.getImageSource(image);
      if (!src || state.initialImageSources.has(src) || domApi.isIgnoredGeminiImageSource(src)) {
        return false;
      }

      const width = Number(image.naturalWidth || image.width || 0);
      const height = Number(image.naturalHeight || image.height || 0);
      if (strongImageUrl(src)) return true;
      if (image.complete === false && width <= 0 && height <= 0) return false;
      return width > 0 && height > 0;
    }

    function inspectResult() {
      const container = acquireResponseContainer();
      const images = container
        ? safeQueryAll(container, 'img')
        : domApi.findAllDeep(root.body || root.documentElement || root, element =>
            String(element.tagName || '').toUpperCase() === 'IMG'
          );

      for (let index = images.length - 1; index >= 0; index -= 1) {
        const image = images[index];
        if (!isCandidateImage(image)) continue;

        // Sem response container, o fallback profundo ainda exige imagem
        // NOVA e heurísticas de tamanho/source. O baseline criado antes do
        // submit elimina anexos e imagens antigas do job.
        const src = domApi.getImageSource(image);
        if (setResult(image, src)) return;
      }
    }

    function inspect() {
      if (state.cleanedUp || state.done) return;
      state.inspectCount += 1;

      inspectEditor();
      if (state.cleanedUp || state.done) return;

      acquireResponseContainer();
      inspectControls();
      if (state.cleanedUp || state.done) return;

      inspectErrors();
      if (state.cleanedUp || state.done) return;

      inspectResult();
    }

    function scheduleInspect() {
      if (state.cleanedUp || state.done || state.inspectionScheduled) return;
      state.inspectionScheduled = true;
      queueMicrotaskFn(() => {
        state.inspectionScheduled = false;
        if (state.cleanedUp || state.done) return;
        inspect();
      });
    }

    function start() {
      if (state.cleanedUp || state.ready) return api;
      const observeRoot = root.body || root.documentElement || root;
      state.observer = new MutationObserverImpl(scheduleInspect);
      state.observer.observe(observeRoot, {
        childList: true,
        subtree: true,
        characterData: true,
        attributes: true,
        attributeFilter: [
          'src',
          'disabled',
          'aria-disabled',
          'aria-hidden',
          'style',
          'class',
        ],
      });
      state.ready = true;
      registryOwner.__mtGeminiObservers[jobId] = api;
      emitState('ready', { initialResponseCount: state.initialResponseCount });
      inspect();
      return api;
    }

    function waitForSubmission(timeoutMs = 5000) {
      if (state.submissionConfirmed) {
        return Promise.resolve({
          confirmed: true,
          reason: state.submissionReason,
        });
      }
      if (state.error) {
        return Promise.reject(createError('GEMINI_UI_ERROR', state.error));
      }
      if (state.cleanedUp || state.done) {
        return Promise.reject(createError('OBSERVER_STOPPED', 'Observer já finalizado'));
      }

      return new Promise((resolve, reject) => {
        const waiter = { resolve, reject, timer: null };
        waiter.timer = setTimeoutFn(() => {
          submissionWaiters.delete(waiter);
          state.timers.delete(waiter.timer);
          reject(createError('GEMINI_SUBMISSION_NOT_CONFIRMED', 'Envio não foi confirmado pela UI'));
        }, timeoutMs);
        state.timers.add(waiter.timer);
        submissionWaiters.add(waiter);
      });
    }

    function waitForResult(timeoutMs = 4 * 60 * 1000) {
      if (state.resultUrl) {
        return Promise.resolve({
          image: state.resultImage,
          url: state.resultUrl,
        });
      }
      if (state.error) {
        return Promise.reject(createError('GEMINI_UI_ERROR', state.error));
      }
      if (state.cleanedUp || state.done) {
        return Promise.reject(createError('OBSERVER_STOPPED', 'Observer já finalizado'));
      }

      return new Promise((resolve, reject) => {
        const waiter = { resolve, reject, timer: null };
        waiter.timer = setTimeoutFn(() => {
          resultWaiters.delete(waiter);
          state.timers.delete(waiter.timer);
          reject(createError('GEMINI_RESULT_TIMEOUT', 'Tempo limite aguardando resultado do Gemini'));
        }, timeoutMs);
        state.timers.add(waiter.timer);
        resultWaiters.add(waiter);
      });
    }

    function stop() {
      if (state.cleanedUp) return false;
      state.cleanedUp = true;
      state.done = true;

      if (state.observer) {
        try { state.observer.disconnect(); } catch (_e) {}
        state.observer = null;
      }
      if (state.responseObserver) {
        try { state.responseObserver.disconnect(); } catch (_e) {}
        state.responseObserver = null;
      }

      for (const timer of Array.from(state.timers)) removeTimer(timer);
      const stopped = createError('OBSERVER_STOPPED', 'Observer interrompido');
      settleWaiters(submissionWaiters, 'reject', stopped);
      settleWaiters(resultWaiters, 'reject', stopped);

      if (registryOwner.__mtGeminiObservers?.[jobId] === api) {
        delete registryOwner.__mtGeminiObservers[jobId];
      }
      emitState('cleanup');
      return true;
    }

    function getState() {
      return state;
    }

    function acceptResult(image, url) {
      return setResult(image || null, url);
    }

    const api = {
      start,
      stop,
      inspect,
      scheduleInspect,
      waitForSubmission,
      waitForResult,
      acceptResult,
      getState,
    };

    return api;
  }

  const api = { createGeminiObserver };
  scope.MangaTranslatorGeminiObserver = api;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})(typeof self !== 'undefined' ? self : globalThis);
