// Run with: node --experimental-vm-modules extension/tests/service-audit-regression.mjs
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import vm from 'node:vm';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = name => readFileSync(resolve(root, name), 'utf8');
const signal = () => {
    const listeners = [];
    return {listeners, addListener: listener => listeners.push(listener),
        emit: (...args) => listeners.forEach(listener => listener(...args))};
};
const tick = () => new Promise(resolve => setImmediate(resolve));
class CustomEvent extends Event {
    constructor(type, options = {}) { super(type); this.detail = options.detail; }
}
const logs = [];
const quietConsole = {log: (...args) => logs.push(args), debug: (...args) => logs.push(args),
    error: (...args) => logs.push(args)};
let releaseStorage;
const storageGate = new Promise(resolve => { releaseStorage = resolve; });
let storageReads = 0;
let writes = [];
const chrome = {
    runtime: {onConnect: signal(), onInstalled: signal(), onSuspend: signal()},
    storage: {
        onChanged: signal(),
        session: {
            async get() { storageReads++; await storageGate; return {serviceState: {
                _ports: [], _status: 1, _jobQueueTasks: [], _currentJob: null,
            }}; },
            async set(value) { writes.push(value); },
        },
    },
};
const context = vm.createContext({console: quietConsole, chrome, EventTarget, Event, CustomEvent,
    Request, URL, setTimeout, clearTimeout, Date});
const synthetic = (exports) => new vm.SyntheticModule(Object.keys(exports), function () {
    for (const [key, value] of Object.entries(exports)) this.setExport(key, value);
}, {context});
class FakeTask { constructor(...args) { this.args = args; } }
class FakeJob {
    constructor() { this.tasks = []; }
    addTask(task) { this.tasks.push(task); }
    toJSON() { return {tasks: this.tasks}; }
    static fromJSON(value) { return value; }
}
const queueModule = new vm.SourceTextModule(source('services/AsyncBlockingQueue.js'), {context});
const eventModule = new vm.SourceTextModule(source('services/StateChangeEvent.js'), {context});
const loggerModule = new vm.SourceTextModule(source('services/Logger.js'), {context});
const defaults = synthetic({default: FakeTask});
const settings = synthetic({default: {load: async () => ({}), apply() {}}, SERVICE_SETTINGS: {}});
const job = synthetic({default: FakeJob});
const diagnostics = synthetic({recordDiagnostic: async () => {}, newDiagnosticRunId: () => 'audit-run'});
const migrationHelpers = synthetic({validId: value => Number(value)});
const module = new vm.SourceTextModule(source('service.js'), {context});
await module.link(specifier => ({
    './settings.js': settings, './services/Job.js': job,
    './services/AsyncBlockingQueue.js': queueModule,
    './services/StateChangeEvent.js': eventModule,
    './services/Logger.js': loggerModule,
    './services/diagnostics.js': diagnostics,
    './tasks/migrate/MigrationTask.js': migrationHelpers,
})[specifier] || defaults);
await module.evaluate();
const Service = module.namespace.default;
let startups = 0;
Service.startup = async () => { startups++; };

// Initialization is shared, connection listeners exist before the first await,
// and requests received during restore cannot mutate state prematurely.
const first = Service.getInstance();
const second = Service.getInstance();
assert.equal(chrome.runtime.onConnect.listeners.length, 1);
assert.equal(storageReads, 1);
const sent = [];
const port = {name: 'ui-panel', sender: {tab: {id: 1, windowId: 1}},
    onMessage: signal(), onDisconnect: signal(), postMessage: value => sent.push(value)};
chrome.runtime.onConnect.emit(port);
port.onMessage.emit({type: 'syscall', id: 'early', method: 'ping', args: ['ready']});
await tick();
assert.equal(sent.length, 0);
releaseStorage();
const [service1, service2] = await Promise.all([first, second]);
await tick();
assert.equal(service1, service2);
assert.equal(startups, 1);
assert.equal(sent[0].return.pang, 'ready');
assert.equal(service1._ports.size, 1, 'restore must retain a port connected during initialization');

