'use strict';
// background/actions/force-send-activation.js -- Ativa o envio imediato no Gemini.

(function(scope) {
  scope.MangaTranslatorRouter.registerAction({
    name: 'force-send-activation',

    meta: {
      // O handler legado aceitava a solicitação de qualquer origem.
      allowedSources: ['any'],
      async: false,
    },

    execute(request) {
      const { geminiTabId, mangaTabId, windowId, executionMode } = request;

      chrome.storage.local.get(['geminiExecutionMode'], (storage) => {
        const mode = executionMode || storage.geminiExecutionMode || 'temp_chat';

        if (mode === 'minimized_window' && windowId) {
          chrome.windows.update(windowId, { focused: true }, () => {
            chrome.tabs.sendMessage(
              geminiTabId,
              { action: 'DO_SEND_NOW' },
              () => { if (chrome.runtime.lastError) {} }
            );

            setTimeout(() => {
              chrome.windows.update(
                windowId,
                { state: 'minimized', focused: false },
                () => { if (chrome.runtime.lastError) {} }
              );

              if (mangaTabId) {
                chrome.tabs.get(mangaTabId, (mangaTab) => {
                  if (mangaTab && mangaTab.windowId) {
                    chrome.windows.update(
                      mangaTab.windowId,
                      { focused: true },
                      () => { if (chrome.runtime.lastError) {} }
                    );
                  }
                });
              }
            }, 250);
          });
        } else if (geminiTabId) {
          chrome.tabs.update(geminiTabId, { active: true }, () => {
            chrome.tabs.sendMessage(
              geminiTabId,
              { action: 'DO_SEND_NOW' },
              () => { if (chrome.runtime.lastError) {} }
            );

            setTimeout(() => {
              if (mangaTabId) {
                chrome.tabs.update(
                  mangaTabId,
                  { active: true },
                  () => { if (chrome.runtime.lastError) {} }
                );
              }
            }, 250);
          });
        }
      });
    },
  });
})(typeof self !== 'undefined' ? self : globalThis);
