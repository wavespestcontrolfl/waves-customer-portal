// The composer's note when a greeting uses another listed spelling of the customer's first name:
// "Hi Sarah," to a record that says Sara shows "Record says Sara" and a one-tap fix. The server does
// the spelling check (POST /admin/communications/name-check); this file only asks, shows, and
// applies. It changes nothing unless the user taps the fix, and it never blocks Send.
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "../ui";
import { adminFetch } from "../../utils/admin-fetch";

const CHECK_DELAY_MS = 400;
const MAX_CHECK_CHARS = 2000; // the server answers 400 above this

// check(customerId, text): the last answer with fixes, or null.
//   result = { customerId, checkedText, fixes, text }  (text = the server's fixed text)
export function useGreetingNameCheck({ customerId, text, setText }) {
  const [result, setResult] = useState(null);
  const abortRef = useRef(null);
  const textRef = useRef(text);
  textRef.current = text;

  const runCheck = useCallback(async (id, body) => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const data = await adminFetch("/admin/communications/name-check", {
        method: "POST",
        body: JSON.stringify({ customer_id: id, text: body }),
        signal: controller.signal,
      });
      if (controller.signal.aborted) return; // a newer check replaced this one
      const fixes = Array.isArray(data?.fixes) ? data.fixes : [];
      setResult(fixes.length && typeof data.text === "string"
        ? { customerId: id, checkedText: body, fixes, text: data.text }
        : null);
    } catch {
      // A failed check shows nothing new: the note is a courtesy and Send never waits on it.
    }
  }, []);

  useEffect(() => {
    if (!customerId || !text || !text.trim() || text.length > MAX_CHECK_CHARS) {
      setResult(null);
      return undefined;
    }
    const timer = setTimeout(() => runCheck(customerId, text), CHECK_DELAY_MS);
    return () => {
      clearTimeout(timer);
      abortRef.current?.abort();
    };
  }, [customerId, text, runCheck]);

  // The note belongs to one customer; a switch hides it at once.
  const current = result && result.customerId === customerId ? result : null;

  const applyFix = useCallback(() => {
    if (!current) return;
    if (textRef.current === current.checkedText) {
      setText(current.text);
      setResult(null);
    } else if (customerId) {
      runCheck(customerId, textRef.current); // the text moved on since the check: ask again
    }
  }, [current, customerId, runCheck, setText]);

  return { fix: current, applyFix };
}

export default function GreetingNameNote({ check }) {
  const fix = check?.fix;
  if (!fix) return null;
  const spelled = [...new Set(fix.fixes.map((f) => f.spelled))].join(" and ");
  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="greeting-name-note"
      className="mt-2 flex flex-wrap items-center justify-between gap-2 rounded-sm border-hairline border-zinc-300 bg-zinc-50 px-3 py-2 text-14 text-zinc-900"
    >
      <span>Record says {spelled}</span>
      <Button size="sm" variant="secondary" onClick={check.applyFix}>Change to {spelled}</Button>
    </div>
  );
}
