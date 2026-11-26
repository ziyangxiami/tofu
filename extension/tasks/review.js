'use strict';
import Task from '../services/Task.js';
import TaskError from '../services/TaskError.js';
import {numericId, validatePage, pageStep} from './_validation.js';
import Storage  from "../storage.js";

const PAGE_SIZE = 50;
const URL_REVIEWS = 'https://m.douban.com/rexxar/api/v2/user/{uid}/reviews?type={type}&start={start}&count=50&ck={ck}&for_mobile=1';


export default class Review extends Task {
    async fetchReview(url) {
        let fetch = await this.fetch
        let response = await fetch(url);
        if (response.status !== 200) {
            throw new TaskError('评论正文获取失败，已保留旧备份');
        }
        let htmlText = await response.text();
        let html = this.parseHTML(htmlText);
        let contentNode = html.querySelector('.review-content') || html.querySelector('#link-report') || html.querySelector('.article');
        
        if (!contentNode) {
            throw new TaskError('无法识别评论正文，已保留旧备份');
        }
        return contentNode.innerHTML;
    }

    async run() {
        let version = this.jobId;
        this.total = 0;

        let baseURL = URL_REVIEWS
            .replace('{ck}', this.session?.cookies?.ck || '')
            .replace('{uid}', this.targetUser.id);

        const seenIds = new Set();
        for (let type of ['music', 'book', 'movie', 'drama', 'game']) {
            let fullURL = baseURL.replace('{type}', type);
            let typeTotal = null;
            for (let start = 0; typeTotal === null || start < typeTotal;) {
                let response = await (await this.fetch)(fullURL.replace('{start}', start), {headers: {'X-Override-Referer': 'https://m.douban.com/mine/' + type}});
                if (response.status !== 200) {
                    throw new TaskError('豆瓣服务器返回错误');
                }
                let json = await response.json();
                const total = validatePage(json, 'reviews', start);
                if (typeTotal === null) {
                    typeTotal = total;
                    this.total += total;
                } else if (typeTotal !== total) {
                    throw new TaskError('备份期间评论总数发生变化，请重试');
                }
                const step = pageStep(json, start, PAGE_SIZE, typeTotal);
                for (let review of json.reviews) {
                    const reviewId = numericId(review.id, '评论');
                    if (seenIds.has(reviewId)) continue;
                    seenIds.add(reviewId);
                    let fulltext = await this.fetchReview(review.url);
                    let row = await this.storage.review.get(reviewId);
                    if (row) {
                        let lastVersion = row.version;
                        row.version = version;
                        if (fulltext !== row.review.fulltext) {
                            !row.history && (row.history = {});
                            row.history[lastVersion] = row.review;
                            review.fulltext = fulltext;
                            row.review = review;
                        }
                    } else {
                        review.fulltext = fulltext;
                        row = {
                            id: reviewId,
                            version: version,
                            type: type,
                            review: review,
                        }
                    }
                    await this.storage.review.put(row);
                    this.step();
                }
                start += step;
            }
        }
        await this.storage.table('version').put({table: 'review', version: version, updated: Date.now()});
        this.total = this.completion;
    }

    get name() {
        return '评论';
    }
}
