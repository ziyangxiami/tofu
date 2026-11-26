const countFormat = new Intl.NumberFormat('zh-CN');

function validCount(value) {
    return Number.isSafeInteger(value) && value >= 0;
}

export function formatTaskProgress(task, completed = false) {
    const completion = validCount(task.completion) ? task.completion : 0;
    const total = validCount(task.total) ? task.total : null;
    // Reviews accumulate totals one category at a time; public annotation pages
    // discover theirs as they go. Neither is a known denominator until finished.
    // The initial 0/1 in Task.init is also a placeholder, not a one-item total.
    const discovering = total === null || completion > total || (!completed &&
        (task.taskType === 'Review' || task.checkpoint?.kind === 'annotation-web' ||
            total === 0 || (total === 1 && completion === 0)));
    if (discovering) {
        return {
            value: 0, max: 1,
            text: `${countFormat.format(completion)} / —`,
            description: `已处理 ${countFormat.format(completion)}，总量统计中`,
        };
    }
    const percent = total > 0 ? Math.min(100, Math.floor(completion / total * 100)) : 100;
    return {
        value: total > 0 ? Math.min(completion, total) : 1,
        max: total > 0 ? total : 1,
        text: `${countFormat.format(completion)} / ${countFormat.format(total ?? completion)} · ${percent}%`,
        description: completed ? '任务已完成' : '按当前已知总量计算，总量可能随扫描更新',
    };
}

export default class TaskProgressList {
    constructor(element) {
        this.element = element;
        this.rows = [];
    }

    render(job) {
        const tasks = Array.isArray(job?.tasks) ? job.tasks : [];
        // Tasks retain their order within a job. Reuse the actual nodes so a
        // progress event never collapses the table or restarts its progress bars.
        for (let index = 0; index < tasks.length; index++) {
            const task = tasks[index];
            let row = this.rows[index];
            if (!row) {
                const element = document.createElement('tr');
                element.innerHTML = '<td class="task-name"></td><td><div class="task-progress">' +
                    '<progress class="progress is-info" value="0" max="1"></progress>' +
                    '<span class="task-progress-text"></span></div><p class="task-error help has-text-danger" hidden></p></td>';
                row = {
                    element,
                    name: element.querySelector('.task-name'),
                    bar: element.querySelector('progress'),
                    text: element.querySelector('.task-progress-text'),
                    error: element.querySelector('.task-error'),
                };
                this.rows.push(row);
                this.element.appendChild(element);
            }
            const name = task.name || (task.taskType === 'Review' ? '评论' : '任务');
            const completed = (job.completedTaskTypes || []).includes(task.taskType);
            const terminal = !!job.finishedAt || !!job.cancelled;
            const activeTypes = Array.isArray(job.activeTaskTypes) ? job.activeTaskTypes : [];
            const current = !terminal && !completed && (activeTypes.includes(task.taskType) || (!!job._currentTask &&
                (task.taskType ? task.taskType === job._currentTask.taskType : name === job._currentTask.name)));
            const progress = formatTaskProgress(task, completed);
            const failure = job.failedTasks?.find(item => item.task === name || item.task === task.taskType);
            const state = failure ? '失败' : completed ? '完成' : job.cancelled ? '已取消' : current ? '处理中' : job.finishedAt ? '未执行' : '待处理';
            if (failure) { progress.text = '失败 · ' + progress.text; progress.description = failure.error; }
            row.element.classList.toggle('has-text-danger', !!failure);
            row.bar.classList.toggle('is-danger', !!failure);
            row.bar.classList.toggle('is-info', !failure);
            row.element.title = failure?.error || state;
            row.error.hidden = !failure; row.error.textContent = failure?.error || '';
            row.element.classList.toggle('is-selected', current);
            if (row.name.textContent !== `${name} · ${state}`) row.name.textContent = `${name} · ${state}`;
            if (row.text.textContent !== progress.text) row.text.textContent = progress.text;
            if (row.bar.max !== progress.max) row.bar.max = progress.max;
            if (row.bar.value !== progress.value) row.bar.value = progress.value;
            row.bar.setAttribute('aria-label', `${name}进度`);
            row.bar.setAttribute('aria-valuetext', `${progress.text}，${progress.description}`);
            row.text.title = progress.description;
        }
        while (this.rows.length > tasks.length) this.rows.pop().element.remove();
    }
}
