'use strict';
import Dexie from './vendor/dexie.js';
import { importFromJsonString, exportToJsonString } from './vendor/IDBExportImport.js';
import * as fflate from './vendor/fflate.js';

const DB_NAME = 'tofu';

// Each task owns these tables. Related parents/children publish together; the
// shared version store is updated only at that task's keys.
const SNAPSHOT_TABLES = {
    Annotation: ['annotation'], Blacklist: ['blacklist'], Board: ['board'],
    Doulist: ['doulist', 'doulistItem'], Doumail: ['doumail', 'doumailContact'],
    Follower: ['follower'], Following: ['following'], Interest: ['interest'],
    Note: ['note'], Photo: ['album', 'photo'], Review: ['review'], Status: ['status'],
};

const SCHEMA_GLOBAL = [
    null,
    {
        account: 'userId, userSymbol',
        job: '++id, userId, userSymbol',
    },
];

const SCHEMA_LOCAL = [
    null,
    {
        status: 'id',
        following: '++id, version',
        follower: '++id, version',
        blacklist: '++id, version',
        review: 'id, type, [type+version]',
        note: 'id, version',
        interest: 'id, &subject, [type+status], [type+status+version]',
        album: 'id, version',
        photo: 'id, album, [album+version]',
        doulist: 'id, type, [type+version]',
        doulistItem: 'id, doulist, [doulist+version]',
        doumail: 'id, contact',
        doumailContact: 'id, rank',
        version: 'table, version',
    },
    {
        files: '++id, &url',
    },
    {
        annotation: 'id, subject, [subject+version]',
    },
    {
        board: 'id',
    },
];


/**
 * Class Storage
 */
export default class Storage {
    static isDumping = false;
    static isRestoring = false;

    constructor(userId = null) {
        this.userId = userId;
    }

    get global() {
        if (!this._global) {
            let db = this._global = new Dexie(DB_NAME);
            for (let i = 1; i < SCHEMA_GLOBAL.length; i ++) {
                db.version(i).stores(SCHEMA_GLOBAL[i]);
            }
        }
        return this._global;
    }

    get local() {
        if (!this._local) {
            if (!this.userId) {
                throw new Error('No local storage');
            }
            this._local = this.getLocalDb(this.userId);
        }
        return this._local;
    }

    getLocalDb(userId) {
        return this.getNamedLocalDb(`${DB_NAME}[${userId}]`);
    }

    getNamedLocalDb(name) {
        let db = new Dexie(name);
        for (let i = 1; i < SCHEMA_LOCAL.length; i ++) {
            db.version(i).stores(SCHEMA_LOCAL[i]);
        }
        return db;
    }

    async createTaskSnapshot(jobId, taskType) {
        const tableNames = SNAPSHOT_TABLES[taskType];
        if (!tableNames) return null; // Files cache and migrations use published data.
        if (!Number.isSafeInteger(jobId) || jobId <= 0) throw new Error('Invalid backup version');
        const live = this.local;
        const receiptKey = '__snapshot_commit:' + taskType;
        const receipt = await live.table('version').get(receiptKey);
        if (receipt?.version === jobId) {
            return {published: true, result: receipt.result, publishedAt: receipt.publishedAt, close: async () => {
                try { await this.deleteTaskStages(this.userId, taskType); } catch (_) {}
            }};
        }
        const stageName = `${DB_NAME}-stage[${this.userId}:${jobId}:${taskType}]`;
        const stage = this.getNamedLocalDb(stageName);
        const stateKey = '__snapshot_state';
        const versionKey = taskType === 'Doumail' ? null : taskType.toLowerCase();
        let fresh = false;
        let resetCheckpointRequired = false;
        try {
            await stage.open();
            const state = await stage.table('version').get(stateKey);
            resetCheckpointRequired = state?.resetCheckpointRequired !== false;
            if (!state?.ready || state.jobId !== jobId || state.taskType !== taskType) {
                fresh = true;
                resetCheckpointRequired = true;
                const rows = {};
                let version;
                await live.transaction('r', [...tableNames.map(name => live.table(name)), live.table('version')], async () => {
                    for (const name of tableNames) rows[name] = await live.table(name).toArray();
                    if (versionKey) version = await live.table('version').get(versionKey);
                });
                // All baseline rows and the ready marker are one transaction.
                // Interrupted initialization cannot be mistaken for a full copy.
                await stage.transaction('rw', [...tableNames.map(name => stage.table(name)), stage.table('version')], async () => {
                    for (const name of tableNames) {
                        await stage.table(name).clear();
                        if (rows[name].length) await stage.table(name).bulkAdd(rows[name]);
                    }
                    await stage.table('version').clear();
                    if (version) await stage.table('version').put(version);
                    await stage.table('version').put({table: stateKey, ready: true, jobId, taskType,
                        resetCheckpointRequired: true});
                });
            }
        } catch (error) {
            stage.close();
            throw error;
        }
        let published = false;
        const owner = this;
        return {
            database: stage, fresh, resetCheckpointRequired, published: false,
            async acknowledgeCheckpointReset() {
                // Called only after the cleared task checkpoint is durably saved
                // in service state. Until then every worker restart must clear it.
                await stage.table('version').update(stateKey, {resetCheckpointRequired: false});
            },
            async commit(result) {
                const rows = {};
                let version;
                const publishedAt = Date.now();
                await stage.transaction('r', [...tableNames.map(name => stage.table(name)), stage.table('version')], async () => {
                    for (const name of tableNames) rows[name] = await stage.table(name).toArray();
                    if (versionKey) version = await stage.table('version').get(versionKey);
                });
                // No network or cross-database awaits inside this transaction.
                // Failed writes roll back data, version markers and the receipt.
                await live.transaction('rw', [...tableNames.map(name => live.table(name)), live.table('version')], async () => {
                    for (const name of tableNames) {
                        await live.table(name).clear();
                        if (rows[name].length) await live.table(name).bulkAdd(rows[name]);
                    }
                    if (versionKey) {
                        if (version) await live.table('version').put(version);
                        else await live.table('version').delete(versionKey);
                    }
                    await live.table('version').put({table: receiptKey, version: jobId, result, publishedAt});
                });
                published = true;
                return publishedAt;
            },
            async close() {
                stage.close();
                if (published) {
                    // Cleanup is not part of publication. A cleanup failure must
                    // never turn an already committed backup into a failed task.
                    try { await owner.deleteTaskStages(owner.userId, taskType); } catch (_) {}
                }
            },
        };
    }

