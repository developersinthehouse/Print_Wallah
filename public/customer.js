/* Customer portal. Loaded before app.js; uses its helpers (api, esc, money, toast, jsonBody, app, setHeading) at call time. */
'use strict';

const PAPER_MM = { A4: [210, 297], A3: [297, 420] };
const PRINTER_MARGIN_MM = 4; // typical unprintable edge, shown as the dashed printable area
const IMAGE_DPI = 150;
const PHOTO_MARGIN_CM = 1, PHOTO_GAP_CM = 0.2; // must match src/routes/api.js
const PDF_SCALE = 1.5;
const isTouchPhone = () => /Android|iPhone|iPad|iPod/i.test(navigator.userAgent) || (navigator.maxTouchPoints > 1 && matchMedia('(pointer:coarse)').matches);

// Same grid maths as the server's photoGeometry so the preview matches the printed sheet.
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
function errorScreen(title, message) { return `<section class="login-wrap"><div class="card"><h1>${esc(title)}</h1><p class="lede">${esc(message)}</p><button class="button" type="button" data-reload>Try again</button></div></section>`; }

let C = null; // portal state
const timers = { poll: null, quote: null, hint: null, resize: null };
function clearTimers() { Object.values(timers).forEach((t) => { clearTimeout(t); clearInterval(t); }); }
function revokeUrls() { (C?.items || []).forEach((i) => i.url && URL.revokeObjectURL(i.url)); }

async function renderCustomer(shopId) {
  clearTimers();
  try {
    const { shop } = await api(`/shops/${encodeURIComponent(shopId)}/public`);
    window.MAX_UPLOAD_MB = shop.maxUploadMb || 30;
    setHeading(shop.name);
    document.title = `${shop.name} | Print Wallah`;
    C = { shop, items: [], cfg: null, quote: null, revision: 0, submitting: false, previewIndex: 0, pdf: null, pdfPage: null, pageCache: {}, upiOpened: false };
    const code = new URLSearchParams(location.search).get('order') || store.get(orderKey(shop.id));
    if (code) {
      try {
        const { order } = await api(`/orders/${encodeURIComponent(code)}`);
        if (order.shopId === shop.id) { showOrder(order); return; }
      } catch (e) { if (e.status === 404) { store.del(orderKey(shop.id)); history.replaceState(null, '', location.pathname); } else { app.innerHTML = errorScreen('Could not load your order', e.message); return; } }
    }
    renderPortal();
  } catch (e) {
    const closed = e.status === 423 || e.status === 404;
    app.innerHTML = errorScreen(e.status === 404 ? 'Shop not found' : e.status === 423 ? 'This shop is not taking orders' : 'Could not open this shop', e.status === 404 ? 'Check the link or scan the shop QR code again.' : e.message);
    if (closed) app.querySelector('[data-reload]')?.remove();
  }
}

