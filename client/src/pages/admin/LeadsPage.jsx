import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';

const API_BASE = import.meta.env.VITE_API_URL || '/api';

function adminFetch(path, opts = {}) {
  return fetch(`${API_BASE}${path}`, {
    ...opts,
    headers: {
      Authorization: `Bearer ${localStorage.getItem('waves_admin_token')}`,
      'Content-Type': 'application/json',
      ...opts.headers,
    },
    body: opts.body ? (typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body)) : undefined,
  }).then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); });
}

const C = {
  bg: '#0f1923', card: '#1e293b', cardHover: '#263548', border: '#334155',
  text: '#e2e8f0', muted: '#94a3b8', teal: '#0ea5e9', green: '#10b981',
  amber: '#f59e0b', red: '#ef4444', purple: '#a855f7', white: '#ffffff',
};
const mono = { fontFamily: "'JetBrains Mono', monospace" };

const STATUS_COLORS = {
  new: C.teal, contacted: C.amber, estimate_sent: C.purple,
  estimate_viewed: C.purple, negotiating: C.amber, won: C.green,
  lost: C.red, unresponsive: C.muted, disqualified: C.red, duplicate: C.muted,
};
const STATUSES = ['new','contacted','estimate_sent','estimate_viewed','negotiating','won','lost','unresponsive','disqualified','duplicate'];
const LEAD_TYPES = ['inbound_call','inbound_sms','form_submission','chat_widget','walk_in','referral','ai_agent','voicemail','email_inquiry'];

function Badge({ label, color, style }) {
  return <span style={{ display:'inline-block', padding:'2px 10px', borderRadius:9999, fontSize:11, fontWeight:600,
    backgroundColor:color+'22', color, border:`1px solid ${color}44`, whiteSpace:'nowrap', ...style }}>{label}</span>;
}

function Card({ children, style, onClick }) {
  return <div onClick={onClick} style={{ backgroundColor:C.card, borderRadius:12, border:`1px solid ${C.border}`,
    padding:20, cursor:onClick?'pointer':undefined, ...style }}>{children}</div>;
}

function MetricCard({ label, value, sub, color }) {
  return <Card style={{ flex:'1 1 180px', minWidth:160 }}>
    <div style={{ fontSize:12, color:C.muted, marginBottom:4 }}>{label}</div>
    <div style={{ fontSize:26, fontWeight:700, color:color||C.white, ...mono }}>{value}</div>
    {sub && <div style={{ fontSize:11, color:C.muted, marginTop:2 }}>{sub}</div>}
  </Card>;
}

function TabBar({ tabs, active, onChange }) {
  return <div style={{ display:'flex', gap:4, marginBottom:24, borderBottom:`1px solid ${C.border}`, flexWrap:'wrap' }}>
    {tabs.map(t => <button key={t.key} onClick={()=>onChange(t.key)} style={{
      padding:'10px 20px', background:'none', border:'none', color:active===t.key?C.teal:C.muted,
      fontSize:14, fontWeight:600, cursor:'pointer', borderBottom:active===t.key?`2px solid ${C.teal}`:'2px solid transparent',
      marginBottom:-1, transition:'all 0.2s',
    }}>{t.label}</button>)}
  </div>;
}

function Btn({ children, onClick, color, small, style, disabled }) {
  return <button onClick={onClick} disabled={disabled} style={{
    padding:small?'4px 12px':'8px 16px', borderRadius:8, border:'none', cursor:disabled?'not-allowed':'pointer',
    backgroundColor:color||C.teal, color:C.white, fontSize:small?12:13, fontWeight:600, opacity:disabled?0.5:1,
    transition:'opacity 0.2s', ...style,
  }}>{children}</button>;
}

function Input({ label, value, onChange, type, placeholder, style, options }) {
  const base = { backgroundColor:'#0f1923', border:`1px solid ${C.border}`, borderRadius:8, padding:'8px 12px',
    color:C.text, fontSize:13, width:'100%', outline:'none', boxSizing:'border-box', ...style };
  return <div style={{ marginBottom:12 }}>
    {label && <label style={{ fontSize:12, color:C.muted, display:'block', marginBottom:4 }}>{label}</label>}
    {options ? <select value={value||''} onChange={e=>onChange(e.target.value)} style={base}>
      <option value="">-- Select --</option>
      {options.map(o => <option key={o.value||o} value={o.value||o}>{o.label||o}</option>)}
    </select> : <input type={type||'text'} value={value||''} onChange={e=>onChange(e.target.value)} placeholder={placeholder} style={base} />}
  </div>;
}

function Modal({ title, onClose, children }) {
  return <div style={{ position:'fixed', inset:0, backgroundColor:'rgba(0,0,0,0.6)', display:'flex', alignItems:'center',
    justifyContent:'center', zIndex:1000 }} onClick={onClose}>
    <div onClick={e=>e.stopPropagation()} style={{ backgroundColor:C.card, borderRadius:16, border:`1px solid ${C.border}`,
      padding:24, maxWidth:520, width:'90%', maxHeight:'80vh', overflowY:'auto' }}>
      <div style={{ display:'flex', justifyContent:'space-between', marginBottom:16 }}>
        <h3 style={{ margin:0, color:C.white, fontSize:18 }}>{title}</h3>
        <button onClick={onClose} style={{ background:'none', border:'none', color:C.muted, cursor:'pointer', fontSize:20 }}>x</button>
      </div>
      {children}
    </div>
  </div>;
}

function fmtMoney(v) { return v != null ? '$' + Number(v).toLocaleString('en-US',{minimumFractionDigits:0,maximumFractionDigits:0}) : '--'; }
function fmtPct(v) { return v != null ? v.toFixed(1) + '%' : '--'; }
function fmtTime(min) {
  if (min == null) return '--';
  if (min < 60) return min + 'm';
  if (min < 1440) return Math.round(min/60) + 'h';
  return Math.round(min/1440) + 'd';
}
function roiColor(roi) { return roi > 200 ? C.green : roi > 50 ? C.amber : C.red; }

// ═══════════════════════════════════════════════════════════════════════════
// SPEED-TO-LEAD TIMER
// ═══════════════════════════════════════════════════════════════════════════

// Inject pulse keyframe once
if (typeof document !== 'undefined' && !document.getElementById('speed-to-lead-pulse')) {
  const style = document.createElement('style');
  style.id = 'speed-to-lead-pulse';
  style.textContent = `@keyframes stlPulse { 0%,100%{opacity:1} 50%{opacity:0.4} }`;
  document.head.appendChild(style);
}

function SpeedToLeadTimer({ firstContactAt }) {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (!firstContactAt) return;
    const start = new Date(firstContactAt).getTime();
    const tick = () => setElapsed(Math.floor((Date.now() - start) / 1000));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [firstContactAt]);

  const mins = Math.floor(elapsed / 60);
  const secs = elapsed % 60;
  const mm = String(mins).padStart(2, '0');
  const ss = String(secs).padStart(2, '0');
  const color = mins < 5 ? C.green : mins < 15 ? C.amber : C.red;
  const shouldPulse = mins >= 5;

  return <span style={{
    ...mono, fontSize: 13, color, fontWeight: 600,
    animation: shouldPulse ? 'stlPulse 1.5s ease-in-out infinite' : 'none',
  }}>{mm}:{ss}</span>;
}

const LOST_REASONS = [
  { value: 'price', label: 'Price too high' },
  { value: 'competitor', label: 'Chose competitor' },
  { value: 'diy', label: 'DIY / self-treating' },
  { value: 'not_ready', label: 'Not ready yet' },
  { value: 'no_response', label: 'No response' },
  { value: 'out_of_area', label: 'Out of service area' },
  { value: 'no_need', label: 'No longer needed' },
  { value: 'other', label: 'Other' },
];

