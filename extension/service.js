'use strict';
import Settings from './settings.js';
import Storage from './storage.js';
import Job from './services/job.js';
import Task from "./services/Task.js";
import AsyncBlockingQueue from "./services/AsyncBlockingQueue.js";
import StateChangeEvent from "./services/StateChangeEvent.js";
import Logger from "./services/Logger.js";
import {taskFromJSON} from "./services/task_deserialize.js";
import Annotation from './tasks/annotation.js';
import Blacklist from './tasks/blacklist.js';
import Board from './tasks/board.js';
import Doulist from './tasks/doulist.js';
import Doumail from './tasks/doumail.js';
import Files from './tasks/files.js';
import Follower from './tasks/follower.js';
import Following from './tasks/following.js';
import Interest from './tasks/interest.js';
import Mock from './tasks/mock.js';
import Note from './tasks/note.js';
import Photo from './tasks/photo.js';
import Review from './tasks/review.js';
import Status from './tasks/status.js';

const TASK_MODULES = {
    'annotation': Annotation,
    'blacklist': Blacklist,
    'board': Board,
    'doulist': Doulist,
    'doumail': Doumail,
    'files': Files,
    'follower': Follower,
    'following': Following,
    'interest': Interest,
    'mock': Mock,
    'note': Note,
    'photo': Photo,
    'review': Review,
    'status': Status
};

/**
 * Service settings
 */
export const SERVICE_SETTINGS = {
    'service.debug': false,
    'service.requestInterval': 1000,
    'service.cloudinary': '',
};

/**
 * Class Service
 */
export default class Service extends EventTarget {
    static STATE_STOPPED = 1;
    static STATE_START_PENDING = 2;
    static STATE_STOP_PENDING = 3;
    static STATE_RUNNING = 4;

    /**
     * Constructor
     */
    constructor() {
        super();
        this._currentJob = null;
        this._ports = new Map();
        this._jobQueue = new AsyncBlockingQueue();
        this._status = Service.STATE_STOPPED;
        this.lastRequest = 0;
        this._debug = false;
        chrome.runtime.onConnect.addListener(port => this.onConnect(port));
    }

    toJSON() {
        return {
            _currentJob: this._currentJob ? this._currentJob.toJSON() : null, // 序列化当前任务
            _ports: Array.from(this._ports.entries()), // 将 Map 转换为数组
            _jobQueueTasks: this._jobQueue.promises.length > 0 ? this._jobQueue.promises : [], // 保存任务队列内容
            _status: this._status,
            lastRequest: this.lastRequest,
            _debug: this._debug
        };
    }

    static fromJSON(json, service) {
        const instance = new Service();
        instance._currentJob = json._currentJob ? Job.fromJSON(json._currentJob, service, service.storage) : null; // 反序列化当前任务
        instance._ports = new Map(json._ports); // 将数组转换回 Map
        instance._status = json._status;
        instance.lastRequest = json.lastRequest;
        instance._debug = json._debug;

        // 重新初始化任务队列
        instance._jobQueue = new AsyncBlockingQueue();
        if (json._jobQueueTasks && json._jobQueueTasks.length > 0) {
            for (let taskJson of json._jobQueueTasks) {
                instance._jobQueue.enqueue(taskFromJSON(taskJson, service.fetch, service.logger, service.storage));
            }
        }

        return instance;
    }


    /**
     * Load settings
     */
    async loadSettings() {
        let settings = await Settings.load(SERVICE_SETTINGS);
        Settings.apply(this, settings);
        this.logger.debug('Service settings loaded.');
        return this;
    }

    /**
     * Get name
     */
    get name() {
        return 'service';
    }

    /**
     * Get debug mode
     * @returns {boolean}
     */
    get debug() {
        return this._debug;
    }

    /**
     * Set debug mode
     * @param {boolean} value
     */
    set debug(value) {
        this._debug = value;
        if (this._debug) {
            let logger = this.logger;
            logger.level = logger.LEVEL_DEBUG;
            logger.addEventListener('log', event => {
                let entry = event.detail;
                let datetime = new Date(entry.time).toISOString();
                console.log(`[${datetime}] ${entry.levelName}: ${entry.message}`);
                // Broadcast to UI via dispatcher override
                this.dispatchEvent(new CustomEvent('log', { detail: entry }));
            })
        }
    }

    /**
     * Get logger
     * @returns {Logger}
     */
    get logger() {
        let logger = this._logger;
        if (!logger) {
            this._logger = logger = new Logger();
        }
        return logger;
    }

    /**
     * Get port unique name
     * @param {chrome.runtime.Port} port
     * @returns {string}
     */
    getPortName(port) {
        let tab = port.sender.tab;
        return `${port.name}-${tab.windowId}-${tab.id}`;
    }

    /**
     * On connect
     * @param {chrome.runtime.Port} port
     */
    onConnect(port) {
        this._ports.set(this.getPortName(port), port);
        port.onMessage.addListener(message => this.onMessage(port, message));
        port.onDisconnect.addListener(port => this.onDisconnect(port));
    }

