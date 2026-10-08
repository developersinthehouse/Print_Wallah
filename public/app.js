const app = document.querySelector('#app');
const modal = document.querySelector('#modal');
const modalContent = document.querySelector('#modal-content');
const logoutButton = document.querySelector('#logout-button');
const route = decodeURIComponent(location.pathname.split('/').filter(Boolean)[1] || '');
const isCustomerRoute = location.pathname.startsWith('/shop/');
const isShopAdminRoute = location.pathname === '/admin' || location.pathname === '/admin/';
let session = null;
let shop = null;
let uploadState = null;
let currentFileUrl = null;
let quote = null;
let quoteRevision = 0;
let adminTab = 'overview';
let statusTimer = null;
let adminTimer = null;
let adminOrdersSignature = '';
let adminRefreshBusy = false;

/* Load only the code this page needs: admin pages never download pdf.js or the customer flow, and vice versa. */
const loadScript = src => new Promise((resolve, reject) => { const el = document.createElement('script'); el.src = src; el.onload = resolve; el.onerror = () => reject(new Error(`Could not load ${src}`)); document.head.appendChild(el); });
const loadStyle = href => new Promise((resolve, reject) => { const el = document.createElement('link'); el.rel = 'stylesheet'; el.href = href; el.onload = resolve; el.onerror = () => reject(new Error(`Could not load ${href}`)); document.head.appendChild(el); });
const modulesReady = (location.pathname.startsWith('/shop/') ? ['/vendor/pdfjs/pdf.min.js', '/photoedit.js', '/customer.js'] : ['/admin.js']).reduce((chain, src) => chain.then(() => loadScript(src)), location.pathname.startsWith('/shop/') ? Promise.resolve() : loadStyle('/admin.css'));

document.addEventListener('click', e => { if (e.target.closest('[data-close-modal]')) closeModal(); if (e.target.closest('[data-reload]')) location.reload(); });

