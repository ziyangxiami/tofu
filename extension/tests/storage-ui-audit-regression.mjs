// Run with: node --experimental-vm-modules extension/tests/storage-ui-audit-regression.mjs
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import vm from 'node:vm';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = name => readFileSync(resolve(root, name), 'utf8');
const context = vm.createContext({console, EventTarget, Event});
const importer = new vm.SourceTextModule(source('vendor/IDBExportImport.js'), {context});
await importer.link(() => { throw new Error('unexpected import'); });
await importer.evaluate();

function importFixture(tableNames, backup) {
    const writes = [];
    let transaction;
    const calls = [];
    importer.namespace.importFromJsonString({
        objectStoreNames: tableNames,
        transaction(names, mode) {
            assert.equal(mode, 'readwrite');
            transaction = {
                objectStore: name => ({add(row) { const request = {}; writes.push({name, row, request}); return request; }}),
                abort() { this.onabort({target: this}); },
            };
            return transaction;
        },
    }, JSON.stringify(backup), error => calls.push(error));
    return {writes, calls, transaction};
}

// A backup can omit stores added later. Only a committed transaction is success.
const restored = importFixture(['status', 'files', 'board'], {status: [{id: 1}], obsolete: [{id: 2}]});
assert.equal(restored.writes.length, 1);
assert.equal(restored.writes[0].name, 'status');
for (const {request} of restored.writes) request.onsuccess?.();
assert.equal(restored.calls.length, 0, 'request success must not report a committed restore');
restored.transaction.oncomplete();
assert.deepEqual(restored.calls, [null]);

// A transaction may abort after its last request succeeded; report one failure.
const aborted = importFixture(['status'], {status: [{id: 1}]});
aborted.writes[0].request.onsuccess?.();
aborted.transaction.error = new Error('commit failed');
aborted.transaction.onabort({target: aborted.transaction});
aborted.transaction.onerror({target: aborted.transaction});
assert.equal(aborted.calls.length, 1);
assert.match(aborted.calls[0].message, /commit failed/);
assert.equal(importFixture(['status'], {status: 'invalid'}).calls[0].name, 'TypeError');
assert.deepEqual(importFixture(['status'], {}).calls, [null]);

const importedFiles = [];
const opened = [];
const closed = [];
const dexieModule = new vm.SyntheticModule(['default'], function () {
    this.setExport('default', class Dexie {
        static async getDatabaseNames() { return ['tofu', 'tofu[1]', 'unrelated', 'tofu[invalid]']; }
        constructor(name) { this.name = name; }
        async open() { opened.push(this.name); }
        backendDB() { return this.name; }
        close() { closed.push(this.name); }
    });
}, {context});
const ioModule = new vm.SyntheticModule(['importFromJsonString', 'exportToJsonString'], function () {
    this.setExport('importFromJsonString', (db, json, callback) => {
        importedFiles.push({db, data: JSON.parse(json)});
        callback(null);
    });
    this.setExport('exportToJsonString', (db, callback) => callback(null, JSON.stringify({db})));
}, {context});
const zipModule = new vm.SyntheticModule(['strToU8', 'strFromU8', 'zip', 'unzip'], function () {
    this.setExport('strToU8', value => value);
    this.setExport('strFromU8', value => value);
    this.setExport('zip', (data, callback) => callback(null, data));
    this.setExport('unzip', (data, options, callback) => {
        callback(null, Object.fromEntries(Object.entries(data).filter(([name]) => options.filter({name}))));
    });
}, {context});
const storageModule = new vm.SourceTextModule(source('storage.js'), {context});
await storageModule.link(specifier => ({
    './vendor/dexie.js': dexieModule,
    './vendor/IDBExportImport.js': ioModule,
    './vendor/fflate.js': zipModule,
})[specifier]);
await storageModule.evaluate();
const Storage = storageModule.namespace.default;

const dumped = await new Storage().dump(() => {});
assert.deepEqual(Object.keys(dumped).sort(), ['database.json', 'tofu.json', 'tofu[1].json']);
assert.deepEqual(opened, ['tofu', 'tofu[1]']);
assert.deepEqual(closed, opened, 'exported database handles must be closed');

const accounts = new Map();
const jobs = new Map([[5, {id: 5, userId: 999, tasks: ['existing history']}]]);
let nextId = 6;
let transactionCount = 0;
const jobTable = {
    orderBy: () => ({last: async () => jobs.get(Math.max(...jobs.keys()))}),
    async add(row) {
        const id = row.id ?? nextId;
        assert(!jobs.has(id));
        nextId = Math.max(nextId, id + 1);
        jobs.set(id, row);
        return id;
    },
    async delete(id) { jobs.delete(id); },
};
const storage = new Storage();
storage._global = {
    open: async () => {}, close: () => {}, job: jobTable,
    account: {
        get: async ({userId}) => accounts.get(userId),
        put: async account => accounts.set(account.userId, account),
    },
    async transaction(mode, table, operation) {
        assert.equal(mode, 'rw');
        assert.equal(table, jobTable);
        transactionCount++;
        return await operation();
    },
};
storage.getLocalDb = id => ({open: async () => {}, close: () => {}, backendDB: () => `tofu[${id}]`});
const archive = {
    'database.json': JSON.stringify({global: {version: 2}, local: {version: 5, files: ['tofu[123]']}}),
    'tofu.json': JSON.stringify({account: [{userId: 123}], job: [{id: 77, tasks: ['must not resume']}] }),
    'tofu[123].json': JSON.stringify({following: [{id: 1, version: 90}], version: [{table: 'following', version: 90}]}),
};
const result = await storage.restore(archive, () => {});
assert.equal(result.successes.length, 1);
assert.equal(result.failures.length, 0);
assert.equal(accounts.has(123), true);
assert.equal(importedFiles.length, 1);
assert.equal(transactionCount, 2);
assert.equal(await jobTable.add({userId: 123}), 91, 'new backups must not reuse restored snapshot versions');
assert.equal(jobs.has(77), false, 'import must not restore runnable jobs');
assert.equal(jobs.has(90), false, 'temporary generator reservation must not remain in history');
assert.deepEqual(jobs.get(5).tasks, ['existing history']);