// ═══════════════════════════════════════════════════════════════════════════
// MAIN COMPONENT
// ═══════════════════════════════════════════════════════════════════════════
export default function LeadsPage() {
  const navigate = useNavigate();
  const [tab, setTab] = useState('pipeline');
  const [smsCompose, setSmsCompose] = useState(null); // { leadId, message }
  const [callbackForm, setCallbackForm] = useState(null); // { leadId, date, time, notes }
  const [smsSending, setSmsSending] = useState(false);
  const [leads, setLeads] = useState([]);
  const [leadsTotal, setLeadsTotal] = useState(0);
  const [sources, setSources] = useState([]);
  const [campaigns, setCampaigns] = useState([]);
  const [overview, setOverview] = useState(null);
  const [funnel, setFunnel] = useState([]);
  const [bySource, setBySource] = useState([]);
  const [byChannel, setByChannel] = useState([]);
  const [responseBuckets, setResponseBuckets] = useState([]);
  const [lostReasons, setLostReasons] = useState([]);
  const [expandedLead, setExpandedLead] = useState(null);
  const [leadActivities, setLeadActivities] = useState([]);
  const [showModal, setShowModal] = useState(null);
  const [formData, setFormData] = useState({});
  const [filters, setFilters] = useState({ status:'', search:'', sort:'first_contact_at', page:1 });
  const [loading, setLoading] = useState(false);
  const [techs, setTechs] = useState([]);

  const loadLeads = useCallback(async () => {
    try {
      const params = new URLSearchParams();
      if (filters.status) params.set('status', filters.status);
      if (filters.search) params.set('search', filters.search);
      params.set('sort', filters.sort);
      params.set('page', filters.page);
      params.set('limit', '50');
      const data = await adminFetch(`/admin/leads?${params}`);
      setLeads(data.leads || []);
      setLeadsTotal(data.total || 0);
    } catch (e) { console.error('loadLeads', e); }
  }, [filters]);

  const loadSources = useCallback(async () => {
    try {
      const data = await adminFetch('/admin/leads/sources');
      setSources(data.sources || []);
    } catch (e) { console.error('loadSources', e); }
  }, []);

  const loadCampaigns = useCallback(async () => {
    try {
      const data = await adminFetch('/admin/leads/campaigns');
      setCampaigns(data.campaigns || []);
    } catch (e) { console.error('loadCampaigns', e); }
  }, []);

  const loadAnalytics = useCallback(async () => {
    try {
      const [ov, fn, bs, bc, rb, lr] = await Promise.all([
        adminFetch('/admin/leads/analytics/overview'),
        adminFetch('/admin/leads/analytics/funnel'),
        adminFetch('/admin/leads/analytics/by-source'),
        adminFetch('/admin/leads/analytics/by-channel'),
        adminFetch('/admin/leads/analytics/response'),
        adminFetch('/admin/leads/analytics/lost'),
      ]);
      setOverview(ov);
      setFunnel(fn.funnel || []);
      setBySource(bs.sources || []);
      setByChannel(bc.channels || []);
      setResponseBuckets(rb.buckets || []);
      setLostReasons(lr.reasons || []);
    } catch (e) { console.error('loadAnalytics', e); }
  }, []);

  const loadTechs = useCallback(async () => {
    try {
      const data = await adminFetch('/admin/customers?limit=1');
      // Try fetching technicians directly
      const t = await adminFetch('/admin/dispatch/technicians').catch(() => ({ technicians: [] }));
      setTechs(t.technicians || []);
    } catch (e) { setTechs([]); }
  }, []);

  useEffect(() => { loadTechs(); }, [loadTechs]);

  useEffect(() => {
    if (tab === 'pipeline') { loadLeads(); loadAnalytics(); }
    if (tab === 'sources') loadSources();
    if (tab === 'campaigns') loadCampaigns();
    if (tab === 'analytics') loadAnalytics();
  }, [tab, loadLeads, loadSources, loadCampaigns, loadAnalytics]);

  const expandLead = async (lead) => {
    if (expandedLead === lead.id) { setExpandedLead(null); return; }
    setExpandedLead(lead.id);
    try {
      const data = await adminFetch(`/admin/leads/${lead.id}`);
      setLeadActivities(data.activities || []);
    } catch (e) { setLeadActivities([]); }
  };

  const updateLeadStatus = async (leadId, status) => {
    try {
      await adminFetch(`/admin/leads/${leadId}`, { method:'PUT', body:{ status } });
      loadLeads();
    } catch (e) { console.error(e); }
  };

  const submitForm = async () => {
    setLoading(true);
    try {
      if (showModal === 'newLead') {
        await adminFetch('/admin/leads', { method:'POST', body:formData });
        loadLeads();
      } else if (showModal === 'newSource') {
        await adminFetch('/admin/leads/sources', { method:'POST', body:formData });
        loadSources();
      } else if (showModal === 'newCampaign') {
        await adminFetch('/admin/leads/campaigns', { method:'POST', body:formData });
        loadCampaigns();
      } else if (showModal === 'convert') {
        await adminFetch(`/admin/leads/${formData.leadId}/convert`, { method:'POST', body:formData });
        loadLeads();
      } else if (showModal === 'lost') {
        await adminFetch(`/admin/leads/${formData.leadId}/lost`, { method:'POST', body:formData });
        loadLeads();
      } else if (showModal === 'assign') {
        await adminFetch(`/admin/leads/${formData.leadId}/assign`, { method:'POST', body:{ technician_id: formData.technician_id } });
        loadLeads();
      } else if (showModal === 'logCost') {
        await adminFetch(`/admin/leads/sources/${formData.sourceId}/cost`, { method:'POST', body:formData });
        loadSources();
      }
      setShowModal(null); setFormData({});
    } catch (e) { alert('Error: ' + e.message); }
    setLoading(false);
  };

  // ═════════════════════════════════════════════════════════════════════════
  // PIPELINE TAB
  // ═════════════════════════════════════════════════════════════════════════
  const renderPipeline = () => {
    const ov = overview || {};
    const funnelStages = ['new','contacted','estimate_sent','won'];
    const funnelData = funnelStages.map(s => funnel.find(f => f.stage === s) || { stage:s, label:s, count:0 });

    return <>
      {/* Metric Cards */}
      <div style={{ display:'flex', gap:16, flexWrap:'wrap', marginBottom:24 }}>
        <MetricCard label="New Leads (Month)" value={ov.total || 0} color={C.teal} />
        <MetricCard label="Conversion Rate" value={fmtPct(ov.conversionRate)} color={C.green} />
        <MetricCard label="Avg Response Time" value={fmtTime(ov.avgResponseTime)} color={C.amber} />
        <MetricCard label="Cost per Acquisition" value={fmtMoney(ov.cpa)} color={C.purple} />
        <MetricCard label="Avg Speed to Lead" value={fmtTime(ov.avgResponseTime)} sub={ov.avgResponseTime != null && ov.avgResponseTime < 5 ? 'Great!' : ov.avgResponseTime != null && ov.avgResponseTime < 15 ? 'Good' : ov.avgResponseTime != null ? 'Needs work' : null} color={ov.avgResponseTime != null ? (ov.avgResponseTime < 5 ? C.green : ov.avgResponseTime < 15 ? C.amber : C.red) : C.muted} />
        <MetricCard label="Monthly ROI" value={ov.roi != null ? fmtPct(ov.roi) : '--'} color={roiColor(ov.roi||0)} />
      </div>

      {/* Funnel */}
      <Card style={{ marginBottom:24 }}>
        <h3 style={{ margin:'0 0 16px', color:C.white, fontSize:15 }}>Lead Funnel</h3>
        <div style={{ display:'flex', alignItems:'flex-end', gap:2, height:120 }}>
          {funnelData.map((f, i) => {
            const maxCount = Math.max(...funnelData.map(d => d.count), 1);
            const h = Math.max(20, (f.count / maxCount) * 100);
            const dropoff = i > 0 && funnelData[i-1].count > 0
              ? Math.round((1 - f.count / funnelData[i-1].count) * 100) : null;
            return <div key={f.stage} style={{ flex:1, textAlign:'center' }}>
              <div style={{ fontSize:18, fontWeight:700, color:C.white, ...mono, marginBottom:4 }}>{f.count}</div>
              <div style={{ height:h, backgroundColor:STATUS_COLORS[f.stage]||C.teal, borderRadius:'6px 6px 0 0',
                margin:'0 auto', width:'70%', minWidth:30, transition:'height 0.3s' }} />
              <div style={{ fontSize:11, color:C.muted, marginTop:6 }}>{f.label || f.stage}</div>
              {dropoff != null && <div style={{ fontSize:10, color:C.red, marginTop:2 }}>-{dropoff}%</div>}
            </div>;
          })}
        </div>
      </Card>

      {/* Filters + Actions */}
      <div style={{ display:'flex', gap:12, marginBottom:16, flexWrap:'wrap', alignItems:'center' }}>
        <select value={filters.status} onChange={e=>setFilters(f=>({...f, status:e.target.value, page:1}))}
          style={{ backgroundColor:C.bg, border:`1px solid ${C.border}`, borderRadius:8, padding:'6px 12px', color:C.text, fontSize:13 }}>
          <option value="">All Statuses</option>
          {STATUSES.map(s => <option key={s} value={s}>{s.replace(/_/g,' ')}</option>)}
        </select>
        <input placeholder="Search leads..." value={filters.search} onChange={e=>setFilters(f=>({...f, search:e.target.value, page:1}))}
          style={{ backgroundColor:C.bg, border:`1px solid ${C.border}`, borderRadius:8, padding:'6px 12px', color:C.text, fontSize:13, minWidth:200 }} />
        <select value={filters.sort} onChange={e=>setFilters(f=>({...f, sort:e.target.value}))}
          style={{ backgroundColor:C.bg, border:`1px solid ${C.border}`, borderRadius:8, padding:'6px 12px', color:C.text, fontSize:13 }}>
          <option value="first_contact_at">Newest First</option>
          <option value="name">Name</option>
          <option value="status">Status</option>
          <option value="response_time">Response Time</option>
          <option value="monthly_value">Value</option>
        </select>
        <div style={{ flex:1 }} />
        <Btn onClick={() => { setFormData({}); setShowModal('newLead'); }}>+ New Lead</Btn>
      </div>

      {/* Leads Table */}
      <Card style={{ padding:0, overflow:'hidden' }}>
        <table style={{ width:'100%', borderCollapse:'collapse' }}>
          <thead>
            <tr style={{ borderBottom:`1px solid ${C.border}` }}>
              {['Name / Phone','Source','Service','Urgency','Status','Response','Assigned'].map(h =>
                <th key={h} style={{ padding:'12px 16px', textAlign:'left', fontSize:11, color:C.muted, fontWeight:600, textTransform:'uppercase' }}>{h}</th>
              )}
            </tr>
          </thead>
          <tbody>
            {leads.map(lead => {
              const isExpanded = expandedLead === lead.id;
              return <React.Fragment key={lead.id}>
                <tr onClick={()=>expandLead(lead)} style={{ borderBottom:`1px solid ${C.border}`, cursor:'pointer',
                  backgroundColor:isExpanded?C.cardHover:'transparent', transition:'background 0.15s' }}>
                  <td style={{ padding:'12px 16px' }}>
                    <div style={{ color:C.white, fontSize:14, fontWeight:500 }}>{[lead.first_name,lead.last_name].filter(Boolean).join(' ') || 'Unknown'}</div>
                    <div style={{ color:C.muted, fontSize:12, ...mono }}>{lead.phone || lead.email || '--'}</div>
                  </td>
                  <td style={{ padding:'12px 16px' }}>
                    {lead.source_name ? <Badge label={lead.source_name.length > 25 ? lead.source_name.slice(0,22)+'...' : lead.source_name}
                      color={C.teal} /> : <span style={{ color:C.muted, fontSize:12 }}>--</span>}
                  </td>
                  <td style={{ padding:'12px 16px', color:C.text, fontSize:13 }}>{lead.service_interest || '--'}</td>
                  <td style={{ padding:'12px 16px' }}>
                    <Badge label={lead.urgency||'normal'} color={lead.urgency==='urgent'?C.red:lead.urgency==='high'?C.amber:C.muted} />
                  </td>
                  <td style={{ padding:'12px 16px' }} onClick={e=>e.stopPropagation()}>
                    <select value={lead.status} onChange={e=>updateLeadStatus(lead.id, e.target.value)}
                      style={{ backgroundColor:STATUS_COLORS[lead.status]+'22', border:`1px solid ${STATUS_COLORS[lead.status]||C.border}44`,
                        borderRadius:6, padding:'4px 8px', color:STATUS_COLORS[lead.status]||C.text, fontSize:12, cursor:'pointer' }}>
                      {STATUSES.map(s => <option key={s} value={s}>{s.replace(/_/g,' ')}</option>)}
                    </select>
                  </td>
                  <td style={{ padding:'12px 16px', ...mono, fontSize:13,
                    color:lead.response_time_minutes!=null?(lead.response_time_minutes<15?C.green:lead.response_time_minutes<60?C.amber:C.red):C.muted }}>
                    {lead.status === 'new' && lead.response_time_minutes == null && lead.first_contact_at
                      ? <SpeedToLeadTimer firstContactAt={lead.first_contact_at} />
                      : fmtTime(lead.response_time_minutes)}
                  </td>
                  <td style={{ padding:'12px 16px', color:C.text, fontSize:13 }}>{lead.assigned_name || '--'}</td>
                </tr>
                {isExpanded && <tr><td colSpan={7} style={{ padding:0 }}>
                  <div style={{ padding:'16px 24px', backgroundColor:C.bg, borderBottom:`1px solid ${C.border}` }}>
                    <div style={{ display:'flex', gap:16, flexWrap:'wrap', marginBottom:16 }}>
                      <div style={{ flex:'1 1 300px' }}>
                        <h4 style={{ margin:'0 0 8px', color:C.white, fontSize:14 }}>Details</h4>
                        <div style={{ fontSize:13, color:C.muted, lineHeight:1.8 }}>
                          <div>Email: <span style={{ color:C.text }}>{lead.email || '--'}</span></div>
                          <div>Address: <span style={{ color:C.text }}>{[lead.address, lead.city, lead.zip].filter(Boolean).join(', ') || '--'}</span></div>
                          <div>Type: <span style={{ color:C.text }}>{lead.lead_type?.replace(/_/g,' ') || '--'}</span></div>
                          <div>First Contact: <span style={{ color:C.text }}>{lead.first_contact_at ? new Date(lead.first_contact_at).toLocaleString() : '--'}</span></div>
                          {lead.monthly_value && <div>Monthly Value: <span style={{ color:C.green, ...mono }}>{fmtMoney(lead.monthly_value)}</span></div>}
                          {lead.transcript_summary && <div>Notes: <span style={{ color:C.text }}>{lead.transcript_summary}</span></div>}
                        </div>
                      </div>
                      <div style={{ flex:'1 1 300px' }}>
                        <h4 style={{ margin:'0 0 8px', color:C.white, fontSize:14 }}>Activity Timeline</h4>
                        <div style={{ maxHeight:200, overflowY:'auto' }}>
                          {leadActivities.length === 0 && <div style={{ color:C.muted, fontSize:12 }}>No activities logged</div>}
                          {leadActivities.map(a => <div key={a.id} style={{ fontSize:12, color:C.muted, padding:'4px 0',
                            borderLeft:`2px solid ${C.border}`, paddingLeft:12, marginLeft:4, marginBottom:4 }}>
                            <Badge label={a.activity_type} color={C.teal} style={{ marginRight:8 }} />
                            <span style={{ color:C.text }}>{a.description}</span>
                            <div style={{ fontSize:10, marginTop:2 }}>{a.performed_by} - {new Date(a.created_at).toLocaleString()}</div>
                          </div>)}
                        </div>
                      </div>
                    </div>
                    {/* AI Suggested Reply */}
                    {(() => {
                      const triageActivity = leadActivities.find(a => a.activity_type === 'ai_triage' && a.metadata);
                      if (!triageActivity) return null;
                      let meta = {};
                      try { meta = typeof triageActivity.metadata === 'string' ? JSON.parse(triageActivity.metadata) : triageActivity.metadata; } catch(e) {}
                      if (!meta.suggestedReply) return null;
                      return <div style={{ border:`1px solid ${C.teal}44`, borderRadius:10, padding:14, marginBottom:14, backgroundColor:C.teal+'0a' }}>
                        <div style={{ fontSize:12, color:C.teal, fontWeight:600, marginBottom:6 }}>AI Suggested Reply</div>
                        <div style={{ fontSize:13, color:C.text, marginBottom:8, lineHeight:1.5 }}>{meta.suggestedReply}</div>
                        {meta.serviceInterest && <Badge label={meta.serviceInterest} color={C.teal} style={{ marginRight:6 }} />}
                        {meta.urgency && meta.urgency !== 'normal' && <Badge label={meta.urgency} color={meta.urgency==='urgent'?C.red:C.amber} style={{ marginRight:6 }} />}
                        <div style={{ marginTop:10 }}>
                          <Btn small color={C.teal} disabled={smsSending} onClick={async ()=>{
                            setSmsSending(true);
                            try {
                              await adminFetch(`/admin/leads/${lead.id}/send-sms`, { method:'POST', body:{ message:meta.suggestedReply } });
                              loadLeads(); expandLead(lead);
                            } catch(e) { alert('Send failed: '+e.message); }
                            setSmsSending(false);
                          }}>{smsSending?'Sending...':'Send This Reply'}</Btn>
                        </div>
                      </div>;
                    })()}

                    {/* Quick Actions */}
                    <div style={{ display:'flex', gap:8, flexWrap:'wrap', marginBottom:12 }}>
                      <Btn small color={C.teal} onClick={()=>{
                        const name = lead.first_name || 'there';
                        const svc = lead.service_interest || 'pest control';
                        setSmsCompose({ leadId:lead.id, message:'', suggestions:[
                          `Hi ${name}! This is Adam from Waves Pest Control. I saw your inquiry about ${svc} — I'd love to help. When's a good time to chat?`,
                          `Hey ${name}! Thanks for reaching out about ${svc}. We can usually get you on the schedule within a day or two. Want me to set up an estimate?`
                        ]});
                      }}>Send Text</Btn>
                      <Btn small color={C.purple} onClick={()=>{
                        const params = new URLSearchParams();
                        if (lead.first_name) params.set('first_name', lead.first_name);
                        if (lead.last_name) params.set('last_name', lead.last_name);
                        if (lead.phone) params.set('phone', lead.phone);
                        if (lead.email) params.set('email', lead.email);
                        if (lead.address) params.set('address', lead.address);
                        if (lead.service_interest) params.set('service_interest', lead.service_interest);
                        navigate(`/admin/estimates?${params}`);
                      }}>Create Estimate</Btn>
                      <Btn small color={C.amber} onClick={()=>setCallbackForm({ leadId:lead.id, date:'', time:'', notes:'' })}>Schedule Callback</Btn>
                      {lead.phone && <a href={`tel:${lead.phone}`} style={{ textDecoration:'none' }}>
                        <Btn small color={C.green}>Call Now</Btn>
                      </a>}
                      <Btn small color={C.green} onClick={()=>{ setFormData({ leadId:lead.id }); setShowModal('convert'); }}>Convert to Customer</Btn>
                      <Btn small color={C.red} onClick={()=>{ setFormData({ leadId:lead.id }); setShowModal('lost'); }}>Mark Lost</Btn>
                      <Btn small color={C.purple} onClick={()=>{ setFormData({ leadId:lead.id }); setShowModal('assign'); }}>Assign</Btn>
                    </div>

                    {/* Inline SMS Compose */}
                    {smsCompose && smsCompose.leadId === lead.id && <div style={{ border:`1px solid ${C.border}`, borderRadius:10, padding:14, marginBottom:12, backgroundColor:C.card }}>
                      <div style={{ fontSize:12, color:C.teal, fontWeight:600, marginBottom:8 }}>Send SMS to {lead.first_name || 'Lead'}</div>
                      {smsCompose.suggestions && smsCompose.suggestions.map((s, i) => <div key={i} onClick={()=>setSmsCompose(prev=>({...prev, message:s}))}
                        style={{ fontSize:12, color:C.text, padding:'8px 10px', borderRadius:6, border:`1px solid ${C.border}`,
                          marginBottom:6, cursor:'pointer', backgroundColor:smsCompose.message===s?C.teal+'22':'transparent', transition:'background 0.15s' }}>
                        {s}
                      </div>)}
                      <textarea value={smsCompose.message} onChange={e=>setSmsCompose(prev=>({...prev, message:e.target.value}))}
                        placeholder="Type your message..."
                        style={{ width:'100%', minHeight:60, backgroundColor:'#0f1923', border:`1px solid ${C.border}`, borderRadius:8,
                          padding:'8px 12px', color:C.text, fontSize:13, resize:'vertical', boxSizing:'border-box', marginBottom:8 }} />
                      <div style={{ display:'flex', gap:8 }}>
                        <Btn small color={C.teal} disabled={smsSending||!smsCompose.message} onClick={async ()=>{
                          setSmsSending(true);
                          try {
                            await adminFetch(`/admin/leads/${lead.id}/send-sms`, { method:'POST', body:{ message:smsCompose.message } });
                            setSmsCompose(null); loadLeads(); expandLead(lead);
                          } catch(e) { alert('Send failed: '+e.message); }
                          setSmsSending(false);
                        }}>{smsSending?'Sending...':'Send'}</Btn>
                        <Btn small color={C.muted} onClick={()=>setSmsCompose(null)}>Cancel</Btn>
                      </div>
                    </div>}

                    {/* Inline Schedule Callback */}
                    {callbackForm && callbackForm.leadId === lead.id && <div style={{ border:`1px solid ${C.border}`, borderRadius:10, padding:14, marginBottom:12, backgroundColor:C.card }}>
                      <div style={{ fontSize:12, color:C.amber, fontWeight:600, marginBottom:8 }}>Schedule Callback</div>
                      <div style={{ display:'flex', gap:8, marginBottom:8 }}>
                        <input type="date" value={callbackForm.date} onChange={e=>setCallbackForm(prev=>({...prev, date:e.target.value}))}
                          style={{ flex:1, backgroundColor:'#0f1923', border:`1px solid ${C.border}`, borderRadius:8, padding:'6px 10px', color:C.text, fontSize:13 }} />
                        <input type="time" value={callbackForm.time} onChange={e=>setCallbackForm(prev=>({...prev, time:e.target.value}))}
                          style={{ flex:1, backgroundColor:'#0f1923', border:`1px solid ${C.border}`, borderRadius:8, padding:'6px 10px', color:C.text, fontSize:13 }} />
                      </div>
                      <textarea value={callbackForm.notes||''} onChange={e=>setCallbackForm(prev=>({...prev, notes:e.target.value}))}
                        placeholder="Notes..."
                        style={{ width:'100%', minHeight:40, backgroundColor:'#0f1923', border:`1px solid ${C.border}`, borderRadius:8,
                          padding:'8px 12px', color:C.text, fontSize:13, resize:'vertical', boxSizing:'border-box', marginBottom:8 }} />
                      <div style={{ display:'flex', gap:8 }}>
                        <Btn small color={C.amber} disabled={!callbackForm.date||!callbackForm.time} onClick={async ()=>{
                          try {
                            await adminFetch(`/admin/leads/${lead.id}/schedule-callback`, { method:'POST', body:{ date:callbackForm.date, time:callbackForm.time, notes:callbackForm.notes } });
                            setCallbackForm(null); loadLeads(); expandLead(lead);
                          } catch(e) { alert('Failed: '+e.message); }
                        }}>Save</Btn>
                        <Btn small color={C.muted} onClick={()=>setCallbackForm(null)}>Cancel</Btn>
                      </div>
                    </div>}
                  </div>
                </td></tr>}
              </React.Fragment>;
            })}
            {leads.length === 0 && <tr><td colSpan={7} style={{ padding:40, textAlign:'center', color:C.muted }}>No leads found</td></tr>}
          </tbody>
        </table>
      </Card>

      {/* Pagination */}
      {leadsTotal > 50 && <div style={{ display:'flex', justifyContent:'center', gap:8, marginTop:16 }}>
        <Btn small disabled={filters.page<=1} onClick={()=>setFilters(f=>({...f, page:f.page-1}))}>Prev</Btn>
        <span style={{ color:C.muted, fontSize:13, alignSelf:'center', ...mono }}>
          Page {filters.page} of {Math.ceil(leadsTotal/50)}
        </span>
        <Btn small disabled={filters.page>=Math.ceil(leadsTotal/50)} onClick={()=>setFilters(f=>({...f, page:f.page+1}))}>Next</Btn>
      </div>}
    </>;
  };

  // ═════════════════════════════════════════════════════════════════════════
  // SOURCES TAB
  // ═════════════════════════════════════════════════════════════════════════
  const [expandedSource, setExpandedSource] = useState(null);
  const [sourceROI, setSourceROI] = useState(null);

  const expandSource = async (source) => {
    if (expandedSource === source.id) { setExpandedSource(null); return; }
    setExpandedSource(source.id);
    try {
      const data = await adminFetch(`/admin/leads/sources/${source.id}`);
      setSourceROI(data);
    } catch (e) { setSourceROI(null); }
  };

  const renderSources = () => {
    return <>
      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:16 }}>
        <h3 style={{ margin:0, color:C.white, fontSize:16 }}>Lead Sources ({sources.length})</h3>
        <div style={{ display:'flex', gap:8 }}>
          <Btn small onClick={()=>{ setFormData({ source_type:'phone_tracking', cost_type:'per_month' }); setShowModal('newSource'); }}>+ Add Source</Btn>
        </div>
      </div>
      <Card style={{ padding:0, overflow:'auto' }}>
        <table style={{ width:'100%', borderCollapse:'collapse', minWidth:900 }}>
          <thead>
            <tr style={{ borderBottom:`1px solid ${C.border}` }}>
              {['Source','Type','Channel','Monthly Cost','Leads (Mo)','Conversions','Conv %','Cost/Lead','Cost/Acq','ROI %'].map(h =>
                <th key={h} style={{ padding:'12px 14px', textAlign:'left', fontSize:11, color:C.muted, fontWeight:600, textTransform:'uppercase', whiteSpace:'nowrap' }}>{h}</th>
              )}
            </tr>
          </thead>
          <tbody>
            {sources.map(src => {
              const monthLeads = parseInt(src.month_leads||0);
              const monthConv = parseInt(src.month_conversions||0);
              const convRate = monthLeads > 0 ? (monthConv / monthLeads * 100) : 0;
              const mc = parseFloat(src.monthly_cost||0);
              const cpl = monthLeads > 0 ? mc / monthLeads : 0;
              const cpa = monthConv > 0 ? mc / monthConv : 0;
              // Rough ROI: just show indicator based on conversion cost
              const roi = mc > 0 && monthConv > 0 ? ((monthConv * 150 - mc) / mc * 100) : (monthConv > 0 ? 9999 : 0);
              const isExp = expandedSource === src.id;

              return <React.Fragment key={src.id}>
                <tr onClick={()=>expandSource(src)} style={{ borderBottom:`1px solid ${C.border}`, cursor:'pointer',
                  backgroundColor:isExp?C.cardHover:'transparent', opacity:src.is_active?1:0.5 }}>
                  <td style={{ padding:'12px 14px' }}>
                    <div style={{ color:C.white, fontSize:13, fontWeight:500 }}>{src.name}</div>
                    {src.domain && <div style={{ color:C.muted, fontSize:11 }}>{src.domain}</div>}
                  </td>
                  <td style={{ padding:'12px 14px' }}><Badge label={src.source_type?.replace(/_/g,' ')} color={C.teal} /></td>
                  <td style={{ padding:'12px 14px', color:C.text, fontSize:13 }}>{src.channel || '--'}</td>
                  <td style={{ padding:'12px 14px', ...mono, fontSize:13, color:C.text }}>{fmtMoney(mc)}</td>
                  <td style={{ padding:'12px 14px', ...mono, fontSize:13, color:C.white }}>{monthLeads}</td>
                  <td style={{ padding:'12px 14px', ...mono, fontSize:13, color:C.green }}>{monthConv}</td>
                  <td style={{ padding:'12px 14px', ...mono, fontSize:13, color:convRate>20?C.green:convRate>10?C.amber:C.muted }}>{fmtPct(convRate)}</td>
                  <td style={{ padding:'12px 14px', ...mono, fontSize:13, color:C.text }}>{cpl>0?fmtMoney(cpl):'--'}</td>
                  <td style={{ padding:'12px 14px', ...mono, fontSize:13, color:C.text }}>{cpa>0?fmtMoney(cpa):'--'}</td>
                  <td style={{ padding:'12px 14px', ...mono, fontSize:13, fontWeight:600, color:roiColor(roi) }}>{roi>0?fmtPct(roi):'--'}</td>
                </tr>
                {isExp && sourceROI && <tr><td colSpan={10} style={{ padding:0 }}>
                  <div style={{ padding:'16px 24px', backgroundColor:C.bg, borderBottom:`1px solid ${C.border}` }}>
                    <div style={{ display:'flex', gap:24, flexWrap:'wrap', marginBottom:12 }}>
                      <div><span style={{ color:C.muted, fontSize:12 }}>Total Leads: </span><span style={{ color:C.white, ...mono }}>{sourceROI.totalLeads}</span></div>
                      <div><span style={{ color:C.muted, fontSize:12 }}>Conversions: </span><span style={{ color:C.green, ...mono }}>{sourceROI.conversions}</span></div>
                      <div><span style={{ color:C.muted, fontSize:12 }}>Total Cost: </span><span style={{ color:C.text, ...mono }}>{fmtMoney(sourceROI.totalCost)}</span></div>
                      <div><span style={{ color:C.muted, fontSize:12 }}>Total Revenue: </span><span style={{ color:C.green, ...mono }}>{fmtMoney(sourceROI.totalRevenue)}</span></div>
                      <div><span style={{ color:C.muted, fontSize:12 }}>ROI: </span><span style={{ ...mono, color:roiColor(sourceROI.roi) }}>{fmtPct(sourceROI.roi)}</span></div>
                      <div><span style={{ color:C.muted, fontSize:12 }}>Avg Response: </span><span style={{ color:C.text, ...mono }}>{fmtTime(sourceROI.avgResponseTime)}</span></div>
                    </div>
                    <Btn small color={C.amber} onClick={()=>{ setFormData({ sourceId:src.id, cost_category:'monthly_fee' }); setShowModal('logCost'); }}>Log Cost</Btn>
                  </div>
                </td></tr>}
              </React.Fragment>;
            })}
          </tbody>
        </table>
      </Card>
    </>;
  };

  // ═════════════════════════════════════════════════════════════════════════
  // CAMPAIGNS TAB
  // ═════════════════════════════════════════════════════════════════════════
  const renderCampaigns = () => {
    return <>
      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:16 }}>
        <h3 style={{ margin:0, color:C.white, fontSize:16 }}>Marketing Campaigns ({campaigns.length})</h3>
        <Btn onClick={()=>{ setFormData({ channel:'website_organic' }); setShowModal('newCampaign'); }}>+ New Campaign</Btn>
      </div>
      <div style={{ display:'flex', gap:16, flexWrap:'wrap' }}>
        {campaigns.map(camp => {
          const budget = parseFloat(camp.budget||0);
          const spend = parseFloat(camp.spend_to_date||0);
          const spendPct = budget > 0 ? Math.min(100, spend/budget*100) : 0;
          const statusColor = camp.status==='active'?C.green:camp.status==='paused'?C.amber:C.muted;
          return <Card key={camp.id} style={{ flex:'1 1 300px', maxWidth:400 }}>
            <div style={{ display:'flex', justifyContent:'space-between', marginBottom:8 }}>
              <h4 style={{ margin:0, color:C.white, fontSize:14 }}>{camp.name}</h4>
              <Badge label={camp.status} color={statusColor} />
            </div>
            <div style={{ display:'flex', gap:8, marginBottom:12 }}>
              <Badge label={camp.channel||'--'} color={C.teal} />
              {camp.source_name && <Badge label={camp.source_name} color={C.purple} />}
            </div>
            <div style={{ fontSize:12, color:C.muted, marginBottom:8 }}>
              {camp.start_date ? new Date(camp.start_date).toLocaleDateString() : '?'} - {camp.end_date ? new Date(camp.end_date).toLocaleDateString() : 'ongoing'}
            </div>
            {/* Budget bar */}
            <div style={{ marginBottom:8 }}>
              <div style={{ display:'flex', justifyContent:'space-between', fontSize:12, marginBottom:4 }}>
                <span style={{ color:C.muted }}>Budget</span>
                <span style={{ color:C.text, ...mono }}>{fmtMoney(spend)} / {fmtMoney(budget)}</span>
              </div>
              <div style={{ height:6, backgroundColor:C.border, borderRadius:3, overflow:'hidden' }}>
                <div style={{ width:`${spendPct}%`, height:'100%', backgroundColor:spendPct>90?C.red:spendPct>70?C.amber:C.green, borderRadius:3 }} />
              </div>
            </div>
            <div style={{ display:'flex', gap:16, fontSize:13 }}>
              <div><span style={{ color:C.muted }}>Leads: </span><span style={{ color:C.white, ...mono }}>{camp.actual_leads||0}{camp.target_leads ? `/${camp.target_leads}`:''}</span></div>
              <div><span style={{ color:C.muted }}>Conv: </span><span style={{ color:C.green, ...mono }}>{camp.actual_conversions||0}{camp.target_conversions ? `/${camp.target_conversions}`:''}</span></div>
            </div>
            {camp.offer_details && <div style={{ fontSize:12, color:C.muted, marginTop:8, fontStyle:'italic' }}>{camp.offer_details}</div>}
          </Card>;
        })}
        {campaigns.length === 0 && <Card style={{ flex:1, textAlign:'center', padding:40 }}>
          <div style={{ color:C.muted }}>No campaigns yet</div>
        </Card>}
      </div>
    </>;
  };

  // ═════════════════════════════════════════════════════════════════════════
  // ROI ANALYTICS TAB
  // ═════════════════════════════════════════════════════════════════════════
  const renderAnalytics = () => {
    const maxChannelVal = Math.max(...byChannel.map(c => Math.max(c.totalCost, c.totalRevenue)), 1);

    // Scatter plot data
    const scatterSources = bySource.filter(s => s.totalLeads > 0);
    const maxCost = Math.max(...scatterSources.map(s => s.totalCost), 1);
    const maxRev = Math.max(...scatterSources.map(s => s.totalRevenue), 1);
    const maxLeads = Math.max(...scatterSources.map(s => s.totalLeads), 1);

    // Response time data
    const maxResp = Math.max(...responseBuckets.map(b => b.total), 1);

    // Lost reasons pie
    const totalLost = lostReasons.reduce((s, r) => s + r.count, 0);
    const pieColors = [C.red, C.amber, C.purple, C.teal, C.green, '#f97316', '#ec4899'];

    // Phone number ROI
    const phoneROI = bySource.filter(s => s.source?.twilio_phone_number);

    return <>
      {/* Channel Comparison */}
      <Card style={{ marginBottom:24 }}>
        <h3 style={{ margin:'0 0 16px', color:C.white, fontSize:15 }}>Channel Comparison</h3>
        {byChannel.length === 0 && <div style={{ color:C.muted, fontSize:13 }}>No channel data available yet</div>}
        {byChannel.map(ch => <div key={ch.channel} style={{ marginBottom:12 }}>
          <div style={{ display:'flex', justifyContent:'space-between', fontSize:12, marginBottom:4 }}>
            <span style={{ color:C.text, fontWeight:500 }}>{ch.channel}</span>
            <span style={{ color:C.muted, ...mono }}>Leads: {ch.totalLeads} | Conv: {ch.conversions} | ROI: {fmtPct(ch.roi)}</span>
          </div>
          <div style={{ display:'flex', gap:2, height:16 }}>
            <div style={{ width:`${ch.totalCost/maxChannelVal*100}%`, height:'100%', backgroundColor:C.red+'88', borderRadius:'3px 0 0 3px', minWidth:ch.totalCost>0?2:0 }} />
            <div style={{ width:`${ch.totalRevenue/maxChannelVal*100}%`, height:'100%', backgroundColor:C.green+'88', borderRadius:'0 3px 3px 0', minWidth:ch.totalRevenue>0?2:0 }} />
          </div>
          <div style={{ display:'flex', gap:16, fontSize:10, color:C.muted, marginTop:2 }}>
            <span>Cost: {fmtMoney(ch.totalCost)}</span>
            <span>Revenue: {fmtMoney(ch.totalRevenue)}</span>
          </div>
        </div>)}
        <div style={{ display:'flex', gap:16, fontSize:11, color:C.muted, marginTop:8 }}>
          <span><span style={{ display:'inline-block', width:12, height:12, backgroundColor:C.red+'88', borderRadius:2, verticalAlign:'middle', marginRight:4 }} />Cost</span>
          <span><span style={{ display:'inline-block', width:12, height:12, backgroundColor:C.green+'88', borderRadius:2, verticalAlign:'middle', marginRight:4 }} />Revenue</span>
        </div>
      </Card>

      {/* Source ROI Matrix */}
      <Card style={{ marginBottom:24 }}>
        <h3 style={{ margin:'0 0 16px', color:C.white, fontSize:15 }}>Source ROI Matrix</h3>
        {scatterSources.length === 0 ? <div style={{ color:C.muted, fontSize:13 }}>No source data with leads yet</div> :
        <svg viewBox="0 0 400 300" style={{ width:'100%', maxWidth:600, height:'auto' }}>
          {/* Quadrant lines */}
          <line x1="200" y1="10" x2="200" y2="280" stroke={C.border} strokeDasharray="4" />
          <line x1="20" y1="145" x2="380" y2="145" stroke={C.border} strokeDasharray="4" />
          {/* Quadrant labels */}
          <text x="110" y="80" fill={C.muted} fontSize="9" textAnchor="middle">Question Marks</text>
          <text x="300" y="80" fill={C.green} fontSize="9" textAnchor="middle">Stars</text>
          <text x="110" y="230" fill={C.muted} fontSize="9" textAnchor="middle">Dogs</text>
          <text x="300" y="230" fill={C.amber} fontSize="9" textAnchor="middle">Cash Cows</text>
          {/* Axes */}
          <text x="200" y="296" fill={C.muted} fontSize="9" textAnchor="middle">Revenue --&gt;</text>
          <text x="12" y="145" fill={C.muted} fontSize="9" textAnchor="middle" transform="rotate(-90 12 145)">Cost --&gt;</text>
          {/* Dots */}
          {scatterSources.map((s, i) => {
            const x = 30 + (s.totalRevenue / maxRev) * 340;
            const y = 270 - (s.totalCost / maxCost) * 250;
            const r = Math.max(4, Math.min(20, (s.totalLeads / maxLeads) * 18));
            const c = s.roi > 200 ? C.green : s.roi > 50 ? C.amber : s.roi > 0 ? '#f97316' : C.red;
            return <g key={i}>
              <circle cx={x} cy={y} r={r} fill={c} opacity={0.7} />
              <title>{s.source?.name}: Cost {fmtMoney(s.totalCost)}, Rev {fmtMoney(s.totalRevenue)}, {s.totalLeads} leads, ROI {fmtPct(s.roi)}</title>
            </g>;
          })}
        </svg>}
      </Card>

      <div style={{ display:'flex', gap:16, flexWrap:'wrap', marginBottom:24 }}>
        {/* Response Time vs Conversion */}
        <Card style={{ flex:'1 1 400px' }}>
          <h3 style={{ margin:'0 0 16px', color:C.white, fontSize:15 }}>Response Time vs Conversion</h3>
          {responseBuckets.length === 0 ? <div style={{ color:C.muted, fontSize:13 }}>No response data yet</div> :
          <div style={{ display:'flex', alignItems:'flex-end', gap:6, height:140 }}>
            {responseBuckets.map((b, i) => {
              const h = Math.max(8, (b.total / maxResp) * 120);
              const wonH = b.total > 0 ? (b.won / b.total) * h : 0;
              return <div key={i} style={{ flex:1, textAlign:'center' }}>
                <div style={{ fontSize:11, color:C.white, ...mono, marginBottom:4 }}>{b.conversionRate}%</div>
                <div style={{ position:'relative', height:h, margin:'0 auto', width:'80%', minWidth:16 }}>
                  <div style={{ position:'absolute', bottom:0, width:'100%', height:h, backgroundColor:C.border, borderRadius:'4px 4px 0 0' }} />
                  <div style={{ position:'absolute', bottom:0, width:'100%', height:wonH, backgroundColor:C.green, borderRadius:wonH>=h?'4px 4px 0 0':'0 0 0 0' }} />
                </div>
                <div style={{ fontSize:9, color:C.muted, marginTop:6, lineHeight:1.2 }}>{b.label}</div>
                <div style={{ fontSize:10, color:C.muted, ...mono }}>{b.total}</div>
              </div>;
            })}
          </div>}
          <div style={{ display:'flex', gap:12, fontSize:11, color:C.muted, marginTop:12 }}>
            <span><span style={{ display:'inline-block', width:10, height:10, backgroundColor:C.border, borderRadius:2, verticalAlign:'middle', marginRight:4 }} />Total</span>
            <span><span style={{ display:'inline-block', width:10, height:10, backgroundColor:C.green, borderRadius:2, verticalAlign:'middle', marginRight:4 }} />Won</span>
          </div>
        </Card>

        {/* Lost Lead Analysis */}
        <Card style={{ flex:'1 1 300px' }}>
          <h3 style={{ margin:'0 0 16px', color:C.white, fontSize:15 }}>Lost Lead Reasons</h3>
          {totalLost === 0 ? <div style={{ color:C.muted, fontSize:13 }}>No lost leads yet</div> :
          <div style={{ display:'flex', gap:24, alignItems:'center' }}>
            <svg viewBox="0 0 100 100" style={{ width:120, height:120, flexShrink:0 }}>
              {(() => {
                let cumAngle = 0;
                return lostReasons.slice(0, 7).map((r, i) => {
                  const pct = r.count / totalLost;
                  const angle = pct * 360;
                  const startAngle = cumAngle;
                  cumAngle += angle;
                  const startRad = (startAngle - 90) * Math.PI / 180;
                  const endRad = (cumAngle - 90) * Math.PI / 180;
                  const largeArc = angle > 180 ? 1 : 0;
                  const x1 = 50 + 45 * Math.cos(startRad);
                  const y1 = 50 + 45 * Math.sin(startRad);
                  const x2 = 50 + 45 * Math.cos(endRad);
                  const y2 = 50 + 45 * Math.sin(endRad);
                  if (lostReasons.length === 1) {
                    return <circle key={i} cx="50" cy="50" r="45" fill={pieColors[i % pieColors.length]} />;
                  }
                  return <path key={i} d={`M50,50 L${x1},${y1} A45,45 0 ${largeArc},1 ${x2},${y2} Z`}
                    fill={pieColors[i % pieColors.length]} />;
                });
              })()}
            </svg>
            <div>
              {lostReasons.slice(0, 7).map((r, i) => <div key={i} style={{ fontSize:12, marginBottom:4, display:'flex', alignItems:'center', gap:6 }}>
                <span style={{ display:'inline-block', width:10, height:10, borderRadius:2, backgroundColor:pieColors[i % pieColors.length], flexShrink:0 }} />
                <span style={{ color:C.text }}>{r.reason}</span>
                <span style={{ color:C.muted, ...mono }}>{r.count}</span>
              </div>)}
            </div>
          </div>}
        </Card>
      </div>

      {/* Phone Number ROI Table */}
      <Card style={{ padding:0, overflow:'auto' }}>
        <div style={{ padding:'16px 20px', borderBottom:`1px solid ${C.border}` }}>
          <h3 style={{ margin:0, color:C.white, fontSize:15 }}>Phone Number ROI</h3>
        </div>
        <table style={{ width:'100%', borderCollapse:'collapse', minWidth:700 }}>
          <thead>
            <tr style={{ borderBottom:`1px solid ${C.border}` }}>
              {['Number','Source','Cost','Leads','Conversions','Revenue','ROI %'].map(h =>
                <th key={h} style={{ padding:'10px 14px', textAlign:'left', fontSize:11, color:C.muted, fontWeight:600, textTransform:'uppercase' }}>{h}</th>
              )}
            </tr>
          </thead>
          <tbody>
            {phoneROI.map((s, i) => <tr key={i} style={{ borderBottom:`1px solid ${C.border}` }}>
              <td style={{ padding:'10px 14px', color:C.teal, ...mono, fontSize:13 }}>{s.source?.twilio_phone_number}</td>
              <td style={{ padding:'10px 14px', color:C.text, fontSize:13 }}>{s.source?.name?.slice(0,30)}</td>
              <td style={{ padding:'10px 14px', ...mono, fontSize:13, color:C.text }}>{fmtMoney(s.totalCost)}</td>
              <td style={{ padding:'10px 14px', ...mono, fontSize:13, color:C.white }}>{s.totalLeads}</td>
              <td style={{ padding:'10px 14px', ...mono, fontSize:13, color:C.green }}>{s.conversions}</td>
              <td style={{ padding:'10px 14px', ...mono, fontSize:13, color:C.green }}>{fmtMoney(s.totalRevenue)}</td>
              <td style={{ padding:'10px 14px', ...mono, fontSize:13, fontWeight:600, color:roiColor(s.roi) }}>{s.roi > 0 ? fmtPct(s.roi) : '--'}</td>
            </tr>)}
            {phoneROI.length === 0 && <tr><td colSpan={7} style={{ padding:30, textAlign:'center', color:C.muted }}>No phone source data yet</td></tr>}
          </tbody>
        </table>
      </Card>
    </>;
  };

  // ═════════════════════════════════════════════════════════════════════════
  // MODALS
  // ═════════════════════════════════════════════════════════════════════════
  const renderModal = () => {
    if (!showModal) return null;

    if (showModal === 'newLead') return <Modal title="New Lead" onClose={()=>setShowModal(null)}>
      <div style={{ display:'flex', gap:12, flexWrap:'wrap' }}>
        <div style={{ flex:'1 1 45%' }}><Input label="First Name" value={formData.first_name} onChange={v=>setFormData(f=>({...f,first_name:v}))} /></div>
        <div style={{ flex:'1 1 45%' }}><Input label="Last Name" value={formData.last_name} onChange={v=>setFormData(f=>({...f,last_name:v}))} /></div>
      </div>
      <Input label="Phone" value={formData.phone} onChange={v=>setFormData(f=>({...f,phone:v}))} />
      <Input label="Email" value={formData.email} onChange={v=>setFormData(f=>({...f,email:v}))} />
      <Input label="Address" value={formData.address} onChange={v=>setFormData(f=>({...f,address:v}))} />
      <div style={{ display:'flex', gap:12, flexWrap:'wrap' }}>
        <div style={{ flex:'1 1 60%' }}><Input label="City" value={formData.city} onChange={v=>setFormData(f=>({...f,city:v}))} /></div>
        <div style={{ flex:'1 1 30%' }}><Input label="ZIP" value={formData.zip} onChange={v=>setFormData(f=>({...f,zip:v}))} /></div>
      </div>
      <Input label="Lead Type" value={formData.lead_type} onChange={v=>setFormData(f=>({...f,lead_type:v}))}
        options={LEAD_TYPES.map(t=>({ value:t, label:t.replace(/_/g,' ') }))} />
      <Input label="Service Interest" value={formData.service_interest} onChange={v=>setFormData(f=>({...f,service_interest:v}))}
        placeholder="e.g. General Pest, Lawn Care, Termite" />
      <Input label="Lead Source" value={formData.lead_source_id} onChange={v=>setFormData(f=>({...f,lead_source_id:v}))}
        options={sources.map(s=>({ value:s.id, label:s.name }))} />
      <Btn onClick={submitForm} disabled={loading}>{loading?'Saving...':'Create Lead'}</Btn>
    </Modal>;

    if (showModal === 'convert') return <Modal title="Convert to Customer" onClose={()=>setShowModal(null)}>
      <Input label="Customer ID (if existing)" value={formData.customer_id} onChange={v=>setFormData(f=>({...f,customer_id:v}))} placeholder="UUID or leave blank" />
      <Input label="Monthly Value ($)" value={formData.monthly_value} onChange={v=>setFormData(f=>({...f,monthly_value:v}))} type="number" />
      <Input label="Initial Service Value ($)" value={formData.initial_service_value} onChange={v=>setFormData(f=>({...f,initial_service_value:v}))} type="number" />
      <Input label="WaveGuard Tier" value={formData.waveguard_tier} onChange={v=>setFormData(f=>({...f,waveguard_tier:v}))}
        options={['bronze','silver','gold','platinum']} />
      <Btn onClick={submitForm} disabled={loading} color={C.green}>{loading?'Converting...':'Convert'}</Btn>
    </Modal>;

    if (showModal === 'lost') return <Modal title="Mark Lead Lost" onClose={()=>setShowModal(null)}>
      <Input label="Reason" value={formData.reason} onChange={v=>setFormData(f=>({...f,reason:v}))}
        options={LOST_REASONS} />
      {formData.reason === 'competitor' && <Input label="Competitor Name" value={formData.competitor}
        onChange={v=>setFormData(f=>({...f,competitor:v}))} placeholder="e.g. Terminix, Orkin, HomeTeam" />}
      <div style={{ marginBottom:12 }}>
        <label style={{ fontSize:12, color:C.muted, display:'block', marginBottom:4 }}>Notes</label>
        <textarea value={formData.notes||''} onChange={e=>setFormData(f=>({...f,notes:e.target.value}))}
          placeholder="Additional context about why this lead was lost..."
          style={{ width:'100%', minHeight:80, backgroundColor:'#0f1923', border:`1px solid ${C.border}`, borderRadius:8,
            padding:'8px 12px', color:C.text, fontSize:13, resize:'vertical', boxSizing:'border-box' }} />
      </div>
      <Btn onClick={submitForm} disabled={loading} color={C.red}>{loading?'Saving...':'Mark Lost'}</Btn>
    </Modal>;

    if (showModal === 'assign') return <Modal title="Assign Lead" onClose={()=>setShowModal(null)}>
      <Input label="Technician" value={formData.technician_id} onChange={v=>setFormData(f=>({...f,technician_id:v}))}
        options={techs.map(t=>({ value:t.id, label:`${t.first_name} ${t.last_name||''}` }))} />
      <Btn onClick={submitForm} disabled={loading} color={C.purple}>{loading?'Assigning...':'Assign'}</Btn>
    </Modal>;

    if (showModal === 'newSource') return <Modal title="Add Lead Source" onClose={()=>setShowModal(null)}>
      <Input label="Name" value={formData.name} onChange={v=>setFormData(f=>({...f,name:v}))} />
      <Input label="Source Type" value={formData.source_type} onChange={v=>setFormData(f=>({...f,source_type:v}))}
        options={['phone_tracking','website_organic','website_paid','social_organic','social_paid','referral','direct','walk_in','marketplace','other'].map(t=>({value:t,label:t.replace(/_/g,' ')}))} />
      <Input label="Channel" value={formData.channel} onChange={v=>setFormData(f=>({...f,channel:v}))} placeholder="e.g. google, facebook, referral" />
      <Input label="Twilio Phone Number" value={formData.twilio_phone_number} onChange={v=>setFormData(f=>({...f,twilio_phone_number:v}))} placeholder="+1XXXXXXXXXX" />
      <Input label="Domain" value={formData.domain} onChange={v=>setFormData(f=>({...f,domain:v}))} placeholder="example.com" />
      <Input label="Cost Type" value={formData.cost_type} onChange={v=>setFormData(f=>({...f,cost_type:v}))}
        options={['free','fixed','per_lead','per_month','one_time']} />
      <Input label="Monthly Cost ($)" value={formData.monthly_cost} onChange={v=>setFormData(f=>({...f,monthly_cost:v}))} type="number" />
      <Btn onClick={submitForm} disabled={loading}>{loading?'Creating...':'Create Source'}</Btn>
    </Modal>;

    if (showModal === 'newCampaign') return <Modal title="New Campaign" onClose={()=>setShowModal(null)}>
      <Input label="Campaign Name" value={formData.name} onChange={v=>setFormData(f=>({...f,name:v}))} />
      <Input label="Channel" value={formData.channel} onChange={v=>setFormData(f=>({...f,channel:v}))} placeholder="e.g. google_ads, facebook, direct_mail" />
      <Input label="Lead Source" value={formData.lead_source_id} onChange={v=>setFormData(f=>({...f,lead_source_id:v}))}
        options={sources.map(s=>({ value:s.id, label:s.name }))} />
      <div style={{ display:'flex', gap:12 }}>
        <div style={{ flex:1 }}><Input label="Start Date" value={formData.start_date} onChange={v=>setFormData(f=>({...f,start_date:v}))} type="date" /></div>
        <div style={{ flex:1 }}><Input label="End Date" value={formData.end_date} onChange={v=>setFormData(f=>({...f,end_date:v}))} type="date" /></div>
      </div>
      <Input label="Budget ($)" value={formData.budget} onChange={v=>setFormData(f=>({...f,budget:v}))} type="number" />
      <div style={{ display:'flex', gap:12 }}>
        <div style={{ flex:1 }}><Input label="Target Leads" value={formData.target_leads} onChange={v=>setFormData(f=>({...f,target_leads:v}))} type="number" /></div>
        <div style={{ flex:1 }}><Input label="Target Conversions" value={formData.target_conversions} onChange={v=>setFormData(f=>({...f,target_conversions:v}))} type="number" /></div>
      </div>
      <Input label="Offer Details" value={formData.offer_details} onChange={v=>setFormData(f=>({...f,offer_details:v}))} placeholder="Special offer or promo description" />
      <div style={{ display:'flex', gap:8 }}>
        <div style={{ flex:1 }}><Input label="UTM Source" value={formData.utm_source} onChange={v=>setFormData(f=>({...f,utm_source:v}))} /></div>
        <div style={{ flex:1 }}><Input label="UTM Medium" value={formData.utm_medium} onChange={v=>setFormData(f=>({...f,utm_medium:v}))} /></div>
        <div style={{ flex:1 }}><Input label="UTM Campaign" value={formData.utm_campaign} onChange={v=>setFormData(f=>({...f,utm_campaign:v}))} /></div>
      </div>
      <Btn onClick={submitForm} disabled={loading}>{loading?'Creating...':'Create Campaign'}</Btn>
    </Modal>;

    if (showModal === 'logCost') return <Modal title="Log Source Cost" onClose={()=>setShowModal(null)}>
      <Input label="Month" value={formData.month} onChange={v=>setFormData(f=>({...f,month:v}))} type="date" />
      <Input label="Cost Amount ($)" value={formData.cost_amount} onChange={v=>setFormData(f=>({...f,cost_amount:v}))} type="number" />
      <Input label="Category" value={formData.cost_category} onChange={v=>setFormData(f=>({...f,cost_category:v}))}
        options={['monthly_fee','domain_renewal','ad_spend','setup','content','other']} />
      <Input label="Notes" value={formData.notes} onChange={v=>setFormData(f=>({...f,notes:v}))} />
      <Btn onClick={submitForm} disabled={loading} color={C.amber}>{loading?'Logging...':'Log Cost'}</Btn>
    </Modal>;

    return null;
  };

  // ═════════════════════════════════════════════════════════════════════════
  // MAIN RENDER
  // ═════════════════════════════════════════════════════════════════════════
  return <div style={{ padding:24, maxWidth:1400, margin:'0 auto', color:C.text }}>
    <h1 style={{ margin:'0 0 8px', fontSize:24, color:C.white }}>Lead Attribution & Marketing ROI</h1>
    <p style={{ margin:'0 0 24px', fontSize:14, color:C.muted }}>Track every lead from first touch to conversion</p>

    <TabBar tabs={[
      { key:'pipeline', label:'Pipeline' },
      { key:'sources', label:'Sources' },
      { key:'campaigns', label:'Campaigns' },
      { key:'analytics', label:'ROI Analytics' },
    ]} active={tab} onChange={setTab} />

    {tab === 'pipeline' && renderPipeline()}
    {tab === 'sources' && renderSources()}
    {tab === 'campaigns' && renderCampaigns()}
    {tab === 'analytics' && renderAnalytics()}

    {renderModal()}
  </div>;
}
