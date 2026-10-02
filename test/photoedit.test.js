const test = require('node:test');
const assert = require('node:assert/strict');
const P = require('../public/photoedit');

const gradient = (w = 64, h = 48) => { const d = new Uint8ClampedArray(w * h * 4); for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const i = (y * w + x) * 4; d[i] = x * 4; d[i + 1] = (y * 5) % 256; d[i + 2] = 120; d[i + 3] = 255; } return d; };
const mean = (d) => { let s = 0, n = 0; for (let i = 0; i < d.length; i += 4) { s += d[i] + d[i + 1] + d[i + 2]; n += 3; } return s / n; };
const spread = (d) => { const m = mean(d); let s = 0, n = 0; for (let i = 0; i < d.length; i += 4) for (let c = 0; c < 3; c++) { s += (d[i + c] - m) ** 2; n++; } return Math.sqrt(s / n); };
const run = (edit) => { const d = gradient(); P.processPixels(d, 64, 48, edit); return d; };

test('default edit leaves pixels untouched and is not counted as edited', () => {
  assert.deepEqual(run({}), gradient());
  assert.equal(P.isEdited({}), false);
  assert.equal(P.isEdited({ brightness: 1 }), true);
  assert.equal(P.isEdited({ rotate: 90 }, { geometry: false }), true);
  assert.equal(P.isEdited({ zoom: 2 }, { geometry: false }), false, 'zoom only matters for photo sheets');
  assert.equal(P.isEdited({ zoom: 2 }), true);
});
test('brightness, exposure and shadows lighten; negative values darken', () => {
  const base = mean(gradient());
  for (const k of ['brightness', 'exposure', 'shadows']) { assert.ok(mean(run({ [k]: 50 })) > base, k + ' up'); assert.ok(mean(run({ [k]: -50 })) < base, k + ' down'); }
  assert.ok(mean(run({ highlights: -60 })) < base);
});
test('contrast widens or narrows the tonal spread', () => {
  const base = spread(gradient());
  assert.ok(spread(run({ contrast: 60 })) > base);
  assert.ok(spread(run({ contrast: -60 })) < base);
});
test('saturation -100 and B&W remove colour; saturation +60 increases it', () => {
  for (const d of [run({ saturation: -100 }), run({ bw: true })]) for (let i = 0; i < d.length; i += 4) assert.ok(Math.abs(d[i] - d[i + 1]) <= 1 && Math.abs(d[i + 1] - d[i + 2]) <= 1);
  const chroma = (d) => { let s = 0; for (let i = 0; i < d.length; i += 4) s += Math.max(d[i], d[i + 1], d[i + 2]) - Math.min(d[i], d[i + 1], d[i + 2]); return s; };
  assert.ok(chroma(run({ saturation: 60 })) > chroma(gradient()));
});
test('sharpness increases local contrast across an edge and is resolution independent in strength', () => {
  const edge = (w, h) => { const d = new Uint8ClampedArray(w * h * 4); for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const i = (y * w + x) * 4; d[i] = d[i + 1] = d[i + 2] = x < w / 2 ? 100 : 160; d[i + 3] = 255; } return d; };
  for (const [w, h] of [[60, 40], [600, 400]]) { const d = edge(w, h); P.processPixels(d, w, h, { sharpness: 80 }); const row = 10 * w, left = d[(row + Math.floor(w / 2) - 1) * 4], right = d[(row + Math.floor(w / 2)) * 4]; assert.ok(left < 100 && right > 160, `overshoot at ${w}px: ${left}/${right}`); }
});
test('cleanEdit clamps hostile values', () => {
  const e = P.cleanEdit({ brightness: 9999, zoom: 0, panX: -9, rotate: 450, sharpness: -5, contrast: 'x', bw: 1 });
  assert.deepEqual([e.brightness, e.zoom, e.panX, e.rotate, e.sharpness, e.contrast, e.bw], [100, 1, -1, 90, 0, 0, true]);
});
test('crop plan keeps the frame aspect and honours zoom, pan and rotation', () => {
  const a = 3.5 / 4.5;
  let p = P.plan(4000, 3000, {}, { aspect: a, fit: 'cover', maxSide: 1000 });
  assert.ok(Math.abs(p.ow / p.oh - a) < 0.01); assert.ok(Math.abs(p.crop.w / p.crop.h - a) < 1e-6);
  assert.equal(Math.round(p.crop.h), 3000);
  const z = P.plan(4000, 3000, { zoom: 2 }, { aspect: a, fit: 'cover', maxSide: 1000 });
  assert.ok(Math.abs(z.crop.w - p.crop.w / 2) < 1e-6);
  const left = P.plan(4000, 3000, { zoom: 2, panX: -1 }, { aspect: a, fit: 'cover' }), right = P.plan(4000, 3000, { zoom: 2, panX: 1 }, { aspect: a, fit: 'cover' });
  assert.equal(Math.round(left.crop.x), 0); assert.ok(Math.abs(right.crop.x + right.crop.w - 4000) < 1e-6);
  const turned = P.plan(4000, 3000, { rotate: 90 }, { aspect: a, fit: 'cover' });
  assert.deepEqual([turned.rw, turned.rh], [3000, 4000]);
  const c = P.plan(4000, 3000, {}, { aspect: a, fit: 'contain', maxSide: 900 });
  assert.ok(c.dest.x >= 0 && c.dest.y > 0 && Math.abs(c.dest.w / c.dest.h - 4 / 3) < 0.01);
  const full = P.plan(4000, 3000, {}, { maxSide: 1000 });
  assert.deepEqual([full.ow, full.oh], [1000, 750]);
});
