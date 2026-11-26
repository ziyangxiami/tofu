'use strict';
import Task from '../services/Task.js';
import TaskError from '../services/TaskError.js';
import {numericId, validatePage, htmlPageCount, pageStep, assertNotChallengePage} from './_validation.js';
import {recordDiagnostic} from '../services/diagnostics.js';


const PAGE_SIZE = 50;
const URL_PHOTOS = 'https://m.douban.com/rexxar/api/v2/user/{uid}/photo_albums?start={start}&count=50&ck={ck}&for_mobile=1';


export default class Photo extends Task {
    resolveAlbumId(album) {
        try {
            return {id: numericId(album?.id, '相册'), source: 'id'};
        } catch (error) {
            // A canonical album URL is another explicit ID source. Never use
            // parseInt on arbitrary text or invent an ID for a special album.
            let url;
            try { url = new URL(album?.url); } catch (error) { /* invalid URL */ }
            if (url && ['https:', 'http:'].includes(url.protocol) &&
                ['www.douban.com', 'douban.com'].includes(url.hostname)) {
                const match = url.pathname.match(/^\/photos\/album\/(\d+)\/?$/);
                if (match) return {id: numericId(match[1], '相册'), source: 'url'};
            }
            throw new TaskError('相册缺少有效 ID，且无法从相册网址恢复，已保留旧备份');
        }
    }

    compareAlbum(l, r) {
        if (l.description != r.description) return false;
        return true;
    }

    async fetchPhotoDetail(url) {
        let fetch = await this.fetch
        let response = await fetch(url);
        if (response.status != 200) {
            if (response.status < 500) {
                return false;
            }
            throw new TaskError('豆瓣服务器返回错误');
        }
        let html = this.parseHTML(await response.text());
        let photo = html.querySelector('.mainphoto>img');
        return photo ? (photo.getAttribute('src') || false) : false;
    }

    async run() {
        let version = this.jobId;
        this.total = (this.targetUser && this.targetUser.photo_albums_count) || 0;

        let baseURL = URL_PHOTOS
            .replace('{uid}', this.targetUser.id)
            .replace('{ck}', this.session?.cookies?.ck || '');

        let total = null;
        const albumIds = new Set();
        for (let start = 0, page = 1; total === null || start < total; page++) {
            let fetch = await this.fetch
            let response = await fetch(baseURL.replace('{start}', start), {headers: {'X-Override-Referer': 'https://m.douban.com/mine/photos'}});
            if (response.status != 200) {
                throw new TaskError('豆瓣服务器返回错误');
            }
            let json = await response.json();
            total = this.total = validatePage(json, 'photo_albums', start);
            const step = pageStep(json, start, PAGE_SIZE, total);
            for (let album of json.photo_albums) {
                let resolved;
                try {
                    resolved = this.resolveAlbumId(album);
                } catch (error) {
                    await recordDiagnostic(this.diagnosticRunId, 'photo.invalid_id', {
                        task: 'Photo', pages: page, count: this.completion,
                        idType: album?.id == null ? 'missing' : typeof album.id,
                    });
                    throw error;
                }
                const albumId = resolved.id;
                if (albumIds.has(albumId)) throw new TaskError('相册分页返回重复 ID，已保留旧备份');
                albumIds.add(albumId);
                if (resolved.source === 'url') {
                    await recordDiagnostic(this.diagnosticRunId, 'photo.id_recovered', {
                        task: 'Photo', pages: page, count: 1,
                    });
                }
                let albumPrivacy = album.privacy;
                let albumRow = await this.storage.album.get(albumId);
                if (albumRow) {
                    let lastVersion = albumRow.version;
                    albumRow.version = version;
                    if (!this.compareAlbum(album, albumRow.album)) {
                        !albumRow.history && (albumRow.history = {});
                        albumRow.history[lastVersion] = albumRow.album;
                        albumRow.album = album;
                    }
                } else {
                    albumRow = {
                        id: albumId,
                        version: version,
                        album: album,
                    };
                }
                const ALBUM_PAGE_SIZE = 18;
                let albumTotalPage = 1;
                for (let i = 0; i < albumTotalPage; i ++) {
                    let fetch = await this.fetch
                    let pageURL = new URL(album.url);
                    pageURL.searchParams.set('m_start', i * ALBUM_PAGE_SIZE);
                    let response = await fetch(pageURL.toString());
                    if (response.status != 200) {
                        throw new TaskError('豆瓣服务器返回错误');
                    }
                    let html = this.parseHTML(await response.text());
                    assertNotChallengePage(html, '相册页面', response.url);
                    albumTotalPage = htmlPageCount(html, i + 1);
                    const photos = html.querySelectorAll('.photolst_photo');
                    if (photos.length === 0 && (i > 0 || albumTotalPage > 1 || (album.photos_count || 0) > 0)) {
                        throw new TaskError('相册分页未返回照片，已保留旧备份');
                    }
                    for (let photoAnchor of photos) {
                        let photoHref = photoAnchor.getAttribute('href') || '';
                        let match = photoHref.match(/https:\/\/www\.douban\.com\/photos\/photo\/(\d+)\//);
                        if (!match) continue;
                        let photoId = parseInt(match[1]);
                        let photoImg = photoAnchor.querySelector('img');
                        let photoSrc = photoImg ? (photoImg.getAttribute('src') || '') : '';
                        let photoDescription = photoAnchor.getAttribute('title') || '';
                        let photoRow = await this.storage.photo.get(photoId);
                        if (photoRow) {
                            let lastVersion = photoRow.version;
                            photoRow.version = version;
                            if (photoRow.photo.description != photoDescription ||
                                photoRow.photo.cover != photoSrc) {
                                !photoRow.history && (photoRow.history = {});
                                photoRow.history[lastVersion] = JSON.parse(JSON.stringify(photoRow.photo));
                                photoRow.photo.description = photoDescription;
                                if (photoRow.photo.cover != photoSrc) {
                                    if (albumPrivacy != 'public') {
                                        let rawUrl = await this.fetchPhotoDetail(photoHref);
                                        photoRow.photo.raw = rawUrl || photoSrc;
                                    } else {
                                        photoRow.photo.raw = photoSrc.replace('/m/', '/l/');
                                    }
                                    photoRow.photo.cover = photoSrc;
                                }
                            }
                        } else {
                            let rawUrl = photoSrc;
                            if (albumPrivacy != 'public') {
                                let fetchedRaw = await this.fetchPhotoDetail(photoHref);
                                rawUrl = fetchedRaw || photoSrc;
                            } else {
                                rawUrl = photoSrc.replace('/m/', '/l/');
                            }
                            photoRow = {
                                id: photoId,
                                album: albumId,
                                version: version,
                                photo: {
                                    url: photoHref,
                                    cover: photoSrc,
                                    description: photoDescription,
                                    raw: rawUrl,
                                }
                            };
                        }
                        await this.storage.photo.put(photoRow);
                    }
                }
                await this.storage.album.put(albumRow);
                this.step();
            }
            start += step;
        }
        await this.storage.table('version').put({table: 'photo', version: version, updated: Date.now()});
        this.total = this.completion;
    }

    get name() {
        return '相册';
    }
}
