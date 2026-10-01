const os = require('node:os');

const isPrivate = (ip) => /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip);

// Non-internal IPv4 addresses, private LAN ranges first (Wi-Fi/Ethernet before VPN/virtual adapters).
function lanAddresses() {
  const found = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const item of list || []) {
      if (item.family === 'IPv4' && !item.internal) found.push({ name, address: item.address, priv: isPrivate(item.address), virtual: /docker|veth|vbox|vmnet|virtual|wsl|hyper-v|loopback|tailscale|zt/i.test(name) });
    }
  }
  return found.sort((a, b) => (b.priv - a.priv) || (a.virtual - b.virtual));
}

const isLocalHost = (host) => /^(localhost|127\.\d+\.\d+\.\d+|\[?::1\]?)(:\d+)?$/i.test(String(host || ''));

// Public base URL used for shop links and QR codes.
// Production always uses APP_URL. In development, a localhost APP_URL (or none) is replaced by the address
// the current browser actually used, so a QR generated on a phone or over the LAN never points at "localhost".
function baseUrl(req) {
  const configured = String(process.env.APP_URL || '').trim().replace(/\/+$/, '');
  const requestBase = `${req.protocol}://${req.get('host')}`;
  if (!configured) return requestBase;
  if (process.env.NODE_ENV === 'production') return configured;
  try { if (isLocalHost(new URL(configured).host) && !isLocalHost(req.get('host'))) return requestBase; } catch { return requestBase; }
  return configured;
}

module.exports = { lanAddresses, baseUrl, isLocalHost };
