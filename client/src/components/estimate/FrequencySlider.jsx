/**
 * Frequency picker — white clickable option boxes (Quarterly /
 * Bi-monthly / Monthly), one per engine-supported pest cadence, matching
 * the preference-toggle rows' inner-box treatment. The selected option
 * inverts to navy, same as the slot-picker cards. Replaces the earlier
 * rail slider (owner directive 2026-07-03).
 *
 * Native buttons: Tab/Enter/Space accessible, aria-pressed carries the
 * selection for assistive tech.
 */
import { estimateInnerBox } from './cardStyles';

const W = {
  blueDeeper: '#1B2C5B',
  textCaption: '#64748B',
  white: '#FFFFFF',
};

export default function FrequencySlider({ frequencies, selected, onChange, disabled = false }) {
  if (!frequencies || frequencies.length === 0) return null;

  return (
    <div
      role="group"
      aria-label="Service frequency"
      style={{ padding: '0 0 6px', marginBottom: 8, opacity: disabled ? 0.68 : 1 }}
    >
      <div style={{
        fontSize: 13, fontWeight: 600, color: W.textCaption,
        textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 12,
      }}>
        How often?
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: 10 }}>
        {frequencies.map((frequency) => {
          const active = frequency.key === selected;
          return (
            <button
              key={frequency.key}
              type="button"
              aria-label={`${frequency.label} frequency`}
              aria-pressed={active}
              disabled={disabled}
              onClick={() => { if (!disabled) onChange(frequency.key); }}
              style={{
                ...estimateInnerBox(),
                padding: '14px 12px',
                textAlign: 'center',
                fontSize: 15,
                fontWeight: 700,
                lineHeight: 1.2,
                color: active ? W.white : W.blueDeeper,
                background: active ? W.blueDeeper : W.white,
                border: `2px solid ${active ? W.blueDeeper : '#D9D3C4'}`,
                cursor: disabled ? 'default' : 'pointer',
                transition: 'background 160ms ease, color 160ms ease, border-color 160ms ease',
              }}
            >
              {frequency.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
