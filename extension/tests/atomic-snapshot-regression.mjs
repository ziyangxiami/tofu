// npm install --prefix extension/tests --ignore-scripts
// node --experimental-vm-modules extension/tests/atomic-snapshot-regression.mjs
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import vm from 'node:vm';
import {webcrypto} from 'node:crypto';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
let idb;
try {
    idb = process.env.TOFU_TEST_DEPS ? require(resolve(process.env.TOFU_TEST_DEPS, 'fake-indexeddb')) : require('fake-indexeddb');
} catch (error) {
    throw new Error('Missing IndexedDB test dependency. Run: npm install --prefix extension/tests --ignore-scripts', {cause: error});
}
const diagnosticValues = {};
const context = vm.createContext({console, URL, Blob, TextEncoder, TextDecoder, Event, EventTarget, Request,
    crypto: webcrypto, chrome: {storage: {local: {
        get: async key => ({[key]: diagnosticValues[key]}),
        set: async values => Object.assign(diagnosticValues, values),
    }}},
    setTimeout, clearTimeout, queueMicrotask, structuredClone,
    indexedDB: new idb.IDBFactory(), IDBKeyRange: idb.IDBKeyRange});
context.self = context;
const modules = new Map();
function create(filename) {
    if (modules.has(filename)) return modules.get(filename);
    const module = new vm.SourceTextModule(readFileSync(filename, 'utf8'), {context, identifier: filename});
    modules.set(filename, module);
    for (const specifier of module.dependencySpecifiers) create(resolve(dirname(filename), specifier));
    return module;
}
const source = create(resolve(root, 'storage.js'));
await source.link((specifier, referring) => modules.get(resolve(dirname(referring.identifier), specifier)));
await source.evaluate();
const Storage = source.namespace.default;
const copy = value => JSON.parse(JSON.stringify(value));
let cases = 0;
async function check(name, run) { await run(); cases++; console.log(`snapshot ${cases}: ${name}`); }
const storage = new Storage(101);
await storage.local.open();
const live = storage.local;
const versions = live.table('version');
await live.note.put({id: 1, version: 1, note: {fulltext: 'old note'}});
await versions.put({table: 'note', version: 1});

await check('page failure and worker interruption leave the published snapshot intact', async () => {
    const partial = await storage.createTaskSnapshot(2, 'Note');
    assert.equal(partial.fresh, true);
    await partial.database.note.put({id: 1, version: 2, note: {fulltext: 'new note'}});
    await partial.database.note.put({id: 2, version: 2, note: {fulltext: 'new row'}});
    assert.equal((await live.note.get(1)).note.fulltext, 'old note');
    assert.equal(await live.note.get(2), undefined);
    assert.equal((await versions.get('note')).version, 1);
    partial.database.close(); // Simulate worker death before completing the task.
    const resumed = await storage.createTaskSnapshot(2, 'Note');
    assert.equal(resumed.fresh, false);
    assert.equal((await resumed.database.note.get(2)).note.fulltext, 'new row');
    await resumed.database.table('version').put({table: 'note', version: 2});
    await resumed.commit({outcome: 'completed', completion: 2, total: 2});
    await resumed.close();
    assert.equal((await live.note.get(1)).note.fulltext, 'new note');
    assert.equal((await versions.get('note')).version, 2);
});

await check('committed receipt survives missing worker completion state', async () => {
    const recovered = await storage.createTaskSnapshot(2, 'Note');
    assert.equal(recovered.published, true);
    assert.equal(recovered.result.completion, 2);
    await recovered.close();
});

await check('related parent and child tables and version roll back on a failed commit', async () => {
    await live.album.put({id: 10, version: 1, album: {title: 'old album'}});
    await live.photo.put({id: 20, album: 10, version: 1, photo: {description: 'old photo'}});
    await versions.put({table: 'photo', version: 1});
    const stage = await storage.createTaskSnapshot(3, 'Photo');
    await stage.database.album.put({id: 10, version: 3, album: {title: 'new album'}});
    await stage.database.photo.put({id: 20, album: 10, version: 3, photo: {description: 'new photo'}});
    await stage.database.table('version').put({table: 'photo', version: 3});
    const fail = () => { throw new Error('simulated quota failure after parent replacement'); };
    live.photo.hook('creating', fail);
    await assert.rejects(() => stage.commit({outcome: 'completed'}), /simulated quota failure/);
    live.photo.hook('creating').unsubscribe(fail);
    assert.equal((await live.album.get(10)).album.title, 'old album');
    assert.equal((await live.photo.get(20)).photo.description, 'old photo');
    assert.equal((await versions.get('photo')).version, 1);
    assert.equal(await versions.get('__snapshot_commit:Photo'), undefined);
    await stage.commit({outcome: 'completed'});
    await stage.close();
    assert.equal((await live.album.get(10)).album.title, 'new album');
    assert.equal((await live.photo.get(20)).photo.description, 'new photo');
    assert.equal((await versions.get('photo')).version, 3);
});

