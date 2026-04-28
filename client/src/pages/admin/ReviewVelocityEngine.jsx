import { useState, useEffect, useCallback, useMemo, useRef } from 'react';

const API_BASE = import.meta.env.VITE_API_URL || '/api';

function adminFetch(path, options = {}) {
  return fetch(`${API_BASE}${path}`, {
    headers: { Authorization: `Bearer ${localStorage.getItem('waves_admin_token')}`, 'Content-Type': 'application/json' },
    ...options,
  }).then(r => {
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  });
}

// V2 token pass: chrome folds to zinc ramp; non-semantic accents
// (acc/blu/pur) collapse to zinc-900 with zinc-100 pastel glows.
// Semantic green/amber/red preserved as V2-legal variants.
const C = {
  bg: '#F4F4F5', raised: '#FFFFFF', surface: '#FFFFFF', hover: '#FAFAFA', input: '#FFFFFF',
  bdr: 'rgba(24,24,27,0.06)', bdrA: 'rgba(24,24,27,0.15)',
  acc: '#18181B', accG: '#F4F4F5', accD: '#09090B',
  grn: '#15803D', grnG: '#DCFCE7',
  org: '#A16207', orgG: '#FEF3C7',
  red: '#991B1B', redG: '#FEE2E2',
  blu: '#18181B', bluG: '#F4F4F5',
  pur: '#18181B', purG: '#F4F4F5',
  t1: '#27272A', t2: '#71717A', t3: '#71717A',
  heading: '#09090B',
  inputBorder: '#D4D4D8',
  sans: "'DM Sans', sans-serif",
};

// ── GBP Locations ──
//
// Source of truth: server/config/locations.js (WAVES_LOCATIONS). The four
// IDs / review URLs below mirror that file exactly so the
// /admin/reviews/outreach-candidates response (which returns
// customers.nearest_location_id) joins cleanly without falling back to
// city-zone routing. Waves operates four GBPs — Lakewood Ranch (HQ),
// Parrish, Sarasota, and Venice. Port Charlotte / Punta Gorda is in the
// service footprint but does NOT have its own GBP — those customers
// route to Venice. Zones / zips below are kept aligned with the
// CITY_TO_LOCATION map in server/config/locations.js.
const GBP_LOCATIONS = [
  {
    id: 'lakewood-ranch',
    name: 'Lakewood Ranch',
    zones: ['lakewood ranch','bradenton','university park'],
    zips: ['34201','34202','34203','34205','34207','34208','34209','34210','34211','34212'],
    reviewUrl: 'https://g.page/r/CVRc_P5butTMEBM/review',
  },
  {
    id: 'parrish',
    name: 'Parrish',
    zones: ['parrish','palmetto','ellenton','ruskin','apollo beach','terra ceia','memphis'],
    zips: ['34219','34221','34222'],
    reviewUrl: 'https://g.page/r/Ca-4KKoWwFacEBM/review',
  },
  {
    id: 'sarasota',
    name: 'Sarasota',
    zones: ['sarasota','siesta key','lido key','osprey','longboat key','bee ridge','fruitville'],
    zips: ['34231','34232','34233','34234','34235','34236','34237','34238','34239','34240','34241','34242','34243'],
    reviewUrl: 'https://g.page/r/CRkzS6M4EpncEBM/review',
  },
  {
    id: 'venice',
    name: 'Venice',
    zones: ['venice','north port','englewood','nokomis','port charlotte','punta gorda','warm mineral springs','wellen park'],
    zips: ['34275','34285','34286','34287','34288','34289','34291','34292','34293','33947','33948','33949','33950','33952','33953','33954','33955','33980','33981','33982','33983'],
    reviewUrl: 'https://g.page/r/CURA5pQ1KatBEBM/review',
  },
];

const STAGES = {
  not_contacted: { label: 'Not Contacted', color: C.t3, tag: 'acc' },
  sms_sent: { label: 'SMS Sent', color: C.org, tag: 'org' },
  reminded: { label: 'Reminded', color: C.blu, tag: 'blu' },
  reviewed: { label: 'Reviewed', color: C.grn, tag: 'grn' },
  declined: { label: 'Declined', color: C.t3, tag: 'pur' },
  issue: { label: 'Issue', color: C.red, tag: 'red' },
};

const SUP_RULES_DEFAULT = [
  { id: 'reviewed_6m', label: 'Reviewed in last 6 months', desc: 'Skip customers who already left a review recently', enabled: true },
  { id: 'asked_3x', label: 'Asked 3× with no response', desc: 'Stop asking after 3 unanswered requests', enabled: true },
  { id: 'open_complaint', label: 'Open complaint / unresolved issue', desc: 'Auto-suppress customers flagged with issues', enabled: true },
  { id: 'collections', label: 'In collections flow', desc: 'Never ask for review during late-payment sequence', enabled: true },
  { id: 'opted_out', label: 'Opted out / negative response', desc: 'Customer replied STOP or expressed refusal', enabled: true },
  { id: 'cooldown_30d', label: '30-day cooldown after ask', desc: 'Minimum gap between review requests', enabled: true },
];

const SEQUENCES = [
  { id: 'standard', name: 'Standard Review Ask', steps: [
    { day: 0, label: 'Initial Ask', icon: '📤', template: 'friendly_ask' },
    { day: 3, label: 'Soft Reminder', icon: '💬', template: 'soft_reminder' },
    { day: 7, label: 'Final Nudge', icon: '🙏', template: 'final_nudge' },
  ]},
  { id: 'recovery', name: 'Issue Recovery → Review', steps: [
    { day: 0, label: 'Resolution Check', icon: '🔧', template: 'resolution_check' },
    { day: 2, label: 'Satisfaction Confirm', icon: '😊', template: 'satisfaction_confirm' },
    { day: 5, label: 'Review Ask', icon: '⭐', template: 'recovery_review' },
  ]},
  { id: 'winback', name: 'Win-Back (60+ days)', steps: [
    { day: 0, label: 'Check-In', icon: '👋', template: 'winback_checkin' },
    { day: 4, label: 'Review Ask', icon: '⭐', template: 'winback_ask' },
  ]},
  { id: 'post_service', name: 'Post-Service Auto (2hr trigger)', steps: [
    { day: 0, label: 'Auto-Send (2hr)', icon: '⚡', template: 'post_service_hot' },
    { day: 3, label: 'Follow-Up', icon: '💬', template: 'soft_reminder' },
  ]},
];

