'use strict';
// background/actions/check-extraction-tab.js — Identifica abas temporárias de extração

(function(scope) {
  if (!scope.MangaTranslatorRouter) {
    throw new Error('MangaTranslatorRouter indisponível');
  }

  scope.MangaTranslatorRouter.registerAction({
    name: 'check-extraction-tab',
    meta: {
      allowedSources: ['any'],
      async: false,
    },
    execute(_request, context) {
      const tabId = context.sender && context.sender.tab ? context.sender.tab.id : -1;
      const extractionTabs = context.state.extractionTabs || {};
      const mapping = extractionTabs[tabId];

      if (mapping) {
        return { isExtractionTab: true, ...mapping };
      }

      return { isExtractionTab: false };
    },
  });
})(typeof self !== 'undefined' ? self : globalThis);
