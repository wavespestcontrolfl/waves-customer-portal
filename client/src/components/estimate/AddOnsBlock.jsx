/**
 * Add-ons surface. Each add-on has a preChecked default from the server's
 * per-frequency config (server/config/addon-defaults-by-frequency.js).
 * Customer taps toggle checked state; selected set is carried through to
 * the accept handler as part of the final payload.
 */
const W = {
  blue: '#065A8C', blueBright: '#009CDE', green: '#16A34A',
  navy: '#0F172A', textBody: '#334155', textCaption: '#64748B',
  white: '#FFFFFF', border: '#CBD5E1', borderLight: '#F1F5F9',
};

export default function AddOnsBlock({ addOns, selectedKeys, onToggle }) {
  const items = Array.isArray(addOns) ? addOns : [];
  if (items.length === 0) return null;

  return (
    <div style={{
      background: W.white, borderRadius: 16, padding: 24,
      border: `1px solid ${W.border}`, marginBottom: 16,
    }}>
      <div style={{ fontSize: 13, fontWeight: 600, color: W.textCaption,
        textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 14 }}>
        Customize your plan
      </div>

      {items.map((item) => {
        const checked = selectedKeys.has(item.key);
        return (
          <label key={item.key} style={{
            display: 'flex', alignItems: 'flex-start', gap: 12,
            padding: '12px 0', borderBottom: `1px solid ${W.borderLight}`,
            cursor: 'pointer',
          }}>
            <input
              type="checkbox"
              checked={checked}
              onChange={() => onToggle(item.key)}
              style={{
                width: 20, height: 20, flexShrink: 0, marginTop: 1,
                accentColor: W.blueBright, cursor: 'pointer',
              }}
            />
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 15, fontWeight: 500, color: W.navy }}>{item.label}</div>
              {item.detail ? (
                <div style={{ fontSize: 13, color: W.textCaption, marginTop: 2 }}>{item.detail}</div>
              ) : null}
            </div>
          </label>
        );
      })}
    </div>
  );
}