async function api(url, options = {}) {
  const response = await fetch(`/api${url}`, { credentials: 'same-origin', ...options, headers: { ...(options.body && !(options.body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}), ...(options.headers || {}) } });
  const type = response.headers.get('content-type') || '';
  const data = type.includes('json') ? await response.json() : await response.text();
  if (response.status === 401 && session && !url.startsWith('/auth/')) { session = null; logoutButton.classList.add('hidden'); clearInterval(adminTimer); toast('Your session ended. Please sign in again.'); setTimeout(() => renderLogin(isShopAdminRoute ? 'shop' : 'super'), 0); }
  if (!response.ok) throw Object.assign(new Error((data && data.error) || `Request failed (${response.status})`), { status: response.status, data });
  return data;
}
const jsonBody = (value) => ({ method: 'POST', body: JSON.stringify(value) });
function toast(message, tone) { const el = document.querySelector('#toast'); const kind = tone || (/failed|error|could not|invalid|not found|no connection/i.test(message) ? 'error' : /saved|verified|updated|copied|switched|confirmed|cancelled/i.test(message) ? 'success' : 'info'); el.textContent = message; el.dataset.tone = kind; el.classList.add('show'); clearTimeout(el._timer); el._timer = setTimeout(() => el.classList.remove('show'), 3200); }
async function holdLoadingState(started, minimum = 180) { const remaining = minimum - (performance.now() - started); if (remaining > 0) await new Promise(resolve => setTimeout(resolve, remaining)); }
function esc(value = '') { return String(value).replace(/[&<>"']/g, s => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[s])); }
function money(value) { return new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 2 }).format(Number(value || 0)); }
function date(value) { return value ? new Date(value).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '—'; }
function dateTime(value) { return value ? new Date(value).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—'; }
function statePill(value) { const state = String(value || 'pending').toLowerCase(); return `<span class="pill ${esc(state)}">${esc(state.replaceAll('_', ' '))}</span>`; }
function setHeading(value, chips = '') { document.querySelector('#nav-context').innerHTML = value ? `<span class="nav-role">${esc(value)}</span>${chips}` : chips; }
function setBrandHome(href) { document.querySelector('#brand-link').setAttribute('href', href); }
function showModal(content) { modalContent.innerHTML = `<div class="modal-inner">${content}</div>`; modal.showModal(); }
function closeModal() { modal.close(); }

/* Shared footer bottom: copyright + developer credit + social links (used by the customer footer and the sign-in pages). */
const SOCIAL = [
  ['Instagram', 'https://www.instagram.com/developers_ballia?utm_source=ig_web_button_share_sheet&stkn=ZDNlZDc0MzIxNw==', '<rect x="3.5" y="3.5" width="17" height="17" rx="5" fill="none" stroke="currentColor" stroke-width="1.8"/><circle cx="12" cy="12" r="4" fill="none" stroke="currentColor" stroke-width="1.8"/><circle cx="17.2" cy="6.8" r="1.1" fill="currentColor"/>'],
  ['X (Twitter)', 'https://x.com/Deve_lopers_?t=mwe4xTw3VEIA6mF2NjA0oQ&s=08', '<path fill="currentColor" d="M18.9 2h3.4l-7.4 8.5L23.6 22h-6.8l-5.3-7-6.1 7H2l7.9-9.1L1.6 2h7l4.8 6.4L18.9 2Zm-1.2 18h1.9L7.4 4H5.4l12.3 16Z"/>'],
  ['Facebook', 'https://www.facebook.com/profile.php?id=61584026251451', '<path fill="currentColor" d="M13.5 22v-9h3l.5-3.5h-3.5V7.2c0-1 .3-1.7 1.8-1.7h1.9V2.4c-.9-.1-1.8-.2-2.8-.2-2.8 0-4.7 1.7-4.7 4.8v2.5H6.5V13h3.2v9h3.8Z"/>'],
  ['LinkedIn', 'https://www.linkedin.com/in/developers-team-devlopers-563526392', '<path fill="currentColor" d="M20.45 20.45h-3.56v-5.57c0-1.33-.03-3.04-1.85-3.04-1.86 0-2.14 1.45-2.14 2.94v5.67H9.35V9h3.41v1.56h.05c.48-.9 1.64-1.85 3.37-1.85 3.6 0 4.27 2.37 4.27 5.46v6.28ZM5.34 7.43a2.06 2.06 0 1 1 0-4.12 2.06 2.06 0 0 1 0 4.12ZM7.12 20.45H3.56V9h3.56v11.45Z"/>'],
  ['GitHub', 'https://github.com/developersinthehouse', '<path fill="currentColor" d="M12 .5C5.65.5.5 5.65.5 12c0 5.08 3.29 9.39 7.86 10.91.58.1.79-.25.79-.56v-1.96c-3.2.7-3.87-1.54-3.87-1.54-.52-1.33-1.28-1.69-1.28-1.69-1.04-.71.08-.7.08-.7 1.15.08 1.76 1.18 1.76 1.18 1.03 1.76 2.69 1.25 3.35.96.1-.75.4-1.25.73-1.54-2.55-.29-5.24-1.28-5.24-5.68 0-1.25.45-2.28 1.18-3.09-.12-.29-.51-1.46.11-3.05 0 0 .97-.31 3.17 1.18a11 11 0 0 1 5.78 0c2.2-1.49 3.17-1.18 3.17-1.18.62 1.59.23 2.76.11 3.05.74.81 1.18 1.84 1.18 3.09 0 4.41-2.69 5.38-5.25 5.67.41.36.78 1.06.78 2.14v3.17c0 .31.21.67.8.56A11.5 11.5 0 0 0 23.5 12C23.5 5.65 18.35.5 12 .5Z"/>'],
  ['Email', 'mailto:developersinthehouse@gmail.com', '<rect x="3" y="5.5" width="18" height="13" rx="3" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="m4 8 8 6 8-6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>'],
];
function legalFooterHtml() {
  const links = SOCIAL.map(([name, href, art]) => `<a href="${href}" aria-label="${name}" title="${name}" ${href.startsWith('http') ? 'target="_blank" rel="noopener"' : ''}><svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true">${art}</svg></a>`).join('');
  return `<div class="pw-footer-bottom"><p class="legal"><span>&copy; ${new Date().getFullYear()} Print Wallah</span><span class="legal-dot" aria-hidden="true">·</span><span>Made by DEVELOPERS · <a href="https://thedevelopers.co.in" target="_blank" rel="noopener">thedevelopers.co.in</a></span></p><nav class="social-links" aria-label="DEVELOPERS social links">${links}</nav></div>`;
}

/* ---------- in-app dialogs (replace confirm()/prompt()) ---------- */
function confirmDialog({ title, message = '', confirmLabel = 'Confirm', cancelLabel = 'Cancel', tone = 'primary', field = null }) {
  return new Promise(resolve => {
    const d = document.querySelector('#confirm');
    d.innerHTML = `<form class="confirm-body" method="dialog"><h2 id="confirm-title">${esc(title)}</h2>${message ? `<p>${esc(message)}</p>` : ''}${field ? `<div class="field"><label for="confirm-field">${esc(field.label)}</label><input id="confirm-field" type="${field.type || 'text'}" ${field.attrs || ''} value="${esc(field.value ?? '')}" required></div><div class="form-error" id="confirm-error" role="alert"></div>` : ''}<div class="confirm-actions"><button type="button" class="button button-light" data-v="0">${esc(cancelLabel)}</button><button type="submit" class="button button-${tone}" data-v="1">${esc(confirmLabel)}</button></div></form>`;
    let settled = false;
    const done = value => { if (settled) return; settled = true; d.close(); resolve(value); };
    d.querySelector('[data-v="0"]').onclick = () => done(false);
    d.querySelector('form').onsubmit = e => { e.preventDefault(); if (field) { const input = d.querySelector('#confirm-field'); if (!input.checkValidity()) { d.querySelector('#confirm-error').textContent = input.validationMessage || 'Enter a valid value.'; return; } done(input.value); } else done(true); };
    d.oncancel = e => { e.preventDefault(); done(false); };
    d.onclick = e => { if (e.target === d) done(false); };
    d.showModal();
    (field ? d.querySelector('#confirm-field') : d.querySelector('[data-v="0"]')).focus();
  });
}
function showDrawer(content) { modal.classList.add('is-drawer'); showModal(content); }
modal.addEventListener('close', () => modal.classList.remove('is-drawer'));
modal.addEventListener('click', e => { if (e.target === modal) closeModal(); });

async function start() {
  document.querySelector('#site-footer').innerHTML = legalFooterHtml();
  const navWrap = document.querySelector('.nav-wrap'), syncNav = () => navWrap.classList.toggle('scrolled', window.scrollY > 6);
  window.addEventListener('scroll', syncNav, { passive: true }); syncNav();
  try { const meta = await api('/meta'); window.MAX_UPLOAD_MB = meta.maxUploadMb; } catch { }
  try { const data = await api('/session'); session = data.user; }
  catch { session = null; }
  try { await modulesReady; } catch (e) { app.innerHTML = errorPanel('Could not load this page', 'Check your connection and try again.'); return; }
  setBrandHome(isCustomerRoute ? `/shop/${encodeURIComponent(route)}` : isShopAdminRoute ? '/admin' : '/');
  if (isCustomerRoute) { document.querySelector('#site-footer').classList.add('hidden'); document.querySelector('#app').classList.add('wide'); setHeading(''); await renderCustomer(route); return; }
  if (isShopAdminRoute) { if (session?.role === 'shop_admin') { logoutButton.classList.remove('hidden'); await renderShopAdmin(); } else { renderLogin('shop'); } return; }
  if (session?.role === 'super_admin') { logoutButton.classList.remove('hidden'); await renderSuper(); return; }
  if (session?.role === 'shop_admin') { logoutButton.classList.remove('hidden'); await renderShopAdmin(); return; }
  renderLogin('super');
}
logoutButton.addEventListener('click', async () => { await api('/auth/logout', { method: 'POST' }).catch(() => { }); session = null; logoutButton.classList.add('hidden'); location.href = '/'; });
function renderLogin(mode) {
  const superMode = mode === 'super'; setHeading(''); setShellMode(false);
  app.innerHTML = `<section class="login-wrap"><div class="login-card">
    <div class="login-brandline">
      <div class="login-brand-mark" aria-hidden="true"><svg viewBox="0 0 48 48" fill="none"><path class="login-mark-paper" d="M15 7h15l6 6v7H15z"/><path d="M30 7v7h6M12 20h24a4 4 0 0 1 4 4v9a4 4 0 0 1-4 4h-3v-8H15v8h-3a4 4 0 0 1-4-4v-9a4 4 0 0 1 4-4Z"/><path d="M15 29h18v12H15zM19 33h10m-10 4h7"/><circle cx="34" cy="25" r="1" fill="currentColor" stroke="none"/></svg></div>
      <div class="login-brand-copy"><span class="login-brand-name">PRINT WALLAH</span><span class="login-brand-caption">WORKSPACE ACCESS</span></div>
    </div>
    <div class="login-intro"><h1>${superMode ? 'Super Admin sign in' : 'Shop admin sign in'}</h1><p class="lede">${superMode ? 'Manage shops, access, pricing and the print network from one place.' : 'Sign in with the credentials created for your printing shop.'}</p></div>
    <form id="login-form" class="stack">
      <div class="field"><label for="email">Email address</label><div class="login-input"><svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><rect x="2.5" y="4" width="15" height="12" rx="3"/><path d="m4 6 6 4.5L16 6"/></svg><input id="email" name="email" type="email" autocomplete="username" required></div></div>
      <div class="field"><label for="password">Password</label><div class="login-input"><svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><rect x="3" y="8" width="14" height="10" rx="2.5"/><path d="M6 8V6a4 4 0 0 1 8 0v2m-4 4v2"/></svg><input id="password" name="password" type="password" autocomplete="current-password" required><button class="login-password-toggle" type="button" aria-label="Show password" aria-pressed="false"><svg class="login-eye-open" viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M2 10s2.8-5 8-5 8 5 8 5-2.8 5-8 5-8-5-8-5Z"/><circle cx="10" cy="10" r="2.2"/></svg><svg class="login-eye-closed" viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="m3 3 14 14M8.6 5.2A8 8 0 0 1 10 5c5.2 0 8 5 8 5a12 12 0 0 1-2.3 2.8M5.1 5.8C3.1 7.2 2 10 2 10s2.8 5 8 5c.8 0 1.6-.1 2.3-.4"/><path d="M8.6 8.6a2 2 0 0 0 2.8 2.8"/></svg></button></div></div>
      <div class="form-error" id="login-error" role="alert"></div>
      <button class="button button-primary button-lg login-submit" type="submit"><span>${superMode ? 'Enter platform' : 'Open shop dashboard'}</span><svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M4 10h11m-4-4 4 4-4 4"/></svg></button>
    </form>
    <p class="login-switch">${superMode ? 'Running a shop?' : 'Platform owner?'} <a class="text-button" id="switch-login" href="${superMode ? '/admin' : '/'}">${superMode ? 'Shop admin sign in' : 'Super Admin sign in'}</a></p>
  </div></section>`;
  const loginForm = document.querySelector('#login-form');
  const password = loginForm.querySelector('#password');
  const passwordToggle = loginForm.querySelector('.login-password-toggle');
  passwordToggle.addEventListener('click', () => {
    const showing = password.type === 'password';
    password.type = showing ? 'text' : 'password';
    passwordToggle.setAttribute('aria-pressed', String(showing));
    passwordToggle.setAttribute('aria-label', showing ? 'Hide password' : 'Show password');
  });
  loginForm.onsubmit = async e => { e.preventDefault(); const data = Object.fromEntries(new FormData(e.currentTarget)); const button = e.currentTarget.querySelector('[type="submit"]'); const label = button.innerHTML; button.disabled = true; button.innerHTML = '<span class="spinner" aria-hidden="true"></span> Signing in'; try { const res = await api(superMode ? '/auth/super/login' : '/auth/shop/login', jsonBody(data)); session = res.user; logoutButton.classList.remove('hidden'); button.innerHTML = '<span class="spinner" aria-hidden="true"></span> Opening workspace'; if (session.role === 'super_admin') renderSuper(); else renderShopAdmin(); } catch (err) { document.querySelector('#login-error').textContent = err.message; button.innerHTML = label; button.disabled = false; } };
}







async function copyText(value) { try { await navigator.clipboard.writeText(value); toast('Copied to clipboard.'); } catch { toast(value); } }
function errorPanel(title, message) { return `<section class="login-wrap"><div class="login-card"><h1>${esc(title)}</h1><p class="lede">${esc(message)}</p><button class="button button-light" type="button" data-reload>Try again</button></div></section>`; }

start();
