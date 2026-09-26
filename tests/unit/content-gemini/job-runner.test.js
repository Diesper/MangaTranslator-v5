'use strict';

const path = require('path');

const RUNNER_PATH = path.resolve(
  __dirname,
  '../../../extension/gemini/job-runner.js'
);

function loadModule() {
  let api;
  jest.isolateModules(() => {
    api = require(RUNNER_PATH);
  });
  return api;
}

function baseDependencies(overrides = {}) {
  const runtimeMessages = [];
  const runtime = {
    lastError: null,
    sendMessage: jest.fn((message, callback) => {
      runtimeMessages.push(message);
      if (callback) callback(null);
    }),
  };

  const storage = {
    get: jest.fn((keys, callback) => callback({})),
  };

  const domApi = {
    getImageSource: image => image?.src || '',
    isIgnoredGeminiImageSource: () => false,
    isModelResponseImage: () => false,
    findAllDeep: () => [],
    getEditableElement: element => element,
    findSendButton: () => null,
  };

  const deletionController = {
    recoverPending: jest.fn(async () => ({
      handled: false,
      deleted: false,
      recovery: null,
    })),
    deleteCurrentConversation: jest.fn(async () => true),
    deleteOrScheduleRecovery: jest.fn(async () => ({
      deleted: true,
      recoverySaved: false,
      reloadScheduled: false,
    })),
  };

  return {
    runtimeMessages,
    options: {
      root: document,
      pageWindow: window,
      runtime,
      storage,
      domApi,
      observerApi: { createGeminiObserver: jest.fn() },
      editorApi: {
        submitWithConfirmation: jest.fn(),
      },
      attachmentApi: {
        attachFile: jest.fn(),
      },
      temporaryChatApi: {
        ensureActive: jest.fn(),
      },
      resultExtractor: {
        extractOrAuxiliaryFallback: jest.fn(),
      },
      deletionController,
      sleep: async () => {},
      sendLog: jest.fn(),
      getUrlLogMetadata: () => ({}),
      debugConsole: jest.fn(),
      reportProgress: jest.fn(),
      openKeepAlive: jest.fn(),
      closeKeepAlive: jest.fn(),
      ...overrides,
    },
  };
}

describe('gemini/job-runner.js', () => {
  beforeEach(() => {
    document.documentElement.innerHTML = '<head></head><body></body>';
    delete window.__mangaTranslatorActiveGeminiObserver;
    delete window.__mangaTranslatorManualGeminiResultUrl;
    delete window.__mangaTranslatorManualPickHandler;
  });

  afterEach(() => {
    jest.restoreAllMocks();
    document.documentElement.innerHTML = '<head></head><body></body>';
  });

  test('RUN-01: dataURLtoFile valida e converte PNG', () => {
    const { createGeminiJobRunner } = loadModule();
    const { options } = baseDependencies();
    const runner = createGeminiJobRunner(options);

    const file = runner.dataURLtoFile(
      'data:image/png;base64,QUJDRA==',
      'page.png'
    );

    expect(file).toBeInstanceOf(File);
    expect(file.type).toBe('image/png');
    expect(file.name).toBe('page.png');
    expect(file.size).toBe(4);
  });

  test('RUN-02: recovery pendente encerra antes de abrir keepalive', async () => {
    const { createGeminiJobRunner } = loadModule();
    const { options } = baseDependencies();
    options.deletionController.recoverPending.mockResolvedValue({
      handled: true,
      deleted: true,
      recovery: { delivery: { action: 'GEMINI_ERROR' } },
    });

    const runner = createGeminiJobRunner(options);
    const result = await runner.run({
      jobId: 'job-recovery',
      geminiTabId: 88,
      mangaTabId: 77,
      index: 1,
    });

    expect(result).toEqual({
      status: 'recovery_handled',
      deleted: true,
    });
    expect(options.openKeepAlive).not.toHaveBeenCalled();
    expect(options.closeKeepAlive).not.toHaveBeenCalled();
  });

  test('RUN-03: erro inicial fecha keepalive no finally e reporta GEMINI_ERROR', async () => {
    const { createGeminiJobRunner } = loadModule();
    const { options, runtimeMessages } = baseDependencies();

    const runner = createGeminiJobRunner(options);
    const result = await runner.run({
      jobId: 'job-no-image',
      batchId: 'batch-1',
      geminiTabId: 321,
      mangaTabId: 77,
      index: 5,
    });

    expect(options.openKeepAlive).toHaveBeenCalledTimes(1);
    expect(options.closeKeepAlive).toHaveBeenCalledTimes(1);
    expect(result.status).toBe('error');
    expect(runtimeMessages).toContainEqual(expect.objectContaining({
      action: 'GEMINI_ERROR',
      mangaTabId: 77,
      index: 5,
      jobId: 'job-no-image',
      batchId: 'batch-1',
    }));
  });

  test('RUN-04: waitForElement resolve imediatamente quando o editor já existe', async () => {
    const { createGeminiJobRunner } = loadModule();
    const { options } = baseDependencies();
    const runner = createGeminiJobRunner(options);

    const editor = document.createElement('div');
    editor.className = 'ql-editor';
    document.body.appendChild(editor);

    await expect(
      runner.waitForElement('.ql-editor', 100)
    ).resolves.toBe(editor);
  });

  test('RUN-05: seleção manual é entregue ao observer ativo existente', () => {
    const { createGeminiJobRunner } = loadModule();
    const { options } = baseDependencies();
    const observer = {
      acceptResult: jest.fn(),
    };
    window.__mangaTranslatorActiveGeminiObserver = observer;

    const runner = createGeminiJobRunner(options);
    runner.setManualGeminiResultUrl(
      'https://cdn.example/result.png',
      'test'
    );

    expect(observer.acceptResult).toHaveBeenCalledWith(
      null,
      'https://cdn.example/result.png'
    );
    expect(window.__mangaTranslatorManualGeminiResultUrl).toBe(
      'https://cdn.example/result.png'
    );
  });

  test('RUN-06: modos de execução escolhem anti-throttling progressivo', () => {
    const { createGeminiJobRunner } = loadModule();
    const { options } = baseDependencies();
    const runner = createGeminiJobRunner(options);

    expect(runner.getAntiThrottleModeForExecutionMode('temp_chat')).toBe('minimal');
    expect(runner.getAntiThrottleModeForExecutionMode('background_delete')).toBe('balanced');
    expect(runner.getAntiThrottleModeForExecutionMode('minimized_window')).toBe('balanced');
    expect(runner.getAntiThrottleModeForExecutionMode('unknown')).toBe('minimal');
  });

  test('RUN-07: setAntiThrottleMode publica evento MAIN-world e normaliza inválidos', () => {
    const { createGeminiJobRunner } = loadModule();
    const { options } = baseDependencies();
    const received = [];
    const listener = event => received.push(event.detail && event.detail.mode);

    window.addEventListener('MANGA_TRANSLATOR_ANTI_THROTTLE_SET_MODE', listener);
    try {
      const runner = createGeminiJobRunner(options);

      expect(runner.setAntiThrottleMode('balanced')).toBe('balanced');
      expect(runner.setAntiThrottleMode('legacy')).toBe('legacy');
      expect(runner.setAntiThrottleMode('qualquer-coisa')).toBe('minimal');

      expect(received).toEqual(['balanced', 'legacy', 'minimal']);
    } finally {
      window.removeEventListener('MANGA_TRANSLATOR_ANTI_THROTTLE_SET_MODE', listener);
    }
  });

});
