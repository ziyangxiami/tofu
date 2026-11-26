'use strict';
import Task from '../services/Task.js';
import TaskError from '../services/TaskError.js';
import {numericId, totalCount, htmlPageCount, assertNotChallengePage} from './_validation.js';
import {recordDiagnostic} from '../services/diagnostics.js';


const PAGE_SIZE = 50;
const URL_INTERESTS = 'https://m.douban.com/rexxar/api/v2/user/{uid}/interests?type={type}&status={status}&start={start}&count={count}&ck={ck}';
const URL_TOTAL = 'https://m.douban.com/rexxar/api/v2/user/{uid}/interests?ck={ck}&count=1';
const STATUS_PATHS = {mark: 'wish', doing: 'do', done: 'collect'};
const SUBJECT_TYPES = ['game', 'music', 'book', 'movie', 'drama'];
const STATUSES = ['mark', 'doing', 'done'];
const WEB_PAGE_SIZE = 15;
const AUTH_ERROR_STATUSES = new Set([401, 403, 429]);
const WEB_CONFIG = {
    movie: {
        label: '影视',
        host: 'movie.douban.com',
        query: 'sort=time&type=all&filter=all&mode=grid',
        containerSelector: '.grid-view',
        itemSelector: '.grid-view > .item',
        subjectPattern: /^https:\/\/movie\.douban\.com\/subject\/(\d+)\/?(?:\?.*)?$/,
        allowedSubjectTypes: new Set(['movie', 'tv']),
    },
    music: {
        label: '音乐',
        host: 'music.douban.com',
        query: 'sort=time&type=all&filter=all&mode=grid',
        containerSelector: '.grid-view',
        itemSelector: '.grid-view > .item',
        subjectPattern: /^https:\/\/music\.douban\.com\/subject\/(\d+)\/?(?:\?.*)?$/,
        allowedSubjectTypes: new Set(['music']),
    },
    book: {
        label: '图书',
        host: 'book.douban.com',
        query: 'sort=time&rating=all&filter=all&mode=grid',
        containerSelector: '.interest-list',
        itemSelector: '.interest-list > li.subject-item, li.subject-item',
        subjectPattern: /^https:\/\/book\.douban\.com\/subject\/(\d+)\/?(?:\?.*)?$/,
        allowedSubjectTypes: new Set(['book']),
    },
};

