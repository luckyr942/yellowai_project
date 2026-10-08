const orderService = require('../services/orderService');

class OrderController {
  /**
   * POST /orders/:order_id/cancel
   * Reverses coupon redemption tied to that order, if any.
   * Calling it twice is an idempotent no-op.
   */
  async cancelOrder(req, res, next) {
    try {
      const { order_id } = req.params;
      const result = await orderService.cancelOrder(order_id);
      return res.status(200).json(result);
    } catch (error) {
      next(error);
    }
  }
}

module.exports = new OrderController();
