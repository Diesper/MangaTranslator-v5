'use strict';

const path = require('path');

const RESULT_EXTRACTOR_PATH = path.resolve(
  __dirname,
  '../../../extension/gemini/result-extractor.js'
);

function loadModule() {
  let api;
  jest.isolateModules(() => {
    api = require(RESULT_EXTRACTOR_PATH);
  });
  return api;
}

class TestCustomEvent {
  constructor(type, init = {}) {
    this.type = type;
    this.detail = init.detail || null;
  }
}

function createImage() {
  return {
    complete: true,
    naturalWidth: 1200,
    naturalHeight: 1800,
  };
}

function createCanvasDocument(events, { fail = false } = {}) {
  return {
    createElement(tag) {
      expect(tag).toBe('canvas');
      return {
        width: 0,
        height: 0,
        getContext(type) {
          expect(type).toBe('2d');
          return {
            drawImage() {
              events.push('canvas');
              if (fail) {
                const error = new Error('SecurityError: canvas tainted by cross-origin image');
                error.name = 'SecurityError';
                throw error;
              }
            },
          };
        },
        toDataURL(type) {
          expect(type).toBe('image/png');
          return 'data:image/png;base64,CANVAS';
        },
      };
    },
  };
}

function createPageWindow(events, outcome) {
  const listeners = new Map();

  return {
    addEventListener(type, listener) {
      listeners.set(type, listener);
    },
    removeEventListener(type, listener) {
      if (listeners.get(type) === listener) listeners.delete(type);
    },
    dispatchEvent(event) {
      if (event.type !== 'MANGA_TRANSLATOR_FETCH_IMAGE') return true;

      events.push('page');
      const listener = listeners.get('MANGA_TRANSLATOR_FETCH_IMAGE_RESULT');
      if (!listener) return true;

      const detail = typeof outcome === 'function'
        ? outcome(event.detail)
        : outcome;

      listener({
        detail: {
          requestId: event.detail.requestId,
          ...(detail || {}),
        },
      });
      return true;
    },
  };
}

function createRuntime(events, responder) {
  return {
    lastError: null,
    sendMessage: jest.fn((message, callback) => {
      events.push(message.geminiSession ? 'sw-session' : 'sw-background');
      const response = responder ? responder(message) : { dataUrl: 'data:image/png;base64,SW' };
      callback(response);
    }),
  };
}

