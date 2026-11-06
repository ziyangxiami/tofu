// Run all offline regression suites: node extension/tests/run.mjs
import {readdirSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';

const directory = dirname(fileURLToPath(import.meta.url));
const suites = readdirSync(directory).filter(name => name.endsWith('-regression.mjs')).sort();
for (const suite of suites) {
    const result = spawnSync(process.execPath, ['--experimental-vm-modules', resolve(directory, suite)], {
        stdio: 'inherit',
    });
    if (result.error) throw result.error;
    if (result.status !== 0) process.exit(result.status || 1);
}
console.log(`All ${suites.length} offline regression suites passed.`);
