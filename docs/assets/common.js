/* Shared helpers for the CKA Study Hub */
(function () {
  // ---- Theme ----
  const stored = localStorage.getItem('cka-theme');
  const theme = stored || 'dark';
  document.documentElement.setAttribute('data-theme', theme);
  window.toggleTheme = function () {
    const cur = document.documentElement.getAttribute('data-theme');
    const next = cur === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    localStorage.setItem('cka-theme', next);
    const b = document.querySelector('.theme-btn');
    if (b) b.textContent = next === 'dark' ? '☀️' : '🌙';
  };
  document.addEventListener('DOMContentLoaded', function () {
    const b = document.querySelector('.theme-btn');
    if (b) b.textContent = document.documentElement.getAttribute('data-theme') === 'dark' ? '☀️' : '🌙';
  });
})();

const CKA = {
  domainClass(key) { return 'd-' + key; },

  async loadJSON(path) {
    const r = await fetch(path, { cache: 'no-cache' });
    if (!r.ok) throw new Error('Failed to load ' + path);
    return r.json();
  },

  // light inline markdown for card text: `code`, **bold**
  inline(text) {
    if (!text) return '';
    let t = text
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    t = t.replace(/`([^`]+)`/g, '<code>$1</code>');
    t = t.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    t = t.replace(/\n/g, '<br>');
    return t;
  },

  shuffle(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  },

  // ---- persisted practice history ----
  getHistory() {
    try { return JSON.parse(localStorage.getItem('cka-history') || '[]'); }
    catch (e) { return []; }
  },
  saveSession(sess) {
    const h = this.getHistory();
    h.unshift(sess);
    localStorage.setItem('cka-history', JSON.stringify(h.slice(0, 50)));
  },
  clearHistory() { localStorage.removeItem('cka-history'); },
};
