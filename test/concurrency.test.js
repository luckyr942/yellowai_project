const { fork } = require('child_process');
const http = require('http');
const path = require('path');
const { pool } = require('../src/config/db');

const INSTANCE_1_PORT = 3001;
const INSTANCE_2_PORT = 3002;
const SERVER_PATH = path.join(__dirname, '../src/server.js');

// Parse --case=<name> CLI argument
const caseArg = process.argv.find(arg => arg.startsWith('--case=')) || '--case=all';
const targetCase = caseArg.split('=')[1].toLowerCase();

function makeRequest(options, postData) {
  return new Promise((resolve, reject) => {
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          resolve({ status: res.statusCode, headers: res.headers, body: parsed });
        } catch (e) {
          resolve({ status: res.statusCode, headers: res.headers, body: data });
        }
      });
    });
    req.on('error', reject);
    if (postData) {
      req.write(typeof postData === 'string' ? postData : JSON.stringify(postData));
    }
    req.end();
  });
}

async function waitForHealth(port, retries = 20) {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await makeRequest({
        hostname: '127.0.0.1',
        port,
        path: '/health',
        method: 'GET'
      });
      if (res.status === 200) return true;
    } catch (e) {
      // Retry
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Instance on port ${port} did not become healthy in time.`);
}

function startInstance(port) {
  return fork(SERVER_PATH, [], {
    env: { ...process.env, PORT: String(port) },
    stdio: 'inherit'
  });
}

async function runTests() {
  console.log('================================================================');
  console.log(`   COUPON SERVICE TEST RUNNER [FILTER: ${targetCase.toUpperCase()}]   `);
  console.log('================================================================');

  // Verify database connection first
  try {
    await pool.query('SELECT 1');
    console.log('✓ Database connection verified');
  } catch (err) {
    console.error('❌ Cannot connect to MySQL. Ensure MySQL is running on port 3306.');
    console.error(err.message);
    process.exit(1);
  }

  console.log(`\nSpawning two independent Node.js processes on ports ${INSTANCE_1_PORT} & ${INSTANCE_2_PORT}...`);
  const proc1 = startInstance(INSTANCE_1_PORT);
  const proc2 = startInstance(INSTANCE_2_PORT);

  const cleanup = () => {
    console.log('\nTerminating test worker instances...');
    proc1.kill('SIGINT');
    proc2.kill('SIGINT');
  };

  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);

  try {
    await Promise.all([
      waitForHealth(INSTANCE_1_PORT),
      waitForHealth(INSTANCE_2_PORT)
    ]);
    console.log('✓ Both server processes are UP and HEALTHY.\n');

    const futureDate = new Date(Date.now() + 3600 * 1000).toISOString();

    // -------------------------------------------------------------
    // TEST 1: Flash-Sale Concurrency Cap & Database Row Locking
    // -------------------------------------------------------------
    if (targetCase === 'all' || targetCase === 'cap' || targetCase === 'lock') {
      console.log('----------------------------------------------------------------');
      console.log('TEST 1: Flash-Sale Concurrency Cap (Database Row Lock Under Burst)');
      console.log('----------------------------------------------------------------');
      const flashCode = `FLASH_${Date.now()}`;

      // Seed coupon via Instance 1
      const seedRes = await makeRequest({
        hostname: '127.0.0.1',
        port: INSTANCE_1_PORT,
        path: '/coupons',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      }, {
        code: flashCode,
        max_redemptions: 10,
        discount_percent: 20,
        expires_at: futureDate,
        type: 'STACKABLE'
      });

      console.log(`[Seed] Created coupon ${flashCode} with max_redemptions = 10 (status: ${seedRes.status})`);

      // Fire 50 simultaneous requests distributed across Instance 1 & 2
      const totalRequests = 50;
      const redemptionPromises = [];

      for (let i = 1; i <= totalRequests; i++) {
        const targetPort = i % 2 === 0 ? INSTANCE_1_PORT : INSTANCE_2_PORT;
        redemptionPromises.push(
          makeRequest({
            hostname: '127.0.0.1',
            port: targetPort,
            path: '/redeem',
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Idempotency-Key': `burst-key-${flashCode}-${i}`
            }
          }, {
            code: flashCode,
            customer_id: `cust-${i}`,
            order_id: `ord-burst-${flashCode}-${i}`
          })
        );
      }

      const burstResults = await Promise.all(redemptionPromises);
      const successes = burstResults.filter(r => r.status === 200 && r.body.success === true);
      const failures = burstResults.filter(r => r.status === 409 && r.body.error === 'no redemptions left');

      console.log(`[Burst Result] ${successes.length} successes, ${failures.length} rejected with 'no redemptions left'`);

      // Fetch strictly consistent counts from Instance 2
      const checkState = await makeRequest({
        hostname: '127.0.0.1',
        port: INSTANCE_2_PORT,
        path: `/coupons/${flashCode}`,
        method: 'GET'
      });

      console.log(`[GET /coupons/${flashCode}] Final state:`, checkState.body);

      if (successes.length !== 10) {
        throw new Error(`FAIL: Expected exactly 10 successes, got ${successes.length}`);
      }
      if (checkState.body.redeemed_count !== 10 || checkState.body.remaining !== 0) {
        throw new Error(`FAIL: Expected redeemed_count: 10, remaining: 0. Got: ${JSON.stringify(checkState.body)}`);
      }
      console.log('✓ PASS: Exact redemption cap is strictly preserved under burst concurrency across processes.\n');
    }

    // -------------------------------------------------------------
    // TEST 2: Idempotency Key Replay Across App Instances
    // -------------------------------------------------------------
    if (targetCase === 'all' || targetCase === 'idempotency') {
      console.log('----------------------------------------------------------------');
      console.log('TEST 2: Idempotency Replay (Retrying Same Key Across Instances)');
      console.log('----------------------------------------------------------------');
      const idemCode = `IDEM_${Date.now()}`;
      await makeRequest({
        hostname: '127.0.0.1',
        port: INSTANCE_1_PORT,
        path: '/coupons',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      }, {
        code: idemCode,
        max_redemptions: 5,
        discount_percent: 15,
        expires_at: futureDate,
        type: 'STANDARD'
      });

      const fixedIdempotencyKey = `idem-key-test-${Date.now()}`;
      const orderPayload = {
        code: idemCode,
        customer_id: 'cust-idem-1',
        order_id: `ord-idem-${Date.now()}`
      };

      // First call -> Instance 1
      const firstCall = await makeRequest({
        hostname: '127.0.0.1',
        port: INSTANCE_1_PORT,
        path: '/redeem',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': fixedIdempotencyKey
        }
      }, orderPayload);

      // Second call -> Instance 2 with identical key
      const secondCall = await makeRequest({
        hostname: '127.0.0.1',
        port: INSTANCE_2_PORT,
        path: '/redeem',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': fixedIdempotencyKey
        }
      }, orderPayload);

      console.log('[First Call on Inst 1] Status:', firstCall.status, 'Body:', firstCall.body);
      console.log('[Retry Call on Inst 2] Status:', secondCall.status, 'Body:', secondCall.body);

      const idemState = await makeRequest({
        hostname: '127.0.0.1',
        port: INSTANCE_1_PORT,
        path: `/coupons/${idemCode}`,
        method: 'GET'
      });

      console.log(`[GET /coupons/${idemCode}] State after retry:`, idemState.body);

      if (firstCall.status !== 200 || secondCall.status !== 200) {
        throw new Error(`FAIL: Both idempotent calls must return 200`);
      }
      if (idemState.body.redeemed_count !== 1) {
        throw new Error(`FAIL: Slot was double-redeemed! redeemed_count is ${idemState.body.redeemed_count}`);
      }
      console.log('✓ PASS: Retrying with same Idempotency-Key returns previous result without double-redeeming.\n');
    }

    // -------------------------------------------------------------
    // TEST 3: Cancellation Slot Reversal & Double-Cancel Idempotency
    // -------------------------------------------------------------
    if (targetCase === 'all' || targetCase === 'cancel') {
      console.log('----------------------------------------------------------------');
      console.log('TEST 3: Cancellation Slot Reversal & Double-Cancel Idempotency');
      console.log('----------------------------------------------------------------');
      const cancelCode = `CNC_${Date.now()}`;
      await makeRequest({
        hostname: '127.0.0.1',
        port: INSTANCE_1_PORT,
        path: '/coupons',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      }, {
        code: cancelCode,
        max_redemptions: 5,
        discount_percent: 20,
        expires_at: futureDate,
        type: 'STANDARD'
      });

      const cancelOrderId = `ord-cancel-${Date.now()}`;
      // Redeem coupon on Instance 1
      await makeRequest({
        hostname: '127.0.0.1',
        port: INSTANCE_1_PORT,
        path: '/redeem',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': `cnc-key-${cancelOrderId}`
        }
      }, {
        code: cancelCode,
        customer_id: 'cust-cancel-1',
        order_id: cancelOrderId
      });

      // First cancel call on Instance 1
      const firstCancel = await makeRequest({
        hostname: '127.0.0.1',
        port: INSTANCE_1_PORT,
        path: `/orders/${cancelOrderId}/cancel`,
        method: 'POST'
      });

      const stateAfterFirstCancel = await makeRequest({
        hostname: '127.0.0.1',
        port: INSTANCE_2_PORT,
        path: `/coupons/${cancelCode}`,
        method: 'GET'
      });

      console.log('[First Cancel on Inst 1]:', firstCancel.body);
      console.log('[Coupon State after First Cancel]:', stateAfterFirstCancel.body);

      // Second cancel call on Instance 2 (repeat call)
      const secondCancel = await makeRequest({
        hostname: '127.0.0.1',
        port: INSTANCE_2_PORT,
        path: `/orders/${cancelOrderId}/cancel`,
        method: 'POST'
      });

      const stateAfterSecondCancel = await makeRequest({
        hostname: '127.0.0.1',
        port: INSTANCE_1_PORT,
        path: `/coupons/${cancelCode}`,
        method: 'GET'
      });

      console.log('[Second Cancel on Inst 2 (Repeat)]:', secondCancel.body);
      console.log('[Coupon State after Second Cancel]:', stateAfterSecondCancel.body);

      if (stateAfterFirstCancel.body.redeemed_count !== 0) {
        throw new Error(`FAIL: Slot was not returned on cancellation. redeemed_count: ${stateAfterFirstCancel.body.redeemed_count}`);
      }
      if (stateAfterSecondCancel.body.redeemed_count !== 0) {
        throw new Error(`FAIL: Double refund occurred! redeemed_count is ${stateAfterSecondCancel.body.redeemed_count}`);
      }
      console.log('✓ PASS: Cancellation returns slot exactly once, repeat cancel is an idempotent no-op.\n');
    }

    // -------------------------------------------------------------
    // TEST 4: Multiple Users / STANDARD Single-Use per Customer
    // -------------------------------------------------------------
    if (targetCase === 'all' || targetCase === 'standard' || targetCase === 'user') {
      console.log('----------------------------------------------------------------');
      console.log('TEST 4: STANDARD Coupon Single-Use Concurrency (Same Customer)');
      console.log('----------------------------------------------------------------');
      const stdCode = `STD_${Date.now()}`;
      const stdRes = await makeRequest({
        hostname: '127.0.0.1',
        port: INSTANCE_1_PORT,
        path: '/coupons',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      }, {
        code: stdCode,
        max_redemptions: 10,
        discount_percent: 10,
        expires_at: futureDate,
        type: 'STANDARD'
      });

      console.log(`[Seed STANDARD] status=${stdRes.status}`, stdRes.body);

      // Same customer fires 10 simultaneous redemptions with different order IDs across both instances
      const sameCustPromises = [];
      for (let i = 1; i <= 10; i++) {
        const targetPort = i % 2 === 0 ? INSTANCE_1_PORT : INSTANCE_2_PORT;
        sameCustPromises.push(
          makeRequest({
            hostname: '127.0.0.1',
            port: targetPort,
            path: '/redeem',
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Idempotency-Key': `cust-std-idem-${stdCode}-${i}`
            }
          }, {
            code: stdCode,
            customer_id: 'alice_single_customer',
            order_id: `ord-alice-${stdCode}-${i}`
          })
        );
      }

      const sameCustResults = await Promise.all(sameCustPromises);
      const custSuccesses = sameCustResults.filter(r => r.status === 200);
      const custAlreadyUsed = sameCustResults.filter(r => r.status === 409 && r.body.error === 'already used');

      console.log(`[Same Customer Burst] 10 parallel attempts: ${custSuccesses.length} succeeded, ${custAlreadyUsed.length} rejected with 'already used'`);

      if (custSuccesses.length !== 1 || custAlreadyUsed.length !== 9) {
        throw new Error(`FAIL: Expected exactly 1 success and 9 rejections for STANDARD coupon.`);
      }
      console.log('✓ PASS: STANDARD coupon permits strictly 1 redemption per customer under concurrency.\n');
    }

    // -------------------------------------------------------------
    // TEST 5: Time Constraints & In-Flight Expiration Rejection
    // -------------------------------------------------------------
    if (targetCase === 'all' || targetCase === 'expiry' || targetCase === 'time') {
      console.log('----------------------------------------------------------------');
      console.log('TEST 5: Time Constraints & Expired Coupon Rejection');
      console.log('----------------------------------------------------------------');
      const expCode = `EXP_${Date.now()}`;
      const pastDate = new Date(Date.now() - 3600 * 1000).toISOString(); // 1 hour ago

      const seedExpRes = await makeRequest({
        hostname: '127.0.0.1',
        port: INSTANCE_1_PORT,
        path: '/coupons',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      }, {
        code: expCode,
        max_redemptions: 5,
        discount_percent: 25,
        expires_at: pastDate,
        type: 'STANDARD'
      });
      console.log(`[Seed Expired Coupon] status=${seedExpRes.status}`, seedExpRes.body);

      const expRedeemRes = await makeRequest({
        hostname: '127.0.0.1',
        port: INSTANCE_2_PORT,
        path: '/redeem',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': `exp-key-${expCode}`
        }
      }, {
        code: expCode,
        customer_id: 'cust-exp-1',
        order_id: `ord-exp-${Date.now()}`
      });
      console.log(`[POST /redeem Expired] status=${expRedeemRes.status}`, expRedeemRes.body);

      if (expRedeemRes.status !== 410 || expRedeemRes.body.error !== 'expired') {
        throw new Error(`FAIL: Expected 410 'expired', got ${expRedeemRes.status} ${JSON.stringify(expRedeemRes.body)}`);
      }
      console.log('✓ PASS: Expired coupon rejected with status 410 and error "expired".\n');
    }

    // -------------------------------------------------------------
    // TEST 6: Unknown Coupon Code Handling
    // -------------------------------------------------------------
    if (targetCase === 'all' || targetCase === 'unknown') {
      console.log('----------------------------------------------------------------');
      console.log('TEST 6: Unknown Coupon Code Handling');
      console.log('----------------------------------------------------------------');
      const unknownRes = await makeRequest({
        hostname: '127.0.0.1',
        port: INSTANCE_1_PORT,
        path: '/redeem',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': `unknown-key-${Date.now()}`
        }
      }, {
        code: 'NON_EXISTENT_COUPON_CODE_XYZ',
        customer_id: 'cust-any',
        order_id: `ord-unknown-${Date.now()}`
      });
      console.log(`[POST /redeem Unknown Code] status=${unknownRes.status}`, unknownRes.body);

      if (unknownRes.status !== 404 || unknownRes.body.error !== 'unknown code') {
        throw new Error(`FAIL: Expected 404 'unknown code', got ${unknownRes.status}`);
      }
      console.log('✓ PASS: Unknown code rejected with status 404 and error "unknown code".\n');
    }

    console.log('================================================================');
    console.log(`   TEST RUN [${targetCase.toUpperCase()}] COMPLETED SUCCESSFULLY! `);
    console.log('================================================================');

  } catch (error) {
    console.error('\n❌ TEST SUITE FAILED:', error.message);
    process.exitCode = 1;
  } finally {
    cleanup();
    await pool.end();
  }
}

runTests();