await check('aborted staging initialization is re-created from the published baseline', async () => {
    const original = storage.getNamedLocalDb.bind(storage);
    storage.getNamedLocalDb = name => {
        const db = original(name);
        db.note.hook('creating', () => { throw new Error('initial copy interrupted'); });
        return db;
    };
    await assert.rejects(() => storage.createTaskSnapshot(4, 'Note'), /initial copy interrupted/);
    storage.getNamedLocalDb = original;
    const retried = await storage.createTaskSnapshot(4, 'Note');
    assert.equal(retried.fresh, true, 'a stale page checkpoint must be reset with a fresh baseline');
    assert.deepEqual(copy(await retried.database.note.toArray()), copy(await live.note.toArray()));
    await retried.close();
});

await check('concurrent tasks publish only their own version keys', async () => {
    const note = await storage.createTaskSnapshot(5, 'Note');
    const review = await storage.createTaskSnapshot(5, 'Review');
    await note.database.table('version').put({table: 'note', version: 5});
    await review.database.review.put({id: 30, version: 5, type: 'book', review: {fulltext: 'review'}});
    await review.database.table('version').put({table: 'review', version: 5});
    await Promise.all([note.commit({outcome: 'completed'}), review.commit({outcome: 'completed'})]);
    await Promise.all([note.close(), review.close()]);
    assert.equal((await versions.get('note')).version, 5);
    assert.equal((await versions.get('review')).version, 5);
    assert.equal((await versions.get('photo')).version, 3);
});

await check('incremental broadcast cursor is isolated until its task completes', async () => {
    await live.status.add({id: 100, status: {text: 'published'}});
    await versions.put({table: 'status', version: 1, lastId: '100'});
    const stage = await storage.createTaskSnapshot(6, 'Status');
    await stage.database.status.add({id: 200, status: {text: 'new'}});
    await stage.database.table('version').put({table: 'status', version: 6, lastId: '200'});
    await stage.close();
    assert.equal(await live.status.get(200), undefined);
    assert.equal((await versions.get('status')).lastId, '100');
    const resume = await storage.createTaskSnapshot(6, 'Status');
    assert.equal((await resume.database.table('version').get('status')).lastId, '200');
    await resume.commit({outcome: 'completed'});
    await resume.close();
    assert.equal((await live.status.get(200)).status.text, 'new');
});

await check('cache and migrations retain access to already published data', async () => {
    assert.equal(await storage.createTaskSnapshot(7, 'Files'), null);
    assert.equal(await storage.createTaskSnapshot(7, 'MigrateNote'), null);
});

const Dexie = modules.get(resolve(root, 'vendor/dexie.js')).namespace.default;
await check('successful publication cleans orphan stages only for its account and task', async () => {
    const orphan = await storage.createTaskSnapshot(99, 'Note');
    await orphan.close();
    const unrelated = await storage.createTaskSnapshot(99, 'Review');
    await unrelated.close();
    const other = new Storage(202);
    await other.local.open();
    const otherStage = await other.createTaskSnapshot(99, 'Note');
    await otherStage.close();
    other.local.close();
    const done = await storage.createTaskSnapshot(100, 'Note');
    await done.commit({outcome: 'completed'});
    await done.close();
    const names = await Dexie.getDatabaseNames();
    assert(!names.includes('tofu-stage[101:99:Note]'));
    assert(!names.includes('tofu-stage[101:100:Note]'));
    assert(names.includes('tofu-stage[101:99:Review]'));
    assert(names.includes('tofu-stage[202:99:Note]'));
});

