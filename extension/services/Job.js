import Service from '../service.js';
import Task from "./Task.js";
import TaskError from "./TaskError.js";
import AsyncBlockingQueue from "./AsyncBlockingQueue.js";
import Storage from "../storage.js";

import {taskFromJSON} from "./task_deserialize.js";

/**
 * Class Job
 */
export default class Job extends EventTarget {
    /**
     * Constructor
     * @param {Service} service
     * @param {string|null} targetUserId
     * @param {string|null} localUserId
     * @param {boolean} isOffline
     */
    constructor(service, targetUserId, localUserId, isOffline) {
        super();
        this._service = service;
        this._targetUserId = targetUserId;
        this._localUserId = localUserId;
        this._tasks = [];
        this._isRunning = false;
        this._currentTask = null;
        this._id = null;
        this._session = null;
        this._isOffline = isOffline;
    }

    /**
     * Get user info
     * @param {Object} cookies
     * @param {string} userId
     */
    async getUserInfo(cookies, userId) {
        const URL_USER_INFO = 'https://m.douban.com/rexxar/api/v2/user/{uid}?ck={ck}&for_mobile=1';

        let userInfoURL = URL_USER_INFO
            .replace('{uid}', userId)
            .replace('{ck}', cookies.ck);
        let fetch = await Service.getFetchURL(this._service);
        return await (
            await fetch(userInfoURL, {headers: {'X-Override-Referer': 'https://m.douban.com/'}})
        ).json();
    }

    /**
     * Checkin account
     * @returns {object}
     */
    async checkin() {
        const URL_MINE = 'https://m.douban.com/mine/';

        let response = await fetch(URL_MINE, { credentials: 'include' });
        if (!response.ok) {
            throw new TaskError('豆瓣服务器返回错误');
        }
        if (response.redirected) {
            if (typeof chrome !== 'undefined' && chrome.tabs && chrome.tabs.create) {
                chrome.tabs.create({ url: response.url });
            }
            throw new TaskError('未登录豆瓣');
        }
        let bodyElement = Task.parseHTML(await response.text(), URL_MINE);
        let inputElement = bodyElement.querySelector('#user');
        if (!inputElement) {
            throw new TaskError('无法读取豆瓣用户信息，请确认是否已在浏览器中登录。');
        }
        let username = inputElement.getAttribute('data-name') || '';
        let uid = inputElement.getAttribute('value') || '';
        let homepageLink = bodyElement.querySelector('.profile .detail .basic-info>a');
        let homepageURL = homepageLink ? homepageLink.getAttribute('href') : '';
        let match = homepageURL ? homepageURL.match(/\/people\/([^\/]+)/) : null;
        let userSymbol = match ? match[1] : (uid || '');
        let cookiesNeeded = {
            'ue': '',
            'bid': '',
            'frodotk_db': '',
            'ck': '',
            'dbcl2': '',
        };
        let cookies = [];
        try {
            if (typeof chrome !== 'undefined' && chrome.cookies) {
                cookies = await new Promise(resolve => chrome.cookies.getAll({ domain: 'douban.com' }, resolve)) || [];
            }
        } catch (e) {
            console.error("Failed to get cookies in Job:", e);
        }

        if (Array.isArray(cookies)) {
            for (let cookie of cookies) {
                if (cookie && cookie.name && cookie.name in cookiesNeeded) {
                    cookiesNeeded[cookie.name] = cookie.value;
                }
            }
        }

        let userInfo = await this.getUserInfo(cookiesNeeded, uid);

        return this._session = {
            userId: parseInt(uid),
            username: username,
            userSymbol: userSymbol,
            cookies: cookiesNeeded,
            userInfo: userInfo,
            updated: Date.now(),
            isOther: false
        }
    }

    /**
     * Add a task
     * @param {Task} task
     */
    addTask(task) {
        this._tasks.push(task);
    }

