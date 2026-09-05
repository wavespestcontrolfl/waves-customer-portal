export default function PublicLoadError({ onRetry, resource = 'link', light = false }) {
  const ink = light ? '#FFFFFF' : '#123B57';
  const muted = light ? 'rgba(255,255,255,0.78)' : '#475569';
  return (
    <div role="alert" style={{ textAlign: 'center', padding: '32px 24px', color: ink }}>
      <div style={{ fontSize: 22, fontWeight: 700 }}>We couldn&rsquo;t load that {resource}</div>
      <p style={{ margin: '10px auto 0', maxWidth: 440, color: muted, fontSize: 16, lineHeight: 1.55 }}>
        This looks temporary. Your link is still valid&mdash;check your connection and try again.
      </p>
      {/* The one action on the card is the gold primary like every other
          customer action (owner sheet 2026-09-03); the dark variant keeps its
          outlined treatment on the navy card page. */}
      <button
        type="button"
        onClick={onRetry}
        data-glass-accent={light ? undefined : ''}
        style={{
          marginTop: 16,
          minHeight: 48,
          padding: '12px 20px',
          borderRadius: 10,
          border: light ? '1px solid rgba(255,255,255,0.7)' : 0,
          background: light ? 'rgba(255,255,255,0.14)' : '#F4B014',
          color: light ? '#fff' : '#1B2C5B',
          font: 'inherit',
          fontSize: 16,
          fontWeight: 600,
          cursor: 'pointer',
          position: 'relative',
        }}
      >
        Try again
      </button>
    </div>
  );
}