// Exercise popup state rendering with the same status values used by Service.
async function popupState(status) {
    const items = new Map(['Start', 'Stop'].map(name => [name, {
        disabled: false,
        setAttribute() { this.disabled = true; },
        removeAttribute() { this.disabled = false; },
    }]));
    const popupContext = vm.createContext({
        console, setTimeout, window: {},
        chrome: {runtime: {getURL: value => value}},
        document: {
            querySelector: () => ({querySelector: selector => items.get(selector.match(/name="(\w+)"/)[1])}),
            addEventListener: () => {},
        },
        Zepto: () => ({on: () => {}}),
    });
    const proxy = new vm.SyntheticModule(['default'], function () {
        this.setExport('default', {getProxy: () => ({getProperty: async () => status})});
    }, {context: popupContext});
    const popup = new vm.SourceTextModule(source('popup.js') + '\nexport {PopupMenu};', {context: popupContext});
    await popup.link(() => proxy);
    await popup.evaluate();
    await popup.namespace.PopupMenu.render();
    return items;
}
const stopped = await popupState(1);
assert.equal(stopped.get('Start').disabled, false);
assert.equal(stopped.get('Stop').disabled, true);
for (const status of [2, 3, 4]) {
    const active = await popupState(status);
    assert.equal(active.get('Start').disabled, true);
    assert.equal(active.get('Stop').disabled, false);
}
const unknown = await popupState(undefined);
assert.equal(unknown.get('Start').disabled, true);
assert.equal(unknown.get('Stop').disabled, true);

// Invalid location hashes must leave the selected tab usable, including hashes
// containing characters that would be invalid in a CSS attribute selector.
const classList = (...initial) => {
    const entries = new Set(initial);
    return {add: name => entries.add(name), remove: name => entries.delete(name), contains: name => entries.has(name)};
};
const tabs = ['general', 'service'].map((name, index) => ({dataset: {tab: name}, classList: classList(...(index ? [] : ['is-active']))}));
const contents = ['general', 'service'].map(name => ({getAttribute: () => name, classList: classList('is-hidden')}));
function collection(items) {
    return Object.assign([...items], {
        removeClass(name) { items.forEach(item => item.classList.remove(name)); },
        addClass(name) { items.forEach(item => item.classList.add(name)); },
        each(callback) { items.forEach((item, index) => callback(index, item)); },
    });
}
const tabContext = vm.createContext({
    EventTarget, Event, location: {hash: '#unknown"]'}, window: {addEventListener: () => {}},
    $: selector => collection(selector === '.tabs' ? tabs : contents),
});
const tabModule = new vm.SourceTextModule(source('ui/tab.js'), {context: tabContext});
await tabModule.link(() => {});
await tabModule.evaluate();
const panel = new tabModule.namespace.default('.tabs', '.contents');
assert.equal(panel.activeTab, contents[0]);
assert.equal(panel.toggle('unknown"]'), false);
assert.equal(contents[0].classList.contains('is-hidden'), false);
assert.equal(panel.toggle('service'), true);
assert.equal(panel.activeTab, contents[1]);

// Ratings in imported or older backups need not already be JavaScript numbers.
context.location = {search: '?123'};
context.XLSX = {utils: {
    book_new: () => [], aoa_to_sheet: data => data,
    book_append_sheet: (workbook, data, name) => workbook.push({data, name}),
}};
const unused = new vm.SyntheticModule(['default'], function () { this.setExport('default', {}); }, {context});
const explorer = new vm.SourceTextModule(source('explorer.js').split('\nlet tab = TabPanel.render();')[0] + '\nexport {Exporter, formatRating, SegmentsPanel};', {context});
await explorer.link(specifier => specifier === './storage.js' ? storageModule : unused);
await explorer.evaluate();
const ratings = ['8.25', null, 'unknown', 0].map(value => ({interest: {subject: {rating: {value}}}}));
const exporter = new explorer.namespace.Exporter();
await exporter.exportInterest({local: {interest: {
    where: () => ({reverse: () => ({each: async callback => ratings.forEach(callback)})}),
}}});
assert.deepEqual(Array.from(exporter.workbook[0].data.slice(1), row => row[2]), ['8.3', '', '', '0.0']);
assert.equal(explorer.namespace.formatRating({rating: null, null_rating_reason: '暂无评分'}), '暂无评分');

let segmentClick;
const chain = {
    parent() { return this; }, removeClass() { return this; }, addClass() { return this; },
    off() { return this; }, on(event, callback) { if (typeof callback === 'function') segmentClick = callback; return this; },
};
const segments = {querySelector: () => ({classList: classList()})};
const body = {innerHTML: ''};
context.$ = target => target === segments ? {find: () => chain} : chain;
const SegmentTest = class extends explorer.namespace.SegmentsPanel {
    onToggle() {}
    async load() { assert.equal(this.page, 1, 'switching category must restart pagination'); return 1; }
    paging() {}
};
const segmented = new SegmentTest({querySelector: selector => selector === '.segments.tabs' ? segments : body}, 5, 50);
await segmentClick({currentTarget: {}});
assert.equal(segmented.page, 1);

console.log('Storage/UI audit regression passed (import commit/abort, missing stores, restore version IDs, popup states, invalid hashes, rating export, category pagination).');
