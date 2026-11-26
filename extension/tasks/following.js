'use strict';
import Task from '../services/Task.js';
import TaskError from '../services/TaskError.js';
import {numericId, validatePage, pageStep} from './_validation.js';


const API_PAGE_SIZE = 50;
const URL_FOLLOWING_API = 'https://m.douban.com/rexxar/api/v2/user/{uid}/following?start={start}&count=50&ck={ck}&for_mobile=1';


export default class Following extends Task {
    async run() {
        // A restarted worker replays this task. Replace only its incomplete
        // snapshot; previously published versions remain available.
        await this.storage.following.where('version').equals(this.jobId).delete();
        this.total = (this.targetUser && this.targetUser.following_count) || 0;
        
        let baseURL = URL_FOLLOWING_API
            .replace('{ck}', this.session?.cookies?.ck || '')
            .replace('{uid}', this.targetUser.id);

        let total = null;
        const seenIds = new Set();
        for (let start = 0; total === null || start < total;) {
            let fetch = await this.fetch
            let response = await fetch(baseURL.replace('{start}', start), {headers: {'X-Override-Referer': 'https://m.douban.com/mine/followed'}});
            if (response.status != 200) {
                throw new TaskError('豆瓣服务器返回错误');
            }
            let json = await response.json();
            total = this.total = validatePage(json, 'users', start);
            const step = pageStep(json, start, API_PAGE_SIZE, total);
            for (let user of json.users) {
                const userId = numericId(user?.id, '用户');
                if (seenIds.has(userId)) continue;
                seenIds.add(userId);
                let row = {
                    version: this.jobId,
                    user: user,
                };
                await this.storage.following.put(row);
                this.step();
            }
            start += step;
        }

        await this.storage.table('version').put({table: 'following', version: this.jobId, updated: Date.now()});
        this.total = this.completion;
    }

    get name() {
        return '关注';
    }
}
