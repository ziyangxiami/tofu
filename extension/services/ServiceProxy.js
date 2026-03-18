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
        
        // Listen to events from the port
        port.onMessage.addListener(message => {
            if (message.type === 'syscall') {
                eventTarget.dispatchEvent(new CustomEvent(message.id, {detail: message.return}));
            } else if (message.type === 'progress' || message.type === 'statechange') {
                // Forward events for UI updates
                eventTarget.dispatchEvent(new CustomEvent(message.type, {detail: message}));
            }
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
                        return new Promise((resolve) => {
                            target.originalAddEventListener(callId, event => resolve(event.detail), {once: true});
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
                    return new Promise((resolve) => {
                        target.originalAddEventListener(callId, event => resolve(event.detail), {once: true});
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
