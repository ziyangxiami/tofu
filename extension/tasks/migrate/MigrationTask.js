import Task from '../../services/Task.js';
import TaskError from '../../services/TaskError.js';

export function validId(value) {
    const text = String(value ?? '');
    if (!/^[1-9]\d*$/.test(text) || !Number.isSafeInteger(Number(text))) {
        throw new TaskError('迁移数据缺少有效 ID');
    }
    return Number(text);
}

export function hasFailure(result) {
    return !result || typeof result !== 'object' || !!result.error || !!result.err ||
        result.result === false || (result.r !== undefined && result.r !== 0) ||
        (result.code !== undefined && result.code !== 0 && result.code !== '0');
}

export function acknowledged(result) {
    return !hasFailure(result) && (result.r === 0 || result.result === true || result.result === 1);
}

export function published(result, kind) {
    if (hasFailure(result)) return false;
    const id = result[`${kind}_id`] ?? result.id;
    if (/^[1-9]\d*$/.test(String(id ?? ''))) return true;
    try {
        const url = new URL(result.url || result[`${kind}_url`]);
        return url.protocol === 'https:' && (url.hostname === 'douban.com' || url.hostname.endsWith('.douban.com')) &&
            new RegExp(`^/${kind}/[1-9]\\d*(?:/|$)`).test(url.pathname);
    } catch (_) { return false; }
}

export async function responseJSON(response) {
    if (response.status < 200 || response.status >= 300) {
        throw new TaskError(`迁移请求失败（HTTP ${response.status}），请检查目标账号后人工核对结果。`);
    }
    try { return await response.json(); }
    catch (_) { throw new TaskError('迁移接口返回无法识别的结果，请人工核对后再处理。'); }
}

export default class MigrationTask extends Task {
    get isMigration() { return true; }

    async assertSource() {
        const source = this.storage.name?.match(/^tofu\[([1-9]\d*)\]$/)?.[1];
        const state = this.checkpoint;
        if (!state || state.kind !== 'migration-v1' || !state.receipts || validId(source) !== state.sourceUserId ||
            validId(this.session?.userId) !== state.destinationUserId || !this.session?.cookies?.ck) {
            throw new TaskError('迁移来源或当前登录账号与确认时不一致，请重新确认迁移。');
        }
        const current = await this.storage.table('version').get(this.constructor.sourceTable);
        if (!current || current.version !== state.sourceVersion) {
            throw new TaskError('来源备份版本已改变，请重新预览后创建迁移任务。');
        }
        if (typeof this.saveCheckpoint !== 'function') throw new TaskError('无法保存迁移进度，已停止。');
    }

    async *rows() {
        await this.assertSource();
        const state = this.checkpoint;
        const journalPrefix = `migrationReceipts:${state.sourceUserId}:${state.destinationUserId}:${this.constructor.sourceTable}:`;
        this._journalKey = `${journalPrefix}${state.sourceVersion}`;
        const journals = await chrome.storage.local.get(null);
        // A newer backup does not establish whether an older migration reached
        // the server. Pending writes block this source/destination/type across
        // all versions; confirmed receipts remain scoped to their own version.
        for (const [key, receipts] of Object.entries(journals)) {
            if (!key.startsWith(journalPrefix)) continue;
            if (!receipts || typeof receipts !== 'object' || Array.isArray(receipts) ||
                Object.values(receipts).some(value => !['pending', 'confirmed'].includes(value))) {
                throw new TaskError('迁移回执损坏，已停止自动执行。');
            }
            if (Object.values(receipts).includes('pending')) {
                throw new TaskError('该来源与目标账号有迁移结果尚未确认，新备份版本也不能自动重发；请人工核对。');
            }
        }
        const stored = journals[this._journalKey];
        if (stored) {
            if (typeof stored !== 'object' || Array.isArray(stored) ||
                Object.values(stored).some(value => !['pending', 'confirmed'].includes(value))) {
                throw new TaskError('迁移回执损坏，已停止自动执行。');
            }
            this.checkpoint.receipts = {...this.checkpoint.receipts, ...stored};
        }
        const pending = Object.values(this.checkpoint.receipts).some(value => value === 'pending');
        if (pending) throw new TaskError('上次迁移结果尚未确认，已停止自动重发；请在目标账号人工核对。');
        const table = this.storage.table(this.constructor.sourceTable);
        const query = () => table.filter(row => row.version === this.checkpoint.sourceVersion);
        this.total = await query().count();
        this.completion = 0;
        for (let offset = 0; offset < this.total; offset += 100) {
            await this.assertSource();
            const rows = await query().offset(offset).limit(100).toArray();
            if (!rows.length) throw new TaskError('来源备份内容发生变化，迁移已停止。');
            for (const row of rows) yield row;
        }
    }

    async writeOnce(key, operation, isSuccess) {
        await this.assertSource();
        key = String(key);
        const receipts = this.checkpoint.receipts;
        if (receipts[key] === 'confirmed') { this.step(); return; }
        if (receipts[key]) throw new TaskError('此条迁移结果尚未确认，已停止自动重发，请人工核对。');
        receipts[key] = 'pending';
        // This must finish before any request capable of writing remotely.
        // Local storage survives the worker clearing its finished/failed Job.
        await chrome.storage.local.set({[this._journalKey]: {...receipts}});
        await this.saveCheckpoint();
        const result = await operation();
        if (!isSuccess(result)) {
            throw new TaskError('迁移接口未确认成功，已停止；请在目标账号核对该条结果。');
        }
        receipts[key] = 'confirmed';
        try {
            await chrome.storage.local.set({[this._journalKey]: {...receipts}});
            await this.saveCheckpoint();
        }
        catch (error) { receipts[key] = 'pending'; throw error; }
        this.step();
    }

    async post(url, data, referer = 'https://www.douban.com/') {
        return responseJSON(await this.fetch(url, {
            headers: {'X-Override-Referer': referer, 'X-Requested-With': 'XMLHttpRequest'},
            method: 'POST', body: data,
        }, false, 0));
    }

    form(values = {}) {
        return new URLSearchParams({ck: this.session.cookies.ck, ...values});
    }
}
