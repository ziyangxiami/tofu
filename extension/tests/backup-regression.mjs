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
const context = vm.createContext({chrome, crypto: webcrypto, URL, EventTarget, console});
const source = name => readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '..', name), 'utf8');
const diagnostics = new vm.SourceTextModule(source('services/diagnostics.js'), {context});
const taskError = new vm.SyntheticModule(['default'], function () {
    this.setExport('default', class TaskError extends Error {});
}, {context});
const storageModule = new vm.SyntheticModule(['default'], function () {
    this.setExport('default', class Storage {
        constructor() {
            this.global = {
                open: async () => {}, close: () => {},
                account: {get: async () => ({userInfo: {id: 1}})},
            };
            this.local = {open: async () => {}, close: () => {}};
        }
    });
}, {context});
const parserModule = new vm.SyntheticModule(['default'], function () {
    this.setExport('default', () => null);
}, {context});
const task = new vm.SourceTextModule(source('services/Task.js'), {context});
await task.link(specifier => ({'./TaskError.js': taskError, '../storage.js': storageModule,
    './html_parser.js': parserModule})[specifier]);
await task.evaluate();
const imports = {'../services/Task.js': task, '../services/TaskError.js': taskError,
    '../services/diagnostics.js': diagnostics};
const taskModules = new Map();
async function loadTask(filename) {
    const module = new vm.SourceTextModule(source(filename), {context});
    await module.link(specifier => imports[specifier]);
    await module.evaluate();
    taskModules.set(filename, module);
    return module.namespace.default;
}

const Doulist = await loadTask('tasks/doulist.js');
const Annotation = await loadTask('tasks/annotation.js');
const unusedTaskModule = new vm.SyntheticModule(['default'], function () {
    this.setExport('default', class UnusedTask {});
}, {context});
const deserializer = new vm.SourceTextModule(source('services/task_deserialize.js'), {context});
await deserializer.link(specifier => ({
    './Task.js': task,
    '../tasks/annotation.js': taskModules.get('tasks/annotation.js'),
    '../tasks/doulist.js': taskModules.get('tasks/doulist.js'),
})[specifier] || unusedTaskModule);
await deserializer.evaluate();
const {taskFromJSON} = deserializer.namespace;
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

const savedDoulists = [];
const recoveredDoulist = new Doulist();
Object.assign(recoveredDoulist, {
    jobId: 6, diagnosticRunId: 'run-recovered-doulist',
    targetUser: {id: 1, owned_doulist_count: 0, following_doulist_count: 2},
    session: doulist.session,
    storage: {
        table: () => ({put: async () => {}}),
        doulist: {
            get: async id => { assert(Number.isSafeInteger(id)); return null; },
            put: async row => savedDoulists.push(row),
        },
        doulistItem: doulist.storage.doulistItem,
    },
    parseHTML: doulist.parseHTML,
    fetch: async url => {
        if (url.includes('owned_doulists')) {
            return {status: 200, json: async () => ({total: 0, doulists: []})};
        }
        if (url.includes('following_doulists')) {
            return {status: 200, json: async () => ({total: 2, doulists: [
                {title: 'recoverable', desc: '', url: 'https://www.douban.com/doulist/22/'},
                {title: 'missing ID', desc: '', url: 'https://www.douban.com/other/'},
            ]})};
        }
        return {status: 200, text: async () => '<html></html>'};
    },
});
await assert.rejects(() => recoveredDoulist.run(), /部分豆列缺少有效 ID/);
assert.deepEqual(savedDoulists.map(row => row.id), [22]);

const annotationRows = new Map();
const pageLink = id => ({
    getAttribute: name => name === 'href' ? `https://book.douban.com/annotation/${id}/` : '',
    textContent: `Note ${id}`,
});
const pageHTML = (id, next) => ({
    querySelectorAll: () => [{
        querySelector: () => null,
        querySelectorAll: () => [{querySelector: selector => selector === 'h5>a' ? pageLink(id) : null}],
    }],
    querySelector: selector => selector === '.paginator .next a' && next ?
        {getAttribute: () => '?start=10'} : null,
});
const checkpointStorage = {
    table: () => ({put: async () => {}}),
    annotation: {
        get: async id => annotationRows.get(id),
        put: async row => annotationRows.set(row.id, row),
    },
};
let persistedCheckpoint;
const interruptedAnnotation = new Annotation();
Object.assign(interruptedAnnotation, {
    jobId: 7, diagnosticRunId: 'run-resumed-annotation',
    targetUser: {id: 1}, session: annotation.session, isOtherUser: false,
    completion: 0, logger: annotation.logger, storage: checkpointStorage,
    parseHTML: html => html === 'page1' ? pageHTML(101, true) : pageHTML(202, false),
    fetchWebAnnotation: async () => ({fulltext: '<p>note</p>'}),
    saveCheckpoint: async function () { persistedCheckpoint = structuredClone(this.checkpoint); },
    fetch: async url => {
        if (url.includes('/rexxar/api/')) {
            return {status: 200, json: async () => ({total: 0, collections: []})};
        }
        if (url.includes('start=10')) throw new Error('simulated worker stop');
        return {status: 200, text: async () => 'page1'};
    },
});
await assert.rejects(() => interruptedAnnotation.run(), /simulated worker stop/);
assert.equal(persistedCheckpoint.nextURL, 'https://book.douban.com/people/1/annotation/?start=10');
assert.equal(persistedCheckpoint.saved, 1);

