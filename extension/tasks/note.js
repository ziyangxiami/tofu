'use strict';
import Task from '../services/Task.js';
import TaskError from '../services/TaskError.js';
import {numericId, validatePage} from './_validation.js';


const PAGE_SIZE = 50;
const URL_NOTES = 'https://m.douban.com/rexxar/api/v2/user/{uid}/notes?start={start}&count=50&ck={ck}&for_mobile=1';


export default class Note extends Task {
    async fetchNote(url) {
        let fetch = await this.fetch
        let response = await fetch(url);
        if (response.status != 200) {
            throw new TaskError('日记正文获取失败，已保留旧备份');
        }
        let html = this.parseHTML(await response.text());
        let node = html.querySelector('#link-report>.note') || html.querySelector('#link-report') || html.querySelector('.note-content');
        if (!node) throw new TaskError('无法识别日记正文，已保留旧备份');
        return node.innerHTML;
    }

    async run() {
        let version = this.jobId;
        this.total = (this.targetUser && this.targetUser.notes_count) || 0;

        let baseURL = URL_NOTES
            .replace('{ck}', this.session?.cookies?.ck || '')
            .replace('{uid}', this.targetUser.id);

        let pageCount = 1;
        for (let i = 0; i < pageCount; i ++) {
            let fetch = await this.fetch
            let response = await fetch(baseURL.replace('{start}', i * PAGE_SIZE), {headers: {'X-Override-Referer': 'https://m.douban.com/mine/notes'}});
            if (response.status != 200) {
                throw new TaskError('豆瓣服务器返回错误');
            }
            let json = await response.json();
            this.total = validatePage(json, 'notes', i * PAGE_SIZE);
            pageCount = Math.ceil(this.total / PAGE_SIZE);
            for (let note of json.notes) {
                let row = await this.storage.note.get(numericId(note.id, '日记'));
                if (row) {
                    let lastVersion = row.version;
                    row.version = version;
                    if (note.update_time != row.note.update_time || row.note.fulltext == undefined) {
                        !row.history && (row.history = {});
                        row.history[lastVersion] = row.note;
                        note.fulltext = await this.fetchNote(note.url);
                        row.note = note;
                    }
                } else {
                    note.fulltext = await this.fetchNote(note.url);
                    row = {
                        id: numericId(note.id, '日记'),
                        version: version,
                        note: note,
                    }
                }
                await this.storage.note.put(row);
                this.step();
            }
        }
        await this.storage.table('version').put({table: 'note', version: version, updated: Date.now()});
        this.complete();
    }

    get name() {
        return '日记';
    }
}
