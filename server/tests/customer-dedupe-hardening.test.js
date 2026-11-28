/**
 * Customer merge & merge-undo hardening + static migration schema ratchet
 * (P1-D1, P1-F2, P2-E1, P2-D1).
 */
const fs = require('fs');
const path = require('path');

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
const mockAudit = jest.fn(async () => {});
jest.mock('../services/audit-log', () => ({ recordAuditEvent: (...a) => mockAudit(...a) }));

const dedupe = require('../services/customer-dedupe');

describe('PR 3 merge & undo table coverage', () => {
  test('REPOINT_EXCLUDED_TABLES excludes session/evidence/filing-hash tables that must never repoint onto winner', () => {
    for (const table of [
      'customer_email_change_requests',
      'call_email_spelling_retries',
      'visit_access_states',
      'visit_access_verdicts',
      'neighborhood_access_filings',
    ]) {
      expect(dedupe.REPOINT_EXCLUDED_TABLES.has(table)).toBe(true);
    }
  });

  test('REPOINT_PK_COLUMNS maps non-id PK tables (customer_refresh_tokens, estimate_roof_points)', () => {
    expect(dedupe._test.REPOINT_PK_COLUMNS).toMatchObject({
      customer_refresh_tokens: 'jti',
      estimate_roof_points: 'estimate_id',
    });
  });

  test('AUTO_BLOCKER_TABLES includes multi_home_family_members', () => {
    const src = fs.readFileSync(path.join(__dirname, '../services/customer-dedupe.js'), 'utf8');
    expect(src).toMatch(/const AUTO_BLOCKER_TABLES = \[[\s\S]*?'multi_home_family_members'[\s\S]*?\];/);
  });

  test('repointMultiHomeFamilyMembers removes colliding loser row, writes audit_log, and cleans up 1-member singleton orphan', async () => {
    mockAudit.mockClear();
    const rows = [
      { id: 'm-win', customer_id: 'win-1', family_id: 'fam-1' },
      { id: 'm-lose', customer_id: 'lose-1', family_id: 'fam-1' },
    ];
    const deleted = [];
    const trx = (table) => {
      expect(table).toBe('multi_home_family_members');
      let cond = {};
      const q = {
        where(w) { cond = { ...cond, ...w }; return q; },
        forUpdate() { return q; },
        first: async () => rows.find((r) => Object.entries(cond).every(([k, v]) => r[k] === v)) || null,
        select: async () => rows.filter((r) => Object.entries(cond).every(([k, v]) => r[k] === v)),
        del: async () => {
          const idx = rows.findIndex((r) => Object.entries(cond).every(([k, v]) => r[k] === v));
          if (idx >= 0) {
            deleted.push(rows[idx].id);
            rows.splice(idx, 1);
            return 1;
          }
          return 0;
        },
        update: async () => 1,
      };
      return q;
    };
    const msg = await dedupe._test.repointMultiHomeFamilyMembers(
      trx,
      'multi_home_family_members',
      'customer_id',
      'win-1',
      'lose-1',
      { performedById: 'admin-1' },
    );
    expect(msg).toMatch(/dropped 1 duplicate family row, cleaned 1 singleton orphan/);
    expect(deleted).toEqual(['m-lose', 'm-win']);
    expect(rows).toHaveLength(0);
    expect(mockAudit).toHaveBeenCalledTimes(2);
    expect(mockAudit.mock.calls[0][0]).toMatchObject({ action: 'multi_home_family.unlinked', resource_id: 'lose-1', critical: true });
    expect(mockAudit.mock.calls[1][0]).toMatchObject({ action: 'multi_home_family.unlinked', resource_id: 'win-1', critical: true });
  });

  test('repointCustomerMoves closes a colliding live move with closed_reason="cancelled" on 23505', async () => {
    const updates = [];
    const trx = (table) => {
      expect(table).toBe('customer_moves');
      let whereObj = {};
      const q = {
        where(a, b) {
          if (typeof a === 'string') whereObj[a] = b;
          else whereObj = { ...whereObj, ...a };
          return q;
        },
        forUpdate() { return q; },
        select: async () => [{ id: 'mv-1', status: 'open', pause_state: 'none' }, { id: 'mv-2', status: 'closed', pause_state: 'none' }],
        first: async () => ({ id: whereObj.id || 'mv-1', status: whereObj.id === 'mv-2' ? 'closed' : 'open', pause_state: 'none' }),
        update: async (patch) => {
          updates.push({ id: whereObj.id, patch });
          return 1;
        },
      };
      return q;
    };
    trx.raw = async () => ({});
    trx.fn = { now: () => 'NOW()' };
    trx.transaction = async (cb) => {
      const sp = () => ({
        where(w) {
          return {
            update: async (patch) => {
              if (w.id === 'mv-1') {
                const err = new Error('duplicate key violates customer_moves_one_live_per_customer');
                err.code = '23505';
                throw err;
              }
              updates.push({ id: w.id, patch });
              return 1;
            },
          };
        },
      });
      return cb(sp);
    };
    const msg = await dedupe._test.repointCustomerMoves(trx, 'customer_moves', 'customer_id', 'win-1', 'lose-1');
    expect(msg).toMatch(/moved 1, closed 1 colliding live move/);
    expect(updates).toEqual([
      {
        id: 'mv-1',
        patch: {
          customer_id: 'win-1',
          status: 'closed',
          closed_reason: 'cancelled',
          closed_at: 'NOW()',
          updated_at: 'NOW()',
        },
      },
      { id: 'mv-2', patch: { customer_id: 'win-1' } },
    ]);
  });

  test('repointPromoCodesNullCollisions detaches colliding redeemed promo row instead of deleting audit trail', async () => {
    const updates = [];
    const trx = () => {
      let whereObj = {};
      const q = {
        where(a, b) {
          if (typeof a === 'string') whereObj[a] = b;
          else whereObj = { ...whereObj, ...a };
          return q;
        },
        select: async () => [{ id: 'pc-1' }, { id: 'pc-2' }],
        update: async (patch) => {
          updates.push({ id: whereObj.id, patch });
          return 1;
        },
      };
      return q;
    };
    trx.fn = { now: () => 'NOW()' };
    trx.transaction = async (cb) => {
      const sp = () => ({
        where(w) {
          return {
            update: async (patch) => {
              if (w.id === 'pc-1') {
                const err = new Error('duplicate key violates estimate_promo_codes_redeemed_customer_discount_uidx');
                err.code = '23505';
                throw err;
              }
              updates.push({ id: w.id, patch });
              return 1;
            },
          };
        },
      });
      return cb(sp);
    };
    const msg = await dedupe._test.repointPromoCodesNullCollisions(
      trx,
      'estimate_promo_codes',
      'redeemed_by_customer_id',
      'win-1',
      'lose-1',
    );
    expect(msg).toMatch(/moved 1, detached 1 duplicate redeemed promo row/);
    expect(updates).toEqual([
      { id: 'pc-1', patch: { redeemed_by_customer_id: null, updated_at: 'NOW()' } },
      { id: 'pc-2', patch: { redeemed_by_customer_id: 'win-1' } },
    ]);
  });

  test('review_sequences handler stops colliding active sequence on 23505 instead of aborting', async () => {
    const updates = [];
    const trx = () => {
      let whereObj = {};
      const q = {
        where(a, b) {
          if (typeof a === 'string') whereObj[a] = b;
          else whereObj = { ...whereObj, ...a };
          return q;
        },
        select: async () => [{ id: 'seq-1', status: 'active' }],
        update: async (patch) => {
          updates.push({ id: whereObj.id, patch });
          return 1;
        },
      };
      return q;
    };
    trx.fn = { now: () => 'NOW()' };
    trx.transaction = async (cb) => cb(() => ({
      where() {
        return {
          update: async () => {
            const err = new Error('duplicate key violates uq_review_sequences_active_customer');
            err.code = '23505';
            throw err;
          },
        };
      },
    }));
    const msg = await dedupe._test.UNIQUE_COLLISION_HANDLERS.review_sequences(
      trx, 'review_sequences', 'customer_id', 'win-1', 'lose-1',
    );
    expect(msg).toMatch(/stopped 1/);
    expect(updates).toEqual([{
      id: 'seq-1',
      patch: { customer_id: 'win-1', status: 'stopped', stop_reason: 'manual', next_run_at: null, updated_at: 'NOW()' },
    }]);
  });

  test('appointment_card_requests handler expires colliding pending standalone link and aborts on completing', async () => {
    const updates = [];
    const makeTrx = (rows) => {
      const trx = () => {
        let whereObj = {};
        const q = {
          where(a, b) {
            if (typeof a === 'string') whereObj[a] = b;
            else whereObj = { ...whereObj, ...a };
            return q;
          },
          select: async () => rows,
          update: async (patch) => {
            updates.push({ id: whereObj.id, patch });
            return 1;
          },
        };
        return q;
      };
      trx.fn = { now: () => 'NOW()' };
      trx.transaction = async (cb) => cb(() => ({
        where() {
          return {
            update: async () => {
              const err = new Error('duplicate key violates uq_appt_card_requests_customer_pending_standalone');
              err.code = '23505';
              throw err;
            },
          };
        },
      }));
      return trx;
    };
    const msg = await dedupe._test.UNIQUE_COLLISION_HANDLERS.appointment_card_requests(
      makeTrx([{ id: 'acr-1', kind: 'customer', status: 'pending' }]),
      'appointment_card_requests', 'customer_id', 'win-1', 'lose-1',
    );
    expect(msg).toMatch(/expired 1/);
    expect(updates).toEqual([{
      id: 'acr-1',
      patch: { customer_id: 'win-1', status: 'expired', updated_at: 'NOW()' },
    }]);

    await expect(
      dedupe._test.UNIQUE_COLLISION_HANDLERS.appointment_card_requests(
        makeTrx([{ id: 'acr-2', kind: 'customer', status: 'completing' }]),
        'appointment_card_requests', 'customer_id', 'win-1', 'lose-1',
      ),
    ).rejects.toThrow(/in-flight standalone Auto Pay setup link/i);

    // Concurrent claim race: CAS update updates 0 rows -> aborts merge.
    const makeZeroRowTrx = () => {
      const trx = () => ({
        where() { return this; },
        select: async () => [{ id: 'acr-3', kind: 'customer', status: 'pending' }],
        update: async () => 0,
      });
      trx.fn = { now: () => 'NOW()' };
      trx.transaction = async (cb) => cb(() => ({
        where() {
          return {
            update: async () => {
              const err = new Error('23505');
              err.code = '23505';
              throw err;
            },
          };
        },
      }));
      return trx;
    };
    await expect(
      dedupe._test.UNIQUE_COLLISION_HANDLERS.appointment_card_requests(
        makeZeroRowTrx(), 'appointment_card_requests', 'customer_id', 'win-1', 'lose-1',
      ),
    ).rejects.toThrow(/changed while merging/i);
  });

  test('customer_access_codes handler drops identical duplicate and aborts on conflicting decision or scope', async () => {
    const deleted = [];
    const makeTrx = (loserRow, winnerRow) => {
      const trx = () => {
        let whereObj = {};
        const q = {
          where(a, b) {
            if (typeof a === 'string') whereObj[a] = b;
            else whereObj = { ...whereObj, ...a };
            return q;
          },
          whereRaw() { return q; },
          forUpdate() { return q; },
          select: async () => [loserRow],
          first: async () => winnerRow,
          del: async () => { deleted.push(whereObj.id); return 1; },
        };
        return q;
      };
      trx.transaction = async (cb) => cb(() => ({
        where() { return { update: async () => { const e = new Error('23505'); e.code = '23505'; throw e; } }; },
      }));
      return trx;
    };
    const base = { id: 'ac-1', source_type: 'sms', source_id: 's1', kind: 'door', value_hash: 'h1', instructions: 'Press 2', life: 'standing', status: 'active', property_id: 'p1', scheduled_service_id: null };
    const msg = await dedupe._test.UNIQUE_COLLISION_HANDLERS.customer_access_codes(
      makeTrx(base, { id: 'ac-w', life: 'standing', status: 'active', property_id: 'p1', scheduled_service_id: null }),
      'customer_access_codes', 'customer_id', 'win-1', 'lose-1',
    );
    expect(msg).toMatch(/dropped 1 identical/);
    expect(deleted).toEqual(['ac-1']);

    await expect(
      dedupe._test.UNIQUE_COLLISION_HANDLERS.customer_access_codes(
        makeTrx(base, { id: 'ac-w', life: 'standing', status: 'retired', property_id: 'p1', scheduled_service_id: null }),
        'customer_access_codes', 'customer_id', 'win-1', 'lose-1',
      ),
    ).rejects.toThrow(/conflicting access-code decisions/i);

    await expect(
      dedupe._test.UNIQUE_COLLISION_HANDLERS.customer_access_codes(
        makeTrx(base, { id: 'ac-w', life: 'visit', status: 'active', property_id: 'p1', scheduled_service_id: null }),
        'customer_access_codes', 'customer_id', 'win-1', 'lose-1',
      ),
    ).rejects.toThrow(/conflicting access-code decisions/i);
  });

  test('customer_signals handler resolves duplicate signal in place instead of deleting', async () => {
    const updates = [];
    const trx = () => {
      let whereObj = {};
      const q = {
        where(a, b) {
          if (typeof a === 'string') whereObj[a] = b;
          else whereObj = { ...whereObj, ...a };
          return q;
        },
        select: async () => [{ id: 'sig-1' }],
        update: async (patch) => { updates.push({ id: whereObj.id, patch }); return 1; },
      };
      return q;
    };
    trx.fn = { now: () => 'NOW()' };
    trx.transaction = async (cb) => cb(() => ({
      where() { return { update: async () => { const e = new Error('23505'); e.code = '23505'; throw e; } }; },
    }));
    const msg = await dedupe._test.UNIQUE_COLLISION_HANDLERS.customer_signals(
      trx, 'customer_signals', 'customer_id', 'win-1', 'lose-1',
    );
    expect(msg).toMatch(/resolved 1 duplicate/);
    expect(updates).toEqual([{
      id: 'sig-1',
      patch: { customer_id: 'win-1', resolved: true, resolved_at: 'NOW()', resolved_by: 'admin_manual', updated_at: 'NOW()' },
    }]);
  });

  test('repointCustomerMoves refuses collision when duplicate move has already paused or claimed pause_at', async () => {
    const makePausedTrx = (row) => {
      const trx = () => ({
        where() { return this; },
        forUpdate() { return this; },
        select: async () => [row],
        first: async () => row,
      });
      trx.raw = async () => ({});
      trx.fn = { now: () => 'NOW()' };
      trx.transaction = async (cb) => cb(() => ({
        where() { return { update: async () => { const e = new Error('23505'); e.code = '23505'; throw e; } }; },
      }));
      return trx;
    };
    await expect(
      dedupe._test.repointCustomerMoves(makePausedTrx({ id: 'mv-paused', status: 'submitted', pause_state: 'paused', paused_at: null }), 'customer_moves', 'customer_id', 'win-1', 'lose-1'),
    ).rejects.toThrow(/pause workflow/i);
    await expect(
      dedupe._test.repointCustomerMoves(makePausedTrx({ id: 'mv-claimed', status: 'submitted', pause_state: null, paused_at: '2026-11-27T12:00:00Z' }), 'customer_moves', 'customer_id', 'win-1', 'lose-1'),
    ).rejects.toThrow(/pause workflow/i);
  });

  test('verifyPostMergeFamilyAndDunningSafety blocks undo on 0-touch post-merge dunning schedule', async () => {
    const mergeAt = new Date('2026-11-27T10:00:00Z');
    const trx = (table) => ({
      whereIn() { return this; },
      select: async () => (table === 'customer_dunning_schedules'
        ? [{ id: 'dun-1', created_at: '2026-11-27T11:00:00Z', updated_at: '2026-11-27T11:00:00Z' }]
        : []),
    });
    const refuse = (reason) => {
      const e = new Error(reason);
      e.statusCode = 409;
      throw e;
    };
    await expect(
      dedupe._test.verifyPostMergeFamilyAndDunningSafety(trx, {
        winnerId: 'win-1',
        loserId: 'lose-1',
        mergeAt,
        recorded: { tables: {} },
        journaledIdsFor: () => new Set(),
        refuse,
      }),
    ).rejects.toMatchObject({ statusCode: 409, message: /overdue reminder schedule/i });
  });

  test('verifyPostMergeFamilyAndDunningSafety blocks undo when post-merge family member linked after mergeAt', async () => {
    const mergeAt = new Date('2026-11-27T10:00:00Z');
    let familyCalls = 0;
    const trx = (table) => {
      if (table === 'customer_dunning_schedules') {
        return { whereIn() { return this; }, select: async () => [] };
      }
      if (table === 'multi_home_family_members') {
        familyCalls += 1;
        const call = familyCalls;
        return {
          where() { return this; },
          first: async () => (call === 1
            ? { id: 'm-1', family_id: 'fam-1', linked_at: '2026-11-20T00:00:00Z' }
            : { id: 'm-2' }),
        };
      }
      return { whereIn() { return this; }, select: async () => [] };
    };
    const refuse = (reason) => {
      const e = new Error(reason);
      e.statusCode = 409;
      throw e;
    };
    await expect(
      dedupe._test.verifyPostMergeFamilyAndDunningSafety(trx, {
        winnerId: 'win-1',
        loserId: 'lose-1',
        mergeAt,
        recorded: { tables: { 'multi_home_family_members.customer_id': ['m-1'] } },
        journaledIdsFor: () => new Set(),
        refuse,
      }),
    ).rejects.toMatchObject({ statusCode: 409, message: /Same-family membership changed/i });
  });

  test('verifyPostMergeFamilyAndDunningSafety blocks undo when moved customer_moves holds unjournaled child links', async () => {
    const mergeAt = new Date('2026-11-27T10:00:00Z');
    const trx = (table) => {
      if (table === 'customer_dunning_schedules') {
        return { whereIn() { return this; }, select: async () => [] };
      }
      if (table === 'customer_moves') {
        return {
          whereIn() { return this; },
          select: async () => [{ id: 'mv-1', service_request_id: null, estimate_id: 'est-new', to_property_id: null }],
        };
      }
      return { whereIn() { return this; }, select: async () => [] };
    };
    const refuse = (reason) => {
      const e = new Error(reason);
      e.statusCode = 409;
      throw e;
    };
    await expect(
      dedupe._test.verifyPostMergeFamilyAndDunningSafety(trx, {
        winnerId: 'win-1',
        loserId: 'lose-1',
        mergeAt,
        recorded: { tables: {} },
        journaledIdsFor: (t) => (t === 'customer_moves' ? new Set(['mv-1']) : new Set()),
        refuse,
      }),
    ).rejects.toMatchObject({ statusCode: 409, message: /moving record.*outside the journal/i });
  });
});

