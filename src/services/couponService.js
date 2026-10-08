const { pool, withTransaction } = require('../config/db');
const {
  UnknownCodeError,
  ExpiredCouponError,
  NoRedemptionsLeftError,
  AlreadyUsedError,
  OrderAlreadyRedeemedError,
  ValidationError,
  AppError
} = require('../errors/AppError');

class CouponService {
  /**
   * Seed / Create a new coupon
   */
  async createCoupon({ code, max_redemptions, discount_percent, expires_at, type }) {
    if (!code || typeof code !== 'string' || !code.trim()) {
      throw new ValidationError('Coupon code is required');
    }
    const cleanCode = code.trim().toUpperCase();

    const maxRedemptions = parseInt(max_redemptions, 10);
    if (isNaN(maxRedemptions) || maxRedemptions <= 0) {
      throw new ValidationError('max_redemptions must be a positive integer greater than 0');
    }

    const discountPercent = parseFloat(discount_percent);
    if (isNaN(discountPercent) || discountPercent <= 0 || discountPercent > 100) {
      throw new ValidationError('discount_percent must be a number between 0 and 100');
    }

    const expiryDate = new Date(expires_at);
    if (isNaN(expiryDate.getTime())) {
      throw new ValidationError('expires_at must be a valid date');
    }

    const couponType = (type || '').toUpperCase();
    if (!['STANDARD', 'STACKABLE'].includes(couponType)) {
      throw new ValidationError("type must be either 'STANDARD' or 'STACKABLE'");
    }

    try {
      const formattedExpiry = expiryDate.toISOString().slice(0, 19).replace('T', ' ');

      const [result] = await pool.query(
        `INSERT INTO coupons (code, max_redemptions, redeemed_count, discount_percent, expires_at, type)
         VALUES (?, ?, 0, ?, ?, ?)`,
        [cleanCode, maxRedemptions, discountPercent, formattedExpiry, couponType]
      );

      const [rows] = await pool.query(
        `SELECT id, code, max_redemptions, redeemed_count, discount_percent, expires_at, type, created_at
         FROM coupons WHERE id = ?`,
        [result.insertId]
      );

      return rows[0];
    } catch (error) {
      if (error.code === 'ER_DUP_ENTRY') {
        throw new AppError(`Coupon with code '${cleanCode}' already exists`, 409, 'COUPON_ALREADY_EXISTS');
      }
      throw error;
    }
  }

  /**
   * Get coupon details: redeemed_count, remaining, max_redemptions
   * Guaranteed strictly consistent at all times (O(1) read).
   */
  async getCouponByCode(code) {
    if (!code || typeof code !== 'string') {
      throw new ValidationError('Coupon code is required');
    }
    const cleanCode = code.trim().toUpperCase();

    const [rows] = await pool.query(
      `SELECT code, max_redemptions, redeemed_count, expires_at, type
       FROM coupons WHERE code = ?`,
      [cleanCode]
    );

    if (rows.length === 0) {
      throw new UnknownCodeError(`Coupon code '${cleanCode}' not found`);
    }

    const coupon = rows[0];
    const remaining = Math.max(0, coupon.max_redemptions - coupon.redeemed_count);

    return {
      code: coupon.code,
      redeemed_count: Number(coupon.redeemed_count),
      remaining: Number(remaining),
      max_redemptions: Number(coupon.max_redemptions)
    };
  }

