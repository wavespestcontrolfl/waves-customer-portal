// Local editor recovery only. Gmail drafts and the server's SMS approval queue
// have different owners and send semantics; neither stores unsent portal edits.
const STORAGE_KEY = "waves_admin_email_drafts_v1";
const emptyDrafts = () => ({ compose: { to: "", subject: "", body: "" }, replies: {} });
let activeSession = null;
const warnBeforeDraftUnload = (event) => { event.preventDefault(); event.returnValue = ""; };

function syncUnloadWarning(session) {
  const unsavedText = !session.saved && (Object.values(session.drafts.compose).some(Boolean)
    || Object.values(session.drafts.replies).some(Boolean));
  if (unsavedText || Object.values(session.sending).some(Boolean)) window.addEventListener("beforeunload", warnBeforeDraftUnload);
  else window.removeEventListener("beforeunload", warnBeforeDraftUnload);
}

export function loadEmailDrafts(userId) {
  if (activeSession?.userId === userId) return activeSession;
  window.removeEventListener("beforeunload", warnBeforeDraftUnload);
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
  activeSession = { userId, drafts, replyRevisions: {}, saved: true, sending: { compose: false, reply: false }, listeners: new Set() };
  return activeSession;
}

export function updateEmailDrafts(session, update) {
  // A late send/AI response from an unmounted or signed-out account must not
  // resurrect that account's edits after another account has opened the inbox.
  if (session !== activeSession || !session.userId) return null;
  const previousReplies = session.drafts.replies;
  session.drafts = update(session.drafts);
  // Text can change and then return to its original value while a request is
  // pending. Track edits per message so late AI/send results respect that edit.
  for (const id of new Set([...Object.keys(previousReplies), ...Object.keys(session.drafts.replies)])) {
    if (previousReplies[id] !== session.drafts.replies[id]) session.replyRevisions[id] = (session.replyRevisions[id] || 0) + 1;
  }
  let saved = true;
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ userId: session.userId, drafts: session.drafts }));
  } catch {
    // Keep SPA navigation recoverable even when browser storage is unavailable.
    // The editor reports this failure and warns before a destructive reload.
    saved = false;
    // A quota failure must not leave a previously saved, now-sent/discarded
    // draft available to recover. Removal needs no additional storage space.
    try { sessionStorage.removeItem(STORAGE_KEY); } catch { /* storage unavailable */ }
  }
  session.saved = saved;
  syncUnloadWarning(session);
  for (const notify of session.listeners) notify();
  return { drafts: session.drafts, saved };
}

export function subscribeEmailDrafts(session, listener) {
  session.listeners.add(listener);
  return () => session.listeners.delete(listener);
}

export function setEmailSending(session, kind, sending) {
  if (session !== activeSession || !session.userId || session.sending[kind] === sending) return false;
  session.sending[kind] = sending;
  // Both pending sends and memory-only drafts outlive the editor's route.
  syncUnloadWarning(session);
  for (const notify of session.listeners) notify();
  return true;
}

export function clearEmailDrafts() {
  activeSession = null;
  window.removeEventListener("beforeunload", warnBeforeDraftUnload);
  try { sessionStorage.removeItem(STORAGE_KEY); } catch { /* storage unavailable */ }
}
