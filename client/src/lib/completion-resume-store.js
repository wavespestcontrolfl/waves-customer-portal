// Durable completion storage: exact committed retry bodies and unsubmitted
// drafts (including photos), using the same IndexedDB transaction adapter.
// Drafts have a separate database: an older open tab prunes every unmarked
// committed-body key, so putting drafts there would let it delete new photos.
// The committed database stays at version 1 for existing browser/native clients.
//
// Why IndexedDB and not localStorage: the committed body carries up to five
// base64 completion photos (~1.5 MB each), which the ~5 MB localStorage
// origin quota cannot hold — that is why the body was never persisted and a
// panel reopened after a reload rebuilt it, 409ing
// completion_resume_payload_mismatch with the report/completion text still
// unsent. The reopen MARKER stays in localStorage (DispatchPageV2 reads it
// synchronously); only the body lives here.
//
// Every call is best-effort and never throws: an environment without
// IndexedDB (or a failing one) resolves null / false, which leaves today's
// behavior — marker only, mismatch on retry → Billing Recovery.

const DB_NAME = "waves-completion-resume";
const STORE = "bodies";
const DB_VERSION = 1;
const DRAFT_DB_NAME = "waves-completion-drafts";
const draftOperations = new Map();

// Drafts are private field work: photos, captions and notes a technician
// has not submitted. On a shared tablet or browser profile the next operator
// signing in must not be offered them, so every draft row is keyed by the
// signed-in admin's id (`scope`) as well as the service (Codex P2). A
// missing scope (no stored profile) shares one anonymous bucket.
export function completionDraftScopeKey(serviceId, scope) {
  return `${scope ? String(scope) : "anonymous"}:${String(serviceId)}`;
}

// A draft nobody has reopened for this long is abandoned: the visit was
// cancelled, removed, or closed out elsewhere. Rows are otherwise deleted
// only by that exact service's discard/complete, so without a sweep the
// multi-megabyte photo rows would accumulate until the origin's IndexedDB
// quota starves active drafts of photo durability (Codex P2).
export const DRAFT_RETENTION_MS = 14 * 24 * 60 * 60 * 1000;

function indexedDbFactory() {
  try {
    return typeof indexedDB !== "undefined" ? indexedDB : null;
  } catch {
    return null;
  }
}

function openDb(dbName) {
  return new Promise((resolve) => {
    const factory = indexedDbFactory();
    if (!factory) return resolve(null);
    let request;
    try {
      request = factory.open(dbName, DB_VERSION);
    } catch {
      return resolve(null);
    }
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
    request.onblocked = () => resolve(null);
  });
}

// Runs one operation inside a transaction on the bodies store and resolves
// the request result, or `fallback` on any failure. The db handle is closed
// when the transaction settles so a later open never blocks on it.
function withStore(dbName, mode, fallback, run) {
  return openDb(dbName).then((db) => {
    if (!db) return fallback;
    return new Promise((resolve) => {
      let settled = false;
      const done = (value) => {
        if (settled) return;
        settled = true;
        try { db.close(); } catch { /* ignore */ }
        resolve(value);
      };
      try {
        const tx = db.transaction(STORE, mode);
        const request = run(tx.objectStore(STORE));
        let result = fallback;
        request.onsuccess = () => { result = request.result; };
        request.onerror = () => done(fallback);
        tx.oncomplete = () => done(result);
        tx.onerror = () => done(fallback);
        tx.onabort = () => done(fallback);
      } catch {
        done(fallback);
      }
    });
  });
}

// Rows are { body, storedAt }: storedAt lets the prune below leave a row
// alone while its marker write may still be in flight in another tab.
export function putCompletionResumeBody(serviceId, body, now = Date.now()) {
  if (!serviceId || !body || typeof body !== "object") return Promise.resolve(false);
  return withStore(DB_NAME, "readwrite", false, (store) => store.put({ body, storedAt: now }, String(serviceId)))
    .then((result) => result !== false);
}

export function getCompletionResumeBody(serviceId) {
  if (!serviceId) return Promise.resolve(null);
  return withStore(DB_NAME, "readonly", null, (store) => store.get(String(serviceId)))
    .then((row) => (row && typeof row.body === "object" && row.body ? row.body : null));
}

export function deleteCompletionResumeBody(serviceId) {
  if (!serviceId) return Promise.resolve(false);
  return withStore(DB_NAME, "readwrite", false, (store) => store.delete(String(serviceId)))
    .then((result) => result !== false);
}

// Order draft writes, reads and deletes across panel mounts. In particular,
// a late autosave must never resurrect a discarded or completed draft.
function withDraftKey(key, operation) {
  const pending = (draftOperations.get(key) || Promise.resolve()).then(() => operation(key));
  draftOperations.set(key, pending);
  void pending.finally(() => {
    if (draftOperations.get(key) === pending) draftOperations.delete(key);
  });
  return pending;
}