    /**
     * Override dispatchEvent to broadcast events to UI ports in MV3
     */
    dispatchEvent(event) {
        let ret = super.dispatchEvent(event);
        if (event && event.type) {
            let message = { type: event.type };
            // Serialize necessary event properties to send to UI
            for (let key in event) {
                if (typeof event[key] !== 'function' && key !== 'detail') {
                    message[key] = event[key];
                }
            }
            if (event.detail !== undefined) {
                // Safely copy detail object
                try {
                    message.detail = JSON.parse(JSON.stringify(event.detail));
                } catch(e) { message.detail = event.detail; }
            }
            // For custom objects like task, serialize what we need or just broadcast state
            this.broadcast(message);
        }
        return ret;
    }

    /**
     * On disconnect
     * @param {chrome.runtime.Port} port
     */
    onDisconnect(port) {
        this._ports.delete(this.getPortName(port));
    }

    /**
     * On receive message
     * @param {chrome.runtime.Port} port
     * @param {any} message
     */
    onMessage(port, message) {
        switch (message.type) {
            case 'syscall':
            let retVal;
            if (message.isProperty) {
                retVal = this[message.method];
            } else {
                retVal = this[message.method].apply(this, message.args);
            }
            port.postMessage({
                type: message.type,
                id: message.id,
                return: retVal
            });
            break;
        }
    }

    /**
     * Post message
     * @param {chrome.runtime.Port} port
     * @param {any} message
     */
    postMessage(port, message) {
        try {
            return port.postMessage(message);
        } catch (e) {
            return false;
        }
    }

    /**
     * Broadcast message
     * @param {any} message
     */
    broadcast(message) {
        for (let port of this._ports.values()) {
            this.postMessage(port, message);
        }
    }

    /**
     * Ping test
     * @param {any} payload
     * @returns {string}
     */
    ping(payload) {
        return {'pang': payload};
    }

    /**
     * Get status code
     * @return {number}
     */
    get status() {
        return this._status;
    }

    /**
     * Start handling task queue
     */
    async start() {
        console.log("service start", this._jobQueue)
        let originalState = this._status;
        if (originalState !== Service.STATE_STOPPED) return false;
        this._status = Service.STATE_START_PENDING;
        this.dispatchEvent(new StateChangeEvent(originalState, this._status));
        this.logger.debug('Starting service...');
        if (this._continuation) {
            this._continuation();
        }
        await this.saveState();
        return true;
    }

    /**
     * Stop handling task queue
     */
    async stop() {
        console.log("service stop")
        let originalState = this._status;

        switch (originalState) {
            case Service.STATE_RUNNING:
            this._status = Service.STATE_STOP_PENDING;
            this.dispatchEvent(new StateChangeEvent(originalState, this._status));
            this.logger.debug('Stopping service...');
            break;

            case Service.STATE_START_PENDING:
            this._status = Service.STATE_STOPPED;
            this.dispatchEvent(new StateChangeEvent(originalState, this._status));
            this.logger.debug('Service stopped.');
            break;

            default:
            return false;
        }
        await this.saveState();
        return true;
    }

    /**
     * Create a job
     * @param  {string} targetUserId
     * @param  {string} localUserId
     * @param  {Array} tasks
     * @param  {boolean} isOffline
     */
    async createJob(targetUserId, localUserId, tasks, isOffline = false) {
        console.log(`service createJob targetUserId ${targetUserId} localUserId ${localUserId} isOffline ${isOffline}`, tasks)
        this.logger.debug('Creating a job...');
        let job = new Job(this, targetUserId, localUserId, isOffline);
        for (let {name, args} of tasks) {
            try {
                let taskName = name.toLowerCase();
                if (!TASK_MODULES[taskName]) throw new Error('Unknown task: ' + name);
                let module = TASK_MODULES[taskName];
                if (typeof args == 'undefined') {
                    args = [];
                }
                let task = new module(...args);
                console.log("add task", task)
                job.addTask(task);
            } catch (e) {
                console.error('Fail to create task:' + e)
                this.logger.error('Fail to create task:' + e);
            }
        }
        this._jobQueue.enqueue(job);
        await this.saveState();
        return job;
    }

    /**
     * Continue the task
     */
    continue() {
        console.log(`service continue ${this._status}`);
        let executor;
        let originalState = this._status;

        switch (originalState) {
            case Service.STATE_RUNNING:
                // let promise = Promise.resolve();
                // console.log(`service continue promise is undefined? ${promise === undefined}`);
                // return promise;
                return Promise.resolve();

            case Service.STATE_START_PENDING:
                executor = resolve => {
                    this._status = Service.STATE_RUNNING;
                    this.dispatchEvent(new StateChangeEvent(originalState, this._status));
                    this.logger.debug('Service started.');
                    resolve();
                };
                break;

            case Service.STATE_STOP_PENDING:
                executor = resolve => {
                    this._status = Service.STATE_STOPPED;
                    this.dispatchEvent(new StateChangeEvent(originalState, this._status));
                    this.logger.debug('Service stopped.');
                    this._continuation = resolve;
                };
                break;

            case Service.STATE_STOPPED:
                executor = resolve => {
                    this._continuation = resolve;
                };
                break;

            default:
                // 处理未定义的状态
                return Promise.resolve();
        }

        // await this.saveState();
        return new Promise(executor);
    }

