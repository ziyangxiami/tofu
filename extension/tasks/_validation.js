import TaskError from '../services/TaskError.js';

export function numericId(value, label = '数据') {
    const text = String(value ?? '');
    const id = /^\d+$/.test(text) ? Number(text) : NaN;
    if (!Number.isSafeInteger(id) || id <= 0) {
        throw new TaskError(`${label}缺少有效 ID`);
    }
    return id;
}

export function validatePage(json, key, start = 0) {
    const totalText = String(json?.total ?? '');
    const total = /^\d+$/.test(totalText) ? Number(totalText) : NaN;
    if (!json || json.code || !Array.isArray(json[key]) ||
        !Number.isSafeInteger(total) || total < 0 ||
        (start < total && json[key].length === 0) ||
        (total === 0 && json[key].length > 0)) {
        throw new TaskError('豆瓣接口响应格式错误或分页内容缺失');
    }
    return total;
}

export function totalCount(json) {
    const text = String(json?.total ?? '');
    const count = /^\d+$/.test(text) ? Number(text) : NaN;
    if (!json || json.code || !Number.isSafeInteger(count) || count < 0) {
        throw new TaskError('豆瓣接口未返回有效总数');
    }
    return count;
}

export function htmlPageCount(html) {
    const current = html.querySelector('.paginator .thispage');
    if (!current) return 1;
    const raw = String(current.dataset?.totalPage ?? current.getAttribute('data-total-page') ?? '');
    const count = /^\d+$/.test(raw) ? Number(raw) : NaN;
    if (!Number.isSafeInteger(count) || count <= 0) {
        throw new TaskError('豆瓣分页信息无效，已保存此前内容');
    }
    return count;
}
