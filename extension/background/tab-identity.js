'use strict';
// background/tab-identity.js — Identidade canônica de abas Gemini.
//
// tabId é uma identidade física e pode ser substituído pelo Chromium. Este
// módulo mantém um alias durável old -> new, migra todas as referências do job
// e usa um journal pequeno para tornar o rekey recuperável após suspensão do
// Service Worker.

(function(scope) {
  const ALIAS_PREFIX = 'gemini_tab_alias_';
  const ALIAS_INDEX_KEY = 'gemini_tab_alias_index';
  const MIGRATION_PREFIX = 'gemini_tab_migration_';
  const MIGRATION_INDEX_KEY = 'gemini_tab_migration_index';
  const DEFAULT_ALIAS_TTL_MS = 10 * 60 * 1000;
  const MAX_ALIAS_HOPS = 8;

  function createTabIdentity({
    state,
    log = function() {},
    moveFinalizedTabId = function() {},
    aliasTtlMs = DEFAULT_ALIAS_TTL_MS,
    now = () => Date.now(),
  } = {}) {
    if (!state) throw new Error('tab-identity requer state');

    const aliasKey = tabId => `${ALIAS_PREFIX}${tabId}`;
    const migrationKey = (oldTabId, newTabId, jobId) =>
      `${MIGRATION_PREFIX}${jobId || `${oldTabId}_${newTabId}`}`;

    async function addIndexValue(key, value) {
      const data = await chrome.storage.local.get([key]);
      const list = Array.isArray(data[key]) ? data[key].slice() : [];
      if (!list.includes(value)) list.push(value);
      await chrome.storage.local.set({ [key]: list });
    }

    async function removeIndexValue(key, value) {
      const data = await chrome.storage.local.get([key]);
      const list = Array.isArray(data[key]) ? data[key].filter(item => item !== value) : [];
      await chrome.storage.local.set({ [key]: list });
    }

    function validTabId(tabId) {
      return Number.isInteger(tabId) && tabId >= 0;
    }

    async function resolveCanonicalTabId(tabId) {
      if (!validTabId(tabId)) return tabId;
      const original = tabId;
      let current = tabId;
      const visited = new Set();

      for (let hop = 0; hop < MAX_ALIAS_HOPS; hop += 1) {
        if (visited.has(current)) {
          log('error', 'bg', 'TAB_ALIAS_CYCLE', 'Ciclo detectado em aliases de aba', {
            oldTabId: original,
            cycleTabId: current,
          });
          return original;
        }
        visited.add(current);

        const key = aliasKey(current);
        const data = await chrome.storage.local.get([key]);
        const alias = data && data[key];
        if (!alias) return current;
        if (!validTabId(alias.newTabId) || !alias.expiresAt || alias.expiresAt <= now()) {
          return current;
        }
        current = alias.newTabId;
      }

      log('error', 'bg', 'TAB_ALIAS_MAX_HOPS', 'Limite de aliases excedido', {
        oldTabId: original,
        lastTabId: current,
      });
      return original;
    }

    async function persistAlias(oldTabId, newTabId) {
      if (!validTabId(oldTabId) || !validTabId(newTabId) || oldTabId === newTabId) return null;
      const alias = {
        oldTabId,
        newTabId,
        createdAt: now(),
        expiresAt: now() + aliasTtlMs,
      };
      await chrome.storage.local.set({ [aliasKey(oldTabId)]: alias });
      await addIndexValue(ALIAS_INDEX_KEY, oldTabId);
      log('info', 'bg', 'TAB_ALIAS_CREATED', 'Alias durável de aba criado', { oldTabId, newTabId });
      return alias;
    }

    async function migrateReferences(oldTabId, newTabId) {
      const mutateSnapshot = snapshot => {
        const next = { ...snapshot };
        next.jobIndex = (Array.isArray(snapshot.jobIndex) ? snapshot.jobIndex : []).map(entry =>
          entry && entry.geminiTabId === oldTabId
            ? { ...entry, geminiTabId: newTabId }
            : entry
        );

        const extractionTabs = { ...(snapshot.extractionTabs || {}) };
        Object.keys(extractionTabs).forEach(key => {
          const info = extractionTabs[key];
          if (info && info.geminiTabId === oldTabId) {
            extractionTabs[key] = { ...info, geminiTabId: newTabId };
          }
        });
        next.extractionTabs = extractionTabs;
        return next;
      };

      if (typeof state.replaceGeminiTabReferences === 'function') {
        await state.replaceGeminiTabReferences(oldTabId, newTabId);
      } else if (typeof state.mutate === 'function') {
        await state.mutate(mutateSnapshot);
      } else {
        const snapshot = typeof state.get === 'function' ? state.get() : state;
        const next = mutateSnapshot(snapshot || {});
        if (typeof state.patch === 'function') state.patch(next);
        else {
          state.jobIndex = next.jobIndex;
          state.extractionTabs = next.extractionTabs;
        }
      }
      moveFinalizedTabId(oldTabId, newTabId);
    }

    function alarmGet(name) {
      return new Promise(resolve => {
        try {
          chrome.alarms.get(name, alarm => resolve(alarm || null));
        } catch (_error) {
          resolve(null);
        }
      });
    }

    async function moveAlarm(oldName, newName) {
      const alarm = await alarmGet(oldName);
      if (!alarm) return false;
      await chrome.alarms.clear(oldName);
      const when = Number(alarm.scheduledTime);
      if (Number.isFinite(when) && when > now()) chrome.alarms.create(newName, { when });
      else chrome.alarms.create(newName, { delayInMinutes: 0.01 });
      return true;
    }

    async function writeJournal(key, journal, phase) {
      const next = { ...journal, phase, updatedAt: now() };
      await chrome.storage.local.set({ [key]: next });
      return next;
    }

    async function performMigration(oldTabId, requestedNewTabId, {
      journalKey = null,
      jobId = null,
      recovering = false,
    } = {}) {
      if (!validTabId(oldTabId) || !validTabId(requestedNewTabId) || oldTabId === requestedNewTabId) {
        return requestedNewTabId;
      }

      const newTabId = await resolveCanonicalTabId(requestedNewTabId);
      const key = journalKey || migrationKey(oldTabId, newTabId, jobId);
      const existing = await chrome.storage.local.get([key]);
      let journal = existing && existing[key];
      if (!journal) {
        journal = {
          oldTabId,
          newTabId,
          jobId: jobId || null,
          phase: 'alias_written',
          createdAt: now(),
          updatedAt: now(),
        };
        await chrome.storage.local.set({ [key]: journal });
      }
      await addIndexValue(MIGRATION_INDEX_KEY, key);

      log('info', 'bg', recovering ? 'TAB_REKEY_RECOVERED' : 'TAB_REKEY_BEGIN',
        recovering ? 'Retomando migração de identidade de aba' : 'Iniciando migração de identidade de aba',
        { oldTabId, newTabId, phase: journal.phase });

      const oldJobKey = `gemini_job_${oldTabId}`;
      const newJobKey = `gemini_job_${newTabId}`;
      const oldWdKey = `wd_data_${oldTabId}`;
      const newWdKey = `wd_data_${newTabId}`;
      const oldRecoveryKey = `gemini_delete_recovery_${oldTabId}`;
      const newRecoveryKey = `gemini_delete_recovery_${newTabId}`;
      const oldFinalizedKey = `gemini_finalized_${oldTabId}`;
      const newFinalizedKey = `gemini_finalized_${newTabId}`;

      const keys = [
        oldJobKey, newJobKey,
        oldWdKey, newWdKey,
        oldRecoveryKey, newRecoveryKey,
        oldFinalizedKey, newFinalizedKey,
      ];
      const data = await chrome.storage.local.get(keys);
      const writes = {};

      const oldJob = data[oldJobKey];
      const newJob = data[newJobKey];

      if (
        oldJob && newJob &&
        oldJob.jobId && newJob.jobId &&
        oldJob.jobId !== newJob.jobId
      ) {
        log('error', 'bg', 'TAB_REKEY_CONFLICT', 'Destino de rekey já pertence a outro job', {
          oldTabId,
          newTabId,
          oldJobIdPrefix: String(oldJob.jobId).slice(0, 8),
          newJobIdPrefix: String(newJob.jobId).slice(0, 8),
        });
        throw new Error('TAB_REKEY_CONFLICT');
      }

      if (oldJob) {
        if (!newJob || !newJob.jobId || !oldJob.jobId || newJob.jobId === oldJob.jobId) {
          writes[newJobKey] = {
            ...oldJob,
            geminiTabId: newTabId,
            canonicalTabId: newTabId,
            replacementCount: (Number(oldJob.replacementCount) || 0) + 1,
            updatedAt: now(),
          };
          if (!journal.jobId && oldJob.jobId) journal.jobId = oldJob.jobId;
        }
      }

      if (data[oldWdKey] && !data[newWdKey]) {
        writes[newWdKey] = { ...data[oldWdKey], geminiTabId: newTabId };
      }
      if (data[oldRecoveryKey] && !data[newRecoveryKey]) {
        const value = data[oldRecoveryKey];
        writes[newRecoveryKey] = value && typeof value === 'object'
          ? { ...value, geminiTabId: newTabId }
          : value;
      }
      if (data[oldFinalizedKey] && !data[newFinalizedKey]) {
        writes[newFinalizedKey] = data[oldFinalizedKey];
      }

      if (Object.keys(writes).length) await chrome.storage.local.set(writes);
      journal = await writeJournal(key, journal, 'records_copied');

      await migrateReferences(oldTabId, newTabId);
      journal = await writeJournal(key, journal, 'state_updated');

      const legacyWatchdogMoved = await moveAlarm(`watchdog_${oldTabId}`, `watchdog_${newTabId}`);
      await moveAlarm(`finalization_marker_${oldTabId}`, `finalization_marker_${newTabId}`);
      journal = await writeJournal(key, { ...journal, legacyWatchdogMoved }, 'alarms_updated');

      await chrome.storage.local.remove([
        oldJobKey,
        oldWdKey,
        oldRecoveryKey,
        oldFinalizedKey,
      ]);
      journal = await writeJournal(key, journal, 'old_keys_removed');

      journal = await writeJournal(key, journal, 'completed');
      await removeIndexValue(MIGRATION_INDEX_KEY, key);

      log('info', 'bg', 'TAB_REKEY_END', 'Migração de identidade de aba concluída', {
        oldTabId,
        newTabId,
        phase: journal.phase,
      });
      return newTabId;
    }

    async function migrateTabIdentity(oldTabId, newTabId, options = {}) {
      return performMigration(oldTabId, newTabId, options);
    }

    async function recordReplacement(addedTabId, removedTabId) {
      if (!validTabId(addedTabId) || !validTabId(removedTabId) || addedTabId === removedTabId) {
        return addedTabId;
      }
      await persistAlias(removedTabId, addedTabId);
      return performMigration(removedTabId, addedTabId);
    }

    async function recoverPendingMigrations() {
      const data = await chrome.storage.local.get([MIGRATION_INDEX_KEY]);
      const keys = Array.isArray(data[MIGRATION_INDEX_KEY]) ? data[MIGRATION_INDEX_KEY].slice() : [];
      let recovered = 0;

      for (const key of keys) {
        // eslint-disable-next-line no-await-in-loop
        const stored = await chrome.storage.local.get([key]);
        const journal = stored && stored[key];
        if (!journal || journal.phase === 'completed') {
          // eslint-disable-next-line no-await-in-loop
          await removeIndexValue(MIGRATION_INDEX_KEY, key);
          continue;
        }
        if (!validTabId(journal.oldTabId) || !validTabId(journal.newTabId)) {
          // eslint-disable-next-line no-await-in-loop
          await removeIndexValue(MIGRATION_INDEX_KEY, key);
          continue;
        }
        // A migração é idempotente: copiar um registro já copiado e remover
        // uma chave já removida não altera a contabilidade.
        // eslint-disable-next-line no-await-in-loop
        await performMigration(journal.oldTabId, journal.newTabId, {
          journalKey: key,
          jobId: journal.jobId || null,
          recovering: true,
        });
        recovered += 1;
      }
      return recovered;
    }

    async function cleanupExpiredAliases() {
      const data = await chrome.storage.local.get([ALIAS_INDEX_KEY]);
      const ids = Array.isArray(data[ALIAS_INDEX_KEY]) ? data[ALIAS_INDEX_KEY].slice() : [];
      const keep = [];
      const remove = [];

      for (const tabId of ids) {
        const key = aliasKey(tabId);
        // eslint-disable-next-line no-await-in-loop
        const stored = await chrome.storage.local.get([key]);
        const alias = stored && stored[key];
        if (alias && validTabId(alias.newTabId) && alias.expiresAt > now()) keep.push(tabId);
        else remove.push(key);
      }

      if (remove.length) await chrome.storage.local.remove(remove);
      await chrome.storage.local.set({ [ALIAS_INDEX_KEY]: keep });
      return { kept: keep.length, removed: remove.length };
    }

    return {
      recordReplacement,
      resolveCanonicalTabId,
      migrateTabIdentity,
      recoverPendingMigrations,
      migrateReferences,
      cleanupExpiredAliases,
      constants: {
        ALIAS_PREFIX,
        ALIAS_INDEX_KEY,
        MIGRATION_PREFIX,
        MIGRATION_INDEX_KEY,
        DEFAULT_ALIAS_TTL_MS,
        MAX_ALIAS_HOPS,
      },
    };
  }

  scope.MangaTranslatorTabIdentity = { createTabIdentity };
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { createTabIdentity };
  }
})(typeof self !== 'undefined' ? self : globalThis);
