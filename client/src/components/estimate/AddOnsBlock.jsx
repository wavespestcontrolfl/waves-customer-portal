/**
 * Add-ons surface. Each add-on has a preChecked default from the server's
 * per-frequency config (server/config/addon-defaults-by-frequency.js).
 * Customer taps toggle checked state; selected set is carried through to
 * the accept handler as part of the final payload.
 */
import { estimateCard, estimateInnerBox } from './cardStyles';
import { CUSTOMER_SURFACE } from '../../theme-customer';

const W = {
  blue: '#065A8C', blueBright: '#009CDE', green: '#16A34A',
  navy: '#0F172A', blueDeeper: '#1B2C5B', textBody: '#334155', textCaption: '#64748B',
  white: '#FFFFFF', border: '#E7E2D7', borderLight: '#F1F5F9',
};

function savingsFromDetail(detail) {
  const match = String(detail || '').match(/Save\s+(.+?)\s+if removed/i);
  return match ? match[1].trim() : '';
}

export default function AddOnsBlock({ addOns, selectedKeys, onToggle, disabled = false }) {
  const items = Array.isArray(addOns) ? addOns : [];
  if (items.length === 0) return null;

  return (
    <div style={estimateCard()}>
      <div style={{ fontSize: 12, fontWeight: 700, color: W.textCaption,
        textTransform: 'uppercase', letterSpacing: '0.12em', marginBottom: 6 }}>
        Customize your visit
      </div>
      <div style={{
        fontFamily: "'Source Serif 4', Georgia, serif",
        fontSize: 24,
        fontWeight: 500,
        color: W.blueDeeper,
        lineHeight: 1.2,
        marginBottom: 4,
      }}>
        Skip parts you don't need
      </div>
      <div style={{ fontSize: 14, color: CUSTOMER_SURFACE.muted, lineHeight: 1.5, marginBottom: 18 }}>
        {disabled
          ? "The add-ons included in the visit you booked."
          : "These are on by default. Toggle off whatever you don't want and the price adjusts instantly."}
      </div>

      {items.map((item) => {
        const checked = selectedKeys.has(item.key);
        const savings = savingsFromDetail(item.detail);
        return (
          <label key={item.key} style={{
            ...estimateInnerBox({ background: checked ? W.white : '#F7F5EE' }),
            display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16,
            padding: 16,
            marginTop: 12,
            cursor: disabled ? 'default' : 'pointer',
          }}>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 16, fontWeight: 700, color: W.blueDeeper }}>
                {item.label} {checked ? 'included' : 'skipped'}
              </div>
              {item.detail ? (
                <div style={{ fontSize: 14, color: W.textCaption, marginTop: 3, lineHeight: 1.5 }}>
                  {checked ? 'Toggle off if you want to skip this.' : `Your estimate skips this. ${item.detail}`}
                </div>
              ) : null}
              {savings ? (
                <div style={{ fontSize: 14, color: checked ? W.green : '#9CA3AF', fontWeight: 800, marginTop: 6 }}>
                  {checked ? `Save ${savings}` : 'Savings applied to your estimate'}
                </div>
              ) : null}
            </div>
            <span style={{ position: 'relative', display: 'inline-block', width: 48, height: 28, flexShrink: 0, marginTop: 2 }}>
              <input
                type="checkbox"
                checked={checked}
                disabled={disabled}
                onChange={() => { if (!disabled) onToggle(item.key); }}
                style={{ position: 'absolute', inset: 0, opacity: 0, cursor: disabled ? 'default' : 'pointer', margin: 0 }}
              />
              <span aria-hidden="true" style={{
                position: 'absolute',
                inset: 0,
                background: checked ? W.blueDeeper : '#D4CBB8',
                borderRadius: 999,
                transition: 'background 160ms ease',
              }} />
              <span aria-hidden="true" style={{
                position: 'absolute',
                width: 22,
                height: 22,
                top: 3,
                left: checked ? 23 : 3,
                background: W.white,
                borderRadius: '50%',
                boxShadow: '0 1px 2px rgba(0,0,0,.15)',
                transition: 'left 160ms ease',
              }} />
            </span>
          </label>
        );
      })}
    </div>
  );
}
