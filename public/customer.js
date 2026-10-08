/* Customer portal. Loaded before app.js; uses its helpers (api, esc, money, toast, jsonBody, app, setHeading) at call time. */
'use strict';

const PAPER_MM = { A4: [210, 297], A3: [297, 420] };
const PRINTER_MARGIN_MM = 4; // typical unprintable edge, shown as the dashed printable area
const IMAGE_DPI = 150;
const PHOTO_MARGIN_CM = 1, PHOTO_GAP_CM = 0.2; // must match src/routes/api.js
const PDF_SCALE = 1.5;
const ACTIVE_ORDER_MAX_AGE_MS = 24 * 3600 * 1000;
const COMPLETE_RETURN_SECONDS = 12;
const isTouchPhone = () => /Android|iPhone|iPad|iPod/i.test(navigator.userAgent) || (navigator.maxTouchPoints > 1 && matchMedia('(pointer:coarse)').matches);

// Same grid maths as the server's photoGeometry, so the preview matches the printed sheet.
function photoLayout(dims, paper, orientation) {
  const sheet = PAPER_MM[paper].map((v) => v / 10);
  const [sw, sh] = orientation === 'landscape' ? [sheet[1], sheet[0]] : sheet;
  const uw = sw - 2 * PHOTO_MARGIN_CM, uh = sh - 2 * PHOTO_MARGIN_CM;
  const fit = (cw, ch) => ({ columns: Math.max(0, Math.floor((uw + PHOTO_GAP_CM) / (cw + PHOTO_GAP_CM))), rows: Math.max(0, Math.floor((uh + PHOTO_GAP_CM) / (ch + PHOTO_GAP_CM))) });
  const up = fit(dims.w, dims.h), turned = fit(dims.h, dims.w);
  const rotated = turned.columns * turned.rows > up.columns * up.rows;
  const g = rotated ? turned : up;
  return { ...g, capacity: g.columns * g.rows, rotated, photoW: dims.w, photoH: dims.h, cellW: rotated ? dims.h : dims.w, cellH: rotated ? dims.w : dims.h, sw, sh };
}

// "all", "3", "1-3,5". Returns selected page numbers in order or an error message.
function parsePageRange(value, total) {
  const text = String(value || '').trim().toLowerCase();
  if (!text || text === 'all') return { pages: Array.from({ length: total }, (_, i) => i + 1) };
  const set = new Set();
  for (const part of text.split(',')) {
    const m = part.trim().match(/^(\d{1,5})(?:\s*-\s*(\d{1,5}))?$/);
    if (!m) return { error: 'Enter pages like 1-3,5' };
    const a = Number(m[1]), b = Number(m[2] || m[1]);
    if (a < 1 || b < a) return { error: 'Page ranges must go upward, like 2-5' };
    if (b > total) return { error: `This document has ${total} page${total === 1 ? '' : 's'}` };
    for (let n = a; n <= b; n++) set.add(n);
  }
  return { pages: [...set].sort((x, y) => x - y) };
}

const formatBytes = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
const orderKey = (shopId) => `pw-order-${shopId}`;
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* private mode */ } },
};
const TERMINAL = new Set(['completed', 'cancelled']);
const isTerminal = (o) => TERMINAL.has(o.status) || ['cancelled', 'rejected', 'failed'].includes(o.paymentStatus) && o.status !== 'failed';
const isActiveOrder = (o) => !isTerminal(o) && Date.now() - new Date(o.createdAt).getTime() < ACTIVE_ORDER_MAX_AGE_MS;
const loadImage = (url) => new Promise((res, rej) => { const img = new Image(); img.onload = () => res(img); img.onerror = () => rej(new Error('image')); img.src = url; });

let C = null; // portal state
const timers = { poll: null, quote: null, hint: null, resize: null, home: null, nudge: null, edit: 0 };
function clearTimers() { Object.entries(timers).forEach(([k, t]) => { if (k !== 'nudge') { clearTimeout(t); clearInterval(t); cancelAnimationFrame(t); } }); }
function revokeUrls() { (C?.items || []).forEach((i) => i.url && URL.revokeObjectURL(i.url)); }