    /**
     * Run the job
     */
    async run() {
        let logger = this._service.logger
        this._isRunning = true;

        let userId, account, targetUser, isOtherUser = false;

        if (this._isOffline) {
            userId = this._targetUserId;
            isOtherUser = true;
        } else {
            let session = await this.checkin();
            if (this._targetUserId) {
                let userInfo = await this.getUserInfo(session.cookies, this._targetUserId);
                this._targetUserId = userId = parseInt(userInfo.id);
                account = {
                    userId: userId,
                    username: userInfo.name,
                    userSymbol: userInfo.uid,
                    cookies: null,
                    userInfo: userInfo,
                    updated: Date.now(),
                    isOther: true
                };
                targetUser = userInfo;
                isOtherUser = true;
            } else {
                userId = session.userId;
                account = session;
                targetUser = session.userInfo;
            }
        }

        let storage = new Storage(this._localUserId || userId);
        await storage.global.open();
        logger.debug('Open global database');
        if (this._isOffline) {
            let account = await storage.global.account.get({userId: userId});
            if (!account) {
                logger.debug('The account does not exist');
                storage.global.close();
                return;
            }
            targetUser = account.userInfo;
        } else {
            await storage.global.account.put(account);
        }
        logger.debug('Create the account');
        let jobId = this._id;
        if (jobId === null || jobId === undefined) {
            jobId = await storage.global.job.add({
                userId: userId,
                created: Date.now(),
                progress: {},
                tasks: JSON.parse(JSON.stringify(this._tasks)),
            });
            logger.debug('Create the job');
        } else {
            // A restored in-flight job restarts its idempotent task loops, but it
            // must keep the original version. Creating a new job here advances
            // version markers before any rows are written and makes already
            // persisted partial results appear to have disappeared.
            logger.debug(`Resume the job [${jobId}]`);
        }
        storage.global.close();
        logger.debug('Close global database');
        this._id = jobId;
        // Store the assigned job/version id before the first task request. If the
        // worker is reclaimed in this window, the restored job must not allocate
        // another version and hide rows already written by this run.
        await this._service.saveState();

        await storage.local.open();
        logger.debug('Open local database');

        // 设置最大并发数
        const maxConcurrency = 3;  // 控制最大并发任务数
        const taskQueue = new AsyncBlockingQueue();

        let fetch = Service.getFetchURL(this._service);
        let deferredTasks = [];
        // 图片同步依赖其他备份任务写入的数据，必须在它们全部结束后执行。
        for (let task of this._tasks) {
            task.init(
                fetch,
                logger,
                jobId,
                this._session,
                storage.local,
                targetUser,
                isOtherUser
            );

            if (task.constructor.name === 'Files') {
                deferredTasks.push(task);
            } else {
                taskQueue.enqueue(task);
            }
        }

        // 处理任务，确保并发执行数不超过 maxConcurrency
        let activePromises = [];
        for (let i = 0; i < maxConcurrency; i++) {
            activePromises.push(this.runTaskQueue(taskQueue, logger));
        }

        // 等待所有任务完成
        await Promise.all(activePromises);

        for (let task of deferredTasks) {
            this._currentTask = task;
            try {
                await task.run();
            } catch (e) {
                console.error(e);
                logger.error(`Fail to run task [${task.name || task.constructor.name}]: ` + e);
                if (!this._failedTasks) this._failedTasks = [];
                this._failedTasks.push({ task: task.name || task.constructor.name, error: e.toString() });
            }
        }

        try {
            storage.local.close();
        } catch (e) {}
        logger.debug('Close local database');
        this._currentTask = null;
        this._isRunning = false;
    }

    /**
     * 处理任务队列中的任务
     */
    async runTaskQueue(queue, logger) {
        while (!queue.isEmpty()) {
            let task = await queue.dequeue();
            this._currentTask = task;
            try {
                await task.run();
            } catch (e) {
                console.error(e);
                logger.error(`Fail to run task [${task.name || task.constructor.name}]: ` + e);
                if (!this._failedTasks) this._failedTasks = [];
                this._failedTasks.push({ task: task.name || task.constructor.name, error: e.toString() });
            }
        }
    }

    /**
     * Whether the job is running
     * @returns {boolean}
     */
    get isRunning() {
        return this._isRunning;
    }

    /**
     * Get current task
     * @returns {Task|null}
     */
    get currentTask() {
        return this._currentTask;
    }

    /**
     * Get tasks
     * @returns {Array}
     */
    get tasks() {
        return this._tasks;
    }

    /**
     * Get job id
     * @returns {number|null}
     */
    get id() {
        return this._id;
    }

    /**
     * Convert to JSON string
     * @returns {string}
     */
    toJSON() {
        return {
            targetUserId: this._targetUserId,
            localUserId: this._localUserId,
            tasks: this._tasks.map(task => task.toJSON()), // 保存任务
            isOffline: this._isOffline,
            _id: this._id,
            _session: this._session,
            _isRunning: this._isRunning,
            _currentTask: this._currentTask ? this._currentTask.toJSON() : null,
        };
    }

    /**
     * Restore job from JSON
     * @param {Object} json
     * @param {Service} service
     * @param storage
     * @returns {Job}
     */
    static fromJSON(json, service, storage) {
        let fetch = Service.getFetchURL(service);
        const job = new Job(service, json.targetUserId, json.localUserId, json.isOffline);
        job._id = json._id;
        job._session = json._session;
        job._isRunning = json._isRunning;
        job._currentTask = json._currentTask ? taskFromJSON(json._currentTask, fetch, service.logger, storage) : null;

        // 恢复任务
        for (let taskJson of json.tasks) {
            const task = taskFromJSON(
                taskJson,
                fetch, // 传入 fetch
                service.logger, // 传入 logger
                storage // 传入 storage
            );
            job.addTask(task);
        }

        return job;
    }

}
