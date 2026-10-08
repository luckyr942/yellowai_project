const couponService = require('../services/couponService');
const { ValidationError } = require('../errors/AppError');

class CouponController {
  /**
   * POST /coupons
   * Seed / Create a coupon
   */
  async createCoupon(req, res, next) {
    try {
      const { code, max_redemptions, discount_percent, expires_at, type } = req.body;
      const coupon = await couponService.createCoupon({
        code,
        max_redemptions,
        discount_percent,
        expires_at,
        type
      });

      return res.status(201).json({
        success: true,
        data: coupon
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * GET /coupons/:code
   * Return strictly consistent counts
   */
  async getCoupon(req, res, next) {
    try {
      const { code } = req.params;
      const data = await couponService.getCouponByCode(code);
      return res.status(200).json(data);
    } catch (error) {
      next(error);
    }
  }

  /**
   * POST /redeem (header: Idempotency-Key)
   * Redeem a coupon with distinct error codes per failure mode
   */
  async redeemCoupon(req, res, next) {
    try {
      const idempotencyKey = req.header('Idempotency-Key') || req.header('idempotency-key') || null;
      const { code, customer_id, order_id } = req.body;

      const result = await couponService.redeemCoupon({
        code,
        customer_id,
        order_id,
        idempotencyKey
      });

      if (result.isReplay) {
        res.setHeader('X-Idempotent-Replay', 'true');
      }

      return res.status(result.statusCode).json(result.response);
    } catch (error) {
      next(error);
    }
  }
}

module.exports = new CouponController();
