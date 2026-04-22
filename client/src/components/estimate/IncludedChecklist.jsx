/**
 * Live-changing "what's included" list per selected frequency. Reads the
 * included array straight from the server payload's frequency entry —
 * no client-side mutation of the underlying contract.
 */
const W = {
  blue: '#065A8C', blueBright: '#009CDE', green: '#16A34A',
  navy: '#0F172A', textBody: '#334155', textCaption: '#64748B',
  white: '#FFFFFF', border: '#CBD5E1', borderLight: '#F1F5F9',
};

export default function IncludedChecklist({ included }) {
  const items = Array.isArray(included) ? included : [];

  return (
    <div style={{
      background: W.white, borderRadius: 16, padding: 24,
      border: `1px solid ${W.border}`, marginBottom: 16,
    }}>
      <div style={{ fontSize: 13, fontWeight: 600, color: W.textCaption,
        textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 14 }}>
        What's included
      </div>

      {items.length === 0 ? (
        <div style={{ fontSize: 14, color: W.textCaption }}>Service details load when pricing is ready.</div>
      ) : (
        <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
          {items.map((item) => (
            <li key={item.key || item.label} style={{
              display: 'flex', alignItems: 'flex-start', gap: 10,
              padding: '10px 0', borderBottom: `1px solid ${W.borderLight}`,
            }}>
              <span style={{
                display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                width: 22, height: 22, flexShrink: 0, marginTop: 1,
                borderRadius: '50%', background: W.green, color: W.white,
                fontSize: 13, fontWeight: 700,
              }}>✓</span>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 15, fontWeight: 500, color: W.navy }}>{item.label}</div>
                {item.detail ? (
                  <div style={{ fontSize: 13, color: W.textCaption, marginTop: 2 }}>{item.detail}</div>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
