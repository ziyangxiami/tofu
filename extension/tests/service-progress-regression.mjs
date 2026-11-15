// Run with: node --experimental-vm-modules extension/tests/service-progress-regression.mjs
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import vm from 'node:vm';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const context = vm.createContext({console});
const source = name => readFileSync(resolve(root, name), 'utf8');
const progress = new vm.SourceTextModule(source('ui/task-progress.js'), {context});
await progress.link(() => { throw new Error('unexpected import'); });
await progress.evaluate();
const {formatTaskProgress} = progress.namespace;

assert.equal(formatTaskProgress({completion: 50, total: 100}).text, '50 / 100 · 50%');
assert.equal(formatTaskProgress({completion: 1000, total: 2000}).text, '1,000 / 2,000 · 50%');
assert.equal(formatTaskProgress({completion: 1, total: 3}).text, '1 / 3 · 33%');
assert.equal(formatTaskProgress({completion: 0, total: 0}, true).text, '0 / 0 · 100%');
assert.equal(formatTaskProgress({completion: 1, total: 1}, true).text, '1 / 1 · 100%');
for (const task of [
    {}, {completion: 0, total: 1}, {completion: 0, total: 0},
    {completion: 5, total: 3}, {completion: 5, total: Infinity},
    {completion: -1, total: NaN}, {completion: 5, total: null},
    {taskType: 'Review', completion: 5, total: 5},
    {completion: 5, total: 5, checkpoint: {kind: 'annotation-web'}},
]) {
    const value = formatTaskProgress(task);
    assert.match(value.text, /\/ —$/);
    assert(!/NaN|Infinity|-1|100%/.test(value.text));
    assert(value.max > 0 && value.value >= 0 && value.value <= value.max);
}
assert.equal(formatTaskProgress({completion: 5, total: null}, true).text, '5 / —');
assert.equal(formatTaskProgress({taskType: 'Review', completion: 5, total: 5}, true).text, '5 / 5 · 100%');

const unused = new vm.SyntheticModule(['default', 'SERVICE_SETTINGS', 'TASK_FILES_SETTINGS', 'getDiagnosticReport'], function () {
    this.setExport('default', {});
    this.setExport('SERVICE_SETTINGS', {});
    this.setExport('TASK_FILES_SETTINGS', {});
    this.setExport('getDiagnosticReport', () => {});
}, {context});
const options = new vm.SourceTextModule(source('options.js').split('\nTabPanel.render();')[0], {context});
await options.link(specifier => specifier === './ui/task-progress.js' ? progress : unused);
await options.evaluate();

function fixture() {
    const requests = [];
    const frames = [];
    const errors = new Set(['is-hidden']);
    const service = {getProperty(property) {
        return new Promise((resolve, reject) => requests.push({property, resolve, reject}));
    }};
    const panel = Object.assign(Object.create(options.namespace.default.prototype), {
        refreshQueued: false, refreshPromise: null,
        renderStatus: status => frames.push({status}),
        progressList: {render: job => frames.push({job})},
        refreshError: {classList: {add: value => errors.add(value), remove: value => errors.delete(value)}},
    });
    return {panel, service, requests, frames, errors};
}

const tick = () => new Promise(resolve => setImmediate(resolve));
const normal = fixture();
const first = normal.panel.onProgress(normal.service);
assert.equal(normal.requests.length, 2);
assert.equal(normal.frames.length, 0, 'RPC latency must not clear or redraw the previous UI');
normal.requests[0].resolve(4);
await tick();
assert.equal(normal.frames.length, 0, 'wait for both status and job before changing controls');
normal.requests[1].resolve({tasks: [{completion: 1, total: 10}]});
await first;
assert.equal(normal.frames.length, 2);
assert.equal(normal.frames[1].job.tasks[0].completion, 1);

// Many progress/state events during a read produce only one trailing read.
const burst = normal.panel.onProgress(normal.service);
for (let i = 0; i < 50; i++) normal.panel.onStateChange(normal.service);
assert.equal(normal.requests.length, 4);
normal.requests[2].resolve(4);
normal.requests[3].resolve({tasks: [{completion: 2, total: 10}]});
await tick();
assert.equal(normal.requests.length, 6);
assert.equal(normal.frames.length, 4, 'render the latest available snapshot while a trailing read is pending');
assert.equal(normal.frames[3].job.tasks[0].completion, 2);
normal.requests[5].resolve({tasks: [{completion: 9, total: 10}]});
await tick();
assert.equal(normal.frames.length, 4);
normal.requests[4].resolve(1);
await burst;
assert.equal(normal.frames.length, 6);
assert.equal(normal.frames[4].status, 1);
assert.equal(normal.frames[5].job.tasks[0].completion, 9);

// A disconnect keeps the last useful frame and reports the refresh failure.
const failed = normal.panel.onProgress(normal.service);
normal.requests[6].reject(new Error('disconnected'));
normal.requests[7].reject(new Error('disconnected'));
await failed;
assert.equal(normal.frames.length, 6);
assert(!normal.errors.has('is-hidden'));
assert.equal(normal.panel.refreshPromise, null);

const recovered = normal.panel.onProgress(normal.service);
normal.requests[8].resolve(1);
normal.requests[9].resolve(null);
await recovered;
assert.equal(normal.frames.at(-1).job, null, 'a successful no-job response clears old tasks');
assert(normal.errors.has('is-hidden'));

// Failed old reads do not hide a newer successful snapshot.
const retry = fixture();
const pending = retry.panel.onProgress(retry.service);
retry.panel.onProgress(retry.service);
retry.requests[0].reject(new Error('old failure'));
retry.requests[1].resolve(null);
await tick();
assert.equal(retry.requests.length, 4);
assert.equal(retry.frames.length, 0);
retry.requests[2].resolve(4);
retry.requests[3].resolve({tasks: []});
await pending;
assert.equal(retry.frames.length, 2);
assert(retry.errors.has('is-hidden'));

// Even an event stream faster than RPC responses must make visible progress.
const streaming = fixture();
const stream = streaming.panel.onProgress(streaming.service);
for (let i = 0; i < 5; i++) {
    streaming.panel.onProgress(streaming.service);
    streaming.requests[i * 2].resolve(4);
    streaming.requests[i * 2 + 1].resolve({tasks: [{completion: i + 1, total: 10}]});
    await tick();
    assert.equal(streaming.frames.at(-1).job.tasks[0].completion, i + 1);
}
streaming.requests[10].resolve(4);
streaming.requests[11].resolve({tasks: [{completion: 6, total: 10}]});
await stream;
assert.equal(streaming.frames.at(-1).job.tasks[0].completion, 6);

console.log('Service progress regression passed (numeric/unknown/empty progress, coalesced events, delayed RPC, stale snapshots, disconnect and recovery).');