const TEMPLATES = [
  { id: 'friendly_ask', name: 'Friendly Ask', sentiment: 'happy', body: 'Hey {first}! This is Adam with Waves Pest Control. Thanks for being a great customer — it means the world to our small family business.\n\nIf you have 30 seconds, a quick Google review would help us more than you know:\n\n{review_url}\n\nThank you!' },
  { id: 'soft_reminder', name: 'Soft Reminder (Day 3)', sentiment: 'happy', body: 'Hi {first}! Just a quick follow-up from Waves. If you had a chance to leave us a review, we\'d really appreciate it — helps other families find us.\n\n{review_url}\n\nThanks so much!' },
  { id: 'final_nudge', name: 'Final Nudge (Day 7)', sentiment: 'happy', body: 'Hey {first} — last one from us, promise! If you\'ve been happy with Waves, a 15-second Google review would mean a lot to our crew.\n\n{review_url}\n\nEither way, thank you for trusting us with your home!' },
  { id: 'post_service_hot', name: 'Post-Service Hot (2hr)', sentiment: 'happy', body: 'Hey {first}! {tech} here from Waves. Just finished up at your place — hope everything looks great!\n\nIf you have a sec, a quick Google review would make my day:\n\n{review_url}\n\nThanks for choosing Waves!' },
  { id: 'service_specific_pest', name: 'Service-Specific: Pest Control', sentiment: 'happy', body: 'Hi {first}! After your {service_type} treatment, we hope the critters are staying away!\n\nIf we earned it, a quick review would help other SWFL families find us:\n\n{review_url}\n\nThank you!' },
  { id: 'service_specific_lawn', name: 'Service-Specific: Lawn Care', sentiment: 'happy', body: 'Hey {first}! Hope the yard is looking great after your {service_type} service.\n\nIf you\'re loving the results, a quick review would mean the world:\n\n{review_url}\n\n— The Waves Crew' },
  { id: 'resolution_check', name: 'Issue Resolution Check', sentiment: 'issue', body: 'Hi {first}, this is Adam with Waves. I wanted to follow up and make sure everything\'s been taken care of. Your satisfaction is our top priority.\n\nPlease let me know if there\'s anything else we can do. — Waves' },
  { id: 'satisfaction_confirm', name: 'Satisfaction Confirm', sentiment: 'issue', body: 'Hey {first} — just checking in one more time. Is everything resolved to your satisfaction? We want to make sure you\'re 100% happy. Let me know!' },
  { id: 'recovery_review', name: 'Recovery → Review', sentiment: 'issue', body: 'Hi {first}! Glad we got everything sorted. Since you mentioned things are looking good now, would you mind sharing your experience?\n\n{review_url}\n\nYour feedback helps us keep getting better. Thank you!' },
  { id: 'winback_checkin', name: 'Win-Back Check-In', sentiment: 'neutral', body: 'Hey {first}! It\'s been a while since your last Waves service. Hope everything\'s been great at the property.\n\nJust wanted to check in — let us know if you need anything!' },
  { id: 'winback_ask', name: 'Win-Back Review Ask', sentiment: 'neutral', body: 'Hi {first}! We realized we never asked — if you were happy with your Waves service, a quick Google review would mean the world to our small team:\n\n{review_url}\n\nThanks so much!' },
  { id: 'qr_followup', name: 'QR Code Follow-Up', sentiment: 'happy', body: 'Hey {first}! Great seeing you today. Here\'s that review link one more time in case you didn\'t get a chance:\n\n{review_url}\n\nThanks for supporting Waves!' },
];

// ── Helpers ──
function routeToGBP(addr) {
  if (!addr) return GBP_LOCATIONS[0];
  const lower = addr.toLowerCase();
  for (const loc of GBP_LOCATIONS) {
    for (const zone of loc.zones) { if (lower.includes(zone)) return loc; }
    for (const zip of loc.zips) { if (lower.includes(zip)) return loc; }
  }
  return GBP_LOCATIONS[0];
}

function calcScore(sentiment, daysAgo, revenue, stage, askCount, svcType) {
  let score = 0;
  if (sentiment === 'happy') score += 35;
  else if (sentiment === 'neutral') score += 15;
  if (daysAgo <= 7) score += 25;
  else if (daysAgo <= 14) score += 22;
  else if (daysAgo <= 30) score += 18;
  else if (daysAgo <= 60) score += 10;
  else score += 3;
  if (revenue >= 200) score += 15;
  else if (revenue >= 100) score += 10;
  else score += 5;
  if (askCount === 0) score += 15;
  else if (askCount === 1) score += 5;
  if (stage === 'reviewed') score -= 20;
  if (stage === 'issue') score -= 15;
  if (['Termite Protection', 'Mosquito Control'].includes(svcType)) score += 5;
  return Math.max(0, Math.min(100, score));
}

function fmtDate(d) {
  if (!d) return '—';
  if (typeof d === 'string') return d;
  return `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()}`;
}

function fmtPh(p) {
  if (!p) return '';
  p = p.replace(/\D/g, '');
  if (p.length === 11 && p[0] === '1') p = p.substring(1);
  return p.length === 10 ? `(${p.substring(0, 3)}) ${p.substring(3, 6)}-${p.substring(6)}` : p;
}

function hydrate(body, c) {
  return body
    .replace(/\{first\}/g, c.first)
    .replace(/\{name\}/g, c.name)
    .replace(/\{tech\}/g, c.lastTech || 'Adam')
    .replace(/\{service_type\}/g, c.lastSvc || 'pest control')
    .replace(/\{review_url\}/g, c.reviewUrl)
    .replace(/\{date\}/g, c.lastDate);
}

// Map a row from /admin/reviews/outreach-candidates to the UI customer shape.
// Stage is derived from askCount (server-backed) — no localStorage override.
function apiToCustomer(row) {
  const gbp = GBP_LOCATIONS.find(l => l.id === row.locationId) || routeToGBP(row.city || '');
  const svcDate = row.lastServiceDate ? new Date(row.lastServiceDate) : null;
  const daysAgo = svcDate ? Math.max(0, Math.floor((Date.now() - svcDate.getTime()) / 86400000)) : 999;
  const askCount = Number(row.askCount) || 0;
  const stage = askCount >= 2 ? 'reminded' : askCount === 1 ? 'sms_sent' : 'not_contacted';
  const sentiment = 'happy'; // PR 1: default. Sentiment signal wiring is a later PR.
  const revenue = Number(row.lifetimeRevenue) || 0;
  const svc = row.lastService || 'General Pest Control';
  const score = calcScore(sentiment, daysAgo, revenue, stage, askCount, svc);
  const first = row.firstName || (row.name || '').split(' ')[0] || row.name;
  const addr = [row.addressLine1, row.city, row.zip].filter(Boolean).join(', ');

  return {
    id: row.id,
    name: row.name || `${row.firstName || ''} ${row.lastName || ''}`.trim() || 'Unknown',
    nameKey: (row.name || '').toLowerCase().replace(/[^a-z]/g, ''),
    first,
    addr,
    phone: row.phone || '',
    phoneF: fmtPh(row.phone || ''),
    email: '',
    lastDate: svcDate ? fmtDate(svcDate) : '—',
    lastSvc: svc,
    lastTech: 'Adam',
    sentiment, stage, score,
    gbpId: gbp.id, gbpName: gbp.name, reviewUrl: gbp.reviewUrl,
    revenue, daysAgo,
    jobs: [], sms: [], calls: [],
    askCount,
    lastAsked: row.lastAsked ? fmtDate(new Date(row.lastAsked)) : null,
    seqStep: stage === 'reminded' ? 2 : stage === 'sms_sent' ? 1 : 0,
    seqId: null, suppressed: false, suppressReason: null,
  };
}

// ── Shared styles ──
const tagColors = {
  acc: { bg: C.accG, color: C.acc },
  grn: { bg: C.grnG, color: C.grn },
  org: { bg: C.orgG, color: C.org },
  red: { bg: C.redG, color: C.red },
  blu: { bg: C.bluG, color: C.blu },
  pur: { bg: C.purG, color: C.pur },
};

function Tag({ type, children }) {
  const tc = tagColors[type] || tagColors.acc;
  return <span style={{ fontSize: 10, fontWeight: 600, padding: '3px 8px', borderRadius: 20, whiteSpace: 'nowrap', background: tc.bg, color: tc.color }}>{children}</span>;
}

