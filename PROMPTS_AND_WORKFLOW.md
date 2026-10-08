# End-to-End Development Transcript & Prompt-Output Record

This document records the exact progression of prompts, technical decisions, problem-solving iterations, and code outputs created during the engineering of the **Coupon Redemption Service**.

---

## Stage 1: Candidate Brief & Architectural Planning

### User Prompt:
> *"Coupon redemption service — candidate brief ... You are building a coupon redemption service for an e-commerce checkout. Rules: max_redemptions cap under burst, STANDARD single use per customer, STACKABLE global cap, in-flight expiry consistency, idempotent order cancellation reversal, Idempotency-Key retry handling ... MySQL is required ... lets start with the architecture then phase wise"*

### Technical Actions & Output:
1. **System Flow Design**:
   - Designed a 3-tier layered architecture: `Client -> Express API Controller -> Service/ACID Transaction Layer -> MySQL 8.0 (InnoDB)`.
2. **Multi-Process Concurrency Strategy**:
   - Identified that in-memory locks (`Mutex`, `AsyncLock`) fail across multiple OS processes.
   - Pushed concurrency control to MySQL InnoDB via `SELECT ... FOR UPDATE` row locks.
3. **Database Schema Blueprint**:
   - Defined tables: `coupons`, `redemptions`, `idempotency_records`.
4. **Phased Roadmap**:
   - Phase 1: Environment & Schema Setup.
   - Phase 2: Transactional Core & Concurrency Logic.
   - Phase 3: Express Routes & Controllers.
   - Phase 4: Multi-Process Concurrency Verification.
   - Phase 5: Documentation & Rationale.

---

## Stage 2: Folder Structure, Docker & Database Setup

### User Prompt:
> *"lets start with the pject setup first will setup the dociker then procesd it with the database and for it don't writ the code by yourself but help me with working and I'll cgeck and review the code first then I will be implmenitng in my codebase and for now lets begiinwith impletmenting the folderstructre anf then follow on with the stage or phase wise"*

### Technical Actions & Output:
1. **Defined Clean Layered Directory Structure**:
   ```text
   yellowai_project/
   ├── docker-compose.yml
   ├── schema.sql
   ├── .env.example
   ├── package.json
   ├── src/
   │   ├── config/db.js
   │   ├── controllers/
   │   ├── services/
   │   ├── errors/
   │   ├── app.js
   │   └── server.js
   └── test/concurrency.test.js
   ```
2. **Wrote `docker-compose.yml`**:
   - Configured MySQL 8.0 with automated `/docker-entrypoint-initdb.d/init.sql` schema execution, persistent volume, and ping healthcheck.
3. **Drafted Initial `schema.sql`**:
   - InnoDB engine, UTF8mb4 encoding, and indexes for fast order/customer lookup.

---

## Stage 3: Edge Cases, Race Conditions & Schema Hardening

### User Prompt:
> *"and also there. need to add the edgecases avout the reacecinditiona dn also the unique key iod for the oupons"*

### Technical Actions & Output:
Identified and solved 6 critical concurrency failure modes:
1. **Flash-Sale Burst Cap Breach**:
   - Enforced InnoDB row-lock `SELECT ... FOR UPDATE` + database constraint `CHECK (redeemed_count <= max_redemptions)`.
2. **Simultaneous Double-Redeem by Same Customer (STANDARD)**:
   - Designed a dedicated `standard_coupon_usage` table with `PRIMARY KEY (coupon_id, customer_id)` so concurrent attempts fail with `ER_DUP_ENTRY`.
3. **Exact Expiry Instant In-Flight**:
   - Checked `(NOW() <= expires_at)` inside SQL to use MySQL's clock as the single source of truth, eliminating server clock drift.
4. **Double-Cancel Race Condition**:
   - Used atomic conditional update `UPDATE redemptions SET status = 'CANCELLED' WHERE order_id = ? AND status = 'ACTIVE'`, guaranteeing only 1 thread decrements the slot.
5. **In-Flight Idempotency Key Collision**:
   - Stored keys in `idempotency_records` with primary key uniqueness.
6. **Negative Count Underflow**:
   - Enforced `CHECK (redeemed_count >= 0)` + `GREATEST(0, redeemed_count - 1)`.

---

## Stage 4: Rapid Code Implementation Under Time Constraints

### User Prompt:
> *"lets p[roceed with the folder direclty build the file as we have time constraints so lets start it and build those files and but"*

### Technical Actions & Output:
Built out the full codebase across all layers:
* `schema.sql`: DDL with InnoDB, constraints, and tables.
* `src/config/db.js`: Connection pool with managed `withTransaction()` runner.
* `src/errors/AppError.js`: Domain error classes (`UnknownCodeError`, `ExpiredCouponError`, `NoRedemptionsLeftError`, `AlreadyUsedError`, `OrderAlreadyRedeemedError`).
* `src/services/couponService.js`: Transactional coupon creation, O(1) status queries, and atomic redemption.
* `src/services/orderService.js`: Atomic order cancellation slot reversal.
* `src/controllers/couponController.js` & `orderController.js`: Request parsing, HTTP status codes, and idempotency header forwarding.
* `src/app.js`: Express routing, healthcheck endpoint, centralized error handler.
* `src/server.js`: Process lifecycle and graceful shutdown (`SIGTERM`/`SIGINT`).
* `test/concurrency.test.js`: Multi-process test suite forking 2 child processes on ports 3001 and 3002.
* Started MySQL container via `docker compose up -d`.

---

## Stage 5: Concurrency Bug War Story (Solving MySQL Deadlocks)

