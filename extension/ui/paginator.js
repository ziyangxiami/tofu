export default class Paginator extends EventTarget {
    constructor(currentPage, pageCount, padding = 5) {
        super();
        this.pageCount = Math.max(1, Math.trunc(pageCount) || 1);
        this.currentPage = Math.max(1, Math.min(this.pageCount, Math.trunc(currentPage) || 1));
        this.padding = padding;
        this.load();
    }

    change(page) {
        if (!Number.isInteger(page) || page < 1 || page > this.pageCount || page === this.currentPage) return;
        this.currentPage = page;
        this.dispatchEvent(new Event('change'));
    }

    load() {
        const nav = document.createElement('nav');
        nav.className = 'pagination is-centered'; nav.setAttribute('aria-label', '备份分页');
        const button = (text, className, page, disabled = false) => {
            const node = document.createElement('button');
            node.type = 'button'; node.className = className; node.textContent = text; node.disabled = disabled;
            node.addEventListener('click', () => this.change(page)); return node;
        };
        nav.append(button('上一页', 'pagination-previous', this.currentPage - 1, this.currentPage === 1));
        nav.append(button('下一页', 'pagination-next', this.currentPage + 1, this.currentPage === this.pageCount));
        const list = document.createElement('ul'); list.className = 'pagination-list';
        const pages = new Set([1, this.pageCount]);
        for (let page = this.currentPage - 2; page <= this.currentPage + 2; page++) {
            if (page >= 1 && page <= this.pageCount) pages.add(page);
        }
        let previous = 0;
        for (const page of [...pages].sort((a, b) => a - b)) {
            if (previous && page - previous > 1) {
                const gap = document.createElement('li'); gap.innerHTML = '<span class="pagination-ellipsis">…</span>'; list.append(gap);
            }
            const item = document.createElement('li');
            const link = button(String(page), 'pagination-link', page);
            link.setAttribute('aria-label', `第 ${page} 页`);
            if (page === this.currentPage) { link.classList.add('is-current'); link.setAttribute('aria-current', 'page'); }
            item.append(link); list.append(item); previous = page;
        }
        nav.append(list);
        const form = document.createElement('form'); form.className = 'pagination-jump';
        const input = document.createElement('input'); input.className = 'input pagination-goto';
        input.type = 'number'; input.min = '1'; input.max = String(this.pageCount); input.required = true;
        input.setAttribute('aria-label', `跳转页码，1 至 ${this.pageCount}`);
        input.placeholder = `${this.currentPage} / ${this.pageCount}`;
        const submit = document.createElement('button'); submit.className = 'button'; submit.textContent = '跳转';
        form.append(input, submit); form.addEventListener('submit', event => { event.preventDefault(); this.change(Number(input.value)); });
        nav.append(form); this.element = nav;
    }

    appendTo(node) { (node instanceof Element ? node : node[0]).append(this.element); }
}
