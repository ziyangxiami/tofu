import MigrationTask, {validId, acknowledged} from './MigrationTask.js';

export default class MigrateFollow extends MigrationTask {
    static sourceTable = 'following';
    async run() {
        for await (const row of this.rows()) {
            const uid = validId(row.user?.id);
            await this.writeOnce(uid, () => this.post(
                'https://www.douban.com/j/contact/addcontact', this.form({people: uid})
            ), acknowledged);
        }
    }
    get name() { return '加关注'; }
}