    async deleteTaskStages(userId, taskType = null) {
        for (const name of await Dexie.getDatabaseNames()) {
            const match = /^tofu-stage\[(\d+):(\d+):([A-Za-z]+)\]$/.exec(name);
            if (match && match[1] === String(userId) && (!taskType || match[3] === taskType)) {
                await Dexie.delete(name);
            }
        }
    }

    async markAccountPublished(userId, publishedAt) {
        if (!Number.isFinite(publishedAt) || publishedAt <= 0) return;
        this._accountUpdateChain = (this._accountUpdateChain || Promise.resolve()).catch(() => {}).then(async () => {
            await this.global.open();
            try {
                await this.global.transaction('rw', this.global.account, async () => {
                    const account = await this.global.account.get({userId});
                    if (account && (!account.updated || account.updated < publishedAt)) {
                        await this.global.account.update(userId, {updated: publishedAt});
                    }
                });
            } finally {
                this.global.close();
            }
        });
        await this._accountUpdateChain;
    }

    async drop(userId) {
        try {
            // Deleting an account includes its unpublished private copies.
            await this.deleteTaskStages(userId);
        } catch (_) {
            return false;
        }
        let localDbName = `${DB_NAME}[${userId}]`;
        if (await Dexie.exists(localDbName)) {
            try {
                await Dexie.delete(localDbName);
            } catch (e) {
                return false;
            }
        }
        return await this.global.account.where({
            userId: parseInt(userId)
        }).delete() > 0;
    }

    async reserveJobIds(version) {
        if (!Number.isSafeInteger(version) || version <= 0) return;
        await this.global.transaction('rw', this.global.job, async () => {
            const lastJob = await this.global.job.orderBy('id').last();
            if (lastJob && lastJob.id >= version) return;
            // Imported rows retain their version numbers. Advance the IndexedDB
            // key generator without restoring runnable jobs or replacing history.
            await this.global.job.add({id: version});
            await this.global.job.delete(version);
        });
    }

