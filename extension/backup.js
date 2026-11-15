'use strict';
import Storage from './storage.js';
import FileSaver from './vendor/FileSaver.js';
import ServiceProxy from './services/ServiceProxy.js';
import UI from './ui/interactions.js';
import Content from './ui/safe-content.js';
import Notification from './ui/notification.js';

const ACCOUNT_TEMPLATE = `\
<article class="media box account">
  <figure class="media-left">
    <p class="image is-64x64 avatar">
      <img src="">
    </p>
  </figure>
  <div class="media-content">
    <div class="content">
      <p>
        <strong class="username"></strong>
        <small class="user-symbol"></small><br>
        <small><span class="reg-time"></span> 加入</small><br>
        <small>备份数据更新于 <span class="backup-time"></span></small>
        <br>
      </p>
    </div>
    <a class="button is-light account-open">翻阅档案 →</a>
  </div>
  <div class="media-right">
    <button class="delete" title="删除备份数据" aria-label="删除此账号的本地备份"></button>
  </div>
</article>`;


class AccountList {
    constructor(selector) {
        this.element = document.querySelector(selector);
    }

    async load() {
        const storage = new Storage();
        let accounts;
        try {
            await storage.global.open();
            accounts = await storage.global.account.toArray();
        } finally { storage.global.close(); }
        this.element.replaceChildren();
        accounts.sort((a, b) => (b.updated || 0) - (a.updated || 0));
        document.querySelector('#account-count').textContent = accounts.length;
        const updated = accounts.find(account => account.updated > 0)?.updated;
        document.querySelector('#latest-backup').textContent = updated ? new Date(updated).toLocaleDateString('zh-CN') : '尚无更新';
        if (!accounts.length) {
            this.element.innerHTML = '<div class="empty-state"><div class="empty-icon">▤</div><h2>第一份档案，从这里开始</h2><p>登录豆瓣后，新建一次备份。已导出的数据库也可以通过右上角恢复。</p><button class="button is-link empty-create">＋ 创建第一份备份</button></div>';
            this.element.querySelector('button').onclick = () => TaskModal.instance.open();
        }
        for (const account of accounts) {
            const $account = $(ACCOUNT_TEMPLATE);
            $account.find('.image.avatar>img').attr('src', Content.url(account.userInfo?.avatar) || 'images/icon-48x48.png');
            $account.find('.username').text(account.username || account.userInfo?.name || '未命名账号');
            $account.find('.user-symbol').text('@' + (account.userSymbol || account.userId));
            $account.find('.reg-time').text(account.userInfo?.reg_time || '未知时间');
            $account.find('.backup-time').text(account.updated ?
                new Date(account.updated).toLocaleString() : '尚未完成备份');
            $account.data('user-id', account.userId);
            $account.find('.account-open').attr('href', 'explorer.html?' + account.userId);
            $account.appendTo(this.element);
        }
        this.filter();
    }

    filter() {
        const query = document.querySelector('#account-search').value.trim().toLocaleLowerCase();
        let visible = 0;
        this.element.querySelectorAll('.account').forEach(account => {
            account.hidden = !account.textContent.toLocaleLowerCase().includes(query);
            if (!account.hidden) visible++;
        });
        this.element.querySelector('.search-empty')?.remove();
        if (query && !visible) {
            const empty = document.createElement('p'); empty.className = 'state-message search-empty';
            empty.textContent = '没有找到匹配的账号，试试昵称或豆瓣 ID。'; this.element.append(empty);
        }
    }

    async remove(userId) {
        let storage = new Storage();
        try {
            return await withDatabaseMaintenance(() => storage.drop(userId));
        } finally { storage.global.close(); }
    }

    static async render() {
        const list = new AccountList('#accounts');
        AccountList.instance = list;
        document.querySelector('#account-search').addEventListener('input', () => list.filter());
        list.element.addEventListener('click', event => {
            const button = event.target.closest('.delete');
            if (!button) return;
            const account = button.closest('.account');
            const userId = $(account).data('user-id');
            const username = account.querySelector('.username').textContent;
            if (!confirm(`删除“${username}”的本地备份？此操作无法撤销，不会删除豆瓣上的内容。建议先导出数据库。`)) return;
            UI.action(button, async () => {
                if (!await list.remove(userId)) throw new Error('删除失败，请关闭其他档案页面后重试。');
                await list.load(); Notification.show('本地备份已删除');
            });
        });
        try { await list.load(); }
        catch (error) {
            list.element.textContent = '读取备份失败：' + error.message;
            list.element.classList.add('state-message', 'is-danger');
        }
    }

}


