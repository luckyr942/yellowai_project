const express = require('express');
const couponController = require('./controllers/couponController');
const orderController = require('./controllers/orderController');
const { AppError } = require('./errors/AppError');
const { pool } = require('./config/db');

const app = express();

app.use(express.json());

// Health check endpoint
app.get('/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.status(200).json({ status: 'ok', database: 'connected' });
  } catch (error) {
    res.status(503).json({ status: 'error', database: 'unhealthy', message: error.message });
  }
});

// Coupon endpoints
app.post('/coupons', (req, res, next) => couponController.createCoupon(req, res, next));
app.get('/coupons/:code', (req, res, next) => couponController.getCoupon(req, res, next));
app.post('/redeem', (req, res, next) => couponController.redeemCoupon(req, res, next));

// Order endpoints
app.post('/orders/:order_id/cancel', (req, res, next) => orderController.cancelOrder(req, res, next));

// 404 Route Not Found
app.use((req, res, next) => {
  res.status(404).json({
    success: false,
    error: 'route not found',
    message: `Cannot ${req.method} ${req.originalUrl}`
  });
});

// Centralized Error Handling Middleware
app.use((err, req, res, next) => {
  if (err instanceof AppError) {
    return res.status(err.statusCode).json({
      success: false,
      error: err.errorCode,
      message: err.message,
      ...(err.details ? { details: err.details } : {})
    });
  }

  console.error('Unhandled Application Error:', err);
  return res.status(500).json({
    success: false,
    error: 'internal error',
    message: 'An unexpected internal error occurred'
  });
});

module.exports = app;
