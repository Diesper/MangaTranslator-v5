'use strict';

const path = require('path');
const {
  getStorageMock,
  getTabsMock,
  getAlarmsMock,
} = require('../../mocks/chrome-api.mock.js');

const STATE_PATH = path.resolve(__dirname, '../../../extension/background/state.js');
const TAB_IDENTITY_PATH = path.resolve(__dirname, '../../../extension/background/tab-identity.js');
const RECONCILIATION_PATH = path.resolve(__dirname, '../../../extension/background/jobs-reconciliation.js');
const LIFECYCLE_PATH = path.resolve(__dirname, '../../../extension/background/jobs-lifecycle.js');

function loadState() {
  delete global.MangaTranslatorState;
  jest.isolateModules(() => require(STATE_PATH));
  return global.MangaTranslatorState;
}

function loadIdentityFactory() {
  let api;
  jest.isolateModules(() => {
    api = require(TAB_IDENTITY_PATH);
  });
  return api.createTabIdentity;
}

function loadReconcilerFactory() {
  delete global.MangaTranslatorJobsReconciliation;
  jest.isolateModules(() => require(RECONCILIATION_PATH));
  return global.MangaTranslatorJobsReconciliation.createReconciler;
}

describe('background/tab-identity.js', () => {
  let storage;
  let tabs;
  let alarms;
  let state;
  let log;
  let createTabIdentity;

  beforeEach(async () => {
    storage = getStorageMock();
    tabs = getTabsMock();
    alarms = getAlarmsMock();
    await storage.clear();
    tabs._tabs.clear();
    await alarms.clearAll();

    state = loadState();
    state.patch({
      jobQueue: [],
      jobIndex: [],
      extractionTabs: {},
      activeJobsCount: 0,
      completedJobs: 0,
    });
    log = jest.fn();
    createTabIdentity = loadIdentityFactory();
  });

  test('TAB-01: replacement após persistência migra job, watchdog, índice e referências', async () => {
    state.patch({
      jobIndex: [{ geminiTabId: 100, jobId: 'job-1', batchId: 'batch-1', mangaTabId: 77, index: 5 }],
      extractionTabs: {
        901: { geminiTabId: 100, jobId: 'job-1', batchId: 'batch-1' },
      },
      activeJobsCount: 1,
      completedJobs: 2,
    });
    await storage.set({
      gemini_job_100: {
        geminiTabId: 100,
        jobId: 'job-1',
        batchId: 'batch-1',
        mangaTabId: 77,
        index: 5,
        prompt: 'sensitive prompt',
        createdAt: 1234,
      },
      wd_data_100: { geminiTabId: 100, jobId: 'job-1', mangaTabId: 77, index: 5 },
      gemini_delete_recovery_100: { geminiTabId: 100, jobId: 'job-1' },
      gemini_finalized_100: { jobId: 'job-1', accountingApplied: true, expiresAt: Date.now() + 60_000 },
    });
    chrome.alarms.create('watchdog_100', { delayInMinutes: 4 });
    chrome.alarms.create('finalization_marker_100', { delayInMinutes: 10 });

    const identity = createTabIdentity({ state, log });
    await identity.recordReplacement(200, 100);

    const data = await storage.get([
      'gemini_job_100', 'gemini_job_200',
      'wd_data_100', 'wd_data_200',
      'gemini_delete_recovery_100', 'gemini_delete_recovery_200',
      'gemini_finalized_100', 'gemini_finalized_200',
      'gemini_tab_alias_100',
    ]);

    expect(data.gemini_job_100).toBeUndefined();
    expect(data.gemini_job_200).toEqual(expect.objectContaining({
      geminiTabId: 200,
      canonicalTabId: 200,
      jobId: 'job-1',
      createdAt: 1234,
      replacementCount: 1,
    }));
    expect(data.wd_data_100).toBeUndefined();
    expect(data.wd_data_200).toEqual(expect.objectContaining({ geminiTabId: 200, jobId: 'job-1' }));
    expect(data.gemini_delete_recovery_100).toBeUndefined();
    expect(data.gemini_delete_recovery_200).toEqual(expect.objectContaining({ geminiTabId: 200 }));
    expect(data.gemini_finalized_100).toBeUndefined();
    expect(data.gemini_finalized_200).toEqual(expect.objectContaining({ jobId: 'job-1' }));
    expect(data.gemini_tab_alias_100).toEqual(expect.objectContaining({ oldTabId: 100, newTabId: 200 }));

    expect(state.jobIndex).toEqual([
      expect.objectContaining({ geminiTabId: 200, jobId: 'job-1' }),
    ]);
    expect(state.extractionTabs[901]).toEqual(expect.objectContaining({ geminiTabId: 200 }));
    expect(state.completedJobs).toBe(2);

    expect(await alarms.get('watchdog_100')).toBeNull();
    expect(await alarms.get('watchdog_200')).toEqual(expect.objectContaining({ name: 'watchdog_200' }));
    expect(await alarms.get('finalization_marker_100')).toBeNull();
    expect(await alarms.get('finalization_marker_200')).toEqual(expect.objectContaining({ name: 'finalization_marker_200' }));
  });

  test('TAB-02: replacement antes do job persistido deixa alias durável para o lifecycle', async () => {
    const identity = createTabIdentity({ state, log });

    await identity.recordReplacement(200, 100);

    expect(await identity.resolveCanonicalTabId(100)).toBe(200);
    const data = await storage.get(['gemini_tab_alias_100', 'gemini_job_100', 'gemini_job_200']);
    expect(data.gemini_tab_alias_100).toEqual(expect.objectContaining({ newTabId: 200 }));
    expect(data.gemini_job_100).toBeUndefined();
    expect(data.gemini_job_200).toBeUndefined();
  });

  test('TAB-03: duas substituições formam cadeia e resolvem para a aba mais nova', async () => {
    const identity = createTabIdentity({ state, log });

    await identity.recordReplacement(200, 100);
    await identity.recordReplacement(300, 200);

    expect(await identity.resolveCanonicalTabId(100)).toBe(300);
    expect(await identity.resolveCanonicalTabId(200)).toBe(300);
  });

  test('TAB-04: ciclo inválido é detectado sem escolher uma identidade arbitrária', async () => {
    const future = Date.now() + 60_000;
    await storage.set({
      gemini_tab_alias_100: { oldTabId: 100, newTabId: 200, createdAt: Date.now(), expiresAt: future },
      gemini_tab_alias_200: { oldTabId: 200, newTabId: 100, createdAt: Date.now(), expiresAt: future },
    });
    const identity = createTabIdentity({ state, log });

    expect(await identity.resolveCanonicalTabId(100)).toBe(100);
    expect(log).toHaveBeenCalledWith(
      'error', 'bg', 'TAB_ALIAS_CYCLE', expect.any(String),
      expect.objectContaining({ oldTabId: 100 })
    );
  });

  test('TAB-05: recovery retoma journal intermediário de forma idempotente', async () => {
    state.patch({
      jobIndex: [{ geminiTabId: 100, jobId: 'job-restart', batchId: 'b', mangaTabId: 9, index: 1 }],
      activeJobsCount: 1,
    });
    await storage.set({
      gemini_job_100: { geminiTabId: 100, jobId: 'job-restart', batchId: 'b', mangaTabId: 9, index: 1 },
      gemini_tab_alias_100: {
        oldTabId: 100,
        newTabId: 200,
        createdAt: Date.now(),
        expiresAt: Date.now() + 60_000,
      },
      gemini_tab_migration_job_restart: {
        oldTabId: 100,
        newTabId: 200,
        jobId: 'job-restart',
        phase: 'records_copied',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
      gemini_tab_migration_index: ['gemini_tab_migration_job_restart'],
    });

    const identity = createTabIdentity({ state, log });
    expect(await identity.recoverPendingMigrations()).toBe(1);
    expect(await identity.recoverPendingMigrations()).toBe(0);

    const data = await storage.get([
      'gemini_job_100',
      'gemini_job_200',
      'gemini_tab_migration_job_restart',
      'gemini_tab_migration_index',
    ]);
    expect(data.gemini_job_100).toBeUndefined();
    expect(data.gemini_job_200).toEqual(expect.objectContaining({ geminiTabId: 200, jobId: 'job-restart' }));
    expect(data.gemini_tab_migration_job_restart.phase).toBe('completed');
    expect(data.gemini_tab_migration_index).toEqual([]);
    expect(state.jobIndex).toEqual([expect.objectContaining({ geminiTabId: 200 })]);
  });

  test('TAB-07/TAB-08: extraction e marcador finalizado migram sem alterar contabilidade', async () => {
    state.patch({
      jobIndex: [{ geminiTabId: 100, jobId: 'job-f', batchId: 'b', mangaTabId: 9, index: 1 }],
      extractionTabs: { 500: { geminiTabId: 100, jobId: 'job-f' } },
      completedJobs: 7,
      activeJobsCount: 1,
    });
    await storage.set({
      gemini_job_100: { geminiTabId: 100, jobId: 'job-f' },
      gemini_finalized_100: { jobId: 'job-f', accountingApplied: true, expiresAt: Date.now() + 60_000 },
    });

    const identity = createTabIdentity({ state, log });
    await identity.recordReplacement(200, 100);

    expect(state.extractionTabs[500].geminiTabId).toBe(200);
    expect(state.completedJobs).toBe(7);
    expect((await storage.get('gemini_finalized_200')).gemini_finalized_200)
      .toEqual(expect.objectContaining({ accountingApplied: true }));
  });

  test('TAB-09: alias expirado não autoriza takeover da aba antiga', async () => {
    await storage.set({
      gemini_tab_alias_100: {
        oldTabId: 100,
        newTabId: 200,
        createdAt: Date.now() - 120_000,
        expiresAt: Date.now() - 1,
      },
      gemini_tab_alias_index: [100],
    });
    const identity = createTabIdentity({ state, log });

    expect(await identity.resolveCanonicalTabId(100)).toBe(100);
    expect(await identity.cleanupExpiredAliases()).toEqual({ kept: 0, removed: 1 });
    expect((await storage.get('gemini_tab_alias_100')).gemini_tab_alias_100).toBeUndefined();
  });

  test('TAB-12: reconciler canonicaliza antes de classificar o job como órfão', async () => {
    state.patch({
      jobIndex: [{ geminiTabId: 100, jobId: 'job-r', batchId: 'b', mangaTabId: 9, index: 4 }],
      activeJobsCount: 1,
    });
    await storage.set({
      gemini_job_100: { geminiTabId: 100, jobId: 'job-r', batchId: 'b', mangaTabId: 9, index: 4 },
      gemini_tab_alias_100: {
        oldTabId: 100,
        newTabId: 200,
        createdAt: Date.now(),
        expiresAt: Date.now() + 60_000,
      },
    });
    tabs._tabs.set(200, { id: 200, url: 'https://gemini.google.com/app', active: false, status: 'complete' });

    const identity = createTabIdentity({ state, log });
    const createReconciler = loadReconcilerFactory();
    const reconciler = createReconciler({
      state,
      tabExists: async tabId => tabs._tabs.has(tabId),
      log,
      syncState: () => state.syncState(),
      processNextJob: jest.fn(),
      recoverPendingFinalization: async () => false,
      resolveCanonicalTabId: tabId => identity.resolveCanonicalTabId(tabId),
      migrateTabIdentity: (oldTabId, newTabId, options) => identity.migrateTabIdentity(oldTabId, newTabId, options),
    });

    await expect(reconciler.reconcile()).resolves.toEqual({ alive: 1, dropped: 0, recovered: 0 });
    expect(state.jobIndex).toEqual([expect.objectContaining({ geminiTabId: 200, jobId: 'job-r' })]);
    expect((await storage.get('gemini_job_200')).gemini_job_200)
      .toEqual(expect.objectContaining({ geminiTabId: 200, jobId: 'job-r' }));
  });
  test('TAB-02 lifecycle: alias existente antes da persistência grava somente na chave canônica', async () => {
    tabs._nextTabId = 100;
    const identity = createTabIdentity({ state, log });
    await identity.recordReplacement(200, 100);

    state.patch({
      jobQueue: [{ mangaTabId: 9, index: 2, prompt: 'translate', batchId: 'batch-x' }],
      jobIndex: [],
      stopRequested: false,
      activeJobsCount: 0,
      totalJobs: 1,
      completedJobs: 0,
    });
    state._cachedMaxCon = 1;

    delete global.MangaTranslatorJobsLifecycle;
    jest.isolateModules(() => require(LIFECYCLE_PATH));
    const lifecycle = global.MangaTranslatorJobsLifecycle.createLifecycle({
      state,
      log,
      syncState: () => state.syncState(),
      sendProgress: jest.fn(),
      armWatchdog: jest.fn(async (_mangaTabId, _index, geminiTabId) => geminiTabId),
      clearWatchdog: jest.fn(),
      indexAddJob: entry => state.indexAddJob(entry),
      indexRemoveJob: tabId => state.indexRemoveJob(tabId),
      indexJobsOfBatch: batchId => state.indexJobsOfBatch(batchId),
      delay: async () => {},
      generateId: () => 'job-before-persist',
      markFinalized: jest.fn(),
      isFinalized: () => false,
      finalizedMarkerTtlMinutes: 10,
      resolveCanonicalTabId: tabId => identity.resolveCanonicalTabId(tabId),
      migrateTabIdentity: (oldTabId, newTabId, options) => identity.migrateTabIdentity(oldTabId, newTabId, options),
    });

    await lifecycle.processNextJob();

    const data = await storage.get(['gemini_job_100', 'gemini_job_200']);
    expect(data.gemini_job_100).toBeUndefined();
    expect(data.gemini_job_200).toEqual(expect.objectContaining({
      geminiTabId: 200,
      canonicalTabId: 200,
      jobId: 'job-before-persist',
      index: 2,
    }));
    expect(state.jobIndex).toEqual([
      expect.objectContaining({ geminiTabId: 200, jobId: 'job-before-persist' }),
    ]);
  });

});
