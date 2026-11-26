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
function webpage(total, start, {duplicate = false, short = false, declaredTotal = total, type = 'movie', dropPaginator = false} = {}) {
    const last = Math.min(start + 15, total);
    const dropped = typeof short === 'number' ? short : (short ? 1 : 0);
    const count = Math.max(0, last - start - dropped);
    const items = Array.from({length: count}, (_, offset) => {
        const index = (duplicate && start ? 0 : start) + offset + 1;
        const cid = 5000000 + index;
        const sid = 1000000 + index;
        if (type === 'book') {
            return `<li class="subject-item"><div class="pic"><a class="nbg" href="https://book.douban.com/subject/${sid}/"><img src="https://img.example/cover.jpg"></a></div>
                <div class="info"><h2><a href="https://book.douban.com/subject/${sid}/" title="Book ${index}">Book ${index}</a></h2>
                <div class="pub">Book details</div><div class="short-note"><div><span class="rating4-t"></span>
                <span class="date">2026-11-12 读过</span></div><p class="comment comment-item" data-cid="${cid}">Comment ${index}</p></div></div></li>`;
        }
        return `<div class="item comment-item" data-cid="${cid}">
            <div class="pic"><img src="https://img.example/cover.jpg"></div>
            <div class="info"><ul><li class="title"><a href="https://${type}.douban.com/subject/${sid}/"><em>${type === 'movie' ? 'Movie' : 'Music'} ${index}</em></a></li>
            <li class="intro">Details</li><li><span class="rating4-t"></span><span class="date">2026-11-12</span></li>
            <li><span class="tags">标签: 电影 纪录片</span></li><li><span class="comment">Comment ${index}</span></li></ul></div></div>`;
    }).join('');
    const list = type === 'book' ? `<ul class="interest-list">${items}</ul>` : `<div class="grid-view">${items}</div>`;
    const paginator = dropPaginator ? '' :
        `<div class="paginator"><span class="thispage" data-total-page="${Math.ceil(total / 15)}">${Math.floor(start / 15) + 1}</span></div>`;
    return `<span class="subject-num">${start + 1}-${last}&nbsp;/&nbsp;${declaredTotal}</span>${list}${paginator}`;
}
function fixture(total, {cap = 50, clamped = false, sparse = false, dropEachPage = 0, webError = false, webOptions = {}, type = 'movie', status = 'done'} = {}) {
    const calls = [];
    const fetch = async resource => {
        const url = new URL(resource);
        calls.push(url);
        const start = Number(url.searchParams.get('start'));
        if (url.hostname !== 'm.douban.com') return {status: webError ? 403 : 200,
            text: async () => webpage(total, start, {type, ...webOptions})};
        assert(!url.searchParams.has('for_mobile'), 'interest requests must not force mobile-only filtering');
        if (!url.searchParams.has('type')) return json({total});
        if (url.searchParams.get('type') !== type || url.searchParams.get('status') !== status) {
            return json({start, count: 0, total: 0, interests: []});
        }
        const count = Math.min(cap, Number(url.searchParams.get('count')));
        let rows = Array.from({length: Math.min(count, total - start)}, (_, offset) => ({...interest(start + offset + 1, status), subject: {...interest(start + offset + 1, status).subject, type}}));
        if (clamped && start >= 1100) rows = [{...interest(1101, status), subject: {...interest(1101, status).subject, type}}];
        if (sparse) rows = rows.filter((_, index) => index % 2 === 0);
        if (dropEachPage > 0) rows = rows.slice(0, Math.max(0, rows.length - dropEachPage));
        return json({start, count, total, interests: rows});
    };
    return {fetch, calls};
}
let setupSeq = 0;
async function setup(fetch) {
    const seq = setupSeq++;
    const storage = new Storage(101 + seq);
    await storage.local.open();
    const warnings = [];
    const task = new Interest();
    task.init(fetch, {warning: message => warnings.push(message)}, 2,
        {cookies: {ck: 'PRIVATE_COOKIE'}}, storage.local, {id: 101, uid: 'test-account'}, true);
    task.diagnosticRunId = `interest-check-${seq}`;
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
    ['a truncated multi-page fallback missing paginator', {webOptions: {dropPaginator: true}}, /分页不完整/],
    ['a repeated public page', {webOptions: {duplicate: true}}, /无效或重复条目/],
    ['a changed public total', {webOptions: {declaredTotal: 54}}, /数量或分页不完整/],
    ['missing records in unverified game category after 500 failure', {type: 'game', sparse: true}, /部分书影音标记获取失败/],
]) {
    await check(`${name} fails with actual progress and retains the published snapshot`, async () => {
        const source = fixture(55, {sparse: true, ...options});
        const {storage, task} = await setup(async url => {
            if (options.type === 'game' && url.includes('type=game') && url.includes('count=50')) return {status: 500, json: async () => ({})};
            if (options.type === 'game' && url.includes('type=game') && url.includes('count=1') && url.includes('start=1')) return {status: 500, json: async () => ({})};
            return source.fetch(url);
        });
        await storage.local.interest.put(row(1));
        await storage.local.table('version').put({table: 'interest', version: 1});
        const snapshot = await storage.createTaskSnapshot(2, 'Interest');
        task.storage = snapshot.database;
        await assert.rejects(() => task.run(), pattern);
        assert(task.completion < task.total || task.total === 0, 'failure must not turn the expected total into saved progress');
        assert.equal(await storage.local.interest.count(), 1);
        assert.equal((await storage.local.table('version').get('interest')).version, 1);
        assert.equal((await snapshot.database.table('version').get('interest')).version, 1);
        assert.equal(await storage.local.table('version').get('__snapshot_commit:Interest'), undefined);
        await snapshot.close();
        storage.local.close();
    });
}

