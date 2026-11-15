import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import vm from 'node:vm';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const signal = () => { const listeners=[]; return {addListener:fn=>listeners.push(fn), emit:value=>listeners.forEach(fn=>fn(value))}; };
const ports=[], timers=new Map(); let nextTimer=0;
class CustomEvent extends Event { constructor(type, options={}) {super(type);this.detail=options.detail;} }
const chrome={runtime:{connect() {
    const port={onMessage:signal(),onDisconnect:signal(),sent:[],postMessage(message){this.sent.push(message);}};
    ports.push(port);return port;
}},storage:{sync:{}}};
const context=vm.createContext({chrome, EventTarget, Event, CustomEvent, console,
    setTimeout: fn=>{timers.set(++nextTimer,fn);return nextTimer;},clearTimeout:id=>timers.delete(id)});
const module=new vm.SourceTextModule(readFileSync(resolve(root,'services/ServiceProxy.js'),'utf8'),{context});
await module.link(()=>{});await module.evaluate();
const Proxy=module.namespace.default, service=Proxy.getProxy();
assert.equal(service,Proxy.getProxy());assert.equal(ports.length,1);
const first=service.getProperty('status');const sent=ports[0].sent[0];
ports[0].onMessage.emit({type:'syscall',id:sent.id,return:1});assert.equal(await first,1);assert.equal(timers.size,0);
const mutation=service.createJob(null,null,[{name:'Note'}]);const rejected=assert.rejects(mutation,/尚未确认/);
ports[0].onDisconnect.emit();await rejected;assert.equal(timers.size,0);
const resumed=service.getProperty('displayJob');assert.equal(ports.length,2);
assert.deepEqual(ports[1].sent.map(message=>message.method),['displayJob'],'reconnect must not replay createJob');
ports[1].onMessage.emit({type:'syscall',id:ports[1].sent[0].id,return:null});assert.equal(await resumed,null);
const timeout=service.createJob();const timeoutRejected=assert.rejects(timeout,/避免重复提交/);
[...timers.values()][0]();await timeoutRejected;assert.equal(timers.size,0);
const oldId=ports[1].sent.at(-1).id;
ports[1].onMessage.emit({type:'syscall',id:oldId,return:true});
const later=service.getProperty('status');
ports[1].onMessage.emit({type:'syscall',id:ports[1].sent.at(-1).id,return:4});assert.equal(await later,4);
assert.equal(await Promise.resolve(service),service,'proxy must not become a thenable');

const settingsModule=new vm.SourceTextModule(readFileSync(resolve(root,'settings.js'),'utf8'),{context});
await settingsModule.link(()=>{});await settingsModule.evaluate();
const Settings=settingsModule.namespace.default;
chrome.storage.sync.set=(_,callback)=>{chrome.runtime.lastError={message:'quota exceeded'};callback();delete chrome.runtime.lastError;};
await assert.rejects(Settings.save({'service.debug':true}),/quota exceeded/);
chrome.storage.sync.get=(_,callback)=>{chrome.runtime.lastError={message:'sync unavailable'};callback();delete chrome.runtime.lastError;};
await assert.rejects(Settings.load({'service.debug':false}),/sync unavailable/);
chrome.storage.sync.set=(_,callback)=>callback();await Settings.save({'service.debug':false});
chrome.storage.sync.get=(_,callback)=>callback({});
assert.equal((await Settings.load({'service.debug':false}))['service.debug'],false);
console.log('UI state regression: RPC reconnection, no mutation replay, timeout cleanup and settings error propagation passed.');
