// Saved home screen (owner 2026-11-25: "the app opens to a real screen in about
// 1 second on weak signal. Payments still wait for fresh data").
//
// Two small localStorage entries let the customer app paint the last screen it
// loaded while /auth/me and the home reads are still on the way:
//   waves_home_snapshot  the signed-in profile (allowlisted, NO money) + the
//                        property list + the session's property selection
//   waves_home_reads     the 'next-visit' and 'latest-service' reads, cut down to
//                        what the saved visit card prints
// Both are bound to the login (homeIdentityKey) and expire after 30 days. Every
// reader checks the binding; every sign-out, 401/403, token clear, identity or
// property change deletes them. Nothing here is verified against the server and
// nothing here may stand in for auth: the page keeps showing the saved screen
// as "Updating…" and withholds money and payment actions until fresh data lands.
export const HOME_SNAPSHOT_KEY = 'waves_home_snapshot';
export const HOME_READS_KEY = 'waves_home_reads';
export const HOME_STORE_VERSION = 1;
export const HOME_STORE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
// The only portal reads written to browser storage.
export const SAVED_READ_KEYS = ['next-visit', 'latest-service'];

const CLOCK_SKEW_MS = 5 * 60 * 1000;

function tokenPayload(token) {
  try {
    const b64 = String(token).split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(atob(b64.padEnd(b64.length + ((4 - (b64.length % 4)) % 4), '=')));
  } catch {
    return null;
  }
}

// Who a saved screen belongs to, read from the session token's payload (not
// verified here; the server verifies every request). The server mints every
// customer access token with customerId + sessionId (the refresh-token family:
// new for each login, kept across the 15-minute access-token rotations), plus
// propertyId / contactKey when the session has them. All four join the key, so
// a new login, another customer, another saved property or a contact session
// never matches. A token with no sessionId (a legacy one) has no key: no saved
// screen, never a guess.
export function homeIdentityKey(token) {
  const payload = token ? tokenPayload(token) : null;
  if (!payload || payload.customerId == null || payload.sessionId == null) return null;
  return [payload.customerId, payload.sessionId, payload.propertyId ?? '', payload.contactKey ?? ''].map(String).join('|');
}

function readEntry(storageKey) {
  try {
    const entry = JSON.parse(localStorage.getItem(storageKey) || 'null');
    return entry && typeof entry === 'object' ? entry : null;
  } catch {
    return null;
  }
}

function writeEntry(storageKey, entry) {
  try { localStorage.setItem(storageKey, JSON.stringify(entry)); } catch { /* storage full or blocked: no saved screen */ }
}

function removeEntry(storageKey) {
  try { localStorage.removeItem(storageKey); } catch { /* storage blocked */ }
}

function entryUsable(entry, identity) {
  if (!entry || entry.v !== HOME_STORE_VERSION || !identity || entry.identity !== identity) return false;
  const age = Date.now() - Number(entry.savedAt);
  return Number.isFinite(age) && age >= -CLOCK_SKEW_MS && age <= HOME_STORE_MAX_AGE_MS;
}

export function clearHomeSnapshot() {
  removeEntry(HOME_SNAPSHOT_KEY);
}

export function clearHomeReads() {
  removeEntry(HOME_READS_KEY);
}

// Delete the entries that belong to ONE login and leave any other login's
// alone: a denial that lands late (after its reader unmounted) must not erase
// what another login has saved since.
function clearEntriesFor(keys, identity) {
  if (!identity) return;
  for (const key of keys) {
    const entry = readEntry(key);
    if (entry && entry.identity === identity) removeEntry(key);
  }
}

export function clearHomeReadsFor(identity) {
  clearEntriesFor([HOME_READS_KEY], identity);
}

export function clearSavedHomeFor(identity) {
  clearEntriesFor([HOME_SNAPSHOT_KEY, HOME_READS_KEY], identity);
}