function Btn({ variant = 'ghost', onClick, disabled, children, style: extra }) {
  const base = { display: 'inline-flex', alignItems: 'center', gap: 6, padding: '7px 14px', borderRadius: 8, fontFamily: C.sans, fontSize: 11, fontWeight: 600, cursor: disabled ? 'not-allowed' : 'pointer', border: 'none', transition: 'all .15s', whiteSpace: 'nowrap', opacity: disabled ? 0.5 : 1 };
  const variants = {
    primary: { background: C.acc, color: '#fff' },
    success: { background: C.grn, color: '#fff' },
    ghost: { background: 'transparent', border: `1px solid ${C.bdr}`, color: C.t2 },
    danger: { background: C.redG, color: C.red, border: '1px solid transparent' },
    warn: { background: C.orgG, color: C.org, border: '1px solid transparent' },
  };
  return <button onClick={onClick} disabled={disabled} style={{ ...base, ...variants[variant], ...extra }}>{children}</button>;
}

function SectionLabel({ children }) {
  return <div style={{ fontSize: 11, fontWeight: 600, color: C.t2, marginBottom: 6 }}>{children}</div>;
}

const isMobile = typeof window !== 'undefined' && window.innerWidth < 640;

// ══════════════════════════════════════════════════════════════
// MAIN COMPONENT
// ══════════════════════════════════════════════════════════════
export default function ReviewVelocityEngine() {
  const [page, setPage] = useState('dashboard');
  const [customers, setCustomers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);
  const [selectedIds, setSelectedIds] = useState(new Set());
  const [currentFilter, setCurrentFilter] = useState('all');
  const [pipeSearch, setPipeSearch] = useState('');
  const [activityLog, setActivityLog] = useState(() => {
    try { return JSON.parse(localStorage.getItem('wrev_activity_log') || '[]'); } catch { return []; }
  });
  const [supRules, setSupRules] = useState(SUP_RULES_DEFAULT);
  const [drawerCust, setDrawerCust] = useState(null);
  const [toast, setToast] = useState('');
  const [batchModal, setBatchModal] = useState(false);

  // Load real outreach candidates from the API — no demo fallback.
  const loadCandidates = useCallback(() => {
    setLoading(true);
    setLoadError(null);
    adminFetch('/admin/reviews/outreach-candidates')
      .then(d => {
        setCustomers((d.customers || []).map(apiToCustomer));
        setLoading(false);
      })
      .catch(err => {
        setLoadError(err?.message || 'Failed to load outreach candidates');
        setLoading(false);
      });
  }, []);

  useEffect(() => { loadCandidates(); }, [loadCandidates]);

  // Activity log persists locally for now (server-side log is PR 2).
  const saveState = useCallback((_custs, log) => {
    try {
      localStorage.setItem('wrev_activity_log', JSON.stringify((log || activityLog).slice(0, 200)));
    } catch (e) { /* ignore */ }
  }, [activityLog]);

  const addLog = useCallback((type, msg) => {
    const entry = { type, msg, time: new Date().toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) };
    setActivityLog(prev => {
      const next = [entry, ...prev].slice(0, 200);
      try { localStorage.setItem('wrev_activity_log', JSON.stringify(next)); } catch { /* ignore */ }
      return next;
    });
  }, []);

  const showToast = useCallback((text) => {
    setToast(text);
    setTimeout(() => setToast(''), 3500);
  }, []);

  const updateCustomer = useCallback((id, updates) => {
    setCustomers(prev => prev.map(c => c.id === id ? { ...c, ...updates } : c));
  }, []);

  // Send a real review request SMS via the server. Optimistic UI update on success.
  const sendReviewRequest = useCallback(async (customer) => {
    const svcType = customer.lastSvc;
    try {
      const res = await adminFetch('/admin/reviews/send-request', {
        method: 'POST',
        body: JSON.stringify({ customerId: customer.id, serviceType: svcType, techName: customer.lastTech }),
      });
      if (!res?.success) throw new Error(res?.error || 'Send failed');
      const newAsk = (customer.askCount || 0) + 1;
      const newStage = newAsk >= 2 ? 'reminded' : 'sms_sent';
      updateCustomer(customer.id, {
        askCount: newAsk,
        lastAsked: fmtDate(new Date()),
        stage: newStage,
        seqStep: Math.min((customer.seqStep || 0) + 1, 3),
      });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err?.message || 'Send failed' };
    }
  }, [updateCustomer]);

  // ── KPI calculations ──
  const eligible = useMemo(() => customers.filter(c => !c.suppressed && c.stage !== 'reviewed'), [customers]);
  const sent = useMemo(() => customers.filter(c => c.askCount > 0), [customers]);
  const reviewed = useMemo(() => customers.filter(c => c.stage === 'reviewed'), [customers]);
  const winback = useMemo(() => customers.filter(c => c.daysAgo >= 60 && c.askCount === 0 && !c.suppressed && c.stage !== 'issue'), [customers]);
  const queue = useMemo(() => eligible.filter(c => c.stage === 'not_contacted'), [eligible]);

  // ── Pipeline filtered list ──
  const pipelineList = useMemo(() => {
    let list = customers.filter(c => !c.suppressed);
    if (currentFilter === 'hot') list = list.filter(c => c.score >= 70 && c.stage === 'not_contacted');
    else if (currentFilter === 'winback') list = list.filter(c => c.daysAgo >= 60 && c.askCount === 0);
    else if (currentFilter !== 'all') list = list.filter(c => c.stage === currentFilter);
    if (pipeSearch) {
      const q = pipeSearch.toLowerCase();
      list = list.filter(c => c.name.toLowerCase().includes(q) || c.addr.toLowerCase().includes(q) || c.lastSvc.toLowerCase().includes(q));
    }
    return list.sort((a, b) => b.score - a.score);
  }, [customers, currentFilter, pipeSearch]);

  const tabs = [
    { key: 'dashboard', label: 'Dashboard' },
    { key: 'pipeline', label: 'Pipeline', count: pipelineList.length },
    { key: 'sequences', label: 'Sequences' },
    { key: 'templates', label: 'Templates' },
    { key: 'suppression', label: 'Suppression' },
    { key: 'log', label: 'Activity Log' },
  ];

  // ── Actions ──
  const quickSend = async (id) => {
    const c = customers.find(x => x.id === id);
    if (!c) return;
    if (!c.phone) { showToast(`No phone on file for ${c.name}`); return; }
    showToast(`Sending to ${c.name}...`);
    const result = await sendReviewRequest(c);
    if (result.ok) {
      addLog('sms', `Review request sent to ${c.name} → ${c.gbpName}`);
      showToast(`SMS sent to ${c.name}`);
    } else {
      addLog('stage', `Failed to send to ${c.name}: ${result.error}`);
      showToast(`Failed: ${result.error}`);
    }
  };

  // Manual stage override — in-memory only for PR 1 (stage is otherwise derived
  // from server askCount on next reload). PR 2 adds review_outreach_state table
  // for persisted overrides.
  const setStage = (id, stage) => {
    updateCustomer(id, { stage });
    const c = customers.find(x => x.id === id);
    addLog('stage', `${c?.name || 'Customer'} moved to ${STAGES[stage]?.label}`);
  };

  return (
    <div style={{ fontFamily: C.sans, color: C.t1 }}>
      {/* Nav tabs */}
      <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 20 }}>
        <div style={{ display: 'inline-flex', flexWrap: 'wrap', alignItems: 'center', gap: 4, background: '#F4F4F5', borderRadius: 10, padding: 4, border: '1px solid #E4E4E7' }}>
          {tabs.map(t => (
            <button key={t.key} onClick={() => setPage(t.key)} style={{
              padding: '10px 24px', borderRadius: 8, border: 'none', cursor: 'pointer',
              background: page === t.key ? '#18181B' : 'transparent',
              color: page === t.key ? '#FFFFFF' : '#A1A1AA',
              fontSize: 14, fontWeight: 700, transition: 'all 0.2s',
              fontFamily: "'DM Sans', sans-serif",
            }}>
              {t.label}
              {t.count !== undefined && (
                <span style={{
                  display: 'inline-flex', alignItems: 'center', justifyContent: 'center', minWidth: 18, height: 18,
                  borderRadius: 9, fontSize: 10, fontWeight: 700, padding: '0 5px', marginLeft: 6,
                  background: page === t.key ? 'rgba(255,255,255,0.2)' : '#E4E4E7', color: page === t.key ? '#FFFFFF' : '#A1A1AA',
                }}>{t.count}</span>
              )}
            </button>
          ))}
        </div>
      </div>

      {/* Load banner */}
      {loading && (
        <div style={{ padding: 14, border: `1px solid ${C.bdr}`, background: C.surface, borderRadius: 10, fontSize: 12, color: C.t2, marginBottom: 14 }}>
          Loading outreach candidates…
        </div>
      )}
      {loadError && (
        <div style={{ padding: 14, border: `1px solid ${C.red}`, background: C.redG, borderRadius: 10, fontSize: 12, color: C.red, marginBottom: 14, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span>Couldn't load candidates: {loadError}</span>
          <Btn onClick={loadCandidates}>Retry</Btn>
        </div>
      )}

      {/* Pages */}
      {page === 'dashboard' && (
        <Dashboard customers={customers} eligible={eligible} sent={sent} reviewed={reviewed} winback={winback} queue={queue} activityLog={activityLog} setPage={setPage} />
      )}
      {page === 'pipeline' && (
        <Pipeline
          customers={pipelineList} allCustomers={customers} selectedIds={selectedIds} setSelectedIds={setSelectedIds}
          currentFilter={currentFilter} setCurrentFilter={setCurrentFilter}
          pipeSearch={pipeSearch} setPipeSearch={setPipeSearch}
          setStage={setStage} quickSend={quickSend} setDrawerCust={setDrawerCust}
          setBatchModal={setBatchModal} addLog={addLog} showToast={showToast}
          updateCustomer={updateCustomer} saveState={saveState}
        />
      )}
      {page === 'sequences' && <SequencesPage customers={customers} />}
      {page === 'templates' && <TemplatesPage showToast={showToast} />}
      {page === 'suppression' && (
        <SuppressionPage customers={customers} supRules={supRules} setSupRules={setSupRules}
          updateCustomer={updateCustomer} showToast={showToast} saveState={saveState} />
      )}
      {page === 'log' && <ActivityLogPage activityLog={activityLog} setActivityLog={setActivityLog} saveState={saveState} />}

      {/* Customer Drawer */}
      {drawerCust && (
        <CustomerDrawer
          customer={drawerCust} onClose={() => setDrawerCust(null)}
          addLog={addLog} showToast={showToast}
          sendReviewRequest={sendReviewRequest}
        />
      )}

      {/* Batch Modal */}
      {batchModal && (
        <BatchModal
          selectedIds={selectedIds} customers={customers}
          onClose={() => setBatchModal(false)}
          addLog={addLog} showToast={showToast}
          setSelectedIds={setSelectedIds}
          sendReviewRequest={sendReviewRequest}
        />
      )}

      {/* Toast */}
      <div style={{
        position: 'fixed', bottom: 20, right: 20, background: C.surface, border: `1px solid ${C.grn}`,
        borderRadius: 8, padding: '10px 16px', display: 'flex', alignItems: 'center', gap: 8,
        boxShadow: '0 8px 32px rgba(0,0,0,.12)', zIndex: 300, fontSize: 12, fontWeight: 500,
        transform: toast ? 'translateY(0)' : 'translateY(80px)', opacity: toast ? 1 : 0, transition: 'all .3s',
        pointerEvents: 'none',
      }}>
        <span style={{ color: C.grn }}>✓</span>
        <span>{toast}</span>
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════
// DASHBOARD
// ══════════════════════════════════════════════════════════════
function Dashboard({ customers, eligible, sent, reviewed, winback, queue, activityLog, setPage }) {
  const kpis = [
    { label: 'In Pipeline', value: customers.length, desc: 'Active customers without a review', accent: C.acc },
    { label: 'Requests Sent', value: sent.length, desc: `${customers.length > 0 ? Math.round(sent.length / customers.length * 100) : 0}% of pipeline asked`, accent: C.grn },
    { label: 'In Queue', value: queue.length, desc: `${eligible.length} total eligible`, accent: C.org },
    { label: 'Win-Back Pool', value: winback.length, desc: 'Customers 60+ days, never asked', accent: C.blu },
  ];

  const svcTypes = [...new Set(customers.map(c => c.lastSvc))];

  return (
    <div>
      {/* KPIs */}
      <div style={{ marginBottom: 20 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
          <div style={{ fontSize: 15, fontWeight: 700 }}>Review Pipeline</div>
          <SectionLabel>Last 90 Days</SectionLabel>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: isMobile ? 'repeat(2, 1fr)' : 'repeat(4, 1fr)', gap: isMobile ? 8 : 12 }}>
          {kpis.map(k => (
            <div key={k.label} style={{ background: C.surface, border: `1px solid ${C.bdr}`, borderRadius: 12, padding: isMobile ? '12px 10px' : '16px 18px', position: 'relative', overflow: 'hidden' }}>
              <div style={{ position: 'absolute', top: 0, left: 0, right: 0, height: 2, background: k.accent }} />
              <div style={{ fontSize: 28, fontWeight: 800, marginBottom: 2 }}>{k.value}</div>
              <div style={{ fontSize: 11, fontWeight: 600, color: C.t2, marginBottom: 4 }}>{k.label}</div>
              <div style={{ fontSize: 11, color: C.t3 }}>{k.desc}</div>
            </div>
          ))}
        </div>
      </div>

      {/* GBP Cards */}
      <div style={{ marginBottom: 20 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
          <div style={{ fontSize: 15, fontWeight: 700 }}>Review Routing</div>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: isMobile ? 'repeat(2, 1fr)' : 'repeat(4, 1fr)', gap: isMobile ? 8 : 12 }}>
          {GBP_LOCATIONS.map(loc => {
            const locCusts = customers.filter(c => c.gbpId === loc.id);
            const locReviewed = locCusts.filter(c => c.stage === 'reviewed').length;
            const locSent = locCusts.filter(c => c.askCount > 0).length;
            const locQueue = locCusts.filter(c => !c.suppressed && c.stage === 'not_contacted').length;
            return (
              <div key={loc.id} onClick={() => setPage('pipeline')} style={{
                background: C.surface, border: `1px solid ${C.bdr}`, borderRadius: 12, padding: isMobile ? 14 : 18,
                cursor: 'pointer', transition: 'all .15s',
              }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: isMobile ? 10 : 14 }}>
                  <div style={{ fontSize: isMobile ? 13 : 14, fontWeight: 700 }}>{loc.name}</div>
                  <Tag type="acc">{locCusts.length} customers</Tag>
                </div>
                {/* Stat strip — 2×2 on phones, 4-col single row on desktop so each
                    number gets more horizontal space and reads cleanly at a glance. */}
                <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr 1fr' : 'repeat(4, 1fr)', gap: 8 }}>
                  {[
                    { v: locReviewed, l: 'Reviewed' },
                    { v: locSent, l: 'Asked' },
                    { v: locQueue, l: 'In Queue' },
                    { v: `${locSent > 0 ? Math.round(locReviewed / locSent * 100) : 0}%`, l: 'Conv Rate' },
                  ].map(s => (
                    <div key={s.l} style={{ textAlign: 'center', padding: '8px 4px', background: C.input, borderRadius: 8 }}>
                      <div style={{ fontSize: isMobile ? 14 : 16, fontWeight: 700, color: C.acc }}>{s.v}</div>
                      <div style={{ fontSize: 10, color: C.t3, marginTop: 2 }}>{s.l}</div>
                    </div>
                  ))}
                </div>
                <a
                  href={loc.reviewUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={(e) => e.stopPropagation()}
                  style={{
                    display: 'inline-block', fontSize: 11, color: C.t3, marginTop: 10,
                    textDecoration: 'none', borderBottom: `1px dotted ${C.bdr}`,
                  }}
                  title={loc.reviewUrl}
                >
                  Open review link ↗
                </a>
              </div>
            );
          })}
        </div>
      </div>

      {/* Review Velocity */}
      <div style={{ marginBottom: 20 }}>
        <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 10 }}>Review Velocity</div>
        <div style={{ display: 'grid', gridTemplateColumns: isMobile ? 'repeat(2, 1fr)' : 'repeat(3, 1fr)', gap: isMobile ? 8 : 10 }}>
          {svcTypes.map(svc => {
            const sc = customers.filter(c => c.lastSvc === svc);
            const rev = sc.filter(c => c.stage === 'reviewed').length;
            const asked = sc.filter(c => c.askCount > 0).length;
            return (
              <div key={svc} style={{ background: C.surface, border: `1px solid ${C.bdr}`, borderRadius: 12, padding: 14 }}>
                <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 6 }}>{svc}</div>
                <div style={{ display: 'flex', gap: 12 }}>
                  <div><span style={{ fontSize: 16, fontWeight: 700, color: C.acc }}>{sc.length}</span><div style={{ fontSize: 10, color: C.t3 }}>Jobs</div></div>
                  <div><span style={{ fontSize: 16, fontWeight: 700, color: C.grn }}>{rev}</span><div style={{ fontSize: 10, color: C.t3 }}>Reviews</div></div>
                  <div><span style={{ fontSize: 16, fontWeight: 700, color: C.org }}>{asked > 0 ? Math.round(rev / asked * 100) : 0}%</span><div style={{ fontSize: 10, color: C.t3 }}>Conv</div></div>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Recent Activity */}
      <div>
        <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 10 }}>Recent Activity</div>
        <ActivityList log={activityLog} max={8} />
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════
// PIPELINE
// ══════════════════════════════════════════════════════════════
function Pipeline({ customers, allCustomers, selectedIds, setSelectedIds, currentFilter, setCurrentFilter, pipeSearch, setPipeSearch, setStage, quickSend, setDrawerCust, setBatchModal, addLog, showToast, updateCustomer, saveState }) {
  const filters = [
    { key: 'all', label: 'All' },
    { key: 'hot', label: 'Hot Leads' },
    { key: 'not_contacted', label: 'Not Contacted' },
    { key: 'sms_sent', label: 'SMS Sent' },
    { key: 'reminded', label: 'Reminded' },
    { key: 'reviewed', label: 'Reviewed' },
    { key: 'issue', label: 'Issues' },
    { key: 'winback', label: 'Win-Back' },
  ];

  const toggleSel = (id) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const toggleAll = (checked) => {
    if (checked) {
      setSelectedIds(new Set(customers.map(c => c.id)));
    } else {
      setSelectedIds(new Set());
    }
  };

  const batchStage = (stage) => {
    selectedIds.forEach(id => setStage(id, stage));
    addLog('stage', `${selectedIds.size} customers moved to ${STAGES[stage]?.label}`);
    setSelectedIds(new Set());
  };

  // PR 1: suppression has no backing table yet. Drop in a later PR — no-op + toast.
  const batchSuppress = () => {
    showToast('Suppression persists in a later PR');
  };

  return (
    <div>
      <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 0 }}>Review Pipeline</div>

      {/* Filter bar */}
      <div style={{ display: 'flex', gap: 8, padding: '12px 0', borderBottom: `1px solid ${C.bdr}`, marginBottom: 12, flexWrap: 'wrap', alignItems: 'center' }}>
        <input
          value={pipeSearch} onChange={e => setPipeSearch(e.target.value)}
          placeholder="Search customers..."
          style={{ flex: 1, minWidth: 200, padding: '8px 12px', background: C.input, border: `1px solid ${C.bdr}`, borderRadius: 8, color: C.t1, fontFamily: C.sans, fontSize: 12, outline: 'none' }}
        />
        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
          {filters.map(f => (
            <button key={f.key} onClick={() => setCurrentFilter(f.key)} style={{
              padding: '6px 12px', fontSize: 12, fontWeight: 500,
              borderRadius: 20, border: `1px solid ${currentFilter === f.key ? C.bdrA : C.bdr}`,
              background: currentFilter === f.key ? C.acc : 'transparent',
              color: currentFilter === f.key ? '#fff' : C.t2, cursor: 'pointer', transition: 'all .15s',
            }}>{f.label}</button>
          ))}
        </div>
      </div>

      {/* Batch bar */}
      {selectedIds.size > 0 && (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '10px 16px', background: C.surface, border: `1px solid ${C.bdrA}`, borderRadius: 12, marginBottom: 12 }}>
          <span style={{ fontSize: 12, fontWeight: 700, color: C.acc }}>{selectedIds.size} selected</span>
          <div style={{ width: 1, height: 20, background: C.bdr }} />
          <Btn variant="primary" onClick={() => setBatchModal(true)}>📤 Batch Send</Btn>
          <Btn onClick={() => batchStage('sms_sent')}>Mark: SMS Sent</Btn>
          <Btn onClick={() => batchStage('reviewed')}>Mark: Reviewed</Btn>
          <Btn onClick={batchSuppress}>Suppress</Btn>
          <Btn onClick={() => setSelectedIds(new Set())}>Clear</Btn>
        </div>
      )}

      {/* Table */}
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr>
              <th style={thStyle}><input type="checkbox" onChange={e => toggleAll(e.target.checked)} style={{ accentColor: C.acc, cursor: 'pointer' }} /></th>
              <th style={thStyle}>Customer</th>
              <th style={thStyle}>Location / GBP</th>
              <th style={thStyle}>Score</th>
              <th style={thStyle}>Sentiment</th>
              <th style={thStyle}>Stage</th>
              <th style={thStyle}>Last Service</th>
              <th style={thStyle}>Seq Step</th>
              <th style={thStyle}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {customers.map(c => {
              const scoreColor = c.score >= 70 ? C.grn : c.score >= 40 ? C.org : C.red;
              const isSelected = selectedIds.has(c.id);
              return (
                <tr key={c.id} onDoubleClick={() => setDrawerCust(c)} style={{ background: isSelected ? C.accG : 'transparent', transition: 'background .1s', cursor: 'pointer' }}>
                  <td style={tdStyle}><input type="checkbox" checked={isSelected} onChange={() => toggleSel(c.id)} style={{ accentColor: C.acc, cursor: 'pointer' }} /></td>
                  <td style={tdStyle}>
                    <div style={{ fontWeight: 600, fontSize: 12 }}>{c.name}</div>
                    <div style={{ fontSize: 10, color: C.t3 }}>{c.addr.substring(0, 40)}</div>
                  </td>
                  <td style={tdStyle}><Tag type="acc">{c.gbpName}</Tag></td>
                  <td style={tdStyle}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <div style={{ height: 6, borderRadius: 3, minWidth: 4, width: `${c.score}%`, maxWidth: 80, background: scoreColor, transition: 'width .3s' }} />
                      <span style={{ fontSize: 11, fontWeight: 700, color: scoreColor }}>{c.score}</span>
                    </div>
                  </td>
                  <td style={tdStyle}>
                    <Tag type={c.sentiment === 'happy' ? 'grn' : c.sentiment === 'issue' ? 'red' : 'org'}>{c.sentiment}</Tag>
                  </td>
                  <td style={tdStyle}>
                    <select
                      value={c.stage} onChange={e => setStage(c.id, e.target.value)}
                      style={{ fontSize: 11, padding: '4px 10px', borderRadius: 8, border: `1px solid ${C.bdr}`, background: C.input, color: C.t2, cursor: 'pointer', outline: 'none' }}
                    >
                      {Object.entries(STAGES).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
                    </select>
                  </td>
                  <td style={tdStyle}>
                    <div style={{ fontSize: 11 }}>{c.lastSvc}</div>
                    <div style={{ fontSize: 10, color: C.t3 }}>{c.lastDate} · {c.daysAgo}d ago</div>
                  </td>
                  <td style={tdStyle}>
                    {c.seqStep > 0 ? <Tag type="blu">Step {c.seqStep}/3</Tag> : <span style={{ color: C.t3, fontSize: 10 }}>—</span>}
                  </td>
                  <td style={{ ...tdStyle, whiteSpace: 'nowrap' }}>
                    <Btn onClick={() => setDrawerCust(c)} style={{ padding: '4px 8px', fontSize: 10 }}>View</Btn>{' '}
                    <Btn variant="primary" onClick={() => quickSend(c.id)} style={{ padding: '4px 8px', fontSize: 10 }}>📤</Btn>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {customers.length === 0 && (
          <div style={{ padding: 40, textAlign: 'center', color: C.t3, fontSize: 13 }}>No customers match your filters</div>
        )}
      </div>
    </div>
  );
}

const thStyle = { fontSize: 11, fontWeight: 600, color: C.t2, textAlign: 'left', padding: '8px 10px', borderBottom: `1px solid ${C.bdr}` };
const tdStyle = { padding: '10px', borderBottom: `1px solid ${C.bdr}`, fontSize: 12, verticalAlign: 'middle' };

// ══════════════════════════════════════════════════════════════
// SEQUENCES
// ══════════════════════════════════════════════════════════════
function SequencesPage({ customers }) {
  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <div style={{ fontSize: 15, fontWeight: 700 }}>Follow-Up Sequences</div>
      </div>
      {SEQUENCES.map(seq => (
        <div key={seq.id} style={{ background: C.surface, border: `1px solid ${C.bdr}`, borderRadius: 12, padding: 16, marginBottom: 10 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
            <div style={{ fontSize: 14, fontWeight: 700 }}>{seq.name}</div>
            <Tag type="acc">{seq.id}</Tag>
          </div>
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 0, padding: '10px 0' }}>
            {seq.steps.map((step, i) => (
              <div key={i} style={{ flex: 1, minWidth: 100, display: 'flex', flexDirection: 'column', alignItems: 'center', position: 'relative' }}>
                <div style={{
                  width: 32, height: 32, borderRadius: '50%', display: 'grid', placeItems: 'center', fontSize: 14,
                  border: `2px solid ${C.acc}`, background: C.accG, zIndex: 1,
                }}>{step.icon}</div>
                {i < seq.steps.length - 1 && (
                  <div style={{ position: 'absolute', top: 16, left: 'calc(50% + 16px)', width: 'calc(100% - 32px)', height: 2, background: C.bdr }} />
                )}
                <div style={{ fontSize: 11, fontWeight: 500, color: C.t2, marginTop: 6, textAlign: 'center' }}>{step.label}</div>
                <div style={{ fontSize: 11, color: C.acc, marginTop: 2 }}>{step.day === 0 ? 'Immediate' : `Day ${step.day}`}</div>
                <div style={{ fontSize: 10, color: C.t3, marginTop: 2 }}>{step.template}</div>
              </div>
            ))}
          </div>
          <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
            <Btn style={{ fontSize: 10 }}>Edit Steps</Btn>
            <Btn style={{ fontSize: 10 }}>{customers.filter(c => c.seqId === seq.id).length} customers enrolled</Btn>
          </div>
        </div>
      ))}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════
// TEMPLATES
// ══════════════════════════════════════════════════════════════
function TemplatesPage({ showToast }) {
  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <div style={{ fontSize: 15, fontWeight: 700 }}>Message Templates</div>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 10 }}>
        {TEMPLATES.map(t => (
          <div key={t.id} onClick={() => showToast(`Template: ${t.name}`)} style={{
            background: C.surface, border: `1px solid ${C.bdr}`, borderRadius: 12, padding: 14,
            cursor: 'pointer', transition: 'all .15s',
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
              <div style={{ fontSize: 12, fontWeight: 600 }}>{t.name}</div>
              <Tag type={t.sentiment === 'happy' ? 'grn' : t.sentiment === 'issue' ? 'red' : 'org'}>{t.sentiment}</Tag>
            </div>
            <div style={{ fontSize: 11, color: C.t3, lineHeight: 1.6, whiteSpace: 'pre-wrap', maxHeight: 80, overflow: 'hidden' }}>{t.body}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════
// SUPPRESSION
// ══════════════════════════════════════════════════════════════
function SuppressionPage({ customers, supRules, setSupRules, updateCustomer, showToast }) {
  const suppressed = customers.filter(c => c.suppressed);

  const toggleRule = (id) => {
    setSupRules(prev => prev.map(r => r.id === id ? { ...r, enabled: !r.enabled } : r));
  };

  const unsuppress = (id) => {
    const c = customers.find(x => x.id === id);
    updateCustomer(id, { suppressed: false, suppressReason: null });
    showToast(`${c?.name || 'Customer'} restored to pipeline`);
  };

  return (
    <div>
      <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 16 }}>Suppression Rules & Do-Not-Ask List</div>

      <div style={{ marginBottom: 16 }}>
        <SectionLabel>Auto-Suppression Rules</SectionLabel>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 8, marginTop: 10 }}>
          {supRules.map(r => (
            <div key={r.id} style={{ background: C.surface, border: `1px solid ${C.bdr}`, borderRadius: 12, padding: 12, display: 'flex', alignItems: 'flex-start', gap: 10 }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 2 }}>{r.label}</div>
                <div style={{ fontSize: 10, color: C.t3 }}>{r.desc}</div>
              </div>
              <label style={{ position: 'relative', display: 'inline-block', width: 36, height: 20, flexShrink: 0, cursor: 'pointer' }}>
                <input type="checkbox" checked={r.enabled} onChange={() => toggleRule(r.id)} style={{ opacity: 0, width: 0, height: 0, position: 'absolute' }} />
                <span style={{ position: 'absolute', cursor: 'pointer', inset: 0, background: r.enabled ? C.acc : C.bdr, borderRadius: 20, transition: '.2s' }} />
                <span style={{ position: 'absolute', left: r.enabled ? 18 : 2, top: 2, width: 16, height: 16, background: 'white', borderRadius: '50%', transition: '.2s' }} />
              </label>
            </div>
          ))}
        </div>
      </div>

      <div>
        <SectionLabel>Manually Suppressed Customers</SectionLabel>
        <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: 10 }}>
          <thead>
            <tr>
              <th style={thStyle}>Customer</th>
              <th style={thStyle}>Reason</th>
              <th style={thStyle}>Suppressed</th>
              <th style={thStyle}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {suppressed.length > 0 ? suppressed.map(c => (
              <tr key={c.id}>
                <td style={{ ...tdStyle, fontWeight: 500 }}>{c.name}</td>
                <td style={tdStyle}><Tag type="red">{c.suppressReason || 'Manual'}</Tag></td>
                <td style={{ ...tdStyle, fontSize: 11, color: C.t3 }}>—</td>
                <td style={tdStyle}><Btn onClick={() => unsuppress(c.id)} style={{ padding: '3px 8px', fontSize: 10 }}>Restore</Btn></td>
              </tr>
            )) : (
              <tr><td colSpan={4} style={{ color: C.t3, textAlign: 'center', padding: 20 }}>No suppressed customers</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════
// ACTIVITY LOG
// ══════════════════════════════════════════════════════════════
function ActivityLogPage({ activityLog, setActivityLog, saveState }) {
  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <div style={{ fontSize: 15, fontWeight: 700 }}>Activity Log</div>
        <Btn onClick={() => { setActivityLog([]); saveState(undefined, []); }}>Clear</Btn>
      </div>
      <ActivityList log={activityLog} max={100} />
    </div>
  );
}

function ActivityList({ log, max }) {
  if (!log.length) return <p style={{ color: C.t3, padding: 20, textAlign: 'center', fontSize: 12 }}>No activity yet. Send your first review request!</p>;

  const iconMap = { sms: { bg: C.grnG, color: C.grn, icon: '💬' }, call: { bg: C.bluG, color: C.blu, icon: '📞' }, batch: { bg: C.purG, color: C.pur, icon: '📤' }, stage: { bg: C.orgG, color: C.org, icon: '📋' } };

  return (
    <div style={{ maxHeight: 300, overflowY: 'auto' }}>
      {log.slice(0, max).map((l, i) => {
        const ic = iconMap[l.type] || iconMap.stage;
        return (
          <div key={i} style={{ display: 'flex', gap: 10, padding: '10px 0', borderBottom: `1px solid ${C.bdr}` }}>
            <div style={{ width: 28, height: 28, borderRadius: '50%', display: 'grid', placeItems: 'center', fontSize: 12, flexShrink: 0, background: ic.bg, color: ic.color }}>{ic.icon}</div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 12, lineHeight: 1.5 }}>{l.msg}</div>
              <div style={{ fontSize: 10, color: C.t3, marginTop: 2 }}>{l.time}</div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════
// CUSTOMER DRAWER
// ══════════════════════════════════════════════════════════════
function CustomerDrawer({ customer, onClose, addLog, showToast, sendReviewRequest }) {
  const [msg, setMsg] = useState('');
  const [selectedTpl, setSelectedTpl] = useState('');
  const [sending, setSending] = useState(false);
  const c = customer;

  const applyTpl = (tplId) => {
    setSelectedTpl(tplId);
    const tpl = TEMPLATES.find(t => t.id === tplId);
    if (tpl) setMsg(hydrate(tpl.body, c));
  };

  // Fires the server's canonical review-request flow (NPS gate + rate page link).
  // Composed message is ignored by the server for PR 1 — it always sends the
  // canonical template. Custom message body ships in PR 3 with templates table.
  const sendSms = async () => {
    if (!c.phone) { showToast('No phone on file'); return; }
    setSending(true);
    const result = await sendReviewRequest(c);
    setSending(false);
    if (result.ok) {
      addLog('sms', `Review request sent to ${c.name} → ${c.gbpName}`);
      showToast(`SMS sent to ${c.name}`);
      setMsg('');
    } else {
      showToast(`Failed: ${result.error}`);
    }
  };

  const startSequence = () => {
    showToast('Sequences ship in a later PR — send manually for now');
  };

  const scoreColor = c.score >= 70 ? C.grn : c.score >= 40 ? C.org : C.red;
  const gbp = GBP_LOCATIONS.find(l => l.id === c.gbpId);
  const filteredTpls = TEMPLATES.filter(t => t.sentiment === c.sentiment || t.sentiment === 'neutral' || c.sentiment === 'neutral');

  return (
    <div style={{
      position: 'fixed', top: 0, right: 0, width: 520, height: '100vh', background: C.surface,
      borderLeft: `1px solid ${C.bdrA}`, zIndex: 150, overflowY: 'auto',
      boxShadow: '-8px 0 32px rgba(0,0,0,.1)',
    }}>
      {/* Header */}
      <div style={{ padding: '16px 20px', borderBottom: `1px solid ${C.bdr}`, display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', position: 'sticky', top: 0, background: C.surface, zIndex: 1 }}>
        <div>
          <h2 style={{ fontSize: 18, fontWeight: 700, marginBottom: 4, margin: 0, color: C.heading }}>{c.name}</h2>
          <div style={{ fontSize: 11, color: C.t2 }}>{c.addr} · {c.lastSvc} · {c.daysAgo} days ago</div>
          <div style={{ fontSize: 11, color: C.acc, marginTop: 2 }}>{c.phoneF || 'No phone'}</div>
        </div>
        <button onClick={onClose} style={{ background: 'none', border: 'none', color: C.t3, fontSize: 18, cursor: 'pointer', padding: 4 }}>✕</button>
      </div>

      <div style={{ padding: '16px 20px' }}>
        {/* Score */}
        <DrawerSection title="Review Score Breakdown">
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
            <div style={{ fontSize: 32, fontWeight: 800, color: scoreColor }}>{c.score}</div>
            <div style={{ flex: 1, height: 8, background: C.input, borderRadius: 4, overflow: 'hidden' }}>
              <div style={{ width: `${c.score}%`, height: '100%', background: scoreColor, borderRadius: 4 }} />
            </div>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 4, fontSize: 11 }}>
            {[
              { l: 'Sentiment', v: <Tag type={c.sentiment === 'happy' ? 'grn' : c.sentiment === 'issue' ? 'red' : 'org'}>{c.sentiment}</Tag> },
              { l: 'Recency', v: `${c.daysAgo}d ago` },
              { l: 'Revenue', v: `$${c.revenue}` },
              { l: 'Times Asked', v: c.askCount },
              { l: 'Stage', v: STAGES[c.stage]?.label },
              { l: 'Last Asked', v: c.lastAsked || 'Never' },
            ].map(r => (
              <div key={r.l} style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0' }}>
                <span style={{ color: C.t3 }}>{r.l}</span>
                <span style={{ fontWeight: 500 }}>{r.v}</span>
              </div>
            ))}
          </div>
        </DrawerSection>

        {/* GBP */}
        <DrawerSection title="GBP Assignment">
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: 8, background: C.input, borderRadius: 8, border: `1px solid ${C.bdr}` }}>
            <Tag type="acc">{gbp?.name || c.gbpId}</Tag>
            <span style={{ fontSize: 10, color: C.t3, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis' }}>{c.reviewUrl}</span>
          </div>
        </DrawerSection>

        {/* Service History */}
        <DrawerSection title="Service History">
          {c.jobs.length > 0 ? c.jobs.map((j, i) => (
            <div key={i} style={{ padding: '6px 0', borderBottom: `1px solid ${C.bdr}`, fontSize: 11 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span style={{ fontWeight: 600 }}>{j.svcType}</span>
                <span style={{ fontSize: 10, color: C.t3 }}>{j.date}</span>
              </div>
              {j.notes && <div style={{ color: C.t3, marginTop: 2 }}>{j.notes}</div>}
              <div style={{ fontSize: 10, color: C.t3, marginTop: 2 }}>{j.tech} · ${j.revenue}</div>
            </div>
          )) : <p style={{ color: C.t3, fontSize: 11 }}>No service records</p>}
        </DrawerSection>

        {/* Recent SMS */}
        <DrawerSection title="Recent SMS">
          {c.sms.length > 0 ? c.sms.slice(-5).map((m, i) => (
            <div key={i} style={{ background: C.input, border: `1px solid ${C.bdr}`, borderRadius: 8, padding: '8px 10px', marginBottom: 4, fontSize: 11, lineHeight: 1.5 }}>
              <div style={{ fontSize: 10, color: C.t3, marginBottom: 2 }}>{m.date} {m.dir === 'out' ? '→ Sent' : '← Received'}</div>
              {m.text}
            </div>
          )) : <p style={{ color: C.t3, fontSize: 11 }}>No SMS history</p>}
        </DrawerSection>

        {/* Send Review Request */}
        <DrawerSection title="Send Review Request">
          <div style={{ background: C.input, border: `1px solid ${C.bdr}`, borderRadius: 12, padding: 12 }}>
            <SectionLabel>Select Template</SectionLabel>
            <select value={selectedTpl} onChange={e => applyTpl(e.target.value)} style={{
              width: '100%', padding: '6px 8px', background: C.bg, border: `1px solid ${C.bdr}`, borderRadius: 8,
              color: C.t1, fontSize: 11, marginBottom: 8, outline: 'none',
            }}>
              <option value="">Select a template...</option>
              {filteredTpls.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
            <textarea
              value={msg} onChange={e => setMsg(e.target.value)}
              placeholder="Compose review request..."
              style={{
                width: '100%', padding: 8, background: C.bg, border: `1px solid ${C.bdr}`, borderRadius: 8,
                color: C.t1, fontFamily: C.sans, fontSize: 12, resize: 'none', minHeight: 80, outline: 'none', boxSizing: 'border-box',
              }}
            />
            <div style={{ fontSize: 10, color: C.t3, marginTop: 6, lineHeight: 1.5 }}>
              Template is preview-only for now. The send uses the canonical review-request flow with a rating link that routes happy customers to Google and issues to a recovery inbox.
            </div>
            <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
              <Btn variant="success" onClick={sendSms} disabled={sending || !c.phone}>{sending ? 'Sending…' : '📤 Send Review Request'}</Btn>
              <Btn variant="primary" onClick={() => { addLog('call', `Call initiated to ${c.name} at ${c.phoneF}`); showToast(`Calling ${c.name}...`); }}>📞 Call</Btn>
              <Btn onClick={startSequence}>🔄 Start Sequence</Btn>
            </div>
          </div>
        </DrawerSection>
      </div>
    </div>
  );
}

function DrawerSection({ title, children }) {
  return (
    <div style={{ marginBottom: 16 }}>
      <div style={{ fontSize: 12, fontWeight: 600, color: C.t2, marginBottom: 8, paddingBottom: 4, borderBottom: `1px solid ${C.bdr}` }}>{title}</div>
      {children}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════
// BATCH MODAL
// ══════════════════════════════════════════════════════════════
function BatchModal({ selectedIds, customers, onClose, addLog, showToast, setSelectedIds, sendReviewRequest }) {
  const [tplId, setTplId] = useState(TEMPLATES[0].id);
  const [stagger, setStagger] = useState('0');
  const [sending, setSending] = useState(false);
  const [progress, setProgress] = useState({ done: 0, total: 0 });

  // PR 1: stagger is cosmetic (all sends fire immediately). True scheduler ships in PR 5.
  const confirm = async () => {
    const targets = [...selectedIds]
      .map(id => customers.find(x => x.id === id))
      .filter(c => c && c.phone);
    if (targets.length === 0) { showToast('No eligible customers with phone'); return; }
    setSending(true);
    setProgress({ done: 0, total: targets.length });
    let ok = 0, fail = 0;
    for (let i = 0; i < targets.length; i++) {
      const result = await sendReviewRequest(targets[i]);
      if (result.ok) ok++; else fail++;
      setProgress({ done: i + 1, total: targets.length });
    }
    setSending(false);
    addLog('batch', `Batch review request — ${ok} sent, ${fail} failed`);
    showToast(fail === 0 ? `${ok} review requests sent` : `${ok} sent · ${fail} failed`);
    setSelectedIds(new Set());
    onClose();
  };

  const happyTpls = TEMPLATES.filter(t => t.sentiment === 'happy' || t.sentiment === 'neutral');

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.65)', zIndex: 200, display: 'grid', placeItems: 'center', backdropFilter: 'blur(6px)' }} onClick={onClose}>
      <div onClick={e => e.stopPropagation()} style={{ background: C.surface, border: `1px solid ${C.bdrA}`, borderRadius: 16, padding: 24, minWidth: 440, maxWidth: 560, boxShadow: '0 24px 64px rgba(0,0,0,.12)' }}>
        <h3 style={{ fontSize: 16, fontWeight: 700, marginBottom: 6, margin: 0, color: C.heading }}>📤 Batch Send Review Requests</h3>
        <p style={{ fontSize: 12, color: C.t2, lineHeight: 1.6, marginBottom: 14 }}>
          You're about to send personalized review request SMS to <strong>{selectedIds.size}</strong> customers.
          Each message will be personalized with their name and routed to the correct GBP link.
        </p>

        <div style={{ marginBottom: 12 }}>
          <SectionLabel>Stagger Delivery</SectionLabel>
          <select value={stagger} onChange={e => setStagger(e.target.value)} style={{
            width: '100%', padding: 8, background: C.input, border: `1px solid ${C.bdr}`, borderRadius: 8,
            color: C.t1, fontSize: 12, outline: 'none',
          }}>
            <option value="0">Send all immediately</option>
            <option value="5">Every 5 minutes</option>
            <option value="15">Every 15 minutes</option>
            <option value="30">Every 30 minutes</option>
            <option value="60">Every hour</option>
          </select>
        </div>

        <div style={{ marginBottom: 12 }}>
          <SectionLabel>Template</SectionLabel>
          <select value={tplId} onChange={e => setTplId(e.target.value)} style={{
            width: '100%', padding: 8, background: C.input, border: `1px solid ${C.bdr}`, borderRadius: 8,
            color: C.t1, fontSize: 12, outline: 'none',
          }}>
            {happyTpls.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
        </div>

        {sending && (
          <div style={{ fontSize: 12, color: C.t2, padding: '10px 12px', background: C.input, borderRadius: 8, marginTop: 8 }}>
            Sending… {progress.done}/{progress.total}
          </div>
        )}
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 16 }}>
          <Btn onClick={onClose} disabled={sending}>Cancel</Btn>
          <Btn variant="success" onClick={confirm} disabled={sending}>{sending ? 'Sending…' : 'Confirm & Send'}</Btn>
        </div>
      </div>
    </div>
  );
}
