'use strict';
import Task from '../services/Task.js';
import TaskError from '../services/TaskError.js';


const PAGE_SIZE = 50;
const URL_PHOTOS = 'https://m.douban.com/rexxar/api/v2/user/{uid}/photo_albums?start={start}&count=50&ck={ck}&for_mobile=1';


export default class Photo extends Task {
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
        if (this.total == 0) {
            return;
        }
        await this.storage.table('version').put({table: 'photo', version: version, updated: Date.now()});

        let baseURL = URL_PHOTOS
            .replace('{uid}', this.targetUser.id)
            .replace('{ck}', this.session?.cookies?.ck || '');

        let pageCount = 1;
        for (let i = 0; i < pageCount; i ++) {
            let fetch = await this.fetch
            let response = await fetch(baseURL.replace('{start}', i * PAGE_SIZE), {headers: {'X-Override-Referer': 'https://m.douban.com/mine/photos'}});
            if (response.status != 200) {
                throw new TaskError('豆瓣服务器返回错误');
            }
            let json = await response.json();
            pageCount = Math.ceil(json.total / PAGE_SIZE);
            for (let album of json.photo_albums) {
                let albumId = parseInt(album.id);
                let albumPrivacy = album.privacy;
                if (isNaN(albumId)) continue;
                let row = await this.storage.album.get(albumId);
                if (row) {
                    let lastVersion = row.version;
                    row.version = version;
                    if (!this.compareAlbum(album, row.album)) {
                        !row.history && (row.history = {});
                        row.history[lastVersion] = row.album;
                        row.album = album;
                    }
                } else {
                    row = {
                        id: albumId,
                        version: version,
                        album: album,
                    };
                }
                const ALBUM_PAGE_SIZE = 18;
                let albumTotalPage = 1;
                for (let i = 0; i < albumTotalPage; i ++) {
                    let fetch = await this.fetch
                    let response = await fetch(album.url + '?m_start=' + i * ALBUM_PAGE_SIZE);
                    if (response.status != 200) {
                        if (response.status < 500) continue;
                        throw new TaskError('豆瓣服务器返回错误');
                    }
                    let html = this.parseHTML(await response.text());
                    try {
                        albumTotalPage = parseInt(html.querySelector('.paginator .thispage').dataset.totalPage);
                    } catch (e) {}
                    for (let photoAnchor of html.querySelectorAll('.photolst_photo')) {
                        let photoHref = photoAnchor.getAttribute('href') || '';
                        let match = photoHref.match(/https:\/\/www\.douban\.com\/photos\/photo\/(\d+)\//);
                        if (!match) continue;
                        let photoId = parseInt(match[1]);
                        let photoImg = photoAnchor.querySelector('img');
                        let photoSrc = photoImg ? (photoImg.getAttribute('src') || '') : '';
                        let photoDescription = photoAnchor.getAttribute('title') || '';
                        let row = await this.storage.photo.get(photoId);
                        if (row) {
                            let lastVersion = row.version;
                            row.version = version;
                            if (row.photo.description != photoDescription ||
                                row.photo.cover != photoSrc) {
                                !row.history && (row.history = {});
                                row.history[lastVersion] = row.photo;
                                row.photo.description = photoDescription;
                                if (row.photo.cover != photoSrc) {
                                    if (albumPrivacy != 'public') {
                                        let rawUrl = await this.fetchPhotoDetail(photoHref);
                                        row.photo.raw = rawUrl || photoSrc;
                                    } else {
                                        row.photo.raw = photoSrc.replace('/m/', '/l/');
                                    }
                                    row.photo.cover = photoSrc;
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
                            row = {
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
                        await this.storage.photo.put(row);
                    }
                }
                await this.storage.album.put(row);
                this.step();
            }
        }
        this.complete();
    }

    get name() {
        return '相册';
    }
}
