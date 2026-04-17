import { useState, useEffect } from 'react';
import { useParams } from 'react-router-dom';
import { COLORS as B, FONTS, BUTTON_BASE, HALFTONE_PATTERN, HALFTONE_SIZE } from '../theme-brand';
import BrandFooter from '../components/BrandFooter';

const API_BASE = import.meta.env.VITE_API_URL || '/api';

export default function ReportViewPage() {
  const { token } = useParams();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch(`${API_BASE}/reports/${token}/data`)
      .then(r => r.json())
      .then(d => { setData(d); setLoading(false); })
      .catch(() => setLoading(false));
  }, [token]);

  if (loading) return (
    <div style={{ minHeight: '100vh', background: B.blueDark, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ color: '#fff', fontFamily: FONTS.body }}>Loading report...</div>
    </div>
  );

  if (!data || data.error) return (
    <div style={{ minHeight: '100vh', background: B.blueDark, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
      <div style={{ background: '#fff', borderRadius: 16, padding: 28, maxWidth: 400, textAlign: 'center' }}>
        <div style={{ fontSize: 32 }}>📄</div>
        <div style={{ fontSize: 16, fontWeight: 700, color: B.navy, marginTop: 8 }}>Report not found</div>
        <a href="tel:+19413187612" style={{ ...BUTTON_BASE, marginTop: 16, padding: '10px 22px', borderRadius: 9999, background: B.yellow, color: B.blueDeeper, textDecoration: 'none', display: 'inline-flex', fontWeight: 800 }}>Call (941) 318-7612</a>
      </div>
    </div>
  );

  const pdfUrl = `${API_BASE}/reports/${token}`;

  return (
    <div style={{ minHeight: '100vh', background: B.offWhite, fontFamily: FONTS.body }}>
      {/* Header */}
      <div style={{
        position: 'relative', overflow: 'hidden',
        background: B.blueDark, padding: '14px 20px',
        backgroundImage: HALFTONE_PATTERN, backgroundSize: HALFTONE_SIZE,
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
      }}>
        {/* Hero video — waves-hero-service.mp4 */}
        <video autoPlay muted loop playsInline preload="none" poster="/brand/waves-hero-service.webp"
          style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover', opacity: 0.3, zIndex: 0, pointerEvents: 'none' }}
          aria-hidden="true">
          <source src="/brand/waves-hero-service.mp4" type="video/mp4" />
        </video>
        <div style={{ position: 'relative', zIndex: 1, display: 'flex', alignItems: 'center', gap: 10 }}>
          <img src="/waves-logo.png" alt="Waves" style={{ height: 28 }} />
          <div>
            <h1 style={{
              fontFamily: FONTS.display, fontWeight: 400,
              fontSize: 20, color: '#fff',
              letterSpacing: '0.02em', lineHeight: 1, margin: 0,
            }}>Service Report</h1>
            <div style={{ fontSize: 11, color: B.blueLight, marginTop: 4 }}>{data.customerName}</div>
          </div>
        </div>
        <a href={pdfUrl} download style={{
          ...BUTTON_BASE, position: 'relative', zIndex: 1,
          padding: '0 18px', height: 36, fontSize: 13,
          borderRadius: 999, background: B.yellow, color: B.blueDeeper,
          textDecoration: 'none', fontWeight: 800, display: 'inline-flex',
          alignItems: 'center',
        }}>⬇ Download PDF</a>
      </div>

      {/* Report summary card */}
      <div style={{ maxWidth: 600, margin: '16px auto', padding: '0 16px' }}>
        <div style={{ background: '#fff', borderRadius: 16, padding: 20, border: `1px solid ${B.bluePale}` }}>
          <div style={{ fontSize: 18, fontWeight: 800, color: B.navy, fontFamily: FONTS.heading }}>{data.serviceType}</div>
          <div style={{ fontSize: 13, color: B.grayDark, marginTop: 4 }}>
            {data.serviceDate && new Date(data.serviceDate + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}
            {' · '}{data.technicianName}
          </div>
          <div style={{ fontSize: 12, color: B.grayMid, marginTop: 2 }}>{data.cityState || ''}</div>

          {/* Notes */}
          {data.notes && (
            <div style={{ marginTop: 14, padding: '12px 14px', borderRadius: 10, background: B.blueSurface, border: `1px solid ${B.bluePale}` }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: B.navy, marginBottom: 4 }}>Tech Notes</div>
              <div style={{ fontSize: 13, color: B.grayDark, lineHeight: 1.6 }}>{data.notes}</div>
            </div>
          )}

          {/* Products */}
          {data.products?.length > 0 && (
            <div style={{ marginTop: 14 }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: B.navy, marginBottom: 6 }}>Products Applied</div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                {data.products.map((p, i) => (
                  <span key={i} style={{
                    fontSize: 11, padding: '3px 10px', borderRadius: 8,
                    background: B.blueSurface, color: B.navy, fontWeight: 500,
                    border: `1px solid ${B.bluePale}`,
                  }}>{p.name}</span>
                ))}
              </div>
            </div>
          )}

          {/* Measurements */}
          {(data.measurements?.soilTemp || data.measurements?.thatch) && (
            <div style={{ marginTop: 14, display: 'flex', gap: 12, flexWrap: 'wrap' }}>
              {data.measurements.soilTemp && (
                <div style={{ fontSize: 12, color: B.grayDark }}>🌡️ Soil: {data.measurements.soilTemp}°F</div>
              )}
              {data.measurements.thatch && (
                <div style={{ fontSize: 12, color: B.grayDark }}>📏 Thatch: {data.measurements.thatch}"</div>
              )}
              {data.measurements.soilPh && (
                <div style={{ fontSize: 12, color: B.grayDark }}>⚗️ pH: {data.measurements.soilPh}</div>
              )}
              {data.measurements.moisture && (
                <div style={{ fontSize: 12, color: B.grayDark }}>💧 Moisture: {data.measurements.moisture}</div>
              )}
            </div>
          )}
        </div>

        {/* PDF embed */}
        <div style={{ marginTop: 16, borderRadius: 12, overflow: 'hidden', border: `1px solid ${B.bluePale}` }}>
          <iframe src={pdfUrl} style={{ width: '100%', height: 600, border: 'none' }} title="Service Report PDF" />
        </div>

        {/* CTA */}
        <div style={{ textAlign: 'center', marginTop: 20, padding: '16px 0' }}>
          <div style={{ fontSize: 13, color: B.grayDark }}>Questions about your service?</div>
          <a href="sms:+19413187612" style={{
            ...BUTTON_BASE, padding: '0 22px', height: 44, fontSize: 14, marginTop: 8,
            borderRadius: 999, background: B.yellow, color: B.blueDeeper,
            textDecoration: 'none', display: 'inline-flex', alignItems: 'center',
            fontWeight: 800,
          }}>💬 Text Us — (941) 318-7612</a>
        </div>

        <BrandFooter />
      </div>
    </div>
  );
}
