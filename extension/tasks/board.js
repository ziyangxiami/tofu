'use strict';
import Task from '../services/Task.js';
import TaskError from '../services/TaskError.js';


const PAGE_SIZE = 20;
const URL_MESSAGE_BOARD = 'https://www.douban.com/people/{uid}/board?start={start}';


export default class Board extends Task {
    async run() {
        let version = this.jobId;
        let lastMessageId = '';
        let maxMessageId = 0;
        await this.storage.transaction('rw', this.storage.table('version'), async () => {
            let verTable = this.storage.table('version');
            let row = await verTable.get('board');
            if (row) {
                lastMessageId = row.lastId;
                maxMessageId = parseInt(row.lastId) || 0;
                await verTable.update('board', {version: version, updated: Date.now()});
            } else {
                await verTable.add({table: 'board', version: version, updated: Date.now()});
            }
        });
        
        let baseURL = URL_MESSAGE_BOARD
            .replace('{uid}', this.targetUser.id);

        let totalPage = this.total = 1;

        for (let i = 0; i < totalPage; i ++) {
            let fetch = await this.fetch
            let response = await fetch(baseURL.replace('{start}', i * PAGE_SIZE));
            if (response.status !== 200) {
                throw new TaskError('豆瓣服务器返回错误');
            }
            let html =  this.parseHTML(await response.text());
            try {
                this.total = totalPage = parseInt(html.querySelector('.paginator .thispage').dataset.totalPage);
            } catch (e) {}

            for (let li of html.querySelectorAll('#comments>.comment-item')) {
                let messageId = parseInt(li.dataset?.cid || li.getAttribute('data-cid'));
                if (messageId <= lastMessageId) {
                    totalPage = 0;
                    break;
                }
                if (messageId > maxMessageId) {
                    maxMessageId = messageId;
                }
                let sendTime = li.querySelector('.pl')?.textContent?.trim() || '';
                if (sendTime.length < 6) {
                    let datetime = new Date();
                    let year = datetime.getFullYear().toString();
                    let month = datetime.getMonth() + 1;
                    month = month < 10 ? '0' + month.toString() : month.toString();
                    let date = datetime.getDate();
                    date = date < 10 ? '0' + date.toString() : date.toString();
                    sendTime = year + ' ' + month + '-' + date + ' ' + sendTime;
                } else if (sendTime.length < 12) {
                    sendTime = (new Date()).getFullYear().toString() + ' ' + sendTime;
                }
                let prevImg = li.previousElementSibling ? li.previousElementSibling.querySelector('img') : null;
                let avatarSrc = prevImg ? (prevImg.getAttribute('src') || '') : '';
                let authorAnchor = li.querySelector('a');
                let authorName = authorAnchor ? (authorAnchor.textContent || authorAnchor.text || '').trim() : '';
                let authorUrl = authorAnchor ? (authorAnchor.getAttribute('href') || '') : '';
                let row = {
                    id: messageId,
                    sender: {
                        avatar: avatarSrc,
                        name: authorName,
                        url: authorUrl,
                    },
                    created: Date.now(),
                    message: this.getMessage(li),
                    sendTime: sendTime
                };
                try {
                    await this.storage.board.add(row);
                } catch (e) {}
            }
            this.step();
        }
        await this.storage.table('version').put({ table: 'board', version: version, lastId: maxMessageId, updated: Date.now() });
        this.complete();
    }

    getMessage(element) {
        if (!element.childNodes || element.childNodes.length < 2) return '';
        let message = (element.childNodes[1].textContent || element.childNodes[1].text || '').substr(4);
        for (let i = 2; i < element.childNodes.length; i ++) {
            let childNode = element.childNodes[i];
            if (childNode.classList && childNode.classList.contains('pl')) break;

            message += (childNode.textContent || childNode.text || '');
        }

        return message;
    }

    get name() {
        return '留言板';
    }
}
