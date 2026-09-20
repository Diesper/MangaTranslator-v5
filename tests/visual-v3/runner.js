'use strict';
const RESET = '\x1b[0m', GREEN = '\x1b[32m', RED = '\x1b[31m';
const YELLOW = '\x1b[33m', CYAN = '\x1b[36m', DIM = '\x1b[2m', BOLD = '\x1b[1m';

const results = { pass: 0, fail: 0, skip: 0, errors: [] };
let _currentSuite = '(root)', _suiteDepth = 0;

// Scoped hooks — each describe level gets its own array
const _beforeStack = [[]];
const _afterStack  = [[]];

function _allBefores() { return _beforeStack.slice(1).flat(); }
function _allAfters()  { return _afterStack.slice(1).flat();  }

// Serial async queue — eliminates race conditions between ita tests
let _asyncQueue = Promise.resolve();

function describe(name, fn) {
    const prev = _currentSuite;
    _currentSuite = name;
    _suiteDepth++;
    const indent = '  '.repeat(_suiteDepth - 1);
    console.log(`\n${indent}${CYAN}${BOLD}▶ ${name}${RESET}`);
    _beforeStack.push([]);
    _afterStack.push([]);
    try { fn(); } catch (e) {
        console.log(`${indent}  ${RED}✖ SUITE ERROR: ${e.message}${RESET}`);
        results.fail++;
        results.errors.push({ suite: name, test: '(suite-level)', error: e });
    }
    _beforeStack.pop();
    _afterStack.pop();
    _suiteDepth--;
    _currentSuite = prev;
}

function beforeEach(fn) { _beforeStack[_beforeStack.length - 1].push(fn); }
function afterEach(fn)  { _afterStack[_afterStack.length - 1].push(fn);  }

function it(label, fn) {
    const indent = '  '.repeat(_suiteDepth);
    if (!fn) { console.log(`${indent}${YELLOW}○ ${label} (skipped)${RESET}`); results.skip++; return; }
    const befores = _allBefores(), afters = _allAfters();
    for (const bf of befores) { try { bf(); } catch (_e) {} }
    try {
        fn();
        console.log(`${indent}${GREEN}✔${RESET} ${label}`);
        results.pass++;
    } catch (e) {
        console.log(`${indent}${RED}✖ ${label}${RESET}`);
        console.log(`${indent}  ${DIM}${e && e.message ? e.message : e}${RESET}`);
        results.fail++;
        results.errors.push({ suite: _currentSuite, test: label, error: e });
    }
    for (const af of afters) { try { af(); } catch (_e) {} }
}

function ita(label, fn) {
    const indent = '  '.repeat(_suiteDepth), suiteName = _currentSuite, depth = _suiteDepth;
    if (!fn) { console.log(`${indent}${YELLOW}○ ${label} (skipped)${RESET}`); results.skip++; return Promise.resolve(); }
    // Snapshot hooks at registration time (CRITICAL: before describe pops its layer)
    const befores = _allBefores();
    const afters  = _allAfters();
    return _asyncQueue = _asyncQueue.then(async () => {
        const ind = '  '.repeat(depth);
        for (const bf of befores) { try { await bf(); } catch (_e) {} }
        try {
            await fn();
            console.log(`${ind}${GREEN}✔${RESET} ${label}`);
            results.pass++;
        } catch (e) {
            console.log(`${ind}${RED}✖ ${label}${RESET}`);
            console.log(`${ind}  ${DIM}${e && e.message ? e.message : e}${RESET}`);
            results.fail++;
            results.errors.push({ suite: suiteName, test: label, error: e });
        }
        for (const af of afters) { try { await af(); } catch (_e) {} }
    });
}