/* ---------- Upload ---------- */
function portalShell() {
  const s = C.shop;
  app.innerHTML = `<div class="portal-head"><h1>${esc(s.name)}</h1><p>${esc([s.address, s.city].filter(Boolean).join(', '))}${s.phone ? ` | ${esc(s.phone)}` : ''}</p></div>
  ${s.printerOnline ? '' : '<div class="inline-notice warn" style="margin-bottom:16px">The shop\'s print computer is not connected right now. You can still place your order; it prints when the shop reconnects.</div>'}
  <div class="portal-grid"><div class="portal-col"><section class="card" id="file-card" style="order:1"></section><section class="card hidden" id="settings-card" style="order:3"></section></div>
  <div class="portal-col sticky-col"><section class="card preview-card hidden" id="preview-card" style="order:2"></section><section class="card hidden" id="summary-card" style="order:4"></section></div></div>
  <div class="mobile-total hidden" id="mobile-total"></div>`;
}
function renderPortal() {
  portalShell();
  renderDropzone();
}
function renderDropzone() {
  const card = document.querySelector('#file-card');
  const types = C.shop.printConfig.photo ? 'PDF, JPG or PNG' : 'PDF, JPG or PNG';
  card.innerHTML = `<h2>1. Choose your file</h2><label class="dropzone" id="dropzone"><input type="file" id="file-input" accept="application/pdf,image/jpeg,image/png,.pdf,.jpg,.jpeg,.png" multiple><strong>Tap to choose a file</strong><span class="subtext">${types}, up to ${window.MAX_UPLOAD_MB || 30} MB. ${C.shop.printConfig.photo ? 'Select several photos to put them on one sheet.' : ''}</span></label><div class="form-error" id="upload-error" style="margin-top:10px"></div><div class="progress hidden" id="upload-progress"><span></span></div>`;
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
function uploadOne(file, mime, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest(), data = new FormData();
    data.append('document', new Blob([file], { type: mime }), file.name);
    xhr.open('POST', `/api/shops/${encodeURIComponent(C.shop.id)}/uploads`);
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(e.loaded / e.total); };
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
  const photoOk = C.shop.printConfig.photo && C.shop.printConfig.paperTypes.includes('glossy');
  const pdfPick = accepted.find((a) => a.mime === 'application/pdf');
  if (adding) accepted = accepted.filter((a) => a.mime !== 'application/pdf');
  else if (pdfPick) { if (accepted.length > 1) toast('Documents are printed one PDF at a time. Using the first PDF.'); accepted = [pdfPick]; }
  else if (!photoOk) accepted = accepted.slice(0, 1);
  if (adding && C.items.length + accepted.length > 12) { accepted = accepted.slice(0, 12 - C.items.length); toast('A photo sheet can hold up to 12 different photos.'); }
  if (!accepted.length) return;
  if (errorBox) errorBox.textContent = '';
  bar?.classList.remove('hidden');
  const added = [];
  try {
    for (const [i, a] of accepted.entries()) {
      const up = await uploadOne(a.file, a.mime, (p) => { if (bar) bar.firstElementChild.style.width = `${Math.round(((i + p) / accepted.length) * 100)}%`; });
      added.push({ upload: up, file: a.file, mime: a.mime, url: a.mime === 'application/pdf' ? null : URL.createObjectURL(a.file), quantity: 1 });
    }
  } catch (e) { show(e.message); bar?.classList.add('hidden'); if (!added.length) return; }
  if (!added.length) return;
  if (adding) { C.items.push(...added); C.cfg.photoQuantityDirty = true; renderSettings(); refreshAll(); return; }
  C.items = added;
  await setupDocument();
}
async function setupDocument() {
  const main = C.items[0];
  const pc = C.shop.printConfig;
  let orientation = 'portrait';
  C.pdf = null; C.pageCache = {}; C.previewIndex = 0;
  if (main.mime === 'application/pdf') {
    try {
      if (!window.pdfjsLib) throw new Error('viewer missing');
      pdfjsLib.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs/pdf.worker.min.js';
      C.pdf = await pdfjsLib.getDocument({ data: new Uint8Array(await main.file.arrayBuffer()) }).promise;
      const first = await C.pdf.getPage(1); const v = first.getViewport({ scale: 1 });
      main.pageMm = [v.width * 25.4 / 72, v.height * 25.4 / 72];
      if (v.width > v.height) orientation = 'landscape';
    } catch (e) { console.warn('PDF preview unavailable:', e.message); main.pageMm = [210, 297]; C.previewFailed = true; }
  } else {
    const dims = await new Promise((res) => { const img = new Image(); img.onload = () => res([img.naturalWidth, img.naturalHeight]); img.onerror = () => res(null); img.src = main.url; });
    if (!dims) { C.items = []; document.querySelector('#upload-error').textContent = 'This image could not be opened. Try saving it again as JPG or PNG.'; return; }
    main.px = dims; main.pageMm = dims.map((p) => p * 25.4 / IMAGE_DPI);
    if (dims[0] > dims[1]) orientation = 'landscape';
  }
  const isImage = main.mime !== 'application/pdf';
  const photoOk = pc.photo && pc.paperTypes.includes('glossy') && isImage;
  C.cfg = {
    mode: photoOk && C.items.length > 1 ? 'photo' : 'document',
    paperSize: pc.paperSizes.includes(pc.defaultPaper) ? pc.defaultPaper : pc.paperSizes[0],
    paperType: pc.paperTypes.includes('normal') ? 'normal' : pc.paperTypes[0],
    orientation, scaling: 'fit', color: false, duplex: false, copies: 1, pageRange: 'all', rangeMode: 'all',
    photoSize: C.shop.photoSizes[0].id, photoFit: 'cover',
  };
  if (C.cfg.mode === 'photo') C.cfg.orientation = 'portrait';
  normalizeCfg(); renderFileCard(); renderSettings(); refreshAll();
  document.querySelector('#settings-card').classList.remove('hidden');
  document.querySelector('#preview-card').classList.remove('hidden');
  document.querySelector('#summary-card').classList.remove('hidden');
}
function renderFileCard() {
  const main = C.items[0], many = C.items.length > 1;
  const name = many ? `${C.items.length} photos` : main.upload.fileName;
  const meta = main.mime === 'application/pdf' ? `${main.upload.pages} page${main.upload.pages === 1 ? '' : 's'} | ${formatBytes(main.upload.size)}` : many ? 'Photos' : `${main.upload.width || main.px[0]} x ${main.upload.height || main.px[1]} px | ${formatBytes(main.upload.size)}`;
  document.querySelector('#file-card').innerHTML = `<div class="file-line"><div class="file-meta"><div class="label-caption muted">Your file</div><div class="file-name">${esc(name)}</div><div class="subtext">${esc(meta)}</div></div><button class="button button-light button-small" id="change-file" type="button">Change</button></div>${C.previewFailed ? '<div class="inline-notice warn" style="margin-top:12px">This PDF could not be previewed here, but it can still be printed. The preview shows a blank page.</div>' : ''}`;
  document.querySelector('#change-file').onclick = () => { revokeUrls(); C.items = []; C.cfg = null; C.quote = null; C.previewFailed = false; ['settings-card', 'preview-card', 'summary-card', 'mobile-total'].forEach((id) => document.querySelector('#' + id)?.classList.add('hidden')); renderDropzone(); };
}

