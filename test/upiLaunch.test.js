const test = require('node:test');
const assert = require('node:assert/strict');
const { buildUpiUri } = require('../src/services/upi');
const U = require('../public/upiLaunch.js');

const UA = {
  chromeAndroid: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.6367.82 Mobile Safari/537.36',
  samsung: 'Mozilla/5.0 (Linux; Android 13; SM-S908B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/21.0 Chrome/110.0.5481.154 Mobile Safari/537.36',
  firefoxAndroid: 'Mozilla/5.0 (Android 14; Mobile; rv:124.0) Gecko/124.0 Firefox/124.0',
  instagramAndroid: 'Mozilla/5.0 (Linux; Android 13; Pixel 7 Build/TQ3A.230901.001; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/119.0.6045.193 Mobile Safari/537.36 Instagram 312.0.0.34.111 Android',
  androidWebView: 'Mozilla/5.0 (Linux; Android 12; SM-A525F Build/SP1A.210812.016; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/120.0.6099.144 Mobile Safari/537.36',
  safariIphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1',
  chromeIphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/124.0.6367.88 Mobile/15E148 Safari/604.1',
  instagramIphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/21E219 Instagram 330.0.0.25.108',
  wkWebViewIphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148',
  ipadDesktopMode: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15',
  desktopChrome: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
};
const link = (o = {}) => buildUpiUri({ upiId: 'sharmaprint@okaxis', payeeName: 'Sharma Xerox', amount: 12.5, orderCode: 'PR-MV2UQUXZ-C1E2D4E575', ...o });
const FALLBACK = 'https://print.example.com/shop/ABC123?order=PR-MV2UQUXZ-C1E2D4E575&upi=noapp';

test('UPI link: payee, amount, currency and references are present and correctly encoded', () => {
  const uri = link();
  assert.match(uri, /^upi:\/\/pay\?pa=sharmaprint@okaxis&pn=Sharma%20Xerox&am=12\.50&cu=INR&tr=PR-MV2UQUXZ-C1E2D4E575&tn=Print%20order%20PR-MV2UQUXZ-C1E2D4E575$/);
  assert.ok(!uri.includes('+'), 'spaces must be %20, never +');
  const p = U.parseUpiUri(uri);
  assert.deepEqual([p.pa, p.pn, p.am, p.cu, p.tr, p.tn], ['sharmaprint@okaxis', 'Sharma Xerox', '12.50', 'INR', 'PR-MV2UQUXZ-C1E2D4E575', 'Print order PR-MV2UQUXZ-C1E2D4E575']);
});

test('UPI link: two shops never share a payee, and the amount is always two decimals', () => {
  const a = U.parseUpiUri(link({ upiId: 'shopa@okaxis', amount: 10 })), b = U.parseUpiUri(link({ upiId: 'shopb@ybl', amount: 7.1 }));
  assert.equal(a.pa, 'shopa@okaxis'); assert.equal(b.pa, 'shopb@ybl');
  assert.equal(a.am, '10.00'); assert.equal(b.am, '7.10');
  assert.equal(U.parseUpiUri(link({ amount: '19.999' })).am, '20.00');
});

test('UPI link: refuses unusable inputs instead of producing a broken link', () => {
  assert.throws(() => link({ upiId: 'not a vpa' }), /not valid/);
  assert.throws(() => link({ upiId: null }), /not valid/);
  for (const amount of [0, -1, NaN, 'abc', 100000.01, 0.004]) assert.throws(() => link({ amount }), /not payable/, String(amount));
  for (const orderCode of ['', 'ab', 'has space', 'semi;colon', 'x'.repeat(40), undefined]) assert.throws(() => link({ orderCode }), /reference/, String(orderCode));
});

