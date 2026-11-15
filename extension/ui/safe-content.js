const allowedTags = new Set('A P BR DIV SPAN STRONG B EM I U S DEL BLOCKQUOTE PRE CODE UL OL LI H1 H2 H3 H4 H5 H6 IMG FIGURE FIGCAPTION HR TABLE THEAD TBODY TR TH TD SUP SUB'.split(' '));
const forbiddenTags = new Set('SCRIPT STYLE IFRAME OBJECT EMBED FORM INPUT BUTTON TEXTAREA SELECT LINK META BASE SVG MATH TEMPLATE'.split(' '));

export default class Content {
    static url(value) {
        if (!value) return '';
        try {
            const url = new URL(String(value), 'https://www.douban.com/');
            return ['http:', 'https:'].includes(url.protocol) ? url.href : '';
        } catch (_) { return ''; }
    }

    static html(value) {
        // Parse in an inert document, never in Zepto.html (which evaluates scripts).
        const parsed = new DOMParser().parseFromString(String(value || ''), 'text/html');
        const result = document.createDocumentFragment();
        const copy = (node, parent) => {
            if (node.nodeType === 3) { parent.append(document.createTextNode(node.textContent)); return; }
            if (node.nodeType !== 1 || forbiddenTags.has(node.tagName)) return;
            const target = allowedTags.has(node.tagName) ? document.createElement(node.tagName) : parent;
            if (target !== parent) {
                for (const name of ['title', 'alt', 'colspan', 'rowspan']) {
                    if (node.hasAttribute(name)) target.setAttribute(name, node.getAttribute(name));
                }
                const attr = node.tagName === 'A' ? 'href' : node.tagName === 'IMG' ? 'src' : null;
                if (attr && Content.url(node.getAttribute(attr))) target.setAttribute(attr, Content.url(node.getAttribute(attr)));
                if (node.tagName === 'A') { target.target = '_blank'; target.rel = 'noopener noreferrer'; }
                if (node.tagName === 'IMG') { target.loading = 'lazy'; target.referrerPolicy = 'no-referrer'; }
                parent.append(target);
            }
            for (const child of node.childNodes) copy(child, target);
        };
        for (const child of parsed.body.childNodes) copy(child, result);
        return result;
    }

    static links(root) {
        root.querySelectorAll('a, img').forEach(node => {
            const attribute = node.tagName === 'A' ? 'href' : 'src';
            const value = node.getAttribute(attribute);
            if (value) {
                const url = Content.url(value);
                if (url) node.setAttribute(attribute, url); else node.removeAttribute(attribute);
            }
            if (node.tagName === 'A') {
                node.rel = 'noopener noreferrer';
                if (!node.hasAttribute('href')) {
                    node.tabIndex = 0; node.setAttribute('role', 'button');
                    node.addEventListener('keydown', event => {
                        if (['Enter', ' '].includes(event.key)) { event.preventDefault(); node.click(); }
                    });
                }
            } else {
                node.loading = 'lazy'; node.alt ||= '备份图片';
                const fallback = new URL('../images/icon-48x48.png', import.meta.url).href;
                node.addEventListener('error', () => { if (node.src !== fallback) node.src = fallback; }, {once: true});
                if (!node.getAttribute('src')) node.src = fallback;
            }
        });
    }

    static image(normal, large = normal) {
        const column = document.createElement('div'); column.className = 'column is-one-third';
        const figure = document.createElement('figure'); figure.className = 'image preview is-128x128';
        const img = document.createElement('img');
        const src = Content.url(normal); if (src) img.src = src;
        img.dataset.src = Content.url(large); img.alt = '备份图片'; img.loading = 'lazy';
        figure.append(img); column.append(figure); return column;
    }
}
