// node --experimental-vm-modules extension/tests/interest-completeness-regression.mjs
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {webcrypto} from 'node:crypto';
import vm from 'node:vm';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const idb = process.env.TOFU_TEST_DEPS ? require(resolve(process.env.TOFU_TEST_DEPS, 'fake-indexeddb')) : require('fake-indexeddb');
const diagnosticValues = {};
const context = vm.createContext({console, URL, Blob, TextEncoder, TextDecoder, Event, EventTarget, Request,
    crypto: webcrypto, setTimeout, clearTimeout, queueMicrotask, structuredClone,
    indexedDB: new idb.IDBFactory(), IDBKeyRange: idb.IDBKeyRange,
    location: {search: '?101'}, chrome: {runtime: {getManifest: () => ({version: 'test'})}, storage: {local: {
        get: async key => ({[key]: diagnosticValues[key]}),
        set: async values => Object.assign(diagnosticValues, values),
    }}},
});
context.self = context;
const modules = new Map();
function create(filename) {
    if (modules.has(filename)) return modules.get(filename);
    const module = new vm.SourceTextModule(readFileSync(filename, 'utf8'), {context, identifier: filename});
    modules.set(filename, module);
    for (const specifier of module.dependencySpecifiers) create(resolve(dirname(filename), specifier));
    return module;
}
async function load(path) {
    const module = create(resolve(root, path));
    if (module.status === 'unlinked') {
        await module.link((specifier, referring) => modules.get(resolve(dirname(referring.identifier), specifier)));
    }
    if (module.status !== 'evaluated') await module.evaluate();
    return module.namespace;
}
const {default: Interest} = await load('tasks/interest.js');
const {default: Storage} = await load('storage.js');
const {default: Exporter} = await load('exporter.js');
const {recordDiagnostic, getDiagnosticReport} = await load('services/diagnostics.js');
vm.runInContext(readFileSync(resolve(root, 'vendor/xlsx.full.min.js'), 'utf8'), context);

let checks = 0;
let largeDiagnostics;
async function check(name, run) { await run(); checks++; console.log(`interest ${checks}: ${name}`); }
const copy = value => JSON.parse(JSON.stringify(value));
function interest(index, status = 'done') {
    return {id: 5000000 + index, status, comment: '', tags: [], rating: {value: 4},
        create_time: '2026-11-12 12:00:00',
        subject: {id: String(1000000 + index), title: `Movie ${index}`,
            url: `https://movie.douban.com/subject/${1000000 + index}/`, rating: {value: 8.2}},
    };
}
function row(index, version = 1) {
    const value = interest(index);
    return {id: value.id, subject: Number(value.subject.id), type: 'movie', status: 'done', version, interest: value};
}
function json(value, status = 200) { return {status, json: async () => copy(value)}; }
function webpage(total, start, {duplicate = false, short = false, declaredTotal = total} = {}) {
    const last = Math.min(start + 15, total);
    const items = Array.from({length: last - start - (short ? 1 : 0)}, (_, offset) => {
        const index = (duplicate && start ? 0 : start) + offset + 1;
        return `<div class="item comment-item" data-cid="${5000000 + index}">
            <div class="pic"><img src="https://img.example/cover.jpg"></div>
            <div class="info"><ul><li class="title"><a href="https://movie.douban.com/subject/${1000000 + index}/"><em>Movie ${index}</em></a></li>
            <li class="intro">Movie details</li><li><span class="rating4-t"></span><span class="date">2026-11-12</span></li>
            <li><span class="tags">标签: 电影 纪录片</span></li><li><span class="comment">Comment ${index}</span></li></ul></div></div>`;
    }).join('');
    return `<span class="subject-num">${start + 1}-${last}&nbsp;/&nbsp;${declaredTotal}</span>
        <div class="grid-view">${items}</div><div class="paginator"><span class="thispage" data-total-page="${Math.ceil(total / 15)}">${Math.floor(start / 15) + 1}</span></div>`;
}
function fixture(total, {cap = 50, clamped = false, sparse = false, webError = false, webOptions = {}, type = 'movie'} = {}) {
    const calls = [];
    const fetch = async resource => {
        const url = new URL(resource);
        calls.push(url);
        const start = Number(url.searchParams.get('start'));
        if (url.hostname === 'movie.douban.com') return {status: webError ? 403 : 200,
            text: async () => webpage(total, start, webOptions)};
        assert(!url.searchParams.has('for_mobile'), 'interest requests must not force mobile-only filtering');
        if (!url.searchParams.has('type')) return json({total});
        if (url.searchParams.get('type') !== type || url.searchParams.get('status') !== 'done') {
            return json({start, count: 0, total: 0, interests: []});
        }
        const count = Math.min(cap, Number(url.searchParams.get('count')));
        let rows = Array.from({length: Math.min(count, total - start)}, (_, offset) => interest(start + offset + 1));
        if (clamped && start >= 1100) rows = [interest(1101)];
        if (sparse) rows = rows.filter((_, index) => index % 2 === 0);
        return json({start, count, total, interests: rows});
    };
    return {fetch, calls};
}
async function setup(fetch) {
    const storage = new Storage(101 + checks);
    await storage.local.open();
    const warnings = [];
    const task = new Interest();
    task.init(fetch, {warning: message => warnings.push(message)}, 2,
        {cookies: {ck: 'PRIVATE_COOKIE'}}, storage.local, {id: 101, uid: 'test-account'}, true);
    task.diagnosticRunId = `interest-check-${checks}`;
    return {storage, task, warnings};
}

