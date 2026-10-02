const fs = require('node:fs/promises');
const path = require('node:path');

const PRINT_FILE_RETENTION_MS = 10 * 60 * 1000;
const CLEANUP_BATCH_SIZE = 100;

async function cleanupCompletedOrderFiles({ pool, uploadDir, now = new Date() }) {
  const cutoff = new Date(now.getTime() - PRINT_FILE_RETENTION_MS);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: orders } = await client.query(
      `SELECT id, upload_id, print_file_name
       FROM orders
       WHERE order_status = 'completed'
         AND completed_at <= $1
         AND files_deleted_at IS NULL
       ORDER BY completed_at, id
       LIMIT $2
       FOR UPDATE SKIP LOCKED`,
      [cutoff, CLEANUP_BATCH_SIZE],
    );

    let deletedFiles = 0;
    for (const order of orders) {
      const { rows: uploadRows } = await client.query(
        `SELECT stored_name FROM uploads WHERE id = $1
         UNION
         SELECT uploads.stored_name
         FROM order_uploads
         JOIN uploads ON uploads.id = order_uploads.upload_id
         WHERE order_uploads.order_id = $2`,
        [order.upload_id, order.id],
      );
      const storedNames = new Set(uploadRows.map((row) => row.stored_name));
      if (order.print_file_name) storedNames.add(order.print_file_name);

      for (const storedName of storedNames) {
        if (typeof storedName !== 'string' || !storedName || path.basename(storedName) !== storedName) {
          throw new Error(`Unsafe stored print-file name for order ${order.id}`);
        }
        await fs.rm(path.join(uploadDir, storedName), { force: true });
        deletedFiles += 1;
      }

      await client.query(
        'UPDATE orders SET files_deleted_at = $2 WHERE id = $1 AND files_deleted_at IS NULL',
        [order.id, now],
      );
    }

    await client.query('COMMIT');
    return { ordersDeleted: orders.length, filesDeleted: deletedFiles };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

module.exports = { cleanupCompletedOrderFiles, PRINT_FILE_RETENTION_MS };