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

  if (!validDateString(from) || !validDateString(to)) {
    throw Object.assign(new Error('Dates must use YYYY-MM-DD format'), { status: 400 });
  }
  if (!['day', 'month'].includes(groupBy)) {
    throw Object.assign(new Error('groupBy must be day or month'), { status: 400 });
  }
  const duration = (Date.parse(`${to}T00:00:00.000Z`) - Date.parse(`${from}T00:00:00.000Z`)) / 86400000;
  if (duration < 0 || duration >= MAX_REPORT_RANGE_DAYS) {
    throw Object.assign(new Error('Choose an end date on or after the start date within a 10-year range'), { status: 400 });
  }
  return { from, to, groupBy, timeZone: REPORT_TIME_ZONE };
}

function periodExpression(groupBy, createdAt = 'created_at') {
  return groupBy === 'month'
    ? `date_trunc('month', ${createdAt} AT TIME ZONE '${REPORT_TIME_ZONE}')::date`
    : `(${createdAt} AT TIME ZONE '${REPORT_TIME_ZONE}')::date`;
}

const REPORT_METRICS = `
  count(*)::int AS orders,
  coalesce(sum((config->>'billablePages')::int), 0)::int AS pages,
  coalesce(sum(amount) FILTER (WHERE payment_status = 'verified'), 0)::numeric(12,2) AS revenue,
  coalesce(sum(amount) FILTER (WHERE payment_status = 'verified' AND payment_method = 'upi'), 0)::numeric(12,2) AS online,
  coalesce(sum(amount) FILTER (WHERE payment_status = 'verified' AND payment_method = 'cash'), 0)::numeric(12,2) AS cash,
  count(*) FILTER (WHERE payment_status = 'pending')::int AS payment_pending,
  count(*) FILTER (WHERE print_status = 'failed')::int AS print_failures`;

function istRangeSql(startParameter, endParameter, column = 'created_at') {
  return `${column} >= ($${startParameter}::date::timestamp AT TIME ZONE '${REPORT_TIME_ZONE}')
    AND ${column} < (($${endParameter}::date + INTERVAL '1 day')::timestamp AT TIME ZONE '${REPORT_TIME_ZONE}')`;
}

async function queryShopAnalytics(pool, shopId, range) {
  const dateExpression = periodExpression(range.groupBy);
  const { rows } = await pool.query(
    `WITH selected_orders AS (
       SELECT *, ${dateExpression} AS activity_date
       FROM orders
       WHERE shop_id = $1 AND ${istRangeSql(2, 3)}
     )
     SELECT activity_date, ${REPORT_METRICS}
     FROM selected_orders
     GROUP BY activity_date
     ORDER BY activity_date`,
    [shopId, range.from, range.to],
  );
  return rows;
}

async function queryPlatformAnalytics(pool, range) {
  const { rows } = await pool.query(
    `SELECT shops.public_id AS shop_id, shops.name AS shop_name,
            count(orders.id)::int AS orders,
            coalesce(sum((orders.config->>'billablePages')::int), 0)::int AS pages,
            coalesce(sum(orders.amount) FILTER (WHERE orders.payment_status = 'verified'), 0)::numeric(12,2) AS revenue,
            coalesce(sum(orders.amount) FILTER (WHERE orders.payment_status = 'verified' AND orders.payment_method = 'upi'), 0)::numeric(12,2) AS online,
            coalesce(sum(orders.amount) FILTER (WHERE orders.payment_status = 'verified' AND orders.payment_method = 'cash'), 0)::numeric(12,2) AS cash,
            count(orders.id) FILTER (WHERE orders.payment_status = 'pending')::int AS payment_pending,
            count(orders.id) FILTER (WHERE orders.print_status = 'failed')::int AS print_failures
     FROM shops
     LEFT JOIN orders ON orders.shop_id = shops.id AND ${istRangeSql(1, 2, 'orders.created_at')}
     GROUP BY shops.id, shops.public_id, shops.name
     ORDER BY revenue DESC, shops.name ASC`,
    [range.from, range.to],
  );
  return rows;
}

module.exports = {
  REPORT_TIME_ZONE,
  parseAnalyticsRange,
  queryShopAnalytics,
  queryPlatformAnalytics,
};