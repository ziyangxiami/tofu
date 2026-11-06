import MigrationTask, {validId, acknowledged, published} from './MigrationTask.js';
import TaskError from '../../services/TaskError.js';
import Draft from '../../vendor/draft.js';

export default class MigrateReview extends MigrationTask {
    static sourceTable = 'review';
    async run() {
        for await (const row of this.rows()) {
            const id = validId(row.id);
            const subject = validId(row.subject || row.review?.subject?.id);
            if (typeof row.review?.fulltext !== 'string' || !row.review.title) throw new TaskError('评论缺少标题或正文，迁移已停止。');
            const html = this.parseHTML(row.review.fulltext);
            const draft = new Draft().feed(html.querySelector('body') || html);
            if (draft.count() < 140) throw new TaskError('评论正文不足 140 字，迁移已停止，请在目标账号手动处理。');
            const data = this.form({is_rich: '1', topic_id: '', 'review[rating]': row.review.rating?.value ?? '',
                'review[spoiler]': '', 'review[donate]': '', 'review[original]': '', 'review[introduction]': '',
                'review[subject_id]': subject, 'review[title]': row.review.title, 'review[text]': JSON.stringify(draft.toArray())});
            await this.writeOnce(id, () => this.post('https://www.douban.com/j/review/create', data,
                `https://www.douban.com/subject/${subject}/new_review`), result => acknowledged(result) || published(result, 'review'));
        }
    }
    get name() { return '发布评论'; }
}
