import { useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import { Download, MessageCircle, Printer, Share2 } from 'lucide-react';
import { COLORS as B, FONTS } from '../theme-brand';

const API_BASE = import.meta.env.VITE_API_URL || '/api';

function formatDate(value) {
  if (!value) return '';
  const date = new Date(String(value).includes('T') ? value : `${value}T12:00:00`);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  });
}

function formatMetric(metric) {
  if (metric.value == null || metric.value === '') return '-';
  if (metric.format === 'decimal_1') return Number(metric.value).toFixed(1);
  return `${metric.value}${metric.unit ? ` ${metric.unit}` : ''}`;
}

function valueOrDash(value, suffix = '') {
  if (value == null || value === '') return '-';
  return `${value}${suffix}`;
}

function conditionRows(conditions = {}) {
  return [
    ['Air temp', valueOrDash(conditions.temp_f ?? conditions.temp, ' deg F')],
    ['Humidity', valueOrDash(conditions.humidity_pct ?? conditions.humidity, '%')],
    ['Wind', valueOrDash(conditions.wind_mph ?? conditions.wind, conditions.wind_mph ? ' mph' : '')],
    ['Rain last 24 hr', valueOrDash(conditions.rain_24h_in, ' in')],
    ['Sky', valueOrDash(conditions.sky ?? conditions.cloudCover)],
    ['Source', valueOrDash(conditions.source)],
  ];
}

function actionButtonStyle(kind = 'plain') {
  return {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    minHeight: 40,
    padding: '0 14px',
    border: '0.5px solid #d4d4d4',
    borderRadius: 6,
    background: kind === 'primary' ? '#111111' : '#ffffff',
    color: kind === 'primary' ? '#ffffff' : '#171717',
    fontFamily: FONTS.body,
    fontSize: 14,
    fontWeight: 500,
    textDecoration: 'none',
    cursor: 'pointer',
  };
}

function LoadingState() {
  return (
    <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', background: '#fafafa', fontFamily: FONTS.body }}>
      <div style={{ fontSize: 14, color: '#525252' }}>Loading report...</div>
    </div>
  );
}

function NotFoundState() {
  return (
    <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', background: '#fafafa', padding: 20, fontFamily: FONTS.body }}>
      <div style={{ background: '#fff', borderRadius: 8, border: '0.5px solid #d4d4d4', padding: 28, maxWidth: 400, textAlign: 'center' }}>
        <div style={{ fontSize: 18, fontWeight: 600, color: '#171717' }}>Report not found</div>
        <a href="tel:+19412975749" style={{ ...actionButtonStyle('primary'), marginTop: 16 }}>Call (941) 297-5749</a>
      </div>
    </div>
  );
}