/* ---------- Shared UI: nudge, nav, footer ---------- */
function nudge(message, { action, onAction } = {}) {
  const el = document.querySelector('#nudge'); clearTimeout(timers.nudge);
  el.innerHTML = `${icon('info', 40)}<p>${esc(message)}</p>${action ? `<button class="button button-primary button-small" type="button">${esc(action)}</button>` : ''}`;
  el.classList.add('show');
  el.querySelector('button')?.addEventListener('click', () => { el.classList.remove('show'); onAction?.(); });
  timers.nudge = setTimeout(() => el.classList.remove('show'), 5200);
}
function nudgeNeedsFile(what = 'option') {
  const photoFirst = C.cfg.mode === 'photo';
  nudge(photoFirst ? `Upload your photos first to use this ${what}.` : `Upload a document first to use this ${what}.`, { action: 'Choose file', onAction: () => document.querySelector('#file-input')?.click() });
  const card = document.querySelector('#file-card'); if (!card) return;
  card.classList.remove('pulse'); void card.offsetWidth; card.classList.add('pulse');
  const r = card.getBoundingClientRect(); if (r.bottom < 0 || r.top > innerHeight) card.scrollIntoView({ behavior: 'smooth', block: 'center' });
}
function setCustomerNav({ viewing = false } = {}) {
  const s = C.shop, active = viewing ? null : C.activeOrder;
  const call = s.phone ? `<a class="nav-chip chip-compact" href="tel:${esc(s.phone.replace(/[^\d+]/g, ''))}" aria-label="Call ${esc(s.name)}" title="Call shop">${icon('phone', 20)}<span>Call shop</span></a>` : '';
  const track = active ? `<a class="nav-chip" href="/shop/${encodeURIComponent(s.id)}?order=${encodeURIComponent(active.code)}" aria-label="Track order">${icon('printer', 20)}<span>Track order</span></a>` : '';
  setHeading("", track + call);
}
function footerHtml() {
  const s = C.shop, active = C.activeOrder;
  const maps = s.address ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent([s.name, s.address, s.city].filter(Boolean).join(', '))}` : null;
  const tel = s.phone ? s.phone.replace(/[^\d+]/g, '') : '';
  return `<footer class="pw-footer"><div class="pw-footer-inner">
    <section class="pf-brand"><img class="brand-logo" src="/assets/Print-Wallah_wordmark.png" alt="Print Wallah"><p class="tag">Upload, set up, pay and collect, with ${esc(s.name)}.</p></section>
    <section class="pf-shop" aria-label="This shop"><h4>This shop</h4><strong>${esc(s.name)}</strong>${s.address || s.city ? `<p class="address">${esc([s.address, s.city].filter(Boolean).join(', '))}</p>` : ''}<div class="pf-actions">${tel ? `<a class="pf-pill" href="tel:${esc(tel)}">${icon('phone', 18)}<span>Call</span></a>` : ''}${maps ? `<a class="pf-pill" href="${maps}" target="_blank" rel="noopener">${icon('pin', 18)}<span>Maps</span></a>` : ''}</div></section>
    <nav class="pf-links" aria-label="Quick links"><h4>Quick links</h4><ul><li><a href="#file-card" data-jump="file-card">Start a print</a></li><li><a href="#settings-card" data-jump="settings-card">Print settings</a></li>${active ? `<li><a href="/shop/${encodeURIComponent(s.id)}?order=${encodeURIComponent(active.code)}">Track my order</a></li>` : ''}<li><a href="/admin">Shop staff sign in</a></li></ul></nav>
  </div>${legalFooterHtml()}</footer>`;
}
function wireJumps() { document.querySelectorAll('[data-jump]').forEach((a) => a.addEventListener('click', (e) => { e.preventDefault(); document.querySelector('#' + a.dataset.jump)?.scrollIntoView({ behavior: 'smooth', block: 'start' }); })); }
function creditLine() { return '<p class="countdown mt-5">Print Wallah &middot; Made by DEVELOPERS</p>'; }
function errorScreen(title, message, retry = true) { return `<div class="login-wrap"><div class="login-card"><div class="status-art">${icon('empty')}</div><h1 style="text-align:center">${esc(title)}</h1><p class="lede" style="text-align:center">${esc(message)}</p>${retry ? '<button class="button" type="button" data-reload>Try again</button>' : ''}</div></div>`; }

/* ---------- Entry ---------- */
function freshState(shop) {
  const pc = shop.printConfig;
  return {
    shop, items: [], quote: null, revision: 0, submitting: false, previewIndex: 0, pdf: null, pageCache: {}, renderCache: new Map(), upiOpened: false, editing: 0, activeOrder: null, notice: null, order: null,
    cfg: { mode: 'document', paperSize: pc.paperSizes.includes(pc.defaultPaper) ? pc.defaultPaper : pc.paperSizes[0], paperType: pc.paperTypes.includes('normal') ? 'normal' : pc.paperTypes[0], orientation: 'portrait', scaling: 'fit', color: false, duplex: false, copies: 1, pageRange: 'all', rangeMode: 'all', photoSize: shop.photoSizes[0].id, photoFit: 'cover' },
  };
}
const photoAvailable = () => C.shop.printConfig.photo && C.shop.printConfig.paperTypes.includes('glossy');

async function renderCustomer(shopId) {
  clearTimers(); document.querySelector('#nudge')?.classList.remove('show');
  try {
    const { shop } = await api(`/shops/${encodeURIComponent(shopId)}/public`);
    window.MAX_UPLOAD_MB = shop.maxUploadMb || 30;
    document.title = `${shop.name} | Print Wallah`;
    revokeUrls(); C = freshState(shop); setCustomerNav();
    const params = new URLSearchParams(location.search), explicit = params.get('order'), stored = store.get(orderKey(shop.id));
    const code = explicit || stored;
    if (code) {
      try {
        const { order } = await api(`/orders/${encodeURIComponent(code)}`);
        if (order.shopId === shop.id) {
          if (isActiveOrder(order)) {
            C.activeOrder = order; store.set(orderKey(shop.id), order.code);
            if (explicit) { showOrder(order); return; }
          } else {
            // Finished, cancelled or stale: never resurrect its screen. Show the homepage, with a one time note for a tracking link.
            store.del(orderKey(shop.id));
            if (explicit) C.notice = order.status === 'completed' ? { kind: 'ok', text: `Order ${order.code} was printed. Thank you!` } : { kind: 'warn', text: `Order ${order.code} is no longer active.` };
            history.replaceState(null, '', location.pathname);
          }
        } else { store.del(orderKey(shop.id)); if (explicit) history.replaceState(null, '', location.pathname); }
      } catch (e) {
        if (e.status === 404) { store.del(orderKey(shop.id)); if (explicit) history.replaceState(null, '', location.pathname); }
        else if (explicit) { app.innerHTML = errorScreen('Could not load your order', e.message); return; }
      }
    }
    setCustomerNav(); renderHome();
  } catch (e) {
    document.querySelector('#app').classList.add('wide');
    const gone = e.status === 423 || e.status === 404;
    app.innerHTML = errorScreen(e.status === 404 ? 'Shop not found' : e.status === 423 ? 'This shop is not taking orders' : 'Could not open this shop', e.status === 404 ? 'Check the link or scan the shop QR code again.' : e.message, !gone);
  }
}
function goHome() {
  clearTimers();
  if (C?.order && isTerminal(C.order)) store.del(orderKey(C.shop.id));
  history.replaceState(null, '', location.pathname);
  window.scrollTo({ top: 0, behavior: 'instant' });
  renderCustomer(C.shop.id);
}

/* ---------- Home ---------- */
function renderHome() {
  const s = C.shop, rate = Number(s.pricing.bw_a4) > 0 ? `B&amp;W A4 from ${money(s.pricing.bw_a4)}` : '';
  const a = C.activeOrder;
  app.innerHTML = `<div class="page">
    <section class="hero"><div><h1>${esc(s.name)}</h1>
      <div class="where">${s.address || s.city ? `<span>${icon('pin', 18)}${esc([s.address, s.city].filter(Boolean).join(', '))}</span>` : ''}${s.phone ? `<a href="tel:${esc(s.phone.replace(/[^\d+]/g, ''))}">${icon('phone', 18)}${esc(s.phone)}</a>` : ''}${rate ? `<span>${icon('rupee', 18)}${rate}</span>` : ''}</div></div>
      <ol class="steps" aria-label="How it works"><li>${icon('upload', 34)}Upload</li><li>${icon('sliders', 34)}Set up</li><li>${icon('pay', 34)}Pay</li><li>${icon('printer', 34)}Collect</li></ol></section>
    <details class="fold"><summary>${icon('info', 18)}<span>Files are deleted after printing</span></summary><p>Print files are automatically deleted about 10 minutes after printing completes. Order and payment records are retained.</p></details>
    ${C.notice ? `<div class="inline-notice ${C.notice.kind} mb" id="home-notice" style="margin-bottom:var(--s-5)">${esc(C.notice.text)}</div>` : ''}
    ${s.printerOnline ? '' : `<div class="printer-note"><div class="pn-full inline-notice warn">The shop’s printer is offline right now. You can still order; it prints when the shop reconnects.</div><details class="pn-fold"><summary><i aria-hidden="true"></i><span>Printer is offline</span></summary><p>The shop’s printer is offline right now. You can still order; it prints when the shop reconnects.</p></details></div>`}
    ${a ? `<div class="resume-banner">${icon('printer', 44)}<div><strong>You have an order in progress</strong><div class="subtext">${esc(a.code)} &middot; ${money(a.amount)} &middot; ${esc(orderStateText(a))}</div></div><a class="button button-primary button-small" href="/shop/${encodeURIComponent(s.id)}?order=${encodeURIComponent(a.code)}">View order</a></div>` : ''}
    <div class="portal-grid"><div class="portal-col"><section class="card" id="file-card" style="order:1"></section><section class="card" id="settings-card" style="order:3"></section><section class="card hidden" id="edit-card" style="order:4"></section></div>
    <div class="portal-col sticky-col"><section class="card" id="preview-card" style="order:2"></section><section class="card" id="summary-card" style="order:5"></section></div></div>
    <div class="mobile-total hidden" id="mobile-total"></div></div>${footerHtml()}`;
  document.querySelector('#site-footer').classList.add('hidden');
  renderFileArea(); renderSettings(); renderEditor(); drawPreview(); renderSummary({}); wireJumps();
}
function orderStateText(o) {
  return ({ pending_payment: 'waiting for your UPI payment', payment_review: 'shop is confirming your payment', cash_confirmation_pending: 'pay cash at the counter', print_queued: 'in the print queue', printing: 'printing now', failed: 'needs the shop\'s attention' })[o.status] || 'in progress';
}

/* ---------- Upload ---------- */
function renderFileArea() { C.items.length ? renderFileCard() : renderDropzone(); }
function renderDropzone() {
  const card = document.querySelector('#file-card'), photo = C.cfg.mode === 'photo', max = window.MAX_UPLOAD_MB || 30;
  card.innerHTML = `<div class="card-title">${icon(photo ? 'photo' : 'doc')}<div><span class="step">Step 1</span><h2>${photo ? 'Choose your photos' : 'Choose your file'}</h2></div></div>
    <label class="dropzone" id="dropzone">${icon('upload')}<input type="file" id="file-input" accept="${photo ? 'image/jpeg,image/png,.jpg,.jpeg,.png' : 'application/pdf,image/jpeg,image/png,.pdf,.jpg,.jpeg,.png'}" multiple><strong>${photo ? 'Tap to choose photos' : 'Tap to choose files'}</strong><span class="dz-types">${photo ? 'JPG or PNG' : 'PDF, JPG or PNG'} · up to ${max} MB each</span><span class="dz-more">${photoAvailable() && !photo ? 'Several photos can share one sheet' : 'Up to 10 files in one order'}</span></label>
    <div class="form-error mt-4" id="upload-error"></div><div class="progress hidden" id="upload-progress"><span></span></div>`;
  const zone = card.querySelector('#dropzone'), input = card.querySelector('#file-input');
  input.onchange = () => { if (input.files.length) handleFiles([...input.files]); input.value = ''; };
  ['dragenter', 'dragover'].forEach((ev) => zone.addEventListener(ev, (e) => { e.preventDefault(); zone.classList.add('drag'); }));
  ['dragleave', 'drop'].forEach((ev) => zone.addEventListener(ev, (e) => { e.preventDefault(); zone.classList.remove('drag'); }));
  zone.addEventListener('drop', (e) => { if (e.dataTransfer.files.length) handleFiles([...e.dataTransfer.files]); });
}
function fileKind(file) {
  const n = file.name.toLowerCase();
  if (file.type === 'application/pdf' || n.endsWith('.pdf')) return 'application/pdf';
  if (file.type === 'image/png' || n.endsWith('.png')) return 'image/png';
  if (file.type === 'image/jpeg' || /\.jpe?g$/.test(n)) return 'image/jpeg';
  return null;
}
function uploadOne(blob, mime, name, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest(), data = new FormData();
    data.append('document', new Blob([blob], { type: mime }), name);
    xhr.open('POST', `/api/shops/${encodeURIComponent(C.shop.id)}/uploads`);
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress?.(e.loaded / e.total); };
    xhr.onload = () => { let body = {}; try { body = JSON.parse(xhr.responseText); } catch { /* non-json */ } xhr.status >= 200 && xhr.status < 300 ? resolve(body) : reject(new Error(body.error || `Upload failed (${xhr.status})`)); };
    xhr.onerror = () => reject(new Error('Upload failed. Check your connection and try again.'));
    xhr.ontimeout = () => reject(new Error('Upload timed out. Try again on a stronger connection.'));
    xhr.timeout = 5 * 60 * 1000;
    xhr.send(data);
  });
}
async function handleFiles(files, { adding = false } = {}) {
  const errorBox = document.querySelector('#upload-error'), bar = document.querySelector('#upload-progress');
  const show = (m) => { if (errorBox) errorBox.textContent = m; else toast(m); };
  const max = (window.MAX_UPLOAD_MB || 30) * 1048576;
  let accepted = [];
  for (const f of files) {
    const mime = fileKind(f);
    if (!mime) { show(`${f.name}: only PDF, JPG and PNG files can be printed.`); continue; }
    if (!f.size) { show(`${f.name} is empty.`); continue; }
    if (f.size > max) { show(`${f.name} is ${formatBytes(f.size)}. The limit is ${window.MAX_UPLOAD_MB || 30} MB.`); continue; }
    accepted.push({ file: f, mime });
  }
  if (!accepted.length) return;
  const wantPhotos = adding || C.cfg.mode === 'photo';
  const pdfPick = accepted.find((a) => a.mime === 'application/pdf');
  if (wantPhotos) { if (pdfPick) toast('PDFs are printed as documents, not photo sheets.'); accepted = accepted.filter((a) => a.mime !== 'application/pdf'); if (!accepted.length) return; }
  if (!wantPhotos && accepted.length > 10) { accepted = accepted.slice(0, 10); toast('A combined print order can contain up to 10 files.'); }
  if (!wantPhotos && accepted.reduce((sum, item) => sum + item.file.size, 0) > 100 * 1024 * 1024) { show('The combined files exceed the 100 MB order limit. Choose fewer or smaller files.'); return; }
  if (adding && C.items.length + accepted.length > 12) { accepted = accepted.slice(0, 12 - C.items.length); toast('A photo sheet can hold up to 12 different photos.'); }
  if (!accepted.length) return;
  if (errorBox) errorBox.textContent = '';
  bar?.classList.remove('hidden');
  const added = [];
  try {
    for (const [i, a] of accepted.entries()) {
      const up = await uploadOne(a.file, a.mime, a.file.name, (p) => { if (bar) bar.firstElementChild.style.width = `${Math.round(((i + p) / accepted.length) * 100)}%`; });
      const url = a.mime === 'application/pdf' ? null : URL.createObjectURL(a.file);
      const item = { upload: up, file: a.file, mime: a.mime, url, quantity: 1, edit: { ...PhotoEdit.DEFAULT_EDIT }, id: up.uploadToken };
      if (url) { try { item.img = await loadImage(url); item.px = [item.img.naturalWidth, item.img.naturalHeight]; } catch { URL.revokeObjectURL(url); show(`${a.file.name} could not be opened. Try saving it again as JPG or PNG.`); continue; } }
      added.push(item);
    }
  } catch (e) { show(e.message); bar?.classList.add('hidden'); if (!added.length) return; }
  bar?.classList.add('hidden');
  if (!added.length) return;
  if (adding) { C.items.push(...added); renderSettings(); renderEditor(); drawPreview(); scheduleQuote(); return; }
  C.items = added;
  await setupDocument();
}
async function setupDocument() {
  const main = C.items[0], cfg = C.cfg;
  C.pdf = null; C.pageCache = {}; C.previewIndex = 0; C.previewFailed = false; C.editing = 0; C.renderCache.clear();
  let orientation = 'portrait';
  if (main.mime === 'application/pdf') {
    try {
      if (!window.pdfjsLib) throw new Error('viewer missing');
      pdfjsLib.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs/pdf.worker.min.js';
      C.pdf = await pdfjsLib.getDocument({ data: new Uint8Array(await main.file.arrayBuffer()) }).promise;
      const v = (await C.pdf.getPage(1)).getViewport({ scale: 1 });
      main.pageMm = [v.width * 25.4 / 72, v.height * 25.4 / 72];
      if (v.width > v.height) orientation = 'landscape';
    } catch (e) { console.warn('PDF preview unavailable:', e.message); main.pageMm = [210, 297]; C.previewFailed = true; }
  } else {
    main.pageMm = main.px.map((p) => p * 25.4 / IMAGE_DPI);
    if (main.px[0] > main.px[1]) orientation = 'landscape';
  }
  const allImages = C.items.every((item) => item.mime !== 'application/pdf');
  cfg.mode = allImages && photoAvailable() && (C.items.length > 1 || cfg.mode === 'photo') ? 'photo' : 'document';
  cfg.orientation = cfg.mode === 'photo' ? 'portrait' : orientation;
  cfg.rangeMode = 'all'; cfg.pageRange = 'all'; cfg.copies = 1; cfg.scaling = 'fit'; cfg.duplex = false;
  normalizeCfg(); renderFileCard(); renderSettings(); renderEditor(); drawPreview(); scheduleQuote();
}
function renderFileCard() {
  const main = C.items[0], many = C.items.length > 1;
  const bundle = many && C.cfg.mode !== 'photo';
  const pages = bundle ? C.items.reduce((sum, item) => sum + Number(item.upload.pages || 1), 0) : Number(main.upload.pages || 1);
  const name = many ? `${C.items.length} ${bundle ? 'files' : 'photos'}` : main.upload.fileName;
  const meta = bundle ? `${pages} total pages · one print order` : main.mime === 'application/pdf' ? `${main.upload.pages} page${main.upload.pages === 1 ? '' : 's'} | ${formatBytes(main.upload.size)}` : many ? 'Photos ready to print' : `${main.upload.width || main.px[0]} x ${main.upload.height || main.px[1]} px | ${formatBytes(main.upload.size)}`;
  const fileList = bundle ? `<div class="file-meta mt-3">${C.items.map((item, i) => `<div class="file-line"><span class="file-name">${esc(item.upload.fileName)} · ${item.upload.pages || 1} page${Number(item.upload.pages || 1) === 1 ? '' : 's'}</span><button class="button button-light button-small" type="button" data-remove-document="${i}" aria-label="Remove ${esc(item.upload.fileName)}">Remove</button></div>`).join('')}</div>` : '';
  document.querySelector('#file-card').innerHTML = `<div class="card-title">${icon(main.mime === 'application/pdf' ? 'doc' : 'photo')}<div><span class="step">Step 1</span><h2>${bundle ? 'Your files' : 'Your file'}</h2></div></div><div class="file-line"><div class="file-meta"><div class="file-name">${esc(name)}</div><div class="subtext">${esc(meta)}</div></div><button class="button button-light button-small" id="change-file" type="button">Change</button></div>${fileList}${C.previewFailed ? '<div class="inline-notice warn mt-4">This PDF could not be previewed here, but it can still be printed. The preview shows a blank page.</div>' : ''}${bundle ? '<div class="field-hint mt-3">The preview shows the first file; all files and pages are included in the combined order.</div>' : ''}`;
  document.querySelector('#change-file').onclick = () => { revokeUrls(); C.items = []; C.quote = null; C.pdf = null; C.previewFailed = false; C.renderCache.clear(); renderDropzone(); renderSettings(); renderEditor(); drawPreview(); renderSummary({}); };
  document.querySelectorAll('[data-remove-document]').forEach((button) => button.addEventListener('click', async () => {
    const [removed] = C.items.splice(Number(button.dataset.removeDocument), 1);
    if (removed.url) URL.revokeObjectURL(removed.url);
    if (!C.items.length) { C.quote = null; C.pdf = null; renderDropzone(); renderSettings(); renderEditor(); drawPreview(); renderSummary({}); return; }
    await setupDocument();
  }));
}

/* ---------- Settings (always visible, locked until a file exists) ---------- */
const seg = (name, value, options) => `<div class="segmented" role="group" aria-label="${esc(name)}">${options.map(([v, label, disabled]) => `<button type="button" data-set="${name}" data-value="${esc(v)}" class="${String(value) === String(v) ? 'selected' : ''}" aria-pressed="${String(value) === String(v)}" ${disabled ? 'disabled' : ''}>${esc(label)}</button>`).join('')}</div>`;
const hasFile = () => C.items.length > 0;
const mainItem = () => C.items[0] || null;
const isPdf = () => mainItem()?.mime === 'application/pdf';
function renderSettings() {
  const { cfg, shop } = C, pc = shop.printConfig, main = mainItem(), locked = !hasFile();
  const sizeSelect = `<div class="field"><label for="paper-size">Paper size</label><select id="paper-size" data-select="paperSize">${pc.paperSizes.map((s) => `<option ${cfg.paperSize === s ? 'selected' : ''}>${s}</option>`).join('')}</select></div>`;
  const orient = `<div class="field"><label>Orientation</label>${seg('orientation', cfg.orientation, [['portrait', 'Portrait'], ['landscape', 'Landscape']])}</div>`;
  let body;
  if (cfg.mode === 'photo') {
    const lay = photoLayout(shop.photoSizes.find((p) => p.id === cfg.photoSize), cfg.paperSize, cfg.orientation);
    const total = C.items.reduce((n, i) => n + i.quantity, 0) || 0, sheets = Math.ceil(total / lay.capacity);
    body = `<div class="settings-grid"><div class="field"><label for="photo-size">Photo size</label><select id="photo-size" data-select="photoSize">${shop.photoSizes.map((p) => `<option value="${p.id}" ${cfg.photoSize === p.id ? 'selected' : ''}>${esc(p.label)}</option>`).join('')}</select></div>${sizeSelect}
      <div class="field"><label>Photo fit</label>${seg('photoFit', cfg.photoFit, [['cover', 'Fill (crop)'], ['contain', 'Fit whole photo']])}</div>${orient}
      <div class="field full"><label>Photos and how many of each</label>${locked ? '<div class="field-hint">Your photos will be listed here with a quantity for each.</div>' : `<div class="photo-list">${C.items.map((it, i) => `<div class="photo-row ${i === C.editing ? 'editing' : ''}"><img src="${it.url}" alt=""><div class="file-meta"><div class="file-name">${esc(it.upload.fileName)}</div>${PhotoEdit.isEdited(it.edit) ? '<span class="edited-dot">Edited</span>' : ''}</div><div class="stepper"><button type="button" data-qty="${i}" data-delta="-1" aria-label="Fewer">-</button><input type="number" inputmode="numeric" min="1" max="500" value="${it.quantity}" data-qty-input="${i}" aria-label="Quantity of ${esc(it.upload.fileName)}"><button type="button" data-qty="${i}" data-delta="1" aria-label="More">+</button></div>${C.items.length > 1 ? `<button type="button" class="button button-light button-small remove" data-remove="${i}">Remove</button>` : ''}</div>`).join('')}</div>
        ${C.items.length < 12 ? '<label class="button button-light button-small mt-3" style="cursor:pointer;width:fit-content">Add more photos<input type="file" id="add-photos" accept="image/jpeg,image/png" multiple style="position:absolute;width:1px;height:1px;opacity:0"></label>' : ''}`}
        <div class="field-hint mt-3" id="photo-summary">${locked ? '' : `${total} photo${total === 1 ? '' : 's'}. `}${lay.capacity} fit on one ${cfg.paperSize} sheet${lay.rotated ? ' (turned to fit more)' : ''}${locked ? '.' : `, so ${sheets} sheet${sheets === 1 ? '' : 's'}.`}</div></div>
      <div class="full field-hint">Printed in colour on glossy paper, with thin guide lines to cut along.</div></div>`;
  } else {
    const documentBundle = C.items.length > 1;
    const pageLabel = documentBundle ? `All ${C.items.reduce((sum, item) => sum + Number(item.upload.pages || 1), 0)} pages across ${C.items.length} files` : locked || !isPdf() ? 'All pages' : `All ${main.upload.pages}`;
    const range = `<div class="field full"><label>Pages</label>${seg('rangeMode', cfg.rangeMode, [['all', pageLabel], ['custom', 'Choose pages', documentBundle]])}${cfg.rangeMode === 'custom' ? `<input id="page-range" value="${esc(cfg.pageRange === 'all' ? '' : cfg.pageRange)}" placeholder="Example: 1-3, 5" inputmode="text" autocomplete="off" aria-describedby="range-msg"><div class="field-hint" id="range-msg"></div>` : ''}</div>`;
    body = `<div class="settings-grid">${range}
      <div class="field"><label for="copies">Copies</label><div class="stepper"><button type="button" data-copies="-1" aria-label="Fewer copies">-</button><input id="copies" type="number" inputmode="numeric" min="1" max="500" value="${cfg.copies}"><button type="button" data-copies="1" aria-label="More copies">+</button></div></div>
      <div class="field"><label>Colour</label>${seg('color', cfg.color, [[false, 'Black and white'], [true, 'Colour', !pc.color]])}</div>
      ${sizeSelect}
      <div class="field"><label for="paper-type">Paper type</label><select id="paper-type" data-select="paperType">${pc.paperTypes.map((t) => `<option value="${t}" ${cfg.paperType === t ? 'selected' : ''}>${t === 'normal' ? 'Normal' : 'Glossy'}</option>`).join('')}</select></div>
      <div class="field"><label>Sides</label>${seg('duplex', cfg.duplex, [[false, 'Single-sided'], [true, 'Double-sided', !pc.duplex || cfg.paperType !== 'normal']])}</div>${orient}
      <div class="field full"><label>Scaling</label>${seg('scaling', cfg.scaling, [['fit', 'Fit to page'], ['fill', 'Fill page'], ['actual', 'Actual size']])}<div class="field-hint">${{ fit: 'Whole page fits inside the printable area.', fill: 'Covers the whole sheet; edges may be cropped.', actual: 'Real size from the top left; large pages are cut off.' }[cfg.scaling]}</div></div></div>`;
  }
  const allImages = C.items.every((item) => item.mime !== 'application/pdf');
  const modeToggle = photoAvailable() && (locked || allImages) ? `<div class="field mb-4" style="margin-bottom:var(--s-5)"><label>What are you printing?</label>${seg('mode', cfg.mode, [['document', 'Documents / pictures'], ['photo', 'Photo sheet']])}</div>` : '';
  const card = document.querySelector('#settings-card');
  card.innerHTML = `<div class="card-title">${icon('sliders')}<div><span class="step">Step 2</span><h2>Print settings</h2></div></div>${modeToggle}<div class="${locked ? 'locked-zone' : ''}" id="settings-zone">${body}${locked ? '<div class="lock-cover" id="lock-cover" aria-hidden="true"></div>' : ''}</div>`;
  wireSettings();
  if (cfg.rangeMode === 'custom' && !locked) validateRange();
}
function normalizeCfg() {
  const { cfg, shop } = C, pc = shop.printConfig;
  if (cfg.mode === 'photo') { cfg.paperType = 'glossy'; cfg.duplex = false; cfg.color = true; }
  else { if (cfg.paperType !== 'normal') cfg.duplex = false; if (!pc.color) cfg.color = false; }
  if (!pc.paperSizes.includes(cfg.paperSize)) cfg.paperSize = pc.paperSizes[0];
}
function afterConfigChange() { normalizeCfg(); renderSettings(); renderEditor(); drawPreview(); scheduleQuote(); }
function wireSettings() {
  const card = document.querySelector('#settings-card'), { cfg } = C;
  // mode toggle works before an upload: it decides what the upload step asks for
  card.querySelectorAll('[data-set="mode"]').forEach((b) => b.onclick = () => {
    cfg.mode = b.dataset.value; if (cfg.mode === 'photo') cfg.orientation = 'portrait';
    C.previewIndex = 0; normalizeCfg();
    if (hasFile() && cfg.mode === 'photo' && isPdf()) { cfg.mode = 'document'; toast('PDFs are printed as documents.'); }
    if (!hasFile()) renderDropzone();
    afterConfigChange();
  });
  if (!hasFile()) {
    const zone = card.querySelector('#settings-zone');
    card.querySelector('#lock-cover')?.addEventListener('click', () => nudgeNeedsFile('option'));
    zone.addEventListener('focusin', (e) => { if (e.target.matches('input,select,button')) { e.target.blur(); nudgeNeedsFile('option'); } });
    return;
  }
  card.querySelectorAll('[data-set]:not([data-set="mode"])').forEach((b) => b.onclick = () => {
    let v = b.dataset.value; const key = b.dataset.set;
    if (key === 'color' || key === 'duplex') v = v === 'true';
    if (key === 'rangeMode') { cfg.rangeMode = v; cfg.pageRange = v === 'all' ? 'all' : ''; C.previewIndex = 0; }
    else cfg[key] = v;
    afterConfigChange();
  });
  card.querySelectorAll('[data-select]').forEach((s) => s.onchange = () => { cfg[s.dataset.select] = s.value; if (s.dataset.select === 'paperType' && s.value !== 'normal') cfg.duplex = false; C.previewIndex = 0; afterConfigChange(); });
  card.querySelectorAll('[data-copies]').forEach((b) => b.onclick = () => { cfg.copies = Math.min(500, Math.max(1, (Number(cfg.copies) || 1) + Number(b.dataset.copies))); card.querySelector('#copies').value = cfg.copies; drawPreview(); scheduleQuote(); });
  const copies = card.querySelector('#copies');
  if (copies) copies.oninput = () => { const n = Number(copies.value); cfg.copies = Number.isInteger(n) && n >= 1 && n <= 500 ? n : 0; copies.setAttribute('aria-invalid', cfg.copies ? 'false' : 'true'); drawPreview(); scheduleQuote(); };
  const range = card.querySelector('#page-range');
  if (range) range.oninput = () => { cfg.pageRange = range.value; C.previewIndex = 0; validateRange(); drawPreview(); scheduleQuote(); };
  card.querySelectorAll('[data-qty]').forEach((b) => b.onclick = () => { const it = C.items[b.dataset.qty]; it.quantity = Math.min(500, Math.max(1, it.quantity + Number(b.dataset.delta))); renderSettings(); drawPreview(); scheduleQuote(); });
  card.querySelectorAll('[data-qty-input]').forEach((inp) => inp.onchange = () => { const it = C.items[inp.dataset.qtyInput], n = Math.round(Number(inp.value)); it.quantity = Number.isFinite(n) ? Math.min(500, Math.max(1, n)) : 1; renderSettings(); drawPreview(); scheduleQuote(); });
  card.querySelectorAll('.photo-row').forEach((row, i) => row.querySelector('img').addEventListener('click', () => { C.editing = i; renderSettings(); renderEditor(); }));
  card.querySelectorAll('[data-remove]').forEach((b) => b.onclick = () => { const [gone] = C.items.splice(Number(b.dataset.remove), 1); URL.revokeObjectURL(gone.url); C.editing = 0; C.previewIndex = 0; C.renderCache.clear(); renderFileCard(); afterConfigChange(); });
  const add = card.querySelector('#add-photos'); if (add) add.onchange = () => { if (add.files.length) handleFiles([...add.files], { adding: true }); add.value = ''; };
}
function validateRange() {
  const box = document.querySelector('#range-msg'), main = mainItem(); if (!box || !main) return true;
  const text = C.cfg.pageRange.trim();
  if (!text) { box.textContent = 'Enter the pages to print.'; box.style.color = 'var(--warn)'; return false; }
  const r = parsePageRange(text, main.upload.pages);
  box.textContent = r.error || `${r.pages.length} of ${main.upload.pages} pages selected`; box.style.color = r.error ? 'var(--bad)' : '';
  return !r.error;
}
function configProblem() {
  const { cfg } = C, main = mainItem(); if (!main) return null;
  if (cfg.mode === 'document') {
    if (!cfg.copies) return 'Copies must be between 1 and 500.';
    if (isPdf() && cfg.rangeMode === 'custom') { if (!cfg.pageRange.trim()) return 'Enter the pages to print.'; const r = parsePageRange(cfg.pageRange, main.upload.pages); if (r.error) return r.error; }
  }
  return null;
}

/* ---------- Photo editor ---------- */
const editingActive = () => hasFile() && (C.cfg.mode === 'photo' || (C.items.length === 1 && !isPdf() && C.cfg.paperType === 'glossy'));
const geometryActive = () => C.cfg.mode === 'photo';
const frameAspect = () => { if (!geometryActive()) return null; const d = C.shop.photoSizes.find((p) => p.id === C.cfg.photoSize); return d.w / d.h; };
const itemEdit = (it) => (editingActive() ? PhotoEdit.cleanEdit(it.edit) : PhotoEdit.cleanEdit({}));
const SLIDERS = [['brightness', 'Brightness'], ['contrast', 'Contrast'], ['saturation', 'Saturation'], ['exposure', 'Exposure'], ['highlights', 'Highlights'], ['shadows', 'Shadows'], ['sharpness', 'Sharpness']];
function renderEditor() {
  const card = document.querySelector('#edit-card'); if (!card) return;
  if (!editingActive()) { card.classList.add('hidden'); card.innerHTML = ''; return; }
  C.editing = Math.min(C.editing, C.items.length - 1);
  const it = C.items[C.editing], e = PhotoEdit.cleanEdit(it.edit), photo = geometryActive(), many = C.items.length > 1;
  const slider = (key, label, min, max, step) => `<div class="slider"><label for="ed-${key}">${label}</label><output id="out-${key}">${fmtVal(key, e[key])}</output><input id="ed-${key}" type="range" min="${min}" max="${max}" step="${step}" value="${e[key]}" data-edit="${key}"></div>`;
  card.classList.remove('hidden');
  card.innerHTML = `<div class="card-title">${icon('photo')}<div><span class="step">Optional</span><h2>Photo editing</h2></div></div>
    <p class="subtext mb-4" style="margin-bottom:var(--s-4)">Quick fixes before printing. The edited photo is what gets sent to the printer.</p>
    ${many ? `<div class="tool-row" style="margin-bottom:var(--s-4)" role="group" aria-label="Choose photo to edit">${C.items.map((p, i) => `<button type="button" class="chip ${i === C.editing ? 'selected' : ''}" data-pick="${i}">Photo ${i + 1}${PhotoEdit.isEdited(p.edit) ? ' *' : ''}</button>`).join('')}</div>` : ''}
    <div class="editor"><div class="edit-frame-wrap"><div class="edit-frame" id="edit-frame"><canvas id="edit-canvas"></canvas></div>${photo ? '<div class="field-hint" style="text-align:center">Zoom in, then drag the photo to reposition it.</div>' : ''}</div>
    <div class="edit-controls"><div class="tool-row"><button type="button" class="chip" data-tool="rot-left">Rotate left</button><button type="button" class="chip" data-tool="rot-right">Rotate right</button><button type="button" class="chip ${e.bw ? 'selected' : ''}" data-tool="bw" aria-pressed="${e.bw}">Black &amp; white</button></div>
      ${photo ? `<div class="stack-sm"><div class="label-caption">Photo fit</div>${seg('photoFit', C.cfg.photoFit, [['cover', 'Fill (crop)'], ['contain', 'Fit whole photo']])}</div>${C.cfg.photoFit === 'cover' ? slider('zoom', 'Zoom', 1, 4, 0.05) : ''}` : ''}
      ${SLIDERS.map(([k, l]) => slider(k, l, k === 'sharpness' ? 0 : -100, 100, 1)).join('')}
      <div class="tool-row"><button type="button" class="button button-light button-small" data-tool="reset">Reset adjustments</button>${many ? '<button type="button" class="button button-light button-small" data-tool="all">Apply to all photos</button>' : ''}</div></div></div>`;
  card.querySelectorAll('[data-pick]').forEach((b) => b.onclick = () => { C.editing = Number(b.dataset.pick); renderSettings(); renderEditor(); });
  card.querySelectorAll('[data-set="photoFit"]').forEach((b) => b.onclick = () => { C.cfg.photoFit = b.dataset.value; afterConfigChange(); });
  card.querySelectorAll('input[data-edit]').forEach((r) => r.addEventListener('input', () => { it.edit[r.dataset.edit] = Number(r.value); card.querySelector('#out-' + r.dataset.edit).textContent = fmtVal(r.dataset.edit, Number(r.value)); scheduleEditRender(); }));
  card.querySelectorAll('[data-tool]').forEach((b) => b.onclick = () => {
    const t = b.dataset.tool;
    if (t === 'rot-left' || t === 'rot-right') { it.edit.rotate = ((Number(it.edit.rotate || 0) + (t === 'rot-right' ? 90 : -90)) % 360 + 360) % 360; it.edit.panX = 0; it.edit.panY = 0; }
    if (t === 'bw') it.edit.bw = !it.edit.bw;
    if (t === 'reset') it.edit = { ...PhotoEdit.DEFAULT_EDIT };
    if (t === 'all') { C.items.forEach((p) => { p.edit = { ...it.edit }; }); toast('Applied to all photos'); }
    renderSettings(); renderEditor(); drawPreview();
  });
  wireEditFrame(it); paintEditFrame(it);
}
const fmtVal = (key, v) => (key === 'zoom' ? `${Number(v).toFixed(2).replace(/\.?0+$/, '')}x` : v > 0 && key !== 'sharpness' ? `+${v}` : String(v));
function scheduleEditRender() { cancelAnimationFrame(timers.edit); timers.edit = requestAnimationFrame(() => { const it = C.items[C.editing]; if (!it) return; paintEditFrame(it); drawPreview(); const dot = document.querySelectorAll('.photo-row')[C.editing]; if (dot && !dot.querySelector('.edited-dot') && PhotoEdit.isEdited(it.edit)) renderSettings(); }); }
function editOptions(it, maxSide) { return { aspect: frameAspect() ?? undefined, fit: C.cfg.photoFit, maxSide }; }
function paintEditFrame(it) {
  const canvas = document.querySelector('#edit-canvas'), frame = document.querySelector('#edit-frame'); if (!canvas || !it.img) return;
  const aspect = frameAspect() || (it.px[0] / it.px[1]);
  const rotated = PhotoEdit.cleanEdit(it.edit).rotate % 180 !== 0, a = frameAspect() ? aspect : (rotated ? it.px[1] / it.px[0] : aspect);
  frame.style.aspectRatio = String(a);
  const out = PhotoEdit.render(it.img, it.edit, { ...editOptions(it, 460) });
  canvas.width = out.width; canvas.height = out.height; canvas.getContext('2d').drawImage(out, 0, 0);
  frame.style.cursor = geometryActive() && C.cfg.photoFit === 'cover' && PhotoEdit.cleanEdit(it.edit).zoom > 1 ? 'grab' : 'default';
}
function wireEditFrame(it) {
  const frame = document.querySelector('#edit-frame'); if (!frame) return;
  let start = null;
  frame.addEventListener('pointerdown', (ev) => {
    if (!geometryActive() || C.cfg.photoFit !== 'cover' || PhotoEdit.cleanEdit(it.edit).zoom <= 1) return;
    start = { x: ev.clientX, y: ev.clientY, px: it.edit.panX || 0, py: it.edit.panY || 0 }; frame.setPointerCapture(ev.pointerId); frame.classList.add('drag');
  });
  frame.addEventListener('pointermove', (ev) => {
    if (!start) return;
    const p = PhotoEdit.plan(it.px[0], it.px[1], it.edit, { aspect: frameAspect(), fit: 'cover' }), w = frame.clientWidth, h = frame.clientHeight;
    const travelX = (p.rw - p.crop.w) / 2, travelY = (p.rh - p.crop.h) / 2;
    if (travelX > 0.5) it.edit.panX = Math.max(-1, Math.min(1, start.px - ((ev.clientX - start.x) * (p.crop.w / w)) / travelX));
    if (travelY > 0.5) it.edit.panY = Math.max(-1, Math.min(1, start.py - ((ev.clientY - start.y) * (p.crop.h / h)) / travelY));
    scheduleEditRender();
  });
  const end = () => { start = null; frame.classList.remove('drag'); };
  frame.addEventListener('pointerup', end); frame.addEventListener('pointercancel', end);
}

// Edited canvas shared by the sheet preview and the editor. Cached per photo, settings and size.
function editedCanvas(it, maxSide) {
  const key = `${it.id}|${PhotoEdit.editKey(itemEdit(it))}|${frameAspect()}|${C.cfg.photoFit}|${maxSide}`;
  if (C.renderCache.has(key)) return C.renderCache.get(key);
  const out = PhotoEdit.render(it.img, itemEdit(it), { aspect: frameAspect() ?? undefined, fit: C.cfg.photoFit, maxSide });
  if (C.renderCache.size > 60) C.renderCache.clear();
  C.renderCache.set(key, out); return out;
}

/* ---------- Preview ---------- */
async function pdfCanvas(n) {
  if (C.pageCache[n]) return C.pageCache[n];
  const page = await C.pdf.getPage(n), vp = page.getViewport({ scale: PDF_SCALE }), canvas = document.createElement('canvas');
  canvas.width = Math.round(vp.width); canvas.height = Math.round(vp.height);
  await page.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise;
  return (C.pageCache[n] = canvas);
}
let drawToken = 0;
async function drawPreview() {
  const card = document.querySelector('#preview-card'); if (!card || !C.cfg) return;
  const token = ++drawToken, { cfg, shop } = C, main = mainItem(), hasF = hasFile();
  card.classList.toggle('is-empty', !hasF);
  const [pw0, ph0] = PAPER_MM[cfg.paperSize] || PAPER_MM.A4, landscape = cfg.orientation === 'landscape';
  const [sw, sh] = landscape ? [ph0, pw0] : [pw0, ph0];
  if (!card.querySelector('.preview-stage')) card.innerHTML = `<div class="card-title">${icon('printer')}<div><span class="step">Live preview</span><h2>How it will print</h2></div></div><div class="preview-stage" id="preview-stage"></div><div class="preview-caption" id="preview-caption"></div>`;
  const stage = card.querySelector('#preview-stage');
  const avail = Math.max(180, Math.min((stage.clientWidth || 320) - 36, landscape ? 400 : 330));
  const k = avail / sw, W = Math.round(sw * k), H = Math.round(sh * k), pm = PRINTER_MARGIN_MM * k;
  let inner = '', label = '', caption = '', warn = '', nav = '', copiesNote = '', empty = false, cellCanvases = [];
  const problem = configProblem();

  if (cfg.mode === 'photo') {
    const dims = shop.photoSizes.find((p) => p.id === cfg.photoSize), lay = photoLayout(dims, cfg.paperSize, cfg.orientation);
    const flat = C.items.flatMap((it) => Array.from({ length: it.quantity }, () => it)), sheetsTotal = Math.max(1, Math.ceil(flat.length / lay.capacity));
    C.previewIndex = Math.min(C.previewIndex, sheetsTotal - 1);
    const cm = k * 10, mg = PHOTO_MARGIN_CM * cm, gap = PHOTO_GAP_CM * cm, dpr = Math.min(2, window.devicePixelRatio || 1);
    const slots = hasF ? flat.slice(C.previewIndex * lay.capacity, (C.previewIndex + 1) * lay.capacity) : Array.from({ length: lay.capacity }, () => null);
    slots.forEach((it, i) => {
      const col = i % lay.columns, row = Math.floor(i / lay.columns), x = mg + col * (lay.cellW * cm + gap), y = mg + row * (lay.cellH * cm + gap);
      const cw = lay.cellW * cm, ch = lay.cellH * cm;
      let content = '';
      if (it) {
        const idx = cellCanvases.push(it) - 1;
        content = lay.rotated ? `<div style="position:absolute;left:${cw}px;top:0;width:${ch}px;height:${cw}px;transform-origin:0 0;transform:rotate(90deg)"><canvas data-ci="${idx}" style="width:100%;height:100%;display:block"></canvas></div>` : `<canvas data-ci="${idx}" style="width:100%;height:100%;display:block"></canvas>`;
      }
      inner += `<div class="cell" style="left:${x}px;top:${y}px;width:${cw}px;height:${ch}px;${it ? '' : 'background:#f3f4f7'}">${content}</div>`;
    });
    label = hasF ? `Sheet ${C.previewIndex + 1} of ${sheetsTotal}` : '';
    caption = hasF ? `${dims.label}, ${lay.capacity} per ${cfg.paperSize} sheet. ${flat.length} photo${flat.length === 1 ? '' : 's'} on ${sheetsTotal} sheet${sheetsTotal === 1 ? '' : 's'}.` : `${dims.label}: ${lay.capacity} fit on one ${cfg.paperSize} sheet. Upload your photos to see them here.`;
    if (hasF && sheetsTotal > 1) nav = navHtml(C.previewIndex + 1, sheetsTotal, 'sheet');
    cellCanvases = { items: cellCanvases, px: Math.max(60, Math.min(500, Math.round(Math.max(lay.cellW, lay.cellH) * cm * dpr))) };
  } else if (!hasF) {
    empty = true;
    caption = `A blank ${cfg.paperSize} sheet. Upload a file to see how it will print.`;
  } else {
    const r = isPdf() ? parsePageRange(cfg.rangeMode === 'custom' ? cfg.pageRange : 'all', main.upload.pages) : { pages: [1] }, pages = r.pages || [];
    if (pages.length) C.previewIndex = Math.min(C.previewIndex, pages.length - 1);
    const pageNo = pages[C.previewIndex] || 1, [cwmm, chmm] = main.pageMm || [210, 297];
    const useEdited = !isPdf() && editingActive();
    const rotated = useEdited && PhotoEdit.cleanEdit(main.edit).rotate % 180 !== 0, [cw0, ch0] = rotated ? [chmm, cwmm] : [cwmm, chmm];
    const pwid = sw - 2 * PRINTER_MARGIN_MM, phei = sh - 2 * PRINTER_MARGIN_MM;
    const s = cfg.scaling === 'actual' ? 1 : cfg.scaling === 'fill' ? Math.max(pwid / cw0, phei / ch0) : Math.min(pwid / cw0, phei / ch0);
    const dw = cw0 * s * k, dh = ch0 * s * k, left = cfg.scaling === 'actual' ? 0 : (pwid * k - dw) / 2, top = cfg.scaling === 'actual' ? 0 : (phei * k - dh) / 2;
    let content = '';
    if (isPdf()) {
      if (C.pdf && pages.length) {
        try { const src = await pdfCanvas(pageNo); if (token !== drawToken) return; content = `<canvas class="content" id="pv-canvas" width="${src.width}" height="${src.height}" style="left:${left}px;top:${top}px;width:${dw}px;height:${dh}px;background:#fff"></canvas>`; C._canvasSrc = src; }
        catch { content = `<div class="content" style="left:${left}px;top:${top}px;width:${dw}px;height:${dh}px;background:#f3f3f3"></div>`; warn = 'This page could not be drawn. It will still print.'; }
      } else content = `<div class="content" style="left:${left}px;top:${top}px;width:${dw}px;height:${dh}px;background:#f3f3f3;border:1px solid #ccc"></div>`;
    } else if (useEdited) { C._canvasSrc = PhotoEdit.render(main.img, main.edit, { maxSide: 900 }); content = `<canvas class="content" id="pv-canvas" width="${C._canvasSrc.width}" height="${C._canvasSrc.height}" style="left:${left}px;top:${top}px;width:${dw}px;height:${dh}px"></canvas>`; }
    else content = `<img class="content" src="${main.url}" alt="Your picture" style="left:${left}px;top:${top}px;width:${dw}px;height:${dh}px">`;
    inner = `<div class="printable" style="left:${pm}px;top:${pm}px;width:${pwid * k}px;height:${phei * k}px"><div class="content-wrap">${content}</div></div>`;
    const total = pages.length, copies = Number(cfg.copies) || 0, sheetsPerCopy = cfg.duplex ? Math.ceil(total / 2) : total;
    label = isPdf() ? `Page ${pageNo}` : '';
    caption = `${isPdf() ? `${total} page${total === 1 ? '' : 's'}` : '1 page'} x ${copies || '?'} cop${copies === 1 ? 'y' : 'ies'} on ${cfg.paperSize}${cfg.paperType === 'glossy' ? ' glossy' : ''}, ${cfg.color ? 'colour' : 'black and white'}. ${cfg.duplex ? `Double-sided: ${sheetsPerCopy} sheet${sheetsPerCopy === 1 ? '' : 's'} per copy.` : ''}`;
    if (cfg.duplex && total) caption += ` Page ${pageNo} is on the ${C.previewIndex % 2 === 0 ? 'front' : 'back'} of sheet ${Math.floor(C.previewIndex / 2) + 1}.`;
    copiesNote = copies > 1 ? 'multi' : '';
    if (total > 1) nav = navHtml(C.previewIndex + 1, total, 'page');
    if (cfg.scaling === 'actual' && (cw0 > pwid + 0.5 || ch0 > phei + 0.5)) warn = 'At actual size this page is larger than the paper, so the edges will be cut off.';
    if (cfg.scaling === 'fill' && Math.abs(pwid / phei - cw0 / ch0) > 0.05) warn = warn || 'Fill page crops the parts that stick out past the paper.';
    if (cfg.orientation === 'landscape' && cw0 < ch0 && cfg.scaling !== 'actual') warn = warn || 'This page is upright but the paper is landscape, so it prints smaller. Choose Portrait to use more of the sheet.';
  }
  if (problem) warn = problem;
  const emptyArt = empty ? `<div class="preview-empty" style="position:absolute;inset:0;justify-content:center;max-width:none;padding:0 12%">${icon('empty')}<span class="subtext" style="color:#6b7280">Your document appears here</span></div>` : '';
  stage.innerHTML = `<div class="stack-paper ${copiesNote}" style="width:${W}px"><div class="sheet ${cfg.color || cfg.mode === 'photo' ? '' : 'bw'}" style="width:${W}px;height:${H}px">${inner}${emptyArt}${label ? `<span class="sheet-label">${esc(label)}</span>` : ''}</div></div>${nav}`;
  const cv = stage.querySelector('#pv-canvas'); if (cv && C._canvasSrc) cv.getContext('2d').drawImage(C._canvasSrc, 0, 0);
  if (cellCanvases.items) stage.querySelectorAll('canvas[data-ci]').forEach((c) => { const it = cellCanvases.items[Number(c.dataset.ci)], src = editedCanvas(it, cellCanvases.px); c.width = src.width; c.height = src.height; c.getContext('2d').drawImage(src, 0, 0); });
  stage.querySelectorAll('[data-nav]').forEach((b) => b.onclick = () => { C.previewIndex = Math.max(0, C.previewIndex + Number(b.dataset.nav)); drawPreview(); });
  card.querySelector('#preview-caption').innerHTML = `${esc(caption)}${warn ? `<div class="preview-warn">${esc(warn)}</div>` : ''}<div class="subtext mt-2">Approximate · dashed line marks the printable area.</div>`;
}
const navHtml = (i, n, noun) => `<div class="preview-nav"><button class="button button-light button-small" data-nav="-1" ${i <= 1 ? 'disabled' : ''} aria-label="Previous ${noun}">&lsaquo;</button><span class="subtext">${noun[0].toUpperCase() + noun.slice(1)} ${i} of ${n}</span><button class="button button-light button-small" data-nav="1" ${i >= n ? 'disabled' : ''} aria-label="Next ${noun}">&rsaquo;</button></div>`;
window.addEventListener('resize', () => { clearTimeout(timers.resize); timers.resize = setTimeout(() => { if (C?.cfg && document.querySelector('#preview-stage')) drawPreview(); }, 200); });

/* ---------- Price and checkout ---------- */
function scheduleQuote() {
  clearTimeout(timers.quote); C.quote = null;
  if (!hasFile()) { renderSummary({}); return; }
  renderSummary({ loading: true });
  const problem = configProblem();
  if (problem) { renderSummary({ error: problem }); return; }
  timers.quote = setTimeout(fetchQuote, 250);
}
function requestConfig(tokens) {
  const { cfg } = C, base = { mode: cfg.mode, paperSize: cfg.paperSize, paperType: cfg.paperType, orientation: cfg.orientation, scaling: cfg.scaling, color: cfg.color, duplex: cfg.duplex };
  if (cfg.mode === 'photo') return { ...base, photoSize: cfg.photoSize, photoFit: cfg.photoFit, photoItems: C.items.map((i, n) => ({ uploadToken: tokens?.[n] || i.upload.uploadToken, quantity: i.quantity, edit: PhotoEdit.isEdited(i.edit) ? PhotoEdit.cleanEdit(i.edit) : undefined })), photoQuantity: C.items[0].quantity };
  const out = { ...base, copies: cfg.copies, pageRange: cfg.rangeMode === 'custom' ? cfg.pageRange.trim() : 'all' };
  if (editingActive() && PhotoEdit.isEdited(C.items[0].edit, { geometry: false })) out.imageEdit = PhotoEdit.cleanEdit(C.items[0].edit);
  return out;
}
function bundleUploadTokens() {
  return C.cfg.mode === 'document' && C.items.length > 1
    ? C.items.map((item) => item.upload.uploadToken)
    : undefined;
}
async function fetchQuote() {
  const rev = ++C.revision;
  try {
    const q = await api(`/shops/${encodeURIComponent(C.shop.id)}/price`, jsonBody({ uploadToken: C.items[0].upload.uploadToken, documentTokens: bundleUploadTokens(), config: requestConfig() }));
    if (rev !== C.revision) return;
    C.quote = q; renderSummary({});
  } catch (e) { if (rev !== C.revision) return; const gone = /expired|does not belong/i.test(e.message); renderSummary({ error: gone ? 'Your upload expired. Choose the file again.' : e.message, expired: gone }); }
}
function renderSummary({ loading, error, expired }) {
  const card = document.querySelector('#summary-card'), bar = document.querySelector('#mobile-total'); if (!card) return;
  const q = C.quote, { cfg, shop } = C, file = hasFile();
  const sheetWord = cfg.mode === 'photo' ? `${q?.sheets || 0} photo sheet${q?.sheets === 1 ? '' : 's'}` : `${q?.pages || 0} page${q?.pages === 1 ? '' : 's'} x ${q?.copies || 0} cop${q?.copies === 1 ? 'y' : 'ies'}`;
  const rows = q ? `<div class="quote-row"><span>${esc(sheetWord)}</span><strong>${q.printablePages ? `${q.printablePages * (q.copies || 1)} sheet${q.printablePages * (q.copies || 1) === 1 ? '' : 's'}` : ''}</strong></div><div class="quote-row"><span>Rate per sheet</span><strong>${money(q.rate)}</strong></div>${q.base && q.photoCharge ? `<div class="quote-row"><span>Printing</span><strong>${money(q.base)}</strong></div>` : ''}${q.photoCharge ? `<div class="quote-row"><span>Photo sheets (${q.sheets})</span><strong>${money(q.photoCharge)}</strong></div>` : ''}<div class="quote-total"><span>Total</span><span>${money(q.total)}</span></div>` : '';
  const ready = Boolean(q) && !error && !C.submitting, locked = !file;
  card.innerHTML = `<div class="card-title">${icon('pay')}<div><span class="step">Step 3</span><h2>Pay and send</h2></div></div>
    <div class="stack">
    ${locked ? `<div class="price-empty">${icon('rupee')}<span>Your price appears once you add a file.</span></div>` : ''}
    ${loading ? '<div class="loading" style="padding:0"><span class="spinner"></span> Calculating price</div>' : ''}${error ? `<div class="inline-notice bad" role="alert">${esc(error)}</div>${expired ? '<button class="button button-light" id="reselect" type="button">Choose file again</button>' : ''}` : ''}${rows ? `<div>${rows}</div>` : ''}
    <details class="fold fold-form" ${C.name || C.phone ? 'open' : ''}><summary>${icon('phone', 18)}<span>Add name or phone <em>(optional)</em></span></summary><div class="settings-grid"><div class="field"><label for="cust-name">Your name</label><input id="cust-name" maxlength="100" autocomplete="name" value="${esc(C.name || '')}"></div><div class="field"><label for="cust-phone">Phone</label><input id="cust-phone" maxlength="40" inputmode="tel" autocomplete="tel" value="${esc(C.phone || '')}"></div></div></details>
    <div class="${locked ? 'locked-zone' : ''}" id="pay-zone"><div class="pay-buttons"><button class="button button-primary button-lg" id="pay-upi" type="button" ${ready && shop.upiConfigured ? '' : 'disabled'}>Pay with UPI</button><button class="button button-lg" id="pay-cash" type="button" ${ready ? '' : 'disabled'}>Pay with cash</button></div>${locked ? '<div class="lock-cover" id="pay-cover" aria-hidden="true"></div>' : ''}</div>
    <div class="form-error" id="order-error" role="alert"></div>
    <div class="pay-note">${shop.upiConfigured ? 'Printing starts after the shop confirms your payment.' : 'This shop has not set up UPI. Pay cash at the counter; printing starts once the shop confirms.'}</div></div>`;
  card.querySelector('#reselect')?.addEventListener('click', () => { revokeUrls(); C.items = []; C.renderCache.clear(); renderDropzone(); renderSettings(); renderEditor(); drawPreview(); renderSummary({}); });
  card.querySelector('#cust-name').oninput = (e) => { C.name = e.target.value; }; card.querySelector('#cust-phone').oninput = (e) => { C.phone = e.target.value; };
  card.querySelector('#pay-cover')?.addEventListener('click', () => nudgeNeedsFile('step'));
  card.querySelector('#pay-upi').onclick = () => submitOrder('upi'); card.querySelector('#pay-cash').onclick = () => submitOrder('cash');
  if (bar) { bar.classList.toggle('hidden', !q); bar.innerHTML = q ? `<div><div class="subtext">Total</div><strong style="font-size:1.15rem">${money(q.total)}</strong></div><a class="button button-primary" href="#summary-card">Pay and send</a>` : ''; }
}

// Edited photos are rendered at print resolution with the same code as the preview, uploaded, and those uploads are what the order prints.
async function bakeEdited(setStatus) {
  if (!editingActive()) return null;
  const photo = geometryActive(), aspect = frameAspect(), dims = photo ? C.shop.photoSizes.find((p) => p.id === C.cfg.photoSize) : null;
  const maxSide = photo ? Math.min(4000, Math.ceil(Math.max(dims.w, dims.h) / 2.54 * 300)) : 4000;
  const tokens = [];
  for (const [n, it] of C.items.entries()) {
    if (!PhotoEdit.isEdited(it.edit, { geometry: photo })) { tokens.push(it.upload.uploadToken); continue; }
    const key = PhotoEdit.editKey(it.edit, `${aspect}|${C.cfg.photoFit}|${maxSide}`);
    if (!it.baked || it.baked.key !== key) {
      setStatus?.(`Preparing photo ${n + 1} of ${C.items.length}`);
      const canvas = PhotoEdit.render(it.img, it.edit, { aspect: photo ? aspect : undefined, fit: C.cfg.photoFit, maxSide });
      const blob = await PhotoEdit.toBlob(canvas, 0.93);
      const base = it.file.name.replace(/\.[^.]+$/, '').slice(0, 80) || 'photo';
      it.baked = { key, upload: await uploadOne(blob, 'image/jpeg', `${base}-edited.jpg`) };
    }
    tokens.push(it.baked.upload.uploadToken);
  }
  return tokens;
}
async function submitOrder(method) {
  if (C.submitting || !C.quote) return;
  const problem = configProblem(); if (problem) return;
  C.submitting = true; const buttons = [...document.querySelectorAll('#pay-upi,#pay-cash')]; buttons.forEach((b) => { b.disabled = true; });
  const errorBox = document.querySelector('#order-error'); errorBox.textContent = '';
  const clicked = document.querySelector(method === 'upi' ? '#pay-upi' : '#pay-cash'), label = clicked.textContent;
  clicked.innerHTML = '<span class="spinner" aria-hidden="true"></span> Preparing order';
  try {
    let tokens = null;
    try { tokens = await bakeEdited((t) => { clicked.textContent = t; }); } catch (e) { throw Object.assign(new Error(`Could not prepare your edited photo. ${e.message}`), { status: 0 }); }
    clicked.innerHTML = '<span class="spinner" aria-hidden="true"></span> Sending order';
    const first = tokens ? tokens[0] : C.items[0].upload.uploadToken;
    const res = await api(`/shops/${encodeURIComponent(C.shop.id)}/orders`, jsonBody({ uploadToken: first, documentTokens: bundleUploadTokens(), paymentMethod: method, config: requestConfig(tokens), expectedAmount: C.quote.total, customerName: (C.name || '').trim(), customerPhone: (C.phone || '').trim() }));
    store.set(orderKey(C.shop.id), res.order.code);
    history.replaceState(null, '', `${location.pathname}?order=${encodeURIComponent(res.order.code)}`);
    C.submitting = false; C.activeOrder = null;
    showOrder(res.order);
  } catch (e) {
    C.submitting = false; clicked.textContent = label;
    if (e.data?.code === 'PRICE_CHANGED') { await fetchQuote(); const box = document.querySelector('#order-error'); if (box) box.textContent = e.message; return; }
    if (e.status === 409 || e.status === 400) { renderSummary({ error: e.message }); return; }
    buttons.forEach((b) => { b.disabled = false; });
    errorBox.textContent = /Failed to fetch|NetworkError/i.test(e.message) ? 'No connection. Nothing was sent. Check your internet and tap again.' : e.message;
  }
}

/* ---------- Order status, UPI and cash ---------- */
function showOrder(order) {
  clearTimers(); C.order = order;
  const s = C.shop, st = order.status;
  if (isTerminal(order)) store.del(orderKey(s.id)); else store.set(orderKey(s.id), order.code);
  C.activeOrder = isActiveOrder(order) ? order : null; setCustomerNav({ viewing: true });
  document.querySelector('#site-footer').classList.add('hidden');
  const homeBtn = `<button class="button button-light" id="back-home" type="button">Back to home</button>`;
  const head = (art, title, text) => `<div class="status-art">${icon(art, 96)}</div><h1>${esc(title)}</h1>${text ? `<p class="lede">${text}</p>` : ''}`;
  const detailRows = `<dt>File</dt><dd>${esc(order.fileName || 'Document')}</dd><dt>Amount</dt><dd>${money(order.amount)}</dd><dt>Payment</dt><dd>${order.paymentMethod === 'upi' ? 'UPI' : 'Cash'}</dd>`;
  const codeRow = `<dt>Order code</dt><dd class="mono">${esc(order.code)}</dd>`;
  const summary = `<dl class="kv">${codeRow}${detailRows}</dl>`, summaryBigCode = `<dl class="kv">${detailRows}</dl>`;
  let body = '', completing = false;
  if (st === 'completed') {
    completing = true;
    body = `${head('success', 'Printed and ready', `Collect your order from ${esc(s.name)}. Show the order code if asked.`)}<div class="success-code">${esc(order.code)}</div>${summaryBigCode}<div class="stack-sm"><button class="button button-primary button-lg" id="back-home" type="button">Back to home</button><p class="countdown" id="countdown">Taking you back to the home page in ${COMPLETE_RETURN_SECONDS} seconds. <button class="text-button" id="stay" type="button">Stay on this page</button></p></div>`;
  } else if (isTerminal(order)) {
    const rejected = ['rejected', 'failed'].includes(order.paymentStatus);
    body = `${head('empty', rejected ? 'Payment not confirmed' : 'Order cancelled', rejected ? `The shop could not find your payment, so this order was not printed. If money left your account, contact ${esc(s.name)}${order.shopPhone ? ` on ${esc(order.shopPhone)}` : ''} and quote the order code.` : 'This order will not be printed.')}${summary}<button class="button button-primary button-lg" id="back-home" type="button">Back to home</button>`;
  } else if (st === 'pending_payment') body = upiScreen(order, head);
  else if (st === 'payment_review') body = `${head('wait', 'Waiting for the shop to confirm', `You told the shop you paid ${money(order.amount)}. The shop checks its UPI account and then sends your file to print. This page updates by itself.`)}${summary}${order.reference ? `<div class="inline-notice mb-4">Transaction reference sent: <span class="mono">${esc(order.reference)}</span></div>` : ''}<div id="live-note"></div><p class="pay-note mt-4">Nothing has been printed yet. If this takes long, show the order code at the counter${order.shopPhone ? ` or call ${esc(order.shopPhone)}` : ''}.</p><div class="mt-5">${homeBtn}</div>`;
  else if (st === 'cash_confirmation_pending') body = `${head('pay', 'Pay cash at the counter', `Show this code at ${esc(s.name)}. Printing starts after cash is confirmed.`)}<div class="success-code">${esc(order.code)}</div>${summaryBigCode}<div id="live-note"></div><div class="cluster mt-5">${homeBtn}<button class="button button-danger" id="cancel-order" type="button">Cancel this order</button></div>`;
  else if (st === 'print_queued') body = `${head('printer', 'Payment confirmed', 'Your file is in the shop\'s print queue.')}${summary}<div id="live-note"></div><div class="mt-5">${homeBtn}</div>`;
  else if (st === 'printing') body = `${head('printer', 'Printing now', 'Your document is being printed. It will be ready at the counter shortly.')}${summary}<div id="live-note"></div><div class="mt-5">${homeBtn}</div>`;
  else if (st === 'failed') body = `${head('info', 'There was a problem printing', `The shop has been told. Show the order code to ${esc(s.name)}${order.shopPhone ? ` or call ${esc(order.shopPhone)}` : ''} and they will retry it.`)}<div class="success-code">${esc(order.code)}</div>${summaryBigCode}<div id="live-note"></div><div class="mt-5">${homeBtn}</div>`;
  else body = `${head('wait', 'Order received', 'The shop is processing your order.')}${summary}<div id="live-note"></div><div class="mt-5">${homeBtn}</div>`;
  app.innerHTML = `<div class="page"><section class="card status-card"><div id="net-banner" class="inline-notice warn hidden mb-4" style="margin-bottom:var(--s-4)" role="status">Connection lost. Retrying...</div>${body}</section>${creditLine()}</div>`;
  window.scrollTo({ top: 0, behavior: 'instant' });
  document.querySelector('#back-home')?.addEventListener('click', goHome);
  document.querySelector('#cancel-order')?.addEventListener('click', () => customerOrderAction('cancel', 'Cancel this order?'));
  if (completing) {
    let left = COMPLETE_RETURN_SECONDS;
    timers.home = setInterval(() => { left--; const el = document.querySelector('#countdown'); if (left <= 0) { clearInterval(timers.home); goHome(); } else if (el?.firstChild) el.firstChild.textContent = `Taking you back to the home page in ${left} second${left === 1 ? '' : 's'}. `; }, 1000);
    document.querySelector('#stay')?.addEventListener('click', () => { clearInterval(timers.home); const el = document.querySelector('#countdown'); if (el) el.textContent = 'You can go back to the home page whenever you like.'; });
  }
  wireUpi(order);
  if (!isTerminal(order)) startPolling(order);
}
function upiScreen(order, head) {
  const u = order.upi, phone = isTouchPhone(), s = C.shop;
  const homeBtn = `<button class="button button-light" id="back-home" type="button">Back to home</button>`;
  if (!u) return `${head('info', 'UPI link not available', 'Switch to cash or cancel this order.')}<div class="cluster mt-5"><button class="button" id="switch-cash" type="button">Pay cash instead</button>${homeBtn}</div>`;
  const copy = (v, label) => `<div class="copy-row"><span class="mono">${esc(v)}</span><button class="button button-light button-small" type="button" data-copy="${esc(v)}" aria-label="Copy ${label}">Copy</button></div>`;
  return `${head('pay', `Pay ${money(order.amount)} to ${u.payee}`, phone ? 'Opens a UPI app on your phone. Amount and shop are filled in.' : 'Scan this QR with a UPI app on your phone. Amount and shop are filled in.')}
  <div class="stack mt-5">
  ${phone ? `<a class="button button-primary button-lg button-block" id="upi-open" href="${esc(u.uri)}">Open UPI app to pay ${money(order.amount)}</a>` : `<img class="upi-qr" src="${u.qr}" alt="UPI payment QR code for ${money(order.amount)}"><a class="button button-light button-block" id="upi-open" href="${esc(u.uri)}">Try opening a UPI app on this device</a>`}
  <div class="inline-notice warn hidden" id="upi-hint" role="status">No UPI app opened, or you came back? This page cannot see your payment. Try again, scan the QR with another phone, pay using the details below, or choose cash.</div>
  <details class="fold" ${phone ? '' : 'open'}><summary>${icon('pay', 18)}<span>Pay manually or scan QR</span></summary><dl class="kv" style="margin:var(--s-3) 0 0"><dt>Pay to</dt><dd>${copy(u.id, 'UPI ID')}</dd><dt>Amount</dt><dd>${copy(Number(order.amount).toFixed(2), 'amount')}</dd><dt>Note</dt><dd>${copy(order.code, 'order code')}</dd></dl>${phone ? `<img class="upi-qr" src="${u.qr}" alt="UPI payment QR code">` : ''}</details>
  <div class="inset-card stack-sm" id="paid-box"><h3>After you pay</h3><p class="subtext">Come back here and tell the shop.</p>
    <div class="field"><label for="utr">UPI transaction ID (optional)</label><input id="utr" inputmode="text" autocomplete="off" maxlength="30" placeholder="Example: 412345678901"></div>
    <div class="form-error" id="claim-error" role="alert"></div>
    <button class="button button-primary button-lg button-block" id="claim-paid" type="button">I have paid</button></div>
  <div class="cluster"><button class="button button-light" id="switch-cash" type="button">Pay cash instead</button><button class="button button-danger" id="cancel-order" type="button">Cancel order</button>${homeBtn}</div>
  <div id="live-note"></div><div class="pay-note">Tap “I have paid” only after the money has left your account.</div></div>`;
}
function wireUpi(order) {
  document.querySelectorAll('[data-copy]').forEach((b) => b.onclick = async () => { try { await navigator.clipboard.writeText(b.dataset.copy); toast('Copied'); } catch { toast(b.dataset.copy); } });
  document.querySelector('#switch-cash')?.addEventListener('click', () => customerOrderAction('switch-cash', 'Pay at the counter with cash instead?'));
  document.querySelector('#claim-paid')?.addEventListener('click', claimPaid);
  const open = document.querySelector('#upi-open');
  if (open) {
    const showFallback = () => {
      if (document.visibilityState !== 'visible') return;
      C.upiOpened = false;
      document.querySelector('#upi-hint')?.classList.remove('hidden');
      const box = document.querySelector('#paid-box');
      if (box) { box.scrollIntoView({ behavior: 'smooth', block: 'center' }); box.classList.remove('pulse'); void box.offsetWidth; box.classList.add('pulse'); }
    };
    open.addEventListener('click', (event) => {
      event.preventDefault();
      const href = open.getAttribute('href');
      if (!href) return;
      C.upiOpened = true;
      clearTimeout(timers.hint);
      const started = Date.now();
      window.location.href = href;
      timers.hint = setTimeout(() => {
        if (document.visibilityState === 'visible' && Date.now() - started > 1200) showFallback();
      }, 1800);
    });
  }
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible' || !C?.upiOpened || C.order?.status !== 'pending_payment') return;
  C.upiOpened = false; clearTimeout(timers.hint);
  document.querySelector('#upi-hint')?.classList.remove('hidden');
  const box = document.querySelector('#paid-box'); if (box) { box.scrollIntoView({ behavior: 'smooth', block: 'center' }); box.classList.remove('pulse'); void box.offsetWidth; box.classList.add('pulse'); }
});
async function claimPaid() {
  const btn = document.querySelector('#claim-paid'), err = document.querySelector('#claim-error'); if (btn.disabled) return;
  const utr = document.querySelector('#utr').value.trim(); err.textContent = '';
  if (utr && !/^[A-Za-z0-9]{6,30}$/.test(utr)) { err.textContent = 'A transaction ID has 6 to 30 letters and numbers. Leave it empty if you do not have it.'; return; }
  btn.disabled = true; btn.innerHTML = '<span class="spinner" aria-hidden="true"></span> Sending';
  try { await api(`/orders/${encodeURIComponent(C.order.code)}/payment-claim`, jsonBody({ reference: utr })); const { order } = await api(`/orders/${encodeURIComponent(C.order.code)}`); showOrder(order); }
  catch (e) { err.textContent = /Failed to fetch|NetworkError/i.test(e.message) ? 'No connection. Nothing was sent. Tap again when you are online.' : e.message; btn.disabled = false; btn.textContent = 'I have paid'; }
}
async function customerOrderAction(action, question) {
  if (!(await confirmDialog({ title: question, message: action === 'cancel' ? 'It will not be printed.' : 'The shop will take cash at the counter.', confirmLabel: action === 'cancel' ? 'Cancel order' : 'Pay cash instead', cancelLabel: 'Keep as is', tone: action === 'cancel' ? 'danger' : 'primary' }))) return;
  const button = document.querySelector(action === 'switch-cash' ? '#switch-cash' : '#cancel-order'), label = button?.textContent;
  if (button) { button.disabled = true; button.innerHTML = '<span class="spinner" aria-hidden="true"></span> Updating'; }
  try { await api(`/orders/${encodeURIComponent(C.order.code)}/${action}`, jsonBody({})); const { order } = await api(`/orders/${encodeURIComponent(C.order.code)}`); showOrder(order); if (action === 'switch-cash') toast('Switched to cash. Pay at the counter.'); }
  catch (e) { toast(e.message); if (button) { button.disabled = false; button.textContent = label; } try { const { order } = await api(`/orders/${encodeURIComponent(C.order.code)}`); if (order.status !== C.order.status) showOrder(order); } catch { /* keep screen */ } }
}
function startPolling(order) {
  let failures = 0;
  const every = order.status === 'failed' ? 15000 : 5000;
  const tick = async () => {
    try {
      const s = await api(`/orders/${encodeURIComponent(order.code)}/status`);
      failures = 0; document.querySelector('#net-banner')?.classList.add('hidden');
      if (s.order_status !== order.status || s.payment_status !== order.paymentStatus) { const { order: fresh } = await api(`/orders/${encodeURIComponent(order.code)}`); showOrder(fresh); return; }
      const note = document.querySelector('#live-note');
      if (note) {
        const off = !s.printer_online && ['print_queued', 'cash_confirmation_pending', 'payment_review', 'pending_payment'].includes(s.order_status);
        note.innerHTML = `${s.ahead ? `<div class="inline-notice mt-3">${s.ahead} job${s.ahead === 1 ? '' : 's'} ahead of yours.</div>` : ''}${off ? '<div class="inline-notice warn mt-3">The shop\'s print computer is offline. Your order is safe and prints when it reconnects.</div>' : ''}`;
      }
    } catch (e) {
      if (e.status === 404) { store.del(orderKey(C.shop.id)); goHome(); return; }
      failures++; document.querySelector('#net-banner')?.classList.remove('hidden');
    }
    timers.poll = setTimeout(tick, Math.min(every * (1 + failures), 30000));
  };
  timers.poll = setTimeout(tick, every);
}
