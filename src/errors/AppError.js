class AppError extends Error {
  constructor(message, statusCode = 400, errorCode = 'ERROR', details = null) {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.errorCode = errorCode;
    this.details = details;
    Error.captureStackTrace(this, this.constructor);
  }
}

class UnknownCodeError extends AppError {
  constructor(message = 'Coupon code does not exist') {
    super(message, 404, 'unknown code');
  }
}

class ExpiredCouponError extends AppError {
  constructor(message = 'Coupon has expired') {
    super(message, 410, 'expired');
  }
}

class NoRedemptionsLeftError extends AppError {
  constructor(message = 'Coupon max redemptions limit reached') {
    super(message, 409, 'no redemptions left');
  }
}

class AlreadyUsedError extends AppError {
  constructor(message = 'Standard coupon already used by this customer') {
    super(message, 409, 'already used');
  }
}

class OrderAlreadyRedeemedError extends AppError {
  constructor(message = 'Order has already used a coupon') {
    super(message, 409, 'order already redeemed');
  }
}

class ValidationError extends AppError {
  constructor(message = 'Invalid request parameters', details = null) {
    super(message, 400, 'invalid request', details);
  }
}

module.exports = {
  AppError,
  UnknownCodeError,
  ExpiredCouponError,
  NoRedemptionsLeftError,
  AlreadyUsedError,
  OrderAlreadyRedeemedError,
  ValidationError
};
