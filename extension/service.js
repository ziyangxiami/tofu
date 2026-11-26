'use strict';
import Settings, {SERVICE_SETTINGS} from './settings.js';
export {SERVICE_SETTINGS} from './settings.js';
import Job from './services/Job.js';
import AsyncBlockingQueue from "./services/AsyncBlockingQueue.js";
import StateChangeEvent from "./services/StateChangeEvent.js";
import Logger from "./services/Logger.js";
import {recordDiagnostic, newDiagnosticRunId} from './services/diagnostics.js';
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
import Storage from './storage.js';
import MigrateAnnotation from './tasks/migrate/annotation.js';
import MigrateBlacklist from './tasks/migrate/blacklist.js';
import MigrateFollow from './tasks/migrate/follow.js';
import MigrateInterest from './tasks/migrate/interest.js';
import MigrateNote from './tasks/migrate/note.js';
import MigrateReview from './tasks/migrate/review.js';
import {validId} from './tasks/migrate/MigrationTask.js';

const RPC_METHODS = new Set(['ping', 'start', 'stop', 'createJob', 'previewMigration', 'loadSettings', 'retryLastJob', 'cancelCurrentJob']);
const RPC_PROPERTIES = new Set(['status', 'currentJob', 'displayJob', 'debug', 'requestInterval', 'adaptivePacing', 'queuedJobCount', 'hasUnfinishedJobs', 'canRetryLastJob', 'serviceAction']);

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
    'status': Status,
    'migrate/annotation': MigrateAnnotation,
    'migrate/blacklist': MigrateBlacklist,
    'migrate/follow': MigrateFollow,
    'migrate/interest': MigrateInterest,
    'migrate/note': MigrateNote,
    'migrate/review': MigrateReview,
};

