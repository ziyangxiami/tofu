import MigrationTask, {validId, acknowledged} from './MigrationTask.js';
import TaskError from '../../services/TaskError.js';

const URLS = {
    movie: 'https://movie.douban.com/j/subject/{id}/interest',
    music: 'https://music.douban.com/j/subject/{id}/interest',
    book: 'https://book.douban.com/j/subject/{id}/interest',
    game: 'https://www.douban.com/j/ilmen/thing/{id}/interest',
    drama: 'https://www.douban.com/j/location/drama/{id}/interest',
};
const MARKS = {mark: 'wish', doing: 'do', done: 'collect'};

export default class MigrateInterest extends MigrationTask {
    static sourceTable = 'interest';
    async run() {
        for await (const row of this.rows()) {
            const subject = validId(row.subject);
            const interest = row.interest;
            if (!interest || !URLS[row.type] || !MARKS[row.status]) throw new TaskError('标记类型或状态无效，迁移已停止。');
            const data = this.form({foldcollect: 'F', rating: interest.rating?.value ?? '',
                interest: MARKS[row.status], tags: Array.isArray(interest.tags) ? interest.tags.join(' ') : '',
                comment: interest.comment || ''});
            await this.writeOnce(`${row.type}:${subject}`, () => this.post(URLS[row.type].replace('{id}', subject), data), acknowledged);
        }
    }
    get name() { return '标记影音书游剧'; }
}