for (const [type, status, total, drop] of [['music', 'done', 40, 2], ['book', 'doing', 33, 2]]) {
    await check(`film101-style ${type}/${status} verified unavailable gap supplements and publishes cleanly`, async () => {
        const source = fixture(total, {type, status, dropEachPage: 0});
        const {storage, task, warnings} = await setup(async url => {
            const parsed = new URL(url);
            const start = Number(parsed.searchParams.get('start') || 0);
            if (parsed.hostname !== 'm.douban.com') {
                return {status: 200, text: async () => webpage(total, start, {type, short: start === 0 ? drop : 0})};
            }
            const res = await source.fetch(url);
            const data = await res.json();
            if (Array.isArray(data.interests) && start === 0 && data.interests.length > drop) {
                const droppedIds = new Set(Array.from({length: drop}, (_, i) => 5000000 + 15 - i));
                data.interests = data.interests.filter(item => !droppedIds.has(item.id));
            }
            return json(data);
        });
        await task.run();
        const expectedSaved = total - drop;
        assert.equal(task.completion, expectedSaved);
        assert.equal(task.total, expectedSaved);
        assert.equal(await storage.local.interest.count(), expectedSaved);
        assert.equal((await storage.local.table('version').get('interest')).version, 2);
        assert(warnings.some(w => w.includes('不可见或下架')));
        const entries = (await getDiagnosticReport()).entries;
        assert(entries.some(e => e.event === 'interest.verified' && e.subjectType === type && e.interestStatus === status && e.unavailable === drop));
        storage.local.close();
    });
}

await check('transient short HTTP 200 API page recovers on single retry without web fallback', async () => {
    let bookDoneReads = 0;
    const source = fixture(30, {type: 'book', status: 'done'});
    const {storage, task} = await setup(async url => {
        if (url.includes('type=book') && url.includes('status=done') && url.includes('start=0')) {
            bookDoneReads++;
            if (bookDoneReads === 1) {
                return json({start: 0, count: 50, total: 30, interests: [interest(1, 'done')]});
            }
        }
        return source.fetch(url);
    });
    await task.run();
    assert.equal(bookDoneReads, 2);
    assert.equal(task.completion, 30);
    assert(!source.calls.some(u => u.hostname === 'book.douban.com'));
    storage.local.close();
});

await check('segment failure does not abort remaining categories and reports all failed segments', async () => {
    const visited = new Set();
    const {storage, task} = await setup(async url => {
        const parsed = new URL(url);
        if (parsed.hostname === 'music.douban.com') return {status: 502, text: async () => ''};
        const type = parsed.searchParams.get('type');
        const status = parsed.searchParams.get('status');
        if (type) visited.add(`${type}/${status}`);
        if (type === 'music' && status === 'done') {
            return json({start: 0, count: 50, total: 20, interests: [interest(1, 'done')]});
        }
        if (type === 'book' && status === 'done') {
            return json({start: 0, count: 50, total: 1, interests: [{...interest(2, 'done'), subject: {...interest(2, 'done').subject, type: 'book'}}]});
        }
        if (type === 'movie' && status === 'done') {
            return json({start: 0, count: 50, total: 1, interests: [{...interest(3, 'done'), subject: {...interest(3, 'done').subject, type: 'tv'}}]});
        }
        return json({start: 0, count: 50, total: 0, interests: []});
    });
    await assert.rejects(() => task.run(), /music\/done/);
    assert(visited.has('book/done'));
    assert(visited.has('movie/done'));
    assert(visited.has('drama/done'));
    assert.equal(await storage.local.table('version').get('interest'), undefined);
    storage.local.close();
});

