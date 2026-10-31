const { COLLECTIONS, getDb } = require('../firestoreStore');

const REPORT_TIME_ZONE = 'Asia/Kolkata';
const MAX_REPORT_RANGE_DAYS = 3660;

function dateInTimeZone(value, timeZone = REPORT_TIME_ZONE) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(value);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function validDateString(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function parseAnalyticsRange(query, now = new Date()) {
  const to = query.to === undefined ? dateInTimeZone(now) : query.to;
  const defaultFrom = dateInTimeZone(new Date(now.getTime() - 29 * 86400000));
  const from = query.from === undefined ? defaultFrom : query.from;
  const groupBy = query.groupBy === undefined ? 'day' : query.groupBy;
  if (!validDateString(from) || !validDateString(to)) throw Object.assign(new Error('Dates must use YYYY-MM-DD format'), { status: 400 });
  if (!['day', 'month'].includes(groupBy)) throw Object.assign(new Error('groupBy must be day or month'), { status: 400 });
  const duration = (Date.parse(`${to}T00:00:00.000Z`) - Date.parse(`${from}T00:00:00.000Z`)) / 86400000;
  if (duration < 0 || duration >= MAX_REPORT_RANGE_DAYS) throw Object.assign(new Error('Choose an end date on or after the start date within a 10-year range'), { status: 400 });
  return { from, to, groupBy, timeZone: REPORT_TIME_ZONE };
}

function istBoundary(date, days = 0) {
  const utcDate = new Date(`${date}T00:00:00.000Z`);
  utcDate.setUTCDate(utcDate.getUTCDate() + days);
  return new Date(utcDate.getTime() - (5 * 60 + 30) * 60000);
}

function inRange(order, range) {
  const createdAt = new Date(order.created_at).getTime();
  return createdAt >= istBoundary(range.from).getTime() && createdAt < istBoundary(range.to, 1).getTime();
}

function activityDate(order, range) {
  const day = dateInTimeZone(new Date(order.created_at), range.timeZone);
  return range.groupBy === 'month' ? day.slice(0, 7) : day;
}

function emptyMetrics() {
  return { orders: 0, pages: 0, revenue: 0, online: 0, cash: 0, payment_pending: 0, print_failures: 0 };
}

function addOrder(metrics, order) {
  metrics.orders += 1;
  metrics.pages += Number(order.config?.billablePages || 0);
  const amount = Number(order.amount || 0);
  if (order.payment_status === 'verified') {
    metrics.revenue += amount;
    if (order.payment_method === 'upi') metrics.online += amount;
    if (order.payment_method === 'cash') metrics.cash += amount;
  }
  if (order.payment_status === 'pending') metrics.payment_pending += 1;
  if (order.print_status === 'failed') metrics.print_failures += 1;
}

function roundMetrics(metrics) {
  return { ...metrics, revenue: Number(metrics.revenue.toFixed(2)), online: Number(metrics.online.toFixed(2)), cash: Number(metrics.cash.toFixed(2)) };
}

async function queryShopAnalytics(db = getDb(), shopId, range) {
  const snapshot = await db.collection(COLLECTIONS.orders).where('shop_id', '==', shopId).get();
  const grouped = new Map();
  for (const doc of snapshot.docs) {
    const order = doc.data();
    if (!inRange(order, range)) continue;
    const date = activityDate(order, range);
    const metrics = grouped.get(date) || emptyMetrics();
    addOrder(metrics, order);
    grouped.set(date, metrics);
  }
  return [...grouped.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([activity_date, metrics]) => ({ activity_date, ...roundMetrics(metrics) }));
}

async function queryPlatformAnalytics(db = getDb(), range) {
  const [shopsSnapshot, ordersSnapshot] = await Promise.all([
    db.collection(COLLECTIONS.shops).get(),
    db.collection(COLLECTIONS.orders).get(),
  ]);
  const shopsById = new Map(shopsSnapshot.docs.map((doc) => [doc.id, { id: doc.id, ...doc.data() }]));
  const metricsByShop = new Map([...shopsById.keys()].map((id) => [id, emptyMetrics()]));
  for (const doc of ordersSnapshot.docs) {
    const order = doc.data();
    if (!inRange(order, range)) continue;
    const metrics = metricsByShop.get(order.shop_id);
    if (metrics) addOrder(metrics, order);
  }
  return [...shopsById.values()].map((shop) => ({
    shop_id: shop.public_id,
    shop_name: shop.name,
    ...roundMetrics(metricsByShop.get(shop.id)),
  })).sort((a, b) => b.revenue - a.revenue || a.shop_name.localeCompare(b.shop_name));
}

module.exports = { REPORT_TIME_ZONE, parseAnalyticsRange, queryShopAnalytics, queryPlatformAnalytics };
