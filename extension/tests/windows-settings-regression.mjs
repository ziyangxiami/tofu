// Settings regression plus compiled launcher logic using inert Win32 API doubles.
import assert from 'node:assert/strict';
import {readFileSync, mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, resolve, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import vm from 'node:vm';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const context = vm.createContext({console});
const module = new vm.SourceTextModule(readFileSync(resolve(repository, 'extension/settings.js'), 'utf8'), {context});
await module.link(() => { throw new Error('unexpected import'); });
await module.evaluate();
const target = {name: 'service', nested: {enabled: false}, requestInterval: 1000, debug: false};
module.namespace.default.apply(target, {
    'service.nested.enabled': true,
    'unrelated.debug': true,
    'service.requestInterval': 2500,
    'service.debug': true,
});
assert.equal(target.nested.enabled, true);
assert.equal(target.requestInterval, 2500, 'a nested setting must not redirect later settings to its child object');
assert.equal(target.debug, true);
assert.equal(target.nested.requestInterval, undefined);
console.log('settings regression: mixed nested and top-level settings passed');

// A host compiler is optional for extension contributors, and an explicit skip
// is different from a Windows build. In this task clang compiles and runs this.
const compiler = process.env.CC || 'clang';
const available = spawnSync(compiler, ['--version'], {encoding: 'utf8'});
if (available.error?.code === 'ENOENT') {
    console.log('SKIP launcher C regression: host C compiler unavailable (Windows build not verified)');
} else {
    if (available.error) throw available.error;
    assert.equal(available.status, 0, available.stderr);
    const temp = mkdtempSync(join(tmpdir(), 'tofu-launcher-test-'));
    try {
        const executable = join(temp, process.platform === 'win32' ? 'launcher-test.exe' : 'launcher-test');
        const built = spawnSync(compiler, ['-std=c11', '-Wall', '-Wextra', '-Werror',
            '-I' + resolve(repository, 'chrome/tests/win32'),
            resolve(repository, 'chrome/tests/launcher-regression.c'), '-o', executable], {encoding: 'utf8'});
        if (built.error) throw built.error;
        assert.equal(built.status, 0, built.stdout + built.stderr);
        const ran = spawnSync(executable, [], {encoding: 'utf8'});
        if (ran.error) throw ran.error;
        assert.equal(ran.status, 0, ran.stdout + ran.stderr);
        process.stdout.write(ran.stdout);
    } finally {
        rmSync(temp, {recursive: true, force: true});
    }
}
