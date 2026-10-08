const mysql = require('mysql2/promise');
require('dotenv').config();

const pool = mysql.createPool({
  host: process.env.DB_HOST || '127.0.0.1',
  port: parseInt(process.env.DB_PORT || '3306', 10),
  user: process.env.DB_USER || 'coupon_user',
  password: process.env.DB_PASSWORD || 'coupon_password',
  database: process.env.DB_NAME || 'coupon_service',
  waitForConnections: true,
  connectionLimit: parseInt(process.env.DB_CONNECTION_LIMIT || '25', 10),
  queueLimit: 0,
  decimalNumbers: true,
  dateStrings: true
});

/**
 * Execute a unit of work inside a managed transaction with READ COMMITTED
 * isolation level and automatic deadlock retry handling.
 *
 * @param {Function} callback - Function receiving the transactional connection
 * @param {number} maxRetries - Maximum number of retries upon ER_LOCK_DEADLOCK
 * @returns {Promise<any>} Result returned by callback
 */
async function withTransaction(callback, maxRetries = 5) {
  let attempt = 0;

  while (true) {
    attempt++;
    const connection = await pool.getConnection();

    try {
      await connection.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED');
      await connection.beginTransaction();
      const result = await callback(connection);
      await connection.commit();
      return result;
    } catch (error) {
      try {
        await connection.rollback();
      } catch (rollbackError) {
        console.error('Error during transaction rollback:', rollbackError);
      }

      // If InnoDB detected a transient deadlock, retry with slight jitter
      if (error.code === 'ER_LOCK_DEADLOCK' && attempt < maxRetries) {
        const jitterMs = Math.floor(Math.random() * 20) + 10 * attempt;
        await new Promise((resolve) => setTimeout(resolve, jitterMs));
        continue;
      }

      throw error;
    } finally {
      connection.release();
    }
  }
}

module.exports = {
  pool,
  withTransaction
};
