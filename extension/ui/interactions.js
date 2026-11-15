import Notification from './notification.js';

export default class UI {
    static async action(button, operation) {
        if (button?.dataset.busy) return;
        const modal = button?.closest('.modal');
        if (button) {
            button.dataset.busy = 'true'; button.disabled = true;
            button.setAttribute('aria-disabled', 'true'); button.classList.add('is-loading');
        }
        if (modal) modal.dataset.busy = 'true';
        try { return await operation(); }
        catch (error) { Notification.show(error?.message || String(error), {type: 'danger', duration: 10000}); }
        finally {
            if (button) {
                delete button.dataset.busy; button.disabled = false;
                button.removeAttribute('aria-disabled'); button.classList.remove('is-loading');
            }
            if (modal) delete modal.dataset.busy;
        }
    }

    static selection(element, selector) {
        const all = element.querySelector('.select-all');
        const update = () => {
            const inputs = [...element.querySelectorAll(selector)].filter(input => !input.disabled);
            const count = inputs.filter(input => input.checked).length;
            if (all) {
                all.checked = inputs.length > 0 && count === inputs.length;
                all.indeterminate = count > 0 && count < inputs.length;
            }
            const label = element.querySelector('.selection-count');
            if (label) label.textContent = `已选择 ${count} 项`;
        };
        element.addEventListener('change', update); update();
        return update;
    }

    static dialogs() {
        const stack = [];
        const focusable = modal => [...modal.querySelectorAll('a[href], button, input, select, textarea, [tabindex="0"]')]
            .filter(node => !node.disabled && node.getClientRects().length);
        document.querySelectorAll('.modal').forEach((modal, index) => {
            modal.setAttribute('role', 'dialog'); modal.setAttribute('aria-modal', 'true'); modal.tabIndex = -1;
            const title = modal.querySelector('.modal-card-title');
            if (title) {
                title.id ||= `dialog-title-${index}`; modal.setAttribute('aria-labelledby', title.id);
            } else modal.setAttribute('aria-label', modal.id === 'picture-modal' ? '图片预览' : '内容详情');
            modal.querySelectorAll('.delete, .modal-close').forEach(button => button.setAttribute('aria-label', '关闭'));
            let opened = false, previous;
            const sync = () => {
                const active = modal.classList.contains('is-active');
                if (active === opened) return;
                opened = active;
                if (active) {
                    previous = document.activeElement; stack.push(modal);
                    modal.style.zIndex = String(100 + stack.length);
                    (focusable(modal)[0] || modal).focus();
                } else {
                    stack.splice(stack.indexOf(modal), 1);
                    if (previous?.isConnected) previous.focus();
                }
                document.documentElement.classList.toggle('is-clipped', stack.length > 0);
            };
            new MutationObserver(sync).observe(modal, {attributes: true, attributeFilter: ['class']});
            modal.addEventListener('click', event => {
                if (event.target.matches('.modal-background, .cancel, .modal-close, .delete')) {
                    if (modal.dataset.busy || modal.id === 'backup-db-modal') {
                        event.preventDefault(); event.stopImmediatePropagation(); return;
                    }
                    modal.classList.remove('is-active');
                }
            }, true);
            sync();
        });
        document.addEventListener('keydown', event => {
            const modal = stack.at(-1);
            if (!modal) return;
            if (event.key === 'Escape' && !modal.dataset.busy && modal.id !== 'backup-db-modal') {
                modal.classList.remove('is-active'); event.preventDefault();
            }
            if (event.key === 'Tab') {
                const nodes = focusable(modal), first = nodes[0] || modal, last = nodes.at(-1) || modal;
                if (!nodes.length || (event.shiftKey && document.activeElement === first) ||
                    (!event.shiftKey && document.activeElement === last) || !modal.contains(document.activeElement)) {
                    (event.shiftKey ? last : first).focus(); event.preventDefault();
                }
            }
        });
    }
}
