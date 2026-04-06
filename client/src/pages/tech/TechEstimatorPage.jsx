import { useState, useEffect, useRef } from 'react';

const DARK = {
  bg: '#0f1923',
  card: '#1e293b',
  border: '#334155',
  teal: '#0ea5e9',
  text: '#e2e8f0',
  muted: '#94a3b8',
};

const API = import.meta.env.VITE_API_URL || '';

// ---------- Service definitions ----------
const LOT_SIZES = {
  A: { label: 'A — Up to 5k sqft', price: 55 },
  B: { label: 'B — 5k–10k sqft', price: 65 },
  C: { label: 'C — 10k–15k sqft', price: 75 },
  D: { label: 'D — 15k+ sqft', price: 85 },
};

const LAWN_FREQ = [
  { label: 'Weekly', multiplier: 1 },
  { label: 'Bi-Weekly', multiplier: 0.5 },
];

const PEST_FREQ = [
  { label: 'Quarterly', price: 35 },
  { label: 'Bi-Monthly', price: 40 },
  { label: 'Monthly', price: 45 },
];

const MOSQUITO_OPTS = [
  { label: '6 Treatments', monthly: 45 },
  { label: '9 Treatments', monthly: 55 },
];

const TS_OPTS = [
  { label: '4 Treatments', monthly: 35 },
  { label: '6 Treatments', monthly: 45 },
];

const RODENT_OPTS = [
  { label: 'Monitoring — $45/mo', monthly: 45 },
  { label: 'Exclusion — from $295', monthly: 0, oneTime: 295 },
];

const ADDONS = [
  { id: 'fire_ant', label: 'Fire Ant Treatment', price: 149 },
  { id: 'flea', label: 'Flea Treatment', price: 129 },
  { id: 'wdo', label: 'WDO Inspection', price: 125 },
];

function getTier(count) {
  if (count >= 4) return { name: 'Platinum', discount: 0.30 };
  if (count >= 3) return { name: 'Gold', discount: 0.20 };
  if (count >= 2) return { name: 'Silver', discount: 0.15 };
  if (count >= 1) return { name: 'Bronze', discount: 0.10 };
  return { name: 'Bronze', discount: 0 };
}

const TIER_COLORS = {
  Bronze: '#CD7F32',
  Silver: '#90CAF9',
  Gold: '#FDD835',
  Platinum: '#E5E4E2',
};

