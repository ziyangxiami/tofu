'use strict';
import Task from '../services/Task.js';
import TaskError from '../services/TaskError.js';
import {numericId, validatePage} from './_validation.js';


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

        let pageCount = 1;
        for (let i = 0; i < pageCount; i ++) {
            let fetch = await this.fetch
            let response = await fetch(baseURL.replace('{start}', i * API_PAGE_SIZE), {headers: {'X-Override-Referer': 'https://m.douban.com/mine/followed'}});
            if (response.status != 200) {
                throw new TaskError('豆瓣服务器返回错误');
            }
            let json = await response.json();
            this.total = validatePage(json, 'users', i * API_PAGE_SIZE);
            pageCount = Math.ceil(this.total / API_PAGE_SIZE);
            for (let user of json.users) {
                numericId(user?.id, '用户');
                let row = {
                    version: this.jobId,
                    user: user,
                };
                await this.storage.following.put(row);
                this.step();
            }
        }

        await this.storage.table('version').put({table: 'following', version: this.jobId, updated: Date.now()});
        this.complete();
    }

    get name() {
        return '关注';
    }
}
