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

export function pageStep(json, requestedStart, requestedCount, total) {
    const pageSize = json?.count === undefined ? requestedCount : Number(json.count);
    if (!Number.isSafeInteger(pageSize) || pageSize < 0 || (pageSize === 0 && total > 0) || pageSize > requestedCount ||
        (json?.start !== undefined && Number(json.start) !== requestedStart)) {
        throw new TaskError('豆瓣接口响应格式错误或分页位置异常');
    }
    return pageSize || requestedCount;
}

export function assertNotChallengePage(html, label = '页面', responseUrl = '') {
    const rateLimitError = () => {
        const error = new TaskError(`${label}触发豆瓣访问限制，需要登录或安全验证（请在浏览器打开豆瓣完成验证或稍后重试），已保留旧备份`);
        error.httpStatus = 429;
        return error;
    };
    const authError = () => {
        const error = new TaskError(`${label}需要登录或安全验证，已保留旧备份`);
        error.httpStatus = 401;
        return error;
    };
    if (responseUrl) {
        try {
            const url = new URL(responseUrl);
            if (!(url.hostname === 'douban.com' || url.hostname.endsWith('.douban.com')) ||
                url.hostname === 'accounts.douban.com' ||
                /\/(?:login|passport)(?:\/|$)/i.test(url.pathname)) {
                throw authError();
            }
            if (url.hostname === 'sec.douban.com' ||
                /\/(?:captcha|challenge)(?:\/|$)/i.test(url.pathname) ||
                /\/misc\/sorry(?:\/|$)/i.test(url.pathname) ||
                (/\/misc\//i.test(url.pathname) && url.searchParams.has('original-url'))) {
                throw rateLimitError();
            }
        } catch (error) {
            if (error instanceof TaskError) throw error;
        }
    }
    if (!html) return;
    if (html.querySelector('form[action*="/misc/sorry"]') || html.querySelector('#captcha_image') ||
        html.querySelector('input[name="captcha-solution"]') || html.querySelector('input[name="captcha-id"]')) {
        throw rateLimitError();
    }
    const title = html.querySelector('title')?.textContent?.trim() || '';
    if (/禁止访问|安全验证|豆瓣验证|人机验证/.test(title)) {
        throw rateLimitError();
    }
    if (html.querySelector('form[name="login"]') || html.querySelector('input[name="form_email"]')) {
        throw authError();
    }
}