/* ---------- Settings ---------- */
const seg = (name, value, options) => `<div class="segmented" role="group" aria-label="${esc(name)}">${options.map(([v, label, disabled]) => `<button type="button" data-set="${name}" data-value="${esc(v)}" class="${String(value) === String(v) ? 'selected' : ''}" aria-pressed="${String(value) === String(v)}" ${disabled ? 'disabled' : ''}>${esc(label)}</button>`).join('')}</div>`;
function renderSettings() {
  const { cfg, shop } = C, pc = shop.printConfig, main = C.items[0], isPdf = main.mime === 'application/pdf';
  const photoOk = pc.photo && pc.paperTypes.includes('glossy') && main.mime !== 'application/pdf';
  const sizeSelect = `<div class="field"><label for="paper-size">Paper size</label><select id="paper-size" data-select="paperSize">${pc.paperSizes.map((s) => `<option ${cfg.paperSize === s ? 'selected' : ''}>${s}</option>`).join('')}</select></div>`;
  const orient = `<div class="field"><label>Orientation</label>${seg('orientation', cfg.orientation, [['portrait', 'Portrait'], ['landscape', 'Landscape']])}</div>`;
  let body;
  if (cfg.mode === 'photo') {
    const lay = photoLayout(shop.photoSizes.find((p) => p.id === cfg.photoSize), cfg.paperSize, cfg.orientation);
    const total = C.items.reduce((n, i) => n + i.quantity, 0);
    body = `<div class="settings-grid"><div class="field"><label for="photo-size">Photo size</label><select id="photo-size" data-select="photoSize">${shop.photoSizes.map((p) => `<option value="${p.id}" ${cfg.photoSize === p.id ? 'selected' : ''}>${esc(p.label)}</option>`).join('')}</select></div>${sizeSelect}
      <div class="field"><label>Photo fit</label>${seg('photoFit', cfg.photoFit, [['cover', 'Crop to fill'], ['contain', 'Whole photo']])}</div>${orient}
      <div class="field full"><label>Photos and how many of each</label><div class="photo-list">${C.items.map((it, i) => `<div class="photo-row"><img src="${it.url}" alt=""><div class="file-meta"><div class="file-name">${esc(it.upload.fileName)}</div></div><div class="stepper"><button type="button" data-qty="${i}" data-delta="-1" aria-label="Fewer">-</button><input type="number" inputmode="numeric" min="1" max="500" value="${it.quantity}" data-qty-input="${i}" aria-label="Quantity of ${esc(it.upload.fileName)}"><button type="button" data-qty="${i}" data-delta="1" aria-label="More">+</button></div>${C.items.length > 1 ? `<button type="button" class="button button-light button-small remove" data-remove="${i}">Remove</button>` : ''}</div>`).join('')}</div>
        ${C.items.length < 12 ? '<label class="button button-light button-small" style="margin-top:10px;cursor:pointer;width:fit-content">Add more photos<input type="file" id="add-photos" accept="image/jpeg,image/png" multiple style="position:absolute;width:1px;height:1px;opacity:0"></label>' : ''}
        <div class="field-hint" style="margin-top:8px" id="photo-summary">${total} photo${total === 1 ? '' : 's'}, ${lay.capacity} fit on one ${cfg.paperSize} sheet${lay.rotated ? ' (turned to fit more)' : ''}, so ${Math.ceil(total / lay.capacity)} sheet${Math.ceil(total / lay.capacity) === 1 ? '' : 's'}.</div></div>
      <div class="full inline-notice">Photo sheets print on glossy paper in colour. Thin guide lines show where to cut.</div></div>`;
  } else {
    const range = isPdf ? `<div class="field full"><label>Pages</label>${seg('rangeMode', cfg.rangeMode, [['all', `All ${main.upload.pages}`], ['custom', 'Choose pages']])}${cfg.rangeMode === 'custom' ? `<input id="page-range" value="${esc(cfg.pageRange === 'all' ? '' : cfg.pageRange)}" placeholder="Example: 1-3, 5" inputmode="text" autocomplete="off" aria-describedby="range-msg"><div class="field-hint" id="range-msg"></div>` : ''}</div>` : '';
    body = `<div class="settings-grid">${range}
      <div class="field"><label for="copies">Copies</label><div class="stepper"><button type="button" data-copies="-1" aria-label="Fewer copies">-</button><input id="copies" type="number" inputmode="numeric" min="1" max="500" value="${cfg.copies}"><button type="button" data-copies="1" aria-label="More copies">+</button></div></div>
      <div class="field"><label>Colour</label>${seg('color', cfg.color, [[false, 'Black and white'], [true, 'Colour', !pc.color]])}</div>
      ${sizeSelect}
      <div class="field"><label for="paper-type">Paper type</label><select id="paper-type" data-select="paperType">${pc.paperTypes.map((t) => `<option value="${t}" ${cfg.paperType === t ? 'selected' : ''}>${t === 'normal' ? 'Normal' : 'Glossy'}</option>`).join('')}</select></div>
      <div class="field"><label>Sides</label>${seg('duplex', cfg.duplex, [[false, 'Single-sided'], [true, 'Double-sided', !pc.duplex || cfg.paperType !== 'normal']])}</div>${orient}
      <div class="field full"><label>Scaling</label>${seg('scaling', cfg.scaling, [['fit', 'Fit to page'], ['fill', 'Fill page'], ['actual', 'Actual size']])}<div class="field-hint">${{ fit: 'The whole page is shrunk or enlarged to fit inside the printable area.', fill: 'Page covers the whole sheet. Edges may be cropped.', actual: 'Printed at its real size from the top left. Large pages are cut off.' }[cfg.scaling]}</div></div></div>`;
  }
  const modeToggle = photoOk ? `<div class="field" style="margin-bottom:14px"><label>What are you printing?</label>${seg('mode', cfg.mode, [['document', 'Document or picture'], ['photo', 'Photo sheet']])}</div>` : '';
  document.querySelector('#settings-card').innerHTML = `<h2>2. Print settings</h2>${modeToggle}${body}`;
  wireSettings();
  if (cfg.rangeMode === 'custom') validateRange();
}
function normalizeCfg() {
  const { cfg, shop } = C, pc = shop.printConfig;
  if (cfg.mode === 'photo') { cfg.paperType = 'glossy'; cfg.duplex = false; cfg.color = true; }
  else { if (cfg.paperType !== 'normal') cfg.duplex = false; if (!pc.color) cfg.color = false; }
  if (!pc.paperSizes.includes(cfg.paperSize)) cfg.paperSize = pc.paperSizes[0];
}
function wireSettings() {
  const card = document.querySelector('#settings-card'), { cfg } = C;
  card.querySelectorAll('[data-set]').forEach((b) => b.onclick = () => {
    let v = b.dataset.value; const key = b.dataset.set;
    if (key === 'color' || key === 'duplex') v = v === 'true';
    if (key === 'rangeMode') { cfg.rangeMode = v; if (v === 'all') cfg.pageRange = 'all'; else cfg.pageRange = ''; C.previewIndex = 0; }
    else cfg[key] = v;
    if (key === 'mode') { if (v === 'photo') cfg.orientation = 'portrait'; C.previewIndex = 0; }
    normalizeCfg(); renderSettings(); refreshAll();
  });
  card.querySelectorAll('[data-select]').forEach((s) => s.onchange = () => { cfg[s.dataset.select] = s.value; if (s.dataset.select === 'paperType' && s.value !== 'normal') cfg.duplex = false; normalizeCfg(); renderSettings(); refreshAll(); });
  card.querySelectorAll('[data-copies]').forEach((b) => b.onclick = () => { cfg.copies = Math.min(500, Math.max(1, (Number(cfg.copies) || 1) + Number(b.dataset.copies))); card.querySelector('#copies').value = cfg.copies; refreshAll(); });
  const copies = card.querySelector('#copies');
  if (copies) copies.oninput = () => { const n = Number(copies.value); cfg.copies = Number.isInteger(n) && n >= 1 && n <= 500 ? n : 0; copies.setAttribute('aria-invalid', cfg.copies ? 'false' : 'true'); refreshAll(); };
  const range = card.querySelector('#page-range');
  if (range) range.oninput = () => { cfg.pageRange = range.value; C.previewIndex = 0; validateRange(); refreshAll(); };
  card.querySelectorAll('[data-qty]').forEach((b) => b.onclick = () => { const it = C.items[b.dataset.qty]; it.quantity = Math.min(500, Math.max(1, it.quantity + Number(b.dataset.delta))); renderSettings(); refreshAll(); });
  card.querySelectorAll('[data-qty-input]').forEach((inp) => inp.onchange = () => { const it = C.items[inp.dataset.qtyInput], n = Math.round(Number(inp.value)); it.quantity = Number.isFinite(n) ? Math.min(500, Math.max(1, n)) : 1; renderSettings(); refreshAll(); });
  card.querySelectorAll('[data-remove]').forEach((b) => b.onclick = () => { const [gone] = C.items.splice(Number(b.dataset.remove), 1); URL.revokeObjectURL(gone.url); if (!C.items[0].pageMm) C.items[0].pageMm = [210, 297]; C.previewIndex = 0; renderFileCard(); renderSettings(); refreshAll(); });
  const add = card.querySelector('#add-photos'); if (add) add.onchange = () => { if (add.files.length) handleFiles([...add.files], { adding: true }); add.value = ''; };
}
function validateRange() {
  const box = document.querySelector('#range-msg'), main = C.items[0]; if (!box) return true;
  const text = C.cfg.pageRange.trim();
  if (!text) { box.textContent = 'Enter the pages to print.'; box.style.color = 'var(--warn)'; return false; }
  const r = parsePageRange(text, main.upload.pages);
  box.textContent = r.error || `${r.pages.length} of ${main.upload.pages} pages selected`; box.style.color = r.error ? 'var(--bad)' : '';
  return !r.error;
}
function configProblem() {
  const { cfg } = C, main = C.items[0];
  if (cfg.mode === 'document') {
    if (!cfg.copies) return 'Copies must be between 1 and 500.';
    if (main.mime === 'application/pdf' && cfg.rangeMode === 'custom') { const r = parsePageRange(cfg.pageRange, main.upload.pages); if (!cfg.pageRange.trim()) return 'Enter the pages to print.'; if (r.error) return r.error; }
  }
  return null;
}
function requestConfig() {
  const { cfg } = C, base = { mode: cfg.mode, paperSize: cfg.paperSize, paperType: cfg.paperType, orientation: cfg.orientation, scaling: cfg.scaling, color: cfg.color, duplex: cfg.duplex };
  if (cfg.mode === 'photo') return { ...base, photoSize: cfg.photoSize, photoFit: cfg.photoFit, photoItems: C.items.map((i) => ({ uploadToken: i.upload.uploadToken, quantity: i.quantity })), photoQuantity: C.items[0].quantity };
  return { ...base, copies: cfg.copies, pageRange: cfg.rangeMode === 'custom' ? cfg.pageRange.trim() : 'all' };
}