// Separate connections from one tab remain independent when one closes.
const secondPort = {...port, onMessage: signal(), onDisconnect: signal(), postMessage() {}};
delete secondPort._portId;
service1.onConnect(secondPort);
assert.equal(service1._ports.size, 2);
port.onDisconnect.emit(port);
assert.equal(service1._ports.size, 1);
assert.equal([...service1._ports.values()][0], secondPort);

// Invalid selections fail as a whole instead of silently queuing partial jobs.
const writesBefore = writes.length;
await assert.rejects(() => service1.createJob(null, null, []), /至少选择/);
await assert.rejects(() => service1.createJob(null, null, [{name: 'Note'}, {name: 'unknown'}]), /不支持/);
await assert.rejects(() => service1.createJob(null, null, [{name: 'constructor'}]), /不支持/);
await assert.rejects(() => service1.createJob(null, null, [{name: 'Note', args: {}}]), /参数格式/);
assert.equal(service1._jobQueue.length, 0);
assert.equal(writes.length, writesBefore);
await service1.createJob(null, null, [{name: 'Note'}]);
assert.equal(service1._jobQueue.length, 1);

// A caller closing its page while an RPC completes must not reject onMessage.
await service1.onMessage({postMessage() { throw new Error('disconnected port'); }},
    {type: 'syscall', method: 'ping', args: [1], id: 'closed'});

// A network retry honors both the configured interval and a user pause.
let attempts = 0;
let continueCalls = 0;
let resume;
let waits = [];
const networkService = {
    requestInterval: 40, logger: {debug: (...args) => logs.push(args), error: (...args) => logs.push(args)}, dispatchEvent() {},
    continue() {
        continueCalls++;
        if (continueCalls === 2) return new Promise(resolve => { resume = resolve; });
        return Promise.resolve();
    },
};
const originalWait = Service.waitWithKeepAlive;
Service.waitWithKeepAlive = async delay => { waits.push(delay); };
context.fetch = async () => { if (++attempts === 1) throw new Error('offline'); return {status: 200}; };
const network = Service.getFetchURL(networkService)('https://example.test/data?ck=test-sensitive-cookie',
    {headers: {'X-Private': 'test-sensitive-header'}, body: 'test-sensitive-body'}, false, 1);
await tick();
assert.equal(attempts, 1);
assert.equal(typeof resume, 'function');
resume();
assert.equal((await network).status, 200);
assert.equal(attempts, 2);
assert.equal(waits.length, 1);
assert(waits[0] > 0 && waits[0] <= 40);
Service.waitWithKeepAlive = originalWait;
assert(!JSON.stringify(logs).includes('test-sensitive-'), 'request secrets must not enter service logs');

// A POST may have reached the server even when fetch rejects. Do not replay it,
// including when its method is supplied by a Request instead of init.
const writeService = {...networkService, requestInterval: 0, continue: () => Promise.resolve()};
for (const [resource, init] of [
    ['https://example.test/write', {method: 'POST', body: 'payload'}],
    [new Request('https://example.test/write', {method: 'POST', body: 'payload'}), {}],
]) {
    let writeAttempts = 0;
    context.fetch = async () => { writeAttempts++; throw new Error('response lost after dispatch'); };
    await assert.rejects(() => Service.getFetchURL(writeService)(resource, init), /response lost after dispatch/);
    assert.equal(writeAttempts, 1, 'an uncertain write must not be automatically retried');
}


