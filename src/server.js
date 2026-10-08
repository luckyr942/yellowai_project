require('dotenv').config();
const app = require('./app');
const { pool } = require('./config/db');

const PORT = parseInt(process.env.PORT || '3001', 10);

const server = app.listen(PORT, () => {
  console.log(`[Coupon Service] Server running on port ${PORT}`);
});

function gracefulShutdown(signal) {
  console.log(`[Coupon Service] Received ${signal}. Shutting down gracefully...`);
  server.close(async () => {
    console.log('[Coupon Service] HTTP server closed.');
    try {
      await pool.end();
      console.log('[Coupon Service] MySQL connection pool closed.');
      process.exit(0);
    } catch (err) {
      console.error('[Coupon Service] Error closing database pool:', err);
      process.exit(1);
    }
  });
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
