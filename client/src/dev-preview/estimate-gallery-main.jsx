import React, { useState } from 'react';
import ReactDOM from 'react-dom/client';
import { ESTIMATE_SCENARIOS } from './estimate-scenarios';
import '../index.css';
import '../styles/brand-tokens.css';

const VIEWPORTS = {
  desktop: { width: 1280, height: 820 },
  mobile: { width: 390, height: 844 },
};

function Gallery() {
  const [viewport, setViewport] = useState('desktop');
  const frame = VIEWPORTS[viewport];
  return (
    <main style={{ minHeight: '100vh', background: '#F3F4F6', color: '#172554', fontFamily: 'Inter, system-ui, sans-serif', padding: 24 }}>
      <header style={{ maxWidth: 1500, margin: '0 auto 20px' }}>
        <div style={{ fontSize: 12, letterSpacing: '.12em', textTransform: 'uppercase', fontWeight: 800, color: '#64748B' }}>Developer visual QA</div>
        <h1 style={{ margin: '6px 0 8px', fontSize: 32 }}>Customer estimate fixture gallery</h1>
        <p style={{ margin: 0, color: '#475569', maxWidth: 850 }}>Every frame renders the production EstimateViewPage with a stable, fictional payload. Use the controls to review desktop/mobile wrapping, open a full page, or open the print/PDF document route.</p>
        <div style={{ display: 'flex', gap: 8, marginTop: 16, flexWrap: 'wrap' }}>
          {Object.keys(VIEWPORTS).map((key) => <button key={key} type="button" onClick={() => setViewport(key)} style={{ border: 0, borderRadius: 8, padding: '9px 14px', cursor: 'pointer', fontWeight: 800, background: viewport === key ? '#1B2C5B' : '#fff', color: viewport === key ? '#fff' : '#1B2C5B' }}>{key}</button>)}
        </div>
      </header>
      <div style={{ maxWidth: 1500, margin: '0 auto', display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(340px,1fr))', gap: 20 }}>
        {ESTIMATE_SCENARIOS.map(([key, label]) => {
          const src = `/preview-estimate.html?scenario=${key}&chrome=0`;
          return <section key={key} style={{ minWidth: 0, background: '#fff', border: '1px solid #CBD5E1', borderRadius: 12, overflow: 'hidden', boxShadow: '0 8px 20px rgba(15,23,42,.08)' }}>
            <div style={{ padding: '11px 12px', display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'center', borderBottom: '1px solid #E2E8F0' }}>
              <div><strong>{label}</strong><div style={{ fontSize: 12, color: '#64748B' }}>{key}</div></div>
              <div style={{ display: 'flex', gap: 8, fontSize: 12 }}><a href={src} target="_blank" rel="noreferrer">Open</a><a href={`${src}&mode=pdf`} target="_blank" rel="noreferrer">Print</a></div>
            </div>
            <div style={{ overflow: 'auto', background: '#DCE3EA', padding: 10 }}>
              <iframe title={`${label} ${viewport} preview`} src={src} style={{ display: 'block', width: frame.width, height: frame.height, border: 0, background: '#fff', transformOrigin: 'top left', maxWidth: 'none' }} />
            </div>
          </section>;
        })}
      </div>
    </main>
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(<Gallery />);