// The proxy handles synchronous responses/disconnects, serialization errors,
// and promise assimilation without losing callbacks or inventing a `then` RPC.
const proxyModule = new vm.SourceTextModule(source('services/ServiceProxy.js'), {context});
await proxyModule.link(() => { throw new Error('unexpected proxy import'); });
await proxyModule.evaluate();
const ServiceProxy = proxyModule.namespace.default;
let posted = [];
const proxyPort = {onMessage: signal(), onDisconnect: signal(), postMessage(message) {
    posted.push(message);
    this.onMessage.emit({type: 'syscall', id: message.id, return: message.method});
}};
const proxy = new ServiceProxy(proxyPort);
assert.equal(await proxy.ping(), 'ping');
assert.equal(await proxy.getProperty('status'), 'status');
assert.equal(await Promise.resolve(proxy), proxy);
assert.equal(posted.length, 2);
let events = 0;
proxy.addEventListener('progress', () => events++);
proxyPort.onMessage.emit({type: 'progress', detail: {count: 1}});
assert.equal(events, 1);
proxyPort.postMessage = () => { throw new Error('cannot serialize'); };
await assert.rejects(() => proxy.ping(), /cannot serialize/);
proxyPort.postMessage = () => proxyPort.onDisconnect.emit();
await assert.rejects(() => proxy.ping(), /连接已断开/);
await assert.rejects(() => proxy.getProperty('status'), /连接已断开/);

// DNR updates remove and add in one atomic operation; a failed addition is caught.
const dnrCalls = [];
chrome.declarativeNetRequest = {updateDynamicRules: async value => {
    dnrCalls.push(value); throw new Error('invalid rule');
}};
const backgroundService = synthetic({default: {getInstance: async () => service1}});
const background = new vm.SourceTextModule(source('background.js'), {context});
await background.link(() => backgroundService);
await background.evaluate();
chrome.runtime.onInstalled.emit();
await tick();
assert.equal(dnrCalls.length, 1);
assert(dnrCalls[0].removeRuleIds.includes(101));
assert(dnrCalls[0].addRules.some(rule => rule.id === 101));
assert(logs.some(args => args[0] === 'declarativeNetRequest error:'));
console.log('Service audit regression tests passed (startup, ports, RPC, job validation, safe retries, DNR).');

// A database maintenance lease excludes task starts and enqueue operations.
let lockHeld = true;
context.navigator = {locks: {request: async (name, options, operation) => {
    assert.equal(name, 'tofu-database-maintenance'); assert.equal(options.ifAvailable, true);
    return operation(lockHeld ? null : {name});
}}};
await assert.rejects(service1.start(), /数据库正在/);
const beforeLockedQueue = service1._jobQueue.length;
await assert.rejects(service1.createJob(null, null, [{name:'Note'}]), /数据库正在/);
assert.equal(service1._jobQueue.length, beforeLockedQueue);
lockHeld = false;
assert.equal(await Service.withDatabaseLock(() => 'available'), 'available');
console.log('Database maintenance exclusion passed.');

// RPC must not expose private methods that bypass the maintenance lock.
for (const method of ['_start','_createJob','_retryLastJob','_cancelCurrentJob','restoreState','constructor']) {
    const replies=[];
    await service1.onMessage({postMessage:value=>replies.push(value)}, {type:'syscall',id:method,method,args:[]});
    assert.match(replies[0].error,/不支持的后台操作/);
}
console.log('RPC public-operation allowlist passed.');

