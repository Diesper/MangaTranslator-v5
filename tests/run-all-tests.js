const { spawn } = require('child_process');
const path = require('path');

const stripAnsi = (str) => str.replace(/\x1B\[\d+m/g, '').replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '');

function parseJestSummary(output) {
  const testsLine = output.match(/Tests:\s+([^\n\r]+)/);
  if (!testsLine) return { passed: 0, failed: 0, total: 0 };

  const summary = testsLine[1];
  const passedMatch = summary.match(/(\d+)\s+passed/);
  const failedMatch = summary.match(/(\d+)\s+failed/);
  const totalMatch = summary.match(/(\d+)\s+total/);

  return {
    passed: passedMatch ? parseInt(passedMatch[1], 10) : 0,
    failed: failedMatch ? parseInt(failedMatch[1], 10) : 0,
    total: totalMatch ? parseInt(totalMatch[1], 10) : 0,
  };
}

function parseVisualV3Summary(output) {
  const clean = stripAnsi(output || '');
  const passedMatch = clean.match(/Passed:[^\d\r\n]*(\d+)/i) || (output || '').match(/Passed:[^\d\r\n]*(\d+)/i);
  const failedMatch = clean.match(/Failed:[^\d\r\n]*(\d+)/i) || (output || '').match(/Failed:[^\d\r\n]*(\d+)/i);
  const totalMatch = clean.match(/Total:[^\d\r\n]*(\d+)/i) || (output || '').match(/Total:[^\d\r\n]*(\d+)/i);
  const passed = passedMatch ? parseInt(passedMatch[1], 10) : 0;
  const failed = failedMatch ? parseInt(failedMatch[1], 10) : 0;
  return {
    passed,
    failed,
    total: totalMatch ? parseInt(totalMatch[1], 10) : passed + failed,
  };
}

async function runCommand(name, cmd, args) {
  return new Promise((resolve) => {
    console.log(`\n======================================================`);
    console.log(`🚀 INICIANDO: ${name}`);
    console.log(`======================================================\n`);

    const child = spawn(cmd, args, {
      cwd: __dirname,
      shell: false,
      stdio: ['inherit', 'pipe', 'pipe'],
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
      },
    });

    let output = '';

    child.on('error', (error) => {
      output += error.stack || String(error);
      resolve({ name, code: 1, output: stripAnsi(output) });
    });

    child.stdout.on('data', (data) => {
      process.stdout.write(data);
      output += data.toString();
    });

    child.stderr.on('data', (data) => {
      process.stderr.write(data);
      output += data.toString();
    });

    let settled = false;
    const finish = (code) => {
      if (settled) return;
      settled = true;
      resolve({ name, code: code == null ? 1 : code, output });
    };

    child.on('close', finish);
    child.on('exit', finish);
  });
}

const ROOT_PACKAGE_VERSION = require('../package.json').version;
const PRODUCT_VERSION = ROOT_PACKAGE_VERSION.endsWith('.0')
  ? ROOT_PACKAGE_VERSION.slice(0, -2)
  : ROOT_PACKAGE_VERSION;

