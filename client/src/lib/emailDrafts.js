// Local editor recovery only. Gmail drafts and the server's SMS approval queue
// have different owners and send semantics; neither stores unsent portal edits.
const STORAGE_KEY = "waves_admin_email_drafts_v1";
const emptyDrafts = () => ({ compose: { to: "", subject: "", body: "" }, replies: {} });
let activeSession = null;

export function loadEmailDrafts(userId) {
  if (activeSession?.userId === userId) return activeSession;
  let drafts = emptyDrafts();
  try {
    const stored = JSON.parse(sessionStorage.getItem(STORAGE_KEY) || "null");
    if (userId && stored?.userId === userId) {
      const compose = stored.drafts?.compose;
      if ([compose?.to, compose?.subject, compose?.body].every((value) => typeof value === "string")) {
        drafts.compose = { to: compose.to, subject: compose.subject, body: compose.body };
      }
      drafts.replies = Object.fromEntries(Object.entries(stored.drafts?.replies || {})
        .filter(([id, value]) => id && typeof value === "string" && value));
    }
  } catch { /* An unavailable/corrupt store must not prevent opening the inbox. */ }
  activeSession = { userId, drafts, saved: true, listeners: new Set() };
  return activeSession;
}

export function updateEmailDrafts(session, update) {
  // A late send/AI response from an unmounted or signed-out account must not
  // resurrect that account's edits after another account has opened the inbox.
  if (session !== activeSession || !session.userId) return null;
  session.drafts = update(session.drafts);
  let saved = true;
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ userId: session.userId, drafts: session.drafts }));
  } catch {
    // Keep SPA navigation recoverable even when browser storage is unavailable.
    // The editor reports this failure and warns before a destructive reload.
    saved = false;
  }
  session.saved = saved;
  for (const notify of session.listeners) notify();
  return { drafts: session.drafts, saved };
}

export function subscribeEmailDrafts(session, listener) {
  session.listeners.add(listener);
  return () => session.listeners.delete(listener);
}

export function clearEmailDrafts() {
  activeSession = null;
  try { sessionStorage.removeItem(STORAGE_KEY); } catch { /* storage unavailable */ }
}
