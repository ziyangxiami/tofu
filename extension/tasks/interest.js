'use strict';
import Task from '../services/Task.js';
import TaskError from '../services/TaskError.js';
import {numericId, totalCount, htmlPageCount} from './_validation.js';
import {recordDiagnostic} from '../services/diagnostics.js';


const PAGE_SIZE = 50;
const URL_INTERESTS = 'https://m.douban.com/rexxar/api/v2/user/{uid}/interests?type={type}&status={status}&start={start}&count={count}&ck={ck}';
const URL_TOTAL = 'https://m.douban.com/rexxar/api/v2/user/{uid}/interests?ck={ck}&count=1';
const MOVIE_PATHS = {mark: 'wish', doing: 'do', done: 'collect'};
const WEB_PAGE_SIZE = 15;


export default class Interest extends Task {
    async getTotal() {
        let totalURL = URL_TOTAL
            .replace('{ck}', encodeURIComponent(this.session?.cookies?.ck || ''))
            .replace('{uid}', encodeURIComponent(this.targetUser.id));
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
            row.type = type;
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

    async crawlMovieWeb(status, expectedTotal, save) {
        const user = encodeURIComponent(this.targetUser.uid || this.targetUser.id);
        const baseURL = `https://movie.douban.com/people/${user}/${MOVIE_PATHS[status]}`;
        const seen = new Set();
        let pages = 1;
        for (let page = 1; page <= pages; page++) {
            const start = (page - 1) * WEB_PAGE_SIZE;
            const url = `${baseURL}?start=${start}&sort=time&type=all&filter=all&mode=grid`;
            const response = await (await this.fetch)(url);
            if (response.status !== 200) throw new TaskError('影视标记公开页面读取失败，已保留旧备份');
            const html = this.parseHTML(await response.text());
            const countText = html.querySelector('.subject-num')?.textContent || '';
            const countMatch = countText.match(/(\d+)\s*-\s*(\d+)\s*\/\s*(\d+)/);
            const items = html.querySelectorAll('.grid-view > .item');
            pages = htmlPageCount(html, page);
            if (!countMatch || Number(countMatch[1]) !== start + 1 ||
                Number(countMatch[3]) !== expectedTotal ||
                Number(countMatch[2]) !== Math.min(start + WEB_PAGE_SIZE, expectedTotal) ||
                pages !== Math.ceil(expectedTotal / WEB_PAGE_SIZE) ||
                items.length !== Math.min(WEB_PAGE_SIZE, expectedTotal - start)) {
                throw new TaskError('影视标记公开页面数量或分页不完整，已保留旧备份');
            }
            for (const item of items) {
                const link = item.querySelector('.title a');
                const href = link?.getAttribute('href') || '';
                const subjectMatch = href.match(/^https:\/\/movie\.douban\.com\/subject\/(\d+)\/?(?:\?.*)?$/);
                const id = numericId(item.getAttribute('data-cid'), '影视标记');
                if (!subjectMatch || seen.has(id)) {
                    throw new TaskError('影视标记公开页面包含无效或重复条目，已保留旧备份');
                }
                seen.add(id);
                const title = (item.querySelector('.title em') || link).textContent.trim();
                const ratingClass = item.querySelector('[class*="rating"][class$="-t"]')?.getAttribute('class') || '';
                const rating = ratingClass.match(/(?:^|\s)rating([1-5])-t(?:\s|$)/);
                const tags = (item.querySelector('.tags')?.textContent || '').replace(/^\s*标签[:：]\s*/, '').trim();
                await save({
                    id, status, comment: (item.querySelector('.comment')?.textContent || '').trim(),
                    create_time: (item.querySelector('.date')?.textContent || '').trim(),
                    rating: rating ? {value: Number(rating[1])} : null,
                    tags: tags ? tags.split(/\s+/) : [], is_private: !!item.querySelector('.private'),
                    subject: {
                        id: subjectMatch[1], type: 'movie', title, url: href,
                        card_subtitle: (item.querySelector('.intro')?.textContent || '').trim(),
                        pic: {normal: item.querySelector('.pic img')?.getAttribute('src') || ''},
                        null_rating_reason: '公开页面未提供评分',
                    },
                }, true);
            }
        }
        if (seen.size !== expectedTotal) throw new TaskError('影视标记公开页面数量不完整，已保留旧备份');
    }

    async crawlSegment(baseURL, type, status, savedIds, savedSubjects) {
        const ids = new Set();
        let total = null;
        let failedSlices = 0;
        const save = async (interest, fromWeb = false) => {
            const id = numericId(interest?.id, '标记');
            const subject = numericId(interest?.subject?.id, '条目');
            if (interest.status !== status ||
                (savedIds.has(id) && savedIds.get(id) !== subject) ||
                (savedSubjects.has(subject) && savedSubjects.get(subject) !== id)) {
                throw new TaskError('标记接口返回重复或不一致的条目，已保留旧备份');
            }
            // Repeated API pages cannot inflate progress. The public scan checks
            // its own page identities before filling only the missing records.
            if (ids.has(id)) return;
            if (savedIds.has(id)) throw new TaskError('不同分类返回重复标记，已保留旧备份');
            if (fromWeb) {
                const previous = await this.storage.interest.get({subject});
                if (previous?.interest?.subject) {
                    interest.subject = {...previous.interest.subject, ...interest.subject,
                        rating: previous.interest.subject.rating,
                        null_rating_reason: previous.interest.subject.null_rating_reason || interest.subject.null_rating_reason};
                }
            }
            await this.processInterest(interest, this.jobId, type);
            savedIds.set(id, subject);
            savedSubjects.set(subject, id);
            ids.add(id);
        };
        const read = async (start, count) => {
            const url = baseURL.replace('{start}', start).replace('{count}', count);
            const response = await (await this.fetch)(url, {headers: {'X-Override-Referer': 'https://m.douban.com/mine/' + type}});
            if (response.status !== 200) return {status: response.status};
            const json = await response.json();
            const pageTotal = totalCount(json);
            const pageSize = json.count === undefined ? count : Number(json.count);
            if (!Array.isArray(json.interests) ||
                !Number.isSafeInteger(pageSize) || pageSize < 0 || (pageSize === 0 && pageTotal !== 0) || pageSize > count ||
                (json.start !== undefined && Number(json.start) !== start) ||
                json.interests.length > Math.min(pageSize, Math.max(0, pageTotal - start))) {
                throw new TaskError('标记接口响应格式或分页位置错误，已保留旧备份');
            }
            if (total === null) total = pageTotal;
            if (total !== pageTotal) throw new TaskError('备份期间标记总数发生变化，请重试');
            for (const interest of json.interests) await save(interest);
            return {status: 200, pageSize};
        };

        for (let start = 0; total === null || start < total;) {
            const page = await read(start, PAGE_SIZE);
            if (page.status === 500) {
                // Keep the existing single-record recovery for a broken page.
                for (let offset = start; offset < start + PAGE_SIZE && (total === null || offset < total); offset++) {
                    const slice = await read(offset, 1);
                    if (slice.status !== 200) failedSlices++;
                }
                if (total === null) throw new TaskError('部分书影音标记获取失败，已保留旧备份，请重试');
                start += PAGE_SIZE;
            } else {
                if (page.status !== 200) throw new TaskError('豆瓣服务器返回错误: ' + page.status);
                // The server can cap count below the requested 50. Advancing by
                // the requested size skips entire ranges in that case.
                start += page.pageSize;
            }
        }
        await recordDiagnostic(this.diagnosticRunId, 'interest.segment', {
            subjectType: type, interestStatus: status, count: ids.size, total,
        });
        if (ids.size < total && type === 'movie') {
            this.logger?.warning('影视标记接口返回数量不足，改用豆瓣电影公开页面补齐。');
            await recordDiagnostic(this.diagnosticRunId, 'interest.fallback', {
                subjectType: type, interestStatus: status, count: ids.size, total,
            });
            await this.crawlMovieWeb(status, total, save);
        }
        if (ids.size !== total || (failedSlices && type !== 'movie')) {
            throw new TaskError(`部分书影音标记获取失败（${type}/${status}：实际 ${ids.size} / ${total}），已保留旧备份，请重试`);
        }
        await recordDiagnostic(this.diagnosticRunId, 'interest.verified', {
            subjectType: type, interestStatus: status, count: ids.size, total,
        });
        return total;
    }

    async run() {
        this.completion = 0;
        this.total = await this.getTotal();
        const baseURL = URL_INTERESTS
            .replace('{ck}', encodeURIComponent(this.session?.cookies?.ck || ''))
            .replace('{uid}', encodeURIComponent(this.targetUser.id));
        const savedIds = new Map();
        const savedSubjects = new Map();
        let verifiedTotal = 0;
        for (const type of ['game', 'music', 'book', 'movie', 'drama']) {
            for (const status of ['mark', 'doing', 'done']) {
                const url = baseURL.replace('{type}', type).replace('{status}', status);
                verifiedTotal += await this.crawlSegment(url, type, status, savedIds, savedSubjects);
            }
        }
        // Publish only after each category has the advertised number of unique
        // records. Never turn the API's total into a fabricated saved count.
        if (this.completion !== verifiedTotal) throw new TaskError('书影音标记保存数量不一致，已保留旧备份');
        this.total = verifiedTotal;
        await this.storage.table('version').put({table: 'interest', version: this.jobId, updated: Date.now()});
    }

    get name() {
        return '书/影/音/游';
    }
}
