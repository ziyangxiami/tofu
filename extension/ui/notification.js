export default class Notification {
    static show(message, {duration = 5000, type = 'success'} = {}) {
        let host = document.querySelector('.notification-cascading');
        if (!host) {
            host = document.createElement('div'); host.className = 'notification-cascading';
            document.body.append(host);
        }
        const element = document.createElement('div');
        element.className = `notification is-${type}`;
        element.setAttribute('role', type === 'danger' ? 'alert' : 'status');
        const messageNode = document.createElement('span'); messageNode.textContent = message;
        const close = document.createElement('button'); close.className = 'delete';
        close.setAttribute('aria-label', '关闭提示'); close.onclick = () => element.remove();
        element.append(messageNode, close); host.append(element);
        if (duration > 0) setTimeout(() => element.remove(), duration);
        return element;
    }
}
