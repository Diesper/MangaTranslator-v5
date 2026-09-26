'use strict';
// background/router.js — Roteador central de mensagens do MangaTranslator
// Substitui a cadeia if/else do chrome.runtime.onMessage em background.js

(function(scope) {
  const actionRegistry = new Map();

  // Mapeamento de nomes legados (SCREAMING_CASE) para canônicos (kebab-case)
  const ACTION_MAP = {
    'START_BATCH': 'start-batch',
    'STOP_BATCH': 'stop-batch',
    'GEMINI_IMAGE_EXTRACTED': 'deliver-result',
    'GEMINI_RESULT_URL': 'deliver-result-url',
    'IMAGE_READY_FROM_NEW_TAB': 'deliver-result-from-tab',
    'GEMINI_ERROR': 'report-error',
    'FETCH_IMAGE_AS_BASE64': 'fetch-image-base64',
    'CALCULATE_VISUAL_FINGERPRINT': 'calculate-visual-fingerprint',
    'DOWNLOAD_IMAGE': 'download-image',
    'DOWNLOAD_CHAPTER_AND_SHOW': 'download-chapter',
    'OPEN_CHAPTER_FOLDER': 'download-chapter',
    'EXPORT_ALL_AND_SHOW': 'export-all',
    'SHOW_EXISTING_FOLDER': 'open-existing-folder',
    'OPEN_MANGA_ROOT': 'open-manga-root',
    'FORCE_SEND_ACTIVATION': 'force-send-activation',
    'SET_DEBUG_MODE': 'set-debug-mode',
    'LOG_ENTRY': 'log-entry',
    'GET_TAB_ID': 'get-tab-id',
    'CLAIM_GEMINI_JOB': 'claim-gemini-job',
    'GEMINI_PROGRESS': 'relay-progress',
    'REQUEST_IMAGE_DATA': 'request-image-data',
    'CHECK_IF_EXTRACTION_TAB': 'check-extraction-tab',
  };

  function registerAction(actionDef) {
    if (!actionDef || !actionDef.name) {
      throw new Error('Ação sem nome');
    }
    actionRegistry.set(actionDef.name, actionDef);
  }

  function resolveActionName(requestAction) {
    return ACTION_MAP[requestAction] || null;
  }

  function identifySource(sender) {
    if (!sender) return 'unknown';
    if (sender.tab && sender.tab.url) {
      if (sender.tab.url.includes('gemini.google.com') ||
          sender.tab.url.includes('127.0.0.1')) {
        return 'gemini';
      }
      return 'content';
    }
    if (sender.id === chrome.runtime.id) return 'popup';
    return 'external';
  }

  function createContext(sender) {
    const log = scope.MangaTranslatorLog ? scope.MangaTranslatorLog.log : function() {};
    const state = scope.MangaTranslatorState || {};
    return {
      state,
      log,
      sender,
      storage: {
        get: (keys) => new Promise(resolve =>
          chrome.storage.local.get(keys, resolve)),
        set: (items) => new Promise(resolve =>
          chrome.storage.local.set(items, resolve)),
        remove: (keys) => new Promise(resolve =>
          chrome.storage.local.remove(keys, resolve)),
      },
    };
  }

  function createMessageRouter({ gtcHandler, smHandler, contextFactory } = {}) {
    const log = scope.MangaTranslatorLog ? scope.MangaTranslatorLog.log : function() {};

    return function onMessage(request, sender, sendResponse) {
      // 1. Delegar GTC_* ao handler existente
      if (request && typeof request.action === 'string' && request.action.startsWith('GTC_')) {
        if (gtcHandler && gtcHandler(request, sender, sendResponse)) {
          return true;
        }
      }

      // 2. Delegar SM_* ao handler existente
      if (request && typeof request.action === 'string' && request.action.startsWith('SM_')) {
        if (smHandler && smHandler(request, sender, sendResponse)) {
          return true;
        }
      }

      // 3. Resolver ação
      if (!request || typeof request.action !== 'string') return false;
      const actionName = resolveActionName(request.action);
      if (!actionName) return false;

      const actionDef = actionRegistry.get(actionName);
      if (!actionDef) {
        log('warn', 'router', 'ACTION_NOT_FOUND',
            'Ação desconhecida: ' + request.action, {});
        return false;
      }

      // 4. Validar origem
      const source = identifySource(sender);
      if (actionDef.meta && actionDef.meta.allowedSources &&
          !actionDef.meta.allowedSources.includes(source) &&
          !actionDef.meta.allowedSources.includes('any')) {
        log('warn', 'router', 'SOURCE_DENIED',
            'Origem ' + source + ' negada para ' + actionName, {});
        sendResponse({ ok: false, error: { code: 'SOURCE_DENIED' } });
        return false;
      }

      // 5. Validar payload
      if (typeof actionDef.validate === 'function') {
        const err = actionDef.validate(request);
        if (err) {
          sendResponse({ ok: false, error: err });
          return false;
        }
      }

      // 6. Contexto
      const context = {
        ...createContext(sender),
        ...(typeof contextFactory === 'function' ? contextFactory(sender) : {}),
      };

      // 7. Executar
      if (actionDef.meta && actionDef.meta.async === false) {
        try {
          const result = actionDef.execute(request, context);
          sendResponse({ ok: true, ...(result || {}) });
        } catch (e) {
          log('error', 'router', 'ACTION_ERROR', e.message, {});
          sendResponse({ ok: false, error: { code: 'INTERNAL_ERROR', message: e.message } });
        }
        return false;
      }

      // Async
      (async () => {
        try {
          const result = await actionDef.execute(request, context);
          sendResponse({ ok: true, ...(result || {}) });
        } catch (e) {
          log('error', 'router', 'ACTION_ERROR', e.message || String(e), {});
          sendResponse({ ok: false, error: { code: 'INTERNAL_ERROR', message: e.message || String(e) } });
        }
      })();
      return true;
    };
  }

  scope.MangaTranslatorRouter = {
    createMessageRouter,
    registerAction,
    resolveActionName,
    identifySource,
    getAction: (name) => actionRegistry.get(name),
    getRegisteredActions: () => Array.from(actionRegistry.keys()),
  };
})(typeof self !== 'undefined' ? self : globalThis);