// Failed task retry, idle start, cancelCurrentJob, and cookie stripping.
let retriedRuns = 0;
service1._jobQueue = new (queueModule.namespace.default)();
service1._currentJob = null;
service1._lastJob = null;
service1._status = Service.STATE_STOPPED;
assert.equal(service1.serviceAction, 'idle');
assert.equal(await service1.start(), false, 'idle start must not spin');
service1._lastJob = {
    targetUserId: null, localUserId: null, isOffline: false, isMigration: false, _id: 9,
    _session: {userId: 1, cookies: {dbcl2: 'SECRET_COOKIE', ck: 'SECRET_CK'}},
    tasks: [{taskType: 'Note', name: '日记', session: {cookies: {ck: 'SECRET_CK'}}, targetUser: {id: 1}}],
    completedTaskTypes: [], emptyTasks: [], failedTasks: [{task: '日记', error: 'TaskError: fail'}],
    finishedAt: Date.now(),
};
assert.equal(service1.canRetryLastJob, true);
assert.equal(service1.serviceAction, 'retry');
assert(!JSON.stringify(service1.displayJob).includes('SECRET_'), 'displayJob must strip credentials');
FakeJob.fromJSON = (json) => ({
    ...json,
    toJSON() { return this; },
    toPublicJSON() { const c = {...this}; delete c._session; return c; },
});
assert.equal(await service1.start(), true, 'start() on retryable _lastJob must enqueue retry');
assert.equal(service1._jobQueue.length, 1);
assert.equal(service1._lastJob, null);
await service1.stop();
service1._currentJob = service1._jobQueue.dequeue ? await service1._jobQueue.dequeue() : null;
service1._status = Service.STATE_STOPPED;
assert.equal(service1.serviceAction, 'resume');
assert.equal(await service1.cancelCurrentJob(), true);
assert.equal(service1.hasUnfinishedJobs, false);
assert.equal(service1.serviceAction, 'idle');
assert.equal(service1.displayJob.cancelled, true);
assert.deepEqual(JSON.parse(JSON.stringify(service1.displayJob.activeTaskTypes || [])), []);

// Real Service.startup() loop verification for cancel (no ghost execution) and retry (including Files re-run).
const realValidation = new vm.SourceTextModule(source('tasks/_validation.js'), {context});
const realTaskError = new vm.SourceTextModule(source('services/TaskError.js'), {context});
await realTaskError.link(() => {}); await realTaskError.evaluate();
await realValidation.link(() => realTaskError); await realValidation.evaluate();
const realStorage = synthetic({default: class Storage {
    constructor() {
        this.global = {open: async () => {}, close() {}, account: {get: async () => null, put: async () => {}}, job: {add: async () => 1}};
        this.local = {open: async () => {}, close() {}, table: () => ({get: async () => null, put: async () => {}})};
    }
    async createTaskSnapshot() { return null; }
    async markAccountPublished() {}
}});
const realDeser = synthetic({taskFromJSON: json => new FakeTask(json)});
const realJobMod = new vm.SourceTextModule(source('services/Job.js'), {context});
const realTaskMod = new vm.SourceTextModule(source('services/Task.js'), {context});
const realParserMod = synthetic({default: () => null});
await realTaskMod.link(s => ({'./TaskError.js': realTaskError, '../storage.js': realStorage, './html_parser.js': realParserMod})[s]);
await realTaskMod.evaluate();
await realJobMod.link(s => ({
    '../service.js': module, './Task.js': realTaskMod, './TaskError.js': realTaskError,
    './AsyncBlockingQueue.js': queueModule, '../storage.js': realStorage,
    './task_deserialize.js': realDeser, './diagnostics.js': diagnostics,
})[s]);
await realJobMod.evaluate();
const RealJob = realJobMod.namespace.default;
const realJob = new RealJob(service1, null, null, false);
realJob._session = {userId: 1, cookies: {dbcl2: 'SECRET_DBCL2', ck: 'SECRET_CK'}};
realJob._failedTasks = [{task: '书/影/音/游', error: 'TaskError: segment'}];
realJob._activeTaskTypes.add('Note');
realJob._activeTaskTypes.add('Review');
const pub = realJob.toPublicJSON();
assert.equal(pub._session, undefined);
assert.deepEqual(JSON.parse(JSON.stringify(pub.activeTaskTypes)).sort(), ['Note', 'Review']);
const roundtripped = RealJob.fromJSON(JSON.parse(JSON.stringify(realJob.toJSON())), service1, null);
assert.equal(roundtripped._failedTasks.length, 1);
assert.equal(roundtripped._failedTasks[0].task, '书/影/音/游');

