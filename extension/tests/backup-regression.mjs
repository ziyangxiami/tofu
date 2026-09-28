// Run with: node --experimental-vm-modules extension/tests/backup-regression.mjs
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import vm from 'node:vm';
import {webcrypto} from 'node:crypto';

const values = new Map();
const chrome = {
    storage: {local: {
        async get(key) { return {[key]: values.get(key)}; },
        async set(data) { for (const [key, value] of Object.entries(data)) values.set(key, value); },
    }},
    runtime: {getManifest: () => ({version: 'test'})},
};
const context = vm.createContext({chrome, crypto: webcrypto, URL, console});
const source = name => readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '..', name), 'utf8');
const diagnostics = new vm.SourceTextModule(source('services/diagnostics.js'), {context});
const task = new vm.SyntheticModule(['default'], function () {
    this.setExport('default', class Task {
        step() { this.completion += 1; }
        complete() { this.completion = this.total; }
    });
}, {context});
const taskError = new vm.SyntheticModule(['default'], function () {
    this.setExport('default', class TaskError extends Error {});
}, {context});
const imports = {'../services/Task.js': task, '../services/TaskError.js': taskError,
    '../services/diagnostics.js': diagnostics};
async function loadTask(filename) {
    const module = new vm.SourceTextModule(source(filename), {context});
    await module.link(specifier => imports[specifier]);
    await module.evaluate();
    return module.namespace.default;
}

const Doulist = await loadTask('tasks/doulist.js');
const Annotation = await loadTask('tasks/annotation.js');
const {recordDiagnostic, getDiagnosticReport} = diagnostics.namespace;

const doulist = new Doulist();
const oldRow = {id: 10, version: 1, doulist: {id: '10', title: 'list', desc: 'about'}};
doulist.jobId = 2;
doulist.diagnosticRunId = 'run-doulist';
doulist.targetUser = {id: 1, owned_doulist_count: 1, following_doulist_count: 0};
doulist.session = {cookies: {ck: 'secret-cookie'}};
doulist.storage = {
    table: () => ({put: async () => {}}),
    doulist: {get: async () => oldRow, put: async () => {}},
    doulistItem: {get: async () => null, put: async () => {}},
};
doulist.parseHTML = () => ({querySelector: () => null, querySelectorAll: () => []});
doulist.fetch = async url => {
    if (url.includes('owned_doulists')) {
        return {status: 200, json: async () => ({total: 1, doulists: [
            {id: '10', title: 'list', desc: 'about', url: 'https://www.douban.com/doulist/10/'},
        ]})};
    }
    if (url.includes('following_doulists')) {
        return {status: 200, json: async () => ({total: 0, doulists: []})};
    }
    return {status: 200, text: async () => '<html></html>'};
};
await doulist.run();
assert.equal(doulist.completion, 1);
assert.equal(doulist.missingTags, 1);
assert.equal(oldRow.doulist.tags, undefined);

const annotation = new Annotation();
const saved = [];
const warnings = [];
const urls = [];
annotation.jobId = 3;
annotation.diagnosticRunId = 'run-annotation';
annotation.targetUser = {id: 1};
annotation.session = {cookies: {ck: 'secret-cookie'}};
annotation.isOtherUser = false;
annotation.completion = 0;
annotation.logger = {warning: message => warnings.push(message)};
annotation.storage = {
    table: () => ({put: async () => {}}),
    annotation: {get: async () => null, put: async row => saved.push(row)},
};
const link = {
    getAttribute: name => name === 'href' ? 'https://book.douban.com/annotation/456/' : '',
    textContent: 'A note',
};
const item = {
    querySelector: selector => selector === 'h5>a' ? link : null,
};
const group = {
    querySelector: () => null,
    querySelectorAll: () => [item],
};
annotation.parseHTML = html => html === 'public' ? {
    querySelectorAll: () => [group], querySelector: () => null,
} : {querySelector: selector => selector === '#link-report' ? {innerHTML: '<p>A note</p>'} : null};
annotation.fetch = async url => {
    urls.push(url);
    if (url.includes('/rexxar/api/')) {
        return {status: 200, json: async () => ({total: 0, collections: []})};
    }
    if (url.includes('/people/')) return {status: 200, text: async () => 'public'};
    return {status: 200, text: async () => 'detail'};
};
await annotation.run();
assert.equal(saved.length, 1, 'empty mobile response must try the public page for own account');
assert.equal(annotation.completion, 1);
assert.equal(warnings.length, 1);
assert(urls.some(url => url.includes('book.douban.com/people/')));

const emptyAnnotation = new Annotation();
emptyAnnotation.jobId = 4;
emptyAnnotation.diagnosticRunId = 'run-empty';
emptyAnnotation.targetUser = {id: 1};
emptyAnnotation.session = {cookies: {ck: 'secret-cookie'}};
emptyAnnotation.isOtherUser = false;
emptyAnnotation.completion = 0;
emptyAnnotation.logger = {warning: message => warnings.push(message)};
emptyAnnotation.storage = annotation.storage;
emptyAnnotation.parseHTML = () => ({querySelectorAll: () => [], querySelector: () => null});
emptyAnnotation.fetch = async url => url.includes('/rexxar/api/') ?
    {status: 200, json: async () => ({total: 0, collections: []})} :
    {status: 200, text: async () => 'empty public page'};
await emptyAnnotation.run();
assert.equal(emptyAnnotation.completion, 0);
assert.equal(warnings.length, 3, 'an empty public page should produce a clear warning');

const invalidDoulist = new Doulist();
Object.assign(invalidDoulist, {
    jobId: 5, diagnosticRunId: 'run-invalid-doulist', targetUser: doulist.targetUser,
    session: doulist.session, storage: doulist.storage,
    fetch: async () => ({status: 200, json: async () => ({code: 500})}),
});
await assert.rejects(() => invalidDoulist.run(), /豆列接口响应格式错误/);

await recordDiagnostic('run-annotation', 'task.finished', {
    task: 'Annotation', outcome: 'completed', count: 1,
    cookie: 'secret-cookie', url: 'https://secret.example/?ck=secret-cookie',
    body: 'private backup content',
});
await recordDiagnostic('run-annotation', 'task.finished', {
    task: 'Annotation', outcome: 'failed', errorType: 'TypeError',
    errorStack: 'TypeError: private backup content\n at chrome-extension://secret-id/tasks/doulist.js:14:20?ck=secret-cookie',
});
const report = await getDiagnosticReport();
assert(report.entries.some(entry => entry.event === 'doulist.missing_tags' && entry.count === 1));
assert(report.entries.some(entry => entry.event === 'doulist.api' && entry.listType === 'owned' && entry.apiGroups === 1));
assert(report.entries.some(entry => entry.event === 'annotation.fallback' && entry.count === 1));
assert(report.entries.some(entry => entry.event === 'annotation.fallback' && entry.count === 0));
assert(report.entries.some(entry => entry.event === 'doulist.api' && entry.reason === 'invalid_response'));
assert(report.entries.some(entry => entry.errorLocation === 'tasks/doulist.js:14'));
const exported = JSON.stringify(report);
assert(!exported.includes('secret-cookie'));
assert(!exported.includes('private backup content'));
assert(!exported.includes('secret.example'));
console.log('backup regression: passed');
