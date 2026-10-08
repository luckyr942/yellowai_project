CREATE DATABASE IF NOT EXISTS coupon_service;
USE coupon_service;

-- 1. Coupons Master Table
CREATE TABLE IF NOT EXISTS coupons (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    code VARCHAR(64) NOT NULL UNIQUE,
    max_redemptions INT UNSIGNED NOT NULL,
    redeemed_count INT UNSIGNED NOT NULL DEFAULT 0,
    discount_percent DECIMAL(5, 2) NOT NULL,
    expires_at DATETIME NOT NULL,
    type ENUM('STANDARD', 'STACKABLE') NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    
    -- Hard database constraints against race condition anomalies
    CONSTRAINT chk_redeemed_not_exceed_max CHECK (redeemed_count <= max_redemptions),
    CONSTRAINT chk_redeemed_non_negative CHECK (redeemed_count >= 0),
    CONSTRAINT chk_discount_range CHECK (discount_percent > 0 AND discount_percent <= 100),
    
    INDEX idx_coupons_code (code),
    INDEX idx_coupons_expires_at (expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 2. Redemptions Log Table
CREATE TABLE IF NOT EXISTS redemptions (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    coupon_id BIGINT NOT NULL,
    coupon_code VARCHAR(64) NOT NULL,
    customer_id VARCHAR(64) NOT NULL,
    order_id VARCHAR(64) NOT NULL UNIQUE,
    status ENUM('ACTIVE', 'CANCELLED') NOT NULL DEFAULT 'ACTIVE',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    
    FOREIGN KEY (coupon_id) REFERENCES coupons(id) ON DELETE RESTRICT,
    INDEX idx_redemptions_order (order_id),
    INDEX idx_redemptions_lookup (coupon_code, customer_id, status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 3. Standard Coupon Customer Usage Tracking (Atomic DB Primary Key Constraint)
CREATE TABLE IF NOT EXISTS standard_coupon_usage (
    coupon_id BIGINT NOT NULL,
    customer_id VARCHAR(64) NOT NULL,
    order_id VARCHAR(64) NOT NULL,
    PRIMARY KEY (coupon_id, customer_id),
    INDEX idx_std_order (order_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 4. Idempotency Records Table
CREATE TABLE IF NOT EXISTS idempotency_records (
    idempotency_key VARCHAR(128) PRIMARY KEY,
    status_code INT NOT NULL,
    response_body JSON NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_idempotency_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
