// Load the real background import graph without window/document or network access.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {webcrypto} from 'node:crypto';
import vm from 'node:vm';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const signal = () => ({listeners: [], addListener(listener) { this.listeners.push(listener); }});
const errors = [];
let ruleUpdates = 0;
class CustomEvent extends Event {
    constructor(type, options = {}) { super(type); this.detail = options.detail; }
}
const chrome = {
    runtime: {onConnect: signal(), onInstalled: signal(), onSuspend: signal(),
        getManifest: () => ({version: 'test'})},
    storage: {
        onChanged: signal(),
        session: {get: async () => ({}), set: async () => {}},
        sync: {get: (keys, callback) => callback({})},
    },
    declarativeNetRequest: {updateDynamicRules: async rules => {
        assert(rules.addRules.length && rules.removeRuleIds.length);
        ruleUpdates++;
    }},
};
const context = vm.createContext({chrome, crypto: webcrypto, Event, EventTarget, CustomEvent,
    URL, Request, Blob, TextEncoder, TextDecoder, setTimeout, clearTimeout, queueMicrotask,
    console: {log() {}, debug() {}, warn() {}, error: (...args) => errors.push(args)},
    fetch: async () => { throw new Error('smoke test must not make requests'); },
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
const background = create(resolve(root, 'background.js'));
await background.link((specifier, referencing) => modules.get(resolve(dirname(referencing.identifier), specifier)));
await background.evaluate();
await new Promise(resolve => setImmediate(resolve));
assert.equal(errors.length, 0, 'real worker import graph must initialize without document/window');
assert.equal(chrome.runtime.onConnect.listeners.length, 1);
for (const listener of chrome.runtime.onInstalled.listeners) await listener();
await new Promise(resolve => setImmediate(resolve));
assert.equal(ruleUpdates, 1);
assert.equal(chrome.runtime.onConnect.listeners.length, 1, 'install event must reuse the singleton');
const replies = [];
const port = {name: 'smoke', onMessage: signal(), onDisconnect: signal(), postMessage: value => replies.push(value)};
chrome.runtime.onConnect.listeners[0](port);
port.onMessage.listeners[0]({type: 'syscall', method: 'status', isProperty: true, id: 'status'});
await new Promise(resolve => setImmediate(resolve));
assert.equal(replies[0].return, 1);
assert.equal(errors.length, 0);
console.log(`background smoke: ${modules.size} real modules initialized; install rules and UI RPC passed`);