/* ---------- Preview ---------- */
function refreshAll() { drawPreview(); scheduleQuote(); }
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
  const token = ++drawToken, { cfg, shop } = C, main = C.items[0];
  const [pw0, ph0] = PAPER_MM[cfg.paperSize] || PAPER_MM.A4;
  const landscape = cfg.orientation === 'landscape';
  const [sw, sh] = landscape ? [ph0, pw0] : [pw0, ph0]; // sheet in mm
  let html = '', caption = '', warn = '', nav = '';
  const problem = configProblem();
  if (!card.querySelector('.preview-stage')) card.innerHTML = '<h2>Preview</h2><div class="preview-stage" id="preview-stage"></div><div class="preview-caption" id="preview-caption"></div>';
  const stage = card.querySelector('#preview-stage');
  const avail = Math.max(180, Math.min((stage.clientWidth || 320) - 36, landscape ? 400 : 330));
  const k = avail / sw; // px per mm
  const W = Math.round(sw * k), H = Math.round(sh * k);
  const pm = PRINTER_MARGIN_MM * k;
  let inner = '', label = '';
  let copiesNote = '', sheetsTotal = 1;

  if (cfg.mode === 'photo') {
    const dims = shop.photoSizes.find((p) => p.id === cfg.photoSize), lay = photoLayout(dims, cfg.paperSize, cfg.orientation);
    const flat = C.items.flatMap((it) => Array.from({ length: it.quantity }, () => it));
    sheetsTotal = Math.ceil(flat.length / lay.capacity);
    C.previewIndex = Math.min(C.previewIndex, sheetsTotal - 1);
    const slice = flat.slice(C.previewIndex * lay.capacity, (C.previewIndex + 1) * lay.capacity);
    const cm = k * 10, mg = PHOTO_MARGIN_CM * cm, gap = PHOTO_GAP_CM * cm;
    slice.forEach((it, i) => {
      const col = i % lay.columns, row = Math.floor(i / lay.columns), x = mg + col * (lay.cellW * cm + gap), y = mg + row * (lay.cellH * cm + gap);
      const fit = cfg.photoFit === 'contain' ? 'contain' : 'cover';
      const img = lay.rotated
        ? `<div style="position:absolute;left:${lay.cellW * cm}px;top:0;width:${lay.cellH * cm}px;height:${lay.cellW * cm}px;transform-origin:0 0;transform:rotate(90deg)"><img src="${it.url}" alt="" style="object-fit:${fit}"></div>`
        : `<img src="${it.url}" alt="" style="object-fit:${fit}">`;
      inner += `<div class="cell" style="left:${x}px;top:${y}px;width:${lay.cellW * cm}px;height:${lay.cellH * cm}px">${img}</div>`;
    });
    label = `Sheet ${C.previewIndex + 1} of ${sheetsTotal}`;
    caption = `${dims.label}, ${lay.capacity} per ${cfg.paperSize} sheet. ${flat.length} photo${flat.length === 1 ? '' : 's'} on ${sheetsTotal} sheet${sheetsTotal === 1 ? '' : 's'}.`;
    if (sheetsTotal > 1) nav = navHtml(C.previewIndex + 1, sheetsTotal, 'sheet');
  } else {
    const r = main.mime === 'application/pdf' ? parsePageRange(cfg.rangeMode === 'custom' ? cfg.pageRange : 'all', main.upload.pages) : { pages: [1] };
    const pages = r.pages || [];
    if (pages.length) C.previewIndex = Math.min(C.previewIndex, pages.length - 1);
    const pageNo = pages[C.previewIndex] || 1;
    const [cwmm, chmm] = main.pageMm || [210, 297];
    const pwid = sw - 2 * PRINTER_MARGIN_MM, phei = sh - 2 * PRINTER_MARGIN_MM;
    let s = cfg.scaling === 'actual' ? 1 : cfg.scaling === 'fill' ? Math.max(pwid / cwmm, phei / chmm) : Math.min(pwid / cwmm, phei / chmm);
    const dw = cwmm * s * k, dh = chmm * s * k;
    const left = cfg.scaling === 'actual' ? 0 : (pwid * k - dw) / 2, top = cfg.scaling === 'actual' ? 0 : (phei * k - dh) / 2;
    let content = '';
    if (main.mime === 'application/pdf') {
      if (C.pdf && pages.length) {
        try { const src = await pdfCanvas(pageNo); if (token !== drawToken) return; content = `<canvas class="content" id="pv-canvas" width="${src.width}" height="${src.height}" style="left:${left}px;top:${top}px;width:${dw}px;height:${dh}px;background:#fff"></canvas>`; C._canvasSrc = src; }
        catch { content = `<div class="content" style="left:${left}px;top:${top}px;width:${dw}px;height:${dh}px;background:#f3f3f3"></div>`; warn = 'This page could not be drawn. It will still print.'; }
      } else content = `<div class="content" style="left:${left}px;top:${top}px;width:${dw}px;height:${dh}px;background:#f3f3f3;border:1px solid #ccc"></div>`;
    } else content = `<img class="content" src="${main.url}" alt="Your picture" style="left:${left}px;top:${top}px;width:${dw}px;height:${dh}px">`;
    inner = `<div class="printable" style="left:${pm}px;top:${pm}px;width:${pwid * k}px;height:${phei * k}px"><div class="content-wrap">${content}</div></div>`;
    const total = pages.length;
    label = main.mime === 'application/pdf' ? `Page ${pageNo}` : '';
    const selected = main.mime === 'application/pdf' ? `${total} page${total === 1 ? '' : 's'}` : '1 page';
    const copies = Number(cfg.copies) || 0;
    const sheetsPerCopy = cfg.duplex ? Math.ceil(total / 2) : total;
    caption = `${selected} x ${copies || '?'} cop${copies === 1 ? 'y' : 'ies'} on ${cfg.paperSize}${cfg.paperType === 'glossy' ? ' glossy' : ''}, ${cfg.color ? 'colour' : 'black and white'}. ${cfg.duplex ? `Double-sided: ${sheetsPerCopy} sheet${sheetsPerCopy === 1 ? '' : 's'} per copy.` : ''}`;
    if (cfg.duplex && total) caption += ` Page ${pageNo} is on the ${C.previewIndex % 2 === 0 ? 'front' : 'back'} of sheet ${Math.floor(C.previewIndex / 2) + 1}.`;
    copiesNote = copies > 1 ? 'multi' : '';
    if (total > 1) nav = navHtml(C.previewIndex + 1, total, 'page');
    if (cfg.scaling === 'actual' && (cwmm > pwid + 0.5 || chmm > phei + 0.5)) warn = 'At actual size this page is larger than the paper, so the edges will be cut off.';
    if (cfg.scaling === 'fill' && Math.abs(pwid / phei - cwmm / chmm) > 0.05) warn = warn || 'Fill page crops the parts that stick out past the paper.';
    if (cfg.orientation === 'landscape' && cwmm < chmm && cfg.scaling !== 'actual') warn = warn || 'This page is upright but the paper is landscape, so it prints smaller. Choose Portrait to use more of the sheet.';
  }
  if (problem) warn = problem;
  stage.innerHTML = `<div class="stack ${copiesNote}" style="width:${W}px"><div class="sheet ${cfg.color || cfg.mode === 'photo' ? '' : 'bw'}" style="width:${W}px;height:${H}px">${inner}${label ? `<span class="sheet-label">${esc(label)}</span>` : ''}</div></div>${nav}`;
  const cv = stage.querySelector('#pv-canvas'); if (cv && C._canvasSrc) cv.getContext('2d').drawImage(C._canvasSrc, 0, 0);
  stage.querySelectorAll('[data-nav]').forEach((b) => b.onclick = () => { C.previewIndex = Math.max(0, C.previewIndex + Number(b.dataset.nav)); drawPreview(); });
  card.querySelector('#preview-caption').innerHTML = `${esc(caption)}${warn ? `<div class="preview-warn" style="margin-top:6px">${esc(warn)}</div>` : ''}<div class="subtext" style="margin-top:6px">Approximate preview. The dashed line is the area most printers can print on.</div>`;
}
const navHtml = (i, n, noun) => `<div class="preview-nav"><button class="button button-light button-small" data-nav="-1" ${i <= 1 ? 'disabled' : ''} aria-label="Previous ${noun}">&lsaquo;</button><span class="subtext">${noun[0].toUpperCase() + noun.slice(1)} ${i} of ${n}</span><button class="button button-light button-small" data-nav="1" ${i >= n ? 'disabled' : ''} aria-label="Next ${noun}">&rsaquo;</button></div>`;
window.addEventListener('resize', () => { clearTimeout(timers.resize); timers.resize = setTimeout(() => { if (C?.cfg && document.querySelector('#preview-stage')) drawPreview(); }, 200); });

