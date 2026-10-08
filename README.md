# Coupon Redemption Service

A robust, high-concurrency coupon redemption microservice built with **Node.js, Express, and MySQL 8.0**.

The service enforces strict transactional guarantees across multiple concurrent application instances without relying on in-memory locks, ensuring that:
1. **The redemption cap is provably exact under concurrency**, even during massive flash-sale bursts.
2. **Order cancellation reverses slots strictly once**, making repeat cancellations idempotent.
3. **Network retries with `Idempotency-Key` are safe** and never double-redeem.
4. **Per-customer limits on `STANDARD` coupons** are strictly enforced.
5. **Exact in-flight expiry consistency** is maintained using the database timestamp.

---

## Architecture & Flow

```
                      +-----------------------------+
                      |   Client / Test Runners     |
                      +-----------------------------+
                        /                         \
         (Instance 1: 3001)                     (Instance 2: 3002)
                |                                       |
+-------------------------------+       +-------------------------------+
| Express API (Instance 1)      |       | Express API (Instance 2)      |
| - Validation & Error Mapping  |       | - Validation & Error Mapping  |
+-------------------------------+       +-------------------------------+
                |                                       |
+-------------------------------+       +-------------------------------+
| Service Layer                 |       | Service Layer                 |
| - Transaction boundaries      |       | - Transaction boundaries      |
+-------------------------------+       +-------------------------------+
                \                                       /
                 +-------------------------------------+
                                    |
                    +-------------------------------+
                    |         MySQL 8.0             |
                    | - SELECT ... FOR UPDATE       |
                    | - CHECK Constraints           |
                    | - Atomic State Transitions    |
                    +-------------------------------+
```

---

## Concurrency & Integrity Mechanics

### 1. Flash-Sale Concurrency Cap (`max_redemptions`)
To prove correctness across multiple distributed Node.js processes without in-memory locks:
- Each checkout transaction locks the coupon row with `SELECT ... FROM coupons WHERE code = ? FOR UPDATE`.
- The transactional lock serializes concurrent checkouts on that specific coupon row.
- An atomic update `UPDATE coupons SET redeemed_count = redeemed_count + 1 WHERE id = ? AND redeemed_count < max_redemptions` ensures that if the cap is reached, `affectedRows` is 0 and throws `no redemptions left`.
- In addition, an InnoDB CHECK constraint (`CONSTRAINT chk_redeemed_not_exceed_max CHECK (redeemed_count <= max_redemptions)`) enforces the invariant at the storage engine level.

### 2. Idempotent Order Cancellation
- A transaction locks the redemption record: `SELECT * FROM redemptions WHERE order_id = ? FOR UPDATE`.
- State transition is atomic: `UPDATE redemptions SET status = 'CANCELLED' WHERE id = ? AND status = 'ACTIVE'`.
- Only if the status transitioned (`affectedRows === 1`) is the coupon's `redeemed_count` decremented.
- Any subsequent or concurrent cancellation for the same order evaluates to `affectedRows === 0` and acts as a safe no-op.

### 3. Expiry Consistency
- Checked inside the transaction using database time: `(NOW() <= expires_at)`.
- Eliminates clock-skew issues between distributed application servers and ensures transactions waiting for a lock immediately fail if expiry passes before they acquire the lock.

### 4. Idempotency Key Handling
- `idempotency_records` stores previous responses mapped to `idempotency_key`.
- Retried requests retrieve the recorded response and return with `idempotency_replay: true` without incrementing redemptions or deducting inventory.

---

## How the System Works Across Different Machines (Distributed Deployment)

When deploying across multiple physical servers, VMs, or Kubernetes pods:
1. **Stateless Node.js Instances**:
   - The application processes are completely stateless. No state, mutex, or locks exist in Node.js memory.
   - Any number of application instances (Machine A, Machine B, Kubernetes Pods) can run concurrently behind a load balancer.
2. **Shared Database as Single Source of Truth**:
   - All concurrency serialization is managed by MySQL InnoDB's row-level lock manager.
   - `SELECT ... FOR UPDATE` acquires an exclusive X-lock on the specific coupon record inside InnoDB. If Instance 1 on Server A holds the lock, Instance 2 on Server B waits until the transaction commits or rolls back.
3. **Clock Skew Immunity**:
   - By evaluating `NOW() <= expires_at` directly in SQL, expiration is pinned to the database server's monotonic clock. Application machines with misconfigured NTP clocks cannot accidentally redeem expired coupons.
4. **Deadlock Recovery Across Network Jitter**:
   - High concurrent contention across servers can trigger transient InnoDB deadlocks (`ER_LOCK_DEADLOCK`). The `withTransaction` wrapper automatically catches deadlocks and retries with randomized exponential backoff up to 5 times.

---

## Code Review & Reading Guide in 5 Steps

To review or evaluate this codebase quickly:

