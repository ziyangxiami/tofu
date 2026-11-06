// Offline migration verification: no request leaves this process.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {resolve, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import vm from 'node:vm';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const clone = value => JSON.parse(JSON.stringify(value));
const durable = new Map();
let failJournal = false;
const chrome = {storage: {local: {
    async get(key) {
        if (key === null) return Object.fromEntries([...durable].map(([name, value]) => [name, clone(value)]));
        return {[key]: durable.has(key) ? clone(durable.get(key)) : undefined};
    },
    async set(values) {
        if (failJournal) throw new Error('journal unavailable');
        for (const [key, value] of Object.entries(values)) durable.set(key, clone(value));
    },
}}};
class CustomEvent extends Event { constructor(type, options = {}) { super(type); this.detail = options.detail; } }
const context = vm.createContext({chrome, URL, URLSearchParams, FormData, Blob, EventTarget, Event, CustomEvent,
    console: {log() {}, debug() {}, info() {}, warning() {}, warn() {}, error() {}}, setTimeout, clearTimeout});
const modules = new Map();
function synthetic(name, exports) {
    const module = new vm.SyntheticModule(Object.keys(exports), function () {
        for (const [key, value] of Object.entries(exports)) this.setExport(key, value);
    }, {context, identifier: resolve(root, name)});
    modules.set(resolve(root, name), module);
}
const tableRows = new Map();
const versions = new Map();
function table(name) {
    const rows = () => tableRows.get(name) || [];
    return {
        filter(predicate) {
            const selected = rows().filter(predicate);
            return {count: async () => selected.length,
                offset: offset => ({limit: limit => ({toArray: async () => clone(selected.slice(offset, offset + limit))})})};
        },
        get: async key => versions.has(key) ? {table: key, version: versions.get(key)} : undefined,
    };
}
const db = {name: 'tofu[10]', table, open: async () => {}, close() {}};
const sourceAccount = {userId: 10, username: 'Source'};
const session = {userId: 20, username: 'Destination', cookies: {ck: 'private-test-token'}, userInfo: {id: 20}};
class FakeStorage {
    constructor() {
        this._local = this.local = db;
        this.global = {open: async () => {}, close() {}, account: {get: async () => sourceAccount}};
    }
}
class FakeJob {
    constructor() { this.tasks = []; }
    addTask(task) { this.tasks.push(task); }
    async checkin() { return clone(session); }
    toJSON() { return {tasks: this.tasks.map(task => task.toJSON())}; }
}
synthetic('storage.js', {default: FakeStorage});
synthetic('services/Job.js', {default: FakeJob});
synthetic('services/diagnostics.js', {recordDiagnostic: async () => {}});
function create(name) {
    const filename = resolve(root, name);
    if (modules.has(filename)) return modules.get(filename);
    const module = new vm.SourceTextModule(readFileSync(filename, 'utf8'), {context, identifier: filename});
    modules.set(filename, module);
    for (const specifier of module.dependencySpecifiers) create(resolve(dirname(filename), specifier));
    return module;
}
const serviceModule = create('service.js');
const deserializer = create('services/task_deserialize.js');
await serviceModule.link((specifier, referencing) => modules.get(resolve(dirname(referencing.identifier), specifier)));
await serviceModule.evaluate();
await deserializer.link((specifier, referencing) => modules.get(resolve(dirname(referencing.identifier), specifier)));
await deserializer.evaluate();
const Service = serviceModule.namespace.default;
const Task = modules.get(resolve(root, 'services/Task.js')).namespace.default;
const Draft = modules.get(resolve(root, 'vendor/draft.js')).namespace.default;
const service = new Service();
service.saveState = async () => {};
service.start = async () => {};
const logger = {info() {}, error() {}, warning() {}, debug() {}};
let cases = 0;
async function check(name, run) {
    durable.clear(); failJournal = false; tableRows.clear(); versions.clear();
    await run(); cases++; console.log(`ok ${cases} - ${name}`);
}
const fixtures = {
    follow: {table: 'following', row: {id: 1, user: {id: 99}}},
    blacklist: {table: 'blacklist', row: {id: 1, user: {id: 99}}},
    interest: {table: 'interest', row: {id: 1, type: 'book', subject: 30, status: 'done', interest: {comment: 'Original'}}},
    note: {table: 'note', row: {id: 1, note: {title: 'Note', fulltext: '<p>Original text</p>'}}},
    review: {table: 'review', row: {id: 1, subject: 30, review: {title: 'Review', fulltext: `<p>${'Original text '.repeat(15)}</p>`}}},
    annotation: {table: 'annotation', row: {id: 1, subject: 30, annotation: {fulltext: '<p>Original annotation text</p>'}}},
};
async function migration(name, fetch, {checkpoint, version = 2} = {}) {
    const fixture = fixtures[name];
    const Type = modules.get(resolve(root, `tasks/migrate/${name}.js`)).namespace.default;
    versions.set(fixture.table, version);
    tableRows.set(fixture.table, [{...clone(fixture.row), version}, {...clone(fixture.row), id: 9, version: 1}]);
    const task = new Type();
    task.init(fetch, logger, 77, clone(session), db, {id: 20}, false);
    task.checkpoint = checkpoint || {kind: 'migration-v1', sourceUserId: 10, destinationUserId: 20, sourceVersion: 2, receipts: {}};
    task.saveCheckpoint = async () => {};
    return task;
}
const ok = result => ({status: 200, json: async () => clone(result)});
await check('Draft converts real worker parser text, formatting, links, and images', async () => {
    const html = Task.parseHTML('<p>Hello <strong>world</strong><a href="https://example.org/">link</a><img src="https://img.doubanio.com/a.jpg" alt="Caption"></p><span>tail</span><script>privateScript()</script>');
    const draft = new Draft().feed(html.querySelector('body'));
    assert(draft.count() > 10);
    const content = draft.toArray();
    assert(content.blocks.map(row => row.text).join('').includes('Hello worldlink'));
    assert(!content.blocks.map(row => row.text).join('').includes('privateScript'));
    assert(content.blocks.some(row => row.inlineStyleRanges.some(range => range.style === 'BOLD')));
    assert(Object.values(content.entityMap).some(entity => entity.type === 'LINK' && entity.data.url === 'https://example.org/'));
    assert(Object.values(content.entityMap).some(entity => entity.type === 'IMAGE' && entity.data.src === 'https://img.doubanio.com/a.jpg'));
});
for (const name of Object.keys(fixtures)) {
    await check(`${name}: published snapshot only; pending precedes request; confirmed rows never replay`, async () => {
        let requests = 0;
        const task = await migration(name, async url => {
            requests++;
            const receipts = [...durable.values()][0];
            assert(Object.values(receipts).includes('pending'));
            if (url.includes('/annotation/write')) return {status: 200, text: async () => '<form id="review-editor-form"><input name="nid" value="501"></form>'};
            return ok(name === 'note' ? {id: 501} : {r: 0, result: true});
        });
        await task.run();
        assert.equal(task.total, 1, 'old snapshot rows must not be migrated');
        assert.equal(task.completion, 1);
        assert(Object.values([...durable.values()][0]).every(value => value === 'confirmed'));
        const sent = requests;
        const fresh = await migration(name, async () => { throw new Error('confirmed receipt must prevent replay'); });
        await fresh.run();
        assert.equal(fresh.completion, 1);
        assert.equal(requests, sent);
    });
}
await check('network ambiguity survives new jobs and never repeats a write', async () => {
    let requests = 0;
    const task = await migration('follow', async () => { requests++; throw new Error('connection lost'); });
    await assert.rejects(() => task.run(), /connection lost/);
    const restored = deserializer.namespace.taskFromJSON(JSON.parse(JSON.stringify(task)), null, logger, db);
    restored.init(async () => { requests++; return ok({result: true}); }, logger, 77, clone(session), db, {}, false);
    restored.saveCheckpoint = async () => {};
    await assert.rejects(() => restored.run(), /尚未确认/);
    const fresh = await migration('follow', async () => { requests++; return ok({result: true}); });
    await assert.rejects(() => fresh.run(), /尚未确认/);
    assert.equal(requests, 1);
});
await check('a newer backup version cannot bypass an older pending migration', async () => {
    let requests = 0;
    const first = await migration('follow', async () => { requests++; throw new Error('connection lost'); });
    await assert.rejects(() => first.run(), /connection lost/);
    const newer = await migration('follow', async () => { requests++; return ok({result: true}); }, {
        version: 3,
        checkpoint: {kind: 'migration-v1', sourceUserId: 10, destinationUserId: 20, sourceVersion: 3, receipts: {}},
    });
    await assert.rejects(() => newer.run(), /尚未确认/);
    assert.equal(requests, 1);
    assert(!durable.has('migrationReceipts:10:20:following:3'));
});
await check('confirmed receipts remain version scoped and unrelated pending writes do not block', async () => {
    let requests = 0;
    const send = async () => { requests++; return ok({result: true}); };
    await (await migration('follow', send)).run();
    durable.set('migrationReceipts:10:21:following:2', {99: 'pending'});
    durable.set('migrationReceipts:10:20:blacklist:2', {99: 'pending'});
    const newer = await migration('follow', send, {
        version: 3,
        checkpoint: {kind: 'migration-v1', sourceUserId: 10, destinationUserId: 20, sourceVersion: 3, receipts: {}},
    });
    await newer.run();
    assert.equal(requests, 2);
    assert.equal(newer.completion, 1);
});
for (const response of [ok({}), ok({result: false}), ok({r: 0, error: 'rejected'}),
    ok({result: true, code: 403}), ok({r: 0, result: false}),
    {status: 403}, {status: 200, json: async () => { throw new Error('HTML'); }}]) {
    await check('unconfirmed or failed API result cannot report success or replay', async () => {
        const task = await migration('follow', async () => response);
        await assert.rejects(() => task.run());
        assert.equal(task.completion, 0);
        assert(Object.values([...durable.values()][0]).every(value => value === 'pending'));
    });
}
await check('journal persistence failure sends no write', async () => {
    let sent = 0;
    const task = await migration('follow', async () => { sent++; return ok({result: true}); });
    failJournal = true;
    await assert.rejects(() => task.run(), /journal unavailable/);
    assert.equal(sent, 0);
});
await check('source version and destination identity must match preview', async () => {
    let sent = 0;
    const task = await migration('follow', async () => { sent++; return ok({result: true}); });
    task.session.userId = 21;
    await assert.rejects(() => task.run(), /账号与确认时不一致/);
    task.session.userId = 20;
    versions.set('following', 3);
    await assert.rejects(() => task.run(), /版本已改变/);
    assert.equal(sent, 0);
});
await check('preview shows concrete source, destination, counts; registration preserves binding', async () => {
    for (const [name, fixture] of Object.entries(fixtures)) await migration(name, async () => {});
    const tasks = Object.keys(fixtures).map(name => ({name: `migrate/${name}`}));
    const plan = await service.previewMigration(10, tasks);
    assert.equal(plan.sourceUserId, 10);
    assert.equal(plan.destinationUserId, 20);
    assert.equal(plan.selections.length, 6);
    assert(plan.selections.every(item => item.count === 1));
    assert(!JSON.stringify(plan).includes('private-test-token'));
    const result = await service.createJob(null, 10, tasks, false, plan);
    assert.equal(result.tasks.length, 6);
    for (const task of result.tasks) {
        assert.equal(task.checkpoint.destinationUserId, 20);
        assert.equal(task.checkpoint.sourceVersion, 2);
    }
});
await check('missing preview, mixed/offline migrations and duplicate selections rejected before queue', async () => {
    const before = service._jobQueue.length;
    await assert.rejects(() => service.createJob(null, 10, [{name: 'migrate/follow'}]), /预览/);
    await assert.rejects(() => service.createJob(null, 10, [{name: 'migrate/follow'}, {name: 'note'}]), /不能/);
    await assert.rejects(() => service.createJob(null, 10, [{name: 'migrate/follow'}], true), /不能/);
    await assert.rejects(() => service.createJob(null, null, [{name: 'note'}, {name: 'NOTE'}]), /重复/);
    assert.equal(service._jobQueue.length, before);
});
console.log(`migration regression: ${cases} cases passed; no live writes`);
