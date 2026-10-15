/* Print Wallah — Shop Admin + Super Admin UI.
   Loaded before app.js. It only defines functions and registers delegated listeners at load time;
   everything else (api, esc, money, toast, session, shop, app, modal ...) comes from app.js and is used at call time. */

/* ---------- small helpers ---------- */
function when(v) { if (!v) return '—'; const s = (Date.now() - new Date(v)) / 1000; if (s < 45) return 'just now'; if (s < 3600) return `${Math.max(1, Math.round(s / 60))} min ago`; if (s < 86400) return `${Math.round(s / 3600)} h ago`; return dateTime(v); }
function skeleton(rows = 4) { return `<div class="a-skel" aria-hidden="true">${Array.from({ length: rows }, () => '<div class="skeleton"></div>').join('')}</div><span class="sr-only">Loading</span>`; }
function emptyState(ic, title, text = '') { return `<div class="empty">${icon(ic, 28)}<strong>${esc(title)}</strong>${text ? `<p>${esc(text)}</p>` : ''}</div>`; }
function printerState(s) { const seen = s?.agentLastSeen ? new Date(s.agentLastSeen) : null; const online = Boolean(seen && Date.now() - seen < 90000); return { online, known: Boolean(seen), label: online ? 'Printer online' : seen ? 'Printer offline' : 'Printer not connected', detail: seen ? `${s.agentName ? `${s.agentName} · ` : ''}last seen ${when(s.agentLastSeen)}` : 'Install the print agent on the shop computer' }; }
/* ---------- shared shell ---------- */
const SHOP_TABS = [['overview', 'Overview', 'home'], ['orders', 'Orders', 'orders'], ['analytics', 'Reports', 'chart'], ['settings', 'Settings', 'settings']];
const SUPER_TABS = [['shops', 'Shops', 'shops'], ['reports', 'Reports', 'chart']];
function shellHtml({ kind, tabs, title, sub, side }) {
  const head = `<header class="a-head"><div class="a-head-text"><div class="a-ident"><strong>${esc(side.name)}</strong><span class="a-sub">${esc(side.sub || '')}</span></div><h1 id="a-title">${esc(title)}</h1><p id="a-sub">${esc(sub || '')}</p></div><div class="a-head-tools" id="a-head-tools"></div>${kind === 'shop' ? `<div class="a-head-mobile">${side.portal ? `<a class="close-button" href="${esc(side.portal)}" target="_blank" rel="noopener" aria-label="Customer portal">${icon('external', 20)}</a>` : ''}<button type="button" class="close-button" data-logout aria-label="Sign out">${icon('logout', 20)}</button></div>` : ''}</header>`;
  if (kind === 'super') {
    const top = tabs.map(([id, label, ic]) => `<button type="button" class="a-nav" data-tab="${id}">${icon(ic, 18)}<span>${label}</span></button>`).join('');
    return `<div class="a-shell" data-kind="super">
    <header class="a-topbar"><a class="a-brand" href="/" aria-label="Print Wallah"><img class="b-mark" src="/assets/pw-mark-96.png" width="30" height="30" alt=""><img class="b-word" src="/assets/pw-wordmark-320.png" width="136" height="19" alt=""></a><nav class="a-toptabs" aria-label="Sections">${top}</nav><button type="button" class="button button-quiet button-small a-signout" data-logout aria-label="Sign out">${icon('logout', 16)}<span>Sign out</span></button></header>
    <div class="a-main">${head}<div class="a-content" id="admin-content"></div></div>
  </div>`;
  }
  const nav = tabs.map(([id, label, ic]) => `<button type="button" class="a-nav" data-tab="${id}">${icon(ic, 22)}<span>${label}</span></button>`).join('');
  const tabbar = tabs.map(([id, label, ic]) => `<button type="button" class="a-tab" data-tab="${id}">${icon(ic, 22)}<span>${label}</span></button>`).join('');
  return `<div class="a-shell" data-kind="shop">
    <aside class="a-rail" aria-label="Shop navigation"><a class="a-brand" href="/admin" aria-label="Print Wallah"><img src="/assets/pw-mark-96.png" width="36" height="36" alt=""></a><nav class="a-navlist" aria-label="Sections">${nav}</nav><div class="a-rail-foot">${side.links || ''}<button type="button" class="a-nav" data-logout>${icon('logout', 22)}<span>Sign out</span></button></div></aside>
    <div class="a-main">${head}<div class="a-content" id="admin-content"></div></div>
    <nav class="a-tabbar" aria-label="Sections">${tabbar}</nav>
  </div>`;
}
document.addEventListener('click', e => { if (e.target.closest('[data-logout]')) logoutButton.click(); });
function markTab(id, tabs, title, sub) {
  document.querySelectorAll('[data-tab]').forEach(b => { const on = b.dataset.tab === id; b.classList.toggle('active', on); if (on) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current'); });
  const t = tabs.find(x => x[0] === id); document.querySelector('#a-title').textContent = title || t?.[1] || ''; document.querySelector('#a-sub').textContent = sub || '';
}

/* ---------- order model helpers ---------- */
let adminOrders = [], adminQueue = [], adminFilter = 'all', adminQuery = '', adminDirty = false, superTab = 'shops';
let queueReorderBusy = false, activeQueueDrag = null;
const orderBusy = new Set();
const STAGE = {
  cash_confirmation_pending: ['Confirm cash', 'attn'], pending_payment: ['Awaiting payment', 'wait'], payment_review: ['Verify payment', 'attn'],
  print_queued: ['In queue', 'info'], printing: ['Printing', 'info'], completed: ['Completed', 'ok'], failed: ['Failed', 'bad'], cancelled: ['Cancelled', 'muted'],
};
function stageOf(status) { return STAGE[status] || [String(status || 'unknown').replaceAll('_', ' '), 'muted']; }
function stageBadge(status) { const [label, tone] = stageOf(status); return `<span class="stage ${tone}"><i></i>${esc(label)}</span>`; }
function orderGroup(o) { const s = o.order_status; if (s === 'cash_confirmation_pending' || s === 'payment_review' || (s === 'failed' && o.payment_status === 'verified')) return 'action'; if (s === 'pending_payment') return 'awaiting'; if (s === 'print_queued' || s === 'printing') return 'queue'; if (s === 'completed') return 'done'; return 'issues'; }
const ORDER_GROUPS = [['all', 'All'], ['action', 'Needs action'], ['awaiting', 'Awaiting payment'], ['queue', 'In queue'], ['done', 'Completed'], ['issues', 'Issues']];
function orderName(o) { return o.original_name || o.config?.fileName || 'Document'; }
function orderSuffix(o) { return String(o.order_code || '').split('-').pop(); }
function cfgSummary(o) { const c = o.config || {}; if (c.mode === 'photo') return `Photo sheet · ${c.paperSize || 'A4'} · ${c.photoQuantity || 0} photos`; return `${c.color ? 'Colour' : 'B&W'} · ${c.paperSize || 'A4'}${c.paperType && c.paperType !== 'normal' ? ` ${c.paperType}` : ''} · ${c.duplex ? 'Double-sided' : 'Single-sided'}`; }
function qtyText(o) { return o.config?.mode === 'photo' ? `${o.page_count} sheet${o.page_count === 1 ? '' : 's'} × ${o.copies}` : `${o.page_count} pg × ${o.copies}`; }
function payLine(o) {
  if (o.payment_method === 'upi') { if (o.payment_status === 'verified') return 'UPI · verified'; if (o.order_status === 'cancelled') return 'UPI · cancelled'; if (o.order_status === 'pending_payment') return 'UPI · customer has not confirmed yet'; return o.payment_reference ? `UPI · customer says paid · ref ${o.payment_reference}` : 'UPI · customer says paid · no reference'; }
  return `Cash · ${o.payment_status === 'verified' ? 'received' : o.order_status === 'cancelled' ? 'cancelled' : 'not received yet'}`;
}
function actionBtn(action, label, tone = 'light', cls = 'button-small') { return `<button type="button" class="button button-${tone} ${cls}" data-action="${action}">${label}</button>`; }
function primaryAction(o, cls) {
  const s = o.order_status;
  if (s === 'cash_confirmation_pending') return actionBtn('cash-confirm', 'Confirm cash', 'primary', cls);
  if (s === 'payment_review' || s === 'pending_payment') return actionBtn('payment-verify', 'Payment received', 'primary', cls);
  if (s === 'failed' && o.payment_status === 'verified') return actionBtn('retry-print', 'Retry print', 'primary', cls);
  if (s === 'printing') return actionBtn('complete', 'Mark complete', 'light', cls);
  return '';
}
function secondaryActions(o, cls) {
  const s = o.order_status;
  if (s === 'cash_confirmation_pending' || s === 'print_queued') return actionBtn('cancel', 'Cancel order', 'danger', cls);
  if (s === 'payment_review') return actionBtn('payment-fail', 'Not received', 'danger', cls);
  if (s === 'pending_payment') return actionBtn('payment-fail', 'Cancel order', 'danger', cls);
  if (s === 'printing') return actionBtn('print-failed', 'Mark failed', 'danger', cls);
  return '';
}
function orderCard(o, reorderable = false) {
  const [, tone] = stageOf(o.order_status), name = orderName(o), act = primaryAction(o, 'button-small'), pay = payLine(o);
  const search = `${o.order_code} ${name} ${o.customer_name || ''} ${o.customer_phone || ''}`.toLowerCase();
  return `<article class="a-order tone-${tone}${reorderable ? ' is-reorderable' : ''}" data-order="${esc(o.id)}" data-group="${orderGroup(o)}" data-search="${esc(search)}"${reorderable ? ' data-reorderable="true"' : ''}>
    ${reorderable ? `<button type="button" class="queue-drag-handle" aria-label="Reorder ${esc(name)}" aria-keyshortcuts="ArrowUp ArrowDown">${icon('grip', 18)}</button>` : ''}
    <button type="button" class="a-order-main" data-open="${esc(o.id)}" aria-label="Open details for ${esc(name)}"><span class="a-file">${esc(name)}</span><span class="a-order-sub o-cfg">${esc(cfgSummary(o))} · ${esc(qtyText(o))}</span></button>
    <div class="a-order-who o-meta"><span class="o-cust${o.customer_name ? '' : ' dim'}">${o.customer_name ? esc(o.customer_name) : 'Customer'}</span><span class="o-sub"><span class="o-time">${esc(when(o.created_at))}</span><span class="o-code mono">${esc(orderSuffix(o))}</span></span></div>
    <span class="a-amt">${money(o.amount)}</span>
    <div class="a-order-state">${stageBadge(o.order_status)}<span class="a-pay" title="${esc(pay)}">${esc(pay)}</span></div>
    <div class="a-order-actions">${act || (o.order_status === 'print_queued' ? '<span class="a-sub o-wait">Waiting for printer</span>' : '')}</div>
    ${o.print_error && o.order_status === 'failed' ? `<div class="a-err">${icon('alert', 16)}<span>${esc(o.print_error)}</span></div>` : ''}
  </article>`;
}
function orderList(rows, emptyTitle = 'No orders yet', emptyText = 'Orders appear here as customers send them.', reorderable = false) {
  return rows.length ? `<div class="a-orders${reorderable ? ' is-print-queue' : ''}"${reorderable ? ' data-print-queue-list="true"' : ''}>${rows.map((row) => orderCard(row, reorderable)).join('')}</div>` : emptyState('inbox', emptyTitle, emptyText);
}
function ordersSignature(rows) { return rows.map(o => `${o.id}:${o.updated_at}:${o.order_status}:${o.payment_status}:${o.print_status}:${o.print_queue_position || ''}:${o.print_error || ''}`).join('|'); }

/* ---------- order drawer ---------- */
function kv(label, value) { return value === undefined || value === null || value === '' ? '' : `<div class="dkv"><dt>${esc(label)}</dt><dd>${value}</dd></div>`; }
function openOrder(id) {
  const o = [...adminOrders, ...adminQueue].find(x => String(x.id) === String(id)); if (!o) return;
  const c = o.config || {}, files = Array.isArray(c.documentFiles) && c.documentFiles.length > 1 ? c.documentFiles : null;
  const scaling = { fit: 'Fit to page', fill: 'Fill page', actual: 'Actual size' }[c.scaling] || c.scaling;
  const pr = c.priceBreakdown;
  const setup = c.mode === 'photo'
    ? [kv('Type', 'Photo sheet'), kv('Paper', `${esc(c.paperSize || 'A4')} · ${esc(c.paperType || 'normal')}`), kv('Photos', `${esc(c.photoQuantity ?? '')} (${esc(c.photoSize || '')})`), kv('Sheets', esc(o.page_count)), kv('Copies', esc(o.copies))]
    : [kv('Type', 'Documents / pictures'), kv('Colour', c.color ? 'Colour' : 'Black & white'), kv('Paper', `${esc(c.paperSize || 'A4')} · ${esc(c.paperType || 'normal')}`), kv('Sides', c.duplex ? 'Double-sided' : 'Single-sided'), kv('Orientation', esc(c.orientation || 'portrait')), kv('Pages', c.pageRange && c.pageRange !== 'all' ? esc(c.pageRange) : 'All'), kv('Pages to print', esc(o.page_count)), kv('Copies', esc(o.copies)), kv('Scaling', esc(scaling))];
  const times = [kv('Placed', esc(dateTime(o.created_at))), kv('Customer marked paid', o.payment_claimed_at ? esc(dateTime(o.payment_claimed_at)) : ''), kv('Payment confirmed', o.confirmed_at ? esc(dateTime(o.confirmed_at)) : ''), kv('Completed', o.completed_at ? esc(dateTime(o.completed_at)) : ''), kv('Print file removed', o.files_deleted_at ? esc(dateTime(o.files_deleted_at)) : '')];
  const sec = secondaryActions(o, ''), prim = primaryAction(o, '');
  showDrawer(`<div class="dr" data-order="${esc(o.id)}">
    <header class="dr-head"><div class="dr-id"><div class="dr-kicker"><span>Order</span><button type="button" class="code-copy mono" data-copy="${esc(o.order_code)}" aria-label="Copy order code">${esc(o.order_code)} ${icon('copy', 14)}</button></div><h2 class="dr-title">${esc(files ? `${files.length} files` : orderName(o))}</h2></div><button type="button" class="close-button" data-close-modal aria-label="Close">${icon('close', 20)}</button></header>
    <div class="dr-body">
      <div class="dr-hero"><div class="dr-hero-state">${stageBadge(o.order_status)}<div class="a-sub">${esc(payLine(o))}</div></div><div class="dr-amount">${money(o.amount)}</div></div>
      ${o.print_error ? `<div class="a-err">${icon('alert', 16)}<span>${esc(o.print_error)}${o.print_attempts ? ` · ${esc(o.print_attempts)} attempt${Number(o.print_attempts) === 1 ? '' : 's'}` : ''}</span></div>` : ''}
      ${files ? `<section class="dr-sec"><h3>Files</h3><ul class="dr-files">${files.map(f => `<li>${icon('file', 16)}<span>${esc(f)}</span></li>`).join('')}</ul></section>` : ''}
      <section class="dr-sec"><h3>Print setup</h3><dl class="dkv-list">${setup.join('')}${pr && Number.isFinite(Number(pr.rate)) ? kv('Rate', `${esc(money(pr.rate))} per sheet`) : ''}</dl></section>
      ${o.customer_name || o.customer_phone ? `<section class="dr-sec"><h3>Customer</h3><dl class="dkv-list">${kv('Name', esc(o.customer_name || ''))}${kv('Phone', o.customer_phone ? `<a class="text-button" href="tel:${esc(String(o.customer_phone).replace(/[^\d+]/g, ''))}">${esc(o.customer_phone)}</a>` : '')}</dl></section>` : ''}
      <section class="dr-sec"><h3>Timeline</h3><dl class="dkv-list">${times.join('')}${kv('Print status', esc(o.print_status))}</dl></section>
    </div>
    <footer class="dr-actions">${prim}${sec}<a class="button button-light" href="/api/admin/uploads/${esc(o.id)}" target="_blank" rel="noopener">${icon('file', 18)} Open file</a>${actionBtn('delete', 'Delete order', 'danger', 'button-small')}</footer>
  </div>`);
}
document.addEventListener('click', e => {
  const open = e.target.closest('[data-open]'); if (open) { openOrder(open.dataset.open); return; }
  const copy = e.target.closest('[data-copy]'); if (copy) { copyText(copy.dataset.copy); return; }
  const btn = e.target.closest('[data-order] [data-action]'); if (btn) runOrderAction(btn.closest('[data-order]').dataset.order, btn.dataset.action, btn);
});
const ORDER_ASK = {
  'cash-confirm': { title: 'Confirm cash received?', message: 'Only confirm once you have the cash. The order is queued for printing right away.', confirmLabel: 'Cash received' },
  'payment-verify': { title: 'Payment received?', message: 'Confirm only if the exact amount reached this shop’s UPI account. The order code is in the payment note. The job is queued for printing right away.', confirmLabel: 'Yes, payment received' },
  'payment-fail': { title: 'Mark payment as not received?', message: 'The order will not be printed. Use this if the money has not arrived.', confirmLabel: 'Not received', tone: 'danger' },
  cancel: { title: 'Cancel this order?', message: 'It will not be printed. Refund any payment yourself.', confirmLabel: 'Cancel order', cancelLabel: 'Keep order', tone: 'danger' },
  delete: { title: 'Delete this order permanently?', message: 'The order and its files will be removed from this shop. This cannot be undone and will not issue a refund.', confirmLabel: 'Delete order', cancelLabel: 'Keep order', tone: 'danger' },
};
async function runOrderAction(id, action, btn) {
  if (orderBusy.has(id)) return;
  const ask = ORDER_ASK[action]; if (ask && !(await confirmDialog(ask))) return;
  if (orderBusy.has(id)) return;
  orderBusy.add(id);
  const scope = [...document.querySelectorAll(`[data-order="${CSS.escape(String(id))}"] [data-action]`)];
  const label = btn.innerHTML; scope.forEach(b => { b.disabled = true; }); btn.setAttribute('aria-busy', 'true'); btn.innerHTML = '<span class="spinner" aria-hidden="true"></span> Updating';
  try {
    const routeName = action === 'payment-fail' ? 'payment-verify' : action;
    const result = action === 'delete'
      ? await api(`/admin/orders/${encodeURIComponent(id)}`, { method: 'DELETE' })
      : await api(`/admin/orders/${encodeURIComponent(id)}/${routeName}`, jsonBody(action === 'payment-verify' || action === 'payment-fail' ? { verified: action === 'payment-verify' } : {}));
    if (action === 'delete') toast(result.filesCleanupWarning ? 'Order deleted, but some files could not be removed.' : 'Order deleted. No refund was issued.', result.filesCleanupWarning ? 'error' : 'success');
    else toast(action === 'payment-verify' ? 'Payment verified and job queued.' : action === 'cash-confirm' ? 'Cash confirmed and job queued.' : 'Order updated.');
    if (modal.open) closeModal();
    await renderAdminTab({ silent: true });
  } catch (e) { toast(e.message); scope.forEach(b => { b.disabled = false; }); btn.removeAttribute('aria-busy'); btn.innerHTML = label; }
  finally { orderBusy.delete(id); }
}

/* ---------- stat cards ---------- */
function statCard(label, value, foot, tone = '') { return `<div class="metric ${tone}"><span class="metric-label">${esc(label)}</span><strong class="metric-value">${esc(value ?? '0')}</strong><span class="metric-foot">${esc(foot || '')}</span></div>`; }
/* ---------- Shop Admin ---------- */
async function renderShopAdmin() {
  const started = performance.now(); setShellMode(true); setHeading(''); app.innerHTML = `<div class="a-boot">${skeleton(3)}</div>`;
  try {
    const data = await api('/admin/overview'); shop = (await api('/admin/me')).shop; await holdLoadingState(started);
    const hash = location.hash.slice(1); adminTab = SHOP_TABS.some(t => t[0] === hash) ? hash : 'overview'; adminOrders = data.recent || []; adminOrdersSignature = ordersSignature(adminOrders);
    app.innerHTML = shellHtml({ kind: 'shop', tabs: SHOP_TABS, title: 'Overview', side: { name: shop.name, sub: shop.city || '', portal: `/shop/${encodeURIComponent(shop.id)}`, links: `<a class="a-nav" href="/shop/${encodeURIComponent(shop.id)}" target="_blank" rel="noopener">${icon('external', 22)}<span>Portal</span></a>` } });
    document.querySelectorAll('[data-tab]').forEach(b => b.onclick = async () => { if (b.dataset.tab === adminTab) return; if (adminDirty && !(await confirmDialog({ title: 'Discard unsaved changes?', message: 'Your edits to shop settings have not been saved.', confirmLabel: 'Discard', cancelLabel: 'Keep editing', tone: 'danger' }))) return; adminDirty = false; adminTab = b.dataset.tab; history.replaceState(null, '', `#${adminTab}`); renderAdminTab(); });
    renderAdminTab(); clearInterval(adminTimer); adminTimer = setInterval(softRefreshAdmin, 5000);
  } catch (e) { if (e.status === 401) { session = null; logoutButton.classList.add('hidden'); renderLogin('shop'); } else { setShellMode(false); app.innerHTML = errorPanel('Shop workspace unavailable', e.message); } }
}
function headTools() {
  const p = printerState(shop);
  document.querySelector('#a-head-tools').innerHTML = `${statePill(shop.status)}<span class="pill ${p.online ? 'online' : p.known ? 'offline' : ''}" title="${esc(p.detail)}">${esc(p.label)}</span>`;
}
async function renderAdminTab({ silent = false } = {}) {
  const target = document.querySelector('#admin-content'); if (!target) return;
  const subs = { overview: 'What needs attention right now.', orders: 'Confirm payments and manage the print queue.', analytics: 'Orders, pages and revenue over time.', settings: 'Shop details, payments, print options and prices.' };
  markTab(adminTab, SHOP_TABS, adminTab === 'overview' ? 'Overview' : undefined, subs[adminTab]); headTools();
  const tab = adminTab; if (!silent) target.innerHTML = skeleton(tab === 'settings' ? 3 : 4);
  try {
    if (tab === 'overview') await renderOverview(target, silent);
    else if (tab === 'orders') await renderOrdersTab(target, silent);
    else if (tab === 'analytics') renderShopReports(target);
    else renderSettingsTab(target);
    if (!silent) target.querySelector(':scope > *')?.classList.add('enter');
  } catch (e) { if (adminTab === tab) target.innerHTML = `<div class="inline-notice">${esc(e.message)} <button type="button" class="text-button" data-reload>Try again</button></div>`; }
}
async function renderOverview(target, silent) {
  const [data, rows, queue] = await Promise.all([api('/admin/overview'), api('/admin/orders'), api('/admin/print-queue')]); if (adminTab !== 'overview') return;
  adminOrders = rows; adminQueue = queue; adminOrdersSignature = ordersSignature(rows);
  const attention = rows.filter(o => orderGroup(o) === 'action'), s = data.stats, p = printerState(shop);
  const queued = queue.length, n = attention.length;
  const html = `<div class="a-overview">
    <div class="a-col">
      <section class="a-panel o-attn ${n ? 'is-attn' : ''}"><header class="a-panel-head"><div><h2>${n ? `${n} order${n === 1 ? '' : 's'} need${n === 1 ? 's' : ''} your action` : 'Nothing needs your action'}</h2><p>${n ? 'Confirm payments or retry failed prints.' : 'New payments and failed prints will show up here.'}</p></div>${n > 4 ? '<button type="button" class="button button-light button-small" data-goto="orders">See all</button>' : ''}</header>${n ? `<div class="a-orders">${attention.slice(0, 4).map(o => orderCard(o)).join('')}</div>` : `<div class="a-allclear">${icon('check', 18)}<span>All caught up</span></div>`}</section>
      <section class="a-panel o-queue"><header class="a-panel-head"><div><h2>Print queue</h2><p><span id="overview-queue-count">${queue.length} job${queue.length === 1 ? '' : 's'}</span>${queue.length > 1 ? ' · drag the handle to reorder' : ''}</p></div><button type="button" class="button button-light button-small" data-goto="orders" data-queue-tab>Open queue</button></header>${orderList(queue, 'Queue is empty', '', true)}</section>
    </div>
    <div class="a-col">
      <section class="a-panel o-today"><header class="a-panel-head"><div><h2>Today</h2></div></header><div class="metrics is-stack">${statCard('Orders today', s.today_orders, 'New work received')}${statCard('Pages today', s.today_pages, 'Billable printed pages')}${statCard('Earnings today', money(s.today_earnings), 'Confirmed orders')}${statCard('In queue', queued, Number(s.awaiting_payment) ? `${s.awaiting_payment} awaiting customer payment` : 'Waiting for the printer')}</div></section>
      <section class="a-panel o-printer"><header class="a-panel-head"><div><h2>Printer</h2><p>${esc(p.detail)}</p></div><span class="pill ${p.online ? 'online' : p.known ? 'offline' : ''}">${p.online ? 'Online' : p.known ? 'Offline' : 'Not connected'}</span></header>${p.online ? '' : `<p class="a-note">${p.known ? 'The print agent has not checked in for a while. Paid orders wait safely in the queue until it reconnects.' : 'No print agent has connected yet. See the setup guide in Settings.'}</p>`}</section>
    </div>
  </div>`;
  target.innerHTML = html; if (!silent) target.firstElementChild.classList.add('enter');
}
document.addEventListener('click', e => { const g = e.target.closest('[data-goto]'); if (g) { if (g.hasAttribute('data-queue-tab')) adminFilter = 'queue'; adminTab = g.dataset.goto; history.replaceState(null, '', `#${adminTab}`); renderAdminTab(); } });
function filterCounts(rows) { const n = { all: rows.length }; ORDER_GROUPS.slice(1).forEach(([k]) => { n[k] = 0; }); rows.forEach(o => { n[orderGroup(o)]++; }); n.queue = adminQueue.length; return n; }
function applyOrderFilter() {
  const q = adminQuery.trim().toLowerCase(), rows = adminFilter === 'queue' ? adminQueue : adminOrders; let shown = 0;
  document.querySelectorAll('#order-list [data-order]').forEach(row => { const ok = (adminFilter === 'all' || row.dataset.group === adminFilter) && (!q || row.dataset.search.includes(q)); row.classList.toggle('hidden', !ok); if (ok) shown++; });
  const none = document.querySelector('#order-none'); if (none) none.classList.toggle('hidden', shown > 0 || !rows.length);
  const count = document.querySelector('#order-count'); if (count) count.textContent = `${shown} of ${rows.length} order${rows.length === 1 ? '' : 's'}`;
}
function chipsHtml(rows) { const n = filterCounts(rows); return ORDER_GROUPS.map(([k, label]) => `<button type="button" class="fchip ${adminFilter === k ? 'active' : ''} ${k === 'action' && n[k] ? 'attn' : ''}" data-filter="${k}" aria-pressed="${adminFilter === k}">${label}<b>${n[k]}</b></button>`).join(''); }
async function renderOrdersTab(target, silent) {
  const [rows, queue] = await Promise.all([api('/admin/orders'), api('/admin/print-queue')]); if (adminTab !== 'orders') return;
  adminOrders = rows; adminQueue = queue; adminOrdersSignature = ordersSignature(rows);
  target.innerHTML = `<div class="a-panel a-flush"><div class="a-toolbar"><label class="search-box">${icon('search', 18)}<input id="order-search" type="search" placeholder="Search order, file or customer" aria-label="Search orders" value="${esc(adminQuery)}" autocomplete="off"></label><div class="a-toolbar-meta"><span id="order-count"></span><span class="a-sub">Updates automatically</span></div></div><div class="chips" id="order-chips" role="group" aria-label="Filter orders">${chipsHtml(rows)}</div><div id="order-list">${orderList(adminFilter === 'queue' ? queue : rows, 'Queue is empty', '', adminFilter === 'queue')}</div><div id="order-none" class="hidden">${emptyState('search', 'No orders match', 'Try a different search or filter.')}</div></div>`;
  document.querySelector('#order-search').oninput = e => { adminQuery = e.target.value; applyOrderFilter(); };
  document.querySelector('#order-chips').onclick = e => { const c = e.target.closest('[data-filter]'); if (!c) return; adminFilter = c.dataset.filter; document.querySelectorAll('#order-chips .fchip').forEach(x => { const on = x.dataset.filter === adminFilter; x.classList.toggle('active', on); x.setAttribute('aria-pressed', on); }); renderOrderList(); applyOrderFilter(); };
  applyOrderFilter();
}
function renderOrderList() {
  const list = document.querySelector('#order-list'); if (!list) return;
  list.innerHTML = orderList(adminFilter === 'queue' ? adminQueue : adminOrders, 'Queue is empty', '', adminFilter === 'queue');
}
function queueIdsInList(list = document.querySelector('#order-list [data-print-queue-list="true"]')) {
  return list ? [...list.querySelectorAll('[data-reorderable="true"]')].map((row) => row.dataset.order) : [];
}
async function persistQueueOrder(orderIds) {
  if (queueReorderBusy || orderIds.length !== adminQueue.length || orderIds.every((id, i) => id === adminQueue[i]?.id)) return;
  queueReorderBusy = true;
  try {
    await api('/admin/print-queue', { ...jsonBody({ orderIds }), method: 'PATCH' });
    adminQueue = await api('/admin/print-queue');
    adminOrdersSignature = '';
    renderQueueLists();
  } catch (error) {
    toast(error.message);
    try { adminQueue = await api('/admin/print-queue'); renderQueueLists(); }
    catch (refreshError) { toast(refreshError.message); }
  } finally {
    queueReorderBusy = false;
  }
}
function renderQueueLists() {
  document.querySelectorAll('[data-print-queue-list="true"]').forEach((list) => {
    list.innerHTML = adminQueue.map((order) => orderCard(order, true)).join('');
  });
  const overviewCount = document.querySelector('#overview-queue-count');
  if (overviewCount) overviewCount.textContent = `${adminQueue.length} job${adminQueue.length === 1 ? '' : 's'}`;
  if (adminTab === 'orders' && adminFilter === 'queue') applyOrderFilter();
}
document.addEventListener('pointerdown', (event) => {
  const handle = event.target.closest('.queue-drag-handle');
  if (!handle || event.button !== 0 || queueReorderBusy) return;
  const card = handle.closest('.a-order[data-reorderable="true"]');
  const list = card?.closest('[data-print-queue-list="true"]');
  if (!card || !list) return;
  activeQueueDrag = { card, list, pointerId: event.pointerId, startY: event.clientY, moved: false };
  card.classList.add('is-dragging');
  list.setPointerCapture(event.pointerId);
  event.preventDefault();
});
window.addEventListener('pointermove', (event) => {
  const drag = activeQueueDrag;
  if (!drag || drag.pointerId !== event.pointerId) return;
  event.preventDefault();
  const element = document.elementFromPoint(event.clientX, event.clientY);
  const target = element?.closest('.a-order[data-reorderable="true"]');
  if (target && target !== drag.card && target.closest('[data-print-queue-list="true"]') === drag.list) {
    const rect = target.getBoundingClientRect();
    const before = event.clientY < rect.top + rect.height / 2;
    if (before && target.previousElementSibling !== drag.card || !before && target.nextElementSibling !== drag.card) {
      drag.list.insertBefore(drag.card, before ? target : target.nextElementSibling);
      drag.moved = true;
    }
    return;
  }
  if (element?.closest('[data-print-queue-list="true"]') !== drag.list) return;
  const cards = [...drag.list.querySelectorAll('.a-order[data-reorderable="true"]')].filter((card) => card !== drag.card);
  if (!cards.length) return;
  const first = cards[0], last = cards[cards.length - 1];
  if (event.clientY < first.getBoundingClientRect().top && first.previousElementSibling !== drag.card) {
    drag.list.insertBefore(drag.card, first);
    drag.moved = true;
  } else if (event.clientY > last.getBoundingClientRect().bottom && last.nextElementSibling !== drag.card) {
    drag.list.append(drag.card);
    drag.moved = true;
  }
});
window.addEventListener('pointerup', (event) => {
  const drag = activeQueueDrag;
  if (!drag || drag.pointerId !== event.pointerId) return;
  drag.card.classList.remove('is-dragging');
  if (drag.list.hasPointerCapture(event.pointerId)) drag.list.releasePointerCapture(event.pointerId);
  activeQueueDrag = null;
  if (drag.moved) persistQueueOrder(queueIdsInList(drag.list));
});
window.addEventListener('pointercancel', (event) => {
  if (!activeQueueDrag || activeQueueDrag.pointerId !== event.pointerId) return;
  activeQueueDrag.card.classList.remove('is-dragging');
  activeQueueDrag = null;
  renderQueueLists();
});
document.addEventListener('keydown', (event) => {
  const handle = event.target.closest?.('.queue-drag-handle');
  if (!handle || !['ArrowUp', 'ArrowDown'].includes(event.key)) return;
  const card = handle.closest('.a-order[data-reorderable="true"]');
  const list = card?.closest('[data-print-queue-list="true"]');
  if (!card || !list) return;
  const sibling = event.key === 'ArrowUp' ? card.previousElementSibling : card.nextElementSibling;
  if (!sibling || queueReorderBusy) return;
  event.preventDefault();
  if (event.key === 'ArrowUp') card.parentElement.insertBefore(card, sibling);
  else card.parentElement.insertBefore(sibling, card);
  persistQueueOrder(queueIdsInList(list));
});
async function softRefreshAdmin() {
  if (adminRefreshBusy || queueReorderBusy || activeQueueDrag || document.visibilityState !== 'visible' || modal.open || orderBusy.size || !['overview', 'orders'].includes(adminTab)) return;
  const active = document.activeElement; if (active && ['SELECT', 'TEXTAREA'].includes(active.tagName)) return;
  adminRefreshBusy = true;
  try {
    const [rows, queue] = await Promise.all([api('/admin/orders'), api('/admin/print-queue')]);
    if (ordersSignature(rows) === adminOrdersSignature && queue.map((o) => `${o.id}:${o.print_queue_position}`).join('|') === adminQueue.map((o) => `${o.id}:${o.print_queue_position}`).join('|')) return;
    adminOrders = rows; adminOrdersSignature = ordersSignature(rows);
    adminQueue = queue;
    if (adminTab === 'orders') { const list = document.querySelector('#order-list'); if (!list) return; renderOrderList(); document.querySelector('#order-chips').innerHTML = chipsHtml(rows); applyOrderFilter(); }
    else if (adminTab === 'overview') { shop = (await api('/admin/me')).shop; await renderAdminTab({ silent: true }); }
  } catch { } finally { adminRefreshBusy = false; }
}
function renderShopReports(target) {
  target.innerHTML = `<div class="a-panel"><header class="a-panel-head"><div><h2>Print activity</h2><p>Daily or monthly totals · India time</p></div><button class="button button-light button-small" id="analytics-csv" type="button" disabled>${icon('download', 16)} Export CSV</button></header><div class="a-filters"><div class="field"><label for="analytics-from">From</label><input id="analytics-from" type="date"></div><div class="field"><label for="analytics-to">To</label><input id="analytics-to" type="date"></div><div class="field"><label for="analytics-group">Group by</label><select id="analytics-group"><option value="day">Daily</option><option value="month">Monthly</option></select></div><button class="button button-primary" id="analytics-load" type="button">Load report</button></div><div id="analytics-results"><div class="empty"><p>Choose a date range and load the report.</p></div></div></div>`;
  const to = indiaDateString(); document.querySelector('#analytics-from').value = shiftReportDate(to, -29); document.querySelector('#analytics-to').value = to; document.querySelector('#analytics-load').onclick = loadAnalytics; loadAnalytics();
}
/* ---------- Shop settings ---------- */
function shopSettingsForm(s) {
  const field = (label, name, value, extra = '') => `<div class="field"><label for="f-${name}">${label}</label><input id="f-${name}" name="${name}" value="${esc(value ?? '')}" ${extra}></div>`;
  const price = Object.entries({ bw_a4: 'B&W · A4', color_a4: 'Colour · A4', bw_a3: 'B&W · A3', color_a3: 'Colour · A3', glossy_a4: 'Glossy · A4', photo_sheet: 'Photo sheet' }).map(([k, l]) => priceField(k, l, s.pricing[k] ?? 0)).join('') + optionalPriceField('glossy_a3', 'Glossy · A3', s.pricing.glossy_a3) + optionalPriceField('photo_sheet_a3', 'Photo sheet · A3', s.pricing.photo_sheet_a3);
  const portal = `${location.origin}/shop/${encodeURIComponent(s.id)}`, pr = printerState(s);
  const section = (title, text, body) => `<section class="a-section"><div class="a-section-intro"><h2>${title}</h2><p>${text}</p></div><div class="a-section-body">${body}</div></section>`;
  return `<div class="a-settings">
  <form id="settings-form-admin" class="a-settings-main" novalidate>
    ${section('Shop information', 'Shown to customers on the portal.', `<div class="form-grid">${field('Shop name', 'name', s.name, 'required')}${field('Owner name', 'ownerName', s.ownerName, 'required')}${field('Shop phone', 'phone', s.phone, 'inputmode="tel"')}${field('Shop email', 'email', s.email, 'type="email"')}${field('City', 'city', s.city)}${field('Shop address', 'address', s.address)}</div>`)}
    ${section('Payments', 'Customers pay this UPI ID. Amounts and order codes are filled in automatically.', `<div class="form-grid">${field('UPI ID', 'upiId', s.upiId, 'placeholder="shop@bank" autocapitalize="none" autocomplete="off"')}${field('UPI payee name', 'upiName', s.upiName)}</div>`)}
    ${section('Print options', 'Only enabled options appear for customers.', `${printConfigFields(s.printConfig, false)}<div class="form-grid a-printer-field">${field('Printer name', 'agentName', s.agentName, 'placeholder="e.g. Canon G3010 · Counter PC"')}</div>`)}
    ${section('Price card', 'Rupees per printed sheet. Changes apply to new orders.', `<div class="form-grid price-grid">${price}</div>`)}
    <div class="form-error" id="settings-error" role="alert"></div>
    <div class="a-savebar" id="savebar"><span class="a-savebar-msg">You have unsaved changes</span><button type="button" class="button button-light button-small" id="discard-settings">Discard</button><button type="submit" class="button button-primary button-small" form="settings-form-admin" id="save-settings">Save changes</button></div>
  </form>
  <aside class="a-settings-side">
    <section class="a-panel"><header class="a-panel-head"><div><h2>Customer portal</h2><p>Your shop’s QR code opens this page.</p></div></header><div class="a-panel-body"><div class="url-box">${esc(portal)}</div><div class="a-row"><button type="button" class="button button-light button-small" data-copy="${esc(portal)}">${icon('copy', 16)} Copy link</button><a class="button button-light button-small" href="${esc(portal)}" target="_blank" rel="noopener">${icon('external', 16)} Open</a></div></div></section>
    <section class="a-panel"><header class="a-panel-head"><div><h2>Print agent</h2><p>${esc(pr.detail)}</p></div><span class="pill ${pr.online ? 'online' : pr.known ? 'offline' : ''}">${pr.online ? 'Online' : pr.known ? 'Offline' : 'Not connected'}</span></header><div class="a-panel-body"><p class="field-hint">Keep the agent token private. Rotating it disconnects the running agent until its configuration is updated.</p><div class="a-row"><button type="button" class="button button-light button-small" id="rotate-agent">Rotate agent token</button><a class="text-button" href="/docs/PRINT_AGENT.md" target="_blank" rel="noopener">Setup guide</a></div></div></section>
  </aside></div>`;
}
function renderSettingsTab(target) {
  target.innerHTML = shopSettingsForm(shop);
  const form = document.querySelector('#settings-form-admin'), bar = document.querySelector('#savebar');
  const snap = () => JSON.stringify([...new FormData(form).entries()]); let base = snap(); adminDirty = false;
  const sync = () => { adminDirty = snap() !== base; bar.classList.toggle('show', adminDirty); };
  form.addEventListener('input', sync); form.addEventListener('change', sync);
  document.querySelector('#discard-settings').onclick = () => { renderSettingsTab(target); adminDirty = false; };
  form.onsubmit = saveShopSettings; document.querySelector('#rotate-agent').onclick = rotateAgent;
}
async function saveShopSettings(e) {
  e.preventDefault(); const form = document.querySelector('#settings-form-admin'), button = document.querySelector('#save-settings'), label = button.textContent, error = document.querySelector('#settings-error');
  if (button.disabled) return;
  const b = Object.fromEntries(new FormData(form));
  b.pricing = Object.fromEntries(['bw_a4', 'color_a4', 'bw_a3', 'color_a3', 'glossy_a4', 'photo_sheet', 'glossy_a3', 'photo_sheet_a3'].filter(k => !((k === 'glossy_a3' || k === 'photo_sheet_a3') && String(b[k] ?? '') === '')).map(k => [k, Number(b[k] ?? shop.pricing[k])]));
  b.printConfig = readPrintConfig(form); error.textContent = ''; button.disabled = true; button.innerHTML = '<span class="spinner" aria-hidden="true"></span> Saving';
  try { const result = await api('/admin/settings', { method: 'PATCH', body: JSON.stringify(b) }); shop = result.shop; adminDirty = false; document.querySelector('.a-ident strong').textContent = shop.name; document.querySelector('.a-ident .a-sub').textContent = shop.city || ''; toast('Shop settings saved.'); renderAdminTab({ silent: true }); }
  catch (err) { error.textContent = err.message; button.disabled = false; button.textContent = label; error.scrollIntoView({ block: 'center', behavior: 'smooth' }); }
}
async function rotateAgent() {
  if (!(await confirmDialog({ title: 'Rotate the agent token?', message: 'The running print agent will stop connecting until its configuration is updated with the new token.', confirmLabel: 'Rotate token', tone: 'danger' }))) return;
  try { const result = await api('/admin/agent/rotate', { method: 'POST', body: '{}' }); showModal(`<div class="modal-head"><div><h2 class="modal-title">Update the shop computer now.</h2><p class="subtext">The previous token stopped working when this one was created. It is shown only once.</p></div><button class="close-button" aria-label="Close" type="button" data-close-modal>${icon('close', 20)}</button></div><div class="url-box">${esc(result.agentToken)}</div><div class="form-actions"><button class="button button-primary" id="copy-new-token">Copy token</button><button class="button button-light" type="button" data-close-modal>Done</button></div>`); document.querySelector('#copy-new-token').onclick = () => copyText(result.agentToken); } catch (e) { toast(e.message); }
}
/* ---------- Super Admin ---------- */
function daysLeft(value) { return Math.max(0, Math.ceil((new Date(value) - Date.now()) / 86400000)); }
function shopCard(s) {
  const left = daysLeft(s.accessEnd), total = Math.max(1, Math.round((new Date(s.accessEnd) - new Date(s.accessStart)) / 86400000)), pct = Math.min(100, Math.round(left / total * 100)), locked = s.status === 'locked';
  return `<article class="a-shop" data-shop="${esc(s.id)}" data-search="${esc(`${s.name} ${s.ownerName} ${s.city} ${s.id}`.toLowerCase())}">
    <div class="a-shop-id"><div class="a-shop-name">${esc(s.name)}</div><div class="a-sub">${esc(s.ownerName)} · ${esc(s.city)}</div></div>
    <div class="a-shop-access">${statePill(s.status)}<div class="a-sub">${s.status === 'active' ? `${left} day${left === 1 ? '' : 's'} left` : `Until ${date(s.accessEnd)}`}</div>${s.status === 'active' ? `<span class="meter ${left <= 7 ? 'warn' : ''}"><i style="width:${pct}%"></i></span>` : ''}</div>
    <div class="a-shop-portal"><a class="text-button" href="/shop/${encodeURIComponent(s.id)}" target="_blank" rel="noopener" data-portal-link>Open portal ${icon('external', 14)}</a><div class="a-sub mono">${esc(s.id)}</div></div>
    <div class="a-shop-actions"><button type="button" class="button button-light button-small" data-action="details">Details</button><button type="button" class="button button-light button-small" data-action="extend">Extend</button><button type="button" class="button ${locked ? 'button-primary' : 'button-danger'} button-small" data-action="lock">${locked ? 'Unlock' : 'Lock'}</button></div>
  </article>`;
}
function wireShopRows() {
  document.querySelectorAll('[data-shop]').forEach(row => row.querySelectorAll('button[data-action]').forEach(button => button.onclick = async () => {
    const id = row.dataset.shop, action = button.dataset.action;
    if (action === 'details') { const label = button.textContent; button.disabled = true; button.innerHTML = '<span class="spinner" aria-hidden="true"></span> Opening'; try { await showShopDetails(id); } finally { button.disabled = false; button.textContent = label; } return; }
    if (action === 'extend') { await extendShop(id); return; }
    if (action === 'lock') await toggleShopLock(id, button.textContent.trim() === 'Lock');
  }));
}
async function renderSuper() {
  const started = performance.now(); setShellMode(true); setHeading(''); app.innerHTML = `<div class="a-boot">${skeleton(3)}</div>`;
  try {
    const [overview, shops] = await Promise.all([api('/super/overview'), api('/super/shops')]); await holdLoadingState(started);
    const hash = location.hash.slice(1); if (SUPER_TABS.some(t => t[0] === hash)) superTab = hash;
    app.innerHTML = shellHtml({ kind: 'super', tabs: SUPER_TABS, title: 'Shops', side: { name: 'Print Wallah', sub: `${overview.shops.total} shop${overview.shops.total === 1 ? '' : 's'} on the network` } });
    const show = () => {
      markTab(superTab, SUPER_TABS, superTab === 'shops' ? 'Shops' : 'Reports', superTab === 'shops' ? 'Create shops, manage access and open each customer portal.' : 'Compare shops by orders, pages and verified revenue.');
      const target = document.querySelector('#admin-content'), tools = document.querySelector('#a-head-tools');
      if (superTab === 'shops') {
        tools.innerHTML = `<button type="button" class="button button-primary" id="add-shop">${icon('plus', 18)}<span>Add a shop</span></button>`;
        target.innerHTML = `<div class="a-stack"><section class="metrics" aria-label="Platform summary">${statCard('Total shops', overview.shops.total, 'Across the platform')}${statCard('Active', overview.shops.active, 'Ready to take orders')}${statCard('Expiring soon', overview.shops.expiring, 'Within the next 7 days', Number(overview.shops.expiring) ? 'is-warn' : '')}${statCard('Orders today', overview.orders.today, `${overview.orders.pages} pages · ${money(overview.orders.verified_revenue)} verified`)}</section>
        <section class="a-panel a-flush"><div class="a-toolbar"><label class="search-box">${icon('search', 18)}<input id="shop-search" type="search" placeholder="Search shops" aria-label="Search shops" autocomplete="off"></label><div class="a-toolbar-meta"><span>${shops.length} shop${shops.length === 1 ? '' : 's'}</span></div></div><div class="a-ledger-head" aria-hidden="true"><span>Shop</span><span>Access</span><span>Customer portal</span><span></span></div><div id="shops-rows" class="a-shops">${shops.map(shopCard).join('')}</div><div id="shops-none" class="${shops.length ? 'hidden' : ''}">${emptyState('shops', shops.length ? 'No shops match' : 'No shops yet', shops.length ? 'Try a different search.' : 'Create a shop to generate its customer portal, price card, admin login and QR code.')}</div></section></div>`;
        document.querySelector('#add-shop').onclick = () => showCreateShop();
        document.querySelector('#shop-search').oninput = e => { const q = e.target.value.trim().toLowerCase(); let n = 0; document.querySelectorAll('#shops-rows [data-shop]').forEach(row => { const ok = row.dataset.search.includes(q); row.classList.toggle('hidden', !ok); if (ok) n++; }); if (shops.length) document.querySelector('#shops-none').classList.toggle('hidden', n > 0); };
        wireShopRows();
      } else { tools.innerHTML = ''; target.innerHTML = platformAnalyticsPanel(); wirePlatformAnalytics(); }
      target.firstElementChild?.classList.add('enter');
    };
    document.querySelectorAll('[data-tab]').forEach(b => b.onclick = () => { if (b.dataset.tab === superTab) return; superTab = b.dataset.tab; history.replaceState(null, '', `#${superTab}`); show(); });
    show();
  } catch (e) { if (e.status === 401) { session = null; logoutButton.classList.add('hidden'); renderLogin('super'); } else { setShellMode(false); app.innerHTML = errorPanel('Could not load platform dashboard', e.message); } }
}
async function extendShop(id) {
  const raw = await confirmDialog({ title: 'Extend shop access', message: 'Adds days to the current access period. This also unlocks the shop if it is locked.', confirmLabel: 'Extend access', field: { label: 'Days to add', type: 'number', attrs: 'min="1" max="3650" step="1" inputmode="numeric"', value: 30 } });
  if (!raw) return; const days = Number(raw); if (!Number.isInteger(days) || days < 1 || days > 3650) { toast('Enter a duration from 1 to 3650 days.'); return; }
  try { const r = await api(`/super/shops/${encodeURIComponent(id)}/extend`, jsonBody({ days })); toast(`Access now ends ${date(r.shop.accessEnd)}.`); renderSuper(); } catch (e) { toast(e.message); }
}
async function toggleShopLock(id, locked) {
  if (!(await confirmDialog({ title: locked ? 'Lock this shop?' : 'Unlock this shop?', message: locked ? 'Customers cannot place new orders and the print agent stops receiving jobs until you unlock the shop.' : 'The shop will accept new orders again and its print agent will receive jobs.', confirmLabel: locked ? 'Lock shop' : 'Unlock shop', tone: locked ? 'danger' : 'primary' }))) return;
  try { await api(`/super/shops/${encodeURIComponent(id)}/lock`, jsonBody({ locked })); toast(locked ? 'Shop locked.' : 'Shop unlocked.'); renderSuper(); } catch (e) { toast(e.message); }
}

/* ---------- shop create / edit / details modals, reports (moved from app.js, behaviour unchanged) ---------- */
function indiaDateString(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function shiftReportDate(value, days) {
  const date = new Date(`${value}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function reportCsv(filename, headers, rows) {
  const csv = [headers, ...rows].map((row) => row.map((value) => `"${String(value ?? '').replaceAll('"', '""')}"`).join(',')).join('\r\n');
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

let platformData = null, platformSort = 'revenue', platformQuery = '', platformPreset = '30';
const PLATFORM_PRESETS = [['today', 'Today'], ['7', '7 days'], ['30', '30 days'], ['month', 'This month']];
const PLATFORM_SORTS = [['revenue', 'Most revenue'], ['orders', 'Most orders'], ['pages', 'Most pages'], ['attention', 'Needs attention'], ['name', 'Name A–Z']];
function platformAnalyticsPanel() {
  return `<div class="a-stack">
    <section class="a-panel" aria-labelledby="platform-reports-title">
      <header class="a-panel-head"><div><h2 id="platform-reports-title">Shop comparison</h2><p>Revenue counts only verified payments · India time</p></div><button class="button button-light button-small" id="platform-csv" type="button" disabled>${icon('download', 16)} Export CSV</button></header>
      <div class="rp-range"><div class="chips is-seg" id="platform-presets" role="group" aria-label="Date range">${PLATFORM_PRESETS.map(([k, l]) => `<button type="button" class="fchip ${platformPreset === k ? 'active' : ''}" data-preset="${k}" aria-pressed="${platformPreset === k}">${l}</button>`).join('')}<button type="button" class="fchip ${platformPreset === 'custom' ? 'active' : ''}" data-preset="custom" aria-pressed="${platformPreset === 'custom'}">Custom</button></div>
      <div class="rp-dates ${platformPreset === 'custom' ? 'show' : ''}" id="platform-dates"><label class="sr-only" for="platform-from">From</label><input id="platform-from" type="date"><span aria-hidden="true">to</span><label class="sr-only" for="platform-to">To</label><input id="platform-to" type="date"><label class="sr-only" for="platform-group">Group by</label><select id="platform-group"><option value="day">Daily</option><option value="month">Monthly</option></select></div></div>
    </section>
    <div id="platform-report-results"><div class="a-panel">${skeleton(3)}</div></div></div>`;
}
function applyPlatformPreset(key) {
  const to = indiaDateString(); let from = to;
  if (key === '7') from = shiftReportDate(to, -6); else if (key === '30') from = shiftReportDate(to, -29); else if (key === 'month') from = `${to.slice(0, 8)}01`;
  if (key !== 'custom') { document.querySelector('#platform-from').value = from; document.querySelector('#platform-to').value = to; document.querySelector('#platform-group').value = key === 'today' || key === '7' || key === '30' || key === 'month' ? 'day' : document.querySelector('#platform-group').value; }
}
function shopReportRow(shop, totalRevenue, maxRevenue) {
  const n = k => Number(shop[k] || 0), idle = !n('orders'), pct = maxRevenue > 0 ? Math.max(n('revenue') > 0 ? 3 : 0, Math.round(n('revenue') / maxRevenue * 100)) : 0, share = totalRevenue > 0 ? Math.round(n('revenue') / totalRevenue * 100) : 0;
  const flags = `${n('payment_pending') ? `<span class="stage attn"><i></i>${n('payment_pending')} awaiting payment</span>` : ''}${n('print_failures') ? `<span class="stage bad"><i></i>${n('print_failures')} failed print${n('print_failures') === 1 ? '' : 's'}</span>` : ''}`;
  return `<article class="rp-row ${idle ? 'idle' : ''}" data-id="${esc(shop.shop_id)}" data-search="${esc(`${shop.shop_name} ${shop.shop_id}`.toLowerCase())}">
    <button type="button" class="rp-main" aria-expanded="false" aria-label="${esc(shop.shop_name)}: show details">
      <span class="rp-name"><strong>${esc(shop.shop_name)}</strong><small class="mono">${esc(shop.shop_id)}</small></span>
      <span class="rp-rev"><b>${money(n('revenue'))}</b><span class="rp-bar" aria-hidden="true"><i style="width:${pct}%"></i></span><small>${idle ? 'No orders' : share ? `${share}% of total` : ''}</small></span>
      <span class="rp-num"><b>${n('orders')}</b><small>orders</small></span><span class="rp-num"><b>${n('pages')}</b><small>pages</small></span>
      <span class="rp-flags">${flags || '<span class="rp-ok">All clear</span>'}</span><span class="rp-chev" aria-hidden="true"></span>
    </button>
    <div class="rp-more"><div class="rp-more-in"><dl class="rp-kv"><div class="m-only"><dt>Orders</dt><dd>${n('orders')}</dd></div><div class="m-only"><dt>Pages</dt><dd>${n('pages')}</dd></div><div><dt>UPI</dt><dd>${money(n('online'))}</dd></div><div><dt>Cash</dt><dd>${money(n('cash'))}</dd></div><div><dt>Awaiting payment</dt><dd>${n('payment_pending')}</dd></div><div><dt>Failed prints</dt><dd>${n('print_failures')}</dd></div></dl><div class="a-row"><a class="button button-light button-small" href="/shop/${encodeURIComponent(shop.shop_id)}" target="_blank" rel="noopener">${icon('external', 16)} Open portal</a><button type="button" class="button button-light button-small" data-copy="${esc(shop.shop_id)}">${icon('copy', 16)} Copy shop ID</button></div></div></div>
  </article>`;
}
function renderPlatformResults() {
  const box = document.querySelector('#platform-report-results'); if (!box || !platformData) return;
  const report = platformData, all = report.shops.map(sh => ({ ...sh, _attn: Number(sh.payment_pending || 0) + Number(sh.print_failures || 0) }));
  const sum = k => all.reduce((t, sh) => t + Number(sh[k] || 0), 0), totals = { orders: sum('orders'), pages: sum('pages'), revenue: sum('revenue'), online: sum('online'), cash: sum('cash'), pending: sum('payment_pending'), failed: sum('print_failures') };
  const q = platformQuery.trim().toLowerCase();
  const sorters = { revenue: (a, b) => b.revenue - a.revenue, orders: (a, b) => b.orders - a.orders, pages: (a, b) => b.pages - a.pages, attention: (a, b) => b._attn - a._attn || b.revenue - a.revenue, name: (a, b) => String(a.shop_name).localeCompare(String(b.shop_name)) };
  const rows = all.filter(sh => !q || `${sh.shop_name} ${sh.shop_id}`.toLowerCase().includes(q)).sort(sorters[platformSort]);
  const maxRev = Math.max(0, ...all.map(sh => Number(sh.revenue || 0)));
  box.innerHTML = all.length ? `<div class="metrics">${statCard('Orders', totals.orders, 'In this range')}${statCard('Pages', totals.pages, 'Billable pages')}${statCard('Verified revenue', money(totals.revenue), `UPI ${money(totals.online)} · Cash ${money(totals.cash)}`)}${statCard('Needs attention', totals.pending + totals.failed, `${totals.pending} awaiting payment · ${totals.failed} failed prints`, totals.pending + totals.failed ? 'is-warn' : '')}</div>
    <section class="a-panel a-flush rp-card"><div class="a-toolbar rp-tools"><label class="search-box">${icon('search', 18)}<input id="platform-search" type="search" placeholder="Search shops" aria-label="Search shops" value="${esc(platformQuery)}" autocomplete="off"></label><label class="rp-sort"><span>Sort by</span><select id="platform-sort" aria-label="Sort shops">${PLATFORM_SORTS.map(([k, l]) => `<option value="${k}" ${platformSort === k ? 'selected' : ''}>${l}</option>`).join('')}</select></label></div>
    <div class="a-listmeta"><span>${rows.length} of ${all.length} shop${all.length === 1 ? '' : 's'}</span><span class="a-sub">${report.groupBy === 'month' ? 'Monthly' : 'Daily'} · ${esc(report.from)} to ${esc(report.to)}</span></div>
    <div class="rp-head" aria-hidden="true"><span>Shop</span><span>Verified revenue</span><span>Orders</span><span>Pages</span><span>Status</span></div>
    <div class="rp-list" id="platform-rows">${rows.map(sh => shopReportRow(sh, totals.revenue, maxRev)).join('') || emptyState('search', 'No shops match', 'Try a different search.')}</div></section>` : `<div class="a-panel">${emptyState('shops', 'No shops yet', 'Shops you create will show up here.')}</div>`;
  const csv = document.querySelector('#platform-csv'); csv.disabled = !all.length;
  csv.onclick = () => reportCsv(`print-wallah-platform-${report.from}-${report.to}.csv`, ['Shop ID', 'Shop', 'Orders', 'Pages', 'Verified revenue', 'UPI', 'Cash', 'Payment pending', 'Print failures'], all.map(sh => [sh.shop_id, sh.shop_name, sh.orders, sh.pages, sh.revenue, sh.online, sh.cash, sh.payment_pending, sh.print_failures]));
  const search = document.querySelector('#platform-search'); if (search) { search.oninput = e => { platformQuery = e.target.value; const pos = e.target.selectionStart; renderPlatformResults(); const again = document.querySelector('#platform-search'); again.focus(); again.setSelectionRange(pos, pos); }; document.querySelector('#platform-sort').onchange = e => { platformSort = e.target.value; renderPlatformResults(); }; }
}
document.addEventListener('click', e => {
  const row = e.target.closest('.rp-main'); if (!row) return;
  const card = row.closest('.rp-row'), open = !card.classList.contains('open'); card.classList.toggle('open', open); row.setAttribute('aria-expanded', open);
});
async function loadPlatformAnalytics() {
  const box = document.querySelector('#platform-report-results'); if (!box) return;
  const params = new URLSearchParams({ from: document.querySelector('#platform-from').value, to: document.querySelector('#platform-to').value, groupBy: document.querySelector('#platform-group').value });
  if (!platformData) box.innerHTML = `<div class="a-panel">${skeleton(3)}</div>`; else box.classList.add('is-loading');
  try { platformData = await api(`/super/analytics?${params}`); box.classList.remove('is-loading'); renderPlatformResults(); }
  catch (error) { box.classList.remove('is-loading'); box.innerHTML = `<div class="a-panel">${emptyState('alert', 'Could not load the comparison', error.message)}</div>`; document.querySelector('#platform-csv').disabled = true; }
}
function wirePlatformAnalytics() {
  platformData = null; applyPlatformPreset(platformPreset === 'custom' ? '30' : platformPreset);
  const reload = () => loadPlatformAnalytics();
  document.querySelector('#platform-presets').onclick = e => { const b = e.target.closest('[data-preset]'); if (!b) return; platformPreset = b.dataset.preset; document.querySelectorAll('#platform-presets .fchip').forEach(x => { const on = x.dataset.preset === platformPreset; x.classList.toggle('active', on); x.setAttribute('aria-pressed', on); }); document.querySelector('#platform-dates').classList.toggle('show', platformPreset === 'custom'); if (platformPreset !== 'custom') { applyPlatformPreset(platformPreset); reload(); } };
  ['platform-from', 'platform-to', 'platform-group'].forEach(id => { document.querySelector('#' + id).onchange = () => { if (id !== 'platform-group' && platformPreset !== 'custom') { platformPreset = 'custom'; document.querySelectorAll('#platform-presets .fchip').forEach(x => { const on = x.dataset.preset === 'custom'; x.classList.toggle('active', on); x.setAttribute('aria-pressed', on); }); document.querySelector('#platform-dates').classList.add('show'); } reload(); }; });
  reload();
}
function showCreateShop() {
  const f = (label, name, o) => modalField('cs', label, name, o);
  showModal(`<div class="modal-head"><div><h2 class="modal-title">Create a shop workspace</h2><p class="subtext">Generates the customer portal, admin login, print-agent token and QR code.</p></div><button class="close-button" aria-label="Close" type="button" data-close-modal>${icon('close', 20)}</button></div>
  <form id="create-shop-form">
    <div class="form-grid">${f('Shop name', 'name', { required: true })}${f('Owner name', 'ownerName', { required: true })}${f('Contact number', 'phone', { required: true, attrs: 'inputmode="tel"' })}${f('Shop email', 'email', { type: 'email' })}${f('Address', 'address', { required: true, full: true })}${f('City', 'city', { required: true })}${f('Initial access (days)', 'accessDays', { type: 'number', value: 30, attrs: 'min="1" max="3650"' })}</div>
    <div class="config-section"><h3>Shop admin login</h3><div class="form-grid">${f('Shop admin email', 'adminEmail', { type: 'email', required: true })}${f('Shop admin password', 'adminPassword', { type: 'password', required: true, attrs: 'minlength="10" autocomplete="new-password"', hint: 'At least 10 characters. Share this securely with the shop owner.' })}</div></div>
    <div class="config-section"><h3>Payments · optional</h3><div class="form-grid">${f('UPI ID', 'upiId', { attrs: 'placeholder="shop@upi" autocapitalize="none"' })}${f('UPI payee name', 'upiName')}</div></div>
    ${printConfigFields()}
    <div class="config-section"><h3>Starting price card · ₹ per printed sheet</h3><div class="form-grid price-grid">${priceField('bw_a4', 'B&W · A4', 2)}${priceField('color_a4', 'Color · A4', 10)}${priceField('bw_a3', 'B&W · A3', 4)}${priceField('color_a3', 'Color · A3', 20)}${priceField('glossy_a4', 'Glossy · A4', 15)}${priceField('photo_sheet', 'Photo sheet', 30)}${optionalPriceField('glossy_a3', 'Glossy · A3', '')}${optionalPriceField('photo_sheet_a3', 'Photo sheet · A3', '')}</div></div>
    <div class="form-error" id="create-error" role="alert"></div>
    <div class="form-actions"><button type="button" class="button button-light" data-close-modal>Cancel</button><button type="submit" class="button button-primary">Create shop + QR</button></div>
  </form>`);
  document.querySelector('#create-shop-form').onsubmit = async e => { e.preventDefault(); const form = Object.fromEntries(new FormData(e.currentTarget)); form.pricing = Object.fromEntries(['bw_a4', 'color_a4', 'bw_a3', 'color_a3', 'glossy_a4', 'photo_sheet'].map(k => [k, Number(form[k])])); for (const k of ['bw_a4', 'color_a4', 'bw_a3', 'color_a3', 'glossy_a4', 'photo_sheet']) delete form[k]; form.printConfig = readPrintConfig(e.currentTarget); const button = e.currentTarget.querySelector('button[type="submit"]'), label = button.textContent; button.disabled = true; button.innerHTML = '<span class="spinner" aria-hidden="true"></span> Creating shop'; try { const result = await api('/super/shops', jsonBody(form)); showCreatedShop(result); renderSuper(); } catch (err) { document.querySelector('#create-error').textContent = err.message; button.disabled = false; button.textContent = label; }; };
}
function priceField(key, label, value) { return `<div class="field"><label for="${key}">${label}</label><input id="${key}" name="${key}" type="number" min="0" step="0.01" value="${value}" required></div>`; }
function optionalPriceField(key, label, value) { return `<div class="field"><label for="${key}">${label}</label><input id="${key}" name="${key}" type="number" min="0" step="0.01" value="${value ?? ''}" placeholder="Standard rate"><div class="field-hint">Optional. Leave empty to use the standard rate.</div></div>`; }
function modalField(prefix, label, name, o = {}) {
  const { type = 'text', value = '', required = false, hint = '', full = false, attrs = '' } = o;
  return `<div class="field${full ? ' full' : ''}"><label for="${prefix}-${name}">${label}</label><input id="${prefix}-${name}" name="${name}" type="${type}" ${value !== '' ? `value="${esc(value)}"` : ''} ${required ? 'required' : ''} ${attrs}>${hint ? `<span class="field-hint">${hint}</span>` : ''}</div>`;
}
function printConfigFields(pc = { paperSizes: ['A4', 'A3'], paperTypes: ['normal', 'glossy'], color: true, duplex: true, photo: true }, heading = true) {
  pc = pc || {}; const checked = (value) => value ? 'checked' : '';
  const choice = (name, label, on) => `<label class="choice"><input type="checkbox" name="${name}" ${checked(on)}><span>${label}</span></label>`;
  return `<div class="${heading ? 'config-section' : 'config-flat'}">${heading ? '<h3>Printing options this shop supports</h3>' : ''}<div class="form-grid"><div class="field"><span class="label">Paper sizes</span><div class="choice-row">${choice('paperSize_A4', 'A4', (pc.paperSizes || []).includes('A4'))}${choice('paperSize_A3', 'A3', (pc.paperSizes || []).includes('A3'))}</div></div><div class="field"><span class="label">Paper types</span><div class="choice-row">${choice('paperType_normal', 'Normal', (pc.paperTypes || []).includes('normal'))}${choice('paperType_glossy', 'Glossy', (pc.paperTypes || []).includes('glossy'))}</div></div><div class="field full"><span class="label">Print capabilities</span><div class="choice-row">${choice('supportsColor', 'Colour printing', pc.color)}${choice('supportsDuplex', 'Double-sided', pc.duplex)}${choice('supportsPhoto', 'Photo sheets', pc.photo)}</div></div></div></div>`;
}
function readPrintConfig(form) { const has = name => Boolean(form.querySelector(`[name="${name}"]`)?.checked); const paperSizes = ['A4', 'A3'].filter(v => has(`paperSize_${v}`)), paperTypes = ['normal', 'glossy'].filter(v => has(`paperType_${v}`)); return { paperSizes, paperTypes, color: has('supportsColor'), duplex: has('supportsDuplex'), photo: has('supportsPhoto'), defaultPaper: paperSizes.includes('A4') ? 'A4' : paperSizes[0] }; }
function showCreatedShop(result) {
  showModal(`<div class="modal-head"><div><h2 class="modal-title">${esc(result.shop.name)} is set up.</h2><p class="subtext">Shop ID ${esc(result.shop.id)} · access until ${date(result.shop.accessEnd)}</p></div><button class="close-button" aria-label="Close" type="button" data-close-modal>${icon('close', 20)}</button></div>
  <div class="qr-layout"><img class="qr-image" src="${result.qr}" alt="QR code for ${esc(result.shop.name)}" width="168" height="168"><div class="qr-side"><div><div class="label-caption">Customer portal</div><div class="url-box" id="created-url">${esc(result.customerUrl)}</div></div><div class="actions"><button class="button button-primary button-small" id="copy-url">${icon('copy', 16)} Copy URL</button><a class="button button-light button-small" href="${result.qr}" download="${esc(result.shop.id)}-qr.png">${icon('download', 16)} Download QR</a><a class="button button-light button-small" href="${esc(result.customerUrl)}" target="_blank" rel="noopener">${icon('external', 16)} Open portal</a></div></div></div>
  <div class="config-section"><div class="notice warn">${icon('alert', 18)}<span>The print-agent token is shown only once. Copy it now and follow the local agent setup guide.</span></div><div class="url-box mt-3">${esc(result.agentToken)}</div><div class="actions mt-3"><button class="button button-light button-small" id="copy-agent">${icon('copy', 16)} Copy agent token</button></div><p class="field-hint mt-3">Shop admin: ${esc(result.shop.adminEmail)}</p></div>`);
  document.querySelector('#copy-url').onclick = () => copyText(result.customerUrl); document.querySelector('#copy-agent').onclick = () => copyText(result.agentToken);
}
async function showShopDetails(id) {
  try {
    const data = await api(`/super/shops/${encodeURIComponent(id)}`); const s = data.shop;
    const capabilities = [...(s.printConfig.paperSizes || []), ...(s.printConfig.paperTypes || []), s.printConfig.color ? 'Color' : '', s.printConfig.duplex ? 'Double-sided' : '', s.printConfig.photo ? 'Photo sheets' : ''].filter(Boolean).join(' · ') || 'No print options enabled';
    showModal(`<div class="modal-head"><div><h2 class="modal-title">${esc(s.name)}</h2><p class="subtext">${esc(s.ownerName)} · ${esc(s.phone)} · ${esc(s.city)}</p></div><button class="close-button" aria-label="Close" type="button" data-close-modal>${icon('close', 20)}</button></div>
    <div class="detail-grid">${detailStat('Status', cap(s.status))}${detailStat('Access start', date(s.accessStart))}${detailStat('Access until', date(s.accessEnd))}${detailStat('Days left', daysLeft(s.accessEnd))}${detailStat('Total orders', data.stats.orders)}${detailStat('Orders today', data.stats.today)}${detailStat('Orders this month', data.stats.month_orders)}${detailStat('Orders this year', data.stats.year_orders)}${detailStat('Printed pages', data.stats.pages)}${detailStat('Gross order value', money(data.stats.charges))}${detailStat('Verified online', money(data.stats.online_verified))}${detailStat('Confirmed cash', money(data.stats.cash_confirmed))}</div>
    <div class="config-section"><h3>Shop contact and account</h3><div class="detail-grid">${detailStat('Phone', s.phone || '—')}${detailStat('Email', s.email || '—')}${detailStat('Address', s.address || '—')}${detailStat('City', s.city || '—')}${detailStat('Shop admin login', s.adminEmail || '—')}${detailStat('Printer agent', s.agentName || 'Not configured')}${detailStat('Last agent heartbeat', s.agentLastSeen ? dateTime(s.agentLastSeen) : 'Not connected')}</div></div>
    <div class="config-section"><h3>Payment and print setup</h3><div class="detail-grid">${detailStat('UPI payee', s.upiName || s.name)}${detailStat('UPI ID', s.upiId || 'Not configured')}${detailStat('Print options', capabilities)}${Object.entries(s.pricing || {}).map(([key, value]) => detailStat(`${key.replaceAll('_', ' ')} rate`, money(value))).join('')}</div></div>
    <div class="config-section qr-layout"><img class="qr-image" src="${data.qr}" alt="Shop customer portal QR" width="168" height="168"><div class="qr-side"><div><div class="label-caption">Customer portal</div><div class="url-box">${esc(data.customerUrl)}</div></div><div class="actions"><button class="button button-light button-small" id="copy-detail-url">${icon('copy', 16)} Copy portal URL</button><a class="button button-light button-small" href="${data.qr}" download="${esc(s.id)}-qr.png">${icon('download', 16)} Download QR</a><a class="button button-light button-small" href="${esc(data.customerUrl)}" target="_blank" rel="noopener">${icon('external', 16)} Open portal</a></div></div></div>
    <div class="config-section"><h3>Recent orders</h3>${data.recent.length ? `<div class="table-scroll"><table class="data"><thead><tr><th>Order</th><th>Created</th><th>Status</th><th class="num">Amount</th></tr></thead><tbody>${data.recent.map(o => `<tr><td class="mono">${esc(o.order_code)}</td><td>${dateTime(o.created_at)}</td><td>${stageBadge(o.order_status)}</td><td class="num">${money(o.amount)}</td></tr>`).join('')}</tbody></table></div>` : '<div class="empty"><p>No orders yet.</p></div>'}</div>
    <div class="form-actions"><button class="button button-light" id="detail-extend">Extend access</button><button class="button button-primary" id="edit-shop">Edit shop</button></div>`);
    document.querySelector('#copy-detail-url').onclick = () => copyText(data.customerUrl); document.querySelector('#edit-shop').onclick = () => showEditShop(s); document.querySelector('#detail-extend').onclick = () => extendShop(id);
  } catch (e) { toast(e.message); }
}
function detailStat(label, value) { return `<div class="detail-stat"><span class="stat-label">${esc(label)}</span><strong>${esc(value)}</strong></div>`; }
function showEditShop(s) {
  const f = (label, name, o) => modalField('es', label, name, o);
  showModal(`<div class="modal-head"><div><h2 class="modal-title">Edit ${esc(s.name)}</h2></div><button class="close-button" aria-label="Close" type="button" data-close-modal>${icon('close', 20)}</button></div>
  <form id="edit-shop-form">
    <div class="form-grid">${f('Shop name', 'name', { value: s.name, required: true })}${f('Owner name', 'ownerName', { value: s.ownerName, required: true })}${f('Contact number', 'phone', { value: s.phone, required: true, attrs: 'inputmode="tel"' })}${f('Shop email', 'email', { type: 'email', value: s.email || '' })}${f('Address', 'address', { value: s.address, full: true })}${f('City', 'city', { value: s.city })}</div>
    <div class="config-section"><h3>Shop admin login</h3><div class="form-grid">${f('Shop admin email', 'adminEmail', { type: 'email', value: s.adminEmail })}${f('Reset admin password', 'adminPassword', { type: 'password', attrs: 'minlength="10" autocomplete="new-password" placeholder="Leave blank to keep current"' })}</div></div>
    <div class="config-section"><h3>Payments</h3><div class="form-grid">${f('UPI ID', 'upiId', { value: s.upiId || '' })}${f('UPI payee name', 'upiName', { value: s.upiName || '' })}</div></div>
    ${printConfigFields(s.printConfig)}
    <div class="config-section"><h3>Price card · ₹ per printed sheet</h3><div class="form-grid price-grid">${priceField('bw_a4', 'B&W · A4', s.pricing.bw_a4)}${priceField('color_a4', 'Color · A4', s.pricing.color_a4)}${priceField('bw_a3', 'B&W · A3', s.pricing.bw_a3)}${priceField('color_a3', 'Color · A3', s.pricing.color_a3)}${priceField('glossy_a4', 'Glossy · A4', s.pricing.glossy_a4)}${priceField('photo_sheet', 'Photo sheet', s.pricing.photo_sheet)}${optionalPriceField('glossy_a3', 'Glossy · A3', s.pricing.glossy_a3)}${optionalPriceField('photo_sheet_a3', 'Photo sheet · A3', s.pricing.photo_sheet_a3)}</div></div>
    <div class="form-error" id="edit-error" role="alert"></div>
    <div class="form-actions"><button type="button" class="button button-light" data-close-modal>Cancel</button><button class="button button-primary">Save changes</button></div>
  </form>`);
  document.querySelector('#edit-shop-form').onsubmit = async e => { e.preventDefault(); const b = Object.fromEntries(new FormData(e.currentTarget)); b.pricing = Object.fromEntries(['bw_a4', 'color_a4', 'bw_a3', 'color_a3', 'glossy_a4', 'photo_sheet'].map(k => [k, Number(b[k])])); b.printConfig = readPrintConfig(e.currentTarget); try { await api(`/super/shops/${encodeURIComponent(s.id)}`, { method: 'PATCH', body: JSON.stringify(b) }); toast('Shop saved.'); renderSuper(); showShopDetails(s.id); } catch (err) { document.querySelector('#edit-error').textContent = err.message; } };
}
async function loadAnalytics() {
  const box = document.querySelector('#analytics-results');
  box.innerHTML = '<div class="loading"><span class="spinner" aria-hidden="true"></span><span>Loading totals</span></div>';
  const params = new URLSearchParams({
    from: document.querySelector('#analytics-from').value,
    to: document.querySelector('#analytics-to').value,
    groupBy: document.querySelector('#analytics-group').value,
  });
  try {
    const report = await api(`/admin/analytics?${params}`), rows = report.rows;
    if (!rows.length) {
      box.innerHTML = emptyState('chart', 'No print activity', 'There are no orders in this date range.');
      document.querySelector('#analytics-csv').disabled = true;
      return;
    }
    const totals = rows.reduce((sum, row) => {
      for (const key of ['orders', 'pages', 'revenue', 'online', 'cash', 'payment_pending', 'print_failures']) sum[key] += Number(row[key] || 0);
      return sum;
    }, { orders: 0, pages: 0, revenue: 0, online: 0, cash: 0, payment_pending: 0, print_failures: 0 });
    const grouping = report.groupBy === 'month' ? 'MONTH' : 'DAY';
    const max = Math.max(1, ...rows.map((row) => Number(row.orders)));
    const step = Math.max(1, Math.ceil(rows.length / 8));
    box.innerHTML = `<div class="metrics is-flat">${statCard('Orders', totals.orders, 'Selected range')}${statCard('Pages', totals.pages, 'Billable pages')}${statCard('Verified revenue', money(totals.revenue), `UPI ${money(totals.online)} · Cash ${money(totals.cash)}`)}${statCard('Needs attention', totals.payment_pending + totals.print_failures, `${totals.payment_pending} payment pending · ${totals.print_failures} print failures`)}</div><div class="a-chart" aria-hidden="true">${rows.map((row, i) => `<div class="bar-col"><div class="bar-track"><div class="bar" title="${esc(`${date(row.activity_date)} · ${row.orders} orders · ${money(row.revenue)}`)}" style="height:${Math.max(3, Number(row.orders) / max * 100)}%"></div></div><span class="bar-label">${i % step === 0 ? esc(date(row.activity_date)) : ''}</span></div>`).join('')}</div><div class="table-scroll"><table class="data"><thead><tr><th>${grouping}</th><th class="num">Orders</th><th class="num">Pages</th><th class="num">Verified revenue</th><th class="num">UPI</th><th class="num">Cash</th><th class="num">Payment pending</th><th class="num">Print failures</th></tr></thead><tbody>${rows.map((row) => `<tr><td>${date(row.activity_date)}</td><td class="num">${row.orders}</td><td class="num">${row.pages}</td><td class="num">${money(row.revenue)}</td><td class="num">${money(row.online)}</td><td class="num">${money(row.cash)}</td><td class="num">${row.payment_pending}</td><td class="num">${row.print_failures}</td></tr>`).join('')}</tbody></table></div><p class="a-foot">${esc(report.timeZone)} · ${esc(report.from)} to ${esc(report.to)}</p>`;
    const csvButton = document.querySelector('#analytics-csv');
    csvButton.disabled = false;
    csvButton.onclick = () => reportCsv(`print-wallah-shop-${report.from}-${report.to}.csv`, [grouping, 'Orders', 'Pages', 'Verified revenue', 'UPI', 'Cash', 'Payment pending', 'Print failures'], rows.map((row) => [row.activity_date, row.orders, row.pages, row.revenue, row.online, row.cash, row.payment_pending, row.print_failures]));
  } catch (error) {
    box.innerHTML = emptyState('alert', 'Could not load the report', error.message);
    document.querySelector('#analytics-csv').disabled = true;
  }
}
