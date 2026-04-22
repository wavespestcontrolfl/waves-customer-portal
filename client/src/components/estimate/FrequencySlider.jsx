/**
 * 3-stop frequency slider — Quarterly / Bi-monthly / Monthly.
 *
 * Engine supports exactly these three pest frequencies today; every_6_weeks
 * + one-time-as-pest-frequency land in follow-up PRs (Waves needs to decide
 * discount numbers). One-time items render elsewhere when present.
 *
 * Default selection is Quarterly — WaveGuard Bronze anchor, most common
 * close. Intentionally not "the middle position"; anchoring to actual
 * preferred close matters more than positional symmetry.
 */
const W = {
  blue: '#065A8C', blueBright: '#009CDE', blueDeeper: '#1B2C5B',
  navy: '#0F172A', textBody: '#334155', textCaption: '#64748B',
  white: '#FFFFFF', offWhite: '#F1F5F9', border: '#CBD5E1',
};

export default function FrequencySlider({ frequencies, selected, onChange }) {
  if (!frequencies || frequencies.length === 0) return null;

  return (
    <div style={{
      background: W.white, borderRadius: 16, padding: '20px 16px',
      border: `1px solid ${W.border}`, marginBottom: 16,
    }}>
      <div style={{ fontSize: 13, fontWeight: 600, color: W.textCaption,
        textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 12 }}>
        How often?
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: `repeat(${frequencies.length}, 1fr)`, gap: 8 }}>
        {frequencies.map((f) => {
          const isActive = f.key === selected;
          return (
            <button
              key={f.key}
              type="button"
              onClick={() => onChange(f.key)}
              style={{
                padding: '14px 8px',
                background: isActive ? W.blueBright : W.offWhite,
                color: isActive ? W.white : W.navy,
                border: `2px solid ${isActive ? W.blueBright : W.border}`,
                borderRadius: 12, cursor: 'pointer',
                fontSize: 15, fontWeight: 600,
                transition: 'all 150ms ease',
                minHeight: 56,
              }}
            >{f.label}</button>
          );
        })}
      </div>
    </div>
  );
}