### User Prompt:
> *"Prioritize: The redemption cap is provably exact under concurrency, Cancellation reversal, Everything else. Say what you cut and why. and also we need to priortize this as these re somne contraints foe the project"*

### Problem Encountered:
During the initial 50-thread concurrent redemption test across ports 3001 and 3002, MySQL threw:
```text
ER_LOCK_DEADLOCK: Deadlock found when trying to get lock; try restarting transaction
```

### Senior Engineering Resolution:
1. **Identified Gap Lock Contention**:
   - Prior code executed `SELECT id FROM redemptions WHERE order_id = ? FOR UPDATE` on non-existent rows. In MySQL, this creates index **gap locks**, conflicting with concurrent `INSERT` statements.
2. **Normalized Lock Hierarchy**:
   - Standardized transaction lock ordering: Always acquire the row lock on `coupons` **first**.
   - Removed unnecessary pre-insert gap locks on `redemptions`.
3. **Deadlock Jitter Retry in `withTransaction`**:
   - Added automatic retries with randomized backoff upon `ER_LOCK_DEADLOCK` (up to 5 retries).
4. **Resolved Dynamic Test Keys**:
   - Made test order IDs and idempotency keys unique per test run (`order_id: ord-alice-${stdCode}-${i}`) to prevent false conflicts from previous runs.

---

## Stage 6: Technical Explanations & Architecture Deep-Dive

### User Prompts:
> 1. *"and for eveycheck we need to console.log so that the oputput can be seena nd chenage accorundg toit he need"*
> 2. *"is everyaspect covered in the p[roject and if not what phases or things have been missed out and also check for the saftey breach map out the plan for the api check"*
> 3. *"ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci; need to explain this why we need this is this reqyired"*

### Technical Actions & Output:
1. **Added Rich Console Logs to Test Runner**:
   - Logged HTTP request status, response payloads, seed outputs, and database states for every test step.
2. **Explained Table Configuration**:
   - `ENGINE=InnoDB`: Required for fine-grained **row-level locking** (`SELECT ... FOR UPDATE`), ACID transactions, and storage-level CHECK constraints. Contrast with `MyISAM` which locks the entire table.
   - `DEFAULT CHARSET=utf8mb4`: Full 4-byte UTF-8 encoding supporting emojis and special characters without data truncation.
   - `COLLATE=utf8mb4_unicode_ci`: Case-insensitive collation (`SAVE20` == `save20`), ensuring consistent checkout matching.
3. **Security & Safety Audit**:
   - Parameterized SQL queries against SQL injection.
   - Guarded against underflow attacks via `GREATEST(0, redeemed_count - 1)` and `CHECK (redeemed_count >= 0)`.
   - Input sanitization and bounds checking.

---

## Stage 7: Individual Test Runners & Core Pillars

### User Prompts:
> 1. *"get me all the test we can runn indiviually so that i can test each caases and improve the system generete around Database lock multiple user and time constraiunts and also explain in the easy way of the system works and how to"*
> 2. *"what is the inno db"*

### Technical Actions & Output:
1. **Added CLI Filtering to Test Suite**:
   - Enhanced `test/concurrency.test.js` with `--case=<name>` flag.
   - Added npm scripts to `package.json`:
     - `npm run test:cap`: Tests flash-sale burst (50 threads for cap of 10) on database row lock.
     - `npm run test:standard`: Tests multiple concurrent checkouts by the same customer on STANDARD coupon.
     - `npm run test:expiry`: Tests clock-based expiry rejection (`410 expired`).
     - `npm run test:idempotency`: Tests identical key retries returning cached response without double-charging.
     - `npm run test:cancel`: Tests order cancellation slot return and duplicate cancel idempotency.
     - `npm run test:unknown`: Tests non-existent coupon handling (`404 unknown code`).
     - `npm test`: Runs all 6 suites together.
2. **Simplified Concepts**:
   - Explained InnoDB using the **Hotel Analogy** (locking one room door vs locking the whole hotel building).
   - Provided the 3 Core Pillars breakdown and interview answer scripts.

---

## Stage 8: Scalability Roadmap (To 100,000+ TPS)

### User Prompt:
> *"how we can scle it"*

### Technical Actions & Output:
Outlined a 5-layer scaling blueprint:
1. **Counter Sharding (Slot Bucketing)**: Splitting a single coupon's row into 10 independent bucket rows in MySQL to reduce row lock contention by 10x.
2. **Redis In-Memory Pre-Allocation (Lua Gatekeeper)**: Atomic `DECR` in Redis RAM filtering out 99% of excess traffic in 1ms before hitting MySQL.
3. **Read Scaling**: AWS Aurora / MySQL read replicas for `GET /coupons/:code` with short-TTL cache-aside.
4. **Idempotency Table Partitioning**: Range partitioning by date for zero-cost partition dropping (`DROP PARTITION`).
5. **Horizontal Stateless Compute**: Auto-scaling Node.js pods via Kubernetes HPA behind an Application Load Balancer.

---

## Stage 9: Git Hygiene & GitHub Repository Push

### User Prompt:
> *"add the git ingrone fike and add all the nodemodules and env file *

### Technical Actions & Output:
1. **Created `.gitignore`**:
   - Excluded `node_modules/`, `.env`, log files, and OS metadata files.
   - Preserved `.env.example` as the repository configuration template.
2. **Unstaged Sensitive & Heavy Files**:
   - Executed `git reset` to remove `node_modules` and `.env` from git index.
3. **Committed Clean Codebase**:
   - Staged all source code, tests, schema, compose file, and documentation.