function httpTaskError(message, status) {
    const error = new TaskError(message);
    if (Number.isSafeInteger(status)) error.httpStatus = status;
    return error;
}


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
        if (Boolean(l.is_private) !== Boolean(r.is_private)) return false;
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

    async crawlWeb(type, status, expectedTotal, save, {startPage = 1, seenIds = null, onPage = null, resumed = false} = {}) {
        const cfg = WEB_CONFIG[type];
        if (!cfg) return false;
        const user = encodeURIComponent(this.targetUser.uid || this.targetUser.id);
        const baseURL = `https://${cfg.host}/people/${user}/${STATUS_PATHS[status]}`;
        const seen = new Set(seenIds || []);
        const expectedPages = Math.ceil(expectedTotal / WEB_PAGE_SIZE);
        for (let page = startPage; page <= expectedPages; page++) {
            const start = (page - 1) * WEB_PAGE_SIZE;
            const url = `${baseURL}?start=${start}&${cfg.query}`;
            const expectedPageItems = Math.min(WEB_PAGE_SIZE, expectedTotal - start);
            let parsedPage = null;
            for (let attempt = 1; attempt <= 2; attempt++) {
                const response = await (await this.fetch)(url);
                if (response.status !== 200) {
                    const reason = response.status === 429 ? 'rate_limited' : 'http_error';
                    if (attempt === 2 || AUTH_ERROR_STATUSES.has(response.status)) {
                        await recordDiagnostic(this.diagnosticRunId, 'interest.fallback_failed', {
                            subjectType: type, interestStatus: status, status: response.status, pages: page, reason,
                        });
                        throw httpTaskError(`${cfg.label}标记公开页面读取失败（HTTP ${response.status}），已保留旧备份`, response.status);
                    }
                    continue;
                }
                const html = this.parseHTML(await response.text());
                try {
                    assertNotChallengePage(html, `${cfg.label}标记公开页面`, response.url);
                } catch (error) {
                    await recordDiagnostic(this.diagnosticRunId, 'interest.fallback_failed', {
                        subjectType: type, interestStatus: status,
                        status: error?.httpStatus || 429, pages: page, reason: 'rate_limited',
                    });
                    throw error;
                }
                const countText = html.querySelector('.subject-num')?.textContent || '';
                const countMatch = countText.match(/(\d+)\s*-\s*(\d+)\s*\/\s*(\d+)/);
                if (resumed && countMatch && Number(countMatch[3]) !== expectedTotal) {
                    const error = new TaskError('备份期间标记总数发生变化，请重试');
                    error.resetCheckpoint = true;
                    throw error;
                }
                const items = html.querySelectorAll(cfg.itemSelector);
                const hasContainer = !!html.querySelector(cfg.containerSelector) ||
                    (type === 'book' && items.length > 0);
                let pages = null;
                let pageCountError = null;
                try {
                    pages = htmlPageCount(html, page);
                } catch (error) {
                    pageCountError = error;
                }
                if (pageCountError || !hasContainer || (expectedPages > 1 && !html.querySelector('.paginator')) ||
                    !countMatch || Number(countMatch[1]) !== start + 1 ||
                    Number(countMatch[3]) !== expectedTotal ||
                    Number(countMatch[2]) !== Math.min(start + WEB_PAGE_SIZE, expectedTotal) ||
                    pages !== expectedPages || items.length > expectedPageItems) {
                    if (attempt === 1) continue;
                    await recordDiagnostic(this.diagnosticRunId, 'interest.fallback_failed', {
                        subjectType: type, interestStatus: status, pages: page, reason: 'invalid_response',
                    });
                    throw pageCountError || new TaskError(`${cfg.label}标记公开页面数量或分页不完整，已保留旧备份`);
                }
                if (items.length > 0 || expectedPageItems === 0) {
                    parsedPage = items;
                    break;
                }
            }
            if (!parsedPage) {
                await recordDiagnostic(this.diagnosticRunId, 'interest.fallback_failed', {
                    subjectType: type, interestStatus: status, pages: page, reason: 'empty_response',
                });
                throw new TaskError(`${cfg.label}标记公开页面第 ${page} 页未返回任何条目，已保留旧备份`);
            }
            for (const item of parsedPage) {
                const link = item.querySelector('.info h2 a, h2 a, .title a');
                const href = (link?.getAttribute('href') || '').trim();
                const subjectMatch = href.match(cfg.subjectPattern);
                const cid = item.getAttribute('data-cid') || item.querySelector('[data-cid]')?.getAttribute('data-cid');
                const id = numericId(cid, `${cfg.label}标记`);
                if (!subjectMatch || seen.has(id)) {
                    throw new TaskError(`${cfg.label}标记公开页面包含无效或重复条目，已保留旧备份`);
                }
                seen.add(id);
                const title = (item.querySelector('.title em')?.textContent || link?.getAttribute('title') || link?.textContent || '').replace(/\s+/g, ' ').trim();
                const ratingClass = item.querySelector('[class*="rating"][class$="-t"]')?.getAttribute('class') || '';
                const rating = ratingClass.match(/(?:^|\s)rating([1-5])-t(?:\s|$)/);
                const tags = (item.querySelector('.short-note .tags, .tags')?.textContent || '').replace(/^\s*标签[:：]\s*/, '').trim();
                const dateText = (item.querySelector('.short-note .date, .date')?.textContent || '')
                    .replace(/\s+/g, ' ')
                    .replace(/\s*(想读|在读|读过|想看|在看|看过|想听|在听|听过)\s*$/, '')
                    .trim();
                await save({
                    id, status,
                    comment: (item.querySelector('.short-note .comment, .comment')?.textContent || '').trim(),
                    create_time: dateText,
                    rating: rating ? {value: Number(rating[1])} : null,
                    tags: tags ? tags.split(/\s+/) : [],
                    is_private: !!item.querySelector('.private'),
                    subject: {
                        id: subjectMatch[1], type, title, url: href,
                        card_subtitle: (item.querySelector('.intro, .pub')?.textContent || '').replace(/\s+/g, ' ').trim(),
                        pic: {normal: item.querySelector('.pic img')?.getAttribute('src') || ''},
                        null_rating_reason: '公开页面未提供评分',
                    },
                }, true);
            }
            if (onPage) await onPage({page, seen: [...seen]});
        }
        if (expectedTotal > 0 && seen.size === 0) {
            throw new TaskError(`${cfg.label}标记公开页面未读取到有效条目，已保留旧备份`);
        }
        return true;
    }

    async crawlSegment(baseURL, type, status, savedIds, savedSubjects, options = {}) {
        const {initialIds = null, partial = null, onPartial = null} = options;
        const preloadedIds = initialIds ? new Map(initialIds) : new Map();
        const ids = new Set(preloadedIds.keys());
        const webConfig = WEB_CONFIG[type];
        let total = partial?.total ?? null;
        let failedSlices = 0;
        let incompleteApi = false;
        let webFallbackRequired = Boolean(partial?.webFallbackRequired);
        const save = async (interest, fromWeb = false) => {
            const id = numericId(interest?.id, '标记');
            const subject = numericId(interest?.subject?.id, '条目');
            const subjectType = interest?.subject?.type;
            const allowedTypes = webConfig?.allowedSubjectTypes || new Set([type]);
            if (interest.status !== status ||
                (subjectType && !allowedTypes.has(subjectType)) ||
                (savedIds.has(id) && savedIds.get(id) !== subject) ||
                (savedSubjects.has(subject) && savedSubjects.get(subject) !== id)) {
                throw new TaskError('标记接口返回重复、类型不符或不一致的条目，已保留旧备份');
            }
            // Repeated API pages cannot inflate progress. The public scan checks
            // its own page identities before filling only the missing records.
            if (ids.has(id)) return preloadedIds.has(id) ? 'preloaded' : false;
            if (savedIds.has(id)) throw new TaskError('不同分类返回重复标记，已保留旧备份');
            if (fromWeb) {
                const previous = await this.storage.interest.get({subject});
                if (previous?.interest) {
                    if (!interest.is_private && previous.interest.is_private) {
                        interest.is_private = previous.interest.is_private;
                    }
                    if (previous.interest.subject) {
                        interest.subject = {...previous.interest.subject, ...interest.subject,
                            rating: previous.interest.subject.rating,
                            null_rating_reason: previous.interest.subject.null_rating_reason || interest.subject.null_rating_reason};
                    }
                }
            }
            await this.processInterest(interest, this.jobId, type);
            savedIds.set(id, subject);
            savedSubjects.set(subject, id);
            ids.add(id);
            return true;
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
            if (total !== pageTotal) {
                const error = new TaskError('备份期间标记总数发生变化，请重试');
                error.resetCheckpoint = true;
                throw error;
            }
            let newItems = 0;
            let preloadedCount = 0;
            for (const interest of json.interests) {
                const saved = await save(interest);
                if (saved === true) newItems++;
                else if (saved === 'preloaded') preloadedCount++;
            }
            return {status: 200, pageSize, itemCount: json.interests.length, newItems, preloadedCount};
        };
        const recover500 = async start => {
            for (let offset = start; offset < start + PAGE_SIZE && (total === null || offset < total); offset++) {
                const slice = await read(offset, 1);
                if (slice.status !== 200) {
                    if (AUTH_ERROR_STATUSES.has(slice.status)) {
                        throw httpTaskError('豆瓣服务器返回错误: ' + slice.status, slice.status);
                    }
                    failedSlices++;
                }
            }
            if (total === null) throw new TaskError('部分书影音标记获取失败，已保留旧备份，请重试');
        };

        if (partial?.phase !== 'web') {
            const resumeStart = partial?.phase === 'api' ? (partial.nextStart || 0) : 0;
            let apiPages = 0;
            for (let start = resumeStart; total === null || start < total;) {
                const page = await read(start, PAGE_SIZE);
                let stepSize = PAGE_SIZE;
                if (page.status === 500) {
                    if (webFallbackRequired && webConfig && total !== null) {
                        const retry500 = await read(start, PAGE_SIZE);
                        if (AUTH_ERROR_STATUSES.has(retry500.status)) {
                            throw httpTaskError('豆瓣服务器返回错误: ' + retry500.status, retry500.status);
                        }
                        if (retry500.status === 200) stepSize = retry500.pageSize;
                    } else {
                        await recover500(start);
                    }
                } else {
                    if (page.status !== 200) throw httpTaskError('豆瓣服务器返回错误: ' + page.status, page.status);
                    stepSize = page.pageSize;
                    const expectedItems = Math.min(page.pageSize, Math.max(0, total - start));
                    const hadOverlap = !webConfig && page.itemCount > 0 && (page.newItems + page.preloadedCount) < page.itemCount;
                    if (!webFallbackRequired && (page.itemCount < expectedItems || hadOverlap)) {
                        const retryPage = await read(start, page.pageSize);
                        if (retryPage.status === 500) {
                            await recover500(start);
                        } else if (retryPage.status !== 200) {
                            throw httpTaskError('豆瓣服务器返回错误: ' + retryPage.status, retryPage.status);
                        } else if (hadOverlap && page.newItems + page.preloadedCount + retryPage.newItems < page.itemCount) {
                            incompleteApi = true;
                        } else if (webConfig && retryPage.itemCount < expectedItems) {
                            webFallbackRequired = true;
                        }
                    }
                }
                // The server can cap count below the requested 50. Advancing by
                // the requested size skips entire ranges in that case.
                start += stepSize;
                apiPages++;
                if (onPartial) {
                    await onPartial({phase: 'api', total, nextStart: start, webFallbackRequired}, apiPages % 10 === 0);
                }
            }
        }
        await recordDiagnostic(this.diagnosticRunId, 'interest.segment', {
            subjectType: type, interestStatus: status, count: ids.size, total,
        });
        let webVerified = false;
        if (ids.size < total && webConfig) {
            const startPage = partial?.phase === 'web' ? (partial.nextPage || 1) : 1;
            const seenIds = partial?.phase === 'web' ? partial.webSeen : null;
            if (startPage === 1) {
                this.logger?.warning(`${webConfig.label}标记接口返回数量不足（${ids.size} / ${total}），改用公开页面补齐并核验。`);
                await recordDiagnostic(this.diagnosticRunId, 'interest.fallback', {
                    subjectType: type, interestStatus: status, count: ids.size, total,
                });
            }
            if (onPartial) {
                await onPartial({
                    phase: 'web', total, nextPage: startPage, webSeen: seenIds || [], webFallbackRequired: true,
                }, true);
            }
            webVerified = await this.crawlWeb(type, status, total, save, {
                startPage, seenIds, resumed: Boolean(partial),
                onPage: onPartial ? ({page, seen}) => onPartial({
                    phase: 'web', total, nextPage: page + 1, webSeen: seen, webFallbackRequired: true,
                }, page % 10 === 0) : null,
            });
        }
        const unavailable = total - ids.size;
        if (unavailable < 0) {
            throw new TaskError(`书影音标记数量异常（${type}/${status}：实际 ${ids.size} / ${total}），已保留旧备份，请重试`);
        }
        if (unavailable > 0) {
            if (webConfig) {
                if (!webVerified || ids.size === 0) {
                    throw new TaskError(`部分书影音标记获取失败（${type}/${status}：实际 ${ids.size} / ${total}），已保留旧备份，请重试`);
                }
                this.logger?.warning(`${webConfig.label}标记（${type}/${status}）声明 ${total} 条，已完整获取 ${ids.size} 条，另有 ${unavailable} 条在豆瓣端已不可见或下架。`);
            } else if (failedSlices || incompleteApi || ids.size === 0) {
                throw new TaskError(`部分书影音标记获取失败（${type}/${status}：实际 ${ids.size} / ${total}），已保留旧备份，请重试`);
            } else {
                this.logger?.warning(`书影音标记（${type}/${status}）声明 ${total} 条，接口返回 ${ids.size} 条，另有 ${unavailable} 条在豆瓣端已不可见或下架。`);
            }
        }
        await recordDiagnostic(this.diagnosticRunId, 'interest.verified', {
            subjectType: type, interestStatus: status, count: ids.size, total,
            unavailable: unavailable > 0 ? unavailable : undefined,
        });
        return {savedCount: ids.size, declaredTotal: total};
    }

    async run() {
        const canCheckpoint = typeof this.storage.interest.filter === 'function' &&
            (typeof this.saveCheckpoint === 'function' || this.checkpoint?.kind === 'interest-v1');
        const resume = canCheckpoint && this.checkpoint?.kind === 'interest-v1' ? this.checkpoint : null;
        this.completion = 0;
        let overviewTotal = null;
        try {
            overviewTotal = await this.getTotal();
            this.total = overviewTotal;
        } catch (_) {
            this.logger?.warning('书影音总览数量读取失败，将直接按各分类核对备份。');
            this.total = 0;
        }
        if (overviewTotal === null && typeof resume?.overviewTotal === 'number') {
            overviewTotal = resume.overviewTotal;
            this.total = overviewTotal;
        }
        const hadPrevious = typeof this.storage.interest.count === 'function' ?
            (await this.storage.interest.count()) > 0 : false;
        const baseURL = URL_INTERESTS
            .replace('{ck}', encodeURIComponent(this.session?.cookies?.ck || ''))
            .replace('{uid}', encodeURIComponent(this.targetUser.id));
        const savedIds = new Map();
        const savedSubjects = new Map();
        const segmentMaps = new Map();
        const completedSegments = {};
        let partialSegment = null;
        if (resume) {
            const stageRows = await this.storage.interest.filter(row => row.version === this.jobId).toArray();
            for (const row of stageRows) {
                const segKey = `${row.type}/${row.status}`;
                const subjectId = numericId(row.subject, '条目');
                const id = numericId(row.id, '标记');
                if (savedIds.has(id) || savedSubjects.has(subjectId)) {
                    this.checkpoint = null;
                    await this.saveCheckpoint?.();
                    throw new TaskError('书影音断点状态不一致，已保留旧备份，请重试');
                }
                savedIds.set(id, subjectId);
                savedSubjects.set(subjectId, id);
                if (!segmentMaps.has(segKey)) segmentMaps.set(segKey, new Map());
                segmentMaps.get(segKey).set(id, subjectId);
            }
            for (const [segKey, info] of Object.entries(resume.completedSegments || {})) {
                const actual = segmentMaps.get(segKey)?.size || 0;
                if (!info || actual !== info.savedCount) {
                    this.checkpoint = null;
                    await this.saveCheckpoint?.();
                    throw new TaskError('书影音断点状态不一致，已保留旧备份，请重试');
                }
                completedSegments[segKey] = {savedCount: info.savedCount, declaredTotal: info.declaredTotal};
            }
            partialSegment = resume.partialSegment || null;
            this.completion = savedIds.size;
            if (!this.total && savedIds.size > 0) this.total = savedIds.size;
        }
        const persistCheckpoint = async (flush = false) => {
            if (!canCheckpoint) return;
            this.checkpoint = {kind: 'interest-v1', overviewTotal, completedSegments, partialSegment};
            if (flush && this.saveCheckpoint) await this.saveCheckpoint();
        };
        let verifiedSaved = 0;
        let declaredTotal = 0;
        const failedSegments = [];
        let consecutiveAuthErrors = 0;
        outer: for (const type of SUBJECT_TYPES) {
            for (const status of STATUSES) {
                const segKey = `${type}/${status}`;
                if (completedSegments[segKey]) {
                    verifiedSaved += completedSegments[segKey].savedCount;
                    declaredTotal += completedSegments[segKey].declaredTotal;
                    continue;
                }
                const url = baseURL.replace('{type}', type).replace('{status}', status);
                try {
                    const activePartial = partialSegment?.key === segKey ? partialSegment : null;
                    const segment = await this.crawlSegment(url, type, status, savedIds, savedSubjects, {
                        initialIds: segmentMaps.get(segKey) || null,
                        partial: activePartial,
                        onPartial: canCheckpoint ? async (state, flush) => {
                            partialSegment = {key: segKey, ...state};
                            await persistCheckpoint(flush);
                        } : null,
                    });
                    completedSegments[segKey] = segment;
                    if (partialSegment?.key === segKey) partialSegment = null;
                    await persistCheckpoint(true);
                    verifiedSaved += segment.savedCount;
                    declaredTotal += segment.declaredTotal;
                    consecutiveAuthErrors = 0;
                } catch (error) {
                    const message = error?.message || String(error);
                    failedSegments.push({type, status, message});
                    this.logger?.error?.(message);
                    if (error?.resetCheckpoint) {
                        partialSegment = null;
                        this.checkpoint = null;
                        await this.saveCheckpoint?.();
                        break outer;
                    }
                    await persistCheckpoint(true);
                    if (error?.httpStatus === 429) break outer;
                    if (AUTH_ERROR_STATUSES.has(error?.httpStatus)) {
                        consecutiveAuthErrors++;
                        if (consecutiveAuthErrors >= 2) break outer;
                    } else {
                        consecutiveAuthErrors = 0;
                    }
                }
            }
        }
        if (failedSegments.length > 0) {
            const detail = failedSegments.slice(0, 5)
                .map(item => `${item.type}/${item.status}: ${item.message}`)
                .join('；');
            const suffix = failedSegments.length > 5 ? ` 等共 ${failedSegments.length} 项` : '';
            throw new TaskError(`部分书影音标记获取失败（${detail}${suffix}），已保留旧备份，请重试`);
        }
        if (declaredTotal === 0 && (overviewTotal > 0 || (overviewTotal === null && hadPrevious))) {
            throw new TaskError('书影音总览显示有记录或总览未知但各分类均返回 0，已保留旧备份，请检查登录或验证状态后重试');
        }
        const persistedCount = typeof this.storage.interest.filter === 'function' ?
            await this.storage.interest.filter(row => row.version === this.jobId).count() :
            this.completion;
        // Publish only after each category and the staging database match the
        // verified saved count. Never turn the API's total into a fabricated count.
        if (this.completion !== verifiedSaved || persistedCount !== verifiedSaved) {
            throw new TaskError('书影音标记保存数量不一致，已保留旧备份');
        }
        this.checkpoint = null;
        this.total = verifiedSaved;
        await this.storage.table('version').put({table: 'interest', version: this.jobId, updated: Date.now()});
    }

    get name() {
        return '书/影/音/游';
    }
}
