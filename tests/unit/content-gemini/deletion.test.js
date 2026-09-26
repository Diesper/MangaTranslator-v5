'use strict';

const path = require('path');
const { getStorageMock } = require('../../mocks/chrome-api.mock.js');

const DELETION_PATH = path.resolve(
  __dirname,
  '../../../extension/gemini/deletion.js'
);

function loadModule() {
  let api;
  jest.isolateModules(() => {
    api = require(DELETION_PATH);
  });
  return api;
}

function visibleRect(element, width = 180, height = 36) {
  element.getBoundingClientRect = () => ({
    x: 0,
    y: 0,
    top: 0,
    left: 0,
    right: width,
    bottom: height,
    width,
    height,
    toJSON() { return this; },
  });
  return element;
}

function createPageWindow(pathname = '/app/chat-1') {
  return {
    location: {
      pathname,
      reload: jest.fn(),
    },
    addEventListener: jest.fn(),
    removeEventListener: jest.fn(),
  };
}

function mountSuccessfulDeletionDom() {
  const sidebar = document.createElement('div');
  const row = document.createElement('div');

  const link = visibleRect(document.createElement('a'));
  link.href = '/app/chat-1';
  link.scrollIntoView = jest.fn();

  const options = document.createElement('button');
  options.setAttribute('aria-haspopup', 'menu');

  const confirm = visibleRect(document.createElement('button'));
  confirm.textContent = 'Excluir';
  confirm.click = jest.fn();

  const deleteItem = visibleRect(document.createElement('div'));
  deleteItem.setAttribute('role', 'menuitem');
  deleteItem.textContent = 'Excluir';
  deleteItem.click = jest.fn(() => {
    if (document.querySelector('[role="dialog"]')) return;
    const dialog = document.createElement('div');
    dialog.setAttribute('role', 'dialog');
    dialog.appendChild(confirm);
    document.body.appendChild(dialog);
  });

  options.click = jest.fn(() => {
    if (document.querySelector('[role="menu"]')) return;
    const menu = document.createElement('div');
    menu.setAttribute('role', 'menu');
    menu.appendChild(deleteItem);
    document.body.appendChild(menu);
  });

  row.append(link, options);
  sidebar.appendChild(row);
  document.body.appendChild(sidebar);

  return { link, options, deleteItem, confirm, row };
}

