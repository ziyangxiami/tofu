/**
 * Class Notification
 */
export default class TabPanel extends EventTarget {
    constructor(tabSelector, contentSelector) {
        super();
        let $tabs = this.$tabs = $(tabSelector);
        this.$contents = $(contentSelector);

        this.$tabs.each((index, item) => {
            const link = item.querySelector?.('a');
            if (!link) return;
            link.setAttribute('role', 'tab'); link.id = `tab-${item.dataset.tab}`;
            link.setAttribute('aria-controls', `panel-${item.dataset.tab}`);
            link.closest('ul')?.setAttribute('role', 'tablist');
            link.addEventListener('keydown', event => {
                if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
                event.preventDefault();
                const target = event.key === 'Home' ? 0 : event.key === 'End' ? $tabs.length - 1 :
                    (index + (event.key === 'ArrowRight' ? 1 : -1) + $tabs.length) % $tabs.length;
                const next = $tabs[target]; next.querySelector('a').focus(); location.hash = next.dataset.tab;
            });
        });
        this.$contents.each((_, item) => {
            const name = item.getAttribute('name');
            item.setAttribute?.('role', 'tabpanel'); item.setAttribute?.('id', `panel-${name}`);
            item.setAttribute?.('aria-labelledby', `tab-${name}`);
        });

        window.addEventListener('hashchange', e => {
            if (location.hash) {
                this.toggle(location.hash.substr(1));
            }
        }, false);

        if (!location.hash || !this.toggle(location.hash.substr(1))) {
            for (let i = 0; i < $tabs.length; i ++) {
                let tab = $tabs[i];
                if (tab.classList.contains('is-active')) {
                    this.toggle(tab.dataset.tab, tab);
                    break;
                }
            }
        }
    }

    get activeTab() {
        return this._activeTab;
    }

    toggle(tabName, tab) {
        if (!tab) {
            tab = Array.from(this.$tabs).find(item => item.dataset.tab === tabName);
        }
        if (!tab || !Array.from(this.$contents).some(item => item.getAttribute('name') === tabName)) return false;
        this.$tabs.removeClass('is-active');
        this.$contents.addClass('is-hidden');
        tab.classList.add('is-active');
        this.$tabs.each((_, item) => {
            const link = item.querySelector?.('a');
            link?.setAttribute('aria-selected', String(item === tab));
            link?.setAttribute('tabindex', item === tab ? '0' : '-1');
        });
        this.$contents.each((_, el) => {
            if (el.getAttribute('name') == tabName) {
                this._activeTab = el;
                el.classList.remove('is-hidden');
            }
        });
        this.dispatchEvent(new Event('toggle'));
        return true;
    }

    static render() {
        return new TabPanel('.page-tab-link',
                            '.page-tab-content');
    }
}
