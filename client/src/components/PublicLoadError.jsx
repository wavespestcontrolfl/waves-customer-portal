export default function PublicLoadError({ onRetry, resource = 'link', light = false }) {
  const ink = light ? '#FFFFFF' : '#123B57';
  const muted = light ? 'rgba(255,255,255,0.78)' : '#475569';
  return (
    <div role="alert" style={{ textAlign: 'center', padding: '32px 24px', color: ink }}>
      <div style={{ fontSize: 22, fontWeight: 800 }}>We couldn&rsquo;t load that {resource}</div>
      <p style={{ margin: '10px auto 0', maxWidth: 440, color: muted, fontSize: 15, lineHeight: 1.55 }}>
        This looks temporary. Your link is still valid&mdash;check your connection and try again.
      </p>
      <button
        type="button"
        onClick={onRetry}
        style={{
          marginTop: 16,
          minHeight: 42,
          padding: '10px 18px',
          borderRadius: 8,
          border: light ? '1px solid rgba(255,255,255,0.7)' : 0,
          background: light ? 'rgba(255,255,255,0.14)' : '#123B57',
          color: '#fff',
          font: 'inherit',
          fontWeight: 800,
          cursor: 'pointer',
        }}
      >
        Try again
      </button>
    </div>
  );
}