function withDraft(serviceId, scope, operation) {
  return withDraftKey(completionDraftScopeKey(serviceId, scope), operation);
}

// Rows are { draft, storedAt, serviceId, scope }: storedAt ages the row for
// the retention sweep independently of the draft's own fields; serviceId
// and scope let the sweep report what it removed.
export function putCompletionDraft(serviceId, draft, scope, now = Date.now()) {
  const row = { draft, storedAt: now, serviceId: String(serviceId), scope: scope ? String(scope) : "" };
  return withDraft(serviceId, scope, (key) => withStore(DRAFT_DB_NAME, "readwrite", false, (store) => store.put(row, key)))
    .then((result) => result !== false);
}

export function getCompletionDraft(serviceId, scope) {
  return withDraft(serviceId, scope, (key) => withStore(DRAFT_DB_NAME, "readonly", null, (store) => store.get(key)))
    .then((row) => (row && typeof row.draft === "object" && row.draft ? row.draft : null));
}

export function deleteCompletionDraft(serviceId, scope) {
  return withDraft(serviceId, scope, (key) => withStore(DRAFT_DB_NAME, "readwrite", false, (store) => store.delete(key)))
    .then((result) => result !== false);
}

// Visit closeout forms are unsubmitted field drafts too. Keep them in the
// draft database so an older open CompletionPanel tab, whose committed-body
// pruner knows nothing about visit keys, cannot delete them as unmarked
// completion retries. Namespace the scope while retaining the signed-in
// operator id so a shared browser never restores one technician's visit forms
// for the next technician.
function visitDraftScope(operatorScope) {
  return `visit:${operatorScope ? String(operatorScope) : "anonymous"}`;
}

export function putVisitCompletionDraft(visitId, draft, operatorScope, now = Date.now()) {
  return putCompletionDraft(visitId, draft, visitDraftScope(operatorScope), now);
}

export function getVisitCompletionDraft(visitId, operatorScope) {
  return getCompletionDraft(visitId, visitDraftScope(operatorScope));
}

export function deleteVisitCompletionDraft(visitId, operatorScope) {
  return deleteCompletionDraft(visitId, visitDraftScope(operatorScope));
}

// Deletes every draft row older than `maxAgeMs` across all scopes and
// resolves the [{ serviceId, scope }] it removed so the caller can drop the
// matching localStorage metadata. Each row's age check and delete are
// ordered behind that draft's in-flight writes, so a panel refreshing an
// old draft right now is re-read after its refresh and kept.
export function pruneCompletionDrafts(now = Date.now(), maxAgeMs = DRAFT_RETENTION_MS) {
  return withStore(DRAFT_DB_NAME, "readonly", [], (store) => store.getAllKeys())
    .then((keys) => Promise.all(
      (Array.isArray(keys) ? keys : []).map((key) => withDraftKey(String(key), (k) => (
        withStore(DRAFT_DB_NAME, "readonly", null, (store) => store.get(k)).then((row) => {
          if (!row || now - Number(row.storedAt || 0) < maxAgeMs) return null;
          return withStore(DRAFT_DB_NAME, "readwrite", false, (store) => store.delete(k))
            .then((result) => (result === false ? null : { serviceId: row.serviceId, scope: row.scope }));
        })
      ))),
    ))
    .then((results) => results.filter(Boolean));
}

// A row younger than this is never pruned: persistCompletionResumeOwed
// writes the body and THEN the marker, so a sibling tab mounting a panel
// in between would otherwise see an un-owed row and delete it, leaving the
// marker-without-body state the store exists to prevent (Codex r4 P2).
// Far longer than the write→marker gap; far shorter than a real orphan's
// life (it is pruned by the next mount after the window).
export const PRUNE_GRACE_MS = 5 * 60 * 1000;

// Removes every stored body whose marker is gone. The success paths clear
// the marker synchronously but the body delete is asynchronous, so a page
// killed in between leaves an unreachable multi-megabyte row behind; run
// once when a completion panel mounts so those rows never accumulate
// (Codex r3 P2). `isOwed(serviceId)` is the marker predicate.
export function pruneCompletionResumeBodies(isOwed, now = Date.now()) {
  const rowFor = (key) => withStore(DB_NAME, "readonly", null, (store) => store.get(key));
  return withStore(DB_NAME, "readonly", [], (store) => store.getAllKeys())
    .then((keys) => Promise.all(
      (Array.isArray(keys) ? keys : [])
        .map((key) => String(key))
        .filter((key) => !isOwed(key))
        .map((key) => rowFor(key).then((row) => (
          row && now - Number(row.storedAt || 0) < PRUNE_GRACE_MS
            ? false
            : deleteCompletionResumeBody(key)
        ))),
    ))
    .then((results) => results.filter(Boolean).length);
}
