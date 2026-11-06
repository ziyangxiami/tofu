// Run with: node --experimental-vm-modules extension/tests/login-job-regression.mjs
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import vm from 'node:vm';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const openedTabs = [];
const writes = [];
const closed = [];
const diagnostics = [];
let apiFetch;
let pageResponse;
let failAccountWrite = false;
const context = vm.createContext({
    URL, EventTarget, console,
    fetch: async (url, init) => {
        assert.equal(url, 'https://m.douban.com/mine/');
        assert.equal(init.credentials, 'include');
        return pageResponse;
    },
    chrome: {
        tabs: {create: options => openedTabs.push(options)},
        cookies: {getAll: (options, callback) => callback([{name: 'ck', value: 'test&cookie'}])},
    },
});
const synthetic = exports => new vm.SyntheticModule(Object.keys(exports), function () {
    for (const [name, value] of Object.entries(exports)) this.setExport(name, value);
}, {context});
const modules = new Map([
    ['storage.js', synthetic({default: class Storage {
        constructor() {
            writes.push('storage.created');
            this.global = {
                open: async () => {}, close() { closed.push('global'); },
                account: {get: async () => undefined, put: async () => {
                    if (failAccountWrite) throw new Error('account storage failed');
                    writes.push('account.put');
                }},
                job: {add: async () => { writes.push('job.add'); return 1; }},
            };
            this.local = {open: async () => {}, close() { closed.push('local'); }};
        }
    }})],
    ['service.js', synthetic({default: class Service {
        static getFetchURL() { return (...args) => apiFetch(...args); }
    }})],
    ['services/task_deserialize.js', synthetic({taskFromJSON: () => { throw new Error('unused'); }})],
    ['services/diagnostics.js', synthetic({
        newDiagnosticRunId: () => 'login-test',
        recordDiagnostic: async (runId, event, details) => diagnostics.push({event, ...details}),
    })],
]);
async function load(name) {
    if (!modules.has(name)) {
        const module = new vm.SourceTextModule(readFileSync(resolve(root, name), 'utf8'), {context});
        modules.set(name, module);
        await module.link(specifier => load(resolve(root, dirname(name), specifier).slice(root.length + 1)));
    }
    return modules.get(name);
}
const jobModule = await load('services/Job.js');
await jobModule.evaluate();
const Job = jobModule.namespace.default;
const TaskError = modules.get('services/TaskError.js').namespace.default;
assert.equal(new TaskError('test').name, 'TaskError');
const service = {logger: {debug() {}, error() {}}, saveState: async () => {}};
const page = (overrides = {}) => ({
    ok: true, status: 200, redirected: false, url: 'https://m.douban.com/mine/',
    text: async () => '<input id="user" value="123" data-name="Test user">' +
        '<div class="profile"><div class="detail"><div class="basic-info">' +
        '<a href="https://www.douban.com/people/test-user/">Profile</a></div></div></div>',
    ...overrides,
});
function reset() {
    pageResponse = page();
    apiFetch = async url => {
        const parsed = new URL(url);
        assert.equal(parsed.searchParams.get('ck'), 'test&cookie');
        return {ok: true, status: 200, json: async () => ({id: '123', uid: 'test-user', name: 'Test user'})};
    };
    openedTabs.length = 0;
    writes.length = 0;
    closed.length = 0;
    failAccountWrite = false;
}
let cases = 0;
async function check(name, run) {
    reset();
    await run();
    cases++;
}
await check('direct logged-in page', async () => {
    const session = await new Job(service).checkin();
    assert.equal(session.userId, 123);
    assert.equal(session.userSymbol, 'test-user');
});
await check('ordinary redirects stay in backup', async () => {
    pageResponse = page({redirected: true, url: 'https://m.douban.com/people/test-user/'});
    await new Job(service).run();
    assert(writes.includes('account.put'));
    assert.equal(openedTabs.length, 0);
});
for (const url of ['https://accounts.douban.com/passport/login', 'https://m.douban.com/login/',
    'https://www.douban.com/accounts/login']) {
    await check('actual login redirect', async () => {
        pageResponse = page({redirected: true, url});
        await assert.rejects(() => new Job(service).run(), /未登录豆瓣/);
        assert.equal(writes.length, 0);
        assert.equal(openedTabs.length, 0);
    });
}
await check('security verification response', async () => {
    pageResponse = page({ok: false, status: 403, redirected: true, url: 'https://sec.douban.com/a'});
    await assert.rejects(() => new Job(service).run(), /安全验证/);
    assert.equal(writes.length, 0);
});
await check('untrusted final page', async () => {
    pageResponse = page({redirected: true, url: 'https://douban.com.example.org/'});
    await assert.rejects(() => new Job(service).run(), /异常页面/);
    assert.equal(writes.length, 0);
});
await check('HTTP error', async () => {
    pageResponse = page({ok: false, status: 503});
    await assert.rejects(() => new Job(service).run(), /HTTP 503/);
});
await check('missing account marker', async () => {
    pageResponse = page({text: async () => '<h1>Login required</h1>'});
    await assert.rejects(() => new Job(service).run(), /无法读取豆瓣用户信息/);
});
for (const uid of ['', '123invalid', '0', '-1', '1.2', '9007199254740992']) {
    await check('invalid numeric ID', async () => {
        pageResponse = page({text: async () => `<input id="user" value="${uid}">`});
        await assert.rejects(() => new Job(service).run(), /有效的豆瓣用户 ID/);
        assert.equal(writes.length, 0);
    });
}
for (const response of [
    {ok: false, status: 401},
    {ok: true, json: async () => { throw new SyntaxError('not JSON'); }},
    {ok: true, json: async () => ({code: 1001})},
    {ok: true, json: async () => ({id: '123extra'})},
    {ok: true, json: async () => null},
]) {
    await check('invalid user API response', async () => {
        apiFetch = async () => response;
        await assert.rejects(() => new Job(service).run(), /豆瓣用户接口/);
        assert.equal(writes.length, 0);
    });
}
await check('page and API disagree', async () => {
    apiFetch = async () => ({ok: true, json: async () => ({id: 456})});
    await assert.rejects(() => new Job(service).run(), /账号不一致/);
    assert.equal(writes.length, 0);
});
await check('resumed job cannot change accounts', async () => {
    const job = new Job(service);
    job._id = 8;
    job._session = {userId: 456};
    await assert.rejects(() => job.run(), /登录账号已改变/);
    await assert.rejects(() => job.run(), /登录账号已改变/);
    assert.equal(job._session.userId, 456, 'failed check must retain original binding');
    assert.equal(writes.length, 0);
});
await check('resumed target cannot change accounts', async () => {
    const job = new Job(service, 456);
    job._id = 8;
    job._session = {userId: 123};
    apiFetch = async url => ({ok: true, json: async () => ({
        id: new URL(url).pathname.endsWith('/456') ? 789 : 123,
    })});
    await assert.rejects(() => job.run(), /账号不一致/);
    assert.equal(job._targetUserId, 456);
    assert.equal(writes.length, 0);
});
await check('vanity target ID resolves on first use', async () => {
    const job = new Job(service, 'target-name');
    apiFetch = async url => ({ok: true, json: async () => ({
        id: new URL(url).pathname.endsWith('/target-name') ? 456 : 123,
    })});
    await job.run();
    assert.equal(job._targetUserId, 456);
    assert(writes.includes('account.put'));
});
await check('startup failures clear runtime state', async () => {
    const job = new Job(service);
    job._currentTask = {};
    pageResponse = page({ok: false, status: 500});
    await assert.rejects(() => job.run(), /HTTP 500/);
    assert.equal(job.isRunning, false);
    assert.equal(job.currentTask, null);
});
await check('account write failure closes database', async () => {
    failAccountWrite = true;
    const job = new Job(service);
    await assert.rejects(() => job.run(), /account storage failed/);
    assert.deepEqual(closed, ['global']);
    assert.equal(job.isRunning, false);
});
await check('task initialization failure closes databases', async () => {
    const job = new Job(service);
    job.addTask({init() { throw new Error('task initialization failed'); }});
    await assert.rejects(() => job.run(), /task initialization failed/);
    assert.deepEqual(closed, ['global', 'local']);
    assert.equal(job.isRunning, false);
});
console.log(`login/job regression: ${cases} cases passed`);
