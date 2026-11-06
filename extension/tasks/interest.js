'use strict';
import Task from '../services/Task.js';
import TaskError from '../services/TaskError.js';
import {numericId, validatePage, totalCount} from './_validation.js';


const PAGE_SIZE = 50;
const URL_INTERESTS = 'https://m.douban.com/rexxar/api/v2/user/{uid}/interests?type={type}&status={status}&start={start}&count={count}&ck={ck}&for_mobile=1';
const URL_TOTAL = 'https://m.douban.com/rexxar/api/v2/user/{uid}/interests?ck={ck}&count=1&for_mobile=1';


export default class Interest extends Task {
    async getTotal() {
        let totalURL = URL_TOTAL
            .replace('{ck}', this.session?.cookies?.ck || '')
            .replace('{uid}', this.targetUser.id);
        let fetch = await this.fetch
        let response = await fetch(totalURL, {headers: {'X-Override-Referer': 'https://m.douban.com/mine/'}});
        if (response.status !== 200) {
            throw new TaskError('豆瓣服务器返回错误');
        }
        let json = await response.json();
        return totalCount(json);
    }

    compareInterest(l, r) {
        if (!l || !r) return false;
        if (l.status !== r.status) return false;
        if (l.comment !== r.comment) return false;
        if (l.rating !== r.rating) {
            if (l.rating && r.rating) {
                if (l.rating.value !== r.rating.value) {
                    return false;
                }
            } else {
                return false;
            }
        }
        let lTags = Array.isArray(l.tags) ? [...l.tags].sort().toString() : (l.tags ? String(l.tags) : '');
        let rTags = Array.isArray(r.tags) ? [...r.tags].sort().toString() : (r.tags ? String(r.tags) : '');
        if (lTags !== rTags) return false;
        return true;
    }

    async processInterest(interest, version, type)
    {
        if (!interest || Object.keys(interest).length === 0) {
            throw new TaskError('标记接口返回无效数据');
        }
        let subjectId = numericId(interest.subject?.id, '条目');
        let interestId = numericId(interest.id, '标记');
        let row = await this.storage.interest.get({ subject: subjectId });
        let replacedId = null;
        if (row) {
            let lastVersion = row.version;
            let changed = false;
            row.version = version;
            if (row.id !== interestId) {
                replacedId = row.id;
                row.id = interestId;
                changed = true;
            } else {
                changed = !this.compareInterest(row.interest, interest);
            }
            if (changed) {
                !row.history && (row.history = {});
                row.history[lastVersion] = row.interest;
                row.status = interest.status;
                row.interest = interest;
            }
        } else {
            row = {
                id: interestId,
                subject: subjectId,
                version: version,
                type: type,
                status: interest.status,
                interest: interest,
            };
        }
        if (replacedId !== null) {
            // The subject has a unique index. Replacing its primary key needs a
            // short local transaction so a failed put cannot delete the backup.
            await this.storage.transaction('rw', this.storage.interest, async () => {
                await this.storage.interest.delete(replacedId);
                await this.storage.interest.put(row);
            });
        } else {
            await this.storage.interest.put(row);
        }
        this.step();
    }

    async run() {
        let version = this.jobId;
        let failedSlices = 0;
        this.total = await this.getTotal();
        if (this.total === 0) {
            await this.storage.table('version').put({table: 'interest', version: version, updated: Date.now()});
            this.complete();
            return;
        }

        let baseURL = URL_INTERESTS
            .replace('{ck}', this.session?.cookies?.ck || '')
            .replace('{uid}', this.targetUser.id);

        // for (let type of ['movie']) {
        for (let type of ['game', 'music', 'book', 'movie', 'drama']) {
            let urlWithType = baseURL.replace('{type}', type);

            for (let status of ['mark', 'doing', 'done']) {
                let urlWithStatus = urlWithType.replace('{status}', status);
                let pageCount = 1;
                for (let i = 0; i < pageCount; i ++) {
                    let start = i * PAGE_SIZE;
                    let urlToFetch = urlWithStatus
                        .replace('{start}', start)
                        .replace('{count}', PAGE_SIZE);
                    let fetch = await this.fetch
                    let response = await fetch(urlToFetch, {headers: {'X-Override-Referer': 'https://m.douban.com/mine/' + type}});
                    if (response.status !== 200) {
                        if (response.status === 500) {
                            // try to fetch this page sliced
                            for (let j = 0; j < PAGE_SIZE; j ++) {
                                let startSliced = start + j;
                                let urlToFetchSliced = urlWithStatus
                                    .replace('{start}', startSliced)
                                    .replace('{count}', 1);
                                let fetch = await this.fetch
                                let response = await fetch(urlToFetchSliced, {headers: {'X-Override-Referer': 'https://m.douban.com/mine/' + type}});
                                if (response.status !== 200) {
                                    failedSlices++;
                                    continue;
                                }
                                let json = await response.json();
                                const total = validatePage(json, 'interests', startSliced);
                                pageCount = Math.ceil(total / PAGE_SIZE);
                                if (startSliced >= total) break;
                                for (let interest of json.interests) {
                                    await this.processInterest(interest, version, type);
                                }
                            }
                        } else {
                            throw new TaskError('豆瓣服务器返回错误: ' + response.status);
                        }
                        continue;
                    }
                    let json = await response.json();
                    pageCount = Math.ceil(validatePage(json, 'interests', start) / PAGE_SIZE);
                    for (let interest of json.interests) {
                        await this.processInterest(interest, version, type);
                    }
                }
            }
        }
        if (failedSlices) throw new TaskError('部分书影音标记获取失败，已保存可读取内容，请重试');
        await this.storage.table('version').put({table: 'interest', version: version, updated: Date.now()});
        this.complete();
    }

    get name() {
        return '书/影/音/游';
    }
}
