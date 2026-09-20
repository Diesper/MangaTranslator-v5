/**
 * jest.config.js — MangaTranslator v3.1
 *
 * POSIÇÃO: tests/jest.config.js
 * ROOT: quando executado com `npm test` dentro de tests/, rootDir = tests/
 *
 * CORREÇÕES APLICADAS:
 * 1. setupFilesAfterFramwork (typo original)
 *    → setupFilesAfterFramework (typo corrigido no v3.1)
 *    → setupFilesAfterEnv (nome REAL da opção do Jest 24+)
 *    Motivo: setupFilesAfterFramework não existe na API do Jest. A opção
 *    correta é setupFilesAfterEnv. O typo original era triplo: nome errado
 *    + letra faltando. Silenciosamente ignorado pelo Jest, os mocks NUNCA
 *    foram carregados nos testes anteriores.
 *
 * 2. Prefixo "tests/" removido dos testMatch e setupFilesAfterEnv
 *    Motivo: rootDir = tests/ (diretório deste arquivo). Caminhos com
 *    "<rootDir>/tests/unit/..." resolveriam para "tests/tests/unit/..."
 *    que não existe. Sem o prefixo: "<rootDir>/unit/..." = "tests/unit/". ✓
 *
 * 3. collectCoverageFrom: "extension/" → "../extension/"
 *    Motivo: os arquivos da extensão estão em ../extension/ relativo a tests/.
 */
module.exports = {
    testEnvironment: 'node',
    verbose: true,
    cache: true,
    cacheDirectory: '<rootDir>/.jest-cache',
    // CORREÇÃO: testTimeout no nível RAIZ (não dentro de projects) — opção só é reconhecida aqui.
    // 15000ms cobre testes de integração com múltiplas Promises encadeadas de storage mock.
    testTimeout: 15000,
    projects: [
        {
            displayName: 'background',
            testEnvironment: 'node',
            testMatch: ['<rootDir>/unit/background/**/*.test.js'],
            setupFilesAfterEnv: ['<rootDir>/mocks/chrome-api.mock.js'],
        },
        {
            displayName: 'gtc',
            testEnvironment: 'node',
            testMatch: ['<rootDir>/unit/gtc/**/*.test.js'],
        },
        {
            displayName: 'content-scripts',
            testEnvironment: 'jsdom',
            testMatch: [
                '<rootDir>/unit/content-manga/**/*.test.js',
                '<rootDir>/unit/content-gemini/**/*.test.js',
                '<rootDir>/unit/inject/**/*.test.js',
            ],
            setupFilesAfterEnv: [
                '<rootDir>/mocks/chrome-api.mock.js',
                '<rootDir>/mocks/dom-environment.js',
            ],
        },
        {
            displayName: 'popup',
            testEnvironment: 'jsdom',
            testMatch: ['<rootDir>/unit/popup/**/*.test.js'],
            setupFilesAfterEnv: [
                '<rootDir>/mocks/chrome-api.mock.js',
                '<rootDir>/mocks/dom-environment.js',
            ],
        },
        {
            displayName: 'reader',
            testEnvironment: 'jsdom',
            testMatch: ['<rootDir>/unit/reader/**/*.test.js'],
            setupFilesAfterEnv: [
                '<rootDir>/mocks/chrome-api.mock.js',
                '<rootDir>/mocks/dom-environment.js',
            ],
        },
        {
            displayName: 'integration',
            testEnvironment: 'jsdom',
            testMatch: ['<rootDir>/integration/**/*.test.js'],
            setupFilesAfterEnv: [
                '<rootDir>/mocks/chrome-api.mock.js',
                '<rootDir>/mocks/dom-environment.js',
            ],
            // testTimeout removido daqui — não é opção válida em project config.
            // O testTimeout: 15000 está na raiz do config (acima).
        },
    ],
    collectCoverageFrom: [
        '../extension/background.js',
        '../extension/content_gemini.js',
        '../extension/content_manga.js',
        '../extension/gtc-fingerprint.js',
        '../extension/gtc-indexeddb.js',
        '../extension/inject.js',
        '../extension/popup.js',
        '../extension/reader.js',
    ],
    // CORREÇÃO: "coverageThresholds" (plural) → "coverageThreshold" (singular, nome real da opção Jest)
    coverageThreshold: {
        global: { branches: 70, functions: 80, lines: 80, statements: 80 },
    },
    coverageReporters: ['text', 'lcov', 'html'],
    coverageDirectory: '<rootDir>/coverage',
};