1. **[schema.sql](file:///Users/luckyraj/yellowai_project/schema.sql)**:
   - Check the table structure, `CHECK` constraints on `redeemed_count`, and the `standard_coupon_usage` table enforcing single-use per customer.
2. **[src/config/db.js](file:///Users/luckyraj/yellowai_project/src/config/db.js)**:
   - Check the connection pool and `withTransaction()` helper with automatic `ER_LOCK_DEADLOCK` retry with jitter.
3. **[src/services/couponService.js](file:///Users/luckyraj/yellowai_project/src/services/couponService.js)**:
   - Check `redeemCoupon()`: notice how idempotency lookup, `SELECT ... FOR UPDATE` row locking, expiry check (`NOW()`), customer single-use check, and atomic counter updates happen in a single ACID transaction.
4. **[src/services/orderService.js](file:///Users/luckyraj/yellowai_project/src/services/orderService.js)**:
   - Check `cancelOrder()`: notice the conditional state transition `status = 'ACTIVE' -> 'CANCELLED'`, ensuring repeat cancellations are idempotent no-ops.
5. **[test/concurrency.test.js](file:///Users/luckyraj/yellowai_project/test/concurrency.test.js)**:
   - Check the 6 end-to-end multi-process test scenarios executed across two separate ports (3001 and 3002).

---

## API Reference

### 1. Create Coupon (Seed)
* **Method / Route**: `POST /coupons`
* **Body**:
  ```json
  {
    "code": "FLASH50",
    "max_redemptions": 10,
    "discount_percent": 20,
    "expires_at": "2026-12-31T23:59:59.000Z",
    "type": "STANDARD"
  }
  ```
* **Response (201)**: Returns created coupon entity.

### 2. Redeem Coupon
* **Method / Route**: `POST /redeem`
* **Header**: `Idempotency-Key: <unique-uuid-or-key>`
* **Body**:
  ```json
  {
    "code": "FLASH50",
    "customer_id": "cust-101",
    "order_id": "ord-9001"
  }
  ```
* **Success (200)**:
  ```json
  {
    "success": true,
    "remaining": 9
  }
  ```
* **Failure Modes**:
  - `404`: `{"success": false, "error": "unknown code", "message": "Coupon code does not exist"}`
  - `409`: `{"success": false, "error": "no redemptions left", "message": "Coupon has reached maximum redemptions"}`
  - `409`: `{"success": false, "error": "already used", "message": "Standard coupon already used by this customer"}`
  - `409`: `{"success": false, "error": "order already redeemed", "message": "Order has already used a coupon"}`
  - `410`: `{"success": false, "error": "expired", "message": "Coupon has expired"}`

### 3. Cancel Order
* **Method / Route**: `POST /orders/:order_id/cancel`
* **Success (200)**:
  ```json
  {
    "success": true,
    "order_id": "ord-9001",
    "status": "REVERSED",
    "message": "Coupon redemption successfully reversed"
  }
  ```
* **Repeat Call (200, No-Op)**:
  ```json
  {
    "success": true,
    "order_id": "ord-9001",
    "status": "ALREADY_CANCELLED",
    "message": "Order coupon redemption was already cancelled (no-op)"
  }
  ```

### 4. Get Coupon Status
* **Method / Route**: `GET /coupons/:code`
* **Success (200)**:
  ```json
  {
    "code": "FLASH50",
    "redeemed_count": 1,
    "remaining": 9,
    "max_redemptions": 10
  }
  ```
  *(Always strictly consistent, O(1) indexed read)*

---

## Setup & Running Locally

### Prerequisites
- Node.js (v18+)
- Docker & Docker Compose (or local MySQL 8.0)

### 1. Start MySQL via Docker Compose
```bash
docker compose up -d
```
*MySQL will start on port `3306` with database `coupon_service` and automatically apply `schema.sql`.*

### 2. Install Dependencies
```bash
npm install
```

### 3. Run the Concurrency Test Suite
```bash
npm test
```

The test script:
1. Spawns **two separate Node.js server processes** on ports `3001` and `3002`, both connected to the same MySQL instance.
2. Fires a burst of 50 simultaneous checkouts across both processes for a coupon with `max_redemptions = 10`. Asserts exactly 10 succeed and 40 fail with `no redemptions left`.
3. Retries a request with the same `Idempotency-Key` across both instances and verifies no double-redemption.
4. Calls cancel twice on the same order across both instances and verifies the slot is only refunded once.
5. Runs concurrent checkouts for a `STANDARD` coupon with the same customer and asserts strictly 1 succeeds.
6. Asserts expired coupons return `410 expired`.
7. Asserts non-existent coupon codes return `404 unknown code`.

---

## Trade-offs & Scope Decisions (What Was Cut & Why)

1. **Redis / Distributed Locks (Cut)**:
   - *Why*: Redundant when MySQL row-level locks (`SELECT ... FOR UPDATE`) provide ACID guarantees without cache invalidation desynchronization or split-brain risks under network partitions.
2. **Message Queues / Async Settlement (Cut)**:
   - *Why*: The brief explicitly demands `GET /coupons/:code` must be correct *at all times, not eventually correct*. Synchronous ACID transactions in InnoDB guarantee read-your-writes and strict consistency.
3. **Soft Delete vs. Status Flags (Kept Status Flags)**:
   - *Why*: Marking redemptions as `ACTIVE` vs `CANCELLED` allows audit trails while enabling atomic conditional updates.

---

## Future Roadmap & Scalability

1. **Extreme Flash-Sale Counter Partitioning (Slot Bucketing)**:
   - For viral flash sales exceeding 10,000 writes/sec on a single coupon code, a single row lock becomes a throughput ceiling. The coupon's quota can be sharded across `N` sub-buckets (e.g. 10 rows of 1,000 slots each), reducing row contention tenfold.
2. **Idempotency Key Retention / TTL Pruning**:
   - A scheduled cleanup job or partitioned table to purge idempotency records older than 48 hours to maintain steady database size.
3. **API Gateway Rate Limiting**:
   - Applying token-bucket rate limiting per customer/IP to guard against checkout botnets.
