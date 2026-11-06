import MigrationTask, {validId, published} from './MigrationTask.js';
import TaskError from '../../services/TaskError.js';
import Draft from '../../vendor/draft.js';

export default class MigrateNote extends MigrationTask {
    static sourceTable = 'note';
    async run() {
        for await (const row of this.rows()) {
            const id = validId(row.id);
            if (typeof row.note?.fulltext !== 'string' || !row.note.title) throw new TaskError('日记缺少标题或正文，迁移已停止。');
            const html = this.parseHTML(row.note.fulltext);
            const draft = new Draft().feed(html.querySelector('body') || html);
            if (!draft.count()) throw new TaskError('无法转换日记正文，迁移已停止。');
            const data = this.form({is_rich: '1', note_id: '', note_privacy: 'X', action: 'new',
                introduction: '', note_title: row.note.title, note_text: JSON.stringify(draft.toArray())});
            await this.writeOnce(id, () => this.post('https://www.douban.com/j/note/publish', data,
                'https://www.douban.com/note/create'), result => published(result, 'note'));
        }
    }
    get name() { return '发布日记'; }
}
