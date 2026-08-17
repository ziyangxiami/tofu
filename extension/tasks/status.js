'use strict';
import Task from '../services/Task.js';
import TaskError from '../services/TaskError.js';


const URL_TIMELINE = 'https://m.douban.com/rexxar/api/v2/status/user_timeline/{uid}?max_id={maxId}&ck={ck}&for_mobile=1';
const URL_STATUS = 'https://m.douban.com/rexxar/api/v2/status/{id}?ck={ck}&for_mobile=1';


export default class Status extends Task {
    async fetchStatusFulltext(id) {
        let url = URL_STATUS
            .replace('{ck}', this.session?.cookies?.ck || '')
            .replace('{id}', id);
        let fetch = await this.fetch
        let response = await fetch(url, {headers: {'X-Override-Referer': 'https://m.douban.com/mine/statuses'}});
        if (response.status !== 200) {
            throw new TaskError('豆瓣服务器返回错误');
        }
        return await response.json();
    }

    async run() {
        let version = this.jobId;
        this.total = (this.targetUser && this.targetUser.statuses_count) || 0;
        if (this.total === 0) {
            return;
        }
        let lastStatusId = '';
        await this.storage.transaction('rw', this.storage.table('version'), async () => {
            let verTable = this.storage.table('version');
            let row = await verTable.get('status');
            if (row) {
                lastStatusId = row.lastId;
                await verTable.update('status', {version: version, updated: Date.now()});
            } else {
                await verTable.add({table: 'status', version: version, updated: Date.now()});
            }
        })

        let baseURL = URL_TIMELINE
            .replace('{ck}', this.session?.cookies?.ck || '')
            .replace('{uid}', this.targetUser.id);

        while (true) {
            const requestedMaxId = String(lastStatusId || '');
            let fetch = await this.fetch
            let response = await fetch(baseURL.replace('{maxId}', encodeURIComponent(requestedMaxId)), {headers: {'X-Override-Referer': 'https://m.douban.com/mine/statuses'}});
            if (response.status !== 200) {
                throw new TaskError('豆瓣服务器返回错误');
            }
            let json = await response.json();
            if (!json || !json.items) {
                break;
            }
            const count = json.items.length;
            if (count === 0) {
                break;
            }

            let nextMaxId = requestedMaxId;
            for (let item of json.items) {
                let status = item.status;
                if (!status) continue;
                const statusId = String(status.id);
                if (statusId === requestedMaxId) {
                    continue; // 豆瓣接口 max_id 包含边界，需跳过重复的一条以防触发数据库唯一键冲突
                }
                item.id = parseInt(status.id);
                item.created = Date.now();
                nextMaxId = statusId;
                if (status.text && status.text.length >= 140 && status.text.endsWith('...')) {
                    item.status = await this.fetchStatusFulltext(statusId);
                }
                try {
                    await this.storage.status.add(item);
                } catch (e) {
                    if (e.name === 'ConstraintError') {
                        // Timeline pages may overlap by more than their max_id boundary.
                        // A duplicate item must not terminate the whole backup.
                        this.logger.debug(e.message);
                        continue;
                    }
                    throw e;
                }
                this.step();
            }

            // Avoid requesting the same page forever if Douban ignores or repeats a cursor.
            if (!nextMaxId || nextMaxId === requestedMaxId) {
                break;
            }
            lastStatusId = nextMaxId;
            await this.storage.table('version').update('status', { lastId: lastStatusId });
        }
        this.complete();
    }

    get name() {
        return '广播';
    }
}