describe('gemini/deletion.js', () => {
  let storage;

  beforeEach(async () => {
    document.documentElement.innerHTML = '<head></head><body></body>';
    storage = getStorageMock();
    await storage.clear();
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await storage.clear();
    document.documentElement.innerHTML = '<head></head><body></body>';
  });

  test('DEL-01: escape mantém seletor seguro sem CSS.escape', () => {
    const { createDeletionController } = loadModule();
    const controller = createDeletionController({
      root: document,
      pageWindow: createPageWindow(),
      storage,
      sleep: async () => {},
    });

    expect(controller.escapeCssAttributeValue('chat-1')).toBe('chat-1');
    expect(controller.escapeCssAttributeValue('chat"1\\x')).toBe('chat\\"1\\\\x');
  });

  test('DEL-02: waitForElementToSettle falha se o alvo desconecta', async () => {
    const { createDeletionController } = loadModule();
    const element = visibleRect(document.createElement('div'));
    document.body.appendChild(element);

    let calls = 0;
    const controller = createDeletionController({
      root: document,
      pageWindow: createPageWindow(),
      storage,
      sleep: async () => {
        calls += 1;
        if (calls === 1) element.remove();
      },
    });

    await expect(
      controller.waitForElementToSettle(element, 3, 1)
    ).resolves.toBe(false);
  });

  test('DEL-03: modo debug preserva a conversa e limpa o lock idempotente', async () => {
    const { createDeletionController } = loadModule();
    await storage.set({ debugMode: true });
    const logs = [];

    const controller = createDeletionController({
      root: document,
      pageWindow: createPageWindow(),
      storage,
      sleep: async () => {},
      sendLog: (...args) => logs.push(args),
    });

    await expect(controller.deleteCurrentConversation()).resolves.toBe(true);
    expect(controller.isDeletionInProgress()).toBe(false);
    expect(logs.some(([, action]) => action === 'DEBUG_MODE_SKIP')).toBe(true);
  });

  test('DEL-04: exclusão completa usa a linha do chat atual, menu e confirmação', async () => {
    const { createDeletionController } = loadModule();
    const dom = mountSuccessfulDeletionDom();
    const logs = [];

    const controller = createDeletionController({
      root: document,
      pageWindow: createPageWindow('/app/chat-1'),
      storage,
      sleep: async () => {},
      sendLog: (...args) => logs.push(args),
    });

    await expect(controller.deleteCurrentConversation()).resolves.toBe(true);

    expect(dom.link.scrollIntoView).toHaveBeenCalledTimes(1);
    expect(dom.options.click).toHaveBeenCalledTimes(1);
    expect(dom.deleteItem.click).toHaveBeenCalledTimes(1);
    expect(dom.confirm.click).toHaveBeenCalledTimes(1);
    expect(controller.isDeletionInProgress()).toBe(false);
    expect(logs.some(([, action]) => action === 'DELETE_OK')).toBe(true);
  });

  test('DEL-05: segunda exclusão concorrente é recusada enquanto a primeira está ativa', async () => {
    const { createDeletionController } = loadModule();

    let releaseFirstSleep;
    let firstSleep = true;
    const blockingSleep = () => {
      if (!firstSleep) return Promise.resolve();
      firstSleep = false;
      return new Promise(resolve => { releaseFirstSleep = resolve; });
    };

    const immediateStorage = {
      get(_keys, callback) { callback({ debugMode: false }); },
      set(_items, callback) { callback?.(); },
      remove(_keys, callback) { callback?.(); },
    };

    const controller = createDeletionController({
      root: document,
      pageWindow: createPageWindow('/app/chat-1'),
      storage: immediateStorage,
      sleep: blockingSleep,
    });

    const first = controller.deleteCurrentConversation();
    await Promise.resolve();

    await expect(controller.deleteCurrentConversation()).resolves.toBe(false);
    expect(controller.isDeletionInProgress()).toBe(true);

    releaseFirstSleep();
    await expect(first).resolves.toBe(false);
    expect(controller.isDeletionInProgress()).toBe(false);
  });

  test('DEL-06: save/read/clear recovery preserva entrega e chatId', async () => {
    const { createDeletionController } = loadModule();
    const pageWindow = createPageWindow('/app/chat-abc');
    const controller = createDeletionController({
      root: document,
      pageWindow,
      storage,
      sleep: async () => {},
      now: () => 123456,
    });

    const delivery = { action: 'GEMINI_IMAGE_EXTRACTED', jobId: 'job-1' };
    const saved = await controller.saveRecovery(77, delivery);

    expect(saved).toEqual({
      chatId: 'chat-abc',
      delivery,
      createdAt: 123456,
    });
    await expect(controller.readRecovery(77)).resolves.toEqual(saved);

    await controller.clearRecovery(77);
    await expect(controller.readRecovery(77)).resolves.toBeNull();
  });

  test('DEL-07: recovery executa exclusão, limpa marker e entrega uma única vez', async () => {
    const { createDeletionController } = loadModule();
    const pageWindow = createPageWindow('/app/chat-1');
    await storage.set({
      debugMode: true,
      gemini_delete_recovery_88: {
        chatId: 'chat-1',
        delivery: { action: 'GEMINI_ERROR', jobId: 'job-r' },
        createdAt: 1,
      },
    });

    const sendDelivery = jest.fn(async () => {});
    const controller = createDeletionController({
      root: document,
      pageWindow,
      storage,
      sleep: async () => {},
    });

    const result = await controller.recoverPending({
      tabId: 88,
      sendDelivery,
    });

    expect(result.handled).toBe(true);
    expect(result.deleted).toBe(true);
    expect(sendDelivery).toHaveBeenCalledTimes(1);
    await expect(controller.readRecovery(88)).resolves.toBeNull();
  });

  test('DEL-08: falha de exclusão persiste recovery antes de recarregar', async () => {
    const { createDeletionController } = loadModule();
    const pageWindow = createPageWindow('/app/chat-1');
    const controller = createDeletionController({
      root: document,
      pageWindow,
      storage,
      sleep: async () => {},
      now: () => 42,
    });

    const delivery = { action: 'GEMINI_RESULT_URL', jobId: 'job-fallback' };
    const result = await controller.deleteOrScheduleRecovery({
      tabId: 99,
      delivery,
    });

    expect(result).toEqual({
      deleted: false,
      recoverySaved: true,
      reloadScheduled: true,
    });
    await expect(controller.readRecovery(99)).resolves.toEqual({
      chatId: 'chat-1',
      delivery,
      createdAt: 42,
    });
    expect(pageWindow.location.reload).toHaveBeenCalledTimes(1);
  });

  test('DEL-09: recovery inexistente não apaga nem entrega nada', async () => {
    const { createDeletionController } = loadModule();
    const sendDelivery = jest.fn();
    const controller = createDeletionController({
      root: document,
      pageWindow: createPageWindow(),
      storage,
      sleep: async () => {},
    });

    await expect(controller.recoverPending({
      tabId: 100,
      sendDelivery,
    })).resolves.toEqual({
      handled: false,
      deleted: false,
      recovery: null,
    });
    expect(sendDelivery).not.toHaveBeenCalled();
  });
});