function LegacyReport({ data, token }) {
  const pdfUrl = `${API_BASE}/reports/${token}`;
  return (
    <div style={{ minHeight: '100vh', background: B.offWhite, fontFamily: FONTS.body }}>
      <div style={{ background: '#111111', padding: '14px 20px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
          <img src="/waves-logo.png" alt="Waves" style={{ height: 28 }} />
          <div style={{ minWidth: 0 }}>
            <h1 style={{ fontSize: 20, color: '#fff', lineHeight: 1, margin: 0 }}>Service report</h1>
            <div style={{ fontSize: 12, color: '#d4d4d4', marginTop: 4, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{data.customerName}</div>
          </div>
        </div>
        <a href={pdfUrl} download style={actionButtonStyle('primary')}><Download size={16} /> Download PDF</a>
      </div>
      <main style={{ maxWidth: 720, margin: '16px auto', padding: '0 16px 32px' }}>
        <section style={{ background: '#fff', borderRadius: 8, padding: 20, border: '0.5px solid #d4d4d4' }}>
          <div style={{ fontSize: 18, fontWeight: 600, color: '#171717' }}>{data.serviceType}</div>
          <div style={{ fontSize: 14, color: '#525252', marginTop: 4 }}>{formatDate(data.serviceDate)} | {data.technicianName}</div>
          {data.notes && <p style={{ fontSize: 15, color: '#404040', lineHeight: 1.6, marginTop: 16, whiteSpace: 'pre-wrap' }}>{data.notes}</p>}
        </section>
        <div style={{ marginTop: 16, borderRadius: 8, overflow: 'hidden', border: '0.5px solid #d4d4d4' }}>
          <iframe src={pdfUrl} style={{ width: '100%', height: 620, border: 'none' }} title="Service report PDF" />
        </div>
      </main>
    </div>
  );
}

function ServiceReportV1({ data, token }) {
  const pdfUrl = data.pdfUrl ? `${API_BASE}${data.pdfUrl.replace(/^\/api/, '')}` : null;
  const reportUrl = typeof window !== 'undefined' ? window.location.href : `/report/${token}`;
  const conditions = useMemo(() => conditionRows(data.conditions), [data.conditions]);
  const serviceNotes = String(data.legacy?.notes || '').trim();

  const share = async () => {
    if (navigator.share) {
      await navigator.share({ title: 'Waves service report', url: reportUrl });
      return;
    }
    await navigator.clipboard?.writeText(reportUrl);
  };

  return (
    <div className="service-report-v1">
      <style>{`
        .service-report-v1 {
          --text: #171717;
          --muted: #525252;
          --soft: #737373;
          --line: #d4d4d4;
          --paper: #ffffff;
          --page: #f7f7f7;
          --red: #b91c1c;
          min-height: 100vh;
          background: var(--page);
          color: var(--text);
          font-family: Inter, Arial, sans-serif;
        }
        .sr-top {
          position: sticky;
          top: 0;
          z-index: 5;
          background: rgba(255,255,255,.96);
          border-bottom: .5px solid var(--line);
          backdrop-filter: blur(12px);
        }
        .sr-top-inner {
          max-width: 1120px;
          margin: 0 auto;
          min-height: 64px;
          padding: 10px 20px;
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 16px;
        }
        .sr-shell {
          max-width: 1120px;
          margin: 0 auto;
          padding: 28px 20px 44px;
        }
        .sr-actions { display: flex; gap: 8px; flex-wrap: wrap; justify-content: flex-end; }
        .sr-hero {
          display: grid;
          grid-template-columns: 1.2fr .8fr;
          gap: 24px;
          align-items: end;
          padding: 10px 0 24px;
          border-bottom: .5px solid var(--line);
        }
        .sr-title {
          margin: 0;
          font-size: clamp(34px, 5vw, 62px);
          line-height: .98;
          font-weight: 500;
          letter-spacing: 0;
        }
        .sr-meta {
          margin-top: 14px;
          color: var(--muted);
          font-size: 15px;
          line-height: 1.55;
        }
        .sr-pressure {
          justify-self: end;
          background: var(--paper);
          border: .5px solid var(--line);
          border-radius: 8px;
          padding: 18px;
          min-width: 220px;
        }
        .sr-pressure-value { font-size: 44px; line-height: 1; font-weight: 500; }
        .sr-pressure-label { margin-top: 6px; font-size: 13px; color: var(--muted); }
        .sr-band {
          display: grid;
          grid-template-columns: repeat(4, minmax(0, 1fr));
          gap: 1px;
          margin: 24px 0;
          border: .5px solid var(--line);
          background: var(--line);
          border-radius: 8px;
          overflow: hidden;
        }
        .sr-metric { background: var(--paper); padding: 18px; min-height: 88px; }
        .sr-metric-value { font-size: 28px; line-height: 1; font-weight: 500; }
        .sr-metric-label { margin-top: 10px; font-size: 13px; color: var(--muted); }
        .sr-section {
          background: var(--paper);
          border: .5px solid var(--line);
          border-radius: 8px;
          padding: 22px;
          margin-top: 18px;
          break-inside: avoid;
        }
        .sr-section h2 {
          margin: 0 0 16px;
          font-size: 20px;
          line-height: 1.2;
          font-weight: 500;
          letter-spacing: 0;
        }
        .sr-map {
          width: 100%;
          overflow: hidden;
          border: .5px solid var(--line);
          border-radius: 6px;
          background: #fff;
        }
        .sr-map svg { display: block; width: 100%; height: auto; }
        .sr-grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
        .sr-grid-3 { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 1px; border: .5px solid var(--line); border-radius: 8px; overflow: hidden; background: var(--line); }
        .sr-cell { background: #fff; padding: 14px; min-height: 72px; }
        .sr-cell-label { font-size: 12px; color: var(--soft); }
        .sr-cell-value { margin-top: 6px; font-size: 15px; color: var(--text); }
        .sr-list { display: grid; gap: 10px; }
        .sr-row {
          border: .5px solid var(--line);
          border-radius: 6px;
          padding: 13px 14px;
          display: grid;
          grid-template-columns: 1fr auto;
          gap: 12px;
        }
        .sr-row-title { font-size: 15px; font-weight: 500; }
        .sr-row-detail { margin-top: 4px; color: var(--muted); font-size: 13px; line-height: 1.45; }
        .sr-pill { border: .5px solid var(--line); border-radius: 999px; padding: 4px 9px; font-size: 12px; color: var(--muted); white-space: nowrap; height: fit-content; }
        .sr-finding-high { border-left: 3px solid var(--red); }
        .sr-advisory { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; }
        .sr-advisory strong { font-size: 22px; font-weight: 500; display: block; }
        .sr-advisory span { color: var(--muted); font-size: 13px; }
        .sr-footer { color: var(--soft); font-size: 12px; line-height: 1.6; padding: 22px 0 0; }
        @media (max-width: 760px) {
          .sr-top-inner { align-items: flex-start; flex-direction: column; }
          .sr-actions { width: 100%; justify-content: stretch; }
          .sr-actions a, .sr-actions button { flex: 1; }
          .sr-shell { padding: 20px 14px 36px; }
          .sr-hero { grid-template-columns: 1fr; }
          .sr-pressure { justify-self: stretch; }
          .sr-band { grid-template-columns: repeat(2, minmax(0, 1fr)); }
          .sr-grid-2, .sr-grid-3, .sr-advisory { grid-template-columns: 1fr; }
          .sr-row { grid-template-columns: 1fr; }
        }
        @media print {
          .sr-top { position: static; }
          .sr-actions { display: none; }
          .service-report-v1 { background: #fff; }
          .sr-shell { padding: 0; }
        }
      `}</style>

      <header className="sr-top">
        <div className="sr-top-inner">
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
            <img src="/waves-logo.png" alt="Waves" style={{ height: 30 }} />
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 15, fontWeight: 600 }}>Service report</div>
              <div style={{ fontSize: 14, color: '#525252', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{data.customerName}</div>
            </div>
          </div>
          <div className="sr-actions">
            {pdfUrl && <a href={pdfUrl} download style={actionButtonStyle()}><Download size={16} /> PDF</a>}
            <button type="button" onClick={share} style={actionButtonStyle()}><Share2 size={16} /> Share</button>
            <button type="button" onClick={() => window.print()} style={actionButtonStyle()}><Printer size={16} /> Print</button>
            <a href="sms:+19412975749" style={actionButtonStyle('primary')}><MessageCircle size={16} /> Follow-up</a>
          </div>
        </div>
      </header>

      <main className="sr-shell">
        <section className="sr-hero">
          <div>
            <h1 className="sr-title">{data.serviceLineDisplay || data.serviceType}</h1>
            <div className="sr-meta">
              {formatDate(data.serviceDate)}<br />
              {data.technicianName} | {data.cityState || 'Waves service area'}
            </div>
          </div>
          <div className="sr-pressure">
            <div className="sr-pressure-value">{Number(data.pressureIndex || 0).toFixed(1)}</div>
            <div className="sr-pressure-label">Pressure index</div>
          </div>
        </section>

        <section className="sr-band" aria-label="Service metrics">
          {(data.metrics || []).map((metric) => (
            <div className="sr-metric" key={metric.key}>
              <div className="sr-metric-value">{formatMetric(metric)}</div>
              <div className="sr-metric-label">{metric.label}</div>
            </div>
          ))}
        </section>

        {data.mapSvg && (
          <section className="sr-section">
            <h2>Treatment map</h2>
            <div className="sr-map" dangerouslySetInnerHTML={{ __html: data.mapSvg }} />
          </section>
        )}

        <section className="sr-grid-2">
          <div className="sr-section" style={{ marginTop: 18 }}>
            <h2>Application log</h2>
            <div className="sr-list">
              {(data.applications || []).length ? data.applications.map((app) => (
                <div className="sr-row" key={app.id}>
                  <div>
                    <div className="sr-row-title">{app.product?.name || 'Product application'}</div>
                    <div className="sr-row-detail">
                      {[app.product?.active_ingredient, app.rate && app.rateUnit ? `${app.rate} ${app.rateUnit}` : null, app.totalAmount && app.amountUnit ? `${app.totalAmount} ${app.amountUnit}` : null].filter(Boolean).join(' | ') || 'Application recorded'}
                    </div>
                  </div>
                  <div className="sr-pill">{app.method?.replace(/_/g, ' ') || 'Application'}</div>
                </div>
              )) : <div className="sr-row-detail">No product applications were recorded for this visit.</div>}
            </div>
          </div>

          <div className="sr-section" style={{ marginTop: 18 }}>
            <h2>Conditions</h2>
            <div className="sr-grid-3">
              {conditions.map(([label, value]) => (
                <div className="sr-cell" key={label}>
                  <div className="sr-cell-label">{label}</div>
                  <div className="sr-cell-value">{value}</div>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section className="sr-section">
          <h2>Findings and recommendations</h2>
          <div className="sr-list">
            {(data.findings || []).length ? data.findings.map((finding) => (
              <div className={`sr-row ${['high', 'critical'].includes(finding.severity) ? 'sr-finding-high' : ''}`} key={finding.id}>
                <div>
                  <div className="sr-row-title">{finding.title}</div>
                  {(finding.detail || finding.recommendation) && (
                    <div className="sr-row-detail">{[finding.detail, finding.recommendation].filter(Boolean).join(' ')}</div>
                  )}
                </div>
                <div className="sr-pill">{finding.severity}</div>
              </div>
            )) : <div className="sr-row-detail">No issues were documented during this visit.</div>}
            {(data.recommendations || []).map((rec) => (
              <div className="sr-row" key={rec}>
                <div className="sr-row-title">{rec}</div>
                <div className="sr-pill">Next</div>
              </div>
            ))}
          </div>
        </section>

        {serviceNotes && (
          <section className="sr-section">
            <h2>Service notes</h2>
            <p style={{ margin: 0, color: '#404040', lineHeight: 1.6, whiteSpace: 'pre-wrap' }}>{serviceNotes}</p>
          </section>
        )}

        <section className="sr-section">
          <h2>Customer advisory</h2>
          <div className="sr-advisory">
            <div>
              <strong>{valueOrDash(data.advisory?.exterior_reentry_min, ' min')}</strong>
              <span>Exterior re-entry</span>
            </div>
            <div>
              <strong>{valueOrDash(data.advisory?.interior_reentry_min, ' min')}</strong>
              <span>Interior re-entry</span>
            </div>
            <div>
              <strong>{valueOrDash(data.advisory?.irrigation_hold_hr, ' hr')}</strong>
              <span>Irrigation hold</span>
            </div>
          </div>
          {data.advisory?.pet_advisory && <p style={{ margin: '16px 0 0', color: '#525252', lineHeight: 1.55 }}>{data.advisory.pet_advisory}</p>}
        </section>

        {(data.photos || []).length > 0 && (
          <section className="sr-section">
            <h2>Field photos</h2>
            <div className="sr-grid-3">
              {data.photos.map((photo) => (
                <div className="sr-cell" key={photo.id}>
                  {photo.url && <img src={photo.url} alt={photo.caption || 'Service photo'} style={{ width: '100%', borderRadius: 6, border: '0.5px solid #d4d4d4' }} />}
                  <div className="sr-cell-value">{photo.caption || photo.stateBadge || 'Service photo'}</div>
                </div>
              ))}
            </div>
          </section>
        )}

        <footer className="sr-footer">
          Waves Pest Control | This report is provided for your records. For questions, text or call (941) 297-5749.
        </footer>
      </main>
    </div>
  );
}

export default function ReportViewPage() {
  const { token } = useParams();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetch(`${API_BASE}/reports/${token}/data`)
      .then((r) => r.json())
      .then((d) => {
        if (!cancelled) setData(d);
      })
      .catch(() => {
        if (!cancelled) setData({ error: 'Report not found' });
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  if (loading) return <LoadingState />;
  if (!data || data.error) return <NotFoundState />;
  if (data.reportVersion === 'service_report_v1') return <ServiceReportV1 data={data} token={token} />;
  return <LegacyReport data={data} token={token} />;
}
