/* Photo edit pipeline. The SAME code produces the on-screen preview and the file that is uploaded for printing,
   so what the customer sees is what the print system receives. Pure pixel maths (no ctx.filter, which iOS Safari lacks),
   so it also runs under Node for tests. */
(function (root) {
  'use strict';

  const DEFAULT_EDIT = Object.freeze({ brightness: 0, contrast: 0, saturation: 0, exposure: 0, highlights: 0, shadows: 0, sharpness: 0, bw: false, rotate: 0, zoom: 1, panX: 0, panY: 0 });
  const RANGES = { brightness: [-100, 100], contrast: [-100, 100], saturation: [-100, 100], exposure: [-100, 100], highlights: [-100, 100], shadows: [-100, 100], sharpness: [0, 100], zoom: [1, 4], panX: [-1, 1], panY: [-1, 1] };
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

  function cleanEdit(input) {
    const e = { ...DEFAULT_EDIT };
    for (const [key, [lo, hi]] of Object.entries(RANGES)) { const n = Number(input?.[key]); e[key] = Number.isFinite(n) ? clamp(n, lo, hi) : DEFAULT_EDIT[key]; }
    e.bw = Boolean(input?.bw);
    e.rotate = ((Math.round(Number(input?.rotate) / 90) * 90) % 360 + 360) % 360 || 0;
    return e;
  }
  const TONE_KEYS = ['brightness', 'contrast', 'saturation', 'exposure', 'highlights', 'shadows', 'sharpness'];
  const hasPixelEdit = (e) => TONE_KEYS.some((k) => e[k] !== 0) || e.bw;
  // geometry = crop/zoom/pan matter (photo sheets). Rotation always matters.
  function isEdited(input, { geometry = true } = {}) {
    const e = cleanEdit(input);
    return hasPixelEdit(e) || e.rotate !== 0 || (geometry && (e.zoom !== 1 || e.panX !== 0 || e.panY !== 0));
  }
  const editKey = (input, extra = '') => JSON.stringify([cleanEdit(input), extra]);

  function toneLut(e) {
    const lut = new Uint8ClampedArray(256), ex = Math.pow(2, e.exposure / 100 * 1.5);
    const sh = e.shadows / 100 * 0.3, hi = e.highlights / 100 * 0.3, br = e.brightness / 100 * 0.5;
    const cf = e.contrast >= 0 ? 1 + e.contrast / 100 * 1.5 : 1 + e.contrast / 100;
    for (let i = 0; i < 256; i++) {
      let v = i / 255;
      v *= ex;
      v += sh * Math.pow(1 - clamp(v, 0, 1), 3) + hi * Math.pow(clamp(v, 0, 1), 3);
      v += br;
      v = (v - 0.5) * cf + 0.5;
      lut[i] = Math.round(clamp(v, 0, 1) * 255);
    }
    return lut;
  }

  function boxBlurChannel(src, w, h, r, out) {
    const tmp = new Float32Array(w * h), div = 2 * r + 1;
    for (let y = 0; y < h; y++) {
      let sum = 0; const row = y * w;
      for (let k = -r; k <= r; k++) sum += src[row + clamp(k, 0, w - 1)];
      for (let x = 0; x < w; x++) { tmp[row + x] = sum / div; sum += src[row + clamp(x + r + 1, 0, w - 1)] - src[row + clamp(x - r, 0, w - 1)]; }
    }
    for (let x = 0; x < w; x++) {
      let sum = 0;
      for (let k = -r; k <= r; k++) sum += tmp[clamp(k, 0, h - 1) * w + x];
      for (let y = 0; y < h; y++) { out[y * w + x] = sum / div; sum += tmp[clamp(y + r + 1, 0, h - 1) * w + x] - tmp[clamp(y - r, 0, h - 1) * w + x]; }
    }
  }

  // In-place edit of RGBA bytes. Order: tone curve, saturation, black and white, sharpen.
  function processPixels(data, w, h, input) {
    const e = cleanEdit(input);
    if (!hasPixelEdit(e)) return data;
    const toneOn = e.exposure || e.shadows || e.highlights || e.brightness || e.contrast;
    const lut = toneOn ? toneLut(e) : null, sat = 1 + e.saturation / 100;
    for (let i = 0; i < data.length; i += 4) {
      let r = data[i], g = data[i + 1], b = data[i + 2];
      if (lut) { r = lut[r]; g = lut[g]; b = lut[b]; }
      if (e.saturation || e.bw) {
        const gray = 0.299 * r + 0.587 * g + 0.114 * b;
        if (e.bw) { r = g = b = gray; } else { r = gray + (r - gray) * sat; g = gray + (g - gray) * sat; b = gray + (b - gray) * sat; }
      }
      data[i] = r; data[i + 1] = g; data[i + 2] = b;
    }
    if (e.sharpness > 0) {
      const radius = Math.max(1, Math.round(Math.min(w, h) / 600)), amount = e.sharpness / 100 * 1.4;
      const plane = new Float32Array(w * h), blur = new Float32Array(w * h);
      for (let c = 0; c < 3; c++) {
        for (let p = 0, i = c; p < plane.length; p++, i += 4) plane[p] = data[i];
        boxBlurChannel(plane, w, h, radius, blur);
        for (let p = 0, i = c; p < plane.length; p++, i += 4) data[i] = plane[p] + amount * (plane[p] - blur[p]);
      }
    }
    return data;
  }

  // Geometry for the output frame. aspect = width/height of the print frame (photo sheets), or null for a plain picture.
  function plan(nw, nh, input, { aspect = null, fit = 'cover', maxSide = 1600 } = {}) {
    const e = cleanEdit(input), turned = e.rotate % 180 !== 0, rw = turned ? nh : nw, rh = turned ? nw : nh;
    if (!aspect) { const s = Math.min(1, maxSide / Math.max(rw, rh)); return { e, rw, rh, kind: 'full', ow: Math.max(1, Math.round(rw * s)), oh: Math.max(1, Math.round(rh * s)), crop: { x: 0, y: 0, w: rw, h: rh } }; }
    if (fit === 'contain') {
      const ow = aspect >= 1 ? maxSide : Math.round(maxSide * aspect), oh = Math.round(ow / aspect);
      const s = Math.min(ow / rw, oh / rh), dw = rw * s, dh = rh * s;
      return { e, rw, rh, kind: 'contain', ow, oh, dest: { x: (ow - dw) / 2, y: (oh - dh) / 2, w: dw, h: dh }, crop: { x: 0, y: 0, w: rw, h: rh } };
    }
    let cw, ch;
    if (rw / rh > aspect) { ch = rh; cw = ch * aspect; } else { cw = rw; ch = cw / aspect; }
    cw /= e.zoom; ch /= e.zoom;
    const x = (rw - cw) / 2 + e.panX * (rw - cw) / 2, y = (rh - ch) / 2 + e.panY * (rh - ch) / 2;
    const s = Math.min(1, maxSide / Math.max(cw, ch)), ow = Math.max(1, Math.round(cw * s)), oh = Math.max(1, Math.round(ow / aspect));
    return { e, rw, rh, kind: 'cover', ow, oh, crop: { x, y, w: cw, h: ch } };
  }

  // Browser only: draws the edited image into a canvas.
  function render(img, input, options = {}) {
    const nw = img.naturalWidth || img.width, nh = img.naturalHeight || img.height;
    const p = plan(nw, nh, input, options);
    const e = p.e;
    // rotated copy at a resolution that is enough for the crop
    const need = options.maxSide || 1600, z = p.kind === 'cover' ? e.zoom : 1;
    const s1 = Math.min(1, (need * Math.max(1, z) * 1.05) / Math.max(p.rw, p.rh));
    const rot = document.createElement('canvas'); rot.width = Math.max(1, Math.round(p.rw * s1)); rot.height = Math.max(1, Math.round(p.rh * s1));
    const rc = rot.getContext('2d'); rc.imageSmoothingQuality = 'high';
    rc.translate(rot.width / 2, rot.height / 2); rc.rotate(e.rotate * Math.PI / 180);
    const dw = (e.rotate % 180 ? rot.height : rot.width), dh = (e.rotate % 180 ? rot.width : rot.height);
    rc.drawImage(img, -dw / 2, -dh / 2, dw, dh);
    const out = document.createElement('canvas'); out.width = p.ow; out.height = p.oh;
    const ctx = out.getContext('2d', { willReadFrequently: true }); ctx.imageSmoothingQuality = 'high';
    ctx.fillStyle = options.background || '#ffffff'; ctx.fillRect(0, 0, p.ow, p.oh);
    if (p.kind === 'contain') ctx.drawImage(rot, 0, 0, rot.width, rot.height, p.dest.x, p.dest.y, p.dest.w, p.dest.h);
    else ctx.drawImage(rot, p.crop.x * s1, p.crop.y * s1, p.crop.w * s1, p.crop.h * s1, 0, 0, p.ow, p.oh);
    if (hasPixelEdit(e)) { const id = ctx.getImageData(0, 0, p.ow, p.oh); processPixels(id.data, p.ow, p.oh, e); ctx.putImageData(id, 0, 0); }
    return out;
  }
  const toBlob = (canvas, quality = 0.92) => new Promise((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error('Could not encode the edited photo'))), 'image/jpeg', quality));

  const api = { DEFAULT_EDIT, RANGES, cleanEdit, isEdited, hasPixelEdit, editKey, processPixels, plan, render, toBlob };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.PhotoEdit = api;
})(typeof window !== 'undefined' ? window : globalThis);
