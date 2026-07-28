import TaskError from "./TaskError.js";
import Storage  from "../storage.js";
import parseHTMLNode from "./html_parser.js";

// Polyfill .dataset on node-html-parser elements in MV3 ServiceWorker context
try {
    let dummy = parseHTMLNode("<div></div>");
    if (dummy && dummy.constructor && dummy.constructor.prototype) {
        let proto = dummy.constructor.prototype;
        if (!Object.getOwnPropertyDescriptor(proto, "dataset")) {
            Object.defineProperty(proto, "dataset", {
                get() {
                    if (!this._datasetProxy) {
                        this._datasetProxy = new Proxy(this, {
                            get(target, prop) {
                                if (typeof prop !== "string" || prop === "then") return undefined;
                                let kebab = "data-" + prop.replace(/([A-Z])/g, "-$1").toLowerCase();
                                if (target.hasAttribute(kebab)) {
                                    return target.getAttribute(kebab);
                                }
                                let lower = "data-" + prop.toLowerCase();
                                if (target.hasAttribute(lower)) {
                                    return target.getAttribute(lower);
                                }
                                if (target.hasAttribute(prop)) {
                                    return target.getAttribute(prop);
                                }
                                return target.getAttribute(kebab);
                            }
                        });
                    }
                    return this._datasetProxy;
                },
                configurable: true
            });
        }
    }
} catch (e) {
    console.error('Failed to attach dataset polyfill:', e);
}

export default class Task {
    /**
     * Parse HTML
     * @param {string} html
     * @param {string} url
     * @returns {HTMLElement}
     */
    static parseHTML(html, url) {
        return parseHTMLNode(html, url);
    }

    /**
     * Initialize the task
     * @param {callback} fetch
     * @param {Logger} logger
     * @param {number} jobId
     * @param {Object} session
     * @param {Storage} localStorage
     * @param {Object} targetUser
     * @param {boolean} isOtherUser
     */
    init(fetch, logger, jobId, session, localStorage, targetUser, isOtherUser) {
        this.fetch = fetch;
        this.logger = logger;
        this.jobId = jobId;
        this.session = session;
        this.storage = localStorage;
        this.targetUser = targetUser;
        this.isOtherUser = isOtherUser;
        this.total = 1;
        this.completion = 0;
        this.parseHTML = Task.parseHTML
    }

    /**
     * Run task
     */
    async run() {
        throw new TaskError('Not implemented.');
    }

    toJSON() {
        let n = '';
        try { n = this.name; } catch(e) {}
        return {
            name: n,
            taskType: this.constructor.name, // 存储类名
            jobId: this.jobId,
            session: this.session,
            targetUser: this.targetUser,
            isOtherUser: this.isOtherUser,
            total: this.total,
            completion: this.completion,
            // 忽略不可序列化的成员变量：fetch、logger、parseHTML、storage
        };
    }

    /**
     * Get task name
     * @returns {string}
     */
    get name() {
        throw new TaskError('Not implemented.');
    }

    /**
     * Task completed
     */
    complete() {
        this.completion = this.total;
    }

    /**
     * Progress step
     */
    step() {
        this.completion += 1;
    }
}