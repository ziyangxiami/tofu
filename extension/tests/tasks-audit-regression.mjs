// Run: node --experimental-vm-modules extension/tests/tasks-audit-regression.mjs
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {resolve, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import vm from 'node:vm';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const context = vm.createContext({console, URL, URLSearchParams, EventTarget});
const modules = new Map();
function synthetic(path, exports) {
    const module = new vm.SyntheticModule(Object.keys(exports), function () {
        for (const [name, value] of Object.entries(exports)) this.setExport(name, value);
    }, {context});
    modules.set(resolve(root, path), module);
}
synthetic('storage.js', {default: class Storage {}});
synthetic('settings.js', {default: {
    async load() { return {cloudName: 'test-cloud'}; },
    apply(target, settings) { Object.assign(target, settings); },
}});
synthetic('services/diagnostics.js', {recordDiagnostic: async () => {}});
async function load(path) {
    const absolute = resolve(root, path);
    if (modules.has(absolute)) return modules.get(absolute);
    const module = new vm.SourceTextModule(readFileSync(absolute, 'utf8'), {context, identifier: absolute});
    modules.set(absolute, module);
    await module.link(specifier => load(resolve(dirname(absolute), specifier)));
    return module;
}
async function taskClass(name) {
    const module = await load(`tasks/${name}.js`);
    if (module.status !== 'evaluated') await module.evaluate();
    return module.namespace.default;
}
const clone = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
function table(key = 'id', initial = []) {
    const rows = new Map(initial.map(row => [row[key], clone(row)]));
    return {
        rows,
        async get(id) {
            if (typeof id === 'object') return clone([...rows.values()].find(row =>
                Object.entries(id).every(([field, value]) => row[field] === value)));
            return clone(rows.get(id));
        },
        async put(row) { rows.set(row[key] ?? rows.size + 1, clone(row)); },
        async add(row) {
            if (rows.has(row[key])) throw Object.assign(new Error('duplicate'), {name: 'ConstraintError'});
            rows.set(row[key] ?? rows.size + 1, clone(row));
        },
        async update(id, changes) { rows.set(id, {...rows.get(id), ...clone(changes)}); },
        async delete(id) { rows.delete(id); },
        where(field) {
            return {equals(value) { return {async delete() {
                for (const [id, row] of rows) if (row[field] === value) rows.delete(id);
            }}; }};
        },
    };
}
function storage(initialVersions = []) {
    const result = {version: table('table', initialVersions), transaction: async (...args) => args.at(-1)()};
    for (const name of ['note', 'review', 'annotation', 'photo', 'album', 'interest', 'follower',
        'following', 'blacklist', 'status', 'board', 'files', 'doulist', 'doulistItem', 'doumail', 'doumailContact']) {
        result[name] = table();
    }
    result.table = name => result[name];
    return result;
}
function json(data, status = 200) { return {status, json: async () => clone(data)}; }
function html(text, status = 200) { return {status, text: async () => text}; }
const logger = {debug() {}, warning() {}, error() {}};
async function setup(name, fetch, db = storage(), user = {id: 1}) {
    const Type = await taskClass(name);
    const task = new Type();
    task.init(fetch, logger, 2, {cookies: {ck: 'test'}}, db, user, false);
    return {task, db};
}
let checks = 0;
async function check(title, run) {
    await run();
    checks++;
    console.log(`ok ${checks} - ${title}`);
}

for (const name of ['note', 'review', 'photo', 'following', 'follower']) {
    await check(`${name}: missing profile count still queries and rejects malformed API response`, async () => {
        let requests = 0;
        const db = storage([{table: name === 'photo' ? 'photo' : name, version: 1}]);
        const {task} = await setup(name, async () => { requests++; return json({code: 401}); }, db);
        await assert.rejects(() => task.run(), /接口响应格式错误/);
        assert.equal(requests, 1);
        assert.equal((await db.version.get(name)).version, 1);
    });
}
await check('note: API count is authoritative and successful content publishes its version', async () => {
    const {task, db} = await setup('note', async url => url.includes('/rexxar/') ?
        json({total: 1, notes: [{id: '10', url: 'https://www.douban.com/note/10/', update_time: 'new'}]}) :
        html('<div id="link-report"><div class="note">Complete content</div></div>'));
    await task.run();
    assert.equal((await db.note.get(10)).note.fulltext, 'Complete content');
    assert.equal(task.total, 1);
    assert.equal(task.completion, 1);
    assert.equal((await db.version.get('note')).version, 2);
});
for (const name of ['note', 'review', 'annotation']) {
    await check(`${name}: failed detail fetch preserves old content and old published version`, async () => {
        const db = storage([{table: name, version: 1}]);
        const old = {id: 10, version: 1, [name]: {fulltext: 'Saved full content', update_time: 'old'}};
        await db[name].put(old);
        const entry = {id: '10', url: `https://www.douban.com/${name}/10/`, update_time: 'new'};
        const data = name === 'annotation' ? {total: 1, collections: [{subject: {id: 8}, annotations: [entry]}]} :
            {total: 1, [`${name}s`]: [entry]};
        const {task} = await setup(name, async url => url.includes('/rexxar/') ? json(data) : html('', 403), db,
            {id: 1, [`${name}s_count`]: 1});
        await assert.rejects(() => task.run(), /正文获取失败/);
        assert.deepEqual(await db[name].get(10), old);
        assert.equal((await db.version.get(name)).version, 1);
    });
}
await check('review: an HTML page without review content is a failure', async () => {
    const {task} = await setup('review', async () => html('<html><form>Log in</form></html>'));
    await assert.rejects(() => task.fetchReview('https://movie.douban.com/review/10/'), /无法识别评论正文/);
});
await check('note: a positive API total with an empty page cannot pass as complete', async () => {
    const {task} = await setup('note', async () => json({total: 60, notes: []}));
    await assert.rejects(() => task.run(), /分页内容缺失/);
});
await check('status: new backup starts at newest, not at the old oldest cursor', async () => {
    const db = storage([{table: 'status', version: 1, lastId: '10'}]);
    const cursors = [];
    const {task} = await setup('status', async url => {
        cursors.push(new URL(url).searchParams.get('max_id'));
        return json({items: cursors.length === 1 ? [{status: {id: '20', text: 'new'}}] : []});
    }, db);
    await task.run();
    assert.deepEqual(cursors, ['', '20']);
    assert.equal((await db.status.get(20)).status.text, 'new');
});
await check('status: resumed job keeps its own persisted cursor', async () => {
    const db = storage([{table: 'status', version: 2, lastId: '10'}]);
    const cursors = [];
    const {task} = await setup('status', async url => {
        cursors.push(new URL(url).searchParams.get('max_id'));
        return json({items: []});
    }, db);
    await task.run();
    assert.deepEqual(cursors, ['10']);
});
await check('status: failed first request cannot leave an old cursor attached to the new version', async () => {
    const db = storage([{table: 'status', version: 1, lastId: '10'}]);
    const {task} = await setup('status', async () => json({}, 503), db);
    await assert.rejects(() => task.run(), /服务器返回错误/);
    assert.equal((await db.version.get('status')).lastId, '');
});
await check('status: malformed data and repeated pages fail explicitly', async () => {
    const first = await setup('status', async () => json({code: 403}));
    await assert.rejects(() => first.task.run(), /接口响应格式错误/);
    let requests = 0;
    const second = await setup('status', async () => {
        assert(++requests < 6, 'pagination must stop');
        return json({items: [{status: {id: '20'}}, {status: {id: '10'}}]});
    });
    await assert.rejects(() => second.task.run(), /分页.*重复|分页未前进/);
});
function interestFetch({failSlice = false} = {}) {
    return async url => {
        const params = new URL(url).searchParams;
        if (!params.has('type')) return json({total: 51});
        if (params.get('type') !== 'game' || params.get('status') !== 'mark') return json({total: 0, interests: []});
        const start = Number(params.get('start'));
        if (params.get('count') === '50' && start === 0) return json({}, 500);
        if (failSlice && params.get('count') === '1' && start === 3) return json({}, 500);
        return json({total: 51, interests: [{id: start + 1, subject: {id: start + 1000}, status: 'mark'}]});
    };
}
await check('interest: 500 recovery updates pagination and fetches the second page', async () => {
    const {task, db} = await setup('interest', interestFetch());
    await task.run();
    assert.equal(db.interest.rows.size, 51);
    assert(await db.interest.get(51));
    assert.equal((await db.version.get('interest')).version, 2);
});
await check('interest: unrecovered slices retain useful rows and report failure without publishing', async () => {
    const db = storage([{table: 'interest', version: 1}]);
    const {task} = await setup('interest', interestFetch({failSlice: true}), db);
    await assert.rejects(() => task.run(), /部分书影音标记获取失败/);
    assert.equal(db.interest.rows.size, 50);
    assert.equal((await db.version.get('interest')).version, 1);
});
await check('interest: malformed total and invalid subject IDs fail before writes', async () => {
    const {task, db} = await setup('interest', async () => json({code: 403}));
    await assert.rejects(() => task.getTotal(), /有效总数/);
    await assert.rejects(() => task.processInterest({id: 8, subject: {}}, 2, 'book'), /有效 ID/);
    assert.equal(db.interest.rows.size, 0);
});
for (const failWrite of [false, true]) {
    await check(`interest: primary-key replacement ${failWrite ? 'rolls back on failure' : 'commits atomically'}`, async () => {
        const {task, db} = await setup('interest', async () => { throw new Error('no network expected'); });
        const old = {id: 7, subject: 100, version: 1, type: 'book', status: 'mark',
            interest: {id: 7, subject: {id: 100}, status: 'mark'}};
        await db.interest.put(old);
        const put = db.interest.put;
        let transactions = 0;
        db.transaction = async (mode, target, execute) => {
            assert.equal(mode, 'rw');
            assert.equal(target, db.interest);
            transactions++;
            const before = clone([...target.rows]);
            try { return await execute(); }
            catch (error) {
                target.rows.clear();
                for (const [key, row] of before) target.rows.set(key, row);
                throw error;
            }
        };
        db.interest.put = async row => {
            assert.equal(transactions, 1, 'replacement must be inside the transaction');
            if (failWrite) throw new Error('storage quota exceeded');
            await put(row);
        };
        const replace = () => task.processInterest({id: 8, subject: {id: 100}, status: 'done'}, 2, 'book');
        if (failWrite) {
            await assert.rejects(replace, /storage quota exceeded/);
            assert.deepEqual(await db.interest.get(7), old);
            assert.equal(await db.interest.get(8), undefined);
            assert.equal(task.completion, 0);
        } else {
            await replace();
            assert.equal(await db.interest.get(7), undefined);
            assert.equal((await db.interest.get(8)).status, 'done');
            assert.equal(task.completion, 1);
        }
    });
}
await check('board: storage failures propagate and do not advance lastId', async () => {
    const db = storage([{table: 'board', version: 1, lastId: 1}]);
    db.board.add = async () => { throw Object.assign(new Error('full'), {name: 'QuotaExceededError'}); };
    const {task} = await setup('board', async () => html('<div id="comments"><div class="comment-item" data-cid="2"><a>A</a>text<span class="pl">2026-10-01</span></div></div>'), db);
    await assert.rejects(() => task.run(), /full/);
    assert.equal((await db.version.get('board')).lastId, 1);
});
await check('photo: a forbidden album page fails without publishing a complete snapshot', async () => {
    const db = storage([{table: 'photo', version: 1}]);
    const {task} = await setup('photo', async url => url.includes('/rexxar/') ?
        json({total: 1, photo_albums: [{id: '10', url: 'https://www.douban.com/photos/album/10/?sortby=time'}]}) : html('', 403), db);
    await assert.rejects(() => task.run(), /服务器返回错误/);
    assert.equal((await db.version.get('photo')).version, 1);
});
await check('photo: changing a photo preserves an independent history snapshot', async () => {
    const db = storage();
    await db.photo.put({id: 12, album: 10, version: 1, photo: {description: 'old', cover: 'old.jpg', raw: 'old-large.jpg'}});
    let albumURL;
    const {task} = await setup('photo', async url => {
        if (url.includes('/rexxar/')) return json({total: 1, photo_albums: [{id: '10', privacy: 'public', url: 'https://www.douban.com/photos/album/10/?sortby=time'}]});
        albumURL = new URL(url);
        return html('<a class="photolst_photo" href="https://www.douban.com/photos/photo/12/" title="new"><img src="https://img.doubanio.com/m/new.jpg"></a>');
    }, db);
    await task.run();
    const saved = await db.photo.get(12);
    assert.equal(saved.history[1].description, 'old');
    assert.equal(saved.history[1].cover, 'old.jpg');
    assert.equal(saved.photo.description, 'new');
    assert.equal(albumURL.searchParams.get('sortby'), 'time');
    assert.equal(albumURL.searchParams.get('m_start'), '0');
});
for (const status of [401, 403, 429]) {
    await check(`files: HTTP ${status} does not mark a failed upload saved`, async () => {
        const db = storage();
        const row = {id: 1, url: 'https://img.doubanio.com/test.jpg', tags: ['test'], meta: {}, path: 'test'};
        await db.files.put(row);
        db.files.filter = () => ({count: async () => 1, limit: () => ({toArray: async () => [clone(row)]})});
        const {task} = await setup('files', async () => json({error: {message: 'denied'}}, status), db);
        task.extractImages = async () => {};
        await assert.rejects(() => task.run(), /Cloudinary 接口返回错误/);
        assert.equal((await db.files.get(1)).save, undefined);
    });
}
await check('files: local storage errors are not swallowed', async () => {
    const {task, db} = await setup('files', async () => { throw new Error('unused'); });
    db.files.add = async () => { throw Object.assign(new Error('full'), {name: 'QuotaExceededError'}); };
    await assert.rejects(() => task.addFile('https://example.com/a.jpg', [], {}, 'test'), /full/);
});
for (const name of ['following', 'follower', 'blacklist']) {
    await check(`${name}: worker replay replaces only its partial snapshot`, async () => {
        const db = storage([{table: name, version: 1}]);
        await db[name].put({id: 1, version: 1, user: {id: '100'}});
        await db[name].put({id: 2, version: 2, user: {id: '200'}});
        const fetch = name === 'blacklist' ? async () => html('<div class="obss namel"><dl><img class="imgg" src="https://img.doubanio.com/icon/u200-1.jpg" alt="User"><a class="nbg" href="https://www.douban.com/people/200/"></a></dl></div>') :
            async () => json({total: 1, users: [{id: '200'}]});
        const {task} = await setup(name, fetch, db);
        await task.run();
        assert.equal([...db[name].rows.values()].filter(row => row.version === 2).length, 1);
        assert.equal([...db[name].rows.values()].filter(row => row.version === 1).length, 1);
        assert.equal((await db.version.get(name)).version, 2);
    });
}
for (const [name, user] of [['blacklist', {id: 1}], ['follower', {id: 1, followers_count: 6000}]]) {
    await check(`${name}: HTTP 200 without a list cannot replace a published snapshot`, async () => {
        const db = storage([{table: name, version: 1}]);
        const {task} = await setup(name, async () => html('<html><form>Login</form></html>'), db, user);
        await assert.rejects(() => task.run(), /无法识别/);
        assert.equal((await db.version.get(name)).version, 1);
    });
}
const mailContacts = '<div class="doumail-list"><ul><li><span class="operations"><a class="post_link report" data-id="10"></a></span><div class="title"><a class="url" href="https://www.douban.com/doumail/10/"></a></div></li></ul></div>';
for (const payload of [{err: 'denied', more: false, html: ''}, {more: true, html: ''}]) {
    await check(`doumail: ${payload.err ? 'API errors' : 'empty pages with more=true'} cannot report completion`, async () => {
        const {task, db} = await setup('doumail', async (_url, init) => init?.method === 'POST' ? json(payload) : html(mailContacts));
        await assert.rejects(() => task.run(), /豆邮.*错误|豆邮分页内容重复或缺失/);
        assert.equal(db.doumailContact.rows.size, 0);
    });
}
await check('doumail: repeated pages stop instead of fetching forever', async () => {
    let requests = 0;
    const {task, db} = await setup('doumail', async (_url, init) => {
        if (init?.method !== 'POST') return html(mailContacts);
        assert(++requests < 4);
        return json({more: true, html: '<div class="chat" data="20"><div class="content">Message</div></div>'});
    });
    await assert.rejects(() => task.run(), /豆邮分页内容重复/);
    assert.equal(requests, 2);
    assert.equal((await db.doumail.get(20)).content, 'Message');
});
await check('doumail: wrapped HTML fragments save messages and preserve dates across pages', async () => {
    let requests = 0;
    const {task, db} = await setup('doumail', async (_url, init) => {
        if (init?.method !== 'POST') return html(mailContacts);
        requests++;
        return json({more: requests === 1, html:
            (requests === 1 ? '<div class="split-line">2026-10-16</div>' : '') +
            `<div class="chat" data="${20 + requests}"><div class="info"><span class="time">12:30</span></div><div class="content">Message ${requests}</div></div>`});
    });
    await task.run();
    assert.equal(db.doumail.rows.size, 2);
    assert.equal((await db.doumail.get(21)).datetime, '2026-10-16 12:30');
    assert.equal((await db.doumail.get(22)).datetime, '2026-10-16 12:30');
    assert.equal(db.doumailContact.rows.size, 1);
});
await check('HTML pagination rejects invalid totalPage instead of silently stopping after page one', async () => {
    const helper = await load('tasks/_validation.js');
    const parser = await load('services/html_parser.js');
    const parse = parser.namespace.default;
    assert.equal(helper.namespace.htmlPageCount(parse('<div></div>')), 1);
    assert.equal(helper.namespace.htmlPageCount(parse('<div class="paginator"><span class="thispage" data-total-page="3"></span></div>')), 3);
    assert.throws(() => helper.namespace.htmlPageCount(parse('<div class="paginator"><span class="thispage"></span></div>')), /分页信息无效/);
    assert.throws(() => helper.namespace.htmlPageCount(parse('<div class="paginator"><span class="thispage" data-total-page="NaN"></span></div>')), /分页信息无效/);
});
console.log(`task audit regression: ${checks} passed`);