class TaskModal {
    constructor(selector) {
        this.element = document.querySelector(selector);
        this.userHomepageInput = this.element.querySelector('input[name="user-homepage"]');
    }

    static init() {
        let modal = new TaskModal('#task-modal');
        TaskModal.instance = modal;
        UI.selection(modal.element, 'input[name="task"], input[name="advanced-task"]');
        const clearError = () => modal.element.querySelector('#task-error').classList.add('is-hidden');
        modal.element.addEventListener('input', clearError);
        modal.element.addEventListener('change', clearError);
        window.addEventListener('hashchange', () => { if (location.hash === '#new-task') modal.open(); });
        if (location.hash === '#new-task') {
            modal.open();
        }

        modal.element.querySelectorAll('.cancel').forEach(item => {
            item.addEventListener('click', () => modal.close());
        });

        modal.element.querySelector('.select-all').addEventListener('change', event => {
            modal.element.querySelectorAll('input[name="task"]').forEach(item => {
                if (!item.hasAttribute('disabled')) {
                    item.checked = event.target.checked;
                }
            });
        });

        modal.element.querySelector('.enable-target-user').addEventListener('click', event => {
            let doumailCheckbox = modal.element.querySelector('input[value="Doumail"]');
            let blacklistCheckbox = modal.element.querySelector('input[value="Blacklist"]');
            if (event.target.checked) {
                modal.userHomepageInput.removeAttribute('disabled');
                doumailCheckbox.checked = false;
                blacklistCheckbox.checked = false;
                doumailCheckbox.setAttribute('disabled', '');
                blacklistCheckbox.setAttribute('disabled', '');
            } else {
                modal.userHomepageInput.setAttribute('disabled', '');
                doumailCheckbox.removeAttribute('disabled');
                blacklistCheckbox.removeAttribute('disabled');
            }
        });

        modal.element.querySelector('.button.new').addEventListener('click', event => UI.action(event.currentTarget, async () => {
            const errorNode = modal.element.querySelector('#task-error');
            errorNode.classList.add('is-hidden');
            let targetUserId = null;
            if (modal.enableTargetUser) {
                targetUserId = modal.targetUserId;
                if (!targetUserId) {
                    errorNode.textContent = '请输入有效的豆瓣用户主页，例如 https://www.douban.com/people/doufen-org/';
                    errorNode.classList.remove('is-hidden');
                    modal.userHomepageInput.focus();
                    return false;
                }
            }
            let job;
            try {
                job = await modal.createJob(targetUserId);
            } catch (error) {
                errorNode.textContent = '创建备份任务失败：' + (error?.message || error);
                errorNode.classList.remove('is-hidden');
                return;
            }
            // await new Promise(resolve => setTimeout(resolve, 5000));
            if (job) {
                // console.log("等待5s")
                modal.close();
                // window.open(chrome.runtime.getURL('options.html#service'));
                location.href = chrome.runtime.getURL('options.html#service'); // 在当前页面跳转
                // history.pushState({}, '', 'options.html#service');
            }
        }));

        return modal;
    }

    async createJob(targetUserId = null) {
        let checkedTasks = this.element.querySelectorAll('input[name="task"]:checked:not(:disabled), input[name="advanced-task"]:checked:not(:disabled)');
        if (checkedTasks.length === 0) {
            throw new Error('请至少选择一项要备份的内容。');
        }

        let tasks = new Array(checkedTasks.length);
        for (let i = 0; i < checkedTasks.length; i ++) {
            tasks[i] = {
                name: checkedTasks[i].value,
            };
        }
        const service = ServiceProxy.getProxy();
        let job = await service.createJob(targetUserId, null, tasks);
        return job;
    }

    open() {
        this.element.querySelector('#task-error').classList.add('is-hidden');
        this.element.classList.add('is-active');
    }

    close() {
        this.element.classList.remove('is-active');
        if (location.hash === '#new-task') history.replaceState(null, '', location.pathname);
    }

