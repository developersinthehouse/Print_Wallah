const { writeAudit } = require('../firestoreStore');
async function audit(shopId, actor, action, details = {}) {
  await writeAudit({ shop_id: shopId || null, actor, action, details });
}
module.exports = { audit };
