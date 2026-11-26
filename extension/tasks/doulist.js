'use strict';
import Task from '../services/Task.js';
import TaskError from '../services/TaskError.js';
import {recordDiagnostic} from '../services/diagnostics.js';
import {pageStep, htmlPageCount, assertNotChallengePage} from './_validation.js';


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

    async fetchListPage(url, type, start) {
        // Retry the same read once when HTTP 200 contradicts itself. Do not
        // skip the missing page or publish a partial snapshot as successful.
        for (let attempt = 1; attempt <= 2; attempt++) {
            const fetch = await this.fetch;
            const response = await fetch(url, {headers: {'X-Override-Referer': 'https://m.douban.com/mine/doulist'}});
            if (response.status !== 200) {
                await recordDiagnostic(this.diagnosticRunId, 'doulist.api', {
                    task: 'Doulist', listType: type, status: response.status,
                    pages: start / PAGE_SIZE + 1, attempt, reason: 'http_error',
                });
                throw new TaskError('豆瓣服务器返回错误');
            }
            const json = await response.json();
            if (!json || json.code || !Array.isArray(json.doulists)) {
                await recordDiagnostic(this.diagnosticRunId, 'doulist.api', {
                    task: 'Doulist', listType: type, status: response.status,
                    pages: start / PAGE_SIZE + 1, attempt, reason: 'invalid_response',
                });
                throw new TaskError('豆列接口响应格式错误');
            }
            const totalText = String(json.total ?? '');
            const total = /^\d+$/.test(totalText) ? Number(totalText) : NaN;
            const validTotal = Number.isSafeInteger(total) && total >= 0;
            const emptyPage = validTotal && start < total && json.doulists.length === 0;
            await recordDiagnostic(this.diagnosticRunId, 'doulist.api', {
                task: 'Doulist', listType: type, status: response.status,
                pages: start / PAGE_SIZE + 1, attempt,
                apiTotal: validTotal ? total : undefined, apiGroups: json.doulists.length,
                reason: emptyPage ? 'empty_response' :
                    (!validTotal || (total === 0 && json.doulists.length > 0) ? 'invalid_response' : undefined),
            });
            if (!validTotal || (total === 0 && json.doulists.length > 0)) {
                throw new TaskError('豆列接口未返回有效总数或分页内容');
            }
            if (!emptyPage) return {json, total};
            if (attempt === 2) {
                throw new TaskError(`豆列接口显示共有 ${total} 个，但第 ${start / PAGE_SIZE + 1} 页连续两次为空，已保留旧备份，请稍后重试`);
            }
        }
    }

    async run() {
        let version = this.jobId;
        this.missingTags = 0;
        let invalidListIds = 0;
        let invalidItemIds = 0;
        const profileCount = value => Number.isSafeInteger(Number(value)) && Number(value) >= 0 ? Number(value) : 0;
        const totals = {
            owned: profileCount(this.targetUser.owned_doulist_count),
            following: profileCount(this.targetUser.following_doulist_count),
        };
        this.total = totals.owned + totals.following;
        if (this.total === 0) {
            // Default to 1 to allow checking via API in case count properties are absent in targetUser
            this.total = 1;
        }

        let baseURL = URL_DOULIST
            .replace('{ck}', this.session?.cookies?.ck || '')
            .replace('{uid}', this.targetUser.id);

        for (let type of ['owned', 'following']) {
            let urlWithType = baseURL.replace('{type}', type);
            let segmentTotal = null;
            for (let start = 0; segmentTotal === null || start < segmentTotal;) {
                const {json, total} = await this.fetchListPage(urlWithType.replace('{start}', start), type, start);
                totals[type] = segmentTotal = total;
                this.total = totals.owned + totals.following;
                const step = pageStep(json, start, PAGE_SIZE, total);
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
                            throw new TaskError('豆瓣服务器返回错误');
                        }
                        let html = this.parseHTML(await response.text());
                        assertNotChallengePage(html, '豆列页面', response.url);
                        if (i > 0 && !html.querySelector('.paginator')) {
                            throw new TaskError('豆列分页信息缺失，已保存此前内容');
                        }
                        const parsedPages = htmlPageCount(html, i + 1);
                        if (i > 0 && parsedPages < doulistTotalPage) {
                            throw new TaskError('豆列分页信息异常，已保存此前内容');
                        }
                        doulistTotalPage = parsedPages;
                        for (let item of html.querySelectorAll('.doulist-item')) {
                            let addBtn = item.querySelector('.lnk-doulist-add');
                            if (!addBtn) continue;
                            let itemId = this.numericId(String(item.id || '').match(/(\d+)$/)?.[1]);
                            if (itemId === null) {
                                invalidItemIds++;
                                continue;
                            }
                            let itemBody = item.querySelector('.bd');
                            if (!itemBody) {
                                invalidItemIds++;
                                continue;
                            }
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
                start += step;
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
        await this.storage.table('version').put({table: 'doulist', version: version, updated: Date.now()});
        this.complete();
    }

    get name() {
        return '豆列';
    }
}
