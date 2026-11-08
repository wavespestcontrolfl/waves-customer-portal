// GATE_DAY_ONLY_PROMISE part E: the "Customer asked for this time" box and the "Told: ..." badge for the windows that
// use inline styles and a `D` palette (New Appointment, Edit appointment). The Tier 1 windows build theirs from
// components/ui with the same words (dayOnlyPromise.js). The caller shows these only with the gate on.
import { ASKED_TIME_LABEL, askedTimeHint, toldBadgeText } from './dayOnlyPromise';

export function AskedTimeBoxLegacy({ id, checked, onChange, disabled = false, colors, style }) {
  const text = colors?.text || '#18181B';
  const muted = colors?.muted || '#71717A';
  const accent = colors?.teal || '#18181B';
  return (
    <div style={{ marginBottom: 10, ...style }}>
      <label htmlFor={id} style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: disabled ? 'default' : 'pointer', minHeight: 44 }}>
        <input
          id={id}
          type="checkbox"
          checked={checked === true}
          disabled={disabled}
          onChange={(e) => onChange(e.target.checked)}
          style={{ width: 18, height: 18, accentColor: accent }}
        />
        <span style={{ fontSize: 13, color: text }}>{ASKED_TIME_LABEL}</span>
      </label>
      <div data-testid="asked-time-hint" style={{ fontSize: 12, color: muted, marginTop: 2 }}>{askedTimeHint(checked)}</div>
    </div>
  );
}

export function ToldBadgeLegacy({ told, currentDate, colors, style }) {
  const text = toldBadgeText(told, currentDate);
  if (!text) return null;
  return (
    <span
      data-testid="told-badge"
      style={{
        display: 'inline-block', fontSize: 12, fontWeight: 500, padding: '2px 8px', borderRadius: 4,
        border: `1px solid ${colors?.border || '#E4E4E7'}`, color: colors?.text || '#18181B', ...style,
      }}
    >
      {text}
    </span>
  );
}
