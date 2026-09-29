function mapShop(row) {
  if (!row) return null;
  return {
    id: row.id,
    shopName: row.shop_name,
    ownerName: row.owner_name,
    ownerEmail: row.owner_email,
    rates: {
      blackAndWhitePerPage: Number(row.black_and_white_per_page),
      colorPerPage: Number(row.color_per_page),
    },
    subscription_status: row.subscription_status,
    subscription_expiry_date: row.subscription_expiry_date,
    subscription_lock_reason: row.subscription_lock_reason,
    createdAt: row.created_at,
  };
}

function mapJob(row) {
  return {
    id: row.id,
    documentName: row.document_name,
    fileName: row.file_name,
    fileUrl: row.file_url,
    pageCount: row.page_count,
    totalAmount: Number(row.total_amount),
    status: row.status,
    error: row.print_error,
    createdAt: row.created_at,
  };
}

async function withTransaction(pool, action) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await action(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

function createPostgresRepositories(pool) {
  const shopRepository = {
    async findById(shopId) {
      const result = await pool.query('SELECT * FROM shop_profiles WHERE id = $1', [shopId]);
      return mapShop(result.rows[0]);
    },

    async getRates(shopId) {
      const result = await pool.query(
        'SELECT black_and_white_per_page, color_per_page FROM shop_profiles WHERE id = $1',
        [shopId],
      );
      const row = result.rows[0];
      return row ? {
        blackAndWhitePerPage: Number(row.black_and_white_per_page),
        colorPerPage: Number(row.color_per_page),
      } : null;
    },

    async getShopSettings(shopId) {
      const result = await pool.query(
        `SELECT black_and_white_per_page, color_per_page, upi_id
         FROM shop_profiles WHERE id = $1`,
        [shopId],
      );
      const row = result.rows[0];
      return row ? {
        rates: {
          blackAndWhitePerPage: Number(row.black_and_white_per_page),
          colorPerPage: Number(row.color_per_page),
        },
        upiId: row.upi_id || '',
      } : null;
    },

    async updateShopSettings(shopId, settings) {
      const result = await pool.query(
        `UPDATE shop_profiles
         SET black_and_white_per_page = $2,
             color_per_page = $3,
             upi_id = $4,
             updated_at = NOW()
         WHERE id = $1
         RETURNING black_and_white_per_page, color_per_page, upi_id`,
        [shopId, settings.rates.blackAndWhitePerPage, settings.rates.colorPerPage, settings.upiId],
      );
      const row = result.rows[0];
      return row ? {
        rates: {
          blackAndWhitePerPage: Number(row.black_and_white_per_page),
          colorPerPage: Number(row.color_per_page),
        },
        upiId: row.upi_id || '',
      } : null;
    },

    async updateRates(shopId, rates) {
      const result = await pool.query(
        `UPDATE shop_profiles
         SET black_and_white_per_page = $2, color_per_page = $3, updated_at = NOW()
         WHERE id = $1
         RETURNING black_and_white_per_page, color_per_page`,
        [shopId, rates.blackAndWhitePerPage, rates.colorPerPage],
      );
      const row = result.rows[0];
      return row ? {
        blackAndWhitePerPage: Number(row.black_and_white_per_page),
        colorPerPage: Number(row.color_per_page),
      } : null;
    },

    async findExpiredShops(now) {
      const result = await pool.query(
        `SELECT id FROM shop_profiles
         WHERE subscription_expiry_date <= $1 AND subscription_status <> 'EXPIRED'`,
        [now],
      );
      return result.rows;
    },

    async lockIfExpired(shopId, now) {
      const result = await pool.query(
        `UPDATE shop_profiles
         SET subscription_status = 'EXPIRED',
             subscription_lock_reason = 'Subscription expired',
             updated_at = NOW()
         WHERE id = $1
           AND subscription_expiry_date <= $2
           AND subscription_status <> 'EXPIRED'
         RETURNING id`,
        [shopId, now],
      );
      return result.rowCount > 0;
    },

    async applyVerifiedRenewal({ shopId, paymentId, planId, expectedExpiry, newExpiry, renewedAt }) {
      return withTransaction(pool, async (client) => {
        const existingPayment = await client.query(
          'SELECT shop_id, new_expiry FROM subscription_logs WHERE payment_id = $1',
          [paymentId],
        );
        if (existingPayment.rowCount > 0) {
          const existing = existingPayment.rows[0];
          if (existing.shop_id !== shopId) return { conflict: true };
          return { duplicate: true, subscriptionExpiryDate: existing.new_expiry };
        }

        const updated = await client.query(
          `UPDATE shop_profiles
           SET subscription_expiry_date = $3,
               subscription_status = 'ACTIVE',
               subscription_lock_reason = NULL,
               updated_at = $4
           WHERE id = $1 AND subscription_expiry_date = $2
           RETURNING subscription_expiry_date`,
          [shopId, expectedExpiry, newExpiry, renewedAt],
        );
        if (updated.rowCount === 0) {
          const exists = await client.query('SELECT id FROM shop_profiles WHERE id = $1', [shopId]);
          return exists.rowCount === 0 ? null : { conflict: true };
        }

        await client.query(
          `INSERT INTO subscription_logs
            (shop_id, payment_id, event_type, plan_id, previous_expiry, new_expiry, created_at)
           VALUES ($1, $2, 'PAYMENT_RENEWAL', $3, $4, $5, $6)`,
          [shopId, paymentId, planId, expectedExpiry, newExpiry, renewedAt],
        );
        return { duplicate: false, subscriptionExpiryDate: updated.rows[0].subscription_expiry_date };
      });
    },

    async listShops({ limit, offset, status, search }) {
      const conditions = [];
      const values = [];
      if (status === 'EXPIRED') {
        values.push(new Date());
        conditions.push(`(subscription_status = 'EXPIRED' OR subscription_expiry_date <= $${values.length})`);
      } else if (status) {
        values.push(status);
        conditions.push(`subscription_status = $${values.length}`);
      }
      if (search) {
        values.push(`%${search}%`);
        conditions.push(`(shop_name ILIKE $${values.length} OR owner_name ILIKE $${values.length} OR owner_email ILIKE $${values.length})`);
      }
      const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
      const countResult = await pool.query(
        `SELECT COUNT(*)::int AS total FROM shop_profiles ${whereClause}`,
        values,
      );
      const pageValues = [...values, limit, offset];
      const result = await pool.query(
        `SELECT * FROM shop_profiles ${whereClause}
         ORDER BY created_at DESC LIMIT $${pageValues.length - 1} OFFSET $${pageValues.length}`,
        pageValues,
      );
      return { shops: result.rows.map(mapShop), total: countResult.rows[0].total };
    },

    async getSubscriptionCounts(now) {
      const result = await pool.query(
        `SELECT COUNT(*)::int AS total,
          COUNT(CASE WHEN subscription_status = 'ACTIVE' AND subscription_expiry_date > $1 THEN id END)::int AS active,
          COUNT(CASE WHEN subscription_status = 'EXPIRED' OR subscription_expiry_date <= $1 THEN id END)::int AS expired,
          COUNT(CASE WHEN subscription_status = 'LOCKED' AND subscription_expiry_date > $1 THEN id END)::int AS locked
         FROM shop_profiles`,
        [now],
      );
      return result.rows[0];
    },
  };

  const printJobRepository = {
    async getSummary(shopId, { from, to }) {
      const result = await pool.query(
        `SELECT COUNT(CASE WHEN status = 'PRINTED' THEN id END)::int AS total_prints,
          COALESCE(SUM(CASE WHEN status = 'PRINTED' THEN total_amount ELSE 0 END), 0) AS revenue
         FROM print_jobs
         WHERE shop_id = $1 AND created_at >= $2 AND created_at < $3`,
        [shopId, from, to],
      );
      return {
        totalPrints: result.rows[0].total_prints,
        revenue: Number(result.rows[0].revenue),
      };
    },

    async listForShop(shopId, { from, to, limit, offset, status }) {
      const conditions = ['shop_id = $1'];
      const values = [shopId];
      if (from) {
        values.push(from);
        conditions.push(`created_at >= $${values.length}`);
      }
      if (to) {
        values.push(to);
        conditions.push(`created_at < $${values.length}`);
      }
      if (status) {
        values.push(status);
        conditions.push(`status = $${values.length}`);
      }
      const whereClause = conditions.join(' AND ');
      const countResult = await pool.query(
        `SELECT COUNT(*)::int AS total FROM print_jobs WHERE ${whereClause}`,
        values,
      );
      const pageValues = [...values, limit, offset];
      const result = await pool.query(
        `SELECT * FROM print_jobs WHERE ${whereClause}
         ORDER BY created_at DESC LIMIT $${pageValues.length - 1} OFFSET $${pageValues.length}`,
        pageValues,
      );
      return { jobs: result.rows.map(mapJob), total: countResult.rows[0].total };
    },

    async updateResult(shopId, jobId, { status, error }) {
      const updated = await pool.query(
        `UPDATE print_jobs
         SET status = $3,
             print_error = $4,
             printed_at = CASE WHEN $3 = 'PRINTED' THEN COALESCE(printed_at, NOW()) ELSE printed_at END
         WHERE shop_id = $1 AND id = $2 AND (status = 'READY_TO_PRINT' OR status = $3)
         RETURNING *`,
        [shopId, jobId, status, error || null],
      );
      if (updated.rowCount > 0) return mapJob(updated.rows[0]);

      const existing = await pool.query('SELECT * FROM print_jobs WHERE shop_id = $1 AND id = $2', [shopId, jobId]);
      return existing.rows[0] && existing.rows[0].status === status ? mapJob(existing.rows[0]) : null;
    },

    async getPlatformVolume() {
      const result = await pool.query(
        `SELECT COALESCE(SUM(total_amount), 0) AS volume
         FROM print_jobs WHERE status = 'PRINTED'`,
      );
      return Number(result.rows[0].volume);
    },
  };

  const adminRepository = {
    async createShopWithAudit({ shop, audit, shopAdminSetupTokenHash, shopAdminSetupExpiresAt }) {
      return withTransaction(pool, async (client) => {
        const inserted = await client.query(
          `INSERT INTO shop_profiles
            (id, shop_name, owner_name, owner_email, black_and_white_per_page, color_per_page,
             subscription_expiry_date, subscription_status, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9)
           RETURNING *`,
          [
            shop.id, shop.shopName, shop.ownerName, shop.ownerEmail,
            shop.rates.blackAndWhitePerPage, shop.rates.colorPerPage,
            shop.subscription_expiry_date, shop.subscription_status, shop.createdAt,
          ],
        );
        if (shopAdminSetupTokenHash && shopAdminSetupExpiresAt) {
          await client.query(
            `INSERT INTO shop_admin_credentials (shop_id, setup_token_hash, setup_expires_at)
             VALUES ($1, $2, $3)`,
            [shop.id, shopAdminSetupTokenHash, shopAdminSetupExpiresAt],
          );
        }
        await insertAudit(client, audit);
        return mapShop(inserted.rows[0]);
      });
    },

    async updateSubscriptionWithAudit({ shopId, expectedExpiry, update, audit }) {
      return withTransaction(pool, async (client) => {
        const updated = await client.query(
          `UPDATE shop_profiles
           SET subscription_status = $3,
               subscription_expiry_date = COALESCE($4, subscription_expiry_date),
               subscription_lock_reason = $5,
               updated_at = $6
           WHERE id = $1 AND ($2::timestamptz IS NULL OR subscription_expiry_date = $2)
           RETURNING *`,
          [
            shopId,
            expectedExpiry,
            update.subscription_status,
            update.subscription_expiry_date || null,
            update.subscription_lock_reason,
            audit.createdAt,
          ],
        );
        if (updated.rowCount === 0) {
          const exists = await client.query('SELECT id FROM shop_profiles WHERE id = $1', [shopId]);
          return exists.rowCount === 0 ? null : { conflict: true };
        }
        await insertAudit(client, audit);
        return { shop: mapShop(updated.rows[0]) };
      });
    },
  };

  return { shopRepository, printJobRepository, adminRepository };
}

async function insertAudit(client, audit) {
  await client.query(
    `INSERT INTO admin_audit (admin_id, action, shop_id, reason, details, created_at)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6)`,
    [audit.adminId, audit.action, audit.shopId || null, audit.reason || null, JSON.stringify(audit.details || {}), audit.createdAt],
  );
}

module.exports = { createPostgresRepositories, mapJob, mapShop, withTransaction };