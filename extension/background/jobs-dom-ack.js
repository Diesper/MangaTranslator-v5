'use strict';
// background/jobs-dom-ack.js -- Delivers a result and releases the job only after page acknowledgement.

(function(scope) {
  function createDomAckDelivery({ updateJobState, finalizeJob, log, timeoutMs = 30_000 }) {
    function deliver({ mangaTabId, index, src, jobId, batchId, geminiTabId }) {
      updateJobState(geminiTabId, { state: 'result_received' });
      let settled = false;
      let timer = null;
      const settle = (ok, reason) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        if (ok) updateJobState(geminiTabId, { state: 'dom_applied' });
        else log('warn', 'bg', 'DOM_APPLY_FAIL', `Resultado não confirmado pela aba do mangá: ${reason}`, { index, reason });
        finalizeJob(geminiTabId, mangaTabId, !ok);
      };

      timer = setTimeout(() => settle(false, 'ack_timeout'), timeoutMs);
      if (timer && typeof timer.unref === 'function') timer.unref();
      try {
        chrome.tabs.sendMessage(mangaTabId, {
          action: 'UPDATE_IMAGE', index, newSrc: src, jobId, batchId, expectAck: true,
        }, response => {
          const error = chrome.runtime.lastError;
          if (error) {
            const legacyNoAck = /message channel closed/i.test(error.message || '');
            settle(legacyNoAck, legacyNoAck ? 'legacy_no_ack' : (error.message || 'send_failed'));
          } else if (response && response.ok === false) {
            settle(false, response.reason || 'rejected_by_page');
          } else {
            settle(true, 'ack');
          }
        });
      } catch (error) {
        settle(false, error && error.message ? error.message : 'send_exception');
      }
    }
    return { deliver };
  }
  scope.MangaTranslatorJobsDomAck = { createDomAckDelivery };
})(typeof self !== 'undefined' ? self : globalThis);
