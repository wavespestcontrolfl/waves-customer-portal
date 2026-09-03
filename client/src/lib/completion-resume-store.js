// Durable store for the EXACT body of a committed completion whose side
// effects still owe a resume (CompletionPanel in SchedulePage.jsx).
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

function indexedDbFactory() {
  try {
    return typeof indexedDB !== "undefined" ? indexedDB : null;
  } catch {
    return null;
  }
}

function openDb() {
  return new Promise((resolve) => {
    const factory = indexedDbFactory();
    if (!factory) return resolve(null);
    let request;
    try {
      request = factory.open(DB_NAME, DB_VERSION);
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
function withStore(mode, fallback, run) {
  return openDb().then((db) => {
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
  return withStore("readwrite", false, (store) => store.put({ body, storedAt: now }, String(serviceId)))
    .then((result) => result !== false);
}

export function getCompletionResumeBody(serviceId) {
  if (!serviceId) return Promise.resolve(null);
  return withStore("readonly", null, (store) => store.get(String(serviceId)))
    .then((row) => (row && typeof row.body === "object" && row.body ? row.body : null));
}

export function deleteCompletionResumeBody(serviceId) {
  if (!serviceId) return Promise.resolve(false);
  return withStore("readwrite", false, (store) => store.delete(String(serviceId)))
    .then((result) => result !== false);
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
  const rowFor = (key) => withStore("readonly", null, (store) => store.get(key));
  return withStore("readonly", [], (store) => store.getAllKeys())
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