await check('cleanup errors do not invalidate a committed snapshot', async () => {
    const stage = await storage.createTaskSnapshot(101, 'Note');
    const remove = storage.deleteTaskStages;
    storage.deleteTaskStages = async () => { throw new Error('cleanup unavailable'); };
    await stage.commit({outcome: 'completed'});
    await stage.close();
    storage.deleteTaskStages = remove;
    const result = await storage.createTaskSnapshot(101, 'Note');
    assert.equal(result.published, true);
    await result.close();
});

await check('Job uses staging on task failure and restores committed receipts without requests', async () => {
    const jobModule = create(resolve(root, 'services/Job.js'));
    await jobModule.link((specifier, referring) => modules.get(resolve(dirname(referring.identifier), specifier)));
    await jobModule.evaluate();
    const Job = jobModule.namespace.default;
    const Note = modules.get(resolve(root, 'tasks/note.js')).namespace.default;
    await live.note.put({id: 501, version: 101, note: {fulltext: 'published old body', update_time: 'old'}});
    await versions.put({table: 'note', version: 101});
    await storage.global.open();
    await storage.global.account.put({userId: 101, updated: 1234});
    storage.global.close();
    const logger = {debug() {}, error() {}, warning() {}};
    const service = {logger, saveState: async () => {}, continue: async () => {}, dispatchEvent() {}, requestInterval: 0};
    const job = new Job(service);
    job._id = 102;
    job.checkin = async () => job._session = {userId: 101, cookies: {}, userInfo: {id: 101}};
    job.addTask(new Note());
    let failSecondPage = true;
    let requests = 0;
    context.fetch = async url => {
        requests++;
        if (url.includes('start=50') && failSecondPage) return {status: 503};
        if (url.includes('/notes?')) return {status: 200, json: async () => ({total: failSecondPage ? 51 : 1,
            notes: [{id: 501, url: 'https://www.douban.com/note/501/', update_time: 'new'}]})};
        return {status: 200, text: async () => '<div id="link-report">replacement body</div>'};
    };
    await job.run();
    assert.equal(job._failedTasks.length, 1);
    assert.equal(job._completedTaskTypes.length, 0);
    await storage.global.open();
    assert.equal((await storage.global.account.get(101)).updated, 1234, 'failed task must retain the old completion time');
    storage.global.close();
    await live.open();
    assert.equal((await live.note.get(501)).note.fulltext, 'published old body');
    failSecondPage = false;
    await job.run();
    assert.equal(job._failedTasks.length, 0);
    assert(job._completedTaskTypes.includes('Note'));
    await storage.global.open();
    const completedAt = (await storage.global.account.get(101)).updated;
    assert(completedAt > 1234, 'only published data advances completion time');
    storage.global.close();
    await live.open();
    assert.match((await live.note.get(501)).note.fulltext, /replacement body/);
    job._completedTaskTypes = []; // Worker died after DB commit but before saveState.
    requests = 0;
    await job.run();
    assert.equal(requests, 0);
    assert(job._completedTaskTypes.includes('Note'));
    await storage.global.open();
    assert.equal((await storage.global.account.get(101)).updated, completedAt, 'receipt recovery retains the actual commit time');
    storage.global.close();
    await live.open();
});

await check('first failed backup has no timestamp and migration creates no destination backup card', async () => {
    const Job = modules.get(resolve(root, 'services/Job.js')).namespace.default;
    const Note = modules.get(resolve(root, 'tasks/note.js')).namespace.default;
    const service = {logger: {debug() {}, error() {}, warning() {}}, saveState: async () => {},
        continue: async () => {}, dispatchEvent() {}, requestInterval: 0};
    const failed = new Job(service);
    failed._id = 104;
    failed.checkin = async () => failed._session = {userId: 303, cookies: {}, userInfo: {id: 303}};
    failed.addTask(new Note());
    context.fetch = async () => ({status: 503});
    await failed.run();
    assert.equal(failed._failedTasks.length, 1);
    await storage.global.open();
    assert.equal((await storage.global.account.get(303)).updated, null);
    const sourceTime = (await storage.global.account.get(101)).updated;
    storage.global.close();
    class MigrationProbe {
        isMigration = true;
        name = 'offline migration probe';
        init(fetch, logger, jobId, session, database) { this.storage = database; this.completion = 0; this.total = 1; }
        async run() { assert.equal(this.storage.name, 'tofu[101]'); this.completion = 1; }
    }
    const migration = new Job(service, null, 101);
    migration._id = 105;
    migration.checkin = async () => migration._session = {userId: 404, cookies: {}, userInfo: {id: 404}};
    migration.addTask(new MigrationProbe());
    await migration.run();
    assert.equal(migration._failedTasks.length, 0);
    await storage.global.open();
    assert.equal(await storage.global.account.get(404), undefined);
    assert.equal((await storage.global.account.get(101)).updated, sourceTime);
    storage.global.close();
    await live.open();
});

