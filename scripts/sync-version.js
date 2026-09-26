'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_ROOT = path.resolve(__dirname, '..');

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2) + '\n', 'utf8');
}

function parseNumericSemver(version) {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(String(version || ''));
  if (!match) {
    throw new Error(`package.json#version deve usar SemVer numérico MAJOR.MINOR.PATCH; recebido: ${version}`);
  }

  const parts = match.slice(1).map(Number);
  if (parts.some((part) => !Number.isSafeInteger(part) || part < 0 || part > 65535)) {
    throw new Error(`Cada componente da versão deve estar entre 0 e 65535; recebido: ${version}`);
  }

  return { major: parts[0], minor: parts[1], patch: parts[2] };
}

function deriveVersionInfo(packageVersion) {
  const { major, minor, patch } = parseNumericSemver(packageVersion);
  const manifestVersion = patch === 0
    ? `${major}.${minor}`
    : `${major}.${minor}.${patch}`;

  return {
    packageVersion,
    manifestVersion,
    displayVersion: manifestVersion,
    releaseTag: `v${packageVersion}`,
    releaseBaseName: `Manga-Translator-v${manifestVersion}`,
    documentationArtifact: `Documentação_V${manifestVersion}.md`,
  };
}

function collectState(root = DEFAULT_ROOT) {
  const paths = {
    rootPackage: path.join(root, 'package.json'),
    manifest: path.join(root, 'extension', 'manifest.json'),
    testsPackage: path.join(root, 'tests', 'package.json'),
    testsLock: path.join(root, 'tests', 'package-lock.json'),
    canonicalDocs: path.join(root, 'docs', 'Documentação.md'),
    publishWorkflow: path.join(root, '.github', 'workflows', 'publish.yml'),
  };

  const rootPackage = readJson(paths.rootPackage);
  const info = deriveVersionInfo(rootPackage.version);
  const manifest = readJson(paths.manifest);
  const testsPackage = readJson(paths.testsPackage);
  const testsLock = readJson(paths.testsLock);

  return { paths, info, manifest, testsPackage, testsLock };
}

function getDifferences(state) {
  const { paths, info, manifest, testsPackage, testsLock } = state;
  const differences = [];

  if (manifest.version !== info.manifestVersion) {
    differences.push(`extension/manifest.json#version: ${manifest.version} -> ${info.manifestVersion}`);
  }
  if (testsPackage.version !== info.packageVersion) {
    differences.push(`tests/package.json#version: ${testsPackage.version} -> ${info.packageVersion}`);
  }
  if (testsLock.version !== info.packageVersion) {
    differences.push(`tests/package-lock.json#version: ${testsLock.version} -> ${info.packageVersion}`);
  }

  const lockRootVersion = testsLock.packages && testsLock.packages[''] && testsLock.packages[''].version;
  if (lockRootVersion !== info.packageVersion) {
    differences.push(`tests/package-lock.json#packages[""].version: ${lockRootVersion} -> ${info.packageVersion}`);
  }
  if (!fs.existsSync(paths.canonicalDocs)) {
    differences.push('docs/Documentação.md ausente');
  }
  if (!fs.existsSync(paths.publishWorkflow)) {
    differences.push('.github/workflows/publish.yml ausente');
  }

  return differences;
}

function syncWorkspace(root = DEFAULT_ROOT) {
  const state = collectState(root);
  const before = getDifferences(state);

  state.manifest.version = state.info.manifestVersion;
  state.testsPackage.version = state.info.packageVersion;
  state.testsLock.version = state.info.packageVersion;

  if (!state.testsLock.packages || !state.testsLock.packages['']) {
    throw new Error('tests/package-lock.json não contém packages[""]');
  }
  state.testsLock.packages[''].version = state.info.packageVersion;

  writeJson(state.paths.manifest, state.manifest);
  writeJson(state.paths.testsPackage, state.testsPackage);
  writeJson(state.paths.testsLock, state.testsLock);

  const after = checkWorkspace(root).differences;
  if (after.length) {
    throw new Error(`Sincronização incompleta: ${after.join('; ')}`);
  }

  return { info: state.info, changed: before };
}

function checkWorkspace(root = DEFAULT_ROOT) {
  const state = collectState(root);
  return { info: state.info, differences: getDifferences(state) };
}

function printEnv(info) {
  const values = {
    PACKAGE_VERSION: info.packageVersion,
    MANIFEST_VERSION: info.manifestVersion,
    DISPLAY_VERSION: info.displayVersion,
    RELEASE_TAG: info.releaseTag,
    RELEASE_BASENAME: info.releaseBaseName,
    DOC_ARTIFACT: info.documentationArtifact,
  };

  for (const [key, value] of Object.entries(values)) {
    process.stdout.write(`${key}=${value}\n`);
  }
}

function main(argv = process.argv.slice(2)) {
  if (argv.includes('--print-env')) {
    const state = collectState(DEFAULT_ROOT);
    printEnv(state.info);
    return;
  }

  if (argv.includes('--check')) {
    const { info, differences } = checkWorkspace(DEFAULT_ROOT);
    if (differences.length) {
      console.error('❌ Metadados de versão fora de sincronia:');
      differences.forEach((difference) => console.error(`- ${difference}`));
      process.exitCode = 1;
      return;
    }

    console.log(`✅ Versionamento consistente: package ${info.packageVersion} / manifest ${info.manifestVersion}`);
    return;
  }

  const { info, changed } = syncWorkspace(DEFAULT_ROOT);
  if (changed.length) {
    console.log('✅ Metadados sincronizados:');
    changed.forEach((difference) => console.log(`- ${difference}`));
  } else {
    console.log('✅ Metadados já estavam sincronizados.');
  }
  console.log(`Package: ${info.packageVersion} | Manifest: ${info.manifestVersion}`);
}

if (require.main === module) {
  main();
}

module.exports = {
  parseNumericSemver,
  deriveVersionInfo,
  collectState,
  getDifferences,
  syncWorkspace,
  checkWorkspace,
};
