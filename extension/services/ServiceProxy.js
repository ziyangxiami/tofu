/** A document owns one RPC channel. Never replay a submitted mutation. */
export default class ServiceProxy {
    constructor(initialPort, reconnect = null) {
        const eventTarget = new EventTarget();
        let port, disconnected = true, callIdCounter = 1;
        const pendingCalls = new Map();
        const finish = (id, error, value) => {
            const pending = pendingCalls.get(id);
            if (!pending) return;
            clearTimeout(pending.timer); pendingCalls.delete(id);
            if (error) pending.reject(error); else pending.resolve(value);
        };
        const attach = next => {
            port = next; disconnected = false;
            next.onMessage.addListener(message => {
                if (port !== next) return;
                if (message.type === 'syscall') {
                    finish(message.id, message.error ? new Error(message.error) : null, message.return);
                } else if (message.type) {
                    eventTarget.dispatchEvent(new CustomEvent(message.type, {detail: message.detail ?? message}));
                }
            });
            next.onDisconnect.addListener(() => {
                if (port !== next) return;
                disconnected = true;
                // Reading lastError prevents an unchecked runtime.lastError warning.
                if (typeof chrome !== 'undefined') void chrome.runtime?.lastError;
                for (const id of [...pendingCalls.keys()]) finish(id, new Error('后台连接已断开，操作结果可能尚未确认。请重新连接并查看任务状态。'));
                eventTarget.dispatchEvent(new Event('disconnect'));
            });
        };
        attach(initialPort);
        const call = (method, args, isProperty = false) => new Promise((resolve, reject) => {
            if (disconnected) {
                if (!reconnect) { reject(new Error('Service Worker 连接已断开，请刷新页面后重试')); return; }
                try { attach(reconnect()); } catch (error) { reject(error); return; }
            }
            const id = String(callIdCounter++);
            const timer = setTimeout(() => finish(id, new Error(isProperty ? '后台响应超时，请重新连接。' : '操作响应超时，结果尚未确认。请先查看任务中心，避免重复提交。')), 60000);
            pendingCalls.set(id, {resolve, reject, timer});
            try { port.postMessage({type: 'syscall', id, method, args, isProperty}); }
            catch (error) { finish(id, error); }
        });
        return new Proxy(eventTarget, {
            get(target, property) {
                if (property in target) {
                    const value = target[property];
                    return typeof value === 'function' ? value.bind(target) : value;
                }
                if (property === 'then' || typeof property === 'symbol') return undefined;
                if (property === 'getProperty') return name => call(name, undefined, true);
                return (...args) => call(property, args);
            }
        });
    }

    static getProxy() {
        if (!this.instance) {
            const connect = () => chrome.runtime.connect({name: 'ui-panel'});
            this.instance = new ServiceProxy(connect(), connect);
        }
        return this.instance;
    }
}
