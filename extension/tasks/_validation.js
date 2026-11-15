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

export function htmlPageCount(html, expectedPage) {
    const current = html.querySelector('.paginator .thispage');
    const paginator = html.querySelector('.paginator');
    if (!current && !paginator) return 1;
    const positive = value => {
        const text = String(value ?? '').trim();
        const number = /^\d+$/.test(text) ? Number(text) : NaN;
        return Number.isSafeInteger(number) && number > 0 ? number : null;
    };
    const currentPage = positive(current?.textContent);
    if (expectedPage !== undefined && currentPage !== null && currentPage !== expectedPage) {
        throw new TaskError('豆瓣返回的页码与请求不一致，已保留旧备份');
    }
    const count = positive(current?.getAttribute('data-total-page') ?? current?.dataset?.totalPage);
    if (count !== null && (currentPage === null || count >= currentPage)) return count;

    // A paginator can render numbered links and a next link without a total
    // attribute. Use that evidence instead of assuming one page.
    if (currentPage !== null && paginator) {
        const pages = [currentPage];
        for (const link of paginator.querySelectorAll('a')) {
            const page = positive(link.textContent);
            if (page !== null) pages.push(page);
        }
        const next = paginator.querySelector('.next a');
        if (next?.getAttribute('href')) pages.push(currentPage + 1);
        const last = Math.max(...pages);
        if (Number.isSafeInteger(last)) return last;
    }
    throw new TaskError('豆瓣分页信息无效，已保留旧备份');
}
