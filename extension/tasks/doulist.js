'use strict';
import Task from '../services/Task.js';
import TaskError from '../services/TaskError.js';
import {recordDiagnostic} from '../services/diagnostics.js';


const PAGE_SIZE = 50;
const URL_DOULIST = 'https://m.douban.com/rexxar/api/v2/user/{uid}/{type}_doulists?start={start}&count=50&ck={ck}&for_mobile=1';


export default class Doulist extends Task {
    numericId(value) {
        if (!/^\d+$/.test(String(value ?? ''))) return null;
        const id = Number(value);
        return Number.isSafeInteger(id) && id > 0 ? id : null;
    }

    doulistId(doulist) {
        const urlId = String(doulist?.url || '').match(/\/doulist\/(\d+)(?:[/?#]|$)/)?.[1];
        return this.numericId(doulist?.id) ??
            this.numericId(doulist?.doulist_id) ??
            this.numericId(urlId);
    }

    compareDoulist(l, r) {
        if (!l || !r) return false;
        if (l.desc != r.desc) return false;
        if (l.title != r.title) return false;
        if (!Array.isArray(l.tags) || !Array.isArray(r.tags)) {
            this.missingTags = (this.missingTags || 0) + 1;
        }
        const tags = value => Array.isArray(value) ? [...value].sort().join(',') : (value == null ? '' : String(value));
        if (tags(l.tags) != tags(r.tags)) return false;
        return true;
    }

    compareDoulistItem(l, r) {
        if (l.comment != r.comment) return false;
        return true;
    }

    async run() {
        let version = this.jobId;
        this.missingTags = 0;
        let invalidListIds = 0;
        let invalidItemIds = 0;
        let ownedCount = this.targetUser.owned_doulist_count || 0;
        let followingCount = this.targetUser.following_doulist_count || 0;
        this.total = ownedCount + followingCount;
        if (this.total === 0) {
            // Default to 1 to allow checking via API in case count properties are absent in targetUser
            this.total = 1;
        }
        await this.storage.table('version').put({table: 'doulist', version: version, updated: Date.now()});

        let baseURL = URL_DOULIST
            .replace('{ck}', this.session.cookies.ck)
            .replace('{uid}', this.targetUser.id);

        for (let type of ['owned', 'following']) {
            let urlWithType = baseURL.replace('{type}', type);
            let pageCount = 1;
            for (let i = 0; i < pageCount; i ++) {
                let fetch = await this.fetch
                let response = await fetch(urlWithType.replace('{start}', i * PAGE_SIZE), {headers: {'X-Override-Referer': 'https://m.douban.com/mine/doulist'}});
                if (response.status != 200) {
                    await recordDiagnostic(this.diagnosticRunId, 'doulist.api', {
                        task: 'Doulist', listType: type, status: response.status,
                        reason: 'http_error',
                    });
                    throw new TaskError('豆瓣服务器返回错误');
                }
                let json = await response.json();
                if (i === 0) {
                    await recordDiagnostic(this.diagnosticRunId, 'doulist.api', {
                        task: 'Doulist', listType: type, status: response.status,
                        apiTotal: Number.isSafeInteger(json?.total) ? json.total : undefined,
                        apiGroups: Array.isArray(json?.doulists) ? json.doulists.length : 0,
                    });
                }
                if (!json || json.code || !Array.isArray(json.doulists)) {
                    await recordDiagnostic(this.diagnosticRunId, 'doulist.api', {
                        task: 'Doulist', listType: type, reason: 'invalid_response',
                    });
                    throw new TaskError('豆列接口响应格式错误');
                }
                if (typeof json.total === 'number') {
                    this.total = Math.max(this.total, json.total);
                    pageCount = Math.ceil(json.total / PAGE_SIZE);
                }
                for (let doulist of json.doulists) {
                    let doulistId = this.doulistId(doulist);
                    if (doulistId === null) {
                        invalidListIds++;
                        await recordDiagnostic(this.diagnosticRunId, 'doulist.invalid_id', {
                            task: 'Doulist', listType: type, count: 1,
                        });
                        continue;
                    }
                    let doulistRow = await this.storage.doulist.get(doulistId);
                    if (doulistRow) {
                        let lastVersion = doulistRow.version;
                        doulistRow.version = version;
                        if (!this.compareDoulist(doulist, doulistRow.doulist)) {
                            !doulistRow.history && (doulistRow.history = {});
                            doulistRow.history[lastVersion] = doulistRow.doulist;
                            doulistRow.doulist = doulist;
                        }
                    } else {
                        doulistRow = {
                            id: doulistId,
                            type: type,
                            version: version,
                            doulist: doulist,
                        };
                    }
                    const DOULIST_PAGE_SIZE = 25;
                    let doulistTotalPage = 1;
                    for (let i = 0; i < doulistTotalPage; i ++) {
                        let fetch = await this.fetch
                        let response = await fetch(doulist.url + '?start=' + i * DOULIST_PAGE_SIZE);
                        if (response.status != 200) {
                            if (response.status < 500) continue;
                            throw new TaskError('豆瓣服务器返回错误');
                        }
                        let html = this.parseHTML(await response.text());
                        try {
                            doulistTotalPage = parseInt(html.querySelector('.paginator .thispage').dataset.totalPage);
                        } catch (e) {}
                        for (let item of html.querySelectorAll('.doulist-item')) {
                            let addBtn = item.querySelector('.lnk-doulist-add');
                            if (!addBtn) continue;
                            let itemId = this.numericId(String(item.id || '').match(/(\d+)$/)?.[1]);
                            if (itemId === null) {
                                invalidItemIds++;
                                continue;
                            }
                            let itemBody = item.querySelector('.bd');
                            let itemTypes = [];
                            for (let itemType of itemBody.classList) {
                                if (itemType.startsWith('doulist-')) {
                                    itemTypes.push(itemType.substr(8));
                                }
                            }
                            let sourceNode = item.querySelector('.source');
                            let itemSource = sourceNode ? (sourceNode.innerText || sourceNode.text || '').trim().substr(3) : '';
                            let itemAbstract = item.querySelector('.abstract');
                            let commentBlockquote = item.querySelector('.comment-item>.comment');
                            let extra = {};
                            let itemCategory = parseInt(addBtn.dataset.cate);
                            if (itemCategory == 3055) {
                                // 广播
                                try {
                                    let statusTextNode = item.querySelector('.status-text');
                                    let statusImages = [];
                                    for (let statusImage of item.querySelectorAll('.status-images>a')) { 
                                        let styleStr = statusImage.getAttribute('style') || '';
                                        let bgMatch = styleStr.match(/background-image:\s*url\(['"]?([^'"]+)['"]?\)/i);
                                        if (bgMatch) {
                                            statusImages.push(bgMatch[1]);
                                        }
                                    }
                                    let status = {
                                        text: statusTextNode ? (statusTextNode.innerText || statusTextNode.text || '').trim() : '',
                                        images: statusImages,
                                    };
                                    extra.status = status;
                                } catch (e) { }
                            }
                            let itemEntity = {
                                id: parseInt(addBtn.dataset.id),
                                type: itemTypes,
                                category: itemCategory,
                                category_name: addBtn.dataset.catename,
                                url: addBtn.dataset.url,
                                title: addBtn.dataset.title,
                                can_view: addBtn.dataset.canview == 'True',
                                is_url_subject: addBtn.dataset.isurlsubject == 'true',
                                picture: addBtn.dataset.picture,
                                abstract: itemAbstract ? (itemAbstract.innerText || itemAbstract.text || '') : null,
                                source: itemSource,
                                comment: commentBlockquote ? (commentBlockquote.innerText || commentBlockquote.text || '') : null,
                                extra: extra,
                            };
                            let itemRow = await this.storage.doulistItem.get(itemId);
                            if (itemRow) {
                                let lastVersion = itemRow.version;
                                itemRow.version = version;
                                if (!this.compareDoulistItem(itemEntity, itemRow.item)) {
                                    !itemRow.history && (itemRow.history = {});
                                    itemRow.history[lastVersion] = itemRow.item;
                                    itemRow.item = itemEntity;
                                }
                            } else {
                                itemRow = {
                                    id: itemId,
                                    doulist: doulistId,
                                    version: version,
                                    item: itemEntity,
                                }    
                            }
                            await this.storage.doulistItem.put(itemRow);
                        }
                    }
                    await this.storage.doulist.put(doulistRow);
                    this.step();
                }
            }
        }
        if (this.missingTags > 0) {
            await recordDiagnostic(this.diagnosticRunId, 'doulist.missing_tags', {
                task: 'Doulist', count: this.missingTags,
            });
        }
        if (invalidItemIds > 0) {
            await recordDiagnostic(this.diagnosticRunId, 'doulist.invalid_item_id', {
                task: 'Doulist', count: invalidItemIds,
            });
        }
        if (invalidListIds > 0 || invalidItemIds > 0) {
            throw new TaskError('部分豆列缺少有效 ID，其他可识别内容已保存');
        }
        this.complete();
    }

    get name() {
        return '豆列';
    }
}