    /**
     * Get ready for running task
     */
    async ready() {
        console.log("service ready")
        let originalState = this._status;
        switch (originalState) {
            case Service.STATE_RUNNING:
                this._status = Service.STATE_START_PENDING;
                this.dispatchEvent(new StateChangeEvent(originalState, this._status));
                this.logger.debug('Service is pending...');
                break;
            case Service.STATE_START_PENDING:
                return Promise.resolve();
        }
        await this.saveState();
        return this.continue();
    }

    /**
     * Get current job
     * @returns {Job|null}
     */
    get currentJob() {
        return this._currentJob;
    }

    static async getInstance() {
        // console.log(`getInstance _instance存在吗？ ${!!Service._instance}`)
        if (!Service._instance) {
            let storedData = await chrome.storage.session.get("serviceState");
            if (storedData.serviceState) {
                console.log("🔄 从存储恢复 Service 状态...");
                Service._instance = new Service();
                await Service._instance.restoreState();
            } else {
                console.log("🆕 创建新的 Service 实例...");
                Service._instance = new Service();
            }
            await Service._instance.loadSettings()
            Service.startup();
            await Service._instance.start();
        }
        return Service._instance;
    }

    async saveState() {
        const state = this.toJSON(); // 调用 toJSON 方法序列化
        await chrome.storage.session.set({ serviceState: state });
        console.log('Service 状态已保存');
    }

    async restoreState() {
        const storedData = await chrome.storage.session.get("serviceState");
        if (storedData.serviceState) {
            const state = storedData.serviceState;
            const restoredService = Service.fromJSON(state, this); // 调用 fromJSON 方法反序列化

            // 将恢复的状态赋值给当前实例
            this._currentJob = restoredService._currentJob;
            this._ports = restoredService._ports;
            this._jobQueue = restoredService._jobQueue;
            this._status = restoredService._status;
            this.lastRequest = restoredService.lastRequest;
            this._debug = restoredService._debug;

            console.log(`Service 状态已恢复`);
        }
    }


    /**
     * Startup service
     * @returns {Service}
     */
    static async startup() {
        console.log(`service startup state ${Service._instance._status}`)
        const RUN_FOREVER = true;

        let service = await Service.getInstance();
        // await service.loadSettings();
        let logger = service.logger;

        let lastRequest = 0;

        while (RUN_FOREVER) {
            console.debug("RUN_FOREVER")
            await service.ready();
            if (!service._currentJob) {
                console.log('Waiting for the job...');
                logger.debug('Waiting for the job...');
                service._currentJob = await service._jobQueue.dequeue();
            }
            try {
                await service.continue();
                console.log('Performing job...');
                logger.debug('Performing job...');
                await service._currentJob.run();
                console.log('Job completed...');
                logger.debug('Job completed...');
                service._currentJob = null;
            } catch (e) {
                console.error(e)
                logger.error(e);
                await service.stop();
            } finally {
                await service.saveState();
            }
        }
    }

    static async getFetchURL(service) {
        let logger = service.logger;
        let lastRequest = 0;

        return async (resource, init = {}, continuous = false, retries = 2) => {
            let promise =  service.continue();
            if(promise === undefined) {
                console.error("promise is undefined!");
            }
            let requestInterval = lastRequest + service.requestInterval - Date.now();

            // 如果请求间隔大于 0，则等待
            if (!continuous && requestInterval > 0) {
                promise = promise.then(() => {
                    return new Promise(resolve => {
                        setTimeout(resolve, requestInterval);
                    });
                });
            }

            let fetchResolve = () => {
                try {
                    let url = Request.prototype.isPrototypeOf(resource) ? resource.url : resource.toString();
                    lastRequest = Date.now();
                    console.log(`Fetching ${url}...`, resource);

                    // 确保所有发给豆瓣的请求携带 credentials，否则会被当作未登录的机器流量拦截
                    let fetchInit = Object.assign({ credentials: 'include' }, init);

                    // 直接使用传入的 init 参数，不再修改 Header
                    return fetch(resource, fetchInit).catch(e => {
                        if (retries > 0) {
                            logger.debug(e);
                            logger.debug(`Attempt to fetch ${retries} times...`);
                            retries--;
                            return fetchResolve();
                        } else {
                            throw e;
                        }
                    });
                } catch (error) {
                    console.error(error)
                    logger.error("Fetch error:", error);
                    return Promise.reject(error);
                }
            };
            if(promise === undefined) {
                console.error("then之前，promise is undefined!");
                promise = Promise.resolve()
            }
            promise = promise.then(fetchResolve);
            service.dispatchEvent(new Event("progress"));
            return promise;
        }
    }

}