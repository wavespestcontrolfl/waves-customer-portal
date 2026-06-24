// DEV-ONLY preview for the Phase 3 fast tech closeout card. Standalone (no app
// shell); mirrors the /report-v2-preview pattern. Renders the card against a few
// closeout states so we can iterate in Chrome DevTools.

import { useState } from 'react';
import FastCloseoutSummary from '../components/tech/FastCloseoutSummary';

const SCENARIOS = {
  clean: {
    label: 'No issues (20s closeout)',
    summary: {
      productsReady: true, protocolReady: true, photosReady: true, smsEnabled: true,
      aiAnalysisStatus: 'complete',
      aiInsights: [{ label: 'Lawn looks healthy', status: 'ready' }],
      suggestedCustomerAction: '', exceptions: defaultExceptions(), canComplete: true,
    },
  },
  oneIssue: {
    label: 'One exception (water coverage)',
    summary: {
      productsReady: true, protocolReady: true, photosReady: true, smsEnabled: true,
      aiAnalysisStatus: 'complete',
      aiInsights: [{ label: 'Water coverage', status: 'watch' }, { label: 'Mowing height', status: 'watch' }],
      suggestedCustomerAction: 'Check sprinkler coverage near the front/right zone.',
      exceptions: defaultExceptions(['dry_stress']), canComplete: true,
    },
  },
  aiPending: {
    label: 'AI still analyzing',
    summary: {
      productsReady: true, protocolReady: true, photosReady: true, smsEnabled: true,
      aiAnalysisStatus: 'pending', aiInsights: [],
      suggestedCustomerAction: '', exceptions: defaultExceptions(), canComplete: true,
    },
  },
  blocked: {
    label: 'Protocol incomplete (blocked)',
    summary: {
      productsReady: true, protocolReady: false, photosReady: false, smsEnabled: true,
      aiAnalysisStatus: 'not_required', aiInsights: [],
      suggestedCustomerAction: '', exceptions: defaultExceptions(), canComplete: false,
    },
  },
};

function defaultExceptions(active = []) {
  return [
    { key: 'none', label: 'No issues found', status: 'ready', active: active.length === 0 },
    { key: 'dry_stress', label: 'Dry stress', status: 'watch' },
    { key: 'coverage', label: 'Irrigation coverage', status: 'watch' },
    { key: 'mow_short', label: 'Mowing too short', status: 'watch' },
    { key: 'weeds', label: 'Weed pressure', status: 'watch' },
    { key: 'pest', label: 'Pest monitoring', status: 'watch' },
    { key: 'fungus', label: 'Fungus watch', status: 'attention' },
    { key: 'concern', label: 'Customer concern', status: 'attention' },
    { key: 'follow_up', label: 'Follow-up needed', status: 'attention' },
  ].map((e) => ({ ...e, active: active.includes(e.key) || e.active }));
}

export default function CloseoutPreview() {
  const [key, setKey] = useState('clean');
  const s = SCENARIOS[key];
  const tab = (k) => (
    <button key={k} type="button" onClick={() => setKey(k)} style={{
      padding: '7px 12px', borderRadius: 999, cursor: 'pointer', fontSize: 12.5, fontWeight: 700,
      border: `1px solid ${key === k ? '#0ea5e9' : '#334155'}`,
      background: key === k ? '#0ea5e9' : 'transparent', color: key === k ? '#04121c' : '#94a3b8',
    }}>{SCENARIOS[k].label}</button>
  );
  return (
    <div style={{ minHeight: '100vh', background: '#0f1923', padding: '20px 16px', fontFamily: "'DM Sans', system-ui, sans-serif" }}>
      <div style={{ maxWidth: 460, margin: '0 auto' }}>
        <div style={{ color: '#e2e8f0', fontWeight: 800, fontSize: 16, marginBottom: 4 }}>Fast Closeout — preview</div>
        <div style={{ color: '#94a3b8', fontSize: 14, marginBottom: 14 }}>Tech completes a lawn visit. System builds the customer report.</div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 16 }}>{Object.keys(SCENARIOS).map(tab)}</div>
        <FastCloseoutSummary summary={s.summary} onAddIssue={() => {}} onComplete={() => {}} />
      </div>
    </div>
  );
}
