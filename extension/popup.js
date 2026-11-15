import ServiceProxy from './services/ServiceProxy.js';

const URL_OPTIONS = chrome.runtime.getURL('options.html');
const URL_ABOUT = URL_OPTIONS + '#about';
const URL_HELP = URL_OPTIONS + '#help';
const URL_BACKUP = chrome.runtime.getURL('backup.html');

class PopupMenu {
    constructor(selector, service) {
        this.element = document.querySelector(selector);
        this.service = service;
    }

    clickNew(event) {
        window.open(URL_BACKUP + '#new-task');
    }

    clickBackup(event) {
        window.open(URL_BACKUP);
    }

    async clickStart(event) {
        await this.service.start();
    }

    async clickStop(event) {
        await this.service.stop();
    }

    clickTasks() { window.open(URL_OPTIONS + '#service'); }

    clickSettings(event) {
        window.open(URL_OPTIONS);
    }

    clickHelp(event) {
        window.open(URL_HELP);
    }

    clickAbout(event) {
        window.open(URL_ABOUT);
    }

    getItem(name) {
        return this.element.querySelector(`[name="${name}"]`);
    }

    disable(name) {
        let item = this.getItem(name);
        if (item) item.setAttribute('disabled', true);
    }

    enable(name) {
        let item = this.getItem(name);
        if (item) item.removeAttribute('disabled');
    }

    static async render() {
        let service = ServiceProxy.getProxy();
        let menu = new PopupMenu('.menu', service);

        menu.refresh = async () => {
            let status;
            try { status = await service.getProperty('status'); } catch (_) {}
            menu.disable('Start'); menu.disable('Stop');
            if (status === 1) menu.enable('Start');
            else if ([2, 4].includes(status)) menu.enable('Stop');
            const label = document.querySelector('#popup-state');
            if (label) label.textContent = ({1: '服务已停止', 2: '等待新任务', 3: '正在停止', 4: '正在备份'})[status] || '后台暂时无法连接';
        };
        await menu.refresh();
        service.addEventListener?.('statechange', () => menu.refresh());
        service.addEventListener?.('disconnect', () => {
            menu.disable('Start'); menu.disable('Stop');
            const label = document.querySelector('#popup-state');
            if (label) label.textContent = '后台连接已断开';
        });

        // 绑定点击事件
        Zepto('.menu').on('click', '.menu-item', async event => {
            if (menu.busy || event.currentTarget.hasAttribute('disabled')) return false;
            let handle = menu['click' + event.currentTarget.getAttribute('name')];
            if (!handle) return false;
            menu.busy = true;
            try {
                await handle.apply(menu, [event]);
            } catch (e) {
                const error = document.querySelector('#popup-error');
                if (error) { error.hidden = false; error.textContent = e.message || String(e); }
                return;
            } finally { menu.busy = false; }
            if (['Start', 'Stop'].includes(event.currentTarget.getAttribute('name'))) { await menu.refresh(); return; }
            setTimeout(() => {
                window.close();
            }, 100);
        });
    }
}

document.addEventListener('DOMContentLoaded', () => {
    PopupMenu.render();
});
