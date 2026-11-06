'use strict';
import Task from '../services/Task.js';
import TaskError from '../services/TaskError.js';
import {numericId, validatePage} from './_validation.js';
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

        for (let type of ['music', 'book', 'movie', 'drama', 'game']) {
            let fullURL = baseURL.replace('{type}', type);
            let pageCount = 1;
            for (let i = 0; i < pageCount; i ++) {
                let response = await (await this.fetch)(fullURL.replace('{start}', i * PAGE_SIZE), {headers: {'X-Override-Referer': 'https://m.douban.com/mine/' + type}});
                if (response.status !== 200) {
                    throw new TaskError('豆瓣服务器返回错误');
                }
                let json = await response.json();
                const total = validatePage(json, 'reviews', i * PAGE_SIZE);
                if (i === 0) this.total += total;
                pageCount = Math.ceil(total / PAGE_SIZE);
                for (let review of json.reviews) {
                    let fulltext = await this.fetchReview(review.url);
                    let row = await this.storage.review.get(numericId(review.id, '评论'));
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
                            id: numericId(review.id, '评论'),
                            version: version,
                            type: type,
                            review: review,
                        }
                    }
                    await this.storage.review.put(row);
                    this.step();
                }
            }
        }
        await this.storage.table('version').put({table: 'review', version: version, updated: Date.now()});
        this.complete();
    }

    get name() {
        return '评论';
    }
}
