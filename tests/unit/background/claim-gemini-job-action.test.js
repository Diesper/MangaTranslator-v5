'use strict';

const path = require('path');
const { getStorageMock } = require('../../mocks/chrome-api.mock.js');

const ROUTER_PATH = path.resolve(__dirname, '../../../extension/background/router.js');
const CLAIM_PATH = path.resolve(__dirname, '../../../extension/background/actions/claim-gemini-job.js');
const STATE_PATH = path.resolve(__dirname, '../../../extension/background/state.js');
const TAB_IDENTITY_PATH = path.resolve(__dirname, '../../../extension/background/tab-identity.js');

function loadModules() {
  delete global.MangaTranslatorRouter;
  delete global.MangaTranslatorState;
  jest.isolateModules(() => {
    require(ROUTER_PATH);
    require(STATE_PATH);
    require(CLAIM_PATH);
  });
  let tabIdentityApi;
  jest.isolateModules(() => {
    tabIdentityApi = require(TAB_IDENTITY_PATH);
  });
  return {
    router: global.MangaTranslatorRouter,
    state: global.MangaTranslatorState,
    createTabIdentity: tabIdentityApi.createTabIdentity,
  };
}

function dispatch(listener, request, sender) {
  return new Promise(resolve => {
    let keepAlive;
    let delivered = false;
    let deliveredResponse;

    const sendResponse = response => {
      delivered = true;
      deliveredResponse = response;
      if (keepAlive !== undefined) resolve({ keepAlive, response });
    };

    keepAlive = listener(request, sender, sendResponse);
    if (delivered || keepAlive === false) {
      resolve({ keepAlive, response: delivered ? deliveredResponse : undefined });
    }
  });
}

describe('CLAIM_GEMINI_JOB', () => {
  let storage;
  let router;
  let state;
  let identity;
  let log;

  beforeEach(async () => {
    storage = getStorageMock();
    await storage.clear();
    ({ router, state, createTabIdentity: identity } = loadModules());
    state.patch({ jobIndex: [], extractionTabs: {}, activeJobsCount: 0 });
    log = jest.fn();
    identity = identity({ state, log });
  });

  function listener() {
    return router.createMessageRouter({
      contextFactory: () => ({
        state,
        log,
        tabIdentity: identity,
      }),
    });
  }

  test('claim direto retorna somente o contrato necessário', async () => {
    state.patch({
      jobIndex: [{ geminiTabId: 200, jobId: 'job-ok', batchId: 'b', mangaTabId: 7, index: 3 }],
    });
    await storage.set({
      gemini_job_200: {
        geminiTabId: 200,
        jobId: 'job-ok',
        batchId: 'b',
        mangaTabId: 7,
        index: 3,
        prompt: 'translate',
        executionMode: 'temp_chat',
        windowId: 8,
        signedUrl: 'https://secret.invalid/token',
        internalOnly: 'must-not-leak',
      },
    });

    const result = await dispatch(
      listener(),
      { action: 'CLAIM_GEMINI_JOB', jobId: 'job-ok' },
      { tab: { id: 200, url: 'https://gemini.google.com/app?jobId=job-ok' } }
    );

    expect(result.keepAlive).toBe(true);
    expect(result.response).toEqual({
      ok: true,
      job: {
        jobId: 'job-ok',
        batchId: 'b',
        mangaTabId: 7,
        index: 3,
        prompt: 'translate',
        executionMode: 'temp_chat',
        geminiTabId: 200,
        windowId: 8,
      },
    });
    expect(result.response.job).not.toHaveProperty('signedUrl');
    expect(result.response.job).not.toHaveProperty('internalOnly');
  });

  test('TAB-10: jobId divergente rejeita claim mesmo na aba correta', async () => {
    await storage.set({
      gemini_job_200: { geminiTabId: 200, jobId: 'job-real', mangaTabId: 7, index: 1 },
    });

    const result = await dispatch(
      listener(),
      { action: 'CLAIM_GEMINI_JOB', jobId: 'job-wrong' },
      { tab: { id: 200, url: 'https://gemini.google.com/app' } }
    );

    expect(result.response).toEqual({ ok: true, job: null });
  });

  test('TAB-11: aba Gemini manual sem job recebe claim nulo', async () => {
    const result = await dispatch(
      listener(),
      { action: 'CLAIM_GEMINI_JOB' },
      { tab: { id: 777, url: 'https://gemini.google.com/app' } }
    );

    expect(result.response).toEqual({ ok: true, job: null });
  });

  test('origem não-Gemini não pode executar o claim', async () => {
    await storage.set({
      gemini_job_200: { geminiTabId: 200, jobId: 'job-ok', mangaTabId: 7, index: 1 },
    });

    const result = await dispatch(
      listener(),
      { action: 'CLAIM_GEMINI_JOB', jobId: 'job-ok' },
      { tab: { id: 200, url: 'https://reader.example/chapter' } }
    );

    expect(result.keepAlive).toBe(false);
    expect(result.response).toEqual({
      ok: false,
      error: { code: 'SOURCE_DENIED' },
    });
  });

  test('TAB-06: sender na aba substituta recupera job antigo pelo alias e migra ownership', async () => {
    state.patch({
      jobIndex: [{ geminiTabId: 100, jobId: 'job-alias', batchId: 'b', mangaTabId: 7, index: 4 }],
    });
    await storage.set({
      gemini_job_100: {
        geminiTabId: 100,
        jobId: 'job-alias',
        batchId: 'b',
        mangaTabId: 7,
        index: 4,
        prompt: 'translate',
        executionMode: 'temp_chat',
      },
      gemini_tab_alias_100: {
        oldTabId: 100,
        newTabId: 200,
        createdAt: Date.now(),
        expiresAt: Date.now() + 60_000,
      },
    });

    const result = await dispatch(
      listener(),
      { action: 'CLAIM_GEMINI_JOB', jobId: 'job-alias' },
      { tab: { id: 200, url: 'https://gemini.google.com/app?jobId=job-alias' } }
    );

    expect(result.response).toEqual({
      ok: true,
      job: expect.objectContaining({
        jobId: 'job-alias',
        geminiTabId: 200,
        index: 4,
      }),
    });
    expect(state.jobIndex).toEqual([expect.objectContaining({ geminiTabId: 200 })]);
    expect((await storage.get('gemini_job_100')).gemini_job_100).toBeUndefined();
    expect((await storage.get('gemini_job_200')).gemini_job_200)
      .toEqual(expect.objectContaining({ geminiTabId: 200, jobId: 'job-alias' }));
  });
});
