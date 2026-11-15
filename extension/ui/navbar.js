document.addEventListener('DOMContentLoaded', () => {
    const button = document.querySelector('.navbar-burger');
    const menu = document.querySelector('.navbar-menu');
    button?.setAttribute('aria-controls', menu.id);
    button?.addEventListener('click', () => {
        const active = menu.classList.toggle('is-active');
        button.classList.toggle('is-active', active);
        button.setAttribute('aria-expanded', String(active));
        button.setAttribute('aria-label', active ? '收起导航' : '展开导航');
    });
});