await check('a new unfinished account renders a clear placeholder instead of the Unix epoch', async () => {
    const backup = readFileSync(resolve(root, 'backup.js'), 'utf8');
    const classSource = backup.slice(backup.indexOf('const ACCOUNT_TEMPLATE'), backup.indexOf('class TaskModal'));
    const displayed = new Map();
    const account = {userId: 303, userInfo: {}, updated: null};
    const element = {find: selector => ({text: value => displayed.set(selector, value), attr() {}}),
        data() {}, appendTo() {}};
    const view = vm.createContext({document: {querySelector: () => ({})}, $: () => element,
        Storage: class { global = {open: async () => {}, close() {}, account: {toArray: async () => [account]}}; }});
    const AccountList = new vm.Script(classSource + '\nAccountList').runInContext(view);
    await new AccountList('#accounts').load();
    assert.equal(displayed.get('.backup-time'), '尚未完成备份');
});

await check('a second worker death before checkpoint reset persistence cannot revive a stale page cursor', async () => {
    const Job = modules.get(resolve(root, 'services/Job.js')).namespace.default;
    const logger = {debug() {}, error() {}, warning() {}};
    let rejectSave = true;
    let savedCheckpoint = {nextURL: 'https://book.douban.com/people/101/annotation/?start=10'};
    let currentTask;
    const service = {logger, saveState: async () => {
        if (rejectSave) throw new Error('worker terminated before persisting checkpoint reset');
        savedCheckpoint = copy(currentTask.checkpoint);
    }};
    class Annotation {
        constructor() {
            this.name = '读书笔记'; this.checkpoint = copy(savedCheckpoint);
            this.storage = live; this.completion = 0; this.total = 1;
            this.createSnapshot = () => storage.createTaskSnapshot(103, 'Annotation');
        }
        async run() {
            assert.equal(this.checkpoint, null, 'a stale page-2 checkpoint must never skip page 1');
            await this.storage.annotation.put({id: 900, version: 103, annotation: {fulltext: 'page one'}});
            await this.storage.table('version').put({table: 'annotation', version: 103});
            this.completion = 1;
        }
    }
    const interrupted = new Job(service);
    interrupted._failedTasks = [];
    currentTask = new Annotation();
    await interrupted.runSingleTask(currentTask, logger);
    assert.equal(interrupted._failedTasks.length, 1);
    assert(savedCheckpoint.nextURL.endsWith('start=10'));
    assert.equal(await live.annotation.get(900), undefined);
    const pendingReset = await storage.createTaskSnapshot(103, 'Annotation');
    assert.equal(pendingReset.fresh, false, 'baseline was already atomically initialized');
    assert.equal(pendingReset.resetCheckpointRequired, true, 'reset must survive that worker death');
    await pendingReset.close();
    rejectSave = false;
    const recovered = new Job(service);
    recovered._failedTasks = [];
    currentTask = new Annotation();
    await recovered.runSingleTask(currentTask, logger);
    assert.equal(recovered._failedTasks.length, 0);
    assert.equal(savedCheckpoint, null);
    assert.equal((await live.annotation.get(900)).annotation.fulltext, 'page one');
});

await check('account deletion removes all its private stage databases and preserves other accounts', async () => {
    await storage.global.open();
    await storage.global.account.put({userId: 101});
    live.close();
    assert.equal(await storage.drop(101), true);
    const names = await Dexie.getDatabaseNames();
    assert(!names.some(name => name.startsWith('tofu-stage[101:')));
    assert(!names.includes('tofu[101]'));
    assert(names.includes('tofu-stage[202:99:Note]'));
    storage.global.close();
});
live.close();
console.log(`atomic snapshot regression: ${cases} cases passed with real Dexie + fake-indexeddb transactions`);
