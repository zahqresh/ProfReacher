const themeKey = 'profreacher-theme';
const root = document.documentElement;

function applyTheme(theme) {
  root.classList.toggle('light-theme', theme === 'light');
  const button = document.querySelector('#theme-toggle');
  if (button) {
    button.setAttribute('aria-pressed', String(theme === 'light'));
    button.setAttribute('aria-label', `Switch to ${theme === 'light' ? 'dark' : 'light'} theme`);
  }
}

applyTheme(localStorage.getItem(themeKey) || 'dark');
document.querySelector('#theme-toggle')?.addEventListener('click', () => {
  const theme = root.classList.contains('light-theme') ? 'dark' : 'light';
  localStorage.setItem(themeKey, theme);
  applyTheme(theme);
});

if (typeof window.io === 'function') {
  const socket = window.appSocket = window.io();
  const updateConnection = (connected) => {
    document.querySelector('#connection-dot')?.classList.toggle('online', connected);
    const label = document.querySelector('#connection-label');
    if (label) label.textContent = connected ? 'Local dashboard' : 'Reconnecting';
  };
  socket.on('connect', () => updateConnection(true));
  socket.on('disconnect', () => updateConnection(false));
  updateConnection(socket.connected);
}

window.showToast = (notification) => {
  const stack = document.querySelector('#toast-stack');
  if (!stack) return;
  const toast = document.createElement('div');
  toast.className = `toast ${notification.type || 'info'}`;
  const title = document.createElement('strong');
  title.textContent = notification.title || 'Notification';
  const message = document.createElement('span');
  message.textContent = notification.message || '';
  toast.append(title, message);
  stack.append(toast);
  window.setTimeout(() => toast.remove(), 6500);
};
