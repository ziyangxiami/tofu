import Service from '../service.js';
import Task from "./Task.js";
import TaskError from "./TaskError.js";
import AsyncBlockingQueue from "./AsyncBlockingQueue.js";
import Storage from "../storage.js";

import {taskFromJSON} from "./task_deserialize.js";
import {newDiagnosticRunId, recordDiagnostic} from './diagnostics.js';

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
        this._diagnosticRunId = newDiagnosticRunId();
        this._completedTaskTypes = [];
        this._emptyTasks = [];
    }

    /**
     * Get user info
     * @param {Object} cookies
     * @param {string} userId
     */
    async getUserInfo(cookies, userId) {
        const URL_USER_INFO = 'https://m.douban.com/rexxar/api/v2/user/{uid}?ck={ck}&for_mobile=1';

        let userInfoURL = URL_USER_INFO
            .replace('{uid}', encodeURIComponent(userId))
            .replace('{ck}', encodeURIComponent(cookies.ck || ''));
        let fetch = await Service.getFetchURL(this._service);
        const response = await fetch(userInfoURL, {headers: {'X-Override-Referer': 'https://m.douban.com/'}});
        if (!response.ok) {
            throw new TaskError(`豆瓣用户接口返回错误（HTTP ${response.status}），请稍后重试。`);
        }
        let userInfo;
        try {
            userInfo = await response.json();
        } catch (e) {
            throw new TaskError('豆瓣用户接口未返回有效数据，请确认登录及验证状态。');
        }
        if (!userInfo || !/^[1-9]\d*$/.test(String(userInfo.id)) ||
            !Number.isSafeInteger(Number(userInfo.id))) {
            throw new TaskError('豆瓣用户接口未返回有效用户信息，请确认登录及验证状态。');
        }
        if (/^[1-9]\d*$/.test(String(userId)) && Number(userInfo.id) !== Number(userId)) {
            throw new TaskError('豆瓣用户接口账号不一致，请确认目标账号后重试。');
        }
        return userInfo;
    }

    /**
     * Checkin account
     * @returns {object}
     */
    async checkin() {
        const URL_MINE = 'https://m.douban.com/mine/';

        let response = await fetch(URL_MINE, { credentials: 'include', cache: 'no-store' });
        const finalURL = new URL(response.url || URL_MINE);
        if (finalURL.protocol !== 'https:' ||
            !(finalURL.hostname === 'douban.com' || finalURL.hostname.endsWith('.douban.com'))) {
            throw new TaskError('豆瓣登录检查返回了异常页面，请在豆瓣网站确认登录状态。');
        }
        const needsVerification = finalURL.hostname === 'sec.douban.com' ||
            /\/(?:captcha|challenge)(?:\/|$)/i.test(finalURL.pathname);
        const needsLogin = finalURL.hostname === 'accounts.douban.com' ||
            /\/(?:login|passport)(?:\/|$)/i.test(finalURL.pathname);
        if (needsVerification || needsLogin) {
            throw new TaskError(needsVerification ?
                '豆瓣需要安全验证，请在豆瓣网页完成验证后重新开始备份。' :
                '未登录豆瓣，请在浏览器中登录后重新开始备份。');
        }
        if (!response.ok) {
            throw new TaskError(`豆瓣服务器返回错误（HTTP ${response.status}）`);
        }
        // A normal mobile-page redirect is not evidence that the session expired.
        // Read the final page and verify its account before starting any writes.
        let bodyElement = Task.parseHTML(await response.text(), finalURL.href);
        let inputElement = bodyElement.querySelector('#user');
        if (!inputElement) {
            throw new TaskError('无法读取豆瓣用户信息，请确认是否已在浏览器中登录。');
        }
        let username = inputElement.getAttribute('data-name') || '';
        let uid = inputElement.getAttribute('value') || '';
        if (!/^[1-9]\d*$/.test(uid) || !Number.isSafeInteger(Number(uid))) {
            throw new TaskError('无法读取有效的豆瓣用户 ID，请确认登录状态后重试。');
        }
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
        if (Number(userInfo.id) !== Number(uid)) {
            throw new TaskError('豆瓣页面与用户接口的账号不一致，请重新登录后重试。');
        }
        if (this._id !== null && this._id !== undefined && this._session &&
            Number(this._session.userId) !== Number(uid)) {
            throw new TaskError('豆瓣登录账号已改变，请切回原账号继续备份，或新建备份任务。');
        }

        return this._session = {
            userId: Number(uid),
            username: username || userInfo.name || '',
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
        this._isRunning = true;
        try {
            await this._run();
        } finally {
            this._currentTask = null;
            this._isRunning = false;
        }
    }

    async _run() {
        let logger = this._service.logger
        this._failedTasks = [];
        const isMigration = this._tasks.some(task => task.isMigration);
        if (isMigration && (this._isOffline || this._tasks.some(task => !task.isMigration))) {
            throw new TaskError('迁移必须在线单独运行，不能与备份任务混合。');
        }
        await recordDiagnostic(this._diagnosticRunId, 'job.started', {
            count: this._tasks.length,
            isOther: !!this._targetUserId || this._isOffline,
        });

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
        let jobId = this._id;
        try {
            if (this._isOffline) {
                let account = await storage.global.account.get({userId: userId});
                if (!account) {
                    logger.debug('The account does not exist');
                    return;
                }
                targetUser = account.userInfo;
            } else if (!isMigration) {
                const previous = await storage.global.account.get({userId});
                // Login time is not a successful backup time. First failures
                // have no completion timestamp; migrations create no target card.
                await storage.global.account.put({...account, updated: previous?.updated || null});
            }
            logger.debug('Create the account');
            if (jobId === null || jobId === undefined) {
                jobId = await storage.global.job.add({
                    userId: userId,
                    created: Date.now(),
                    progress: {},
                    tasks: JSON.parse(JSON.stringify(this._tasks)),
                });
                logger.debug('Create the job');
            } else {
                // A restored job keeps the version of its partial results.
                logger.debug(`Resume the job [${jobId}]`);
            }
        } finally {
            storage.global.close();
            logger.debug('Close global database');
        }
        this._id = jobId;
        // Store the assigned job/version id before the first task request. If the
        // worker is reclaimed in this window, the restored job must not allocate
        // another version and hide rows already written by this run.
        await this._service.saveState();

        await storage.local.open();
        logger.debug('Open local database');
        try {
            // 设置最大并发数
            const maxConcurrency = 3;  // 控制最大并发任务数
            const taskQueue = new AsyncBlockingQueue();

            let fetch = Service.getFetchURL(this._service);
            let deferredTasks = [];
            // 图片同步依赖其他备份任务写入的数据，必须在它们全部结束后执行。
            for (let task of this._tasks) {
                if (this._completedTaskTypes.includes(task.constructor.name)) {
                    await recordDiagnostic(this._diagnosticRunId, 'task.skipped', {
                        task: task.constructor.name,
                    });
                    continue;
                }
                task.init(
                    fetch,
                    logger,
                    jobId,
                    this._session,
                    storage.local,
                    targetUser,
                    isOtherUser
                );
                task.diagnosticRunId = this._diagnosticRunId;
                task.saveCheckpoint = () => this._service.saveState();
                task.createSnapshot = task.isMigration ? null :
                    () => storage.createTaskSnapshot(jobId, task.constructor.name);
                task.onPublished = task.isMigration ? null :
                    publishedAt => storage.markAccountPublished(userId, publishedAt);

                if (task.constructor.name === 'Files') {
                    deferredTasks.push(task);
                } else {
                    taskQueue.enqueue(task);
                }
            }

            if (isMigration) {
                // A pending or failed write in one migration must stop every
                // later migration type; uncertain actions are never overlapped.
                while (!taskQueue.isEmpty() && !this._failedTasks.length) {
                    await this.runSingleTask(await taskQueue.dequeue(), logger);
                }
            } else {
                let activePromises = [];
                for (let i = 0; i < maxConcurrency; i++) {
                    activePromises.push(this.runTaskQueue(taskQueue, logger));
                }
                await Promise.all(activePromises);
            }

            for (let task of deferredTasks) {
                await this.runSingleTask(task, logger);
            }

        } finally {
            storage.local.close();
            logger.debug('Close local database');
        }
        await recordDiagnostic(this._diagnosticRunId, 'job.finished', {
            outcome: this._failedTasks.length ? 'failed' : (this._emptyTasks.length ? 'empty' : 'completed'),
            failedCount: this._failedTasks.length,
            emptyCount: this._emptyTasks.length,
            total: this._tasks.length,
        });
    }

    /**
     * 处理任务队列中的任务
     */
    async runTaskQueue(queue, logger) {
        while (!queue.isEmpty()) {
            let task = await queue.dequeue();
            await this.runSingleTask(task, logger);
        }
    }

    async runSingleTask(task, logger) {
        this._currentTask = task;
        const taskType = task.constructor.name;
        await recordDiagnostic(this._diagnosticRunId, 'task.started', {task: taskType});
        let snapshot;
        const publishedStorage = task.storage;
        try {
            snapshot = task.createSnapshot ? await task.createSnapshot() : null;
            if (snapshot?.published) {
                task.completion = snapshot.result?.completion ?? task.completion;
                task.total = snapshot.result?.total ?? task.total;
                task.checkpoint = null;
            } else {
                if (snapshot) {
                    task.storage = snapshot.database;
                    // A lost/aborted staging initialization invalidates a saved
                    // page checkpoint. Restart rather than publish missing rows.
                    if (snapshot.resetCheckpointRequired) {
                        task.checkpoint = null;
                        await this._service.saveState();
                        await snapshot.acknowledgeCheckpointReset();
                    }
                }
                await task.run();
            }
            const outcome = snapshot?.published ? snapshot.result?.outcome || 'completed' :
                (taskType === 'Annotation' && task.completion === 0 ? 'empty' : 'completed');
            if (snapshot && !snapshot.published) {
                const publishedAt = await snapshot.commit({outcome, completion: task.completion, total: task.total});
                if (task.onPublished) await task.onPublished(publishedAt);
            } else if (snapshot?.published && task.onPublished) {
                await task.onPublished(snapshot.publishedAt);
            }
            if (outcome === 'empty') this._emptyTasks.push(taskType);
            if (!this._completedTaskTypes.includes(taskType)) {
                this._completedTaskTypes.push(taskType);
            }
            await this._service.saveState();
            await recordDiagnostic(this._diagnosticRunId, 'task.finished', {
                task: taskType,
                outcome,
                count: task.completion,
                total: task.total,
            });
        } catch (e) {
            console.error(e);
            logger.error(`Fail to run task [${task.name || taskType}]: ` + e);
            this._failedTasks.push({ task: task.name || taskType, error: e.toString() });
            await recordDiagnostic(this._diagnosticRunId, 'task.finished', {
                task: taskType,
                outcome: 'failed',
                errorType: e?.name || 'Error',
                errorStack: e?.stack,
            });
        } finally {
            task.storage = publishedStorage;
            if (snapshot) await snapshot.close();
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
            diagnosticRunId: this._diagnosticRunId,
            completedTaskTypes: this._completedTaskTypes,
            emptyTasks: this._emptyTasks,
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
        job._diagnosticRunId = json.diagnosticRunId || job._diagnosticRunId;
        job._completedTaskTypes = Array.isArray(json.completedTaskTypes) ? json.completedTaskTypes : [];
        job._emptyTasks = Array.isArray(json.emptyTasks) ? json.emptyTasks : [];
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
