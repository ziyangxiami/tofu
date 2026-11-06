/**
 * Class ServiceProxy extracted from assistant.js for MV3 UI to Background messaging
 */
export default class ServiceProxy {
    /**
     * Constructor
     * @param {chrome.runtime.Port} port 
     * @returns {Proxy}
     */
    constructor(port) {
        const eventTarget = new EventTarget();
        let callIdCounter = 1;
        let disconnected = false;
        const pendingCalls = new Map();

        port.onMessage.addListener(message => {
            if (message.type === 'syscall') {
                const pending = pendingCalls.get(message.id);
                if (!pending) return;
                pendingCalls.delete(message.id);
                if (message.error) pending.reject(new Error(message.error));
                else pending.resolve(message.return);
            } else if (message.type) {
                eventTarget.dispatchEvent(new CustomEvent(message.type, {
                    detail: message.detail !== undefined ? message.detail : message
                }));
            }
        });

        port.onDisconnect.addListener(() => {
            disconnected = true;
            const error = new Error('Service Worker 连接已断开，请刷新页面后重试');
            for (const pending of pendingCalls.values()) pending.reject(error);
            pendingCalls.clear();
        });

        const call = (method, args, isProperty = false) => new Promise((resolve, reject) => {
            if (disconnected) {
                reject(new Error('Service Worker 连接已断开，请刷新页面后重试'));
                return;
            }
            const id = String(callIdCounter++);
            // Register before sending: a reply or disconnect can arrive during
            // postMessage, and a serialization error must reject this same call.
            pendingCalls.set(id, {resolve, reject});
            try {
                port.postMessage({type: 'syscall', id, method, args, isProperty});
            } catch (error) {
                pendingCalls.delete(id);
                reject(error);
            }
        });

        return new Proxy(eventTarget, {
            get(target, property) {
                if (property in target) {
                    const value = target[property];
                    return typeof value === 'function' ? value.bind(target) : value;
                }
                // A service proxy is not a thenable. Promise assimilation and
                // reflection must not accidentally invoke background methods.
                if (property === 'then' || typeof property === 'symbol') return undefined;
                if (property === 'getProperty') return name => call(name, undefined, true);
                return (...args) => call(property, args);
            }
        });
    }

    /**
     * Get a connected proxy instance
     */
    static getProxy() {
        let port = chrome.runtime.connect({name: 'ui-panel'});
        return new ServiceProxy(port);
    }
}
