const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const bcrypt = require('bcryptjs');
const { Pool } = require('pg');

function createMockPool() {
  const shops = new Map();
  const uploads = new Map();
  const orders = new Map();
  const orderUploads = [];
  const payments = new Map();
  const printJobs = new Map();
  const accessExtensions = [];
  const auditLogs = [];
  const paymentEvents = [];
  let queueSeq = 1;

  // Seed a default demo shop so the platform and customer portal work out of the box
  const demoShopId = crypto.randomUUID();
  const now = new Date();
  const future = new Date(now.getTime() + 30 * 86400000);
  shops.set(demoShopId, {
    id: demoShopId,
    public_id: 'PW-DEMO01',
    name: 'Campus Copy & Print',
    owner_name: 'Rajesh Sharma',
    phone: '+91 98765 43210',
    email: 'shop@printwallah.com',
    address: 'Shop 12, Market Road',
    city: 'Ballia',
    admin_email: 'shop@printwallah.com',
    admin_password_hash: bcrypt.hashSync('shoppassword123', 10),
    pricing: { bw_a4: 2, color_a4: 10, bw_a3: 4, color_a3: 20, glossy_a4: 15, photo_sheet: 30 },
    print_config: { paperSizes: ['A4', 'A3'], paperTypes: ['normal', 'glossy'], color: true, duplex: true, photo: true, defaultPaper: 'A4' },
    upi_id: 'campusprint@upi',
    upi_name: 'Campus Copy & Print',
    access_start: now.toISOString(),
    access_end: future.toISOString(),
    manually_locked: false,
    agent_token_hash: null,
    agent_name: 'Canon G3010 · Counter PC',
    agent_last_seen: now.toISOString(),
    created_at: now.toISOString(),
    updated_at: now.toISOString(),
  });

  async function query(sqlText, params = []) {
    const sql = String(sqlText || '').replace(/\s+/g, ' ').trim();

    if (/^(BEGIN|COMMIT|ROLLBACK)$/i.test(sql) || /^SELECT 1$/i.test(sql) || /^SELECT pg_advisory_xact_lock/i.test(sql) || /^CREATE /i.test(sql)) {
      return { rows: [{ '?column?': 1 }], rowCount: 1 };
    }

    if (/SELECT nextval\('print_queue_position_seq'\)/i.test(sql)) {
      return { rows: [{ position: queueSeq++ }], rowCount: 1 };
    }

    // Uploads cleanup
    if (sql.startsWith('DELETE FROM uploads u WHERE u.expires_at<now()')) {
      return { rows: [], rowCount: 0 };
    }

    // Completed order file retention
    if (sql.includes("FROM orders WHERE order_status = 'completed'") && sql.includes('files_deleted_at IS NULL')) {
      return { rows: [], rowCount: 0 };
    }

    // Super overview shops count
    if (sql.includes('FROM shops') && sql.includes('manually_locked') && sql.includes('expiring')) {
      const all = [...shops.values()];
      const nowMs = Date.now();
      const active = all.filter(s => !s.manually_locked && new Date(s.access_end).getTime() > nowMs);
      const locked = all.filter(s => s.manually_locked);
      const expired = all.filter(s => !s.manually_locked && new Date(s.access_end).getTime() <= nowMs);
      const expiring = active.filter(s => new Date(s.access_end).getTime() <= nowMs + 7 * 86400000);
      return {
        rows: [{
          total: all.length,
          active: active.length,
          locked: locked.length,
          expired: expired.length,
          expiring: expiring.length,
        }],
        rowCount: 1,
      };
    }

    // Super overview orders count
    if (sql.includes('FROM orders') && sql.includes('verified_revenue') && !sql.includes('WHERE shop_id')) {
      const all = [...orders.values()];
      const todayStr = new Date().toISOString().slice(0, 10);
      const today = all.filter(o => String(o.created_at).slice(0, 10) === todayStr).length;
      const pages = all.reduce((acc, o) => acc + Number(o.config?.billablePages || 0), 0);
      const verifiedRevenue = all
        .filter(o => o.payment_method === 'upi' && o.payment_status === 'verified')
        .reduce((acc, o) => acc + Number(o.amount || 0), 0);
      return {
        rows: [{ total: all.length, today, pages, verified_revenue: verifiedRevenue.toFixed(2) }],
        rowCount: 1,
      };
    }

    // Super overview recent orders
    if (sql.includes('FROM orders o JOIN shops s ON s.id=o.shop_id ORDER BY o.created_at DESC LIMIT 8')) {
      const rows = [...orders.values()]
        .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
        .slice(0, 8)
        .map(o => ({
          order_code: o.order_code,
          amount: o.amount,
          order_status: o.order_status,
          created_at: o.created_at,
          shop_name: shops.get(o.shop_id)?.name || 'Shop',
        }));
      return { rows, rowCount: rows.length };
    }

    // Platform analytics
    if (sql.includes('FROM shops LEFT JOIN orders ON orders.shop_id = shops.id')) {
      const rows = [...shops.values()].map(s => {
        const shopOrders = [...orders.values()].filter(o => o.shop_id === s.id);
        const verified = shopOrders.filter(o => o.payment_status === 'verified');
        return {
          shop_id: s.public_id,
          shop_name: s.name,
          orders: shopOrders.length,
          pages: shopOrders.reduce((sum, o) => sum + Number(o.config?.billablePages || 0), 0),
          revenue: verified.reduce((sum, o) => sum + Number(o.amount || 0), 0).toFixed(2),
          online: verified.filter(o => o.payment_method === 'upi').reduce((sum, o) => sum + Number(o.amount || 0), 0).toFixed(2),
          cash: verified.filter(o => o.payment_method === 'cash').reduce((sum, o) => sum + Number(o.amount || 0), 0).toFixed(2),
          payment_pending: shopOrders.filter(o => o.payment_status === 'pending').length,
          print_failures: shopOrders.filter(o => o.print_status === 'failed').length,
        };
      });
      return { rows, rowCount: rows.length };
    }

    // Shop analytics
    if (sql.includes('WITH selected_orders AS')) {
      const shopId = params[0];
      const shopOrders = [...orders.values()].filter(o => o.shop_id === shopId);
      const byDate = new Map();
      for (const o of shopOrders) {
        const d = String(o.created_at).slice(0, 10);
        if (!byDate.has(d)) byDate.set(d, []);
        byDate.get(d).push(o);
      }
      const rows = [...byDate.entries()].map(([activity_date, list]) => {
        const verified = list.filter(o => o.payment_status === 'verified');
        return {
          activity_date,
          orders: list.length,
          pages: list.reduce((sum, o) => sum + Number(o.config?.billablePages || 0), 0),
          revenue: verified.reduce((sum, o) => sum + Number(o.amount || 0), 0).toFixed(2),
          online: verified.filter(o => o.payment_method === 'upi').reduce((sum, o) => sum + Number(o.amount || 0), 0).toFixed(2),
          cash: verified.filter(o => o.payment_method === 'cash').reduce((sum, o) => sum + Number(o.amount || 0), 0).toFixed(2),
          payment_pending: list.filter(o => o.payment_status === 'pending').length,
          print_failures: list.filter(o => o.print_status === 'failed').length,
        };
      });
      return { rows, rowCount: rows.length };
    }

    // Super shops list
    if (sql.startsWith('SELECT * FROM shops WHERE ($1=')) {
      const rawSearch = String(params[0] || '').replace(/^%|%$/g, '').toLowerCase();
      const rows = [...shops.values()]
        .filter(s => !rawSearch || [s.name, s.owner_name, s.public_id, s.city].some(v => String(v || '').toLowerCase().includes(rawSearch)))
        .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
      return { rows, rowCount: rows.length };
    }

    // Shop lookup by id
    if (sql === 'SELECT * FROM shops WHERE id=$1' || sql === 'SELECT public_id,name FROM shops WHERE id=$1' || sql === 'SELECT agent_name,agent_last_seen FROM shops WHERE id=$1') {
      const s = shops.get(params[0]);
      return { rows: s ? [s] : [], rowCount: s ? 1 : 0 };
    }

    // Shop lookup by public_id
    if (sql.startsWith('SELECT * FROM shops WHERE public_id=$1')) {
      const pubId = String(params[0] || '').toUpperCase();
      const s = [...shops.values()].find(x => x.public_id.toUpperCase() === pubId && (!sql.includes('agent_token_hash') || x.agent_token_hash === params[1]));
      return { rows: s ? [s] : [], rowCount: s ? 1 : 0 };
    }

    if (sql.startsWith('SELECT id FROM shops WHERE public_id = $1 AND agent_token_hash = $2')) {
      const pubId = String(params[0] || '').toUpperCase();
      const s = [...shops.values()].find(x => x.public_id.toUpperCase() === pubId && x.agent_token_hash === params[1]);
      return { rows: s ? [{ id: s.id }] : [], rowCount: s ? 1 : 0 };
    }

    // Shop lookup by admin_email
    if (sql === 'SELECT * FROM shops WHERE lower(admin_email)=lower($1)') {
      const email = String(params[0] || '').toLowerCase();
      const s = [...shops.values()].find(x => String(x.admin_email).toLowerCase() === email);
      return { rows: s ? [s] : [], rowCount: s ? 1 : 0 };
    }

    // Insert shop
    if (sql.startsWith('INSERT INTO shops(')) {
      const [public_id, name, owner_name, phone, email, address, city, admin_email, admin_password_hash, pricing, print_config, upi_id, upi_name, days, agent_token_hash] = params;
      if ([...shops.values()].some(x => x.admin_email.toLowerCase() === String(admin_email).toLowerCase())) {
        const err = new Error('Duplicate email');
        err.code = '23505';
        throw err;
      }
      const id = crypto.randomUUID();
      const nowTime = new Date();
      const end = new Date(nowTime.getTime() + Number(days || 30) * 86400000);
      const shop = {
        id, public_id, name, owner_name, phone, email, address, city, admin_email, admin_password_hash,
        pricing, print_config, upi_id, upi_name,
        access_start: nowTime.toISOString(), access_end: end.toISOString(),
        manually_locked: false, agent_token_hash, agent_name: null, agent_last_seen: null,
        created_at: nowTime.toISOString(), updated_at: nowTime.toISOString(),
      };
      shops.set(id, shop);
      return { rows: [shop], rowCount: 1 };
    }

    // Shop stats for super admin
    if (sql.includes('FROM orders WHERE shop_id=$1') && sql.includes('online_verified')) {
      const shopOrders = [...orders.values()].filter(o => o.shop_id === params[0]);
      const todayStr = new Date().toISOString().slice(0, 10);
      return {
        rows: [{
          orders: shopOrders.length,
          today: shopOrders.filter(o => String(o.created_at).slice(0, 10) === todayStr).length,
          month_orders: shopOrders.length,
          year_orders: shopOrders.length,
          pages: shopOrders.reduce((sum, o) => sum + Number(o.config?.billablePages || 0), 0),
          charges: shopOrders.reduce((sum, o) => sum + Number(o.amount || 0), 0).toFixed(2),
          online_verified: shopOrders.filter(o => o.payment_status === 'verified').reduce((sum, o) => sum + Number(o.amount || 0), 0).toFixed(2),
          cash_confirmed: shopOrders.filter(o => o.payment_method === 'cash' && ['print_queued', 'printing', 'completed'].includes(o.order_status)).reduce((sum, o) => sum + Number(o.amount || 0), 0).toFixed(2),
        }],
        rowCount: 1,
      };
    }

    if (sql === 'SELECT * FROM orders WHERE shop_id=$1 ORDER BY created_at DESC LIMIT 12') {
      const rows = [...orders.values()].filter(o => o.shop_id === params[0]).sort((a, b) => new Date(b.created_at) - new Date(a.created_at)).slice(0, 12);
      return { rows, rowCount: rows.length };
    }

    // Update shop
    if (sql.startsWith('UPDATE shops SET name=$2')) {
      const s = shops.get(params[0]);
      if (!s) return { rows: [], rowCount: 0 };
      if (sql.includes('admin_password_hash=$9')) {
        const [, name, owner_name, phone, email, address, city, admin_email, admin_password_hash, pricing, print_config, upi_id, upi_name] = params;
        Object.assign(s, { name, owner_name, phone, email, address, city, admin_email, admin_password_hash, pricing, print_config, upi_id, upi_name, updated_at: new Date().toISOString() });
      } else {
        const [, name, owner_name, phone, email, address, city, upi_id, upi_name, pricing, print_config, agent_name] = params;
        Object.assign(s, { name, owner_name, phone, email, address, city, upi_id, upi_name, pricing, print_config, agent_name, updated_at: new Date().toISOString() });
      }
      return { rows: [s], rowCount: 1 };
    }

    if (sql.startsWith('UPDATE shops SET manually_locked=$2')) {
      const s = shops.get(params[0]);
      if (s) s.manually_locked = Boolean(params[1]);
      return { rows: s ? [s] : [], rowCount: s ? 1 : 0 };
    }

    if (sql.startsWith('UPDATE shops SET access_end=')) {
      const s = shops.get(params[0]);
      if (s) {
        const base = Math.max(Date.now(), new Date(s.access_end).getTime());
        s.access_end = new Date(base + Number(params[1]) * 86400000).toISOString();
        s.manually_locked = false;
      }
      return { rows: s ? [s] : [], rowCount: s ? 1 : 0 };
    }

    if (sql.startsWith('UPDATE shops SET agent_token_hash=$2')) {
      const s = shops.get(params[0]);
      if (s) s.agent_token_hash = params[1];
      return { rows: s ? [s] : [], rowCount: s ? 1 : 0 };
    }

    if (sql.startsWith('UPDATE shops SET agent_name=$2') || sql.startsWith('UPDATE shops SET agent_last_seen')) {
      const s = shops.get(params[0]);
      if (s) {
        if (params[1]) s.agent_name = params[1];
        s.agent_last_seen = new Date().toISOString();
      }
      return { rows: s ? [s] : [], rowCount: s ? 1 : 0 };
    }

    // Uploads insert & select
    if (sql.startsWith('INSERT INTO uploads(')) {
      const [public_token, shop_id, original_name, stored_name, mime_type, byte_size, page_count] = params;
      const id = crypto.randomUUID();
      const row = {
        id, public_token, shop_id, original_name, stored_name, mime_type,
        byte_size: Number(byte_size), page_count: Number(page_count),
        created_at: new Date().toISOString(),
        expires_at: new Date(Date.now() + 2 * 3600 * 1000).toISOString(),
      };
      uploads.set(id, row);
      return { rows: [row], rowCount: 1 };
    }

    if (sql.startsWith('SELECT * FROM uploads WHERE public_token = ANY($1::text[])')) {
      const tokens = new Set(params[0] || []);
      const shopId = params[1];
      const rows = [...uploads.values()].filter(u => tokens.has(u.public_token) && u.shop_id === shopId);
      return { rows, rowCount: rows.length };
    }

    if (sql.startsWith('SELECT * FROM uploads WHERE public_token=$1')) {
      const row = [...uploads.values()].find(u => u.public_token === params[0] && u.shop_id === params[1]);
      return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
    }

    // Orders
    if (sql.startsWith('SELECT o.* FROM orders o JOIN uploads u ON u.id=o.upload_id WHERE u.public_token=$1')) {
      const up = [...uploads.values()].find(u => u.public_token === params[0] && u.shop_id === params[1]);
      const ord = up ? [...orders.values()].find(o => o.upload_id === up.id && o.shop_id === params[1]) : null;
      return { rows: ord ? [ord] : [], rowCount: ord ? 1 : 0 };
    }

    if (sql.startsWith('INSERT INTO orders(')) {
      const [order_code, shop_id, upload_id, print_file_name, customer_name, customer_phone, config, page_count, copies, amount, payment_method, order_status] = params;
      const id = crypto.randomUUID();
      const nowIso = new Date().toISOString();
      const ord = {
        id, order_code, shop_id, upload_id, print_file_name, customer_name, customer_phone,
        config, page_count: Number(page_count), copies: Number(copies), amount: Number(amount),
        payment_method, payment_status: 'pending', order_status, print_status: 'not_ready',
        payment_reference: null, payment_claimed_at: null,
        created_at: nowIso, updated_at: nowIso, confirmed_at: null, completed_at: null, files_deleted_at: null,
      };
      orders.set(id, ord);
      return { rows: [ord], rowCount: 1 };
    }

    if (sql.startsWith('SELECT o.*, row_to_json(s) AS shop_row FROM orders o JOIN shops s ON s.id=o.shop_id WHERE o.order_code=$1')) {
      const ord = [...orders.values()].find(o => o.order_code === params[0]);
      if (!ord) return { rows: [], rowCount: 0 };
      const shop = shops.get(ord.shop_id);
      return { rows: [{ ...ord, shop_row: shop }], rowCount: 1 };
    }

    if (sql.startsWith('SELECT o.*, s.upi_id, s.upi_name, s.name shop_name FROM orders o JOIN shops s ON s.id=o.shop_id WHERE o.order_code=$1')) {
      const ord = [...orders.values()].find(o => o.order_code === params[0]);
      if (!ord) return { rows: [], rowCount: 0 };
      const shop = shops.get(ord.shop_id);
      return { rows: [{ ...ord, upi_id: shop?.upi_id, upi_name: shop?.upi_name, shop_name: shop?.name }], rowCount: 1 };
    }

    if (sql.includes("UPDATE orders SET order_status='payment_review'")) {
      const ord = orders.get(params[0]);
      if (ord) {
        ord.order_status = 'payment_review';
        ord.payment_claimed_at = ord.payment_claimed_at || new Date().toISOString();
        ord.payment_reference = params[1] || ord.payment_reference;
        ord.updated_at = new Date().toISOString();
      }
      return { rows: ord ? [ord] : [], rowCount: ord ? 1 : 0 };
    }

    if (sql.includes("UPDATE orders SET order_status='cancelled', payment_status='cancelled' WHERE id=$1")) {
      const ord = orders.get(params[0]);
      if (ord) {
        ord.order_status = 'cancelled';
        ord.payment_status = 'cancelled';
        ord.updated_at = new Date().toISOString();
      }
      return { rows: ord ? [ord] : [], rowCount: ord ? 1 : 0 };
    }

    if (sql.includes("UPDATE orders SET payment_method='cash', order_status='cash_confirmation_pending'")) {
      const ord = orders.get(params[0]);
      if (ord) {
        ord.payment_method = 'cash';
        ord.order_status = 'cash_confirmation_pending';
        ord.payment_reference = null;
        ord.payment_claimed_at = null;
        ord.updated_at = new Date().toISOString();
      }
      return { rows: ord ? [ord] : [], rowCount: ord ? 1 : 0 };
    }

    // Shop admin overview stats
    if (sql.includes('today_orders') && sql.includes('FROM orders WHERE shop_id=$1')) {
      const shopOrders = [...orders.values()].filter(o => o.shop_id === params[0]);
      const todayStr = new Date().toISOString().slice(0, 10);
      const todayList = shopOrders.filter(o => String(o.created_at).slice(0, 10) === todayStr);
      return {
        rows: [{
          today_orders: todayList.length,
          today_pages: todayList.reduce((sum, o) => sum + Number(o.config?.billablePages || 0), 0),
          today_earnings: todayList.filter(o => ['print_queued', 'printing', 'completed'].includes(o.order_status)).reduce((sum, o) => sum + Number(o.amount || 0), 0).toFixed(2),
          cash_pending: shopOrders.filter(o => o.order_status === 'cash_confirmation_pending').length,
          payment_pending: shopOrders.filter(o => o.order_status === 'payment_review').length,
          awaiting_payment: shopOrders.filter(o => o.order_status === 'pending_payment').length,
          queue: shopOrders.filter(o => ['queued', 'claimed', 'printing'].includes(o.print_status)).length,
        }],
        rowCount: 1,
      };
    }

    // Shop admin orders & recent
    if (sql.includes('FROM orders o JOIN uploads u ON u.id=o.upload_id LEFT JOIN print_jobs j ON j.order_id=o.id WHERE')) {
      const shopId = params[0];
      const rows = [...orders.values()]
        .filter(o => o.shop_id === shopId)
        .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
        .map(o => {
          const u = uploads.get(o.upload_id) || {};
          const j = [...printJobs.values()].find(job => job.order_id === o.id) || {};
          return {
            ...o,
            original_name: u.original_name || 'Document.pdf',
            mime_type: u.mime_type || 'application/pdf',
            byte_size: u.byte_size || 0,
            print_error: j.error_message || null,
            print_attempts: j.attempts || 0,
            print_queue_position: j.queue_position || null,
          };
        });
      return { rows, rowCount: rows.length };
    }

    // Print queue
    if (sql.includes('FROM print_jobs j JOIN orders o ON o.id = j.order_id')) {
      const shopId = params[0];
      const rows = [...printJobs.values()]
        .filter(j => j.shop_id === shopId && j.status === 'queued')
        .sort((a, b) => (a.queue_position || 0) - (b.queue_position || 0))
        .map(j => {
          const o = orders.get(j.order_id) || {};
          const u = uploads.get(o.upload_id) || {};
          return {
            ...o,
            original_name: u.original_name || 'Document.pdf',
            mime_type: u.mime_type || 'application/pdf',
            byte_size: u.byte_size || 0,
            print_error: j.error_message || null,
            print_attempts: j.attempts || 0,
            print_queue_position: j.queue_position || 1,
          };
        });
      return { rows, rowCount: rows.length };
    }

    if (sql.startsWith('SELECT * FROM orders WHERE id=$1')) {
      const ord = orders.get(params[0]);
      if (ord && (!params[1] || ord.shop_id === params[1])) return { rows: [ord], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    }

    if (sql.startsWith('INSERT INTO print_jobs(')) {
      const [order_id, shop_id, queue_position] = params;
      const existing = [...printJobs.values()].find(j => j.order_id === order_id);
      if (existing) {
        existing.status = 'queued';
        existing.queue_position = queue_position;
        existing.attempts = 0;
        existing.error_message = null;
      } else {
        const id = crypto.randomUUID();
        printJobs.set(id, { id, order_id, shop_id, status: 'queued', queue_position, attempts: 0, error_message: null, created_at: new Date().toISOString() });
      }
      return { rows: [], rowCount: 1 };
    }

    if (sql.startsWith('UPDATE orders SET') && sql.includes('WHERE id=$1')) {
      const ord = orders.get(params[0]);
      if (ord) {
        if (sql.includes("order_status='print_queued'")) {
          ord.order_status = 'print_queued';
          ord.print_status = 'queued';
          ord.payment_status = 'verified';
          ord.confirmed_at = ord.confirmed_at || new Date().toISOString();
        } else if (sql.includes("payment_status='failed'")) {
          ord.payment_status = 'failed';
          ord.order_status = 'failed';
        } else if (sql.includes("order_status='cancelled'")) {
          ord.print_status = 'not_ready';
          ord.order_status = 'cancelled';
          if (ord.payment_status === 'pending') ord.payment_status = 'cancelled';
        } else if (sql.includes("order_status='failed'")) {
          ord.order_status = 'failed';
          ord.print_status = 'failed';
        } else if (sql.includes("order_status='completed'")) {
          ord.order_status = 'completed';
          ord.print_status = 'completed';
          ord.completed_at = new Date().toISOString();
        }
        ord.updated_at = new Date().toISOString();
      }
      return { rows: ord ? [ord] : [], rowCount: ord ? 1 : 0 };
    }

    if (sql.startsWith('DELETE FROM orders WHERE id = $1')) {
      const existed = orders.delete(params[0]);
      return { rows: [], rowCount: existed ? 1 : 0 };
    }

    if (sql.includes('SELECT count(*)::int n FROM print_jobs j')) {
      return { rows: [{ n: 0 }], rowCount: 1 };
    }

    if (sql.startsWith('SELECT u.stored_name,u.original_name,o.print_file_name FROM uploads u JOIN orders o')) {
      const ord = orders.get(params[0]);
      if (!ord || ord.shop_id !== params[1]) return { rows: [], rowCount: 0 };
      const up = uploads.get(ord.upload_id);
      if (!up) return { rows: [], rowCount: 0 };
      return { rows: [{ stored_name: up.stored_name, original_name: up.original_name, print_file_name: ord.print_file_name }], rowCount: 1 };
    }

    return { rows: [], rowCount: 0 };
  }

  return {
    query,
    connect: async () => ({
      query,
      release: () => {},
    }),
    end: async () => {},
    on: () => {},
  };
}

let pool;
let usingMock = false;

if (process.env.DATABASE_URL) {
  try {
    const connectionString = process.env.DATABASE_URL.replace(
      /([?&]sslmode=)(?:prefer|require|verify-ca)(?=&|#|$)/i,
      '$1verify-full',
    );
    pool = new Pool({
      connectionString,
      ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : undefined,
      max: 10,
      idleTimeoutMillis: 30000,
    });
    pool.on('error', (error) => console.error('Unexpected database pool error', error.message));
  } catch (err) {
    console.warn('[AI Studio] Database connection setup failed — using in-memory mock database');
    pool = createMockPool();
    usingMock = true;
  }
} else {
  console.warn('[AI Studio] DATABASE_URL not set — using in-memory mock database');
  pool = createMockPool();
  usingMock = true;
}

async function initialize() {
  if (usingMock) return;
  try {
    const schema = fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8');
    await pool.query(schema);
  } catch (err) {
    console.warn('[AI Studio] PostgreSQL unreachable — falling back to in-memory mock database:', err.message);
    const mock = createMockPool();
    pool.query = mock.query;
    pool.connect = mock.connect;
    pool.end = mock.end;
    usingMock = true;
  }
}

module.exports = { pool, initialize };

