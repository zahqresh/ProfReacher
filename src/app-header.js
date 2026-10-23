const icons = {
  overview: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="3" width="8" height="8" rx="2"/><rect x="13" y="3" width="8" height="5" rx="2"/><rect x="13" y="10" width="8" height="11" rx="2"/><rect x="3" y="13" width="8" height="8" rx="2"/></svg>',
  followups: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 12a8 8 0 0 1 14-5l2 2"/><path d="M20 4v5h-5"/><path d="M20 12a8 8 0 0 1-14 5l-2-2"/><path d="M4 20v-5h5"/></svg>',
  bounces: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 5h16v14H4z"/><path d="m4 7 8 6 8-6"/><path d="m8 10-4 4m12-4 4 4"/></svg>',
  schedule: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
  settings: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="3"/><path d="m19.4 15 .1.1 1.4 1.1-1.4 2.4-1.7-.6a8 8 0 0 1-1.7 1l-.3 1.8h-2.8l-.3-1.8a8 8 0 0 1-1.7-1l-1.7.6-1.4-2.4 1.4-1.1a7 7 0 0 1 0-2l-1.4-1.1 1.4-2.4 1.7.6a8 8 0 0 1 1.7-1l.3-1.8h2.8l.3 1.8a8 8 0 0 1 1.7 1l1.7-.6 1.4 2.4-1.4 1.1a7 7 0 0 1 0 1.9Z"/></svg>',
};

const links = [
  ['overview', '/', 'Overview'],
  ['followups', '/followups', 'Follow-ups'],
  ['bounces', '/bounces', 'Bounces'],
  ['schedule', '/settings#schedule-section', 'Schedule'],
  ['settings', '/settings', 'Settings'],
];

const header = document.querySelector('#app-header');
header.innerHTML = `
  <div class="brand"><span class="brand-mark">C</span> CSC Mailer</div>
  <div class="header-controls">
    <nav class="app-nav" aria-label="Main menu">
      ${links.map(([page, href, label]) => `<a class="nav-link" data-page="${page}" href="${href}">${icons[page]}${label}</a>`).join('')}
    </nav>
    <button class="theme-toggle" id="theme-toggle" type="button"><span>Theme</span><span class="theme-switch"></span></button>
    <div class="connection"><span class="dot" id="connection-dot"></span><span id="connection-label">Connecting</span></div>
  </div>
`;

function updateActiveLink() {
  const currentPage = location.pathname === '/followups'
    ? 'followups'
    : location.pathname === '/bounces'
      ? 'bounces'
      : location.pathname === '/settings'
        ? location.hash === '#schedule-section' ? 'schedule' : 'settings'
        : 'overview';
  for (const link of header.querySelectorAll('.nav-link')) {
    const active = link.dataset.page === currentPage;
    link.classList.toggle('active', active);
    if (active) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
}

updateActiveLink();
window.addEventListener('hashchange', updateActiveLink);
window.addEventListener('load', updateActiveLink, { once: true });
