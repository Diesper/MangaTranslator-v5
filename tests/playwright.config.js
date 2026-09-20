const { defineConfig, devices } = require('@playwright/test');
const path = require('path');

/**
 * playwright.config.js — MangaTranslator v3.2
 *
 * POSIÇÃO: tests/playwright.config.js
 *
 * CORREÇÃO APLICADA:
 * Original: webServer.command usava process.cwd() + "/tests/e2e/fixtures/..."
 * → Se executado de dentro de tests/, process.cwd() = tests/, portanto
 *   o caminho resultante seria "tests/tests/e2e/fixtures/..." ← ERRADO.
 * Corrigido: usa path.join(__dirname, 'e2e/fixtures/...') que é sempre
 * relativo ao diretório DESTE arquivo (tests/), independente do cwd. ✓
 */
module.exports = defineConfig({
    testDir: './e2e',
    outputDir: './test-results',
    timeout: 60000, // 60s por teste E2E (operações de UI são lentas)
    retries: 2,     // Testes E2E são inerentemente flaky — 2 retries

    use: {
        // Carrega a extensão real do Chrome
        // CRÍTICO: Playwright suporta extensões apenas com chromium
        channel: 'chromium',

        launchOptions: {
            args: [
                '--headless=new', // BROWSER FANTASMA REAL: Roda extensões 100% invisível
                `--disable-extensions-except=${path.join(__dirname, '../extension')}`,
                `--load-extension=${path.join(__dirname, '../extension')}`,
                '--no-sandbox',
                '--disable-setuid-sandbox',
            ],
        },

        // Sem headless puro nativo — extensões Chrome não funcionam no modo antigo
        headless: false,

        viewport: { width: 1280, height: 720 },
        screenshot: 'only-on-failure',
        video: 'retain-on-failure',
    },

    projects: [
        {
            name: 'extension-tests',
            use: { ...devices['Desktop Chrome'] },
        },
    ],

    // Servidor local para servir a página de mangá fake
    webServer: {
        command: `"${process.execPath}" "${path.join(__dirname, 'e2e/fixtures/gemini-mock-server.js')}"`,
        port: 3999,
        reuseExistingServer: true,
    },
});
