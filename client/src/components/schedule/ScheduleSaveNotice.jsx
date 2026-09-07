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
// outcome. Multiple successful steps accumulate until the operator dismisses.
export function showScheduleSaveNotice(message) {
  messages = [...new Set([...messages, message])];
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
        {notices.map((message) => <p key={message}>{message}</p>)}
      </div>
      <Button className="mt-3 min-h-11 text-sm" onClick={() => {
        messages = [];
        listeners.forEach((listener) => listener());
      }}>Dismiss notices</Button>
    </aside>, document.body,
  );
}
