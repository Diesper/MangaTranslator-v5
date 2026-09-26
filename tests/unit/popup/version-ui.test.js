'use strict';

const fs = require('fs');
const path = require('path');

describe('versionamento da UI', () => {
  const extensionDir = path.resolve(__dirname, '../../../extension');
  const optionsHtml = fs.readFileSync(path.join(extensionDir, 'options.html'), 'utf8');
  const optionsJs = fs.readFileSync(path.join(extensionDir, 'options.js'), 'utf8');

  test('options.html não contém versão de produto hardcoded', () => {
    expect(optionsHtml).toContain('id="app-title"');
    expect(optionsHtml).not.toMatch(/Manga Translator v\d/);
  });

  test('options.js lê a versão do Manifest em runtime', () => {
    expect(optionsJs).toContain('chrome.runtime.getManifest');
    expect(optionsJs).toContain('Manga Translator v${runtimeVersion}');
    expect(optionsJs).not.toMatch(/Manga Translator v\d+(?:\.\d+)*/);
  });
});