async function runAll() {
  const nodeCmd = process.execPath;
  const jestBin = path.join(__dirname, 'node_modules', 'jest', 'bin', 'jest.js');
  
  const rawArgs = process.argv.slice(2).map(a => a.toLowerCase().trim());
  const includeE2E = rawArgs.includes('--e2e') || rawArgs.includes('e2e');
  const onlyVisual = rawArgs.includes('--visual') || rawArgs.includes('visual');
  const onlyJest = rawArgs.includes('--jest') || rawArgs.includes('jest') || rawArgs.includes('--unit') || rawArgs.includes('unit');
  const onlySmoke = rawArgs.includes('--smoke') || rawArgs.includes('smoke');

  const results = [];

  // 0. Testes de Fumaça (opcional ou isolado com --smoke)
  if (onlySmoke) {
    results.push(await runCommand(
      'Testes de Fumaça (Smoke Tests)',
      nodeCmd,
      [path.join(__dirname, 'smoke', 'run-smoke.js')]
    ));
  }

  // 1. Jest (Unitários e Integração — 62 suítes, 492 testes)
  if (!onlyVisual && !onlySmoke) {
    results.push(await runCommand(
      'Testes Jest (Unitários e Integração)',
      nodeCmd,
      [jestBin, '--config', 'jest.config.js', '--runInBand', '--forceExit']
    ));
  }

  // 2. Perceptual Visual (v3 e v4 — 8 suítes, 224 testes)
  if (!onlyJest && !onlySmoke) {
    results.push(await runCommand(
      'Testes Perceptuais Visuais (v3 e v4)',
      nodeCmd,
      [path.join(__dirname, 'visual-v3', 'run-all.js')]
    ));
  }

  // 3. Playwright E2E (opcional com --e2e)
  if (includeE2E && !onlySmoke) {
    results.push(await runCommand(
      'Testes E2E (Playwright)',
      nodeCmd,
      [path.join(__dirname, 'run-e2e.js')]
    ));
  }

  let totalPassed = 0;
  let totalFailed = 0;
  let totalTests = 0;

  const summaries = results.map(r => {
    let passed = 0, failed = 0, total = 0;
    if (r.name.includes('Smoke')) {
      const passedMatch = r.output.match(/(\d+)\s+arquivo\(s\),\s+todos\s+passaram/i);
      const failedMatch = r.output.match(/(\d+)\s+de\s+(\d+)\s+arquivo\(s\)\s+com\s+falha/i);
      if (passedMatch) {
        passed = parseInt(passedMatch[1], 10);
        total = passed;
      } else if (failedMatch) {
        failed = parseInt(failedMatch[1], 10);
        total = parseInt(failedMatch[2], 10);
        passed = total - failed;
      }
    } else if (r.name.toLowerCase().includes('visua')) {
      ({ passed, failed, total } = parseVisualV3Summary(r.output));
    } else if (r.name.includes('E2E')) {
      const passedMatch = r.output.match(/(\d+)\s+passed/);
      const failedMatch = r.output.match(/(\d+)\s+failed/);
      if (passedMatch) passed = parseInt(passedMatch[1], 10);
      if (failedMatch) failed = parseInt(failedMatch[1], 10);
      total = passed + failed;
    } else {
      ({ passed, failed, total } = parseJestSummary(r.output));
    }

    totalPassed += passed;
    totalFailed += failed;
    totalTests += total;

    const isSuccess = failed === 0 && total > 0 && (r.code === 0 || r.code == null);
    return { name: r.name, passed, failed, total, isSuccess };
  });

  console.log(`\n\n`);
  console.log(`================================================================`);
  console.log(`📊 RESUMO GERAL DOS TESTES — MangaTranslator v${PRODUCT_VERSION}`);
  console.log(`================================================================`);
  
  summaries.forEach(s => {
    const status = s.isSuccess ? '✅ SUCESSO' : '❌ FALHA ';
    console.log(`- ${s.name.padEnd(38)} | ${status} | Passou: ${s.passed.toString().padStart(3)} | Falhou: ${s.failed.toString().padStart(2)} | Total: ${s.total.toString().padStart(3)}`);
  });
  
  console.log(`----------------------------------------------------------------`);
  const allSuccess = totalFailed === 0 && totalTests > 0 && summaries.every(s => s.isSuccess);
  const generalStatus = allSuccess ? '✅ SUCESSO' : '❌ FALHA ';
  console.log(`📉 TOTAL GERAL:                         | ${generalStatus} | Passou: ${totalPassed.toString().padStart(3)} | Falhou: ${totalFailed.toString().padStart(2)} | Total: ${totalTests.toString().padStart(3)}`);
  console.log(`================================================================\n`);

  if (!allSuccess) {
    process.exit(1);
  }
}

runAll().catch((error) => {
  console.error(error);
  process.exit(1);
});
