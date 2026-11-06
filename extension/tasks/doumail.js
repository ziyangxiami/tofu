'use strict';
import Task from '../services/Task.js';
import TaskError from '../services/TaskError.js';
import {numericId, htmlPageCount} from './_validation.js';


const PAGE_SIZE = 20;
const URL_DOUMAIL = 'https://www.douban.com/doumail/?start={start}';
const URL_DOUMAIL_LOAD_MORE = 'https://www.douban.com/j/doumail/loadmore';


export default class Doumail extends Task {
    async run() {
        if (this.isOtherUser) {
            throw new TaskError('不能备份其他用户的豆邮');
        }
        let pageCount = 1;
        for (let i = 0; i < pageCount; i ++) {
            let fetch = await this.fetch
            let response = await fetch(URL_DOUMAIL.replace('{start}', i * PAGE_SIZE));
            if (response.status != 200) {
                throw new TaskError('豆瓣服务器返回错误');
            }
            let html = this.parseHTML(await response.text());
            if (!html.querySelector('.doumail-list')) {
                throw new TaskError('无法识别豆邮列表，请确认登录状态或页面是否需要验证');
            }
            pageCount = htmlPageCount(html);
            this.total = pageCount * PAGE_SIZE;
            for (let contact of html.querySelectorAll('.doumail-list>ul>li')) {
                let operationAnchor = contact.querySelector('.operations>.post_link.report');
                let userId = numericId(operationAnchor?.dataset?.id || operationAnchor?.getAttribute('data-id'), '豆邮联系人');
                let contactName = operationAnchor ? (operationAnchor.dataset?.sname || operationAnchor.getAttribute('data-sname') || '') : '';
                let contactUrl = operationAnchor ? (operationAnchor.dataset?.slink || operationAnchor.getAttribute('data-slink') || '') : '';
                let contactAvatarImg = contact.querySelector('.pic img');
                let contactAvatar = contactAvatarImg ? (contactAvatarImg.getAttribute('src') || '') : null;
                let time = contact.querySelector('.title>.sender>.time')?.text?.trim() || '';
                let abstract = contact.querySelector('.title>p')?.text?.trim() || '';
                let doumailAnchor = contact.querySelector('.title .url');
                let doumailUrl = doumailAnchor ? (doumailAnchor.getAttribute('href') || '') : '';
                let doumailContact = {
                    id: userId,
                    contact: {
                        id: userId,
                        name: contactName,
                        url: contactUrl,
                        avatar: contactAvatar,
                    },
                    time: time,
                    url: doumailUrl,
                    abstract: abstract,
                    rank: new Date(time).getTime() || 0,
                };
                let readMore = true;
                let lastDate = null;
                const seenPages = new Set();
                for (let start = 0; readMore; start += PAGE_SIZE) {
                    let postData = new URLSearchParams();
                    postData.append('start', start);
                    postData.append('target_id', userId);
                    postData.append('ck', this.session?.cookies?.ck || '');
                    let fetch = await this.fetch
                    let response = await fetch(URL_DOUMAIL_LOAD_MORE, {
                        headers: {'X-Override-Referer': doumailUrl},
                        method: 'POST',
                        body: postData,
                    });
                    if (response.status != 200) {
                        throw new TaskError('豆瓣服务器返回错误');
                    }
                    let json = await response.json();
                    if (!json || json.err || typeof json.html !== 'string' ||
                        ![true, false, 0, 1, '0', '1'].includes(json.more)) {
                        throw new TaskError('豆邮接口返回错误或无效内容');
                    }
                    readMore = json.more === true || json.more === 1 || json.more === '1';
                    if (seenPages.has(json.html) || (readMore && !json.html.trim())) {
                        throw new TaskError('豆邮分页内容重复或缺失，已保存此前内容');
                    }
                    seenPages.add(json.html);
                    let doumailList = this.parseHTML(json.html);
                    // The service-worker parser wraps HTML fragments in
                    // <html><body>; iterate the messages inside that wrapper.
                    let mailBody = doumailList.querySelector('body') || doumailList;
                    let messages = 0;
                    for (let div of mailBody.children) {
                        if (div.classList && div.classList.contains('split-line')) {
                            lastDate = (div.innerText || div.text || '').trim();
                        } else if (div.classList && div.classList.contains('chat')) {
                            let chatId = numericId(div.getAttribute('data') || div.getAttribute('data-id'), '豆邮');
                            messages++;
                            let time = div.querySelector('.info>.time')?.text?.trim() || '';
                            let datetime = `${lastDate || ''} ${time}`.trim();
                            let senderAvatarImg = div.querySelector('.pic img');
                            let senderAvatar = senderAvatarImg ? (senderAvatarImg.getAttribute('src') || '') : null;
                            let senderName = senderAvatarImg ? (senderAvatarImg.getAttribute('alt') || '') : '';
                            let senderAnchor = div.querySelector('.pic>a');
                            let senderUrl = senderAnchor ? (senderAnchor.getAttribute('href') || '') : null;
                            let content = div.querySelector('.content');
                            let contentSender = content ? content.querySelector('div.sender') : null;
                            contentSender && contentSender.remove();
                            let doumail = {
                                id: chatId,
                                contact: userId,
                                sender: {
                                    avatar: senderAvatar,
                                    name: senderName,
                                    url: senderUrl,
                                },
                                datetime: datetime,
                                content: content ? content.innerHTML : '',
                            };
                            await this.storage.doumail.put(doumail);
                        }
                    }
                    if (readMore && messages === 0) {
                        throw new TaskError('豆邮分页未返回消息，已保存此前内容');
                    }
                }
                await this.storage.doumailContact.put(doumailContact);
                this.step();
            }
        }
        this.complete();
    }

    get name() {
        return '豆邮';
    }
}
