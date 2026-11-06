/**
 * Class Notification
 */
export default class TabPanel extends EventTarget {
    constructor(tabSelector, contentSelector) {
        super();
        let $tabs = this.$tabs = $(tabSelector);
        this.$contents = $(contentSelector);

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
