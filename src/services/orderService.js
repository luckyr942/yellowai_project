const { withTransaction } = require('../config/db');
const { ValidationError } = require('../errors/AppError');

class OrderService {
  /**
   * Reverses the coupon redemption tied to that order, if any.
   * Strictly idempotent: calling it twice is a safe no-op that never double-refunds the slot.
   */
  async cancelOrder(order_id) {
    if (!order_id || typeof order_id !== 'string' || !order_id.trim()) {
      throw new ValidationError('order_id is required');
    }

    const cleanOrderId = order_id.trim();

    return await withTransaction(async (conn) => {
      // 1. Lock the redemption row for this order
      const [rows] = await conn.query(
        `SELECT id, coupon_id, coupon_code, status
         FROM redemptions
         WHERE order_id = ?
         FOR UPDATE`,
        [cleanOrderId]
      );

      // Case 1: Order never had a coupon redemption
      if (rows.length === 0) {
        return {
          success: true,
          order_id: cleanOrderId,
          status: 'NO_REDEMPTION',
          message: 'No coupon was redeemed for this order'
        };
      }

      const redemption = rows[0];

      // Case 2: Order was already cancelled previously -> Idempotent no-op
      if (redemption.status === 'CANCELLED') {
        return {
          success: true,
          order_id: cleanOrderId,
          status: 'ALREADY_CANCELLED',
          message: 'Order coupon redemption was already cancelled (no-op)'
        };
      }

      // Case 3: Order has an ACTIVE redemption -> Transition to CANCELLED and return slot
      const [updateRedemption] = await conn.query(
        `UPDATE redemptions
         SET status = 'CANCELLED'
         WHERE id = ? AND status = 'ACTIVE'`,
        [redemption.id]
      );

      if (updateRedemption.affectedRows === 1) {
        // Decrement redeemed_count on coupon table
        await conn.query(
          `UPDATE coupons
           SET redeemed_count = GREATEST(0, redeemed_count - 1)
           WHERE id = ?`,
          [redemption.coupon_id]
        );

        // Remove from standard coupon usage tracking to free slot for customer
        await conn.query(
          `DELETE FROM standard_coupon_usage WHERE order_id = ?`,
          [cleanOrderId]
        );

        return {
          success: true,
          order_id: cleanOrderId,
          coupon_code: redemption.coupon_code,
          status: 'REVERSED',
          message: 'Coupon redemption successfully reversed'
        };
      }

      // Fallback if concurrent transaction already completed the cancellation
      return {
        success: true,
        order_id: cleanOrderId,
        status: 'ALREADY_CANCELLED',
        message: 'Order coupon redemption was already cancelled (no-op)'
      };
    });
  }
}

module.exports = new OrderService();
