'use strict';
import Task from '../services/Task.js';
import TaskError from '../services/TaskError.js';
import {recordDiagnostic} from '../services/diagnostics.js';


const PAGE_SIZE = 50;
const URL_ANNOTATIONS = 'https://m.douban.com/rexxar/api/v2/user/{uid}/annotations?start={start}&count=50&ck={ck}&for_mobile=1';
const URL_ANNOTATIONS_WEB = 'https://book.douban.com/people/{uid}/annotation/';


export default class Annotation extends Task {
    async fetchAnnotation(url) {
        let fetch = await this.fetch
        let response = await fetch(url);
        if (response.status !== 200) {
            return '';
        }
        let html = this.parseHTML(await response.text());
        let node = html.querySelector('#link-report') || html.querySelector('.article') || html.querySelector('.annotation-content');
        return node ? node.innerHTML : '';
    }

    async fetchWebAnnotation(url, fallbackText = '') {
        let response = await this.fetch(url);
        if (response.status !== 200) {
            return { fulltext: fallbackText };
        }
        let html = this.parseHTML(await response.text());
        let content = html.querySelector('#link-report');
        let created = html.querySelector('.annotation-info .pubtime');
        let reads = html.querySelector('.rnote .pl.info span');
        let rating = html.querySelector('.profile [class*="rating"]');
        let ratingMatch = rating ? (rating.getAttribute('class') || '').match(/rating(\d+)-t/) : null;
        let readMatch = reads ? (reads.textContent || reads.text || '').match(/(\d+)/) : null;
        return {
            fulltext: content ? content.innerHTML : fallbackText,
            create_time: created ? (created.textContent || created.text || '').trim() : '',
            read_count: readMatch ? parseInt(readMatch[1]) : 0,
            rating: ratingMatch ? { value: parseInt(ratingMatch[1]) } : null,
        };
    }

    async saveAnnotation(annotation, subject, version) {
        let annotationId = parseInt(annotation.id);
        if (isNaN(annotationId)) return;
        let row = await this.storage.annotation.get(annotationId);
        if (row) {
            let lastVersion = row.version;
            row.version = version;
            if (annotation.fulltext !== row.annotation.fulltext) {
                !row.history && (row.history = {});
                row.history[lastVersion] = row.annotation;
                // The public HTML fallback contains less subject metadata than
                // the mobile API. Preserve richer metadata from older backups.
                annotation.subject = row.annotation.subject || subject;
                row.annotation = annotation;
            }
        } else {
            annotation.subject = subject;
            row = {
                id: annotationId,
                version: version,
                subject: parseInt(subject && subject.id) || 0,
                annotation: annotation,
            };
        }
        await this.storage.annotation.put(row);
        this.step();
    }