describe('Static CI ratchet: every customer_id table with a customer_id unique index or non-id PK is explicitly handled in customer-dedupe.js', () => {
  const migrationsDir = path.join(__dirname, '../models/migrations');
  const dedupeSrc = fs.readFileSync(path.join(__dirname, '../services/customer-dedupe.js'), 'utf8');
  const excluded = dedupe.REPOINT_EXCLUDED_TABLES;

  const handlerBlockMatch = dedupeSrc.match(/const UNIQUE_COLLISION_HANDLERS = \{([\s\S]*?)\n\};/);
  const handledCollisionTables = new Set(
    (handlerBlockMatch?.[1] || '').match(/^\s*([a-z0-9_]+)\s*:/gm)?.map((m) => m.replace(/[:\s]/g, '')) || [],
  );
  const customHandledTables = new Set([
    'customer_dunning_schedules', // customer-dunning/merge.js releases & renumbers episodes
    'recipient_optin', // pre-sweep consent fold
    'customers', // root table itself
    'customer_accounts', // account table (not customer_id)
    'customer_turf_profiles', // operator-authored: intentionally aborts on collision
    'plan_holds', // operator-authored active hold with held_monthly_rate: auto-blocker + manual abort
    'price_change_notices', // issued notice tokens & delivery history: auto-blocker + manual abort (preserve both tokens)
    'lawn_program_enrollments',
    'referral_promoters',
    'call_log',
    'collection_cases',
    'collections_contact_ledger',
  ]);

  test('every migration creating a UNIQUE index on a *customer_id column has an explicit exclusion, collision handler, or custom/abort policy in customer-dedupe.js', () => {
    const files = fs.readdirSync(migrationsDir).filter((f) => f.endsWith('.js')).sort();
    const unhandled = [];
    const createUidRe = /CREATE\s+UNIQUE\s+INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?\S+\s+ON\s+([a-z0-9_]+)\s*\(([^)]+)\)/gi;
    for (const file of files) {
      const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
      let m;
      while ((m = createUidRe.exec(sql)) !== null) {
        const table = m[1].toLowerCase();
        const cols = m[2].toLowerCase();
        if (!/(^|[,\s])([a-z0-9_]*customer_id)\b/.test(cols)) continue;
        if (excluded.has(table) || handledCollisionTables.has(table) || customHandledTables.has(table)) continue;
        unhandled.push(`${table} (${file})`);
      }
    }
    expect(unhandled).toEqual([]);
  });
});
