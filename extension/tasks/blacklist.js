'use strict';
import Task from '../services/Task.js';
import TaskError from '../services/TaskError.js';

const URL_BLACKLIST = 'https://www.douban.com/contacts/blacklist?start={start}';
const URL_USER_INFO = 'https://m.douban.com/rexxar/api/v2/user/{uid}?ck={ck}&for_mobile=1';
const PAGE_SIZE = 72;


export default class Blacklist extends Task {

    async run() {
        if (this.isOtherUser) {
            throw new TaskError('不能备份其他用户的黑名单');
        }

        await this.storage.table('version').put({table: 'blacklist', version: this.jobId, updated: Date.now()});

        let totalPage = this.total = 1;

        for (let i = 0; i < totalPage; i ++) {
            let fetch = await this.fetch
            let response = await fetch(URL_BLACKLIST.replace('{start}', i * PAGE_SIZE));
            if (response.status !== 200) {
                throw new TaskError('豆瓣服务器返回错误');
            }
            let html = this.parseHTML(await response.text());
            try {
                this.total = totalPage = parseInt(html.querySelector('.paginator .thispage').dataset.totalPage);
            } catch (e) {}
            for (let dl of html.querySelectorAll('.obss.namel>dl')) {
                let avatar = dl.querySelector('.imgg');
                let avatarSrc = avatar ? (avatar.getAttribute('src') || '') : '';
                let avatarAlt = avatar ? (avatar.getAttribute('alt') || '') : '';
                let idMatch = avatarSrc.match(/\/icon\/u(\d+)\-(\d+)\.jpg$/), idText;
                let userLink = dl.querySelector('.nbg')?.getAttribute('href') || '';
                let uidMatch = userLink.match(/\/people\/([^\/]+)/);
                let uid = uidMatch ? uidMatch[1] : '';
                if (idMatch) {
                    idText = idMatch[1];
                } else if (uid) {
                    let ck = this.session?.cookies?.ck || '';
                    let url = URL_USER_INFO
                        .replace('{ck}', ck)
                        .replace('{uid}', uid);
                    let fetch = await this.fetch;
                    let response = await fetch(url, {headers: {'X-Override-Referer': 'https://www.douban.com/'}});
                    if (response.status != 200) {
                        idText = null;
                    } else {
                        let json = await response.json();
                        idText = json.id;
                    }
                }
                let row = {
                    version: this.jobId,
                    user: {
                        avatar: avatarSrc,
                        id: idText,
                        name: avatarAlt,
                        uid: uid,
                        uri: idText ? ('douban://douban.com/user/' + idText) : '',
                        url: userLink,
                    }
                };
                await this.storage.blacklist.put(row);
            }
            this.step();
        }
        this.complete();
    }

    get name() {
        return '黑名单';
    }
}