describe('gemini/result-extractor.js', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('EXT-01: data URL retorna direto sem tocar canvas, MAIN ou SW', async () => {
    const { createResultExtractor } = loadModule();
    const events = [];
    const runtime = createRuntime(events);

    const extractor = createResultExtractor({
      runtime,
      pageDocument: createCanvasDocument(events),
      pageWindow: createPageWindow(events, { dataUrl: 'data:image/png;base64,PAGE' }),
      CustomEventImpl: TestCustomEvent,
      fetchImpl: jest.fn(),
    });

    const dataUrl = 'data:image/png;base64,DIRECT';
    await expect(
      extractor.extractResultImage(null, dataUrl, 'background_delete')
    ).resolves.toBe(dataUrl);

    expect(events).toEqual([]);
    expect(runtime.sendMessage).not.toHaveBeenCalled();
  });

  test('EXT-02: background_delete usa canvas como primeira rota', async () => {
    const { createResultExtractor } = loadModule();
    const events = [];
    const runtime = createRuntime(events);

    const extractor = createResultExtractor({
      runtime,
      pageDocument: createCanvasDocument(events),
      pageWindow: createPageWindow(events, { dataUrl: 'data:image/png;base64,PAGE' }),
      CustomEventImpl: TestCustomEvent,
    });

    await expect(
      extractor.extractResultImage(
        createImage(),
        'https://example.test/result.png',
        'background_delete'
      )
    ).resolves.toBe('data:image/png;base64,CANVAS');

    expect(events).toEqual(['canvas']);
    expect(runtime.sendMessage).not.toHaveBeenCalled();
  });

  test('EXT-03: falha de canvas escala para MAIN-world fetch antes do SW', async () => {
    const { createResultExtractor } = loadModule();
    const events = [];
    const runtime = createRuntime(events);

    const extractor = createResultExtractor({
      runtime,
      pageDocument: createCanvasDocument(events, { fail: true }),
      pageWindow: createPageWindow(events, {
        dataUrl: 'data:image/png;base64,PAGE',
      }),
      CustomEventImpl: TestCustomEvent,
    });

    await expect(
      extractor.extractResultImage(
        createImage(),
        'https://example.test/result.png',
        'background_delete'
      )
    ).resolves.toBe('data:image/png;base64,PAGE');

    expect(events).toEqual(['canvas', 'page']);
    expect(runtime.sendMessage).not.toHaveBeenCalled();
  });

  test('EXT-04: canvas + MAIN falhos escalam para SW com geminiSession', async () => {
    const { createResultExtractor } = loadModule();
    const events = [];
    const runtime = createRuntime(events, message => {
      expect(message).toEqual(expect.objectContaining({
        action: 'FETCH_IMAGE_AS_BASE64',
        geminiSession: true,
      }));
      return { dataUrl: 'data:image/png;base64,SESSION' };
    });

    const extractor = createResultExtractor({
      runtime,
      pageDocument: createCanvasDocument(events, { fail: true }),
      pageWindow: createPageWindow(events, { error: 'MAIN fetch falhou' }),
      CustomEventImpl: TestCustomEvent,
    });

    await expect(
      extractor.extractResultImage(
        createImage(),
        'https://googleusercontent.com/result.png',
        'background_delete'
      )
    ).resolves.toBe('data:image/png;base64,SESSION');

    expect(events).toEqual(['canvas', 'page', 'sw-session']);
  });

  test('EXT-05: modos não background_delete preservam SW fetch legado direto', async () => {
    const { createResultExtractor } = loadModule();
    const events = [];
    const runtime = createRuntime(events, message => {
      expect(message.geminiSession).toBeUndefined();
      return { dataUrl: 'data:image/png;base64,BACKGROUND' };
    });

    const extractor = createResultExtractor({
      runtime,
      pageDocument: {
        createElement() {
          throw new Error('canvas não deveria ser usado');
        },
      },
      pageWindow: createPageWindow(events, { error: 'não deveria ser usado' }),
      CustomEventImpl: TestCustomEvent,
    });

    await expect(
      extractor.extractResultImage(
        createImage(),
        'https://example.test/result.png',
        'temp_chat'
      )
    ).resolves.toBe('data:image/png;base64,BACKGROUND');

    expect(events).toEqual(['sw-background']);
  });

  test('EXT-06: blob usa fetch local + FileReader sem chamar SW', async () => {
    const { createResultExtractor } = loadModule();
    const events = [];
    const runtime = createRuntime(events);
    const fetchImpl = jest.fn(async () => ({
      blob: async () => ({ kind: 'blob-fixture' }),
    }));

    class FakeFileReader {
      readAsDataURL(blob) {
        expect(blob).toEqual({ kind: 'blob-fixture' });
        this.result = 'data:image/png;base64,BLOB';
        this.onloadend();
      }
    }

    const extractor = createResultExtractor({
      runtime,
      fetchImpl,
      FileReaderImpl: FakeFileReader,
    });

    await expect(
      extractor.extractResultImage(null, 'blob:https://gemini.test/abc', 'background_delete')
    ).resolves.toBe('data:image/png;base64,BLOB');

    expect(fetchImpl).toHaveBeenCalledWith('blob:https://gemini.test/abc');
    expect(events).toEqual([]);
  });

  test('EXT-07: retry repete a cadeia completa e só depois usa auxiliary fallback', async () => {
    const { createResultExtractor } = loadModule();
    const events = [];
    const logs = [];
    const runtime = createRuntime(events, () => ({ error: 'SW indisponível' }));

    const extractor = createResultExtractor({
      runtime,
      pageDocument: createCanvasDocument(events, { fail: true }),
      pageWindow: createPageWindow(events, { error: 'MAIN indisponível' }),
      CustomEventImpl: TestCustomEvent,
      sleep: async () => { events.push('sleep'); },
      sendLog: (level, action, detail, extra) => {
        logs.push({ level, action, detail, extra });
      },
      getUrlLogMetadata: () => ({
        urlKind: 'https',
        host: 'example.test',
        hasQuery: false,
      }),
    });

    const auxiliary = jest.fn(async ({ url, error }) => {
      events.push('auxiliary');
      expect(url).toBe('https://example.test/result.png');
      expect(error).toBeInstanceOf(Error);
      return { delivered: true };
    });

    const result = await extractor.extractOrAuxiliaryFallback({
      resultImageElement: createImage(),
      resultUrl: 'https://example.test/result.png',
      executionMode: 'background_delete',
      maxAttempts: 2,
      retryDelayMs: 0,
      onAuxiliaryFallback: auxiliary,
    });

    expect(result.kind).toBe('auxiliary');
    expect(result.dataUrl).toBeNull();
    expect(result.fallbackResult).toEqual({ delivered: true });
    expect(events).toEqual([
      'canvas', 'page', 'sw-session',
      'sleep',
      'canvas', 'page', 'sw-session',
      'auxiliary',
    ]);

    expect(auxiliary).toHaveBeenCalledTimes(1);
    expect(logs.map(entry => entry.action)).toEqual(expect.arrayContaining([
      'GEMINI_EXTRACT_RETRY_ALL',
      'GEMINI_EXTRACT_DIAGNOSTIC',
      'GEMINI_AUXILIARY_FALLBACK',
    ]));
    expect(
      logs.findIndex(entry => entry.action === 'GEMINI_AUXILIARY_FALLBACK')
    ).toBeGreaterThan(
      logs.findIndex(entry => entry.action === 'GEMINI_EXTRACT_RETRY_ALL')
    );
  });

  test('EXT-08: sucesso direto não executa auxiliary fallback', async () => {
    const { createResultExtractor } = loadModule();
    const events = [];
    const auxiliary = jest.fn();

    const extractor = createResultExtractor({
      pageDocument: createCanvasDocument(events),
      runtime: createRuntime(events),
    });

    const result = await extractor.extractOrAuxiliaryFallback({
      resultImageElement: createImage(),
      resultUrl: 'https://example.test/result.png',
      executionMode: 'background_delete',
      onAuxiliaryFallback: auxiliary,
    });

    expect(result).toEqual({
      kind: 'extracted',
      dataUrl: 'data:image/png;base64,CANVAS',
      error: null,
    });
    expect(auxiliary).not.toHaveBeenCalled();
  });

  test('EXT-09: sem callback auxiliar, erro terminal continua sendo propagado', async () => {
    const { createResultExtractor } = loadModule();
    const events = [];

    const extractor = createResultExtractor({
      runtime: createRuntime(events, () => ({ error: 'SW falhou' })),
      sleep: async () => {},
    });

    await expect(
      extractor.extractOrAuxiliaryFallback({
        resultUrl: 'https://example.test/result.png',
        executionMode: 'temp_chat',
        maxAttempts: 1,
      })
    ).rejects.toThrow('SW falhou');
  });
});
