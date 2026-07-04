/**
 * Frequency picker — for two cadences, white clickable option boxes
 * matching the preference-toggle rows' inner-box treatment (selected
 * option inverts to navy, same as the slot-picker cards). Three or more
 * cadences (pest Quarterly/Bi-monthly/Monthly, lawn's four programs)
 * render as a native dropdown instead so the options never wrap into a
 * ragged grid on phones (owner directive 2026-07-04). Replaces the
 * earlier rail slider (owner directive 2026-07-03).
 *
 * Native buttons/select: Tab/Enter/Space accessible, aria-pressed
 * carries the button selection for assistive tech.
 */
import { estimateInnerBox } from './cardStyles';

const W = {
  blueDeeper: '#1B2C5B',
  textCaption: '#64748B',
  white: '#FFFFFF',
};

const DROPDOWN_THRESHOLD = 3;

// Navy chevron for the appearance-reset <select>.
const CHEVRON = `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='16' viewBox='0 0 16 16'%3E%3Cpath fill='none' stroke='%231B2C5B' stroke-width='2' stroke-linecap='round' stroke-linejoin='round' d='M4 6l4 4 4-4'/%3E%3C/svg%3E")`;

export default function FrequencySlider({ frequencies, selected, onChange, disabled = false }) {
  if (!frequencies || frequencies.length === 0) return null;

  const useDropdown = frequencies.length >= DROPDOWN_THRESHOLD;
  const selectedKey = frequencies.some((frequency) => frequency.key === selected)
    ? selected
    : frequencies[0].key;

  return (
    <div
      role={useDropdown ? undefined : 'group'}
      aria-label={useDropdown ? undefined : 'Service frequency'}
      style={{ padding: '0 0 6px', marginBottom: 8, opacity: disabled ? 0.68 : 1 }}
    >
      <div style={{
        fontSize: 13, fontWeight: 600, color: W.textCaption,
        textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 12,
      }}>
        How often?
      </div>

      {useDropdown ? (
        <select
          aria-label="Service frequency"
          value={selectedKey}
          disabled={disabled}
          onChange={(e) => { if (!disabled) onChange(e.target.value); }}
          style={{
            ...estimateInnerBox(),
            display: 'block',
            width: '100%',
            boxSizing: 'border-box',
            padding: '14px 44px 14px 14px',
            fontSize: 15,
            fontWeight: 700,
            fontFamily: 'inherit',
            lineHeight: 1.2,
            color: W.blueDeeper,
            border: `2px solid #D9D3C4`,
            cursor: disabled ? 'default' : 'pointer',
            appearance: 'none',
            WebkitAppearance: 'none',
            MozAppearance: 'none',
            backgroundImage: CHEVRON,
            backgroundRepeat: 'no-repeat',
            backgroundPosition: 'right 14px center',
          }}
        >
          {frequencies.map((frequency) => (
            <option key={frequency.key} value={frequency.key}>
              {frequency.label}
            </option>
          ))}
        </select>
      ) : (
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
      )}
    </div>
  );
}
