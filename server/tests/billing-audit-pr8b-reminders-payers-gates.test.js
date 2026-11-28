'use strict';

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

describe('B-57: Feature gates fail closed in dev, enforce call-time prereqs, and register all gates', () => {
  const ORIGINAL_ENV = { ...process.env };
  const DEV_DARK_VARS = [
    'GATE_PORTAL_PAY_NOW',
    'GATE_ESTIMATE_PROMO_CODE',
    'GATE_PAY_PROMO_CODE',
    'GATE_AUTO_APPLY_ACCOUNT_CREDIT',
    'GATE_MICRODEPOSIT_DUNNING_DIVERSION',
    'GATE_PREPAID_INVOICE',
    'GATE_ZELLE_BANK_RECONCILE',
    'GATE_CARD_DETAILS_SYNC',
  ];
  const DEV_DARK_KEYS = [
    'portalPayNow',
    'estimatePromoCode',
    'payPromoCode',
    'autoApplyAccountCredit',
    'divertMicrodepositDunning',
    'prepaidInvoiceReceipt',
    'zelleBankReconcile',
    'cardDetailsSync',
  ];

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    jest.resetModules();
  });

  test('8 previously dev-open gates stay dark in development unless === "true" and stay open in test unless "false"', () => {
    process.env.NODE_ENV = 'development';
    for (const k of DEV_DARK_VARS) delete process.env[k];

    jest.isolateModules(() => {
      const gates = require('../config/feature-gates');
      for (const key of DEV_DARK_KEYS) {
        expect(gates.gates[key]).toBe(false);
        expect(gates.isEnabled(key)).toBe(false);
      }
      expect(gates.cardDetailsSyncLive()).toBe(false);
      expect(gates.gates).toHaveProperty('cardOnFileReminder');
      expect(gates.gates).toHaveProperty('payerInvoiceSms');
      expect(gates.gates).toHaveProperty('payerPacketAutosend');
      expect(gates.gates).toHaveProperty('achFailureEmail');

      process.env.GATE_CARD_DETAILS_SYNC = 'true';
      expect(gates.cardDetailsSyncLive()).toBe(true);
    });

    process.env.NODE_ENV = 'test';
    jest.isolateModules(() => {
      const gates = require('../config/feature-gates');
      for (const key of DEV_DARK_KEYS) {
        expect(gates.gates[key]).toBe(true);
      }
      process.env.GATE_CARD_DETAILS_SYNC = 'false';
      expect(gates.cardDetailsSyncLive()).toBe(false);
    });
  });

  test('planRateLedgerReconcileLive and dunningCustomerSchedulePrereqsLive check prereqs at call time', () => {
    process.env.NODE_ENV = 'production';
    jest.isolateModules(() => {
      const gates = require('../config/feature-gates');
      process.env.GATE_PLAN_RATE_LEDGER_RECONCILE = 'true';
      delete process.env.GATE_PLAN_RATE_LEDGER;
      expect(gates.planRateLedgerReconcileLive()).toBe(false);
      process.env.GATE_PLAN_RATE_LEDGER = 'true';
      expect(gates.planRateLedgerReconcileLive()).toBe(true);

      delete process.env.GATE_DUNNING_LADDER_90;
      delete process.env.GATE_PAY_INCLUDE_BALANCE;
      expect(gates.dunningCustomerSchedulePrereqsLive()).toBe(false);
      process.env.GATE_DUNNING_LADDER_90 = 'true';
      expect(gates.dunningCustomerSchedulePrereqsLive()).toBe(false);
      process.env.GATE_PAY_INCLUDE_BALANCE = 'true';
      expect(gates.dunningCustomerSchedulePrereqsLive()).toBe(true);
    });
  });
});

