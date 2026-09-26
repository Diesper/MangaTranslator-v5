'use strict';

const {
  parseNumericSemver,
  deriveVersionInfo,
} = require('../../../scripts/sync-version');

describe('versionamento centralizado', () => {
  test('6.5.0 gera Manifest 6.5 e release v6.5.0', () => {
    expect(deriveVersionInfo('6.5.0')).toEqual({
      packageVersion: '6.5.0',
      manifestVersion: '6.5',
      displayVersion: '6.5',
      releaseTag: 'v6.5.0',
      releaseBaseName: 'Manga-Translator-v6.5',
      documentationArtifact: 'Documentação_V6.5.md',
    });
  });

  test('patch diferente de zero é preservado no Manifest e nos artefatos', () => {
    expect(deriveVersionInfo('6.5.1').manifestVersion).toBe('6.5.1');
    expect(deriveVersionInfo('6.5.1').releaseBaseName).toBe('Manga-Translator-v6.5.1');
  });

  test('major/minor com patch zero mantém dois componentes visíveis', () => {
    expect(deriveVersionInfo('7.0.0').manifestVersion).toBe('7.0');
  });

  test.each(['6.5', 'v6.5.0', '6.5.0-beta.1', '06.5.0', '65536.0.0'])(
    'rejeita versão não suportada: %s',
    (version) => {
      expect(() => parseNumericSemver(version)).toThrow();
    }
  );

  test('workflow de release usa caminhos canônicos e nomes derivados', () => {
    const fs = require('fs');
    const path = require('path');
    const workflow = fs.readFileSync(
      path.resolve(__dirname, '../../../.github/workflows/publish.yml'),
      'utf8'
    );

    expect(workflow).toContain('docs/Documentação.md');
    expect(workflow).toContain('scripts/sync-version.js --print-env');
    expect(workflow).toContain('${RELEASE_BASENAME}');
    expect(workflow).toContain('${DOC_ARTIFACT}');
    expect(workflow).not.toMatch(/Manga-Translator-v\d/);
    expect(workflow).not.toMatch(/Documentação_V\d/);
  });
});