const resumedRequests = [];
const serializedAnnotation = JSON.parse(JSON.stringify(interruptedAnnotation.toJSON()));
assert.equal(serializedAnnotation.checkpoint.saved, 1);
const resumedAnnotation = taskFromJSON(serializedAnnotation, null, annotation.logger, checkpointStorage);
resumedAnnotation.init(null, annotation.logger, 7, annotation.session, checkpointStorage, {id: 1}, false);
assert.equal(resumedAnnotation.checkpoint.saved, 1, 'task initialization must retain its checkpoint');
Object.assign(resumedAnnotation, {
    jobId: 7, diagnosticRunId: 'run-resumed-annotation',
    targetUser: {id: 1}, session: annotation.session, isOtherUser: false,
    completion: 0,
    logger: annotation.logger, storage: checkpointStorage,
    parseHTML: interruptedAnnotation.parseHTML,
    fetchWebAnnotation: interruptedAnnotation.fetchWebAnnotation,
    saveCheckpoint: async () => {},
    fetch: async url => {
        resumedRequests.push(url);
        assert(url.includes('start=10'), 'resume must skip the mobile API and completed page');
        return {status: 200, text: async () => 'page2'};
    },
});
await resumedAnnotation.run();
assert.equal(resumedRequests.length, 1);
assert.equal(resumedAnnotation.completion, 2);
assert.equal(annotationRows.size, 2);
assert.equal(resumedAnnotation.checkpoint, null);

const serviceModule = new vm.SyntheticModule(['default'], function () {
    this.setExport('default', class Service {
        static getFetchURL() { return async () => { throw new Error('completed task ran again'); }; }
    });
}, {context});
const queueModule = new vm.SyntheticModule(['default'], function () {
    this.setExport('default', class Queue {
        isEmpty() { return true; }
        enqueue() { throw new Error('completed task was queued again'); }
    });
}, {context});
const jobModule = new vm.SourceTextModule(source('services/Job.js'), {context});
await jobModule.link(specifier => ({
    '../service.js': serviceModule, './Task.js': task, './TaskError.js': taskError,
    './AsyncBlockingQueue.js': queueModule, '../storage.js': storageModule,
    './task_deserialize.js': deserializer, './diagnostics.js': diagnostics,
})[specifier]);
await jobModule.evaluate();
const Job = jobModule.namespace.default;
const service = {logger: {debug: () => {}}, saveState: async () => {}};
const job = new Job(service, 1, 1, true);
job._id = 9;
job.addTask(resumedAnnotation);
job._completedTaskTypes = ['Annotation'];
const restoredJob = Job.fromJSON(JSON.parse(JSON.stringify(job.toJSON())), service, checkpointStorage);
assert.equal(restoredJob.tasks[0].constructor.name, 'Annotation');
assert.equal(restoredJob._completedTaskTypes[0], 'Annotation');
await restoredJob.run();
assert(!restoredJob._failedTasks.length);

await recordDiagnostic('run-annotation', 'task.finished', {
    task: 'Annotation', outcome: 'completed', count: 1,
    cookie: 'secret-cookie', url: 'https://secret.example/?ck=secret-cookie',
    body: 'private backup content',
});
await recordDiagnostic('run-annotation', 'task.finished', {
    task: 'Annotation', outcome: 'failed', errorType: 'TypeError',
    errorStack: 'TypeError: private backup content\n at chrome-extension://secret-id/tasks/doulist.js:14:20?ck=secret-cookie',
});
await recordDiagnostic('run-annotation', 'task.finished', {
    task: 'Doulist', outcome: 'failed', errorType: 'DataError',
});
const report = await getDiagnosticReport();
assert(report.entries.some(entry => entry.event === 'doulist.missing_tags' && entry.count === 1));
assert(report.entries.some(entry => entry.event === 'doulist.api' && entry.listType === 'owned' && entry.apiGroups === 1));
assert(report.entries.some(entry => entry.event === 'annotation.fallback' && entry.count === 1));
assert(report.entries.some(entry => entry.event === 'annotation.fallback' && entry.count === 0));
assert(report.entries.some(entry => entry.event === 'doulist.api' && entry.reason === 'invalid_response'));
assert(report.entries.some(entry => entry.event === 'doulist.invalid_id' && entry.listType === 'following'));
assert(report.entries.some(entry => entry.event === 'annotation.page' && entry.pages === 1));
assert(report.entries.some(entry => entry.event === 'task.skipped' && entry.task === 'Annotation'));
assert(report.entries.some(entry => entry.errorType === 'DataError'));
assert(report.entries.some(entry => entry.errorLocation === 'tasks/doulist.js:14'));
const exported = JSON.stringify(report);
assert(!exported.includes('secret-cookie'));
assert(!exported.includes('private backup content'));
assert(!exported.includes('secret.example'));
console.log('backup regression: passed');
