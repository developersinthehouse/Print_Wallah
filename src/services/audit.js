const { pool } = require('../db');
async function audit(shopId, actor, action, details = {}) {
  await pool.query('INSERT INTO audit_log(shop_id, actor, action, details) VALUES($1,$2,$3,$4)', [shopId || null, actor, action, details]);
}
module.exports = { audit };
