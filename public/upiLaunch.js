/* Print Wallah: UPI launch helpers.
   Pure functions only (no DOM, no network). Loaded in the browser as window.UpiLaunch and in Node tests via require().

   What a web page can and cannot do:
   - It cannot list the UPI apps installed on a phone. Android and iOS do not expose that to websites.
   - On Android the right mechanism is an intent. When several UPI apps are installed the system shows its own app chooser;
     with exactly one, Android opens it directly. We hand the OS an intent: URL (instead of navigating the page itself to
     "upi://"), so if no app can handle it the browser goes to our fallback URL instead of showing an error page.
   - iOS has no chooser. "upi://" opens whichever app claimed it, so we also offer per-app links.
   - Nothing here can know whether a payment happened. Payment is confirmed by the shop, never by the browser. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api; else root.UpiLaunch = api;
})(typeof self !== 'undefined' ? self : this, function () {
  // Android UPI apps that can be targeted directly by package name. A package-targeted intent does not depend on the
  // system chooser, so it also works when the generic upi:// chooser is blocked or confused by default-app settings.
  const ANDROID_APPS = [
    { id: 'gpay', name: 'Google Pay', pkg: 'com.google.android.apps.nbu.paisa.user' },
    { id: 'phonepe', name: 'PhonePe', pkg: 'com.phonepe.app' },
    { id: 'paytm', name: 'Paytm', pkg: 'net.one97.paytm' },
    { id: 'bhim', name: 'BHIM', pkg: 'in.org.npci.upiapp' },
    { id: 'amazon', name: 'Amazon Pay', pkg: 'in.amazon.mShop.android.shopping' },
    { id: 'cred', name: 'CRED', pkg: 'com.dreamplug.androidapp' },
  ];
  const IOS_APPS = [
    { id: 'gpay', name: 'Google Pay', base: 'gpay://upi/pay' },
    { id: 'phonepe', name: 'PhonePe', base: 'phonepe://pay' },
    { id: 'paytm', name: 'Paytm', base: 'paytmmp://pay' },
  ];

  // Splits a upi://pay link into its parts. Returns null for anything that is not a upi://pay link.
  function parseUpiUri(uri) {
    let url;
    try { url = new URL(String(uri)); } catch { return null; }
    if (url.protocol !== 'upi:' || url.hostname !== 'pay' || !url.search) return null;
    const get = (key) => url.searchParams.get(key);
    return { pa: get('pa'), pn: get('pn'), am: get('am'), cu: get('cu'), tr: get('tr'), tn: get('tn'), query: url.search.slice(1) };
  }

  // Refuses to launch a link that does not match the order the customer is looking at: wrong payee, wrong amount,
  // wrong currency or wrong reference. This guards against any mix-up between shops or orders.
  function verify(uri, { upiId, amount, orderCode }) {
    const p = parseUpiUri(uri);
    if (!p) return { ok: false, reason: 'not-a-upi-link' };
    if (!upiId || String(p.pa || '').toLowerCase() !== String(upiId).toLowerCase()) return { ok: false, reason: 'payee-mismatch' };
    const expected = Number(amount);
    if (!Number.isFinite(expected) || expected <= 0 || p.am !== expected.toFixed(2)) return { ok: false, reason: 'amount-mismatch' };
    if (p.cu !== 'INR') return { ok: false, reason: 'currency-mismatch' };
    if (!orderCode || p.tr !== String(orderCode)) return { ok: false, reason: 'reference-mismatch' };
    return { ok: true };
  }

  function detectPlatform({ userAgent = '', uaPlatform = '', maxTouchPoints = 0, coarse = false } = {}) {
    if (/Android/i.test(userAgent) || /^Android$/i.test(uaPlatform)) return 'android';
    if (/iPhone|iPad|iPod/i.test(userAgent) || (/Macintosh/i.test(userAgent) && maxTouchPoints > 1)) return 'ios';
    return coarse && maxTouchPoints > 1 ? 'touch-other' : 'other';
  }

  // In-app browsers and WebViews (Instagram, Facebook, LINE, WeChat, plain Android WebView...) usually block
  // intent: and custom-scheme links. Normal browsers (Chrome, Samsung Internet, Firefox, Safari) are not matched.
  function isInAppBrowser(userAgent = '') {
    const ua = String(userAgent);
    if (/FBAN|FBAV|FB_IAB|Instagram|Line\/|MicroMessenger|Snapchat|Twitter|LinkedInApp|Pinterest|TikTok|musical_ly|Bytedance|; wv\)/i.test(ua)) return true;
    if (/Android/i.test(ua) && /Chrome\//.test(ua) && /\bVersion\/\d/.test(ua)) return true; // Android WebView carries "Version/x.y"
    if (/iPhone|iPad|iPod/i.test(ua) && !/Safari\//.test(ua)) return true;                    // WKWebView inside an app
    return false;
  }

  // Android intent URL. Chrome and other Android browsers launch it as ACTION_VIEW on upi://pay?... (system chooser when
  // several apps can handle it). If nothing can handle it, the browser navigates to browser_fallback_url.
  function androidIntentUrl(uri, { fallbackUrl, packageName } = {}) {
    const p = parseUpiUri(uri);
    if (!p) throw new Error('Not a upi://pay link');
    const parts = ['Intent', 'scheme=upi'];
    if (packageName) parts.push(`package=${packageName}`);
    if (fallbackUrl) {
      if (!/^https?:\/\//i.test(fallbackUrl)) throw new Error('Fallback URL must be http(s)');
      parts.push(`S.browser_fallback_url=${encodeURIComponent(fallbackUrl)}`);
    }
    parts.push('end');
    return `intent://pay?${p.query}#${parts.join(';')}`;
  }

  // Reads an intent: URL the way Android does, only as far as this project uses it. Used by the tests.
  function parseAndroidIntent(url) {
    const m = /^intent:\/\/([^#]*)#Intent;(.*);end$/.exec(String(url));
    if (!m) return null;
    const out = { scheme: null, package: null, extras: {}, data: null };
    for (const part of m[2].split(';')) {
      const eq = part.indexOf('=');
      if (eq < 0) continue;
      const key = part.slice(0, eq), value = part.slice(eq + 1);
      if (key === 'scheme') out.scheme = value;
      else if (key === 'package') out.package = value;
      else if (key.startsWith('S.')) out.extras[key.slice(2)] = decodeURIComponent(value);
    }
    if (out.scheme) out.data = `${out.scheme}://${m[1]}`;
    return out;
  }

  function iosAppUrl(appId, uri) {
    const app = IOS_APPS.find((a) => a.id === appId), p = parseUpiUri(uri);
    if (!app || !p) return null;
    return `${app.base}?${p.query}`;
  }

  // True for Google Chrome itself (not Chromium-based browsers that handle intents differently).
  function isChromeBrowser(userAgent = '') {
    const ua = String(userAgent);
    return /Chrome\//.test(ua) && !/SamsungBrowser|OPR\/|OPT\/|Edg(A|e)?\/|MiuiBrowser|XiaoMi|UCBrowser|HeyTap|OppoBrowser|VivoBrowser|Vivaldi|DuckDuckGo|YaBrowser|Firefox|FxiOS|CriOS/i.test(ua) && !isInAppBrowser(ua);
  }
  // Android intent that opens this same page in Chrome (for people whose default browser blocks UPI hand-offs).
  function chromeIntentForPage(pageUrl) {
    let u; try { u = new URL(pageUrl); } catch { return null; }
    if (!/^https?:$/.test(u.protocol)) return null;
    return `intent://${u.host}${u.pathname}${u.search}#Intent;scheme=${u.protocol.slice(0, -1)};package=com.android.chrome;end`;
  }
  function browserName(userAgent = '') {
    const ua = String(userAgent);
    if (isInAppBrowser(ua)) return 'in-app browser';
    if (/SamsungBrowser/i.test(ua)) return 'Samsung Internet';
    if (/MiuiBrowser|XiaoMi/i.test(ua)) return 'Mi Browser';
    if (/Edg(A|e)?\//i.test(ua)) return 'Edge';
    if (/OPR\/|OPT\//i.test(ua)) return 'Opera';
    if (/Firefox|FxiOS/i.test(ua)) return 'Firefox';
    if (/CriOS/i.test(ua)) return 'Chrome (iOS)';
    if (/UCBrowser/i.test(ua)) return 'UC Browser';
    if (/Chrome\//.test(ua)) return 'Chrome';
    if (/Safari\//.test(ua)) return 'Safari';
    return 'unknown browser';
  }
  function withParams(url, params) {
    if (!url) return url;
    return url + (url.includes('?') ? '&' : '?') + Object.entries(params).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
  }

  // Decides how to launch on this device.
  //  mode 'android-intent': system chooser (or direct launch when only one app), fallback URL if none can handle it
  //  mode 'scheme':         plain upi:// link (iOS, in-app browsers, touch devices that do not identify as Android)
  //  mode 'qr':             not a phone: show the QR code, with a best-effort button
  function plan({ uri, userAgent = '', uaPlatform = '', maxTouchPoints = 0, coarse = false, fallbackUrl, pageUrl } = {}) {
    if (!parseUpiUri(uri)) return { platform: 'other', mode: 'qr', url: null, inApp: false, apps: [] };
    const platform = detectPlatform({ userAgent, uaPlatform, maxTouchPoints, coarse });
    const inApp = isInAppBrowser(userAgent);
    if (platform === 'android') {
      if (inApp) return { platform, mode: 'scheme', url: uri, inApp, apps: [], chromeUrl: pageUrl ? chromeIntentForPage(pageUrl) : null, browser: browserName(userAgent), isChrome: false };
      const apps = ANDROID_APPS.map((a) => ({ id: a.id, name: a.name, url: androidIntentUrl(uri, { packageName: a.pkg, fallbackUrl: fallbackUrl && withParams(fallbackUrl, { app: a.id }) }) }));
      const isChrome = isChromeBrowser(userAgent);
      return { platform, mode: 'android-intent', url: androidIntentUrl(uri, { fallbackUrl }), plainUrl: uri, inApp, apps, isChrome, browser: browserName(userAgent), chromeUrl: !isChrome && pageUrl ? chromeIntentForPage(pageUrl) : null };
    }
    if (platform === 'ios') return { platform, mode: 'scheme', url: uri, plainUrl: uri, inApp, browser: browserName(userAgent), apps: IOS_APPS.map((a) => ({ id: a.id, name: a.name, url: iosAppUrl(a.id, uri) })) };
    if (platform === 'touch-other') return { platform, mode: 'scheme', url: uri, inApp, apps: [] };
    return { platform, mode: 'qr', url: uri, inApp, apps: [] };
  }

  return { parseUpiUri, verify, detectPlatform, isInAppBrowser, isChromeBrowser, browserName, chromeIntentForPage, androidIntentUrl, parseAndroidIntent, iosAppUrl, plan, IOS_APPS, ANDROID_APPS };
});
