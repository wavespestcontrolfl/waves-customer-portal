import React from 'react';
import { CloudRain, Sprout } from 'lucide-react';

// Live simple-web report only. The server adds `liveChip` (GATE_REPORT_WEB_LIVE_CHIP) and `programPromise`
// (GATE_REPORT_WEB_PROGRAM) to a live payload and nothing else ever carries them, so both render nothing otherwise.
// The words are the server's fixed sentences, shown as given. Nothing here is computed or sent.

const NAVY = '#04395E';
const INK = '#1F2933';
const STATE_LABEL = { ahead: 'Ahead', on_track: 'On track', behind: 'Behind' };
const STATE_COLOR = { ahead: '#0F7B54', on_track: NAVY, behind: '#A33B2E' };

function cardProps(glass) {
  return glass
    ? { 'data-glass': 'card' }
    : { style: { background: '#fff', border: '1px solid #D5DDE3', borderRadius: 12 } };
}

export function ReportLiveChip({ chip, glass = false }) {
  if (!chip || typeof chip.text !== 'string' || !chip.text) return null;
  const card = cardProps(glass);
  return (
    <div
      role="status"
      data-testid="report-live-chip"
      {...card}
      style={{ ...(card.style || {}), display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px', marginTop: 12, minWidth: 0, color: INK, fontSize: 16, lineHeight: 1.35 }}
    >
      <CloudRain size={20} color={NAVY} aria-hidden="true" style={{ flex: '0 0 auto' }} />
      <span style={{ minWidth: 0, overflowWrap: 'anywhere' }}>{chip.text}</span>
    </div>
  );
}

export function ReportProgramCard({ promise, glass = false }) {
  const items = Array.isArray(promise?.items) ? promise.items : [];
  if (!promise?.monthLine || !items.length) return null;
  const card = cardProps(glass);
  return (
    <section
      aria-label="Your lawn program"
      data-testid="report-program-card"
      {...card}
      style={{ ...(card.style || {}), padding: '12px 14px', marginTop: 12, minWidth: 0, color: INK }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 16, fontWeight: 700, color: NAVY }}>
        <Sprout size={20} aria-hidden="true" style={{ flex: '0 0 auto' }} />
        <span>{promise.monthLine}</span>
      </div>
      <ul style={{ listStyle: 'none', margin: '8px 0 0', padding: 0, display: 'grid', gap: 6 }}>
        {items.map((item) => (
          <li key={item.key} style={{ display: 'flex', alignItems: 'baseline', gap: 8, fontSize: 16, lineHeight: 1.35, minWidth: 0 }}>
            <span
              style={{ flex: '0 0 auto', minWidth: 86, padding: '1px 8px', borderRadius: 999, border: `1px solid ${STATE_COLOR[item.state] || NAVY}`, color: STATE_COLOR[item.state] || NAVY, fontSize: 14, fontWeight: 700, textAlign: 'center' }}
            >{STATE_LABEL[item.state] || item.state}</span>
            <span style={{ minWidth: 0, overflowWrap: 'anywhere' }}>{item.sentence}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

// Live-only, like the floating Ask Waves bar and the action bar: the PDF has neither card, so a customer pressing
// Print on the live view must not get them on paper either.
const PRINT_SHEET = '@media print { .web-live-only { display: none !important; } }';

export default function WebPromiseCards({ data, glass = false }) {
  if (!data || (!data.liveChip && !data.programPromise)) return null;
  return (
    <div className="sr-shell web-live-only" data-live-only="true" style={{ maxWidth: 760, margin: '0 auto', padding: '0 16px' }}>
      <style>{PRINT_SHEET}</style>
      <ReportLiveChip chip={data.liveChip} glass={glass} />
      <ReportProgramCard promise={data.programPromise} glass={glass} />
    </div>
  );
}
