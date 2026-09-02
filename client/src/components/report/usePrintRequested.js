// True once the browser has begun printing the live page (Cmd+P, the report
// action bar's window.print()). The V2 report primitives gate their draw-in /
// count-up on scrolling into view; without this, any ring the customer never
// reached printed as 0 with an empty arc. The `print` PrintContext prop only
// covers the ?mode=pdf/static renders, not the @media print pass over the live
// page — this hook covers that pass.
//
// flushSync is the documented React pattern for beforeprint: the DOM has to
// reflect the settled state before the browser snapshots it, and a normally
// scheduled render would land too late. Latched for the life of the page
// (no afterprint reset) so nothing un-fills or replays after the dialog
// closes.
import { useEffect, useState } from 'react';
import { flushSync } from 'react-dom';

export function usePrintRequested() {
  const [requested, setRequested] = useState(false);
  useEffect(() => {
    if (requested || typeof window === 'undefined') return undefined;
    const onBeforePrint = () => flushSync(() => setRequested(true));
    window.addEventListener('beforeprint', onBeforePrint);
    return () => window.removeEventListener('beforeprint', onBeforePrint);
  }, [requested]);
  return requested;
}