/* ---------- Price and checkout ---------- */
function scheduleQuote() {
  clearTimeout(timers.quote);
  C.quote = null; renderSummary({ loading: true });
  const problem = configProblem();
  if (problem) { renderSummary({ error: problem }); return; }
  timers.quote = setTimeout(fetchQuote, 250);
}
async function fetchQuote() {
  const rev = ++C.revision;
  try {
    const q = await api(`/shops/${encodeURIComponent(C.shop.id)}/price`, jsonBody({ uploadToken: C.items[0].upload.uploadToken, config: requestConfig() }));
    if (rev !== C.revision) return;
    C.quote = q; renderSummary({});
  } catch (e) { if (rev !== C.revision) return; renderSummary({ error: e.status === 400 && /expired|does not belong/i.test(e.message) ? 'Your upload expired. Choose the file again.' : e.message, expired: /expired|does not belong/i.test(e.message) }); }
}
function renderSummary({ loading, error, expired }) {
  const card = document.querySelector('#summary-card'), bar = document.querySelector('#mobile-total'); if (!card) return;
  const q = C.quote, { cfg, shop } = C;
  const sheetWord = cfg.mode === 'photo' ? `${q?.sheets || 0} photo sheet${q?.sheets === 1 ? '' : 's'}` : `${q?.pages || 0} page${q?.pages === 1 ? '' : 's'} x ${q?.copies || 0} cop${q?.copies === 1 ? 'y' : 'ies'}`;
  const rows = q ? `<div class="quote-row"><span>${esc(sheetWord)}</span><strong>${q.printablePages ? q.printablePages * (q.copies || 1) + ' sheets' : ''}</strong></div><div class="quote-row"><span>Rate per sheet</span><strong>${money(q.rate)}</strong></div>${q.base ? `<div class="quote-row"><span>Printing</span><strong>${money(q.base)}</strong></div>` : ''}${q.photoCharge ? `<div class="quote-row"><span>Photo sheets (${q.sheets})</span><strong>${money(q.photoCharge)}</strong></div>` : ''}<div class="quote-total"><span>Total</span><span>${money(q.total)}</span></div>` : '';
  const ready = Boolean(q) && !error && !C.submitting;
  card.innerHTML = `<h2>3. Pay and send</h2>
    ${loading ? '<div class="loading" style="padding:8px 0"><span class="spinner"></span> Calculating price</div>' : ''}${error ? `<div class="inline-notice bad" role="alert">${esc(error)}</div>${expired ? '<button class="button button-light" style="margin-top:10px" id="reselect">Choose file again</button>' : ''}` : ''}${rows}
    <div class="settings-grid" style="margin-top:14px"><div class="field"><label for="cust-name">Your name (optional)</label><input id="cust-name" maxlength="100" autocomplete="name" value="${esc(C.name || '')}"></div><div class="field"><label for="cust-phone">Phone (optional)</label><input id="cust-phone" maxlength="40" inputmode="tel" autocomplete="tel" value="${esc(C.phone || '')}"></div></div>
    <div class="pay-buttons"><button class="button button-primary button-lg" id="pay-upi" type="button" ${ready && shop.upiConfigured ? '' : 'disabled'}>Pay with UPI</button><button class="button button-lg" id="pay-cash" type="button" ${ready ? '' : 'disabled'}>Pay with cash</button></div>
    ${shop.upiConfigured ? '' : '<div class="pay-note">This shop has not set up UPI. Pay with cash at the counter.</div>'}
    <div class="form-error" id="order-error" style="margin-top:10px" role="alert"></div>
    <div class="pay-note">Your file is sent to the printer only after the shop confirms your payment.</div>`;
  card.querySelector('#reselect')?.addEventListener('click', () => { revokeUrls(); C.items = []; ['settings-card', 'preview-card', 'summary-card', 'mobile-total'].forEach((id) => document.querySelector('#' + id)?.classList.add('hidden')); renderDropzone(); });
  card.querySelector('#cust-name').oninput = (e) => { C.name = e.target.value; }; card.querySelector('#cust-phone').oninput = (e) => { C.phone = e.target.value; };
  card.querySelector('#pay-upi').onclick = () => submitOrder('upi'); card.querySelector('#pay-cash').onclick = () => submitOrder('cash');
  if (bar) { bar.classList.toggle('hidden', !q); bar.innerHTML = q ? `<div><div class="subtext">Total</div><strong>${money(q.total)}</strong></div><a class="button button-primary" href="#summary-card">Pay and send</a>` : ''; }
}
async function submitOrder(method) {
  if (C.submitting || !C.quote) return;
  const problem = configProblem(); if (problem) return;
  C.submitting = true; const buttons = [...document.querySelectorAll('#pay-upi,#pay-cash')]; buttons.forEach((b) => { b.disabled = true; });
  const errorBox = document.querySelector('#order-error'); errorBox.textContent = '';
  const launch = method === 'upi' && isTouchPhone();
  try {
    const res = await api(`/shops/${encodeURIComponent(C.shop.id)}/orders`, jsonBody({ uploadToken: C.items[0].upload.uploadToken, paymentMethod: method, config: requestConfig(), expectedAmount: C.quote.total, customerName: (C.name || '').trim(), customerPhone: (C.phone || '').trim() }));
    store.set(orderKey(C.shop.id), res.order.code);
    history.replaceState(null, '', `${location.pathname}?order=${encodeURIComponent(res.order.code)}`);
    C.submitting = false;
    showOrder(res.order, { launch: launch && res.order.status === 'pending_payment' });
  } catch (e) {
    C.submitting = false;
    if (e.data?.code === 'PRICE_CHANGED') { await fetchQuote(); const box = document.querySelector('#order-error'); if (box) box.textContent = e.message; return; }
    if (e.status === 409 || e.status === 400) { renderSummary({ error: e.message }); }
    else { buttons.forEach((b) => { b.disabled = false; }); errorBox.textContent = /Failed to fetch|NetworkError/i.test(e.message) ? 'No connection. Nothing was sent. Check your internet and tap again.' : e.message; }
    if (e.status === 409 || e.status === 400) { const box = document.querySelector('#order-error'); if (box) box.textContent = ''; }
  }
}

