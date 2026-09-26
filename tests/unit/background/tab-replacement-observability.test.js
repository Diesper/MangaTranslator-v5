'use strict';

require('../../mocks/chrome-api.mock.js');
const { getTabsMock } = require('../../mocks/chrome-api.mock.js');

describe('ChromeTabsMock tab replacement observability', () => {
  test('PR0-TAB: _simulateReplacement transfere a aba e dispara onReplaced(new, old)', async () => {
    const tabs = getTabsMock();
    const original = await tabs.create({
      url: 'https://gemini.google.com/app?mangatranslator=true',
      active: false,
    });
    const listener = jest.fn();
    const handler = jest.fn();

    tabs.onReplaced.addListener(listener);
    tabs._registerMessageHandler(original.id, handler);

    const replacementId = original.id + 100;
    const replaced = tabs._simulateReplacement(original.id, replacementId);

    expect(replaced.id).toBe(replacementId);
    await expect(tabs.get(original.id)).resolves.toBeNull();
    await expect(tabs.get(replacementId)).resolves.toMatchObject({
      id: replacementId,
      url: original.url,
      active: false,
    });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(replacementId, original.id);

    const callback = jest.fn();
    tabs.sendMessage(replacementId, { action: 'PING' }, callback);
    expect(handler).toHaveBeenCalledTimes(1);
  });
});