  /**
   * Atomically redeem a coupon inside a transaction.
   * Handles concurrency, row locking, standard single-use checks, and idempotency.
   */
  async redeemCoupon({ code, customer_id, order_id, idempotencyKey }) {
    if (!code || typeof code !== 'string' || !code.trim()) {
      throw new ValidationError('Coupon code is required');
    }
    if (!customer_id || typeof customer_id !== 'string' || !customer_id.trim()) {
      throw new ValidationError('customer_id is required');
    }
    if (!order_id || typeof order_id !== 'string' || !order_id.trim()) {
      throw new ValidationError('order_id is required');
    }

    const cleanCode = code.trim().toUpperCase();
    const cleanCustomerId = customer_id.trim();
    const cleanOrderId = order_id.trim();

    return await withTransaction(async (conn) => {
      // 1. Check idempotency record first (fast lookup)
      if (idempotencyKey) {
        const [idemRows] = await conn.query(
          `SELECT status_code, response_body FROM idempotency_records WHERE idempotency_key = ?`,
          [idempotencyKey]
        );

        if (idemRows.length > 0) {
          const cached = idemRows[0];
          const parsedBody = typeof cached.response_body === 'string'
            ? JSON.parse(cached.response_body)
            : cached.response_body;

          return {
            isReplay: true,
            statusCode: cached.status_code,
            response: {
              ...parsedBody,
              idempotency_replay: true
            }
          };
        }
      }

      // 2. Lock the coupon row exclusively for update
      // Evaluate expiry using MySQL NOW() to guarantee consistent instant check across distributed servers
      const [couponRows] = await conn.query(
        `SELECT id, code, max_redemptions, redeemed_count, expires_at, type,
                (NOW() <= expires_at) AS is_valid_time
         FROM coupons
         WHERE code = ?
         FOR UPDATE`,
        [cleanCode]
      );

      if (couponRows.length === 0) {
        throw new UnknownCodeError(`Coupon code '${cleanCode}' does not exist`);
      }

      const coupon = couponRows[0];

      // 3. Verify Expiration at the exact instant the lock was acquired
      if (!coupon.is_valid_time) {
        throw new ExpiredCouponError(`Coupon '${cleanCode}' has expired`);
      }

      // 4. Verify Cap limit
      if (coupon.redeemed_count >= coupon.max_redemptions) {
        throw new NoRedemptionsLeftError(`Coupon '${cleanCode}' has reached maximum redemptions`);
      }

      // 5. If STANDARD type: enforce customer single-use with atomic DB unique constraint
      if (coupon.type === 'STANDARD') {
        try {
          await conn.query(
            `INSERT INTO standard_coupon_usage (coupon_id, customer_id, order_id)
             VALUES (?, ?, ?)`,
            [coupon.id, cleanCustomerId, cleanOrderId]
          );
        } catch (stdErr) {
          if (stdErr.code === 'ER_DUP_ENTRY') {
            throw new AlreadyUsedError(`Customer '${cleanCustomerId}' has already redeemed standard coupon '${cleanCode}'`);
          }
          throw stdErr;
        }
      }

      // 6. Check order uniqueness before updating
      const [existingOrder] = await conn.query(
        `SELECT id FROM redemptions WHERE order_id = ? LIMIT 1`,
        [cleanOrderId]
      );
      if (existingOrder.length > 0) {
        throw new OrderAlreadyRedeemedError(`Order '${cleanOrderId}' has already used a coupon`);
      }

      // 7. Increment redeemed_count atomically
      const [updateResult] = await conn.query(
        `UPDATE coupons
         SET redeemed_count = redeemed_count + 1
         WHERE id = ? AND redeemed_count < max_redemptions`,
        [coupon.id]
      );

      if (updateResult.affectedRows === 0) {
        throw new NoRedemptionsLeftError(`Coupon '${cleanCode}' has reached maximum redemptions`);
      }

      // 8. Record the redemption
      try {
        await conn.query(
          `INSERT INTO redemptions (coupon_id, coupon_code, customer_id, order_id, status)
           VALUES (?, ?, ?, ?, 'ACTIVE')`,
          [coupon.id, coupon.code, cleanCustomerId, cleanOrderId]
        );
      } catch (insertErr) {
        if (insertErr.code === 'ER_DUP_ENTRY') {
          throw new OrderAlreadyRedeemedError(`Order '${cleanOrderId}' has already used a coupon`);
        }
        throw insertErr;
      }

      const remaining = coupon.max_redemptions - (coupon.redeemed_count + 1);
      const responsePayload = {
        success: true,
        remaining: Math.max(0, remaining)
      };

      // 9. Store Idempotency Record (if header was provided)
      if (idempotencyKey) {
        try {
          await conn.query(
            `INSERT INTO idempotency_records (idempotency_key, status_code, response_body)
             VALUES (?, ?, ?)`,
            [idempotencyKey, 200, JSON.stringify(responsePayload)]
          );
        } catch (idemErr) {
          if (idemErr.code !== 'ER_DUP_ENTRY') {
            throw idemErr;
          }
        }
      }

      return {
        isReplay: false,
        statusCode: 200,
        response: responsePayload
      };
    });
  }
}

module.exports = new CouponService();