describe('B-52 & B-50: Card details sync gate/cap/cron, autopay removal log, and card reminder exclusions', () => {
  test('syncNearExpiryCards fails closed when GATE_CARD_DETAILS_SYNC is false without querying DB', async () => {
    const savedGate = process.env.GATE_CARD_DETAILS_SYNC;
    try {
      process.env.GATE_CARD_DETAILS_SYNC = 'false';
      let sync;
      jest.isolateModules(() => {
        jest.doMock('../models/db', () => jest.fn(() => {
          throw new Error('DB should not be queried while gate is off');
        }));
        sync = require('../services/card-details-sync');
      });
      await expect(sync.syncNearExpiryCards()).resolves.toMatchObject({ skipped: 'gate_off' });
    } finally {
      if (savedGate === undefined) delete process.env.GATE_CARD_DETAILS_SYNC;
      else process.env.GATE_CARD_DETAILS_SYNC = savedGate;
    }
  });

  test('card-on-file-reminder collectEvents reads autopay_log removal events and nextSelfPayVisit skips bill-by-invoice & covered prepay', async () => {
    let reminder;
    const resolveMock = jest.fn(async () => ({ payerId: null }));
    const billByInvoiceMock = jest.fn(async (_db, svc) => svc.id === 'visit-bbi');
    const annualPrepayCoversVisitMock = jest.fn(async () => false);
    const coveredTermsAsOfMock = jest.fn();
    const coverageRowsForTermMock = jest.fn();
    const openBalanceExistsMock = jest.fn(async () => false);

    const visits = [
      { id: 'visit-bbi', scheduled_date: '2026-12-02', service_type: 'Commercial Pest' },
      { id: 'visit-prepay', scheduled_date: '2026-12-03', service_type: 'Quarterly Pest Control' },
      { id: 'visit-selfpay', scheduled_date: '2026-12-10', service_type: 'Mosquito Control' },
    ];

    coveredTermsAsOfMock.mockImplementation(() => {
      const q = {
        where: jest.fn(() => q),
        select: jest.fn(async () => [{ id: 'term-pest', coverage_service_type: 'Quarterly Pest Control' }]),
      };
      return q;
    });
    coverageRowsForTermMock.mockImplementation(async (_term, _conn, { extraCandidateRows }) => (
      extraCandidateRows[0].id === 'visit-prepay' ? [extraCandidateRows[0]] : []
    ));

    const fakeDb = Object.assign(jest.fn((table) => {
      const q = {
        where: jest.fn(() => q),
        whereNotNull: jest.fn(() => q),
        orderBy: jest.fn(() => q),
        limit: jest.fn(() => q),
        offset: jest.fn(() => q),
        select: jest.fn(async () => {
          if (table === 'email_messages') return [];
          if (table === 'autopay_log') {
            return [{ id: 'log-1', customer_id: 'cust-1', created_at: new Date('2026-11-20T15:00:00Z') }];
          }
          if (table === 'payment_methods') return [];
          if (table === 'scheduled_services') return visits;
          return [];
        }),
      };
      return q;
    }), { schema: { hasTable: jest.fn(async () => true) } });

    jest.isolateModules(() => {
      jest.doMock('../models/db', () => fakeDb);
      jest.doMock('../services/payer', () => ({ resolveForInvoice: resolveMock }));
      jest.doMock('../services/bill-by-invoice', () => ({ billByInvoiceVisit: billByInvoiceMock }));
      jest.doMock('../services/open-balance', () => ({ openBalanceExists: openBalanceExistsMock }));
      jest.doMock('../services/customer-lifecycle-guard', () => ({
        whereVisitRowLive: jest.fn(),
        findActivePrepayTerm: jest.fn(async () => null),
      }));
      const realRenewals = jest.requireActual('../services/annual-prepay-renewals');
      expect(typeof realRenewals.annualPrepayCoversVisit).toBe('function');
      expect(typeof realRenewals.coveredTermsAsOf).toBe('function');
      expect(typeof realRenewals.coverageRowsForTerm).toBe('function');
      jest.doMock('../services/annual-prepay-renewals', () => ({
        annualPrepayCoversVisit: annualPrepayCoversVisitMock,
        coveredTermsAsOf: coveredTermsAsOfMock,
        coverageRowsForTerm: coverageRowsForTermMock,
      }));
      reminder = require('../services/card-on-file-reminder');
    });

    const events = await reminder._private.collectEvents('2026-11-24', new Date('2026-11-24T15:00:00Z'));
    expect(events.get('cust-1')).toEqual({ kind: 'removed', key: 'removed_log:log-1', on: '2026-11-20' });

    const next = await reminder._private.nextSelfPayVisit('cust-1', '2026-11-24');
    expect(next.visit?.id).toBe('visit-selfpay');
    expect(next.prepaidCovered).toBe(false);

    // If only bill-by-invoice and covered prepay visits exist (no open balance), returns prepaidCovered: true
    visits.pop();
    const onlyPrepaid = await reminder._private.nextSelfPayVisit('cust-1', '2026-11-24');
    expect(onlyPrepaid).toMatchObject({ visit: null, prepaidCovered: true });
  });
});