await check('7085 advertised / 1101 unique API records: publish and round-trip all 7085 Excel rows', async () => {
    const source = fixture(7085, {clamped: true});
    const {storage, task, warnings} = await setup(source.fetch);
    await storage.local.interest.bulkAdd(Array.from({length: 1101}, (_, index) => row(index + 1)));
    await storage.local.table('version').put({table: 'interest', version: 1});
    const snapshot = await storage.createTaskSnapshot(2, 'Interest');
    task.storage = snapshot.database;
    await task.run();
    assert.equal(task.completion, 7085);
    assert.equal(task.total, 7085);
    assert.equal(await storage.local.interest.count(), 1101, 'unverified data stays private until publication');
    await snapshot.commit({outcome: 'completed', completion: task.completion, total: task.total});
    await snapshot.close();
    assert.equal(await storage.local.interest.count(), 7085);
    assert.equal((await storage.local.table('version').get('interest')).version, 2);
    assert.equal(warnings.length, 1);
    assert.equal(source.calls.filter(url => url.hostname === 'movie.douban.com').length, 473);
    assert.equal((await storage.local.interest.get(5000001)).interest.subject.rating.value, 8.2,
        'the fallback must retain the richer API metadata');
    const restored = await storage.local.interest.get(5007085);
    assert.equal(restored.interest.comment, 'Comment 7085');
    assert.deepEqual(copy(restored.interest.tags), ['电影', '纪录片']);
    assert.equal(restored.interest.rating.value, 4);
    const exporter = new Exporter();
    await exporter.exportInterest(storage);
    const XLSX = context.XLSX;
    const bytes = XLSX.write(exporter.workbook, {bookType: 'xlsx', type: 'array'});
    const workbook = XLSX.read(bytes, {type: 'array'});
    const records = XLSX.utils.sheet_to_json(workbook.Sheets['看过'], {header: 1});
    assert.equal(records.length, 7086, 'one header plus every saved record');
    assert.equal(new Set(records.slice(1).map(record => record[3])).size, 7085);
    assert.equal(records[1][0], 'Movie 7085');
    assert.equal(records.at(-1)[0], 'Movie 1');
    largeDiagnostics = copy((await getDiagnosticReport()).entries);
    storage.local.close();
});

await check('server count capped at 7 advances by 7 and exports every record without a web fallback', async () => {
    const source = fixture(123, {cap: 7});
    const {storage, task, warnings} = await setup(source.fetch);
    await task.run();
    assert.equal(await storage.local.interest.count(), 123);
    assert.equal(task.completion, 123);
    assert.equal(task.total, 123);
    const starts = source.calls.filter(url => url.searchParams.get('type') === 'movie' && url.searchParams.get('status') === 'done')
        .map(url => Number(url.searchParams.get('start')));
    assert.deepEqual(starts, Array.from({length: 18}, (_, index) => index * 7));
    assert.equal(warnings.length, 0);
    storage.local.close();
});