    async crawlWebpage(version) {
        let nextURL = URL_ANNOTATIONS_WEB.replace('{uid}', this.targetUser.id);
        let visited = new Set();
        let saved = 0;
        this.total = 0;
        this.completion = 0;

        while (nextURL && !visited.has(nextURL)) {
            visited.add(nextURL);
            let response = await this.fetch(nextURL);
            if (response.status !== 200) {
                throw new TaskError('豆瓣读书笔记公开页面返回错误');
            }
            let html = this.parseHTML(await response.text());
            for (let group of html.querySelectorAll('.annotations-item')) {
                let subjectLink = group.querySelector('.annotations-context>h3>a');
                let subjectHref = subjectLink ? (subjectLink.getAttribute('href') || '') : '';
                let subjectMatch = subjectHref.match(/\/annotation\/(\d+)\/?/);
                let cover = group.querySelector('.book-cover img');
                let subject = {
                    id: subjectMatch ? subjectMatch[1] : '0',
                    title: subjectLink ? (subjectLink.getAttribute('title') || (subjectLink.textContent || subjectLink.text || '').trim()) : '',
                    url: subjectMatch ? `https://book.douban.com/subject/${subjectMatch[1]}/` : subjectHref,
                    card_subtitle: '',
                    pic: { normal: cover ? (cover.getAttribute('src') || '') : '' },
                    null_rating_reason: '公开页面未提供评分',
                };
                for (let item of group.querySelectorAll('.rnotes>li.item')) {
                    let link = item.querySelector('h5>a');
                    let url = link ? (link.getAttribute('href') || '') : '';
                    let idMatch = url.match(/\/annotation\/(\d+)\/?/);
                    if (!idMatch) continue;
                    let abstractNode = item.querySelector('.abstract');
                    let abstract = abstractNode ? (abstractNode.textContent || abstractNode.text || '').trim() : '';
                    let commentsLink = item.querySelector('a[href*="#comments"]');
                    let commentsMatch = commentsLink ? (commentsLink.textContent || commentsLink.text || '').match(/(\d+)/) : null;
                    let detail = await this.fetchWebAnnotation(url, abstract);
                    let title = link ? (link.textContent || link.text || '').trim() : '';
                    let annotation = {
                        id: idMatch[1],
                        url: url,
                        title: title,
                        chapter: title,
                        page: '',
                        abstract: abstract,
                        comments_count: commentsMatch ? parseInt(commentsMatch[1]) : 0,
                        ...detail,
                    };
                    this.total += 1;
                    await this.saveAnnotation(annotation, subject, version);
                    saved += 1;
                }
            }

            let nextLink = html.querySelector('.paginator .next a');
            let href = nextLink ? (nextLink.getAttribute('href') || '') : '';
            nextURL = href ? new URL(href, nextURL).toString() : null;
        }
        await recordDiagnostic(this.diagnosticRunId, 'annotation.fallback', {
            task: 'Annotation', pages: visited.size, count: saved,
        });
        if (saved === 0) {
            this.logger.warning('移动接口和公开页面均未找到读书笔记，请下载诊断日志反馈。');
        }
    }

    async run() {
        let version = this.jobId;
        await this.storage.table('version').put({table: 'annotation', version: version, updated: Date.now()});

        let baseURL = URL_ANNOTATIONS
            .replace('{ck}', this.session?.cookies?.ck || '')
            .replace('{uid}', this.targetUser.id);

        let pageCount = 1;
        let useWebFallback = false;
        let fallbackReason;
        for (let i = 0; i < pageCount; i ++) {
            let fetch = await this.fetch
            let response = await fetch(baseURL.replace('{start}', i * PAGE_SIZE), {headers: {'X-Override-Referer': 'https://m.douban.com/'}});
            if (response.status !== 200) {
                useWebFallback = true;
                fallbackReason = 'http_error';
                await recordDiagnostic(this.diagnosticRunId, 'annotation.api', {
                    task: 'Annotation', status: response.status, reason: fallbackReason,
                    isOther: this.isOtherUser,
                });
                break;
            }
            let json = await response.json();
            this.total = parseInt(json?.total) || 0;
            pageCount = Math.ceil(this.total / PAGE_SIZE);
            const collections = json?.collections;
            if (i === 0) {
                await recordDiagnostic(this.diagnosticRunId, 'annotation.api', {
                    task: 'Annotation', status: response.status, apiTotal: this.total,
                    apiGroups: Array.isArray(collections) ? collections.length : 0,
                    isOther: this.isOtherUser,
                });
            }
            if (!Array.isArray(collections)) {
                useWebFallback = true;
                fallbackReason = 'invalid_response';
                break;
            }
            // The mobile endpoint can return zero for the signed-in account too.
            if (i === 0 && this.total === 0 && collections.length === 0) {
                useWebFallback = true;
                fallbackReason = 'empty_response';
                break;
            }
            if (i === 0 && this.total > 0 && collections.length === 0) {
                useWebFallback = true;
                fallbackReason = 'invalid_response';
                break;
            }
            for (let collection of collections) {
                let subject = collection.subject;
                for (let annotation of collection.annotations || []) {
                    annotation.fulltext = await this.fetchAnnotation(annotation.url);
                    await this.saveAnnotation(annotation, subject, version);
                }
            }
        }
        if (useWebFallback) {
            await recordDiagnostic(this.diagnosticRunId, 'annotation.fallback', {
                task: 'Annotation', reason: fallbackReason,
            });
            this.logger.warning('移动接口未返回公开读书笔记，改用豆瓣读书公开页面备份。');
            await this.crawlWebpage(version);
        }
        this.total = Math.max(this.total, this.completion);
        this.complete();
    }

    get name() {
        return '笔记';
    }
}