    async dump(onProgress) {
        if (this.constructor.isRestoring) {
            throw '正在恢复数据库';
        }
        if (this.constructor.isDumping) {
            throw '正在备份数据库';
        }
        this.constructor.isDumping = true;

        try {
            var backupData = {};
            var dbFiles = [];

            const databases = (await Dexie.getDatabaseNames())
                .filter(name => name === DB_NAME || /^tofu\[\d+\]$/.test(name));
            const total = databases.length;
            var completed = 1;
            for (let database of databases) {
                if (database != DB_NAME) {
                    dbFiles.push(database);
                }
                let db = new Dexie(database);
                let dbJson;
                try {
                    await db.open();
                    dbJson = await new Promise((resolve, reject) => {
                        exportToJsonString(db.backendDB(), (error, jsonString) => {
                            if (error) {
                                reject(error);
                            } else {
                                resolve(jsonString);
                            }
                        })
                    });
                } finally {
                    db.close();
                }
                backupData[database + '.json'] = fflate.strToU8(dbJson);
                onProgress(completed ++ / total);
            }
            backupData['database.json'] = fflate.strToU8(JSON.stringify({
                'global': { 'version': SCHEMA_GLOBAL.length },
                'local': {
                    'version': SCHEMA_LOCAL.length,
                    'files': dbFiles
                }
            }));

            return await new Promise((resolve, reject) => {
                fflate.zip(backupData, (error, data) => {
                    if (error) {
                        reject(error);
                    } else {
                        resolve(data);
                    }
                })
            });
        } finally {
            this.constructor.isDumping = false;
        }
    }

    async restore(zipBuffer, onProgress) {
        if (this.constructor.isRestoring) {
            throw '正在恢复数据库';
        }
        if (this.constructor.isDumping) {
            throw '正在备份数据库';
        }
        this.constructor.isRestoring = true;

        const unzipFile = function (filename) {
            return new Promise((resolve, reject) => {
                fflate.unzip(zipBuffer, {
                    filter(file) {
                        return file.name == filename
                    }
                }, (error, data) => {
                    if (error) {
                        reject(error);
                    } else {
                        resolve(data[filename]);
                    }
                })
            });
        };

        try {
            var successes = [];
            var failures = [];
            var unzippedFile = await unzipFile('database.json');
            if (!unzippedFile) throw '压缩包内未找到数据库信息';

            let dbMeta = JSON.parse(fflate.strFromU8(unzippedFile));
            if (dbMeta.global.version != SCHEMA_GLOBAL.length || dbMeta.local.version != SCHEMA_LOCAL.length) {
                throw '数据库版本不一致';
            };

            var completed = 1;
            const total = dbMeta.local.files.length + 2;
            onProgress(completed ++ / total);

            let globalDbFilename = `${DB_NAME}.json`;
            unzippedFile = await unzipFile(globalDbFilename);
            if (!unzippedFile) throw `压缩包缺失文件："${globalDbFilename}"`;
            let globalDb = JSON.parse(fflate.strFromU8(unzippedFile));
            onProgress(completed ++ / total);

            await this.global.open();
            try {
                let maxVersion = 0;
                for (const job of globalDb.job || []) {
                    if (Number.isSafeInteger(job.id) && job.id > maxVersion) maxVersion = job.id;
                }
                await this.reserveJobIds(maxVersion);
                for (let account of globalDb.account) {
                    let dbName = `${DB_NAME}[${account.userId}]`;
                    let dbFilename = dbName + '.json';
                    console.log(`importing ${dbFilename}`);
                    if (await this.global.account.get({userId: account.userId})) {
                        failures.push({
                            'database': dbName,
                            'filename': dbFilename,
                            'error': '数据库已存在'
                        });
                        onProgress(completed ++ / total);
                        continue;
                    }
                    let dbFile = await unzipFile(dbFilename);
                    if (!dbFile) {
                        failures.push({
                            'database': dbName,
                            'filename': dbFilename,
                            'error': '数据库文件缺失'
                        });
                        continue;
                    }

                    const localData = JSON.parse(fflate.strFromU8(dbFile));
                    for (const rows of Object.values(localData)) {
                        if (!Array.isArray(rows)) continue;
                        for (const row of rows) {
                            if (Number.isSafeInteger(row?.version) && row.version > maxVersion) {
                                maxVersion = row.version;
                            }
                        }
                    }
                    await this.reserveJobIds(maxVersion);
                    let localDb = this.getLocalDb(account.userId);
                    await localDb.open();
                    try {
                        await new Promise((resolve, reject) => {
                            importFromJsonString(localDb.backendDB(), fflate.strFromU8(dbFile), (error) => {
                                if (error) {
                                    reject(error);
                                } else {
                                    resolve();
                                }
                            });
                        });
                        await this.global.account.put(account);
                        successes.push({
                            'database': dbName,
                            'filename': dbFilename
                        });
                    } catch (error) {
                        failures.push({
                            'database': dbName,
                            'filename': dbFilename,
                            'error': error
                        });
                    } finally {
                        localDb.close();
                    }
                    onProgress(completed ++ / total);
                }    
            } finally {
                this.global.close();
            }

            return {
                'successes': successes,
                'failures': failures
            };
        } finally {
            this.constructor.isRestoring = false;
        }
    }
}