function expect(actual) {
    const self = {
        toBe(e) { if (!Object.is(actual, e)) throw new Error(`Expected ${JSON.stringify(e)}, got ${JSON.stringify(actual)}`); },
        toEqual(e) { const a = JSON.stringify(actual), b = JSON.stringify(e); if (a !== b) throw new Error(`Expected\n  ${b}\ngot\n  ${a}`); },
        toBeGreaterThan(n)        { if (!(actual > n))  throw new Error(`Expected ${actual} > ${n}`); },
        toBeGreaterThanOrEqual(n) { if (!(actual >= n)) throw new Error(`Expected ${actual} >= ${n}`); },
        toBeLessThan(n)           { if (!(actual < n))  throw new Error(`Expected ${actual} < ${n}`); },
        toBeLessThanOrEqual(n)    { if (!(actual <= n)) throw new Error(`Expected ${actual} <= ${n}`); },
        toBeCloseTo(e, d=2) { if (Math.abs(actual-e) >= Math.pow(10,-d)/2) throw new Error(`Expected ${actual} ≈ ${e}`); },
        toBeNaN()       { if (!Number.isNaN(actual))   throw new Error(`Expected NaN, got ${actual}`); },
        toBeTruthy()    { if (!actual)  throw new Error(`Expected truthy, got ${JSON.stringify(actual)}`); },
        toBeFalsy()     { if (actual)   throw new Error(`Expected falsy, got ${JSON.stringify(actual)}`); },
        toBeNull()      { if (actual !== null)      throw new Error(`Expected null, got ${JSON.stringify(actual)}`); },
        toBeUndefined() { if (actual !== undefined) throw new Error(`Expected undefined, got ${JSON.stringify(actual)}`); },
        toBeDefined()   { if (actual == null)       throw new Error(`Expected defined, got ${JSON.stringify(actual)}`); },
        toMatch(p) { const re = typeof p === 'string' ? new RegExp(p) : p; if (!re.test(String(actual))) throw new Error(`Expected "${actual}" to match ${re}`); },
        toHaveLength(n) { const len = actual == null ? -1 : actual.length; if (len !== n) throw new Error(`Expected length ${n}, got ${len}`); },
        toContain(item) {
            if (typeof actual === 'string') { if (!actual.includes(item)) throw new Error(`Expected string to contain "${item}"`); }
            else if (Array.isArray(actual)) { if (!actual.includes(item)) throw new Error(`Expected array to contain ${JSON.stringify(item)}`); }
            else throw new Error('toContain: not string or array');
        },
        toHaveProperty(key, value) {
            if (!(key in Object(actual))) throw new Error(`Expected object to have property "${key}"`);
            if (value !== undefined && !Object.is(actual[key], value)) throw new Error(`Expected "${key}" = ${JSON.stringify(value)}, got ${JSON.stringify(actual[key])}`);
        },
        toBeTypeOf(type) { if (typeof actual !== type) throw new Error(`Expected typeof ${type}, got ${typeof actual}`); },
        toThrow(msgOrRe) {
            if (typeof actual !== 'function') throw new Error('toThrow requires a function');
            let threw = false, msg = '';
            try { actual(); } catch (e) { threw = true; msg = e && e.message ? e.message : String(e); }
            if (!threw) throw new Error('Expected function to throw');
            if (msgOrRe) { const re = typeof msgOrRe === 'string' ? new RegExp(msgOrRe) : msgOrRe; if (!re.test(msg)) throw new Error(`Expected error matching ${re}, got "${msg}"`); }
        },
        get not() {
            return new Proxy({}, { get(_, method) { return (...args) => {
                let threw = false;
                try { self[method](...args); } catch (_e) { threw = true; }
                if (!threw) throw new Error(`.not.${method}() should have thrown`);
            }; }});
        },
    };
    return self;
}

function printSummary() {
    const total = results.pass + results.fail + results.skip;
    console.log('\n' + '─'.repeat(60));
    console.log(`${BOLD}Test Summary${RESET}`);
    console.log(`  ${GREEN}Passed:${RESET}  ${results.pass}`);
    if (results.skip > 0) console.log(`  ${YELLOW}Skipped:${RESET} ${results.skip}`);
    if (results.fail > 0) {
        console.log(`  ${RED}Failed:${RESET}  ${results.fail}`);
        console.log(`\n${RED}${BOLD}Failures:${RESET}`);
        results.errors.forEach(({ suite, test, error }) => {
            console.log(`  ${RED}✖${RESET} [${suite}] ${test}`);
            const msg = error && error.message ? error.message : String(error);
            msg.split('\n').forEach(l => console.log(`      ${DIM}${l}${RESET}`));
        });
    }
    console.log(`  ${BOLD}Total:${RESET}   ${total}`);
    console.log('─'.repeat(60));
    return results.fail === 0;
}

function getAsyncQueue() { return _asyncQueue; }

module.exports = { describe, it, ita, beforeEach, afterEach, expect, printSummary, results, getAsyncQueue };
