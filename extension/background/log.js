'use strict';
// background/log.js — Sistema de log assíncrono do MangaTranslator
// Extraído de background.js para modularização

(function(scope) {
  let _logQueue = [];
  let _logFlushing = false;

  function log(level, source, action, detail, extra = {}) {
      _logQueue.push({ id: `${Date.now()}_${Math.random()}`, ts: Date.now(), level: level || 'info', source: source || 'bg', action: action || 'UNKNOWN', detail: detail || '', extra: extra || {} });
      if (!_logFlushing) _flushLog();
  }

  async function _flushLog() {
      _logFlushing = true;
      try {
          while (_logQueue.length > 0) {
              const batch = _logQueue.splice(0, _logQueue.length);
              const data = await chrome.storage.local.get(['translatorLog']);
              const entries = data.translatorLog || [];
              entries.push(...batch);
              if (entries.length > 500) entries.splice(0, entries.length - 500);
              await chrome.storage.local.set({ translatorLog: entries });
          }
      } catch (e) {}
      _logFlushing = false;
  }

  scope.MangaTranslatorLog = { log, _flushLog };
})(typeof self !== 'undefined' ? self : globalThis);
