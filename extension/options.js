import Settings, {SERVICE_SETTINGS, TASK_FILES_SETTINGS} from './settings.js';
import ServiceProxy from './services/ServiceProxy.js';
import Notification from './ui/notification.js';
import TabPanel from './ui/tab.js';
import {getDiagnosticReport} from './services/diagnostics.js';
import TaskProgressList from './ui/task-progress.js';
import UI from './ui/interactions.js';
import Content from './ui/safe-content.js';


class AccountPanel {
    constructor(successSelector, errorSelector) {
        this.panel = document.querySelector(successSelector);
        this.error = document.querySelector(errorSelector);
    }

    async load() {
        const URL_LOGOUT = 'https://www.douban.com/accounts/logout?ck={ck}';

        let cookies = [];
        try {
            if (typeof chrome !== 'undefined' && chrome.cookies) {
                cookies = await new Promise(resolve => chrome.cookies.getAll({domain: 'douban.com'}, resolve)) || [];
            }
        } catch (e) {
            console.error("Failed to get cookies:", e);
        }

        let uid, ck;
        if (Array.isArray(cookies)) {
            for (let cookie of cookies) {
                if (!cookie || !cookie.name) continue;
                switch (cookie.name) {
                    case 'dbcl2':
                        if (cookie.value) {
                            let match = cookie.value.match(/^\"?(\w+):/);
                            if (match) {
                                uid = parseInt(match[1]);
                            }
                        }
                        break;
                    case 'ck':
                        if (cookie.value) {
                            ck = cookie.value.replace(/^\"|\"$/g, '');
                        }
                        break;
                }
            }
        }
        if (uid == undefined) {
            this.error.classList.remove('is-hidden');
            return;
        }
        let response = await fetch(`https://m.douban.com/rexxar/api/v2/user/${uid}?ck=${encodeURIComponent(ck || '')}`, {credentials: 'include', signal: AbortSignal.timeout(20000), headers: {'X-Override-Referer': 'https://m.douban.com/'}});
        if (response.status != 200) {
            this.error.classList.remove('is-hidden');
            return;
        }
        let userInfo = await response.json();
        const avatar = document.createElement('img');
        avatar.src = Content.url(userInfo.avatar); avatar.alt = '';
        this.panel.querySelector('.media-left>.image').replaceChildren(avatar);
        this.panel.querySelector('.media-content [name="name"]').innerText = userInfo.name;
        this.panel.querySelector('.media-content [name="symbol"]').innerText = '@' + userInfo.uid;
        this.panel.querySelector('.media-content [name="reg-time"]').innerText = userInfo.reg_time;
        this.panel.querySelector('.media-content [name="intro"]').innerText = userInfo.intro;
        let logoutLink = this.panel.querySelector('.button[name="logout"]');
        logoutLink.setAttribute('href', URL_LOGOUT.replace('{ck}', encodeURIComponent(ck || '')));
        logoutLink.addEventListener('click', event => {
            if (!confirm('确定要退出当前账号的登录状态吗？')) {
                event.preventDefault();
            }
        });
        let collectionPanel = this.panel.querySelector('.media-content [name="collection"]');
        let collection = {
            '关注': {key: 'following_count', url: 'https://www.douban.com/contacts/list'},
            '被关注': {key: 'followers_count', url: 'https://www.douban.com/contacts/rlist'},
            '日记': {key: 'notes_count', url: 'https://www.douban.com/mine/notes'},
            '相册': {key: 'photo_albums_count', url: 'https://www.douban.com/mine/photos'},
            '小组': {key: 'joined_group_count', url: 'https://www.douban.com/group/mine'},
            '广播': {key: 'statuses_count', url: 'https://www.douban.com/mine/statuses'},
            '豆列': {key: 'owned_doulist_count', url: 'https://www.douban.com/mine/doulists'},
        };
        for (let item in collection) {
            let column = document.createElement('DIV');
            let url = collection[item].url;
            let key = collection[item].key;
            column.classList.add('column');
            const link = document.createElement('a');
            link.href = url; link.target = '_blank'; link.rel = 'noopener noreferrer';
            link.textContent = `${Number(userInfo[key]) || 0} ${item}`; column.append(link);
            collectionPanel.appendChild(column);
        }
        this.panel.classList.remove('is-hidden');
    }

    static async render() {
        let panel = new AccountPanel('#account',
            '#account-error');
        try { await panel.load(); }
        catch (_) {
            panel.error.classList.remove('is-hidden');
            const message = document.createElement('p'); message.className = 'help has-text-centered';
            message.textContent = '账号信息暂时无法读取，请检查网络或完成豆瓣安全验证后刷新。';
            panel.error.append(message);
        }
    }
}


class Control {
    constructor(name) {
        this.name = name;
        this.element = document.querySelector(`[name="${name}"]`);
    }

    set value(value) {
        this.element.value = value;
    }

    get value() {
        return this.element.value;
    }
}


class GeneralPanel {
    constructor(selector, settings, defaults) {
        this.panel = document.querySelector(selector);
        this.settings = settings;
        this.defaults = defaults;

        let BoolSwitch = class extends Control {
            constructor(name) {
                super(name);

            }

            set value(value) {
                $(this.element).prop('checked', value).trigger('change');
            }

            get value() {
                return this.element.checked;
            }
        };

        let TimeInput = class extends Control {
            set value(value) {
                let num = parseFloat(value);
                this.element.value = !isNaN(num) ? num / 1000 : 1;
            }

            get value() {
                let seconds = parseFloat(this.element.value);
                if (!Number.isFinite(seconds) || seconds < 0.1 || seconds > 3600) throw new Error('请求间隔需要在 0.1 至 3600 秒之间。');
                return Math.round(seconds * 1000);
            }
        };

        let TextInput = class extends Control {
            set value(value) {
                this.element.value = value ?? '';
            }

            get value() {
                return this.element.value || '';
            }
        };

        const CONTROL_METAS = [
            //{name: 'assistant.enable', type: BoolSwitch},
            {name: 'service.debug', type: BoolSwitch},
            {name: 'service.adaptivePacing', type: BoolSwitch},
            {name: 'service.requestInterval', type: TimeInput},
            {name: '同步图片.cloudName', type: TextInput},
        ];

        this.controls = {};
        for (let {name, type} of CONTROL_METAS) {
            let control = this.controls[name] = new type(name);
            control.value = settings[name];
        }

        this.saveButton = document.querySelector('.button[name="save"]');
        this.resetButton = document.querySelector('.button[name="reset"]');

        this.dirty = false;
        this.status = document.createElement('p'); this.status.className = 'save-status';
        this.status.setAttribute('role', 'status'); this.panel.append(this.status);
        this.panel.addEventListener('input', () => {
            this.dirty = true; this.status.textContent = '有未保存的修改';
        });
        window.addEventListener('beforeunload', event => {
            if (this.dirty) { event.preventDefault(); event.returnValue = ''; }
        });
        this.saveButton.addEventListener('click', event => UI.action(event.currentTarget, async () => {
            if (this.saving) return;
            const values = Object.fromEntries(Object.entries(this.controls).map(([name, control]) => [name, control.value]));
            await this.save(values);
        }));
        this.resetButton.addEventListener('click', event => UI.action(event.currentTarget, async () => {
            if (this.saving || !confirm('将请求间隔、调试开关和图片云存储恢复为默认设置？')) return;
            await this.save(this.defaults);
            for (const name in this.controls) this.controls[name].value = this.settings[name];
        }));
    }

    async save(settings) {
        this.saving = true;
        try {
            await Settings.save(settings);
            this.settings = {...settings}; this.dirty = false;
            this.status.textContent = '设置已保存';
            try {
                await ServiceProxy.getProxy().loadSettings();
                Notification.show('设置已保存并应用');
            } catch (_) {
                this.status.textContent = '设置已保存，后台暂时无法连接。下次启动时会应用。';
                Notification.show(this.status.textContent, {type: 'warning', duration: 8000});
            }
        } finally { this.saving = false; }
    }

    static async render() {
        let settings = await Settings.load(SERVICE_SETTINGS, TASK_FILES_SETTINGS);
        let defaults = Object.assign({}, SERVICE_SETTINGS, TASK_FILES_SETTINGS);
        return new GeneralPanel('.page-tab-content[name="general"]', settings, defaults);
    }
}


/**
 * class ServicePanel
 */
export default class ServicePanel {
    constructor(selector, service) {
        this.panel = document.querySelector(selector);
        this.service = service;

        let $panel = $(this.panel);
        this.$start = $panel.find('.service-ctrl[name="start"]');
        this.$stop = $panel.find('.service-ctrl[name="stop"]');
        this.$loading = $panel.find('.service-ctrl[name="loading"]');
        this.$cancel = $panel.find('[name="cancel-job"]');
        this.$logs = $panel.find('.logs');
        this.$job = $panel.find('.job');
        this.progressList = new TaskProgressList(this.$job[0]);
        this.refreshError = this.panel.querySelector('.service-refresh-error');
        this.refreshQueued = false;
        this.refreshPromise = null;
        this.lastStatus = null;
        $panel.find('[name="download-diagnostics"]').click(async event => {
            const button = event.currentTarget;
            button.disabled = true;
            try {
                const report = await getDiagnosticReport();
                const blob = new Blob([JSON.stringify(report, null, 2)], {type: 'application/json'});
                const url = URL.createObjectURL(blob);
                const link = document.createElement('a');
                link.href = url;
                link.download = `tofu-diagnostics-${new Date().toISOString().slice(0, 10)}.json`;
                document.body.appendChild(link);
                link.click();
                link.remove();
                setTimeout(() => URL.revokeObjectURL(url), 60000);
            } catch (error) {
                alert('诊断日志下载失败，请刷新页面后重试。');
            } finally {
                button.disabled = false;
            }
        });
        this.$start.click(event => UI.action(event.currentTarget, async () => { await service.start(); await this.onProgress(service); }));
        this.$stop.click(event => UI.action(event.currentTarget, async () => { await service.stop(); await this.onProgress(service); }));
        this.$cancel.click(event => UI.action(event.currentTarget, async () => {
            if (!confirm('放弃当前尚未完成的任务？已保存的旧备份不会被删除，未发布的数据将被清理。')) return;
            await service.cancelCurrentJob();
            await this.onProgress(service);
        }));
        this.panel.querySelector('[name="reconnect"]').addEventListener('click', event => UI.action(event.currentTarget, () => this.onProgress(service)));
        service.addEventListener('disconnect', () => {
            if (this.lastStatus === 1) return;
            this.onProgress(service);
        });
        this.ready = this.init(service);
    }

    async init(service) {
        service.addEventListener('statechange', event => this.onStateChange(service));
        service.addEventListener('progress', event => this.onProgress(service));
        service.addEventListener('log', event => this.onLog(event.detail));
        const showLogs = enabled => this.$logs.parent().toggleClass('is-hidden', !enabled);
        chrome.storage.onChanged.addListener((changes, area) => {
            if (area === 'sync' && changes['service.debug']) showLogs(changes['service.debug'].newValue);
        });
        try {
            showLogs(await service.getProperty('debug'));
        } catch (error) {
            // A debug-setting failure must not prevent progress from loading.
        }
        await this.onStateChange(service);
    }

    onLog(entry) {
        let {time, levelName, message} = entry;
        let datetime = new Date(time).toISOString();
        $('<P>').text(`[${datetime}] ${levelName}: ${message}`).appendTo(this.$logs);
        while (this.$logs[0].children.length > 300) this.$logs[0].firstElementChild.remove();
        this.$logs.scrollTop(this.$logs.prop('scrollHeight'));
    }

    renderStatus(status, job = null) {
        this.lastStatus = status;
        let $panel = $(this.panel);
        let statusName = '状态未知';
        let visibleControl;
        let canCancel = false;
        let startLabel = '开始';
        const isRetryable = (() => {
            if (!job || !job.finishedAt || job.cancelled || job.isMigration) return false;
            const tasks = Array.isArray(job.tasks) ? job.tasks : [];
            if (tasks.some(task => String(task?.taskType || task?.name || '').startsWith('Migrate'))) return false;
            const failed = Array.isArray(job.failedTasks) ? job.failedTasks.length : 0;
            const completed = Array.isArray(job.completedTaskTypes) ? job.completedTaskTypes.length : 0;
            return failed > 0 && tasks.length > completed;
        })();
        // Service.STATE_STOPPED = 1
        // Service.STATE_START_PENDING = 2
        // Service.STATE_STOP_PENDING = 3
        // Service.STATE_RUNNING = 4
        switch (status) {
            case 1:
                statusName = '已停止';
                if (job && !job.finishedAt) {
                    visibleControl = this.$start[0];
                    startLabel = '继续';
                    canCancel = true;
                } else if (isRetryable) {
                    visibleControl = this.$start[0];
                    startLabel = '重试失败项';
                }
                break;
            case 2:
                visibleControl = this.$stop[0];
                statusName = '等待任务';
                break;
            case 3:
                visibleControl = this.$loading[0];
                statusName = '正在停止';
                break;
            case 4:
                visibleControl = this.$stop[0];
                statusName = '运行中';
                break;
        }
        const startText = this.$start[0]?.querySelector('label');
        if (startText && startText.textContent !== startLabel) startText.textContent = startLabel;
        if (this.$cancel[0]) this.$cancel[0].classList.toggle('is-hidden', !canCancel);
        this.panel.querySelectorAll('.service-ctrl').forEach(control => {
            control.classList.toggle('is-hidden', control !== visibleControl);
        });
        const label = this.panel.querySelector('.service-status');
        if (label.textContent !== statusName) label.textContent = statusName;
        $panel.find('.service-status').data('status', status);
    }

    onStateChange(service) {
        return this.onProgress(service);
    }

    onProgress(service) {
        this.refreshQueued = true;
        if (!this.refreshPromise) {
            this.refreshPromise = this.refresh(service).finally(() => {
                this.refreshPromise = null;
                if (this.refreshQueued) this.onProgress(service);
            });
        }
        return this.refreshPromise;
    }

    async refresh(service) {
        while (this.refreshQueued) {
            this.refreshQueued = false;
            try {
                const [status, job] = await Promise.all([
                    service.getProperty('status'), service.getProperty('displayJob'),
                ]);
                // Reads are serialized, so an older read cannot overwrite a
                // newer rendered frame. Render even if another read is queued:
                // continuous events must not starve the UI of all updates.
                this.renderStatus(status, job);
                this.progressList.render(job);
                const summary = this.panel?.querySelector('.service-overview');
                if (summary) {
                    const completed = job?.completedTaskTypes?.length || 0;
                    const failed = job?.failedTasks?.length || 0;
                    summary.textContent = job?.tasks?.length ?
                        `${job.finishedAt ? '最近任务' : '当前任务'} · ${completed} / ${job.tasks.length} 项已完成${failed ? ` · ${failed} 项失败，请查看下方原因` : ''}` :
                        '还没有任务，创建一次备份即可在这里查看进度。';
                }
                const jobError = this.panel?.querySelector('.service-job-error');
                if (jobError) { jobError.textContent = job?.error || ''; jobError.classList.toggle('is-hidden', !job?.error); }
                const pacingNote = this.panel?.querySelector('.service-pacing-note');
                if (pacingNote) {
                    const failedText = (job?.failedTasks || []).map(f => f?.error || '').join(' ');
                    const rateLimited = Boolean(job?.finishedAt && !job?.cancelled && (/访问限制|429/.test(failedText) || /访问限制|429/.test(job?.error || '')));
                    let note = '';
                    if (rateLimited) {
                        note = '已保存当前断点。请先在浏览器打开豆瓣页面完成验证或稍等片刻，再点击上方「重试失败项」从中断页码继续，无需重头开始。';
                    } else if (!job?.finishedAt && job?.pacing?.coolingDown) {
                        note = `数据量较大，正在短暂冷却后继续（当前自动基准 ${(job.pacing.effectiveMs / 1000).toFixed(1)} 秒/次），以降低触发豆瓣验证的概率。`;
                    } else if (!job?.finishedAt && job?.pacing?.adaptive) {
                        note = `检测到数据量较大，已自动放慢请求节奏（约 ${(job.pacing.effectiveMs / 1000).toFixed(1)} 秒/次 + 随机抖动），以降低触发豆瓣验证的概率。`;
                    }
                    pacingNote.textContent = note;
                    pacingNote.classList.toggle('is-hidden', !note);
                }
                this.refreshError.classList.add('is-hidden');
            } catch (error) {
                if (!this.refreshQueued) this.refreshError.classList.remove('is-hidden');
            }
        }
    }

    static async render() {
        let service = ServiceProxy.getProxy();
        const panel = new ServicePanel('.page-tab-content[name="service"]', service);
        await panel.ready;
        return panel;
    }
}


TabPanel.render();
GeneralPanel.render().catch(error => Notification.show('设置读取失败：' + error.message, {type: 'danger', duration: 0}));
AccountPanel.render();
ServicePanel.render();
