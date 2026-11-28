/**
 * Extra contacts & reminder-stop hardening tests (PR 4: P1-E1, P1-E2, P1-E3,
 * P2-E2, P2-E3, P3-E).
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

describe('P1-E1: merged reminder-contact sticky STOP compares against GREATEST(texts_stopped_at, lin.merged_at)', () => {
  test('stoppedSql includes recursive merged_at lineage and keeps the 5-placeholder binding order', () => {
    const { stoppedSql, lineageWithMergeSql } = require('../services/reminder-stop-sql');
    const lin = lineageWithMergeSql('?');
    expect(lin).toContain('GREATEST(l.merged_at, j.created_at)');
    expect(lin).toContain('MAX(merged_at) AS merged_at');
    const sql = stoppedSql('?', '?');
    expect(sql).toContain('GREATEST(st.texts_stopped_at, lin.merged_at)');
    expect((sql.match(/\?/g) || []).length).toBe(5);
  });
});

describe('P1-E2: unconsented_slot_phone_keys Catch-22 resolution', () => {
  test('pruneRemovedUnconsentedSlotKeys drops removed slot phones while retaining still-present ones', () => {
    const { pruneRemovedUnconsentedSlotKeys } = require('../services/customer-contact');
    const row = {
      service_preferences: JSON.stringify({
        interior_spray: true,
        unconsented_slot_phone_keys: ['9415550111', '9415550222'],
      }),
    };
    expect(pruneRemovedUnconsentedSlotKeys(row, ['+1 (941) 555-0222'], null)).toEqual({
      interior_spray: true,
      unconsented_slot_phone_keys: ['9415550222'],
    });
    expect(pruneRemovedUnconsentedSlotKeys(row, [], null)).toEqual({
      interior_spray: true,
    });
    // Unchanged list returns existingPrefs untouched (null here).
    expect(pruneRemovedUnconsentedSlotKeys(row, ['9415550111', '9415550222'], null)).toBeNull();
  });

  test('claimRecipientOptins does NOT grandfather a phone still held in unconsented_slot_phone_keys', async () => {
    jest.resetModules();
    const savedDouble = process.env.GATE_RECIPIENT_DOUBLE_OPTIN;
    process.env.GATE_RECIPIENT_DOUBLE_OPTIN = 'true';
    try {
      const inserts = [];
      const mockDb = jest.fn((table) => {
        const q = {
          where: () => q,
          whereNull: () => q,
          whereNot: () => q,
          whereNotNull: () => q,
          orWhere: () => q,
          first: async () => (table === 'sms_templates' ? { template_key: 'recipient_optin_request', is_active: true } : null),
          update: async () => 0,
          insert: (row) => {
            inserts.push({ table, row });
            return {
              onConflict: () => ({ ignore: () => ({ returning: async () => [{ phone_key: row.phone_key }] }) }),
            };
          },
        };
        return q;
      });
      jest.doMock('../models/db', () => mockDb);
      jest.doMock('../services/sms-template-renderer', () => ({
        renderSmsTemplate: jest.fn(async () => 'Reply YES to get texts from Waves.'),
      }));
      const { claimRecipientOptins } = require('../services/recipient-optin');
      const claims = await claimRecipientOptins({
        customer: {
          id: 'cust-1',
          phone: '+19415550000',
          first_name: 'Pat',
          service_preferences: JSON.stringify({ unconsented_slot_phone_keys: ['9415550111'] }),
        },
        contacts: [{ name: 'Alex', phone: '+19415550111' }],
        priorPhones: ['+19415550111'],
        propertyAddress: '100 Main St, Sarasota',
        trx: mockDb,
      });
      expect(claims).toHaveLength(1);
      expect(claims[0].key).toBe('9415550111');
      expect(inserts.some((i) => i.table === 'recipient_optin' && i.row.phone_key === '9415550111')).toBe(true);
    } finally {
      if (savedDouble === undefined) delete process.env.GATE_RECIPIENT_DOUBLE_OPTIN;
      else process.env.GATE_RECIPIENT_DOUBLE_OPTIN = savedDouble;
      jest.resetModules();
    }
  });
});

describe('P2-E2: disarmCustomerBillingFields revokes contact refresh families even when preserveActive=true (archive)', () => {
  test('calls revokeContactRefreshFamilies unconditionally', async () => {
    jest.resetModules();
    const revokeSpy = jest.fn(async () => 1);
    jest.doMock('../middleware/auth', () => ({ revokeContactRefreshFamilies: revokeSpy }));
    const mockDbh = jest.fn(() => ({ where: () => ({ update: async () => 1 }) }));
    const { disarmCustomerBillingFields } = require('../services/cancellation-processor');
    await disarmCustomerBillingFields(mockDbh, 'cust-archive-1', { preserveActive: true });
    expect(revokeSpy).toHaveBeenCalledWith(mockDbh, 'cust-archive-1');
  });
});

describe('P2-E3: POST /api/auth/select-property returns 403 for contact session when target slot fails contactSlotMayLogIn', () => {
  test('refuses unconsented target property with 403 before rotating refresh token', async () => {
    jest.resetModules();
    const rotateSpy = jest.fn(async () => ({ ok: true }));
    const targetRow = {
      id: '11111111-1111-4111-8111-111111111111',
      active: true,
      deleted_at: null,
      phone: '+19415550000',
      service_contact_phone: '+19415550202',
      service_contacts_consent_at: null,
      service_preferences: null,
    };
    const mockDb = jest.fn((table) => {
      const q = {
        where: () => q,
        whereNull: () => q,
        first: async () => (table === 'customers' ? targetRow : null),
      };
      return q;
    });
    jest.doMock('../models/db', () => mockDb);
    jest.doMock('../middleware/auth', () => ({
      authenticate: (req, _res, next) => {
        req.customerId = '22222222-2222-4222-8222-222222222222';
        req.contactSession = { phoneKey: '9415550202' };
        req.authSessionId = 'fam-1';
        next();
      },
      requireAccountHolder: (_req, _res, next) => next(),
      generateToken: jest.fn(),
      issueRefreshSession: jest.fn(),
      rotateRefreshSession: rotateSpy,
      revokeRefreshFamily: jest.fn(),
      revokeRefreshToken: jest.fn(),
      authCustomerPayload: jest.fn(),
      actorPayload: jest.fn(),
      contactPropertiesForSession: jest.fn(),
      accountIdForCustomer: jest.fn(),
    }));
    const express = require('express');
    const authRouter = require('../routes/auth');
    const app = express();
    app.use(express.json());
    app.use('/api/auth', authRouter);
    const server = app.listen(0);
    try {
      const res = await fetch(`http://127.0.0.1:${server.address().port}/api/auth/select-property`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ customerId: targetRow.id, refreshToken: 'tok-abc' }),
      });
      expect(res.status).toBe(403);
      expect(rotateSpy).not.toHaveBeenCalled();
    } finally {
      await new Promise((r) => server.close(r));
      jest.resetModules();
    }
  });
});

describe('P3-E: IB set_customer_service_contact refuses no-op change & name-only slot clear', () => {
  test('rejects unchanged contact and name-only contact without phone/email', async () => {
    jest.resetModules();
    const customer = {
      id: '33333333-3333-4333-8333-333333333333',
      first_name: 'Pat',
      last_name: 'Owner',
      phone: '+19415550000',
      email: 'pat@example.com',
      deleted_at: null,
      service_contact_name: 'Sam Spouse',
      service_contact_phone: '+19415550202',
      service_contact_email: '',
      service_contact_role: 'spouse_partner',
    };
    const fakeDb = jest.fn(() => {
      const q = { where: () => q, whereNull: () => q, first: async () => customer };
      return q;
    });
    jest.doMock('../models/db', () => fakeDb);
    const tools = require('../services/intelligence-bar/service-contact-tools');
    const noop = await tools.executeServiceContactTool('set_customer_service_contact', {
      customer_id: customer.id,
      action: 'change',
      slot: 1,
      name: 'Sam Spouse',
      phone: '+19415550202',
      relationship: 'spouse_partner',
    }, { isAdmin: true });
    expect(noop.code).toBe('no_change');

    const nameOnly = await tools.executeServiceContactTool('set_customer_service_contact', {
      customer_id: customer.id,
      action: 'change',
      slot: 1,
      phone: '',
      email: '',
      relationship: 'spouse_partner',
    }, { isAdmin: true });
    expect(nameOnly.code).toBe('invalid_input');
  });
});

describe('P1-E2 legacy slot-1 save skips unreviewed call-inferred slots 2/3 completely', () => {
  test('claimRecipientOptins does not reclaim or insert for unreviewed unconsented slot-2 phone', async () => {
    jest.resetModules();
    const prevDouble = process.env.GATE_RECIPIENT_DOUBLE_OPTIN;
    process.env.GATE_RECIPIENT_DOUBLE_OPTIN = 'true';
    try {
      const touchedPhones = [];
      const trx = (table) => {
        if (table === 'sms_templates') {
          return { where: () => ({ first: async () => ({ template_key: 'recipient_optin_request', is_active: true, body: 'Hi {recipient_first_name}' }) }) };
        }
        const ctx = { phone_key: null };
        const q = {
          where(arg) {
            if (arg && typeof arg === 'object' && arg.phone_key) ctx.phone_key = arg.phone_key;
            return q;
          },
          update: async () => { touchedPhones.push(`update:${ctx.phone_key}`); return 0; },
          insert: (row) => {
            touchedPhones.push(`insert:${row.phone_key}`);
            return { onConflict: () => ({ ignore: () => ({ returning: async () => [{ phone_key: row.phone_key }] }) }) };
          },
        };
        return q;
      };
      jest.doMock('../services/sms-template-renderer', () => ({
        renderSmsTemplate: jest.fn(async () => 'Confirm visit texts? Reply YES'),
      }));
      const { claimRecipientOptins } = require('../services/recipient-optin');
      const customer = {
        id: 'cust-legacy-1',
        first_name: 'Pat',
        phone: '+19415550000',
        service_preferences: JSON.stringify({ unconsented_slot_phone_keys: ['9415550202'] }),
      };
      const claims = await claimRecipientOptins({
        customer,
        contacts: [
          { name: 'Slot One', phone: '+19415550101' },
          { name: 'Untouched Two', phone: '+19415550202' },
        ],
        priorPhones: ['+19415550101', '+19415550202'],
        unconsentedOverridePhones: ['+19415550101'],
        propertyAddress: '100 Main St',
        trx,
      });
      expect(claims).toEqual([]);
      expect(touchedPhones.filter((t) => t.includes('9415550202'))).toEqual([]);
    } finally {
      if (prevDouble === undefined) delete process.env.GATE_RECIPIENT_DOUBLE_OPTIN;
      else process.env.GATE_RECIPIENT_DOUBLE_OPTIN = prevDouble;
    }
  });
});