await check('subject type validation rejects cross-type pollution while allowing tv under movie; is_private diff updates row', async () => {
    const {storage, task} = await setup(async url => {
        const parsed = new URL(url);
        if (!parsed.searchParams.has('type')) return json({total: 1});
        if (parsed.searchParams.get('type') === 'book' && parsed.searchParams.get('status') === 'done') {
            return json({start: 0, count: 50, total: 1, interests: [{...interest(1, 'done'), subject: {...interest(1, 'done').subject, type: 'movie'}}]});
        }
        return json({start: 0, count: 50, total: 0, interests: []});
    });
    await assert.rejects(() => task.run(), /类型不符/);
    const a = {...interest(10, 'done'), is_private: false};
    const b = {...interest(10, 'done'), is_private: true};
    assert.equal(task.compareInterest(a, b), false);
    storage.local.close();
});

await check('500 slice recovery stops immediately on 403 and overview>0 with all-zero segments fails', async () => {
    let sliceCalls = 0;
    const {storage, task} = await setup(async url => {
        const parsed = new URL(url);
        if (!parsed.searchParams.has('type')) return json({total: 10});
        if (parsed.searchParams.get('type') === 'game' && parsed.searchParams.get('status') === 'mark') {
            if (parsed.searchParams.get('count') === '50') return {status: 500, json: async () => ({})};
            sliceCalls++;
            return {status: 403, json: async () => ({})};
        }
        return json({start: 0, count: 50, total: 0, interests: []});
    });
    await assert.rejects(() => task.run(), /403/);
    assert.equal(sliceCalls, 1, '403 must stop 500 single-slice loop immediately');
    storage.local.close();

    const zero = await setup(async url => new URL(url).searchParams.has('type') ?
        json({start: 0, count: 50, total: 0, interests: []}) : json({total: 5}));
    await assert.rejects(() => zero.task.run(), /各分类均返回 0/);
    zero.storage.local.close();
});

await check('empty web pages (1/60), game duplicate pages (50/60), and overview-failure + all-zero with prior backup all fail', async () => {
    // 1. Music public web returns 1 item on page 1 and 0 items on pages 2-4.
    const emptyWeb = await setup(async url => {
        const parsed = new URL(url);
        if (parsed.hostname === 'music.douban.com') {
            const start = Number(parsed.searchParams.get('start') || 0);
            const html = webpage(60, start, {type: 'music', short: start === 0 ? 14 : 15});
            return {status: 200, text: async () => html};
        }
        if (parsed.searchParams.get('type') === 'music' && parsed.searchParams.get('status') === 'done') {
            const start = Number(parsed.searchParams.get('start') || 0);
            return json({start, count: 50, total: 60, interests: start === 0 ? [interest(1, 'done')] : []});
        }
        return json({start: 0, count: 50, total: 0, interests: []});
    });
    await assert.rejects(() => emptyWeb.task.run(), /未返回任何条目/);
    emptyWeb.storage.local.close();

    // 2. Game page 2 returns start=50 with 10 duplicate IDs from page 1.
    const dupGame = await setup(async url => {
        const parsed = new URL(url);
        if (parsed.searchParams.get('type') === 'game' && parsed.searchParams.get('status') === 'done') {
            const start = Number(parsed.searchParams.get('start') || 0);
            const rows = start === 0 ?
                Array.from({length: 50}, (_, i) => interest(i + 1, 'done')) :
                Array.from({length: 10}, (_, i) => interest(i + 1, 'done'));
            return json({start, count: 50, total: 60, interests: rows});
        }
        return json({start: 0, count: 50, total: 0, interests: []});
    });
    await assert.rejects(() => dupGame.task.run(), /部分书影音标记获取失败/);
    dupGame.storage.local.close();

    // 3. Overview request fails while previous backup is non-empty and all segments return 0.
    const wipe = await setup(async url => new URL(url).searchParams.has('type') ?
        json({start: 0, count: 50, total: 0, interests: []}) : {status: 403, json: async () => ({})});
    await wipe.storage.local.interest.put(row(1, 1));
    await assert.rejects(() => wipe.task.run(), /总览未知但各分类均返回 0/);
    wipe.storage.local.close();

    // 4. Short HTTP 200 API page whose retry returns 500 recovers via 500 single-slice recovery.
    let gameReads = 0;
    const retry500 = await setup(async url => {
        const parsed = new URL(url);
        if (!parsed.searchParams.has('type')) return json({total: 2});
        if (parsed.searchParams.get('type') === 'game' && parsed.searchParams.get('status') === 'done') {
            const start = Number(parsed.searchParams.get('start') || 0);
            const count = Number(parsed.searchParams.get('count') || 50);
            if (count === 50) {
                gameReads++;
                if (gameReads === 1) return json({start: 0, count: 50, total: 2, interests: [interest(1, 'done')]});
                return {status: 500, json: async () => ({})};
            }
            return json({start, count: 1, total: 2, interests: [interest(start + 1, 'done')]});
        }
        return json({start: 0, count: 50, total: 0, interests: []});
    });
    await retry500.task.run();
    assert.equal(retry500.task.completion, 2);
    retry500.storage.local.close();
});

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

