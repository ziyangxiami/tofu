import MigrationTask, {validId, acknowledged} from './MigrationTask.js';

export default class MigrateBlacklist extends MigrationTask {
    static sourceTable = 'blacklist';
    async run() {
        for await (const row of this.rows()) {
            const uid = validId(row.user?.id);
            await this.writeOnce(uid, () => this.post(
                'https://www.douban.com/j/contact/addtoblacklist', this.form({people: uid})
            ), acknowledged);
        }
    }
    get name() { return '加黑名单'; }
}