/**
 * Service settings
 */


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
        this._portCounter = 0;
        this._jobQueue = new AsyncBlockingQueue();
        this._continuations = [];
        this._status = Service.STATE_STOPPED;
        this.lastRequest = 0;
        this._debug = false;
        this._requestInterval = 1000;
        this._adaptivePacing = true;
        if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onConnect) {
            chrome.runtime.onConnect.addListener(port => this.onConnect(port));
        } else if (typeof browser !== 'undefined' && browser.runtime && browser.runtime.onConnect) {
            browser.runtime.onConnect.addListener(port => this.onConnect(port));
        }
        if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.onChanged) {
            chrome.storage.onChanged.addListener((changes, areaName) => {
                if (areaName === 'sync') {
                    this.loadSettings();
                }
            });
        }
    }

    toJSON() {
        return {
            _currentJob: this._currentJob ? this._currentJob.toJSON() : null, // 序列化当前任务
            _ports: [], // 运行时 Port 实例不可序列化
            lastJob: this._lastJob || null,
            _jobQueueTasks: this._jobQueue.items.map(job => job.toJSON()),
            _status: this._status,
            lastRequest: this.lastRequest,
            _debug: this._debug,
            _requestInterval: this._requestInterval,
            _adaptivePacing: this._adaptivePacing
        };
    }

    static fromJSON(json, service) {
        // Restore into the already registered singleton when one is supplied.
        // Constructing another Service here registers a second onConnect
        // listener: UI RPC calls can then enqueue work on that shadow instance
        // while the singleton startup loop waits forever on an empty queue.
        const instance = service || new Service();
        instance._currentJob = json._currentJob ? Job.fromJSON(json._currentJob, instance, instance.storage) : null; // 反序列化当前任务
        // Ports belong to this worker. In particular, keep connections accepted
        // while the asynchronous restore was still loading its snapshot.
        instance._status = json._status;
        instance.lastRequest = json.lastRequest;
        instance._debug = json._debug;
        instance._requestInterval = json._requestInterval !== undefined ? json._requestInterval : 1000;
        instance._adaptivePacing = json._adaptivePacing !== undefined ? json._adaptivePacing !== false : true;

        // 重新初始化任务队列
        instance._lastJob = json.lastJob || null;
        instance._jobQueue = new AsyncBlockingQueue();
        if (json._jobQueueTasks && json._jobQueueTasks.length > 0) {
            for (let jobJson of json._jobQueueTasks) {
                instance._jobQueue.enqueue(Job.fromJSON(jobJson, instance));
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
        this.logger.debug(`Service settings loaded. requestInterval=${this.requestInterval}ms, debug=${this.debug}`);
        return true;
    }

    /**
     * Get name
     */
    get name() {
        return 'service';
    }

    /**
     * Get request interval (ms)
     * @returns {number}
     */
    get requestInterval() {
        if (typeof this._requestInterval === 'number' && !isNaN(this._requestInterval) && this._requestInterval >= 0) {
            return this._requestInterval;
        }
        return 1000;
    }

    /**
     * Set request interval (ms)
     * @param {number} value
     */
    set requestInterval(value) {
        let parsed = parseInt(value, 10);
        this._requestInterval = !isNaN(parsed) && parsed >= 0 ? parsed : 1000;
    }

    get adaptivePacing() {
        return this._adaptivePacing !== false;
    }

    set adaptivePacing(value) {
        this._adaptivePacing = value !== false;
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
        let logger = this.logger;
        if (this._debug) {
            logger.level = logger.LEVEL_DEBUG;
            if (!this._logListener) {
                this._logListener = event => {
                    let entry = event.detail;
                    let datetime = new Date(entry.time).toISOString();
                    console.log(`[${datetime}] ${entry.levelName}: ${entry.message}`);
                    // Broadcast to UI via dispatcher override
                    this.dispatchEvent(new CustomEvent('log', { detail: entry }));
                };
                logger.addEventListener('log', this._logListener);
            }
        } else {
            logger.level = logger.LEVEL_INFO;
            if (this._logListener) {
                logger.removeEventListener('log', this._logListener);
                this._logListener = null;
            }
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
        if (port._portId) {
            return port._portId;
        }
        let tab = port.sender ? port.sender.tab : null;
        if (tab) {
            port._portId = `${port.name}-${tab.windowId}-${tab.id}-${++this._portCounter}`;
        } else {
            port._portId = `${port.name}-${(port.sender && port.sender.id) || 'ext'}-${Math.random().toString(36).substring(2, 9)}`;
        }
        return port._portId;
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
    async onMessage(port, message) {
        switch (message.type) {
            case 'syscall':
            let retVal;
            try {
                // The listener is registered synchronously on worker startup;
                // don't let an early UI request race with restoring its state.
                await this._initialization;
                const allowed = message.isProperty ? RPC_PROPERTIES : RPC_METHODS;
                if (!allowed.has(message.method)) throw new Error('不支持的后台操作');
                if (message.isProperty) {
                    retVal = this[message.method];
                } else {
                    retVal = await this[message.method].apply(this, message.args);
                }
                if (retVal && typeof retVal === 'object') {
                    if (typeof retVal.toPublicJSON === 'function') {
                        retVal = retVal.toPublicJSON();
                    } else if (typeof retVal.toJSON === 'function') {
                        retVal = retVal.toJSON();
                    } else if (retVal.constructor && retVal.constructor.name !== 'Object' && retVal.constructor.name !== 'Array') {
                        retVal = true;
                    }
                }
                this.postMessage(port, {
                    type: message.type,
                    id: message.id,
                    return: retVal
                });
            } catch (e) {
                console.error("RPC error:", e);
                this.postMessage(port, {
                    type: message.type,
                    id: message.id,
                    error: String(e)
                });
            }
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
    static withDatabaseLock(operation) {
        if (typeof navigator === 'undefined' || !navigator.locks) return operation();
        return navigator.locks.request('tofu-database-maintenance', {ifAvailable: true}, lock => {
            if (!lock) throw new Error('数据库正在导入、导出或删除，请稍后再启动任务。');
            return operation();
        });
    }

    static sanitizeJob(job) {
        if (!job) return null;
        if (typeof job.toPublicJSON === 'function') return job.toPublicJSON();
        const copy = {...job};
        delete copy._session;
        if (copy.finishedAt || copy.cancelled) {
            copy.activeTaskTypes = [];
            copy._currentTask = null;
        }
        if (Array.isArray(copy.tasks)) {
            copy.tasks = copy.tasks.map(task => {
                const taskCopy = {...task};
                delete taskCopy.session;
                delete taskCopy.targetUser;
                return taskCopy;
            });
        }
        if (copy._currentTask && typeof copy._currentTask === 'object') {
            copy._currentTask = {...copy._currentTask};
            delete copy._currentTask.session;
            delete copy._currentTask.targetUser;
        }
        return copy;
    }

    static isRetryableJob(job) {
        if (!job || job.cancelled || job.isMigration) return false;
        const tasks = Array.isArray(job.tasks) ? job.tasks : [];
        if (tasks.some(task => String(task?.taskType || task?.name || '').startsWith('Migrate'))) return false;
        const failed = Array.isArray(job.failedTasks) ? job.failedTasks.length : 0;
        const completed = Array.isArray(job.completedTaskTypes) ? job.completedTaskTypes.length : 0;
        return failed > 0 && tasks.length > completed;
    }

    async start() { return Service.withDatabaseLock(() => this._start()); }

    async _activateStart() {
        let originalState = this._status;
        if (originalState !== Service.STATE_STOPPED) return false;
        this._status = Service.STATE_START_PENDING;
        this.dispatchEvent(new StateChangeEvent(originalState, this._status));
        this.logger.debug('Starting service...');
        const continuations = this._continuations.splice(0);
        for (let continuation of continuations) continuation();
        await this.saveState();
        return true;
    }

    async _start() {
        console.log("service start")
        if (this._status !== Service.STATE_STOPPED) return false;
        if (!this._currentJob && this._jobQueue.isEmpty()) {
            if (this.canRetryLastJob) {
                return await this._retryLastJob();
            }
            return false;
        }
        return await this._activateStart();
    }

    async retryLastJob() { return Service.withDatabaseLock(() => this._retryLastJob()); }

    async _retryLastJob() {
        if (this._status !== Service.STATE_STOPPED || this._currentJob || !this._jobQueue.isEmpty() || !this.canRetryLastJob) {
            return false;
        }
        const IMAGE_PRODUCERS = new Set(['Photo', 'Note', 'Review', 'Annotation', 'Status']);
        const completed = new Set(Array.isArray(this._lastJob.completedTaskTypes) ? this._lastJob.completedTaskTypes : []);
        const hasPendingImageProducer = (this._lastJob.tasks || []).some(task =>
            IMAGE_PRODUCERS.has(task.taskType) && !completed.has(task.taskType));
        if (hasPendingImageProducer) completed.delete('Files');

        const accountId = this._lastJob.localUserId || this._lastJob.targetUserId || this._lastJob._session?.userId;
        if (accountId && this._lastJob._id) {
            const storage = new Storage(accountId);
            if (storage.global && typeof storage.global.open === 'function') {
                await storage.global.open();
                let account;
                try { account = await storage.global.account.get({userId: accountId}); }
                finally { storage.global.close(); }
                if (!account) {
                    this._lastJob = null;
                    await this.saveState();
                    throw new Error('对应账号的本地备份已删除，请新建完整备份。');
                }
                if (completed.size > 0 && storage.local && typeof storage.local.open === 'function') {
                    await storage.local.open();
                    try {
                        for (const taskType of completed) {
                            if (taskType === 'Files') continue;
                            const receipt = await storage.local.table('version').get('__snapshot_commit:' + taskType);
                            if (!receipt || receipt.version !== this._lastJob._id) {
                                this._lastJob = null;
                                await this.saveState();
                                throw new Error('部分已完成任务的本地快照已变更或缺失，请新建完整备份。');
                            }
                        }
                    } finally { storage.local.close(); }
                }
            }
        }

        const job = Job.fromJSON(this._lastJob, this, null);
        job._completedTaskTypes = [...completed];
        job._failedTasks = [];
        job._errorMessage = null;
        job._diagnosticRunId = newDiagnosticRunId();
        this._lastJob = null;
        this._jobQueue.enqueue(job);
        await this.saveState();
        return await this._activateStart();
    }

    async cancelCurrentJob() { return Service.withDatabaseLock(() => this._cancelCurrentJob()); }

    async _cancelCurrentJob() {
        if (this._status !== Service.STATE_STOPPED || !this._currentJob) return false;
        const job = this._currentJob;
        if (typeof job.cancel === 'function') job.cancel();
        if (this._runningJobPromise) {
            const continuations = this._continuations.splice(0);
            for (const continuation of continuations) continuation();
            await this._runningJobPromise.catch(() => undefined);
        }
        const userId = job._localUserId || job._targetUserId || job._session?.userId;
        if (userId && job._id) {
            try {
                await new Storage(userId).deleteTaskStages(userId, null, job._id);
            } catch (_) {}
        }
        this._lastJob = {
            ...Service.sanitizeJob(job),
            activeTaskTypes: [],
            _currentTask: null,
            cancelled: true,
            finishedAt: Date.now(),
        };
        this._currentJob = null;
        await this.saveState();
        this.dispatchEvent(new Event('progress'));
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
            case Service.STATE_START_PENDING:
            case Service.STATE_STOP_PENDING:
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
    async previewMigration(localUserId, tasks) {
        const sourceUserId = validId(localUserId);
        if (!Array.isArray(tasks) || !tasks.length) throw new Error('请选择迁移项目。');
        const selections = tasks.map(({name}) => {
            const key = String(name).toLowerCase();
            const TaskClass = TASK_MODULES[key];
            if (!key.startsWith('migrate/') || !TaskClass?.sourceTable) throw new Error('不支持的迁移项目。');
            return {name: key, table: TaskClass.sourceTable, label: new TaskClass().name};
        });
        const storage = new Storage(sourceUserId);
        try {
            await storage.global.open();
            const source = await storage.global.account.get({userId: sourceUserId});
            if (!source) throw new Error('找不到来源备份账号。');
            await storage.local.open();
            for (const selection of selections) {
                const version = await storage.local.table('version').get(selection.table);
                if (!version || !Number.isSafeInteger(version.version)) throw new Error(`${selection.label}没有已完成的备份。`);
                selection.version = version.version;
                selection.count = await storage.local.table(selection.table).filter(row => row.version === version.version).count();
            }
            // Preview performs reads even while the backup worker is stopped.
            const previewService = {requestInterval: this.requestInterval, logger: this.logger,
                continue: async () => {}, dispatchEvent: () => {}};
            const session = await new Job(previewService, null, null, false).checkin();
            return {sourceUserId, sourceName: source.username || String(sourceUserId),
                destinationUserId: session.userId, destinationName: session.username, selections};
        } finally {
            storage.global.close();
            if (storage._local) storage.local.close();
        }
    }

    async createJob(...args) { return Service.withDatabaseLock(() => this._createJob(...args)); }

    async _createJob(targetUserId, localUserId, tasks, isOffline = false, migrationPlan = null) {
        this.logger.debug('Creating a job...');
        if (!Array.isArray(tasks) || tasks.length === 0) {
            throw new Error('请至少选择一个有效的备份任务。');
        }
        let job = new Job(this, targetUserId, localUserId, isOffline);
        const migrating = tasks.some(task => String(task?.name).toLowerCase().startsWith('migrate/'));
        if (migrating && (isOffline || targetUserId || tasks.some(task => !String(task?.name).toLowerCase().startsWith('migrate/')))) {
            throw new Error('迁移任务不能与备份任务混用，也不能离线执行。');
        }
        if (migrating && (!migrationPlan || validId(localUserId) !== migrationPlan.sourceUserId)) {
            throw new Error('请先预览并确认迁移的来源和目标账号。');
        }
        const selected = new Set();
        for (let {name, args} of tasks) {
            const taskName = typeof name === 'string' ? name.toLowerCase() : '';
            if (!Object.prototype.hasOwnProperty.call(TASK_MODULES, taskName)) {
                throw new Error('不支持的任务类型：' + String(name));
            }
            if (args === undefined) args = [];
            if (!Array.isArray(args)) throw new Error('任务参数格式错误：' + name);
            // Construct the entire selection before enqueuing anything. A bad
            // item must not silently produce an empty or incomplete backup.
            const TaskClass = TASK_MODULES[taskName];
            const task = new TaskClass(...args);
            if (selected.has(taskName)) throw new Error('迁移或备份项目不能重复。');
            selected.add(taskName);
            if (migrating) {
                const selection = migrationPlan.selections?.find(item => item.name === taskName);
                if (!selection || selection.table !== TaskClass.sourceTable || !Number.isSafeInteger(selection.version)) {
                    throw new Error('迁移预览已失效，请重新确认。');
                }
                task.checkpoint = {kind: 'migration-v1', sourceUserId: validId(localUserId),
                    destinationUserId: validId(migrationPlan.destinationUserId), sourceVersion: selection.version,
                    receipts: {}};
            }
            job.addTask(task);
        }
        this._jobQueue.enqueue(job);
        await this.saveState();
        if (this._status === Service.STATE_STOPPED) {
            await this._start();
        }
        return typeof job.toPublicJSON === 'function' ? job.toPublicJSON() : job.toJSON();
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
                    this._continuations.push(resolve);
                };
                break;

            case Service.STATE_STOPPED:
                executor = resolve => {
                    this._continuations.push(resolve);
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
    get hasUnfinishedJobs() { return !!this._currentJob || !this._jobQueue.isEmpty(); }

    get queuedJobCount() { return this._jobQueue.length; }

    get canRetryLastJob() {
        return !this._currentJob && this._jobQueue.isEmpty() && Service.isRetryableJob(this._lastJob);
    }

    get serviceAction() {
        if (this._status === Service.STATE_START_PENDING || this._status === Service.STATE_RUNNING) return 'stop';
        if (this._status === Service.STATE_STOP_PENDING) return 'stopping';
        if (this._currentJob || !this._jobQueue.isEmpty()) return 'resume';
        if (this.canRetryLastJob) return 'retry';
        return 'idle';
    }

    get displayJob() { return Service.sanitizeJob(this._currentJob || this._lastJob || this._jobQueue.items[0] || null); }

    get currentJob() {
        return Service.sanitizeJob(this._currentJob);
    }

    static async getInstance() {
        if (!Service._instance) {
            // Register onConnect before the first await and publish the instance
            // immediately so simultaneous wake/install requests share one init.
            const instance = Service._instance = new Service();
            instance._initialization = (async () => {
                await instance.restoreState();
                await instance.loadSettings();
                return instance;
            })();
            instance._initialization.then(() => {
                Service.startup().catch(error => console.error('Service startup failed:', error));
            }, error => console.error('Service initialization failed:', error));
        }
        return Service._instance._initialization || Service._instance;
    }

    async saveState() {
        // Concurrent task workers can finish at the same time. Serialize writes
        // and capture the latest state when each write actually runs, so an older
        // snapshot cannot overwrite a newer task checkpoint.
        this._stateSaveChain = (this._stateSaveChain || Promise.resolve())
            .catch(() => undefined)
            .then(() => chrome.storage.session.set({serviceState: this.toJSON()}));
        await this._stateSaveChain;
        console.log('Service 状态已保存');
    }

    async restoreState() {
        const storedData = await chrome.storage.session.get("serviceState");
        if (storedData.serviceState) {
            const state = storedData.serviceState;
            const restoredService = Service.fromJSON(state, this); // 调用 fromJSON 方法反序列化

            // 将恢复的状态赋值给当前实例
            this._currentJob = restoredService._currentJob;
            this._lastJob = restoredService._lastJob;
            this._ports = restoredService._ports;
            this._jobQueue = restoredService._jobQueue;
            this._status = restoredService._status;
            this.lastRequest = restoredService.lastRequest;
            this._debug = restoredService._debug;
            this._requestInterval = restoredService._requestInterval;

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
            try {
                console.debug("RUN_FOREVER")
                await service.ready();
                if (!service._currentJob && service._jobQueue.isEmpty()) {
                    // A worker can be reclaimed after start() persisted START_PENDING
                    // but before it received a job. Restoring that snapshot must not
                    // leave the UI stuck on "waiting for task" forever.
                    await service.stop();
                    continue;
                }
                if (!service._currentJob) {
                    console.log('Waiting for the job...');
                    logger.debug('Waiting for the job...');
                    service._currentJob = await service._jobQueue.dequeue();
                    // Persist the dequeue before running. Otherwise a Service Worker
                    // restart restores the same job both as current and queued, so it
                    // is executed again from the beginning after it completes.
                    await service.saveState();
                }
                const activeJob = service._currentJob;
                try {
                    await service.continue();
                    console.log('Performing job...');
                    logger.debug('Performing job...');
                    service._runningJobPromise = activeJob.run();
                    await service._runningJobPromise;
                    if (!activeJob?._cancelled) {
                        const failedCount = activeJob._failedTasks?.length || 0;
                        if (failedCount) {
                            logger.warning(`Job finished with ${failedCount} failed task(s).`);
                        } else if (activeJob._emptyTasks?.length) {
                            logger.warning(`Job finished with ${activeJob._emptyTasks.length} empty task(s).`);
                        } else {
                            logger.debug('Job completed...');
                        }
                        const ownerUserId = activeJob._session?.userId;
                        service._lastJob = {
                            ...activeJob.toPublicJSON(),
                            _session: ownerUserId ? {userId: ownerUserId} : null,
                            finishedAt: Date.now(),
                        };
                        service._currentJob = null;
                        if (service._jobQueue.isEmpty()) {
                            // A drained queue is a completed backup, not an indefinitely
                            // running service waiting for another copy of the same job.
                            await service.stop();
                        }
                    }
                } catch (e) {
                    if (!activeJob?._cancelled) {
                        console.error(e)
                        logger.error(e);
                        if (activeJob) activeJob._errorMessage = e?.message || String(e);
                        await recordDiagnostic(activeJob?._diagnosticRunId, 'job.finished', {
                            outcome: 'failed', errorType: e?.name || 'Error', errorStack: e?.stack,
                        });
                        await service.stop();
                    }
                } finally {
                    service._runningJobPromise = null;
                    await service.saveState().catch(err => console.error('Service saveState failed:', err));
                }
            } catch (loopError) {
                console.error('Service loop error:', loopError);
                logger.error(loopError);
                service._status = Service.STATE_STOPPED;
                await new Promise(resolve => setTimeout(resolve, 1000));
            }
        }
    }

    static computePacing({baseInterval = 1000, adaptivePacing = true, estimatedItems = 0, requestCount = 0, isWebPage = false, expectedWebPages = 0, random = Math.random} = {}) {
        const base = typeof baseInterval === 'number' && !isNaN(baseInterval) && baseInterval >= 0 ? baseInterval : 1000;
        if (!adaptivePacing || base <= 0) {
            return {interval: base, effectiveBase: base, floor: 0, jitter: 0, cooldown: 0, tier: 'manual', active: false};
        }
        const items = Number.isFinite(estimatedItems) && estimatedItems > 0 ? estimatedItems : 0;
        const count = Number.isFinite(requestCount) && requestCount > 0 ? requestCount : 0;
        const webPages = Number.isFinite(expectedWebPages) && expectedWebPages > 0 ? expectedWebPages : 0;
        let floor = 0, jitterMax = 0, cooldown = 0, tier = 'normal';
        if (items >= 5000 || count >= 300 || (isWebPage && webPages >= 200)) {
            tier = 'large';
            floor = isWebPage ? 2000 : 1600;
            jitterMax = 450;
            cooldown = (count > 0 && count % 90 === 0) ? 12000 : 0;
        } else if (items >= 1500 || count >= 100 || (isWebPage && webPages >= 100)) {
            tier = 'medium';
            floor = 1500;
            jitterMax = 350;
            cooldown = (count > 0 && count % 100 === 0) ? 8000 : 0;
        }
        const effectiveBase = Math.max(base, floor);
        const active = tier !== 'normal';
        const jitter = active && jitterMax > 0 ? Math.round(random() * jitterMax) : 0;
        return {interval: effectiveBase + jitter + cooldown, effectiveBase, floor, jitter, cooldown, tier, active};
    }

    static getFetchURL(service, isCancelled = () => false) {
        let logger = service.logger;
        let lastRequest = 0;
        let requestCount = 0;
        let requestChain = Promise.resolve();
        const cancelError = () => Object.assign(new Error('任务已取消'), {name: 'TaskError'});

        let executeFetch = async (resource, init, continuous, retries) => {
            const method = String(init?.method ??
                (typeof Request !== 'undefined' && Request.prototype.isPrototypeOf(resource) ? resource.method : 'GET'))
                .toUpperCase();
            // A failed response does not establish whether a write reached the
            // server. Only safe read methods may be retried automatically.
            let attemptsLeft = ['GET', 'HEAD', 'OPTIONS'].includes(method) ? retries : 0;
            const urlStr = typeof resource === 'string' ? resource : (resource?.url || '');
            const isWebPage = /^https?:\/\/(?:movie|book|music|www)\.douban\.com\/people\//i.test(urlStr);

            while (true) {
                await service.continue();
                if (isCancelled()) throw cancelError();
                requestCount += 1;
                let baseInterval = (service && typeof service.requestInterval === 'number') ? service.requestInterval : 1000;
                const tasks = Array.isArray(service?._currentJob?.tasks) ? service._currentJob.tasks : [];
                const estimatedItems = tasks.reduce((max, t) => Math.max(
                    max,
                    Number.isFinite(t?.total) ? t.total : 0,
                    Number.isFinite(t?.completion) ? t.completion : 0
                ), 0);
                const expectedWebPages = isWebPage ? Math.ceil(estimatedItems / 15) : 0;
                const pacing = Service.computePacing({
                    baseInterval,
                    adaptivePacing: service?.adaptivePacing !== false,
                    estimatedItems,
                    requestCount,
                    isWebPage,
                    expectedWebPages,
                });
                let interval = pacing.interval;
                let delay = continuous ? 0 : lastRequest + interval - Date.now();
                const coolingDown = delay > 0 && pacing.cooldown > 0;
                if (service?._currentJob && typeof service._currentJob === 'object') {
                    service._currentJob._pacing = {
                        tier: pacing.tier,
                        effectiveMs: pacing.effectiveBase,
                        adaptive: pacing.active,
                        coolingDown,
                    };
                    if (coolingDown) service.dispatchEvent(new Event('progress'));
                }
                if (delay > 0) {
                    await Service.waitWithKeepAlive(delay);
                    if (coolingDown && service?._currentJob && typeof service._currentJob === 'object') {
                        service._currentJob._pacing = {
                            tier: pacing.tier,
                            effectiveMs: pacing.effectiveBase,
                            adaptive: pacing.active,
                            coolingDown: false,
                        };
                        service.dispatchEvent(new Event('progress'));
                    }
                    // The user may have stopped the service during a long wait.
                    await service.continue();
                    if (isCancelled()) throw cancelError();
                }

                try {
                    if (isCancelled()) throw cancelError();
                    // Request URLs can contain ck, and Request objects can carry
                    // private bodies or headers. Keep them out of service logs.
                    logger.debug(`Fetching request... (interval: ${interval}ms)`);

                    // 确保所有发给豆瓣的请求携带 credentials，否则会被当作未登录的机器流量拦截
                    let fetchInit = Object.assign({ credentials: 'include' }, init);

                    // 直接使用传入的 init 参数，不再修改 Header
                    let response = await fetch(resource, fetchInit);
                    if (isCancelled()) throw cancelError();
                    logger.debug(`Fetch response status: ${response.status}`);
                    service.dispatchEvent(new Event("progress"));
                    return response;
                } catch (error) {
                    if (attemptsLeft <= 0) {
                        console.error(error);
                        logger.error("Fetch error:", error);
                        throw error;
                    }
                    logger.debug(error);
                    logger.debug(`Attempt to fetch ${attemptsLeft} times...`);
                    attemptsLeft--;
                } finally {
                    // Failed network attempts count toward the same interval;
                    // otherwise retries can hammer the site without a pause.
                    lastRequest = Date.now();
                }
            }
        };

        return (resource, init = {}, continuous = false, retries = 2) => {
            // All task workers share one chain so the configured interval applies
            // globally instead of allowing several requests to wake at once.
            let result = requestChain.then(
                () => executeFetch(resource, init, continuous, retries),
                () => executeFetch(resource, init, continuous, retries)
            );
            requestChain = result.catch(() => undefined);
            return result;
        };
    }

    static async waitWithKeepAlive(delay) {
        const deadline = Date.now() + delay;
        const heartbeatInterval = 20000;

        while (Date.now() < deadline) {
            let remaining = deadline - Date.now();
            await new Promise(resolve => setTimeout(resolve, Math.min(remaining, heartbeatInterval)));
            if (Date.now() < deadline) {
                await Service.keepAlive();
            }
        }
    }

    static async keepAlive() {
        if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.getPlatformInfo) {
            return;
        }
        await new Promise(resolve => {
            try {
                chrome.runtime.getPlatformInfo(() => resolve());
            } catch (e) {
                resolve();
            }
        });
    }

}
