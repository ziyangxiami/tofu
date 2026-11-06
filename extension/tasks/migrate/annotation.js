import MigrationTask, {validId, responseJSON, hasFailure, acknowledged} from './MigrationTask.js';
import TaskError from '../../services/TaskError.js';
import Draft from '../../vendor/draft.js';

export default class MigrateAnnotation extends MigrationTask {
    static sourceTable = 'annotation';
    async getInitialData(createURL) {
        const response = await this.fetch(createURL, {}, false, 0);
        if (response.status !== 200) throw new TaskError('无法打开读书笔记编辑页。');
        const html = this.parseHTML(await response.text());
        const nid = validId(html.querySelector('#review-editor-form>input[name="nid"]')?.getAttribute('value'));
        let token = '';
        for (const script of html.querySelectorAll('script')) {
            const text = script.text || script.textContent || '';
            const match = text.match(/name:\s*'upload_auth_token',\s*value:\s*'([^']*)'/m) ||
                text.match(/upload_auth_token['"]?\s*:\s*['"]([^'"]+)['"]/);
            if (match) { token = match[1]; break; }
        }
        return {nid, token};
    }
    async uploadImages(draft, nid, token) {
        for (const entity of Object.values(draft.entities)) {
            if (entity.type !== 'IMAGE') continue;
            if (!token) throw new TaskError('缺少笔记图片上传凭证。');
            const url = new URL(entity.data.src);
            if (url.protocol !== 'https:' || !/(^|\.)doubanio\.com$/.test(url.hostname)) {
                throw new TaskError('笔记图片地址不受支持，请在目标账号手动处理。');
            }
            const image = await this.fetch(url.href);
            if (image.status !== 200) throw new TaskError('笔记图片下载失败。');
            const form = new FormData();
            form.set('ck', this.session.cookies.ck);
            form.set('upload_auth_token', token);
            form.set('image', await image.blob(), url.pathname.split('/').pop());
            const result = await responseJSON(await this.fetch(`https://book.douban.com/j/annotation/${nid}/upload`,
                {method: 'POST', body: form}, false, 0));
            if (hasFailure(result) || !result?.photo?.url) throw new TaskError('笔记图片上传结果未确认。');
            entity.data = {...result.photo, src: result.photo.url};
        }
    }
    async run() {
        for await (const row of this.rows()) {
            const id = validId(row.id);
            const subject = validId(row.subject);
            if (typeof row.annotation?.fulltext !== 'string') throw new TaskError('读书笔记缺少正文。');
            const html = this.parseHTML(row.annotation.fulltext);
            const draft = new Draft().feed(html.querySelector('body') || html);
            if (draft.count() < 10) throw new TaskError('读书笔记正文不足 10 字，请在目标账号手动处理。');
            const createURL = `https://book.douban.com/annotation/write?sid=${subject}`;
            // The editor GET can allocate a draft. Persist pending before that
            // request as well as uploads/publish, so interruption cannot replay it.
            await this.writeOnce(id, async () => {
                const {nid, token} = await this.getInitialData(createURL);
                await this.uploadImages(draft, nid, token);
                return this.post(`https://book.douban.com/j/annotation/${nid}/publish`, this.form({
                    is_rich: '1', chapter: row.annotation.chapter || '', page: row.annotation.page || 1,
                    content: JSON.stringify(draft.toArray()),
                }), createURL);
            }, result => result?.r === 0 && acknowledged(result));
        }
    }
    get name() { return '发布笔记'; }
}
