/**
 * Two-button payment preference picker. Only rendered after a slot is
 * selected. Clicking either triggers the /reserve → confirm → /accept
 * flow; the orchestrator handles the state transitions.
 */
const W = {
  blue: '#065A8C', blueBright: '#009CDE', blueDeeper: '#1B2C5B',
  yellow: '#FFD700', yellowHover: '#FFF176',
  navy: '#0F172A', textBody: '#334155', textCaption: '#64748B',
  white: '#FFFFFF', border: '#CBD5E1',
};

export default function PaymentPreferenceButtons({ onSelect, disabled }) {
  const btnBase = {
    padding: '16px 20px', borderRadius: 12,
    fontSize: 15, fontWeight: 600,
    cursor: disabled ? 'wait' : 'pointer',
    border: 'none', textAlign: 'center', width: '100%',
    opacity: disabled ? 0.65 : 1,
  };

  return (
    <div style={{
      background: W.white, borderRadius: 16, padding: 24,
      border: `1px solid ${W.border}`, marginBottom: 16,
    }}>
      <div style={{ fontSize: 13, fontWeight: 600, color: W.textCaption,
        textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 14 }}>
        Reserve your spot
      </div>

      <div style={{ display: 'grid', gap: 10 }}>
        <button
          type="button"
          disabled={disabled}
          onClick={() => onSelect('deposit_now')}
          style={{ ...btnBase, background: W.blueBright, color: W.white }}
        >
          Reserve + pay deposit now
        </button>
        <button
          type="button"
          disabled={disabled}
          onClick={() => onSelect('pay_at_visit')}
          style={{ ...btnBase, background: W.yellow, color: W.navy }}
        >
          Reserve + pay at visit
        </button>
      </div>

      <div style={{ fontSize: 12, color: W.textCaption, marginTop: 12, lineHeight: 1.5 }}>
        You'll only be charged on service day unless you pick "pay deposit now."
      </div>
    </div>
  );
}
