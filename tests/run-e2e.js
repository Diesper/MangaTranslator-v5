const { spawn } = require('child_process');
const path = require('path');
const readline = require('readline');

const playwrightCli = path.join(__dirname, 'node_modules', 'playwright', 'cli.js');

const forwardedArgs = process.argv.slice(2);
const DEFAULT_MODE = 'stealth';

function normalizeMode(value) {
    const mode = String(value || '').trim().toLowerCase();
    if (['show', 'visible', 'headed', 'ui', 's', 'sim', 'y', 'yes'].includes(mode)) return 'show';
    if (['stealth', 'headless', 'ghost', 'n', 'nao', 'não', 'no'].includes(mode)) return 'stealth';
    return null;
}

function logSelectedMode(mode, reason) {
    const label = mode === 'show' ? 'VISUAL' : 'STEALTH';
    console.log(`\n[E2E] Modo selecionado: ${label}. ${reason}`);
}

async function askBrowserMode() {
    const presetMode = normalizeMode(process.env.MANGA_E2E_BROWSER_MODE);
    if (presetMode) {
        logSelectedMode(presetMode, 'Valor recebido por variavel de ambiente.');
        return presetMode;
    }

    if (!process.stdin.isTTY || !process.stdout.isTTY || process.env.CI) {
        logSelectedMode(DEFAULT_MODE, 'Terminal nao interativo detectado; iniciando automaticamente.');
        return DEFAULT_MODE;
    }

    return new Promise(resolve => {
        const rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout,
        });

        let settled = false;
        let secondsLeft = 5;

        const cleanup = () => {
            clearInterval(tickInterval);
            clearTimeout(autoStartTimer);
            rl.removeAllListeners('line');
            rl.close();
            process.stdin.pause();
        };

        const finish = (mode, reason) => {
            if (settled) return;
            settled = true;
            process.stdout.write('\n');
            cleanup();
            logSelectedMode(mode, reason);
            resolve(mode);
        };

        const renderCountdown = () => {
            process.stdout.write(
                `\r[E2E] Mostrar navegador e acoes? Digite "s" + Enter. ` +
                `Stealth automatico em ${secondsLeft}s...   `
            );
        };

        console.log('[E2E] Responda "s" para acompanhar o navegador. Enter, "n" ou silencio iniciam em stealth.');
        renderCountdown();

        rl.on('line', answer => {
            const normalized = normalizeMode(answer);
            if (normalized === 'show') {
                finish('show', 'Usuario pediu para mostrar o navegador e as acoes.');
                return;
            }

            finish('stealth', answer.trim()
                ? `Resposta "${answer.trim()}" recebida; iniciando em stealth.`
                : 'Nenhuma resposta explicita; iniciando em stealth.');
        });

        const tickInterval = setInterval(() => {
            secondsLeft -= 1;
            if (secondsLeft > 0) renderCountdown();
        }, 1000);

        const autoStartTimer = setTimeout(() => {
            finish('stealth', 'Contagem de 5 segundos encerrada; iniciando automaticamente.');
        }, 5000);
    });
}

async function runPlaywright(mode) {
    const env = {
        ...process.env,
        MANGA_E2E_BROWSER_MODE: mode,
    };

    const playwrightArgs = ['test', '--config', 'playwright.config.js', ...forwardedArgs];
    return new Promise((resolve, reject) => {
        const child = spawn(
            process.execPath,
            [playwrightCli, ...playwrightArgs],
            {
                cwd: __dirname,
                env,
                stdio: 'inherit',
                shell: false,
            }
        );

        child.on('error', reject);
        child.on('close', code => resolve(code == null ? 1 : code));
    });
}

(async () => {
    const mode = await askBrowserMode();
    const code = await runPlaywright(mode);
    process.exit(code);
})().catch(error => {
    console.error('\n[E2E] Falha ao iniciar o launcher do Playwright.');
    console.error(error && error.stack ? error.stack : error);
    process.exit(1);
});
