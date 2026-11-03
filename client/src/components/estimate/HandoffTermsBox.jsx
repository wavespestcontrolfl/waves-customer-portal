/**
 * Estimate terms box for the secure card page in hand-off mode (Book at the Table,
 * owner 2026-11-02). The booking was accepted by staff, which records no terms, so
 * the customer ticks "I accept estimate {ref} and its terms" on the owner's phone and
 * the record matches an online accept. `terms` is the server's handoff.terms:
 * { estimateRef, version, scope, lines }. The lines are
 * shown verbatim; the page owns the checkbox state and the Save gate. The Florida
 * notice line (informational, signed separately) is rendered by the page, not here.
 */
import { useState } from 'react';

const NAVY = '#04395E';
const BODY = '#3E5B73';

export default function HandoffTermsBox({ terms, checked, onChange, disabled = false }) {
  const [open, setOpen] = useState(false);
  if (!terms) return null;
  return (
    <div data-testid="handoff-terms" style={{ marginTop: 16, paddingTop: 14, borderTop: '1px solid rgba(4,57,94,0.18)', textAlign: 'left' }}>
      <label style={{ display: 'flex', gap: 10, alignItems: 'flex-start', cursor: 'pointer' }}>
        <input
          type="checkbox"
          checked={checked}
          onChange={(e) => onChange(e.target.checked)}
          disabled={disabled}
          style={{ marginTop: 3, width: 16, height: 16, flex: 'none' }}
        />
        <span style={{ fontSize: 14, color: NAVY, lineHeight: 1.5, fontWeight: 600 }}>
          {`I accept estimate ${terms.estimateRef} and its terms.`}
        </span>
      </label>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        style={{ background: 'none', border: 'none', padding: 0, marginTop: 8, marginLeft: 26, fontSize: 14, color: NAVY, textDecoration: 'underline', cursor: 'pointer' }}
      >
        {open ? 'Hide terms' : 'View terms'}
      </button>
      {open ? (
        <div style={{ fontSize: 14, color: BODY, lineHeight: 1.5, marginTop: 8, marginLeft: 26 }}>
          {terms.lines.map((line) => <p key={line} style={{ margin: '0 0 6px' }}>{line}</p>)}
        </div>
      ) : null}
    </div>
  );
}
