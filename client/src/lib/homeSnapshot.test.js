// @vitest-environment jsdom
// Saved home screen storage: what is written (no money), who may read it back
// (the same login only), and when it dies (version, age, identity change).
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  HOME_READS_KEY, HOME_SNAPSHOT_KEY, HOME_STORE_MAX_AGE_MS, HOME_STORE_VERSION,
  dropSavedHomeUnlessSameIdentity, homeIdentityKey, readHomeReads, readHomeSnapshot, writeHomeRead, writeHomeSnapshot,
} from './homeSnapshot';

const b64u = (o) => btoa(JSON.stringify(o)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const makeToken = (claims, tail = 'sig') => `${b64u({ alg: 'none' })}.${b64u(claims)}.${tail}`;

const TOKEN = makeToken({ customerId: 'cust-1', sessionId: 'fam-1' });
const ME = {
  id: 'cust-1', accountId: 'acct-1', profileLabel: 'Primary', isPrimaryProfile: true, firstName: 'Pat', lastName: 'Customer',
  email: 'pat@example.com', phone: '9415551234', tier: 'Silver', memberSince: '2024-01-01', referralCode: 'PAT1',
  address: { line1: '1 Test Way', city: 'Parrish', state: 'FL', zip: '34219', geo: { lat: 1 } },
  property: { lawnType: 'St. Augustine' },
  monthlyRate: 89, accountCredit: 45, autoApplyAccountCredit: true, credits: [{ amount: 25 }], annualPrepay: { termEnd: '2027-01-01' },
  futureMoneyField: 123,
  cancelled: false, cancelledAt: null, actor: { kind: 'holder' },
  notificationPrefs: { smsEnabled: true },
  propertyScope: { enabled: true, propertyId: 'p1' },
};
const PROPS = {
  scope: 'saved',
  properties: [{ key: 'cust-1:p1', customerId: 'cust-1', propertyId: 'p1', isPrimaryProperty: true, isPrimaryProfile: true, profileLabel: 'Primary', tier: 'Silver', monthlyRate: 89, address: { line1: '1 Test Way', city: 'Parrish' } }],
  selected: { key: 'cust-1:p1', customerId: 'cust-1', propertyId: 'p1' },
};

beforeEach(() => { localStorage.clear(); localStorage.setItem('waves_token', TOKEN); });
afterEach(() => localStorage.clear());

// A write for the login that is current: the request identity was captured from this token.
const save = (me = ME, token = TOKEN) => writeHomeSnapshot({ token, requestIdentity: homeIdentityKey(token), me, propertyPayload: PROPS });

describe('homeIdentityKey', () => {
  it('binds customer, session family, property and actor; rotation of the access token keeps it', () => {
    expect(homeIdentityKey(TOKEN)).toBe('cust-1|fam-1||');
    expect(homeIdentityKey(makeToken({ customerId: 'cust-1', sessionId: 'fam-1' }, 'rotated'))).toBe(homeIdentityKey(TOKEN));
    expect(homeIdentityKey(makeToken({ customerId: 'cust-1', sessionId: 'fam-2' }))).not.toBe(homeIdentityKey(TOKEN));
    expect(homeIdentityKey(makeToken({ customerId: 'cust-1', sessionId: 'fam-1', propertyId: 'p2' }))).not.toBe(homeIdentityKey(TOKEN));
    expect(homeIdentityKey(makeToken({ customerId: 'cust-1', sessionId: 'fam-1', contactKey: '9415550000' }))).not.toBe(homeIdentityKey(TOKEN));
  });

  it('has no key for a token without a session family, or garbage', () => {
    expect(homeIdentityKey(makeToken({ customerId: 'cust-1' }))).toBeNull();
    expect(homeIdentityKey('not-a-token')).toBeNull();
    expect(homeIdentityKey(null)).toBeNull();
  });
});

describe('account snapshot', () => {
  it('never stores money, notification prefs or unknown fields, in the profile or the property list', () => {
    expect(save(ME)).toBe(true);
    const raw = localStorage.getItem(HOME_SNAPSHOT_KEY);
    for (const word of ['monthlyRate', 'accountCredit', 'autoApplyAccountCredit', 'credits', 'annualPrepay', 'futureMoneyField', 'smsEnabled', 'geo']) {
      expect(raw).not.toContain(word);
    }
    const saved = readHomeSnapshot(TOKEN);
    expect(saved.customer).toMatchObject({ id: 'cust-1', firstName: 'Pat', tier: 'Silver', actor: { kind: 'holder' }, propertyScope: { enabled: true, propertyId: 'p1' } });
    expect(saved.customer.address).toEqual({ line1: '1 Test Way', city: 'Parrish', state: 'FL', zip: '34219' });
    expect(saved.properties.selected).toEqual({ key: 'cust-1:p1', customerId: 'cust-1', propertyId: 'p1' });
    expect(saved.properties.properties[0].tier).toBe('Silver');
  });

  it('reads back only for the same login', () => {
    save(ME);
    expect(readHomeSnapshot(makeToken({ customerId: 'cust-2', sessionId: 'fam-1' }))).toBeNull();
    // A mismatch deletes the entry: the other identity's token cannot "retry" it either.
    expect(localStorage.getItem(HOME_SNAPSHOT_KEY)).toBeNull();
    save(ME);
    expect(readHomeSnapshot(makeToken({ customerId: 'cust-1', sessionId: 'fam-1' }, 'rotated'))).not.toBeNull();
  });

  it('rejects and deletes an expired entry, a future-dated one and a wrong version', () => {
    const write = (patch) => {
      save(ME);
      const entry = JSON.parse(localStorage.getItem(HOME_SNAPSHOT_KEY));
      localStorage.setItem(HOME_SNAPSHOT_KEY, JSON.stringify({ ...entry, ...patch }));
    };
    write({ savedAt: Date.now() - HOME_STORE_MAX_AGE_MS - 1000 });
    expect(readHomeSnapshot(TOKEN)).toBeNull();
    expect(localStorage.getItem(HOME_SNAPSHOT_KEY)).toBeNull();
    write({ savedAt: Date.now() + 60 * 60 * 1000 });
    expect(readHomeSnapshot(TOKEN)).toBeNull();
    write({ v: HOME_STORE_VERSION + 1 });
    expect(readHomeSnapshot(TOKEN)).toBeNull();
    expect(localStorage.getItem(HOME_SNAPSHOT_KEY)).toBeNull();
    write({});
    expect(readHomeSnapshot(TOKEN)).not.toBeNull();
  });

  it('never saves, and never adopts, a cancelled or contact account', () => {
    expect(save({ ...ME, cancelled: true })).toBe(false);
    expect(save({ ...ME, actor: { kind: 'contact', slot: 1 } })).toBe(false);
    expect(localStorage.getItem(HOME_SNAPSHOT_KEY)).toBeNull();
    // A planted entry with the right identity but a cancelled / contact body is refused too.
    save(ME);
    const entry = JSON.parse(localStorage.getItem(HOME_SNAPSHOT_KEY));
    localStorage.setItem(HOME_SNAPSHOT_KEY, JSON.stringify({ ...entry, customer: { ...entry.customer, cancelled: true } }));
    expect(readHomeSnapshot(TOKEN)).toBeNull();
    localStorage.setItem(HOME_SNAPSHOT_KEY, JSON.stringify({ ...entry, customer: { ...entry.customer, actor: { kind: 'contact' } } }));
    expect(readHomeSnapshot(TOKEN)).toBeNull();
  });

  it('a token for another identity deletes the saved entries; a same-session rotation keeps them', () => {
    localStorage.setItem('waves_token', TOKEN);
    save(ME);
    writeHomeRead(homeIdentityKey(TOKEN), 'cust-1:p1', 'next-visit', { next: null }, Date.now());
    dropSavedHomeUnlessSameIdentity(makeToken({ customerId: 'cust-1', sessionId: 'fam-1' }, 'rotated'));
    expect(localStorage.getItem(HOME_SNAPSHOT_KEY)).not.toBeNull();
    expect(localStorage.getItem(HOME_READS_KEY)).not.toBeNull();
    dropSavedHomeUnlessSameIdentity(makeToken({ customerId: 'cust-1', sessionId: 'fam-1', propertyId: 'p2' }));
    expect(localStorage.getItem(HOME_SNAPSHOT_KEY)).toBeNull();
    expect(localStorage.getItem(HOME_READS_KEY)).toBeNull();
  });
});

describe('who a snapshot write is for', () => {
  // Another login of the SAME customer (a new session family): only the request identity tells it apart.
  const OTHER = makeToken({ customerId: 'cust-1', sessionId: 'fam-9' });
  const STRANGER = makeToken({ customerId: 'cust-2', sessionId: 'fam-9' });

  it('writes nothing when another login holds the token by the time the response lands', () => {
    // The request left under TOKEN; a refresh adopted another tab's new login.
    const requestIdentity = homeIdentityKey(TOKEN);
    localStorage.setItem('waves_token', OTHER);
    expect(writeHomeSnapshot({ token: OTHER, requestIdentity, me: ME, propertyPayload: PROPS })).toBe(false);
    expect(localStorage.getItem(HOME_SNAPSHOT_KEY)).toBeNull();
  });

  it('writes nothing when the stored login differs from the token in memory', () => {
    localStorage.setItem('waves_token', STRANGER);
    expect(save(ME, TOKEN)).toBe(false);
    expect(localStorage.getItem(HOME_SNAPSHOT_KEY)).toBeNull();
  });

  it('writes nothing when the profile is not the token\'s customer', () => {
    expect(save({ ...ME, id: 'cust-2' })).toBe(false);
    expect(localStorage.getItem(HOME_SNAPSHOT_KEY)).toBeNull();
  });

  it('writes for the matching login', () => {
    expect(save()).toBe(true);
  });
});

describe('saved home reads', () => {
  const identity = homeIdentityKey(TOKEN);
  beforeEach(() => localStorage.setItem('waves_token', TOKEN));

  it('keeps only the two home reads and only what the saved card prints', () => {
    const visit = { id: 'v1', serviceType: 'Pest Control', date: '2026-12-01', windowStart: '09:00', day_only: false, reportUrl: 'https://x.test/r/secret', calendarUrl: 'https://x.test/c', price: 99 };
    writeHomeRead(identity, 'cust-1:p1', 'next-visit', { next: visit, propertyScope: { enabled: true, propertyId: 'p1' } }, 1000 + Date.now());
    writeHomeRead(identity, 'cust-1:p1', 'latest-service', { services: [visit, { ...visit, id: 'v0' }], total: 9 }, Date.now());
    writeHomeRead(identity, 'cust-1:p1', 'documents', { documents: [{ id: 'd1' }] }, Date.now());
    writeHomeRead(identity, 'cust-1:p1', 'schedule', { upcoming: [visit] }, Date.now());
    const raw = localStorage.getItem(HOME_READS_KEY);
    for (const word of ['reportUrl', 'secret', 'calendarUrl', 'price', 'documents', 'schedule', 'total']) expect(raw).not.toContain(word);
    const reads = readHomeReads(identity, 'cust-1:p1');
    expect(Object.keys(reads).sort()).toEqual(['latest-service', 'next-visit']);
    expect(reads['next-visit'].data).toEqual({ propertyScope: { enabled: true, propertyId: 'p1' }, next: { id: 'v1', serviceType: 'Pest Control', date: '2026-12-01', windowStart: '09:00', day_only: false } });
    expect(reads['latest-service'].data.services).toHaveLength(1);
  });

  it('serves nothing for another property or login and deletes the entry', () => {
    writeHomeRead(identity, 'cust-1:p1', 'next-visit', { next: null }, Date.now());
    expect(readHomeReads(identity, 'cust-1:p2')).toEqual({});
    expect(localStorage.getItem(HOME_READS_KEY)).toBeNull();
    writeHomeRead(identity, 'cust-1:p1', 'next-visit', { next: null }, Date.now());
    expect(readHomeReads(homeIdentityKey(makeToken({ customerId: 'cust-9', sessionId: 'fam-1' })), 'cust-1:p1')).toEqual({});
    expect(localStorage.getItem(HOME_READS_KEY)).toBeNull();
  });

  it('writes nothing when the stored login is gone or different (a late response after sign-out)', () => {
    localStorage.removeItem('waves_token');
    writeHomeRead(identity, 'cust-1:p1', 'next-visit', { next: null }, Date.now());
    expect(localStorage.getItem(HOME_READS_KEY)).toBeNull();
    localStorage.setItem('waves_token', makeToken({ customerId: 'cust-2', sessionId: 'fam-9' }));
    writeHomeRead(identity, 'cust-1:p1', 'next-visit', { next: null }, Date.now());
    expect(localStorage.getItem(HOME_READS_KEY)).toBeNull();
  });

  it('drops a read older than 30 days even when the entry itself is fresh', () => {
    writeHomeRead(identity, 'cust-1:p1', 'next-visit', { next: null }, Date.now() - HOME_STORE_MAX_AGE_MS - 1000);
    writeHomeRead(identity, 'cust-1:p1', 'latest-service', { services: [] }, Date.now());
    expect(Object.keys(readHomeReads(identity, 'cust-1:p1'))).toEqual(['latest-service']);
  });

  it('preserves customerPickBy on a saved next-visit and drops pre-upgrade windowless entries missing the field', () => {
    const pickVisitRow = { id: 'v2', serviceType: 'Pest Control', date: '2026-12-08', windowStart: null, customerPickBy: '2026-12-05T01:00:00.000Z', rescheduleUrl: '/reschedule/secret' };
    writeHomeRead(identity, 'cust-1:p1', 'next-visit', { next: pickVisitRow }, Date.now());
    const reads = readHomeReads(identity, 'cust-1:p1');
    expect(reads['next-visit'].data.next).toEqual({
      id: 'v2', serviceType: 'Pest Control', date: '2026-12-08', windowStart: null, customerPickBy: '2026-12-05T01:00:00.000Z',
    });
    expect(localStorage.getItem(HOME_READS_KEY)).not.toContain('secret');

    // A pre-upgrade saved windowless next-visit lacked customerPickBy and could hold a placeholder date.
    const stored = JSON.parse(localStorage.getItem(HOME_READS_KEY));
    delete stored.reads['next-visit'].data.next.customerPickBy;
    localStorage.setItem(HOME_READS_KEY, JSON.stringify(stored));
    expect(readHomeReads(identity, 'cust-1:p1')['next-visit']).toBeUndefined();
  });
});