export function clearSavedHome() {
  clearHomeSnapshot();
  clearHomeReads();
}

// A new token for a different login, property or actor ends the old saved
// screen. A same-session rotation keeps it.
export function dropSavedHomeUnlessSameIdentity(token) {
  const identity = homeIdentityKey(token);
  for (const key of [HOME_SNAPSHOT_KEY, HOME_READS_KEY]) {
    const entry = readEntry(key);
    if (entry && (!identity || entry.identity !== identity)) removeEntry(key);
  }
}

// ---- Account snapshot -----------------------------------------------------

// An allowlist, not a blocklist: /auth/me and the property entries carry money
// (monthlyRate, accountCredit, autoApplyAccountCredit, credits, annualPrepay)
// and anything added there later stays out of storage by default.
const ME_FIELDS = ['id', 'accountId', 'profileLabel', 'isPrimaryProfile', 'firstName', 'lastName',
  'email', 'phone', 'tier', 'memberSince', 'referralCode', 'cancelled', 'cancelledAt'];
const ADDRESS_FIELDS = ['line1', 'line2', 'city', 'state', 'zip'];
const PROPERTY_FIELDS = ['key', 'id', 'accountId', 'customerId', 'propertyId', 'isPrimaryProfile', 'isPrimaryProperty',
  'profileLabel', 'label', 'relationship', 'occupancyType', 'firstName', 'lastName', 'tier'];

function pick(source, fields) {
  const out = {};
  for (const field of fields) if (source?.[field] !== undefined) out[field] = source[field];
  return out;
}

const pickAddress = (address) => (address && typeof address === 'object' ? pick(address, ADDRESS_FIELDS) : null);

// What the shell needs to paint, no money. notificationPrefs is null (the
// settings that read it are behind the Updating screen) and propertyScope is
// kept: the page reads it to name the house it shows.
export function snapshotCustomer(me) {
  const customer = pick(me, ME_FIELDS);
  customer.address = pickAddress(me?.address);
  customer.property = me?.property && typeof me.property === 'object' ? { ...me.property } : null;
  customer.actor = { kind: 'holder' };
  customer.notificationPrefs = null;
  if (me?.propertyScope && typeof me.propertyScope === 'object') customer.propertyScope = { ...me.propertyScope };
  return customer;
}

function snapshotProperties(payload) {
  if (!payload || typeof payload !== 'object' || !Array.isArray(payload.properties)) return null;
  return {
    scope: payload.scope === 'saved' ? 'saved' : 'profile',
    properties: payload.properties.map((entry) => ({ ...pick(entry, PROPERTY_FIELDS), address: pickAddress(entry?.address) })),
    selected: payload.selected && typeof payload.selected === 'object'
      ? pick(payload.selected, ['key', 'customerId', 'propertyId', 'closed'])
      : null,
  };
}

// Only a holder's open account is saved: a contact session and a cancelled
// (read-only) account have narrower screens and are never adopted.
export function snapshotEligible(me) {
  return !!me && me.cancelled !== true && me.actor?.kind !== 'contact';
}

// The identity of the login stored in this browser right now (what another tab
// may have replaced since a request started).
export function storedHomeIdentity() {
  try { return homeIdentityKey(localStorage.getItem('waves_token')); } catch { return null; }
}

// Writes the saved account only for the login that asked for it. `requestIdentity`
// is homeIdentityKey of the token captured BEFORE the /auth/me request left;
// the write needs the token now in use AND the token in storage to carry the
// same identity, and the returned profile to be that token's customer. A
// response that outlived a login change (another tab's new login adopted by a
// token refresh) writes nothing, so customer A's name and address can never be
// saved under B's identity.
export function writeHomeSnapshot({ token, requestIdentity, me, propertyPayload }) {
  const identity = homeIdentityKey(token);
  const properties = snapshotProperties(propertyPayload);
  if (!snapshotEligible(me)) {
    clearHomeSnapshot();
    return false;
  }
  const payload = tokenPayload(token);
  if (!identity || !properties || identity !== requestIdentity || identity !== storedHomeIdentity()
    || String(payload?.customerId) !== String(me?.id)) return false;
  writeEntry(HOME_SNAPSHOT_KEY, {
    v: HOME_STORE_VERSION, identity, savedAt: Date.now(), customer: snapshotCustomer(me), properties,
  });
  return true;
}

