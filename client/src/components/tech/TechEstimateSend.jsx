import { useRef, useState } from 'react';
import { techEstimateRequest } from './useTechEstimates';
import { INK, s } from './techEstimateParts';

// The Send button of the technician estimate tool (GATE_TECH_ESTIMATES, step 4). A text to a customer cannot be taken
// back, so a tap only opens a confirm block; one request per "Send text", never retried from here. The estimate (and
// its canSend / needsTextRequest) comes from the server; this only asks and reports.

const UNKNOWN = 'The app cannot tell if the text went. Do not send it again. Ask the office to check.';
const RETRY = 'Something went wrong. Try again.';

// What a failed send means, as { text, keep, reread, gone }. `keep`: the Send button may stay (the estimate is still
// his to send); `reread`: the parent reads the estimate again; `gone`: it left his list.
function outcomeOf(err) {
  if (!err.status) return { text: UNKNOWN, reread: true, lock: true };
  if (err.status === 404) return { text: 'This estimate is no longer in your list.', gone: true };
  if (err.code === 'outside_hours') return { text: err.message, keep: true };
  if (['office_sends', 'office_first', 'already_sent'].includes(err.code)) return { text: err.message, reread: true };
  if (err.status >= 500) return { text: UNKNOWN, reread: true, lock: true };
  return { text: err.message || RETRY, keep: true };
}

// onOutcome({ text, ok?, keep?, reread?, gone?, lock? }) tells the parent what to show and read next.
export default function TechEstimateSend({ id, who, needsTextRequest, onOutcome }) {
  const [confirming, setConfirming] = useState(false);
  const [asked, setAsked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [needsBox, setNeedsBox] = useState(false);
  const inFlight = useRef(false);
  const box = needsTextRequest || needsBox;
  const name = who || 'the customer';
  const firstName = (who || '').trim().split(/\s+/)[0] || 'The person';

  const send = async () => {
    if (inFlight.current || (box && !asked)) return;
    inFlight.current = true;
    setBusy(true);
    try {
      await techEstimateRequest(`/${encodeURIComponent(id)}/send`, { method: 'POST', body: box ? { askedForText: true } : {} });
      setConfirming(false);
      onOutcome({ text: `Sent to ${name}.`, ok: true, reread: true });
    } catch (err) {
      if (err.code === 'needs_text_request') { setNeedsBox(true); return; }
      setConfirming(false);
      onOutcome(outcomeOf(err));
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };

  if (!confirming) {
    return <button type="button" style={s.primary} onClick={() => { setAsked(false); setConfirming(true); }}>Send to customer</button>;
  }
  return (
    <div style={s.card}>
      <p style={{ margin: '0 0 10px', fontSize: 16, fontWeight: 500, color: INK }}>Text this estimate to {name}?</p>
      {box && (
        <label style={{ display: 'flex', alignItems: 'flex-start', gap: 10, minHeight: 44, fontSize: 16, color: INK, marginBottom: 10 }}>
          <input type="checkbox" style={{ width: 20, height: 20, marginTop: 2 }} checked={asked} disabled={busy} onChange={(e) => setAsked(e.target.checked)} />
          {firstName} asked me to text this estimate.
        </label>
      )}
      <button type="button" style={{ ...s.primary, opacity: busy || (box && !asked) ? 0.5 : 1 }} disabled={busy || (box && !asked)} onClick={send}>
        {busy ? 'Sending…' : 'Send text'}
      </button>
      <button type="button" style={{ ...s.secondary, marginBottom: 0 }} disabled={busy} onClick={() => setConfirming(false)}>Not now</button>
    </div>
  );
}