await check('interest-v1 checkpoint resumes across /misc/sorry 429 block and skips redundant 500 slicing when web fallback is required', async () => {
    const seq = setupSeq++;
    const storage = new Storage(101 + seq);
    await storage.local.open();
    const snapshot = await storage.createTaskSnapshot(2, 'Interest');
    let blockedOnce = false;
    let movieDoneCalls = 0;
    let slice500Calls = 0;
    const total = 60;
    const baseSource = fixture(total, {type: 'movie', status: 'done'});
    const makeTask = () => {
        const task = new Interest();
        task.init(async url => {
            const parsed = new URL(url);
            if (!parsed.searchParams.has('type') && parsed.hostname === 'm.douban.com') return json({total: 61});
            if (parsed.searchParams.get('type') === 'book' && parsed.searchParams.get('status') === 'done') {
                return json({start: 0, count: 50, total: 1, interests: [{...interest(900, 'done'), subject: {...interest(900, 'done').subject, type: 'book'}}]});
            }
            if (parsed.searchParams.get('type') === 'movie' && parsed.searchParams.get('status') === 'done') {
                movieDoneCalls++;
                const start = Number(parsed.searchParams.get('start') || 0);
                const count = Number(parsed.searchParams.get('count') || 50);
                if (count === 1) slice500Calls++;
                // First API page returns 5 items (capped/short) triggering webFallbackRequired, second API page returns 500
                if (start === 0) return json({start: 0, count: 50, total, interests: [interest(1, 'done')]});
                return {status: 500, json: async () => ({})};
            }
            if (parsed.hostname === 'movie.douban.com') {
                const start = Number(parsed.searchParams.get('start') || 0);
                if (start === 30 && !blockedOnce) {
                    blockedOnce = true;
                    return {
                        status: 200,
                        url: `https://www.douban.com/misc/sorry?original-url=${encodeURIComponent(url)}`,
                        text: async () => '<html><title>禁止访问</title></html>',
                    };
                }
                return {status: 200, url, text: async () => webpage(total, start, {type: 'movie'})};
            }
            return json({start: 0, count: 50, total: 0, interests: []});
        }, {warning() {}, error() {}}, 2, {cookies: {ck: 'PRIVATE_COOKIE'}}, snapshot.database, {id: 101 + seq, uid: 'film101'}, true);
        task.diagnosticRunId = `interest-checkpoint-${seq}`;
        task.saveCheckpoint = async () => {};
        return task;
    };

    const task1 = makeTask();
    await assert.rejects(() => task1.run(), /访问限制/);
    assert.equal(slice500Calls, 0, 'webFallbackRequired must skip 50 single-slice recovery requests on later 500 pages');
    assert.equal(task1.checkpoint?.kind, 'interest-v1');
    assert.equal(task1.checkpoint.partialSegment?.key, 'movie/done');
    assert.equal(task1.checkpoint.partialSegment?.phase, 'web');
    assert.equal(task1.checkpoint.partialSegment?.nextPage, 3);
    assert(task1.checkpoint.completedSegments['book/done']);

    const movieCallsBeforeResume = movieDoneCalls;
    const task2 = makeTask();
    task2.checkpoint = JSON.parse(JSON.stringify(task1.checkpoint));
    await task2.run();
    assert.equal(movieDoneCalls, movieCallsBeforeResume, 'resume in web phase must not restart movie/done API scan');
    assert.equal(task2.checkpoint, null);
    assert.equal(task2.completion, 61);
    assert.equal(await snapshot.database.interest.filter(r => r.version === 2).count(), 61);
    const diag = (await getDiagnosticReport()).entries;
    assert(diag.some(e => e.runId === `interest-checkpoint-${seq}` && e.event === 'interest.fallback_failed' && e.reason === 'rate_limited' && e.pages === 3));
    await snapshot.close();
    storage.local.close();
});

console.log(`interest completeness regression: ${checks} cases passed with real Dexie, parser and Excel round-trip`);