// Drive real Service.startup() in a fresh Service instance to test pause -> cancel -> new job AND retry + Files re-run.
let photoCalls = 0, filesCalls = 0;
const loopDeser = synthetic({taskFromJSON: t => ({
    name: t.name,
    constructor: {name: t.taskType},
    init() {},
    async run() {
        if (t.taskType === 'Photo') photoCalls++;
        if (t.taskType === 'Files') filesCalls++;
    },
    toJSON() { return t; },
})});
const loopJobMod = new vm.SourceTextModule(source('services/Job.js'), {context});
await loopJobMod.link(s => ({
    '../service.js': module, './Task.js': realTaskMod, './TaskError.js': realTaskError,
    './AsyncBlockingQueue.js': queueModule, '../storage.js': realStorage,
    './task_deserialize.js': loopDeser, './diagnostics.js': diagnostics,
})[s]);
await loopJobMod.evaluate();
const LoopJob = loopJobMod.namespace.default;
const svcMod = new vm.SourceTextModule(source('service.js'), {context});
await svcMod.link(specifier => ({
    './settings.js': settings, './services/Job.js': loopJobMod,
    './services/AsyncBlockingQueue.js': queueModule,
    './services/StateChangeEvent.js': eventModule,
    './services/Logger.js': loggerModule,
    './services/diagnostics.js': diagnostics,
    './storage.js': realStorage,
    './tasks/migrate/MigrationTask.js': migrationHelpers,
})[specifier] || defaults);
await svcMod.evaluate();
const LoopService = svcMod.namespace.default;
const loopSvc = new LoopService();
loopSvc.saveState = async () => {};
LoopService._instance = loopSvc;
LoopService.getInstance = async () => loopSvc;
LoopService.startup();
let oldPrePause = 0, oldPostCancel = 0, newJobRuns = 0;
let releasePause;
const pauseHit = new Promise(r => { releasePause = r; });
const pausableJob = new LoopJob(loopSvc, null, null, false);
pausableJob.checkin = async () => pausableJob._session = {userId: 1, cookies: {}, userInfo: {id: 1}};
pausableJob.addTask({
    name: 'Pausable',
    init(fetch) { this.fetch = fetch; },
    async run() {
        oldPrePause++;
        releasePause();
        context.fetch = async () => ({status: 200});
        await this.fetch('https://example.test/paused', {}, true, 0);
        oldPostCancel++;
    },
    toJSON() { return {name: 'Pausable', taskType: 'Note'}; },
});
loopSvc._jobQueue.enqueue(pausableJob);
await loopSvc.start();
await pauseHit;
await loopSvc.stop();
await loopSvc.cancelCurrentJob();
assert.equal(oldPrePause, 1);
assert.equal(oldPostCancel, 0, 'cancelled job must exit before post-pause commit/steps');
const freshJob = new LoopJob(loopSvc, null, null, false);
freshJob.checkin = async () => freshJob._session = {userId: 1, cookies: {}, userInfo: {id: 1}};
freshJob.addTask({
    name: 'Fresh',
    init() {},
    async run() { newJobRuns++; },
    toJSON() { return {name: 'Fresh', taskType: 'Note'}; },
});
loopSvc._jobQueue.enqueue(freshJob);
await loopSvc.start();
for (let i = 0; i < 30 && (newJobRuns === 0 || loopSvc._status !== LoopService.STATE_STOPPED); i++) await tick();
assert.equal(newJobRuns, 1, 'new job must run cleanly after previous job was cancelled');
assert.equal(oldPostCancel, 0);