test('UPI link: hostile payee names cannot add or break parameters', () => {
  const uri = link({ payeeName: 'A&pa=evil@upi;#x=1 "Co" \n\t' });
  const p = U.parseUpiUri(uri);
  assert.equal(p.pa, 'sharmaprint@okaxis');
  assert.equal(new URL(uri).searchParams.getAll('pa').length, 1);
  assert.equal(p.pn, 'A&pa=evil@upi;#x=1 "Co"');
  assert.ok(!/[;#\s"]/.test(uri.slice('upi://pay?'.length)), 'no raw delimiter characters in the query');
  assert.ok(link({ payeeName: 'x'.repeat(200) }).length < 300);
  assert.equal(U.parseUpiUri(link({ payeeName: 'राम प्रिंटर्स' })).pn, 'राम प्रिंटर्स');
});

test('verify(): accepts the matching order and rejects any mix-up', () => {
  const uri = link(), want = { upiId: 'sharmaprint@okaxis', amount: 12.5, orderCode: 'PR-MV2UQUXZ-C1E2D4E575' };
  assert.deepEqual(U.verify(uri, want), { ok: true });
  assert.equal(U.verify(uri, { ...want, upiId: 'other@okaxis' }).reason, 'payee-mismatch');
  assert.equal(U.verify(uri, { ...want, amount: 12.6 }).reason, 'amount-mismatch');
  assert.equal(U.verify(uri, { ...want, orderCode: 'PR-OTHER-1234' }).reason, 'reference-mismatch');
  assert.equal(U.verify(uri.replace('cu=INR', 'cu=USD'), want).reason, 'currency-mismatch');
  assert.equal(U.verify('https://evil.example/pay?pa=sharmaprint@okaxis', want).reason, 'not-a-upi-link');
  assert.equal(U.verify('upi://collect?pa=a@b&am=1.00', want).reason, 'not-a-upi-link');
  assert.equal(U.verify(null, want).reason, 'not-a-upi-link');
});

test('platform and in-app browser detection on real User-Agent strings', () => {
  const plat = (ua, extra = {}) => U.detectPlatform({ userAgent: ua, ...extra });
  assert.equal(plat(UA.chromeAndroid), 'android'); assert.equal(plat(UA.samsung), 'android'); assert.equal(plat(UA.firefoxAndroid), 'android');
  assert.equal(plat(UA.safariIphone), 'ios'); assert.equal(plat(UA.chromeIphone), 'ios');
  assert.equal(plat(UA.ipadDesktopMode, { maxTouchPoints: 5 }), 'ios');
  assert.equal(plat(UA.desktopChrome), 'other');
  assert.equal(plat(UA.desktopChrome, { uaPlatform: 'Android' }), 'android', 'Android Chrome in "desktop site" mode');
  assert.equal(plat(UA.desktopChrome, { maxTouchPoints: 5, coarse: true }), 'touch-other');
  for (const ua of [UA.chromeAndroid, UA.samsung, UA.firefoxAndroid, UA.safariIphone, UA.chromeIphone, UA.desktopChrome]) assert.equal(U.isInAppBrowser(ua), false, ua);
  for (const ua of [UA.instagramAndroid, UA.androidWebView, UA.instagramIphone, UA.wkWebViewIphone]) assert.equal(U.isInAppBrowser(ua), true, ua);
});

test('Android intent URL round-trips to the exact upi link and carries the fallback', () => {
  const uri = link(), url = U.androidIntentUrl(uri, { fallbackUrl: FALLBACK });
  assert.match(url, /^intent:\/\/pay\?.+#Intent;scheme=upi;S\.browser_fallback_url=.+;end$/);
  const parsed = U.parseAndroidIntent(url);
  assert.equal(parsed.data, uri);
  assert.equal(parsed.scheme, 'upi');
  assert.equal(parsed.extras.browser_fallback_url, FALLBACK);
  assert.equal(parsed.package, null);
  assert.equal(U.parseAndroidIntent(U.androidIntentUrl(uri, { packageName: 'com.phonepe.app' })).package, 'com.phonepe.app');
});

test('Android intent URL survives hostile payee names and refuses unsafe input', () => {
  const uri = link({ payeeName: 'Tea;Co#1&x=2' }), parsed = U.parseAndroidIntent(U.androidIntentUrl(uri, { fallbackUrl: FALLBACK }));
  assert.equal(parsed.data, uri);
  assert.equal(U.parseUpiUri(parsed.data).pn, 'Tea;Co#1&x=2');
  assert.equal(parsed.extras.browser_fallback_url, FALLBACK);
  assert.throws(() => U.androidIntentUrl(uri, { fallbackUrl: 'javascript:alert(1)' }), /http/);
  assert.throws(() => U.androidIntentUrl('https://example.com/?pa=a@b'), /upi/);
});

test('iOS app links reuse the exact query and unknown apps are rejected', () => {
  const uri = link(), q = U.parseUpiUri(uri).query;
  assert.equal(U.iosAppUrl('phonepe', uri), `phonepe://pay?${q}`);
  assert.equal(U.iosAppUrl('paytm', uri), `paytmmp://pay?${q}`);
  assert.equal(U.iosAppUrl('gpay', uri), `gpay://upi/pay?${q}`);
  assert.equal(U.iosAppUrl('nope', uri), null);
  assert.equal(U.iosAppUrl('phonepe', 'https://x.test'), null);
});

test('plan(): the right hand-off for each device class', () => {
  const uri = link(), base = { uri, fallbackUrl: FALLBACK };
  const android = U.plan({ ...base, userAgent: UA.chromeAndroid, maxTouchPoints: 5, coarse: true });
  assert.equal(android.mode, 'android-intent'); assert.equal(U.parseAndroidIntent(android.url).data, uri); assert.equal(android.inApp, false);
  const insta = U.plan({ ...base, userAgent: UA.instagramAndroid });
  assert.equal(insta.mode, 'scheme'); assert.equal(insta.url, uri); assert.equal(insta.inApp, true);
  const ios = U.plan({ ...base, userAgent: UA.safariIphone, maxTouchPoints: 5 });
  assert.equal(ios.mode, 'scheme'); assert.equal(ios.url, uri); assert.deepEqual(ios.apps.map((a) => a.id), ['gpay', 'phonepe', 'paytm']);
  assert.ok(ios.apps.every((a) => U.parseUpiUri(`upi://pay?${a.url.split('?')[1]}`).pa === 'sharmaprint@okaxis'));
  const desktop = U.plan({ ...base, userAgent: UA.desktopChrome });
  assert.equal(desktop.mode, 'qr');
  assert.equal(U.plan({ uri: 'https://nope', userAgent: UA.chromeAndroid }).mode, 'qr');
  assert.equal(U.plan({ uri: null, userAgent: UA.chromeAndroid }).url, null);
});

test('Android per-app intents target the right package and report which app failed', () => {
  const uri = link(), p = U.plan({ uri, userAgent: UA.chromeAndroid, fallbackUrl: FALLBACK, pageUrl: 'https://print.example.com/shop/ABC123?order=PR-MV2UQUXZ-C1E2D4E575' });
  assert.deepEqual(p.apps.map((a) => a.id), ['gpay', 'phonepe', 'paytm', 'bhim', 'amazon', 'cred']);
  const phonepe = U.parseAndroidIntent(p.apps.find((a) => a.id === 'phonepe').url);
  assert.equal(phonepe.package, 'com.phonepe.app'); assert.equal(phonepe.data, uri);
  assert.equal(phonepe.extras.browser_fallback_url, `${FALLBACK}&app=phonepe`);
  for (const a of p.apps) { const i = U.parseAndroidIntent(a.url); assert.equal(i.data, uri, a.id); assert.ok(i.package && i.package.includes('.'), a.id); }
  assert.equal(p.plainUrl, uri); assert.equal(p.isChrome, true); assert.equal(p.chromeUrl, null);
});

test('Chrome detection, browser names and Open-in-Chrome intent', () => {
  assert.equal(U.isChromeBrowser(UA.chromeAndroid), true);
  for (const ua of [UA.samsung, UA.firefoxAndroid, UA.instagramAndroid, UA.androidWebView]) assert.equal(U.isChromeBrowser(ua), false, ua);
  assert.equal(U.browserName(UA.chromeAndroid), 'Chrome'); assert.equal(U.browserName(UA.samsung), 'Samsung Internet');
  assert.equal(U.browserName(UA.firefoxAndroid), 'Firefox'); assert.equal(U.browserName(UA.safariIphone), 'Safari'); assert.equal(U.browserName(UA.instagramAndroid), 'in-app browser');
  const page = 'http://192.168.1.20:3000/shop/ABC123?order=PR-MV2UQUXZ-C1E2D4E575';
  const url = U.chromeIntentForPage(page); assert.equal(url, 'intent://192.168.1.20:3000/shop/ABC123?order=PR-MV2UQUXZ-C1E2D4E575#Intent;scheme=http;package=com.android.chrome;end');
  assert.equal(U.chromeIntentForPage('javascript:alert(1)'), null); assert.equal(U.chromeIntentForPage('nope'), null);
  const samsung = U.plan({ uri: link(), userAgent: UA.samsung, fallbackUrl: FALLBACK, pageUrl: page });
  assert.equal(samsung.mode, 'android-intent'); assert.equal(samsung.isChrome, false); assert.equal(samsung.chromeUrl, url);
  const insta = U.plan({ uri: link(), userAgent: UA.instagramAndroid, pageUrl: page });
  assert.equal(insta.mode, 'scheme'); assert.equal(insta.chromeUrl, url); assert.deepEqual(insta.apps, []);
});
