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
      jest.doMock('../services/annual-prepay-renewals', () => ({
        annualPrepayTableExists: jest.fn(async () => true),
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
      const openDraftRes = await hit(app, `/api/pay/statement/${'a'.repeat(64)}`);
      expect(openDraftRes.status).toBe(404);
      expect(openDraftRes.headers['cache-control']).toContain('no-store');
      expect(openDraftRes.headers['x-robots-tag']).toContain('noindex');
    } finally {
      if (saved === undefined) delete process.env.GATE_PAYER_STATEMENTS;
      else process.env.GATE_PAYER_STATEMENTS = saved;
    }
  });
});