// The saved account for this token, or null. Never throws.
export function readHomeSnapshot(token) {
  const entry = readEntry(HOME_SNAPSHOT_KEY);
  if (!entryUsable(entry, homeIdentityKey(token))) {
    if (entry) clearHomeSnapshot();
    return null;
  }
  if (!entry.customer || !entry.properties || !snapshotEligible(entry.customer) || entry.customer.id == null) {
    clearHomeSnapshot();
    return null;
  }
  return { customer: entry.customer, properties: entry.properties, savedAt: entry.savedAt };
}

// ---- Saved home reads -----------------------------------------------------

const VISIT_FIELDS = ['id', 'serviceType', 'type', 'date', 'windowStart', 'day_only', 'arrival_note', 'customerPickBy'];
const pickVisit = (visit) => {
  if (!visit || typeof visit !== 'object') return null;
  const shaped = pick(visit, VISIT_FIELDS);
  if (!shaped.windowStart && !Object.prototype.hasOwnProperty.call(shaped, 'customerPickBy')) {
    shaped.customerPickBy = null;
  }
  return shaped;
};

const isLegacyWindowlessNextVisit = (key, data) => (
  key === 'next-visit'
  && !!data?.next
  && !data.next.windowStart
  && !data.next.day_only
  && !Object.prototype.hasOwnProperty.call(data.next, 'customerPickBy')
);

// The saved card prints a visit's name, day and arrival window and nothing
// else, so that is all a read keeps: no report or calendar links, no amounts.
const READ_SHAPES = {
  'next-visit': (data) => ({ propertyScope: data?.propertyScope ?? null, next: pickVisit(data?.next) }),
  'latest-service': (data) => ({
    propertyScope: data?.propertyScope ?? null,
    services: Array.isArray(data?.services) ? data.services.slice(0, 1).map(pickVisit).filter(Boolean) : [],
  }),
};

// The saved reads for this login and property, as { key: { data, updatedAt } }.
// An entry for any other login or property is deleted on the spot.
export function readHomeReads(identity, property) {
  const entry = readEntry(HOME_READS_KEY);
  if (!entry) return {};
  if (!entryUsable(entry, identity) || entry.property !== property || !entry.reads || typeof entry.reads !== 'object') {
    clearHomeReads();
    return {};
  }
  const out = {};
  for (const key of SAVED_READ_KEYS) {
    const read = entry.reads[key];
    const age = read ? Date.now() - Number(read.updatedAt) : NaN;
    if (read && read.data !== undefined && !isLegacyWindowlessNextVisit(key, read.data) && age >= -CLOCK_SKEW_MS && age <= HOME_STORE_MAX_AGE_MS) {
      out[key] = { data: read.data, updatedAt: Number(read.updatedAt) };
    }
  }
  return out;
}

export function writeHomeRead(identity, property, key, data, updatedAt) {
  if (!identity || !property || !SAVED_READ_KEYS.includes(key)) return;
  // A late response after sign-out or a login change must not write at all.
  if (storedHomeIdentity() !== identity) return;
  const entry = readEntry(HOME_READS_KEY);
  const same = entryUsable(entry, identity) && entry.property === property && entry.reads && typeof entry.reads === 'object';
  writeEntry(HOME_READS_KEY, {
    v: HOME_STORE_VERSION,
    identity,
    property,
    savedAt: Date.now(),
    reads: { ...(same ? entry.reads : {}), [key]: { data: READ_SHAPES[key](data), updatedAt } },
  });
}
