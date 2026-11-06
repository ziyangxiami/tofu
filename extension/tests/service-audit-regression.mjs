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
const settings = synthetic({default: {load: async () => ({}), apply() {}}});
const job = synthetic({default: FakeJob});
const diagnostics = synthetic({recordDiagnostic: async () => {}});
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
