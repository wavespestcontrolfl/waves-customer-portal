import { useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { Button } from '../ui';

let messages = [];
const listeners = new Set();
const subscribe = (listener) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
const snapshot = () => messages;

// Lives in the admin shell so closing an appointment cannot hide its saved
// outcome. Every save event accumulates until the operator dismisses — two
// saves with identical text (two moves on one date returning the same overlap
// warning) are two outcomes, so notices are keyed by event, never deduped by
// message text (Codex #4091 P2).
let nextNoticeId = 0;
export function showScheduleSaveNotice(message) {
  nextNoticeId += 1;
  messages = [...messages, { id: nextNoticeId, message }];
  listeners.forEach((listener) => listener());
}

// Session boundary: logout is an SPA navigation, so this module (and its
// undismissed notices) outlives the account that produced them. The next
// operator signing in on the same tab must not inherit warnings about
// outcomes they did not perform (Codex #4091 P2). Nested admin route changes
// never call this — only the logout handlers do.
export function clearScheduleSaveNotices() {
  if (!messages.length) return;
  messages = [];
  listeners.forEach((listener) => listener());
}

export default function ScheduleSaveNotice() {
  const notices = useSyncExternalStore(subscribe, snapshot);
  if (!notices.length) return null;
  return createPortal(
    <aside aria-label="Schedule save notices"
      style={{ bottom: 'calc(80px + env(safe-area-inset-bottom, 0px))' }}
      className="fixed right-4 z-[11000] box-border w-[360px] max-w-[calc(100%-2rem)] rounded-sm border-hairline border-zinc-300 bg-white p-4 font-sans text-sm text-zinc-900 shadow-lg">
      <div role="status" className="max-h-[35dvh] overflow-y-auto whitespace-pre-line space-y-3">
        {notices.map(({ id, message }) => <p key={id}>{message}</p>)}
      </div>
      <Button className="mt-3 min-h-11 text-sm" onClick={clearScheduleSaveNotices}>Dismiss notices</Button>
    </aside>, document.body,
  );
}