// Retry re-runs upstream Photo failure AND re-enables Files even if Files completed on old snapshot.
loopSvc._status = LoopService.STATE_STOPPED;
loopSvc._currentJob = null;
loopSvc._jobQueue = new (queueModule.namespace.default)();
const origCheckin = LoopJob.prototype.checkin;
LoopJob.prototype.checkin = async function () { return this._session = {userId: 1, cookies: {}, userInfo: {id: 1}}; };
loopSvc._lastJob = {
    targetUserId: null, localUserId: null, isOffline: false, isMigration: false, _id: 11,
    tasks: [{name: '相册', taskType: 'Photo'}, {name: '同步图片', taskType: 'Files'}],
    completedTaskTypes: ['Files'],
    failedTasks: [{task: '相册', error: 'fail'}],
    finishedAt: Date.now(),
};
assert.equal(await loopSvc.retryLastJob(), true);
for (let i = 0; i < 40 && loopSvc._status !== LoopService.STATE_STOPPED; i++) await tick();
LoopJob.prototype.checkin = origCheckin;
assert.equal(photoCalls, 1, 'retry must actually run the failed Photo task');
assert.equal(filesCalls, 1, 'retry must re-run Files after upstream Photo task');

// Adaptive pacing tiers: preserves normal accounts, slows large accounts/web pages, respects manual override & opt-out.
{
    const normal = Service.computePacing({baseInterval: 1000, adaptivePacing: true, estimatedItems: 400, requestCount: 10, isWebPage: false, expectedWebPages: 0, random: () => 0.5});
    assert.deepEqual(JSON.parse(JSON.stringify({tier: normal.tier, interval: normal.interval, active: normal.active})), {tier: 'normal', interval: 1000, active: false});

    const medium = Service.computePacing({baseInterval: 1000, adaptivePacing: true, estimatedItems: 2000, requestCount: 10, isWebPage: false, expectedWebPages: 0, random: () => 1});
    assert.equal(medium.tier, 'medium');
    assert.equal(medium.effectiveBase, 1500);
    assert.equal(medium.interval, 1850);
    assert.equal(medium.active, true);

    const largeWeb = Service.computePacing({baseInterval: 1000, adaptivePacing: true, estimatedItems: 7085, requestCount: 90, isWebPage: true, expectedWebPages: 473, random: () => 0});
    assert.equal(largeWeb.tier, 'large');
    assert.equal(largeWeb.effectiveBase, 2000);
    assert.equal(largeWeb.cooldown, 12000);
    assert.equal(largeWeb.interval, 14000);

    const manualLarger = Service.computePacing({baseInterval: 3000, adaptivePacing: true, estimatedItems: 7085, requestCount: 20, isWebPage: true, expectedWebPages: 473, random: () => 0});
    assert.equal(manualLarger.effectiveBase, 3000);

    const disabled = Service.computePacing({baseInterval: 1000, adaptivePacing: false, estimatedItems: 7085, requestCount: 90, isWebPage: true, expectedWebPages: 473});
    assert.equal(disabled.tier, 'manual');
    assert.equal(disabled.interval, 1000);
    assert.equal(disabled.active, false);

    const zero = Service.computePacing({baseInterval: 0, adaptivePacing: true, estimatedItems: 7085, requestCount: 90, isWebPage: true, expectedWebPages: 473});
    assert.equal(zero.interval, 0);

    // getFetchURL propagates _pacing onto _currentJob for large web jobs.
    const pacedSvc = {
        requestInterval: 1000,
        adaptivePacing: true,
        _currentJob: {tasks: [{total: 7085, completion: 0}]},
        logger: {debug() {}, error() {}},
        dispatchEvent() {},
        continue: async () => {},
    };
    const origWait = Service.waitWithKeepAlive;
    Service.waitWithKeepAlive = async () => {};
    context.fetch = async () => ({status: 200});
    const pacedFetch = Service.getFetchURL(pacedSvc);
    await pacedFetch('https://movie.douban.com/people/film101/collect?start=0', {}, false, 0);
    Service.waitWithKeepAlive = origWait;
    assert.equal(pacedSvc._currentJob._pacing.tier, 'large');
    assert.equal(pacedSvc._currentJob._pacing.effectiveMs, 2000);
    assert.equal(pacedSvc._currentJob._pacing.adaptive, true);
}

console.log('Service retry, cancel, credential stripping and Job roundtrip passed.');