    get targetUserId() {
        let value = (this.userHomepageInput.value || '').trim();
        if (!/^https?:\/\//i.test(value)) value = 'https://' + value;
        try {
            const url = new URL(value);
            if (!['http:', 'https:'].includes(url.protocol) || !/(^|\.)douban\.com$/i.test(url.hostname) || url.username || url.password) return null;
            const match = url.pathname.match(/^\/people\/([a-zA-Z0-9_-]+)\/?$/);
            return match?.[1] || null;
        } catch (_) { return null; }
    }

    get enableTargetUser() {
        return this.element.querySelector('.enable-target-user').checked;
    }
}

class BackupDbModal {
    constructor(selector) {
        this.element = document.querySelector(selector);
        this.progressBar = this.element.querySelector('progress');
        this.message = this.element.querySelector('p');
    }

    open(message) {
        this.element.classList.add('is-active');
        this.message.innerText = message;
        this.progressBar.value = 0;
    }

    close() {
        this.element.classList.remove('is-active');
        this.message.innerText = '';
    }

    onProgress(progress) {
        this.progressBar.value = parseInt(progress * 100);
    }
}

class Toolbar {
    reload() {
        return UI.action(document.querySelector('#reload'), () => AccountList.instance.load());
    }

    newTask() {
        TaskModal.instance.open();
    }

    static render() {
        let toolbar = new Toolbar();
        $('#reload').click(() => toolbar.reload());
        $('#new-task').click(() => toolbar.newTask());
        $('#backup-db').click(event => UI.action(event.currentTarget, async () => {
            let modal = new BackupDbModal('#backup-db-modal');
            try {
                modal.open('正在导出数据库，请保持此页面打开');
                let storage = new Storage();
                let blob = new Blob([await withDatabaseMaintenance(() => storage.dump(progress => {
                    modal.onProgress(progress);
                }))], {type: "application/zip"});
                FileSaver.saveAs(blob, 'tofu-db-backup.zip');    
            } catch (msg) {
                alert(msg);
            } finally {
                modal.close();
            }

        }));
        $('#restore-db').change(async function () {
            let dbFile = this.files[0];
            if (!dbFile || this.disabled) return false;
            this.disabled = true;
            let modal = new BackupDbModal('#backup-db-modal');
            try {
                modal.open('正在恢复数据库，请保持此页面打开');
                let storage = new Storage();
                let buffer = new Uint8Array(await dbFile.arrayBuffer());
                let result = await withDatabaseMaintenance(() => storage.restore(buffer, progress => {
                    modal.onProgress(progress);
                }));
                await AccountList.instance.load();
                let report = document.querySelector('#restore-result');
                if (!report) {
                    report = document.createElement('section'); report.id = 'restore-result';
                    report.className = 'container thin notification';
                    document.querySelector('#accounts').before(report);
                }
                report.replaceChildren(); report.setAttribute('role', 'status');
                const title = document.createElement('strong');
                title.textContent = `恢复完成：${result.successes.length} 个成功，${result.failures.length} 个未导入`;
                const details = document.createElement('details');
                const summary = document.createElement('summary'); summary.textContent = '查看恢复结果';
                const description = document.createElement('pre');
                description.textContent = [...result.successes.map(item => `已恢复 ${item.database}`),
                    ...result.failures.map(item => `${item.database}：${item.error}`)].join('\n');
                details.append(summary, description); report.append(title, details);
                report.scrollIntoView({block: 'center'});
            } catch (msg) {
                alert(msg);
            } finally {
                modal.close();
                this.value = '';
                this.disabled = false;
            }
        });
    }
}

async function withDatabaseMaintenance(operation) {
    return navigator.locks.request('tofu-database-maintenance', {ifAvailable: true}, async lock => {
        if (!lock) throw new Error('其他页面正在管理数据库或创建任务，请稍后重试。');
        const service = ServiceProxy.getProxy();
        const [status, unfinished] = await Promise.all(['status', 'hasUnfinishedJobs'].map(name => service.getProperty(name)));
        if (status !== 1 || unfinished) throw new Error('请等待当前备份和队列全部完成，再管理数据库。暂停的任务仍会使用这份数据。');
        return operation();
    });
}

UI.dialogs();
TaskModal.init();
AccountList.render();
Toolbar.render();
