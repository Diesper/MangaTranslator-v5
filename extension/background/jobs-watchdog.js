'use strict';
// background/jobs-watchdog.js -- Persisted watchdog lifecycle and alarm routing.

(function(scope) {
  function createWatchdog({
    getJobIndex,
    getExtractionTabs,
    finalizeJob,
    log,
    timeoutMinutes,
    resolveCanonicalTabId = async tabId => tabId,
  }) {
    const alarmNameFor = (geminiTabId, jobId) => `watchdog_${jobId || geminiTabId}`;

    async function arm(mangaTabId, index, geminiTabId, jobId) {
      const requestedTabId = geminiTabId;
      let canonicalTabId = await resolveCanonicalTabId(requestedTabId);
      const alarmName = alarmNameFor(canonicalTabId, jobId);

      await new Promise(resolve => chrome.alarms.clear(alarmName, resolve));
      await chrome.storage.local.set({
        [`wd_data_${canonicalTabId}`]: {
          mangaTabId,
          index,
          geminiTabId: canonicalTabId,
          jobId,
        },
      });
      chrome.alarms.create(alarmName, { delayInMinutes: timeoutMinutes });

      // Se onReplaced ocorreu depois da resolução inicial mas antes do write,
      // o listener pode ter migrado cedo demais. Re-resolver após o write fecha
      // essa janela sem reiniciar o deadline do watchdog.
      const latestTabId = await resolveCanonicalTabId(requestedTabId);
      if (latestTabId !== canonicalTabId) {
        const oldKey = `wd_data_${canonicalTabId}`;
        const newKey = `wd_data_${latestTabId}`;
        const data = await chrome.storage.local.get([oldKey, newKey]);
        if (data[oldKey] && !data[newKey]) {
          await chrome.storage.local.set({
            [newKey]: { ...data[oldKey], geminiTabId: latestTabId },
          });
        }
        await chrome.storage.local.remove(oldKey);
        canonicalTabId = latestTabId;
      }
      return canonicalTabId;
    }

    function clear(geminiTabId, jobId) {
      chrome.alarms.clear(alarmNameFor(geminiTabId, jobId), () => {
        chrome.storage.local.remove(`wd_data_${geminiTabId}`);
      });
    }

    function handleAlarm(alarm) {
      if (!alarm.name.startsWith('watchdog_')) return false;
      const suffix = alarm.name.slice('watchdog_'.length);
      const indexed = getJobIndex().find(job => job &&
        (String(job.jobId) === suffix || String(job.geminiTabId) === suffix));
      const keys = indexed ? [`wd_data_${indexed.geminiTabId}`] : [];
      if (!keys.includes(`wd_data_${suffix}`)) keys.push(`wd_data_${suffix}`);

      chrome.storage.local.get(keys, async data => {
        const key = keys.find(candidate => data && data[candidate]);
        const watchdog = key ? data[key] : (indexed && {
          geminiTabId: indexed.geminiTabId,
          mangaTabId: indexed.mangaTabId,
          index: indexed.index,
          jobId: indexed.jobId,
        });
        if (!watchdog) return;
        if (key) chrome.storage.local.remove(key);

        const rawTabId = watchdog.geminiTabId || (indexed && indexed.geminiTabId);
        if (rawTabId === undefined || rawTabId === null) return;
        const tabId = await resolveCanonicalTabId(rawTabId);
        log('warn', 'bg', 'JOB_TIMEOUT', `Timeout de ${timeoutMinutes} min no index ${watchdog.index}`, {
          geminiTabId: tabId,
          replacedTabId: rawTabId === tabId ? null : rawTabId,
        });
        if (watchdog.mangaTabId) {
          chrome.tabs.sendMessage(watchdog.mangaTabId, {
            action: 'SHOW_ERROR_INTEGRATED',
            errorMsg: `LIMITE DE TEMPO (${timeoutMinutes} min)`,
            imgIndex: watchdog.index,
            isDebug: false,
          }, () => { if (chrome.runtime.lastError) {} });
        }
        finalizeJob(tabId, watchdog.mangaTabId, true);

        const extractionTabs = getExtractionTabs();
        Object.keys(extractionTabs)
          .filter(tabIdKey => extractionTabs[tabIdKey] &&
            String(extractionTabs[tabIdKey].geminiTabId) === String(tabId))
          .forEach(tabIdKey => {
            const extractionTabId = Number(tabIdKey);
            chrome.tabs.remove(extractionTabId, () => { if (chrome.runtime.lastError) {} });
            delete extractionTabs[extractionTabId];
          });
      });
      return true;
    }

    return { arm, clear, handleAlarm };
  }

  scope.MangaTranslatorJobsWatchdog = { createWatchdog };
})(typeof self !== 'undefined' ? self : globalThis);
