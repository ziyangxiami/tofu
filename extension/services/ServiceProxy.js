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
        let eventTarget = new EventTarget();
        let callIdCounter = 1;
        let pendingCalls = new Map();
        
        // Listen to events from the port
        port.onMessage.addListener(message => {
            if (message.type === 'syscall') {
                eventTarget.dispatchEvent(new CustomEvent(message.id, {
                    detail: { return: message.return, error: message.error }
                }));
            } else if (message.type) {
                // Forward events for UI updates
                eventTarget.dispatchEvent(new CustomEvent(message.type, {
                    detail: message.detail !== undefined ? message.detail : message
                }));
            }
        });

        port.onDisconnect.addListener(() => {
            const err = new Error('Service Worker 连接已断开');
            for (let [callId, reject] of pendingCalls.entries()) {
                reject(err);
            }
            pendingCalls.clear();
        });

        // Add standard EventTarget listener capability to proxy
        eventTarget.originalAddEventListener = eventTarget.addEventListener;

        return new Proxy(eventTarget, {
            get(target, property, receiver) {
                // Proxy EventTarget methods natively
                if (property === 'addEventListener') {
                    return (...args) => target.originalAddEventListener.apply(target, args);
                }
                
                if (property in target) {
                    const val = target[property];
                    if (typeof val === 'function') {
                        return (...args) => val.apply(target, args);
                    }
                    return val;
                }

                // Any unknown property becomes an RPC to the background service!
                // If it's a known property request function
                if (property === 'getProperty') {
                    return (propName) => {
                        let callId = (callIdCounter ++).toString();
                        port.postMessage({
                            type: 'syscall',
                            id: callId,
                            method: propName, 
                            isProperty: true
                        });
                        return new Promise((resolve, reject) => {
                            pendingCalls.set(callId, reject);
                            target.originalAddEventListener(callId, event => {
                                pendingCalls.delete(callId);
                                if (event.detail && event.detail.error) {
                                    reject(new Error(event.detail.error));
                                } else {
                                    resolve(event.detail ? event.detail.return : undefined);
                                }
                            }, {once: true});
                        });
                    }
                }

                // Normal method call RPC
                return (...args) => {
                    let callId = (callIdCounter ++).toString();
                    port.postMessage({
                        type: 'syscall',
                        id: callId,
                        method: property,
                        args: args
                    });
                    return new Promise((resolve, reject) => {
                        pendingCalls.set(callId, reject);
                        target.originalAddEventListener(callId, event => {
                            pendingCalls.delete(callId);
                            if (event.detail && event.detail.error) {
                                reject(new Error(event.detail.error));
                            } else {
                                resolve(event.detail ? event.detail.return : undefined);
                            }
                        }, {once: true});
                    });
                }
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