describe('B-34 & B-55: Payer statement child exclusions, 409 lock guard, and pay-statement dark guard', () => {
  test('settleStatementPaid rejects with 409 when any child invoice is disputed or chemical-held', async () => {
    let settleSvc;
    jest.isolateModules(() => {
      settleSvc = require('../services/payer-statement-settle');
    });

    const statement = {
      id: 'stmt-1', payer_id: 'payer-1', status: 'viewed', statement_number: 'S-1',
      subtotal_cents: 10000, balance_due_cents: 10000, paid_at: null,
    };
    const childHeld = { id: 'inv-1', status: 'disputed', scheduled_send_error: null, paid_at: null };
    const trx = Object.assign(jest.fn((table) => {
      const q = {
        where: jest.fn(() => q),
        whereNull: jest.fn(() => q),
        whereNotIn: jest.fn(() => q),
        whereNot: jest.fn(() => q),
        whereRaw: jest.fn(() => q),
        forUpdate: jest.fn(() => q),
        first: jest.fn(async () => (table === 'payer_statements' ? statement : null)),
        select: jest.fn(async () => (table === 'invoices' ? [childHeld] : [])),
        update: jest.fn(async () => 1),
      };
      return q;
    }), { fn: { now: jest.fn(() => 'NOW') }, raw: jest.fn((sql) => sql) });

    await expect(settleSvc.settleStatementPaid('stmt-1', { amountCents: 10000 }, { database: trx }))
      .rejects.toMatchObject({ statusCode: 409 });
  });

  test('pay-statement GET rejects GATE_PAYER_STATEMENTS !== "true" via statementDarkPreGuard and returns 404 for open draft statements', async () => {
    const http = require('http');
    const express = require('express');
    const saved = process.env.GATE_PAYER_STATEMENTS;
    const hit = (app, p) => new Promise((resolve, reject) => {
      const srv = app.listen(0, () => {
        const { port } = srv.address();
        http.get(`http://127.0.0.1:${port}${p}`, (res) => {
          let body = '';
          res.on('data', (c) => { body += c; });
          res.on('end', () => srv.close(() => resolve({ status: res.statusCode, headers: res.headers, body })));
        }).on('error', (e) => srv.close(() => reject(e)));
      });
    });

    try {
      delete process.env.GATE_PAYER_STATEMENTS;
      let app;
      jest.isolateModules(() => {
        jest.doMock('../models/db', () => jest.fn(() => ({
          where: jest.fn().mockReturnThis(),
          first: jest.fn(async () => ({ id: 's-open', status: 'open', token: 'a'.repeat(64) })),
        })));
        const payStatement = require('../routes/pay-statement');
        app = express();
        app.use('/api/pay/statement', payStatement.statementDarkPreGuard, payStatement);
      });

      const darkRes = await hit(app, `/api/pay/statement/${'a'.repeat(64)}`);
      expect(darkRes.status).toBe(404);
      expect(darkRes.headers['cache-control']).toContain('no-store');
      expect(darkRes.headers['x-robots-tag']).toContain('noindex');

      process.env.GATE_PAYER_STATEMENTS = 'true';
      let openApp;
      jest.isolateModules(() => {
        jest.doMock('../models/db', () => jest.fn(() => ({
          where: jest.fn().mockReturnThis(),
          first: jest.fn(async () => ({ id: 's-open', status: 'open', token: 'a'.repeat(64) })),
        })));
        const payStatement = require('../routes/pay-statement');
        openApp = express();
        openApp.use('/api/pay/statement', payStatement.statementDarkPreGuard, payStatement);
      });
      const openDraftRes = await hit(openApp, `/api/pay/statement/${'a'.repeat(64)}`);
      expect(openDraftRes.status).toBe(404);
      expect(openDraftRes.headers['cache-control']).toContain('no-store');
      expect(openDraftRes.headers['x-robots-tag']).toContain('noindex');

      let sentApp;
      jest.isolateModules(() => {
        jest.doMock('../models/db', () => jest.fn(() => ({
          where: jest.fn().mockReturnThis(),
          whereNull: jest.fn().mockReturnThis(),
          update: jest.fn(async () => 1),
          first: jest.fn(async () => ({
            id: 42, status: 'sent', token: 'b'.repeat(64), total: '150.00',
            subtotal: '150.00', tax_amount: '0.00', invoice_count: 1,
            period_start: '2026-11-01', period_end: '2026-11-30', due_date: '2026-12-30',
            payer_snapshot: JSON.stringify({ company_name: 'Acme HOA' }),
          })),
        })));
        jest.doMock('../services/payer-statements', () => ({
          loadStatementLines: jest.fn(async () => [{
            invoice_number: 'WPC-1', service_date: '2026-11-10', service_type: 'Pest',
            service_address: '123 Main St', subtotal: '150.00', tax_amount: '0.00', total: '150.00',
          }]),
        }));
        const payStatement = require('../routes/pay-statement');
        sentApp = express();
        sentApp.use('/api/pay/statement', payStatement.statementDarkPreGuard, payStatement);
      });
      const sentRes = await hit(sentApp, `/api/pay/statement/${'b'.repeat(64)}`);
      expect(sentRes.status).toBe(200);
      expect(JSON.parse(sentRes.body).lines).toHaveLength(1);
    } finally {
      if (saved === undefined) delete process.env.GATE_PAYER_STATEMENTS;
      else process.env.GATE_PAYER_STATEMENTS = saved;
    }
  });

  test('PR 8B pre-push fixes: index.js single pre-guard, finalize detach & paid lines visible, blocked child 409/quarantine, zelle dev-dark, card sync rotation, atomic pause resume', async () => {
    const fs = require('fs');
    const path = require('path');

    // (b) server/index.js has exactly one statementDarkPreGuard mount and no inline /api/pay/statement pre-guard
    const indexSrc = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
    const preGuardMatches = indexSrc.match(/statementDarkPreGuard/g) || [];
    expect(preGuardMatches).toHaveLength(1);
    expect(indexSrc).toContain("app.use('/api/pay/statement', require('./routes/pay-statement').statementDarkPreGuard);");
    expect(indexSrc).not.toMatch(/app\.use\('\/api\/pay\/statement',\s*\(req,\s*res,\s*next\)/);

    // (c) finalizeStatement detaches non-collectible children; loadStatementLines keeps paid statement lines visible
    let payerStatements;
    jest.isolateModules(() => {
      jest.dontMock('../services/payer-statements');
      jest.dontMock('../services/payer');
      jest.dontMock('../models/db');
      payerStatements = require('../services/payer-statements');
    });
    const detachedUpdates = [];
    const finDb = Object.assign(jest.fn((table) => {
      const q = {
        where: jest.fn((arg) => {
          if (typeof arg === 'function') arg.call(q);
          return q;
        }),
        whereNot: jest.fn(() => q),
        whereIn: jest.fn(() => q),
        whereNotIn: jest.fn(() => q),
        whereRaw: jest.fn(() => q),
        orWhereRaw: jest.fn(() => q),
        forUpdate: jest.fn(() => q),
        first: jest.fn(async () => (
          table === 'payer_statements'
            ? { id: 7, payer_id: 3, period_start: '2026-11-01', status: 'open', terms_snapshot: 'net_30', payer_snapshot: null }
            : { subtotal: '100.00', tax_amount: '0.00', total: '100.00', invoice_count: 1 }
        )),
        update: jest.fn((patch) => {
          if (table === 'invoices') detachedUpdates.push(patch);
          return { returning: jest.fn(async () => [{ id: 7, status: 'finalized' }]) };
        }),
      };
      return q;
    }), { fn: { now: jest.fn(() => 'NOW') }, raw: jest.fn(async () => ({ rows: [] })) });
    await payerStatements.finalizeStatement(7, { database: finDb, date: new Date('2026-11-30T15:00:00Z') });
    expect(detachedUpdates).toEqual([expect.objectContaining({ payer_statement_id: null })]);

    const lineCalls = { whereNotIn: 0, whereNot: 0 };
    const paidLinesDb = Object.assign(jest.fn(() => {
      const q = {
        leftJoin: jest.fn(() => q),
        where: jest.fn(() => q),
        whereNot: jest.fn(() => { lineCalls.whereNot += 1; return q; }),
        whereNotIn: jest.fn(() => { lineCalls.whereNotIn += 1; return q; }),
        whereRaw: jest.fn(() => q),
        orderBy: jest.fn(() => q),
        select: jest.fn(async () => [{ invoice_number: 'WPC-PAID-1', total: '100.00' }]),
      };
      return q;
    }), { raw: jest.fn((s) => s) });
    const paidLines = await payerStatements.loadStatementLines(7, paidLinesDb, { status: 'paid' });
    expect(paidLines).toHaveLength(1);
    expect(lineCalls.whereNotIn).toBe(0);
    expect(lineCalls.whereNot).toBe(1);

    // (d) settleStatementPaid rejects 409 statementChildBlocked BEFORE mutating payer_statements
    let settleSvc;
    jest.isolateModules(() => {
      settleSvc = require('../services/payer-statement-settle');
    });
    const stmtUpdates = [];
    const blockTrx = Object.assign(jest.fn((table) => {
      const q = {
        where: jest.fn(() => q),
        whereNot: jest.fn(() => q),
        whereNotIn: jest.fn(() => q),
        forUpdate: jest.fn(() => q),
        first: jest.fn(async () => (table === 'payer_statements' ? { id: 9, payer_id: 2, status: 'sent' } : null)),
        select: jest.fn(async () => (table === 'invoices' ? [{ id: 101, status: 'paid', scheduled_send_error: null }] : [])),
        update: jest.fn(async (p) => { if (table === 'payer_statements') stmtUpdates.push(p); return 1; }),
      };
      return q;
    }), { fn: { now: jest.fn(() => 'NOW') }, raw: jest.fn(async () => ({ rows: [] })) });
    await expect(settleSvc.settleStatementPaid(9, { amountCents: 10000 }, { database: blockTrx }))
      .rejects.toMatchObject({ statusCode: 409, statementChildBlocked: true });
    expect(stmtUpdates).toHaveLength(0);

    // (f) reconcileZelleBankFeed returns skipped: gate_off in development when env is unset
    const savedNodeEnv = process.env.NODE_ENV;
    const savedZelle = process.env.GATE_ZELLE_BANK_RECONCILE;
    try {
      process.env.NODE_ENV = 'development';
      delete process.env.GATE_ZELLE_BANK_RECONCILE;
      let zelle;
      jest.isolateModules(() => {
        zelle = require('../services/zelle-notice-reconciler');
      });
      expect(zelle.isZelleBankReconcileEnabled()).toBe(false);
      await expect(zelle.reconcileZelleBankFeed()).resolves.toEqual({ skipped: 'gate_off' });
    } finally {
      process.env.NODE_ENV = savedNodeEnv;
      if (savedZelle === undefined) delete process.env.GATE_ZELLE_BANK_RECONCILE;
      else process.env.GATE_ZELLE_BANK_RECONCILE = savedZelle;
    }

    // (g) syncNearExpiryCards rotates >200 eligible cards across consecutive days
    const manyCards = Array.from({ length: 260 }, (_, i) => ({
      id: `c-${i}`,
      method_type: 'card',
      stripe_payment_method_id: `pm_${String(i).padStart(4, '0')}`,
      exp_month: 12,
      exp_year: 2026,
    }));
    const seenDay1 = [];
    const seenDay2 = [];
    const makeSyncDb = () => jest.fn(() => {
      const q = {
        where: jest.fn(() => q),
        whereNotNull: jest.fn(() => q),
        select: jest.fn(async () => manyCards),
      };
      return q;
    });
    let cardSync;
    jest.isolateModules(() => {
      jest.doMock('../services/stripe', () => ({
        retrievePaymentMethod: jest.fn(async (pmId) => ({ id: pmId, card: { exp_month: 12, exp_year: 2026 } })),
      }));
      cardSync = require('../services/card-details-sync');
    });
    const fakeStripe1 = require('../services/stripe');
    fakeStripe1.retrievePaymentMethod.mockImplementation(async (pmId) => { seenDay1.push(pmId); return { id: pmId, card: { exp_month: 12, exp_year: 2026 } }; });
    await cardSync.syncNearExpiryCards({ now: new Date('2026-11-28T15:00:00Z'), database: makeSyncDb() });
    fakeStripe1.retrievePaymentMethod.mockImplementation(async (pmId) => { seenDay2.push(pmId); return { id: pmId, card: { exp_month: 12, exp_year: 2026 } }; });
    await cardSync.syncNearExpiryCards({ now: new Date('2026-11-29T15:00:00Z'), database: makeSyncDb() });
    expect(seenDay1).toHaveLength(200);
    expect(seenDay2).toHaveLength(200);
    expect(seenDay1[0]).not.toBe(seenDay2[0]);

    // (h) payer-statement-followups runPending skips when atomic pause resume returns 0
    let followups;
    const fDb = Object.assign(jest.fn((table) => {
      const q = {
        leftJoin: jest.fn(() => q),
        where: jest.fn(() => q),
        whereIn: jest.fn(() => q),
        whereNotNull: jest.fn(() => q),
        select: jest.fn(async () => (
          table === 'payer_statements as s'
            ? [{ id: 55, due_date: '2026-11-01', f_status: 'paused', f_step_index: 0, f_paused_until: '2026-11-20T00:00:00Z' }]
            : []
        )),
        update: jest.fn(async () => 0),
      };
      return q;
    }), { fn: { now: jest.fn(() => 'NOW') } });
    const savedStmtGate = process.env.GATE_PAYER_STATEMENTS;
    const savedFollowupGate = process.env.GATE_PAYER_STATEMENT_FOLLOWUPS;
    try {
      process.env.GATE_PAYER_STATEMENTS = 'true';
      process.env.GATE_PAYER_STATEMENT_FOLLOWUPS = 'true';
      jest.isolateModules(() => {
        jest.doMock('../models/db', () => fDb);
        followups = require('../services/payer-statement-followups');
      });
      // 2026-12-01 is Tuesday 10:00 AM ET (15:00 UTC) — inside Tue-Fri send window
      const res = await followups.runPending({ now: new Date('2026-12-01T15:00:00Z') });
      expect(res).toEqual({ sent: 0, skipped: 1 });
    } finally {
      if (savedStmtGate === undefined) delete process.env.GATE_PAYER_STATEMENTS;
      else process.env.GATE_PAYER_STATEMENTS = savedStmtGate;
      if (savedFollowupGate === undefined) delete process.env.GATE_PAYER_STATEMENT_FOLLOWUPS;
      else process.env.GATE_PAYER_STATEMENT_FOLLOWUPS = savedFollowupGate;
    }
  });
});