export default function TechEstimatorPage() {
  const [showPresentation, setShowPresentation] = useState(false);

  // Customer search
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState([]);
  const [selectedCustomer, setSelectedCustomer] = useState(null);
  const [searching, setSearching] = useState(false);
  const searchTimeout = useRef(null);

  // Service toggles
  const [lawn, setLawn] = useState({ on: false, lot: 'A', freq: 0 });
  const [pest, setPest] = useState({ on: false, freq: 0 });
  const [mosquito, setMosquito] = useState({ on: false, opt: 0 });
  const [ts, setTs] = useState({ on: false, opt: 0 });
  const [rodent, setRodent] = useState({ on: false, opt: 0 });
  const [termite, setTermite] = useState({ on: false });
  const [addons, setAddons] = useState({});

  // Sending status
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);

  // ---------- Customer search ----------
  useEffect(() => {
    if (searchQuery.length < 2) { setSearchResults([]); return; }
    clearTimeout(searchTimeout.current);
    searchTimeout.current = setTimeout(async () => {
      setSearching(true);
      try {
        const token = localStorage.getItem('adminToken');
        const res = await fetch(`${API}/api/admin/customers?search=${encodeURIComponent(searchQuery)}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (res.ok) {
          const data = await res.json();
          setSearchResults(Array.isArray(data) ? data : data.customers || []);
        }
      } catch (err) {
        console.error('Search error:', err);
      } finally {
        setSearching(false);
      }
    }, 300);
  }, [searchQuery]);

  // ---------- Calculations ----------
  const serviceCount = [lawn.on, pest.on, mosquito.on, ts.on, rodent.on, termite.on].filter(Boolean).length;
  const tier = getTier(serviceCount);

  let monthlyTotal = 0;
  let oneTimeTotal = 0;

  if (lawn.on) {
    const base = LOT_SIZES[lawn.lot].price;
    const freq = LAWN_FREQ[lawn.freq];
    monthlyTotal += base * freq.multiplier;
  }
  if (pest.on) monthlyTotal += PEST_FREQ[pest.freq].price;
  if (mosquito.on) monthlyTotal += MOSQUITO_OPTS[mosquito.opt].monthly;
  if (ts.on) monthlyTotal += TS_OPTS[ts.opt].monthly;
  if (rodent.on) {
    const r = RODENT_OPTS[rodent.opt];
    monthlyTotal += r.monthly;
    if (r.oneTime) oneTimeTotal += r.oneTime;
  }
  if (termite.on) monthlyTotal += 35;

  Object.keys(addons).forEach((id) => {
    if (addons[id]) {
      const a = ADDONS.find((x) => x.id === id);
      if (a) oneTimeTotal += a.price;
    }
  });

  const discountedMonthly = monthlyTotal * (1 - tier.discount);
  const annualTotal = discountedMonthly * 12 + oneTimeTotal;
  const annualSavings = (monthlyTotal - discountedMonthly) * 12;

  // ---------- Send SMS ----------
  async function sendSMS() {
    if (!selectedCustomer?.phone) return alert('Select a customer with a phone number first.');
    setSending(true);
    try {
      const token = localStorage.getItem('adminToken');
      const lines = buildEstimateText();
      await fetch(`${API}/api/admin/communications/sms`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          to: selectedCustomer.phone,
          message: lines,
        }),
      });
      setSent(true);
      setTimeout(() => setSent(false), 3000);
    } catch (err) {
      alert('Failed to send SMS');
    } finally {
      setSending(false);
    }
  }

  function buildEstimateText() {
    let msg = `Waves Pest Control - Estimate\n`;
    if (selectedCustomer) msg += `For: ${selectedCustomer.name || selectedCustomer.first_name || 'Customer'}\n`;
    msg += `\n`;
    if (lawn.on) msg += `Lawn Care (${LOT_SIZES[lawn.lot].label.split(' — ')[0]}, ${LAWN_FREQ[lawn.freq].label}): $${(LOT_SIZES[lawn.lot].price * LAWN_FREQ[lawn.freq].multiplier).toFixed(0)}/mo\n`;
    if (pest.on) msg += `Pest Control (${PEST_FREQ[pest.freq].label}): $${PEST_FREQ[pest.freq].price}/mo\n`;
    if (mosquito.on) msg += `Mosquito (${MOSQUITO_OPTS[mosquito.opt].label}): $${MOSQUITO_OPTS[mosquito.opt].monthly}/mo\n`;
    if (ts.on) msg += `Tree & Shrub (${TS_OPTS[ts.opt].label}): $${TS_OPTS[ts.opt].monthly}/mo\n`;
    if (rodent.on) msg += `Rodent (${RODENT_OPTS[rodent.opt].label})\n`;
    if (termite.on) msg += `Termite Bait: $35/mo\n`;
    Object.keys(addons).forEach((id) => {
      if (addons[id]) {
        const a = ADDONS.find((x) => x.id === id);
        if (a) msg += `${a.label}: $${a.price} (one-time)\n`;
      }
    });
    msg += `\n`;
    if (tier.discount > 0) {
      msg += `WaveGuard ${tier.name}: ${(tier.discount * 100).toFixed(0)}% bundle discount\n`;
      msg += `Monthly: $${discountedMonthly.toFixed(2)} (was $${monthlyTotal.toFixed(2)})\n`;
      msg += `You save: $${annualSavings.toFixed(0)}/year\n`;
    } else {
      msg += `Monthly: $${monthlyTotal.toFixed(2)}\n`;
    }
    msg += `Annual: $${annualTotal.toFixed(2)}\n`;
    return msg;
  }

  // ---------- Presentation view ----------
  if (showPresentation) {
    return (
      <div style={{
        position: 'fixed', inset: 0, zIndex: 100,
        background: '#fff', color: '#1e293b',
        overflowY: 'auto', padding: '24px 20px',
        fontFamily: "'Nunito Sans', sans-serif",
      }}>
        <div style={{ maxWidth: 480, margin: '0 auto' }}>
          <div style={{ textAlign: 'center', marginBottom: 24 }}>
            <div style={{
              width: 48, height: 48, borderRadius: 12, margin: '0 auto 8px',
              background: 'linear-gradient(135deg, #0ea5e9, #2563eb)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: 22, fontWeight: 800, color: '#fff',
              fontFamily: "'Montserrat', sans-serif",
            }}>W</div>
            <h1 style={{ fontSize: 22, fontWeight: 800, margin: '0 0 4px', fontFamily: "'Montserrat', sans-serif" }}>
              Your Custom Estimate
            </h1>
            {selectedCustomer && (
              <p style={{ fontSize: 14, color: '#64748b', margin: 0 }}>
                Prepared for {selectedCustomer.name || selectedCustomer.first_name || 'Valued Customer'}
              </p>
            )}
          </div>

          {/* Services */}
          <div style={{ marginBottom: 20 }}>
            {lawn.on && <PresentLine label="Lawn Care" sub={`${LOT_SIZES[lawn.lot].label.split(' — ')[0]} lot, ${LAWN_FREQ[lawn.freq].label}`} price={`$${(LOT_SIZES[lawn.lot].price * LAWN_FREQ[lawn.freq].multiplier).toFixed(0)}/mo`} />}
            {pest.on && <PresentLine label="Pest Control" sub={PEST_FREQ[pest.freq].label} price={`$${PEST_FREQ[pest.freq].price}/mo`} />}
            {mosquito.on && <PresentLine label="Mosquito Control" sub={MOSQUITO_OPTS[mosquito.opt].label} price={`$${MOSQUITO_OPTS[mosquito.opt].monthly}/mo`} />}
            {ts.on && <PresentLine label="Tree & Shrub" sub={TS_OPTS[ts.opt].label} price={`$${TS_OPTS[ts.opt].monthly}/mo`} />}
            {rodent.on && <PresentLine label="Rodent Control" sub={RODENT_OPTS[rodent.opt].label} price={RODENT_OPTS[rodent.opt].monthly ? `$${RODENT_OPTS[rodent.opt].monthly}/mo` : `$${RODENT_OPTS[rodent.opt].oneTime}`} />}
            {termite.on && <PresentLine label="Termite Bait" sub="Annual monitoring" price="$35/mo" />}
            {ADDONS.filter((a) => addons[a.id]).map((a) => (
              <PresentLine key={a.id} label={a.label} sub="One-time service" price={`$${a.price}`} />
            ))}
          </div>

          {/* Tier badge */}
          {tier.discount > 0 && (
            <div style={{
              textAlign: 'center', padding: '12px', borderRadius: 10,
              background: `${TIER_COLORS[tier.name]}20`,
              border: `2px solid ${TIER_COLORS[tier.name]}`,
              marginBottom: 16,
            }}>
              <p style={{ margin: 0, fontSize: 15, fontWeight: 700, fontFamily: "'Montserrat', sans-serif" }}>
                WaveGuard {tier.name} - {(tier.discount * 100).toFixed(0)}% Off
              </p>
              <p style={{ margin: '4px 0 0', fontSize: 13, color: '#64748b' }}>
                Save ${annualSavings.toFixed(0)} per year
              </p>
            </div>
          )}

          {/* Totals */}
          <div style={{
            background: '#f8fafc', borderRadius: 12, padding: 16,
            border: '1px solid #e2e8f0', marginBottom: 24,
          }}>
            {tier.discount > 0 && (
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
                <span style={{ fontSize: 13, color: '#94a3b8', textDecoration: 'line-through' }}>Before discount</span>
                <span style={{ fontSize: 13, color: '#94a3b8', textDecoration: 'line-through' }}>${monthlyTotal.toFixed(2)}/mo</span>
              </div>
            )}
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
              <span style={{ fontSize: 16, fontWeight: 700 }}>Monthly Total</span>
              <span style={{ fontSize: 16, fontWeight: 800, color: '#0ea5e9' }}>${discountedMonthly.toFixed(2)}</span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span style={{ fontSize: 13, color: '#64748b' }}>Annual Total</span>
              <span style={{ fontSize: 13, color: '#64748b' }}>${annualTotal.toFixed(2)}</span>
            </div>
          </div>

          <button onClick={() => setShowPresentation(false)} style={{
            width: '100%', padding: 14, borderRadius: 10,
            background: '#0ea5e9', color: '#fff', border: 'none',
            fontSize: 15, fontWeight: 700, cursor: 'pointer',
            fontFamily: "'Montserrat', sans-serif",
          }}>Back to Estimator</button>
        </div>
      </div>
    );
  }

  // ---------- Main estimator UI ----------
  return (
    <div style={{ maxWidth: 480, margin: '0 auto' }}>
      <h1 style={{
        fontSize: 20, fontWeight: 700, margin: '0 0 16px',
        fontFamily: "'Montserrat', sans-serif", color: DARK.text,
      }}>Field Estimator</h1>

      {/* Customer search */}
      <div style={{ marginBottom: 16 }}>
        <label style={{ fontSize: 12, fontWeight: 600, color: DARK.muted, display: 'block', marginBottom: 4 }}>Customer</label>
        {selectedCustomer ? (
          <div style={{
            background: DARK.card, borderRadius: 10, padding: '10px 14px',
            border: `1px solid ${DARK.teal}`,
            display: 'flex', justifyContent: 'space-between', alignItems: 'center',
          }}>
            <span style={{ fontSize: 14, fontWeight: 600, color: DARK.text }}>
              {selectedCustomer.name || selectedCustomer.first_name || 'Customer'}
            </span>
            <button onClick={() => { setSelectedCustomer(null); setSearchQuery(''); }} style={{
              background: 'none', border: 'none', color: DARK.muted, fontSize: 18, cursor: 'pointer',
            }}>&times;</button>
          </div>
        ) : (
          <div style={{ position: 'relative' }}>
            <input
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search customer name or phone..."
              style={{
                width: '100%', padding: '10px 14px', borderRadius: 10,
                background: DARK.card, border: `1px solid ${DARK.border}`,
                color: DARK.text, fontSize: 14, outline: 'none',
                boxSizing: 'border-box',
              }}
            />
            {searchResults.length > 0 && (
              <div style={{
                position: 'absolute', top: '100%', left: 0, right: 0,
                background: DARK.card, border: `1px solid ${DARK.border}`,
                borderRadius: 10, marginTop: 4, zIndex: 10,
                maxHeight: 200, overflowY: 'auto',
              }}>
                {searchResults.slice(0, 5).map((c, i) => (
                  <button key={c.id || i} onClick={() => {
                    setSelectedCustomer(c);
                    setSearchQuery('');
                    setSearchResults([]);
                  }} style={{
                    width: '100%', padding: '10px 14px', background: 'none',
                    border: 'none', borderBottom: `1px solid ${DARK.border}`,
                    color: DARK.text, fontSize: 14, textAlign: 'left',
                    cursor: 'pointer',
                  }}>
                    {c.name || c.first_name || 'Customer'} {c.phone && <span style={{ color: DARK.muted, fontSize: 12, marginLeft: 8 }}>{c.phone}</span>}
                  </button>
                ))}
              </div>
            )}
            {searching && <span style={{ position: 'absolute', right: 12, top: 10, fontSize: 12, color: DARK.muted }}>...</span>}
          </div>
        )}
      </div>

      {/* Services */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 16 }}>
        {/* Lawn Care */}
        <ServiceCard
          label="Lawn Care"
          icon="🌿"
          on={lawn.on}
          onToggle={() => setLawn((p) => ({ ...p, on: !p.on }))}
        >
          <OptionRow label="Lot Size">
            <SegmentedControl
              options={Object.keys(LOT_SIZES).map((k) => ({ label: k, value: k }))}
              value={lawn.lot}
              onChange={(v) => setLawn((p) => ({ ...p, lot: v }))}
            />
          </OptionRow>
          <OptionRow label="Frequency">
            <SegmentedControl
              options={LAWN_FREQ.map((f, i) => ({ label: f.label, value: i }))}
              value={lawn.freq}
              onChange={(v) => setLawn((p) => ({ ...p, freq: v }))}
            />
          </OptionRow>
          <PriceTag value={`$${(LOT_SIZES[lawn.lot].price * LAWN_FREQ[lawn.freq].multiplier).toFixed(0)}/mo`} />
        </ServiceCard>

        {/* Pest Control */}
        <ServiceCard
          label="Pest Control"
          icon="🐜"
          on={pest.on}
          onToggle={() => setPest((p) => ({ ...p, on: !p.on }))}
        >
          <OptionRow label="Frequency">
            <SegmentedControl
              options={PEST_FREQ.map((f, i) => ({ label: f.label, value: i }))}
              value={pest.freq}
              onChange={(v) => setPest((p) => ({ ...p, freq: v }))}
            />
          </OptionRow>
          <PriceTag value={`$${PEST_FREQ[pest.freq].price}/mo`} />
        </ServiceCard>

        {/* Mosquito */}
        <ServiceCard
          label="Mosquito Control"
          icon="🦟"
          on={mosquito.on}
          onToggle={() => setMosquito((p) => ({ ...p, on: !p.on }))}
        >
          <OptionRow label="Plan">
            <SegmentedControl
              options={MOSQUITO_OPTS.map((o, i) => ({ label: o.label, value: i }))}
              value={mosquito.opt}
              onChange={(v) => setMosquito((p) => ({ ...p, opt: v }))}
            />
          </OptionRow>
          <PriceTag value={`$${MOSQUITO_OPTS[mosquito.opt].monthly}/mo`} />
        </ServiceCard>

        {/* Tree & Shrub */}
        <ServiceCard
          label="Tree & Shrub"
          icon="🌳"
          on={ts.on}
          onToggle={() => setTs((p) => ({ ...p, on: !p.on }))}
        >
          <OptionRow label="Plan">
            <SegmentedControl
              options={TS_OPTS.map((o, i) => ({ label: o.label, value: i }))}
              value={ts.opt}
              onChange={(v) => setTs((p) => ({ ...p, opt: v }))}
            />
          </OptionRow>
          <PriceTag value={`$${TS_OPTS[ts.opt].monthly}/mo`} />
        </ServiceCard>

        {/* Rodent */}
        <ServiceCard
          label="Rodent Control"
          icon="🐀"
          on={rodent.on}
          onToggle={() => setRodent((p) => ({ ...p, on: !p.on }))}
        >
          <OptionRow label="Type">
            <SegmentedControl
              options={RODENT_OPTS.map((o, i) => ({ label: i === 0 ? 'Monitor' : 'Exclusion', value: i }))}
              value={rodent.opt}
              onChange={(v) => setRodent((p) => ({ ...p, opt: v }))}
            />
          </OptionRow>
          <PriceTag value={RODENT_OPTS[rodent.opt].monthly ? `$${RODENT_OPTS[rodent.opt].monthly}/mo` : `From $${RODENT_OPTS[rodent.opt].oneTime}`} />
        </ServiceCard>

        {/* Termite */}
        <ServiceCard
          label="Termite Bait System"
          icon="🪵"
          on={termite.on}
          onToggle={() => setTermite((p) => ({ ...p, on: !p.on }))}
        >
          <PriceTag value="$35/mo" />
        </ServiceCard>
      </div>

      {/* One-time Add-ons */}
      <h2 style={{
        fontSize: 13, fontWeight: 700, color: DARK.muted, margin: '0 0 8px',
        fontFamily: "'Montserrat', sans-serif", textTransform: 'uppercase', letterSpacing: 1,
      }}>One-Time Add-Ons</h2>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 20 }}>
        {ADDONS.map((a) => (
          <button
            key={a.id}
            onClick={() => setAddons((p) => ({ ...p, [a.id]: !p[a.id] }))}
            style={{
              display: 'flex', justifyContent: 'space-between', alignItems: 'center',
              background: DARK.card, borderRadius: 10, padding: '12px 14px',
              border: `1px solid ${addons[a.id] ? DARK.teal : DARK.border}`,
              color: DARK.text, cursor: 'pointer', transition: 'border-color 0.2s',
            }}
          >
            <span style={{ fontSize: 14, fontWeight: 600 }}>{a.label}</span>
            <span style={{ fontSize: 13, fontWeight: 700, color: addons[a.id] ? DARK.teal : DARK.muted }}>${a.price}</span>
          </button>
        ))}
      </div>

      {/* WaveGuard Tier */}
      {serviceCount >= 2 && (
        <div style={{
          background: `${TIER_COLORS[tier.name]}15`,
          borderRadius: 12, padding: '12px 16px',
          border: `1px solid ${TIER_COLORS[tier.name]}60`,
          marginBottom: 16, textAlign: 'center',
        }}>
          <p style={{
            margin: 0, fontSize: 14, fontWeight: 700, color: TIER_COLORS[tier.name],
            fontFamily: "'Montserrat', sans-serif",
          }}>
            WaveGuard {tier.name} - {(tier.discount * 100).toFixed(0)}% Bundle Discount
          </p>
        </div>
      )}

      {/* Summary Card */}
      <div style={{
        background: DARK.card, borderRadius: 12, padding: 16,
        border: `1px solid ${DARK.border}`, marginBottom: 16,
      }}>
        <h3 style={{
          fontSize: 14, fontWeight: 700, color: DARK.text, margin: '0 0 12px',
          fontFamily: "'Montserrat', sans-serif",
        }}>Estimate Summary</h3>

        {tier.discount > 0 && (
          <Row label="Monthly (before discount)" value={`$${monthlyTotal.toFixed(2)}`} muted strikethrough />
        )}
        <Row label="Monthly Total" value={`$${discountedMonthly.toFixed(2)}`} bold teal />
        {oneTimeTotal > 0 && <Row label="One-Time Services" value={`$${oneTimeTotal.toFixed(2)}`} />}
        <Row label="Annual Total" value={`$${annualTotal.toFixed(2)}`} />
        {annualSavings > 0 && <Row label="Annual Savings" value={`$${annualSavings.toFixed(0)}`} green />}
      </div>

      {/* Action Buttons */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, paddingBottom: 16 }}>
        <button onClick={sendSMS} disabled={sending} style={{
          width: '100%', padding: 14, borderRadius: 10,
          background: DARK.teal, color: '#fff', border: 'none',
          fontSize: 15, fontWeight: 700, cursor: 'pointer',
          fontFamily: "'Montserrat', sans-serif",
          opacity: sending ? 0.6 : 1,
        }}>
          {sent ? 'Sent!' : sending ? 'Sending...' : 'Send to Customer via SMS'}
        </button>
        <button onClick={() => setShowPresentation(true)} style={{
          width: '100%', padding: 14, borderRadius: 10,
          background: 'transparent', color: DARK.teal,
          border: `1px solid ${DARK.teal}`,
          fontSize: 15, fontWeight: 700, cursor: 'pointer',
          fontFamily: "'Montserrat', sans-serif",
        }}>Show on Screen</button>
        <button onClick={() => alert('Draft saved!')} style={{
          width: '100%', padding: 14, borderRadius: 10,
          background: 'transparent', color: DARK.muted,
          border: `1px solid ${DARK.border}`,
          fontSize: 15, fontWeight: 600, cursor: 'pointer',
          fontFamily: "'Montserrat', sans-serif",
        }}>Save Draft</button>
      </div>
    </div>
  );
}

// ---------- Sub-components ----------

function ServiceCard({ label, icon, on, onToggle, children }) {
  return (
    <div style={{
      background: DARK.card,
      borderRadius: 12,
      border: `1px solid ${on ? DARK.teal : DARK.border}`,
      overflow: 'hidden',
      transition: 'border-color 0.2s',
    }}>
      <button onClick={onToggle} style={{
        width: '100%', display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        padding: '12px 14px', background: 'none', border: 'none',
        cursor: 'pointer', color: DARK.text,
      }}>
        <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 20 }}>{icon}</span>
          <span style={{ fontSize: 15, fontWeight: 700, fontFamily: "'Montserrat', sans-serif" }}>{label}</span>
        </span>
        <TogglePill on={on} />
      </button>
      {on && (
        <div style={{ padding: '0 14px 12px', display: 'flex', flexDirection: 'column', gap: 10 }}>
          {children}
        </div>
      )}
    </div>
  );
}

function TogglePill({ on }) {
  return (
    <div style={{
      width: 44, height: 24, borderRadius: 12,
      background: on ? DARK.teal : DARK.border,
      position: 'relative', transition: 'background 0.2s',
    }}>
      <div style={{
        width: 20, height: 20, borderRadius: '50%',
        background: '#fff', position: 'absolute', top: 2,
        left: on ? 22 : 2, transition: 'left 0.2s',
      }} />
    </div>
  );
}

function OptionRow({ label, children }) {
  return (
    <div>
      <span style={{ fontSize: 11, fontWeight: 600, color: DARK.muted, display: 'block', marginBottom: 4 }}>{label}</span>
      {children}
    </div>
  );
}

function SegmentedControl({ options, value, onChange }) {
  return (
    <div style={{
      display: 'flex', gap: 4, background: '#0f1923',
      borderRadius: 8, padding: 3,
    }}>
      {options.map((opt) => {
        const active = opt.value === value;
        return (
          <button key={opt.value} onClick={() => onChange(opt.value)} style={{
            flex: 1, padding: '6px 4px', borderRadius: 6,
            background: active ? DARK.teal : 'transparent',
            color: active ? '#fff' : DARK.muted,
            border: 'none', fontSize: 11, fontWeight: 600,
            cursor: 'pointer', transition: 'all 0.2s',
            whiteSpace: 'nowrap',
          }}>{opt.label}</button>
        );
      })}
    </div>
  );
}

function PriceTag({ value }) {
  return (
    <div style={{ textAlign: 'right' }}>
      <span style={{ fontSize: 15, fontWeight: 800, color: DARK.teal, fontFamily: "'Montserrat', sans-serif" }}>{value}</span>
    </div>
  );
}

function Row({ label, value, bold, teal, muted, green, strikethrough }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
      <span style={{
        fontSize: 13, color: muted ? DARK.muted : DARK.text,
        textDecoration: strikethrough ? 'line-through' : 'none',
        fontWeight: bold ? 700 : 400,
      }}>{label}</span>
      <span style={{
        fontSize: bold ? 16 : 13,
        fontWeight: bold ? 800 : 600,
        color: teal ? DARK.teal : green ? '#22c55e' : muted ? DARK.muted : DARK.text,
        textDecoration: strikethrough ? 'line-through' : 'none',
        fontFamily: bold ? "'Montserrat', sans-serif" : 'inherit',
      }}>{value}</span>
    </div>
  );
}

function PresentLine({ label, sub, price }) {
  return (
    <div style={{
      display: 'flex', justifyContent: 'space-between', alignItems: 'center',
      padding: '10px 0', borderBottom: '1px solid #e2e8f0',
    }}>
      <div>
        <p style={{ margin: 0, fontSize: 15, fontWeight: 700, color: '#1e293b' }}>{label}</p>
        <p style={{ margin: '2px 0 0', fontSize: 12, color: '#64748b' }}>{sub}</p>
      </div>
      <span style={{ fontSize: 15, fontWeight: 700, color: '#0ea5e9' }}>{price}</span>
    </div>
  );
}