/* ---------- Order status, UPI and cash ---------- */
const TERMINAL = new Set(['completed', 'cancelled']);
function showOrder(order, { launch = false } = {}) {
  clearTimers(); C.order = order;
  const s = C.shop;
  const back = `<button class="button button-light" id="new-order" type="button">Start a new order</button>`;
  const head = (mark, cls, title, text) => `<div class="status-head"><div class="status-mark ${cls}" aria-hidden="true">${mark}</div><div><h1 style="font-size:1.4rem">${esc(title)}</h1><p class="lede" style="margin:6px 0 0">${text}</p></div></div>`;
  const summary = `<dl class="kv"><dt>Order code</dt><dd class="mono">${esc(order.code)}</dd><dt>File</dt><dd>${esc(order.fileName || 'Document')}</dd><dt>Amount</dt><dd>${money(order.amount)}</dd><dt>Payment</dt><dd>${order.paymentMethod === 'upi' ? 'UPI' : 'Cash'}</dd></dl>`;
  let body = '';
  const st = order.status;
  if (st === 'cancelled' || order.paymentStatus === 'cancelled' || order.paymentStatus === 'rejected' || order.paymentStatus === 'failed') {
    const rejected = order.paymentStatus === 'rejected' || order.paymentStatus === 'failed';
    body = `${head('!', 'bad', rejected ? 'Payment not confirmed' : 'Order cancelled', rejected ? `The shop could not find your payment, so this order was not printed. If money left your account, contact ${esc(s.name)}${order.shopPhone ? ` on ${esc(order.shopPhone)}` : ''} and quote the order code.` : 'This order will not be printed.')}${summary}<div class="form-actions">${back}</div>`;
  } else if (st === 'pending_payment') {
    body = upiScreen(order);
  } else if (st === 'payment_review') {
    body = `${head('...', 'wait', 'Waiting for the shop to confirm your payment', `You told the shop you paid ${money(order.amount)}. The shop checks its UPI account and then sends your file to print. This page updates by itself.`)}${summary}${order.reference ? `<div class="inline-notice">Transaction reference sent: <span class="mono">${esc(order.reference)}</span></div>` : ''}<div id="live-note"></div><p class="pay-note">Nothing has been printed yet. If this takes long, show the order code at the counter${order.shopPhone ? ` or call ${esc(order.shopPhone)}` : ''}.</p>`;
  } else if (st === 'cash_confirmation_pending') {
    body = `${head('...', 'wait', 'Pay cash at the counter', `Show this code to ${esc(s.name)} and pay ${money(order.amount)}. Printing starts once the shop confirms your cash payment.`)}<div class="success-code">${esc(order.code)}</div>${summary}<div id="live-note"></div><div class="form-actions"><button class="button button-danger" id="cancel-order" type="button">Cancel this order</button></div>`;
  } else if (st === 'print_queued') {
    body = `${head('OK', 'ok', 'Payment confirmed', 'Your file is in the shop\'s print queue.')}${summary}<div id="live-note"></div>`;
  } else if (st === 'printing') {
    body = `${head('...', 'wait', 'Printing now', 'Your document is being printed. It will be ready at the counter shortly.')}${summary}<div id="live-note"></div>`;
  } else if (st === 'completed') {
    body = `${head('OK', 'ok', 'Printed', `Collect your order from ${esc(s.name)}. Show the order code if asked.`)}<div class="success-code">${esc(order.code)}</div>${summary}<div class="form-actions">${back}</div>`;
  } else if (st === 'failed') {
    body = `${head('!', 'bad', 'There was a problem printing', `The shop has been told. Show the order code to ${esc(s.name)}${order.shopPhone ? ` or call ${esc(order.shopPhone)}` : ''} and they will retry it.`)}<div class="success-code">${esc(order.code)}</div>${summary}<div id="live-note"></div>`;
  } else body = `${head('...', 'wait', 'Order received', 'The shop is processing your order.')}${summary}<div id="live-note"></div>`;
  app.innerHTML = `<section class="login-wrap" style="max-width:560px"><div class="card status-card"><div id="net-banner" class="inline-notice warn hidden" style="margin-bottom:12px" role="status">Connection lost. Retrying...</div>${body}</div></section>`;
  document.querySelector('#new-order')?.addEventListener('click', () => { store.del(orderKey(s.id)); history.replaceState(null, '', location.pathname); revokeUrls(); renderCustomer(s.id); });
  document.querySelector('#cancel-order')?.addEventListener('click', () => customerOrderAction('cancel', 'Cancel this order?'));
  wireUpi(order, launch);
  if (!TERMINAL.has(st)) startPolling(order);
}
function upiScreen(order) {
  const u = order.upi, phone = isTouchPhone();
  if (!u) return `<div class="inline-notice bad">The UPI link for this order is not available. Switch to cash or cancel.</div><div class="form-actions"><button class="button" id="switch-cash" type="button">Pay cash instead</button></div>`;
  const copy = (id, v, label) => `<div class="copy-row"><span class="mono">${esc(v)}</span><button class="button button-light button-small" type="button" data-copy="${esc(v)}" aria-label="Copy ${label}">Copy</button></div>`;
  return `<div class="status-head"><div class="status-mark wait" aria-hidden="true">${'\u20B9'}</div><div><h1 style="font-size:1.4rem">Pay ${money(order.amount)} to ${esc(u.payee)}</h1><p class="lede" style="margin:6px 0 0">${phone ? 'Tap the button to open your UPI app. The shop and amount are already filled in.' : 'Scan the QR code with any UPI app on your phone. The shop and amount are already filled in.'}</p></div></div>
  ${phone ? `<a class="button button-primary button-lg button-block" id="upi-open" href="${esc(u.uri)}" style="margin-top:14px">Open UPI app to pay ${money(order.amount)}</a><div class="inline-notice warn hidden" id="upi-hint" style="margin-top:10px">No UPI app opened? Use the QR code below from another phone, or copy the details and pay manually.</div>` : `<img class="upi-qr" src="${u.qr}" alt="UPI payment QR code for ${money(order.amount)}"><a class="button button-light button-block" id="upi-open" href="${esc(u.uri)}">Try opening a UPI app on this device</a>`}
  <dl class="kv"><dt>Pay to</dt><dd>${copy('upi', u.id, 'UPI ID')}</dd><dt>Amount</dt><dd>${copy('amt', Number(order.amount).toFixed(2), 'amount')}</dd><dt>Note</dt><dd>${copy('note', order.code, 'order code')}</dd></dl>
  ${phone ? `<details style="margin:0 0 12px"><summary class="text-button">Show QR code</summary><img class="upi-qr" src="${u.qr}" alt="UPI payment QR code"></details>` : ''}
  <div class="card" style="background:var(--surface-2);margin-top:8px" id="paid-box"><h3 style="margin-bottom:6px">After you have paid</h3><p class="subtext" style="margin-bottom:10px">Come back to this page and tell the shop. Your file is printed after the shop sees the money in its account.</p>
    <div class="field"><label for="utr">UPI transaction ID (optional)</label><input id="utr" inputmode="text" autocomplete="off" maxlength="30" placeholder="Example: 412345678901"></div>
    <div class="form-error" id="claim-error" style="margin-top:8px" role="alert"></div>
    <button class="button button-primary button-lg button-block" id="claim-paid" type="button" style="margin-top:10px">I have paid</button></div>
  <div class="form-actions"><button class="button button-light" id="switch-cash" type="button">Pay cash instead</button><button class="button button-danger" id="cancel-order" type="button">Cancel order</button></div>
  <div id="live-note"></div><div class="pay-note">Payment cancelled or failed in your UPI app? Tap the button above to try again. Do not tap "I have paid" unless the money was sent.</div>`;
}
function wireUpi(order, launch) {
  document.querySelectorAll('[data-copy]').forEach((b) => b.onclick = async () => { try { await navigator.clipboard.writeText(b.dataset.copy); toast('Copied'); } catch { toast(b.dataset.copy); } });
  document.querySelector('#switch-cash')?.addEventListener('click', () => customerOrderAction('switch-cash', 'Pay at the counter with cash instead?'));
  document.querySelector('#claim-paid')?.addEventListener('click', claimPaid);
  const open = document.querySelector('#upi-open');
  if (open) {
    open.addEventListener('click', () => { C.upiOpened = true; clearTimeout(timers.hint); timers.hint = setTimeout(() => { if (document.visibilityState === 'visible') document.querySelector('#upi-hint')?.classList.remove('hidden'); }, 2500); });
    if (launch && !C.launched) { C.launched = true; C.upiOpened = true; setTimeout(() => { window.location.href = order.upi.uri; }, 150); timers.hint = setTimeout(() => { if (document.visibilityState === 'visible') document.querySelector('#upi-hint')?.classList.remove('hidden'); }, 3000); }
  }
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible' || !C?.upiOpened || C.order?.status !== 'pending_payment') return;
  C.upiOpened = false; document.querySelector('#upi-hint')?.classList.add('hidden');
  const box = document.querySelector('#paid-box'); if (box) { box.scrollIntoView({ behavior: 'smooth', block: 'center' }); box.style.outline = '2px solid var(--brand-text)'; }
});
async function claimPaid() {
  const btn = document.querySelector('#claim-paid'), err = document.querySelector('#claim-error'); if (btn.disabled) return;
  const utr = document.querySelector('#utr').value.trim(); err.textContent = '';
  if (utr && !/^[A-Za-z0-9]{6,30}$/.test(utr)) { err.textContent = 'A transaction ID has 6 to 30 letters and numbers. Leave it empty if you do not have it.'; return; }
  btn.disabled = true; btn.textContent = 'Sending...';
  try { await api(`/orders/${encodeURIComponent(C.order.code)}/payment-claim`, jsonBody({ reference: utr })); const { order } = await api(`/orders/${encodeURIComponent(C.order.code)}`); showOrder(order); }
  catch (e) { err.textContent = /Failed to fetch|NetworkError/i.test(e.message) ? 'No connection. Nothing was sent. Tap again when you are online.' : e.message; btn.disabled = false; btn.textContent = 'I have paid'; }
}
async function customerOrderAction(action, question) {
  if (!confirm(question)) return;
  try { const res = await api(`/orders/${encodeURIComponent(C.order.code)}/${action}`, jsonBody({})); const { order } = await api(`/orders/${encodeURIComponent(C.order.code)}`); showOrder(order); if (action === 'switch-cash') toast('Switched to cash. Pay at the counter.'); }
  catch (e) { toast(e.message); try { const { order } = await api(`/orders/${encodeURIComponent(C.order.code)}`); if (order.status !== C.order.status) showOrder(order); } catch { /* keep screen */ } }
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
        note.innerHTML = `${s.ahead ? `<div class="inline-notice" style="margin-top:8px">${s.ahead} job${s.ahead === 1 ? '' : 's'} ahead of yours.</div>` : ''}${off ? '<div class="inline-notice warn" style="margin-top:8px">The shop\'s print computer is offline. Your order is safe and prints when it reconnects.</div>' : ''}`;
      }
    } catch (e) {
      if (e.status === 404) { store.del(orderKey(C.shop.id)); renderCustomer(C.shop.id); return; }
      failures++; document.querySelector('#net-banner')?.classList.remove('hidden');
    }
    timers.poll = setTimeout(tick, Math.min(every * (1 + failures), 30000));
  };
  timers.poll = setTimeout(tick, every);
}