await check('sparse HTTP 200 pages are supplemented without overwriting API comments and ratings', async () => {
    const source = fixture(55, {sparse: true});
    const {storage, task} = await setup(source.fetch);
    await task.run();
    assert.equal(await storage.local.interest.count(), 55);
    assert.equal(task.completion, 55);
    assert.equal((await storage.local.interest.get(5000001)).interest.comment, '');
    assert.equal((await storage.local.interest.get(5000002)).interest.comment, 'Comment 2');
    storage.local.close();
});

for (const [name, options, pattern] of [
    ['a blocked fallback', {webError: true}, /公开页面读取失败/],
    ['a truncated public page', {webOptions: {short: true}}, /数量或分页不完整/],
    ['a repeated public page', {webOptions: {duplicate: true}}, /无效或重复条目/],
    ['a changed public total', {webOptions: {declaredTotal: 54}}, /数量或分页不完整/],
    ['missing records in another category', {type: 'book'}, /部分书影音标记获取失败/],
]) {
    await check(`${name} fails with actual progress and retains the published snapshot`, async () => {
        const source = fixture(55, {sparse: true, ...options});
        const {storage, task} = await setup(source.fetch);
        await storage.local.interest.put(row(1));
        await storage.local.table('version').put({table: 'interest', version: 1});
        const snapshot = await storage.createTaskSnapshot(2, 'Interest');
        task.storage = snapshot.database;
        await assert.rejects(() => task.run(), pattern);
        assert(task.completion < task.total, 'failure must not turn the expected total into saved progress');
        assert.equal(await storage.local.interest.count(), 1);
        assert.equal((await storage.local.table('version').get('interest')).version, 1);
        assert.equal((await snapshot.database.table('version').get('interest')).version, 1);
        assert.equal(await storage.local.table('version').get('__snapshot_commit:Interest'), undefined);
        await snapshot.close();
        storage.local.close();
    });
}

for (const [name, change] of [
    ['wrong response offset', data => { data.start++; }],
    ['invalid response count', data => { data.count = 0; }],
    ['changing API total', data => { if (data.start) data.total++; }],
    ['one interest ID reused for another subject', data => { data.interests[1].id = data.interests[0].id; }],
    ['one subject reused by another interest ID', data => { data.interests[1].subject.id = data.interests[0].subject.id; }],
    ['wrong interest status', data => { data.interests[0].status = 'mark'; }],
]) {
    await check(`${name} cannot publish`, async () => {
        const source = fixture(55);
        const {storage, task} = await setup(async url => {
            const response = await source.fetch(url);
            const data = await response.json();
            if (data.interests?.length) change(data);
            return json(data);
        });
        await assert.rejects(() => task.run(), /分页位置错误|总数发生变化|不一致/);
        assert.equal(await storage.local.table('version').get('interest'), undefined);
        storage.local.close();
    });
}

await check('an advertised zero still checks every category and finishes with zero real records', async () => {
    const source = fixture(0);
    const {storage, task} = await setup(source.fetch);
    await task.run();
    assert.equal(task.completion, 0);
    assert.equal(task.total, 0);
    assert.equal(source.calls.length, 16);
    assert.equal((await storage.local.table('version').get('interest')).version, 2);
    storage.local.close();
});

await check('per-category diagnostics expose missing counts without account data, cookies or URLs', async () => {
    await recordDiagnostic('interest-privacy', 'interest.segment', {
        subjectType: 'https://PRIVATE_URL', interestStatus: 'PRIVATE_COOKIE', count: 1, total: 5,
        userId: 1234567, url: 'https://PRIVATE_URL', cookie: 'PRIVATE_COOKIE', comment: 'PRIVATE_COMMENT',
    });
    const report = await getDiagnosticReport();
    const shortage = largeDiagnostics.find(entry => entry.event === 'interest.segment' && entry.total === 7085);
    assert.equal(shortage.count, 1101);
    assert.equal(shortage.subjectType, 'movie');
    assert.equal(shortage.interestStatus, 'done');
    assert(largeDiagnostics.some(entry => entry.event === 'interest.verified' && entry.count === 7085));
    const encoded = JSON.stringify(report);
    assert(!encoded.includes('PRIVATE_'));
    assert(!encoded.includes('test-account'));
    assert(!encoded.includes('1234567'));
});

console.log(`interest completeness regression: ${checks} cases passed with real Dexie, parser and Excel round-trip`);
