import { useState, useEffect } from 'react';
import { useAuth } from '../hooks/useAuth';
import api from '../utils/api';

// =========================================================================
// BRAND CONSTANTS
// =========================================================================
const B = {
  navy: '#0B2545', blue: '#1B4965', teal: '#2E8B8B', aqua: '#5DB7B7',
  mint: '#A8DADC', sand: '#F4F0E8', cream: '#FDFBF7', white: '#FFFFFF',
  orange: '#E8763A', green: '#3A8F5C', red: '#C44B4B', gold: '#D4A843',
  gray: '#6B7C8D', lightGray: '#E8ECF0',
};

const TIER = {
  Bronze: { color: '#CD7F32', discount: '0%' },
  Silver: { color: '#8C9EAF', discount: '5%' },
  Gold: { color: '#D4A843', discount: '10%' },
  Platinum: { color: '#6B7C8D', discount: '15%' },
};

// =========================================================================
// TAB BAR
// =========================================================================
function TabBar({ tabs, active, onSelect }) {
  return (
    <div style={{
      display: 'flex', gap: 2, background: B.lightGray, borderRadius: 14,
      padding: 4, maxWidth: 700, margin: '0 auto', overflowX: 'auto',
    }}>
      {tabs.map(t => (
        <button key={t.id} onClick={() => onSelect(t.id)} style={{
          flex: 1, padding: '10px 12px', borderRadius: 11, border: 'none',
          cursor: 'pointer', fontSize: 13, whiteSpace: 'nowrap',
          fontWeight: active === t.id ? 700 : 500,
          fontFamily: "'DM Sans', sans-serif",
          background: active === t.id ? B.white : 'transparent',
          color: active === t.id ? B.navy : B.gray,
          boxShadow: active === t.id ? '0 2px 8px rgba(0,0,0,0.08)' : 'none',
          transition: 'all 0.25s ease',
        }}>{t.icon} {t.label}</button>
      ))}
    </div>
  );
}

// =========================================================================
// DASHBOARD TAB
// =========================================================================
function DashboardTab({ customer }) {
  const [nextService, setNextService] = useState(null);
  const [stats, setStats] = useState(null);
  const [balance, setBalance] = useState(null);

  useEffect(() => {
    api.getNextService().then(d => setNextService(d.next)).catch(console.error);
    api.getServiceStats().then(setStats).catch(console.error);
    api.getBalance().then(setBalance).catch(console.error);
  }, []);

  const formatTime = (t) => {
    if (!t) return 'TBD';
    const [h, m] = t.split(':').map(Number);
    const ampm = h >= 12 ? 'PM' : 'AM';
    return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${ampm}`;
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      {/* Welcome */}
      <div style={{
        position: 'relative', overflow: 'hidden',
        background: `linear-gradient(135deg, ${B.navy}, ${B.blue}, ${B.teal})`,
        borderRadius: 20, padding: '28px 24px 40px', color: '#fff',
      }}>
        <div style={{ fontSize: 13, opacity: 0.7 }}>Welcome back,</div>
        <div style={{ fontSize: 26, fontWeight: 800, fontFamily: "'Playfair Display', serif" }}>
          {customer.firstName} 👋
        </div>
        <div style={{
          marginTop: 12, display: 'inline-flex', alignItems: 'center', gap: 6,
          padding: '5px 14px', borderRadius: 24, fontSize: 13, fontWeight: 700,
          background: `${TIER[customer.tier]?.color}22`,
          color: TIER[customer.tier]?.color, border: `1.5px solid ${TIER[customer.tier]?.color}44`,
        }}>🛡️ {customer.tier} WaveGuard</div>
        <div style={{ marginTop: 12, fontSize: 13, opacity: 0.85, lineHeight: 1.6 }}>
          {customer.address?.line1}, {customer.address?.city}, {customer.address?.state} {customer.address?.zip}<br/>
          {customer.property?.lawnType} · {customer.property?.propertySqFt?.toLocaleString()} sq ft treated
        </div>
      </div>

      {/* Next service */}
      {nextService && (
        <div style={{
          background: B.white, borderRadius: 16, padding: 20,
          border: `2px solid ${B.teal}22`, boxShadow: '0 4px 20px rgba(0,0,0,0.04)',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 14 }}>
            <div style={{
              width: 44, height: 44, borderRadius: 12,
              background: `linear-gradient(135deg, ${B.teal}, ${B.aqua})`,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: 20, color: '#fff',
            }}>📅</div>
            <div>
              <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 1, color: B.teal }}>Next Service</div>
              <div style={{ fontSize: 18, fontWeight: 700, color: B.navy }}>
                {new Date(nextService.date + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
              </div>
            </div>
          </div>
          <div style={{ fontSize: 14, color: B.gray }}>{nextService.serviceType}</div>
          <div style={{ fontSize: 13, color: B.gray, marginTop: 4 }}>
            Technician: <strong style={{ color: B.navy }}>{nextService.technician || 'TBD'}</strong>
            {nextService.windowStart && ` · ${formatTime(nextService.windowStart)} – ${formatTime(nextService.windowEnd)}`}
          </div>
          <div style={{ marginTop: 14, display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            {!nextService.customerConfirmed && (
              <button onClick={() => {
                api.confirmAppointment(nextService.id).then(() => {
                  setNextService({ ...nextService, customerConfirmed: true, status: 'confirmed' });
                });
              }} style={{
                padding: '9px 18px', borderRadius: 10, border: 'none',
                background: B.teal, color: '#fff', fontSize: 13, fontWeight: 600,
                cursor: 'pointer', fontFamily: "'DM Sans', sans-serif",
              }}>Confirm Appointment</button>
            )}
            {nextService.customerConfirmed && (
              <span style={{
                padding: '9px 18px', borderRadius: 10, background: '#E8F5E9',
                color: B.green, fontSize: 13, fontWeight: 700,
              }}>✓ Confirmed</span>
            )}
          </div>
        </div>
      )}

      {/* Quick stats */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        {[
          { label: 'Monthly Rate', value: `$${customer.monthlyRate}`, sub: `${TIER[customer.tier]?.discount} discount`, icon: '💰' },
          { label: 'Balance', value: balance ? `$${balance.currentBalance.toFixed(2)}` : '...', sub: 'All current', icon: '✅' },
          { label: 'Services YTD', value: stats?.servicesYTD ?? '...', sub: `Celsius: ${stats?.celsiusApplicationsThisYear ?? '?'}/${stats?.celsiusMaxPerYear ?? 3}`, icon: '📋' },
          { label: 'Member Since', value: customer.memberSince ? new Date(customer.memberSince + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', year: 'numeric' }) : '—', sub: '', icon: '⭐' },
        ].map((s, i) => (
          <div key={i} style={{
            background: B.white, borderRadius: 14, padding: 16,
            border: `1px solid ${B.lightGray}`,
          }}>
            <div style={{ fontSize: 20, marginBottom: 6 }}>{s.icon}</div>
            <div style={{ fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.8, color: B.gray }}>{s.label}</div>
            <div style={{ fontSize: 20, fontWeight: 800, color: B.navy, marginTop: 2 }}>{s.value}</div>
            <div style={{ fontSize: 11, color: B.green, fontWeight: 600, marginTop: 2 }}>{s.sub}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

// =========================================================================
// SERVICES TAB
// =========================================================================
function ServicesTab() {
  const [services, setServices] = useState([]);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState(null);

  useEffect(() => {
    api.getServices({ limit: 20 }).then(d => { setServices(d.services); setLoading(false); }).catch(console.error);
  }, []);

  if (loading) return <div style={{ padding: 40, textAlign: 'center', color: B.gray }}>Loading service history...</div>;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{ fontSize: 18, fontWeight: 800, color: B.navy, fontFamily: "'Playfair Display', serif" }}>Service History</div>
      {services.map(s => (
        <div key={s.id} style={{
          background: B.white, borderRadius: 14, overflow: 'hidden',
          border: `1px solid ${expanded === s.id ? B.teal + '44' : B.lightGray}`,
          transition: 'all 0.3s ease',
        }}>
          <div onClick={() => setExpanded(expanded === s.id ? null : s.id)}
            style={{ padding: '16px 18px', cursor: 'pointer', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div>
              <div style={{ fontSize: 14, fontWeight: 700, color: B.navy }}>{s.type}</div>
              <div style={{ fontSize: 12, color: B.gray, marginTop: 2 }}>
                {new Date(s.date + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })} · {s.technician}
              </div>
            </div>
            <span style={{
              fontSize: 18, color: B.gray, transition: 'transform 0.3s',
              transform: expanded === s.id ? 'rotate(180deg)' : 'rotate(0)',
            }}>▾</span>
          </div>
          {expanded === s.id && (
            <div style={{ padding: '0 18px 18px', borderTop: `1px solid ${B.lightGray}` }}>
              <div style={{ marginTop: 14, fontSize: 13, color: B.navy, lineHeight: 1.7 }}>
                <strong style={{ color: B.teal }}>Technician Notes:</strong><br/>{s.notes}
              </div>
              {s.soilTemp && <div style={{ fontSize: 12, color: B.gray, marginTop: 8 }}>Soil Temp: {s.soilTemp}°F</div>}
              {s.thatchMeasurement && <div style={{ fontSize: 12, color: B.gray }}>Thatch: {s.thatchMeasurement}"</div>}
              {s.soilPh && <div style={{ fontSize: 12, color: B.gray }}>Soil pH: {s.soilPh}</div>}
              <div style={{ marginTop: 14, fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 1, color: B.gray }}>Products Applied</div>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 6 }}>
                {s.products.map((p, i) => (
                  <span key={i} style={{
                    padding: '4px 10px', borderRadius: 8, fontSize: 11, fontWeight: 600,
                    background: `${B.teal}12`, color: B.teal, border: `1px solid ${B.teal}22`,
                  }}>{p.product_name}</span>
                ))}
              </div>
              {s.hasPhotos && (
                <div style={{ marginTop: 12, padding: '10px 14px', borderRadius: 10, background: `${B.teal}08`, fontSize: 12, color: B.teal, fontWeight: 600 }}>
                  📷 {s.photoCount} photo{s.photoCount > 1 ? 's' : ''} attached — tap to view
                </div>
              )}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

// =========================================================================
// SCHEDULE TAB
// =========================================================================
function ScheduleTab({ customer }) {
  const [upcoming, setUpcoming] = useState([]);
  const [prefs, setPrefs] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([
      api.getSchedule(90),
      api.getNotificationPrefs(),
    ]).then(([schedData, prefsData]) => {
      setUpcoming(schedData.upcoming);
      setPrefs(prefsData);
      setLoading(false);
    }).catch(console.error);
  }, []);

  const handleToggle = async (key) => {
    const newVal = !prefs[key];
    setPrefs({ ...prefs, [key]: newVal });
    try {
      await api.updateNotificationPrefs({ [key]: newVal });
    } catch (err) {
      setPrefs({ ...prefs, [key]: !newVal }); // rollback
      console.error(err);
    }
  };

  const handleConfirm = async (id) => {
    try {
      await api.confirmAppointment(id);
      setUpcoming(upcoming.map(s => s.id === id ? { ...s, status: 'confirmed', customerConfirmed: true } : s));
    } catch (err) {
      console.error(err);
    }
  };

  const formatTime = (t) => {
    if (!t) return 'TBD';
    const [h, m] = t.split(':').map(Number);
    return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`;
  };

  if (loading) return <div style={{ padding: 40, textAlign: 'center', color: B.gray }}>Loading schedule...</div>;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ fontSize: 18, fontWeight: 800, color: B.navy, fontFamily: "'Playfair Display', serif" }}>Upcoming Services</div>

      {upcoming.map(s => (
        <div key={s.id} style={{
          background: B.white, borderRadius: 14, padding: 18,
          border: `1px solid ${B.lightGray}`, display: 'flex', gap: 14,
        }}>
          <div style={{
            minWidth: 52, height: 52, borderRadius: 12,
            background: `${B.teal}12`, border: `1px solid ${B.teal}22`,
            display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
          }}>
            <div style={{ fontSize: 16, fontWeight: 800, color: B.teal }}>
              {new Date(s.date + 'T12:00:00').getDate()}
            </div>
            <div style={{ fontSize: 10, fontWeight: 600, color: B.gray, textTransform: 'uppercase' }}>
              {new Date(s.date + 'T12:00:00').toLocaleDateString('en-US', { month: 'short' })}
            </div>
          </div>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 14, fontWeight: 700, color: B.navy }}>{s.serviceType}</div>
            <div style={{ fontSize: 12, color: B.gray, marginTop: 3 }}>
              {s.windowStart ? `${formatTime(s.windowStart)} – ${formatTime(s.windowEnd)}` : 'Time TBD'} · {s.technician}
            </div>
            <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
              {!s.customerConfirmed ? (
                <button onClick={() => handleConfirm(s.id)} style={{
                  padding: '6px 14px', borderRadius: 8, border: 'none',
                  background: B.teal, color: '#fff', fontSize: 12, fontWeight: 600,
                  cursor: 'pointer', fontFamily: "'DM Sans', sans-serif",
                }}>Confirm</button>
              ) : (
                <span style={{ fontSize: 12, color: B.green, fontWeight: 700 }}>✓ Confirmed</span>
              )}
            </div>
          </div>
        </div>
      ))}

      {/* SMS Prefs */}
      {prefs && (
        <div style={{
          marginTop: 8, background: B.white, borderRadius: 14, padding: 20,
          border: `1px solid ${B.lightGray}`,
        }}>
          <div style={{ fontSize: 15, fontWeight: 700, color: B.navy, marginBottom: 4 }}>📱 SMS Notification Preferences</div>
          <div style={{ fontSize: 12, color: B.gray, marginBottom: 14 }}>Powered by Twilio · Messages sent to {customer.phone}</div>
          {[
            { key: 'serviceReminder24h', label: 'Service Reminders (24hr before)' },
            { key: 'techEnRoute', label: 'Tech En Route Alert' },
            { key: 'serviceCompleted', label: 'Service Completed Summary' },
            { key: 'billingReminder', label: 'Monthly Billing Reminder' },
            { key: 'seasonalTips', label: 'Seasonal Tips & Alerts' },
          ].map(p => (
            <div key={p.key} style={{
              display: 'flex', justifyContent: 'space-between', alignItems: 'center',
              padding: '10px 0', borderBottom: `1px solid ${B.lightGray}`,
            }}>
              <span style={{ fontSize: 13, color: B.navy, fontWeight: 500 }}>{p.label}</span>
              <div onClick={() => handleToggle(p.key)} style={{
                width: 44, height: 24, borderRadius: 12, cursor: 'pointer',
                background: prefs[p.key] ? B.teal : B.lightGray,
                position: 'relative', transition: 'background 0.3s',
              }}>
                <div style={{
                  position: 'absolute', top: 2, width: 20, height: 20,
                  borderRadius: '50%', background: '#fff', boxShadow: '0 1px 4px rgba(0,0,0,0.2)',
                  left: prefs[p.key] ? 22 : 2, transition: 'left 0.3s',
                }} />
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// =========================================================================
// BILLING TAB
// =========================================================================
function BillingTab() {
  const [payments, setPayments] = useState([]);
  const [balance, setBalance] = useState(null);
  const [cards, setCards] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([
      api.getPayments(),
      api.getBalance(),
      api.getCards(),
    ]).then(([payData, balData, cardData]) => {
      setPayments(payData.payments);
      setBalance(balData);
      setCards(cardData.cards);
      setLoading(false);
    }).catch(console.error);
  }, []);

  if (loading) return <div style={{ padding: 40, textAlign: 'center', color: B.gray }}>Loading billing...</div>;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ fontSize: 18, fontWeight: 800, color: B.navy, fontFamily: "'Playfair Display', serif" }}>Billing & Payments</div>
      <div style={{ fontSize: 13, color: B.gray }}>Powered by Square · Secure payment processing</div>

      {/* Balance card */}
      {balance && (
        <div style={{
          background: `linear-gradient(135deg, ${B.navy}, ${B.blue})`,
          borderRadius: 16, padding: 22, color: '#fff',
        }}>
          <div style={{ fontSize: 12, opacity: 0.7 }}>Current Balance</div>
          <div style={{ fontSize: 36, fontWeight: 800, fontFamily: "'Playfair Display', serif" }}>
            ${balance.currentBalance.toFixed(2)}
          </div>
          {balance.nextCharge && (
            <div style={{ fontSize: 12, opacity: 0.7, marginTop: 4 }}>
              Next charge: ${balance.nextCharge.amount.toFixed(2)} on{' '}
              {new Date(balance.nextCharge.date + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
            </div>
          )}
        </div>
      )}

      {/* Cards */}
      {cards.map(c => (
        <div key={c.id} style={{
          background: B.white, borderRadius: 14, padding: 18,
          border: `1px solid ${B.lightGray}`, display: 'flex', alignItems: 'center', gap: 14,
        }}>
          <div style={{
            width: 48, height: 32, borderRadius: 6,
            background: 'linear-gradient(135deg, #1A1F71, #2E3B8C)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            color: '#fff', fontSize: 10, fontWeight: 800, letterSpacing: 1,
          }}>{c.brand}</div>
          <div>
            <div style={{ fontSize: 14, fontWeight: 600, color: B.navy }}>{c.brand} ending in {c.lastFour}</div>
            <div style={{ fontSize: 12, color: B.gray }}>Expires {c.expMonth}/{c.expYear} · Auto-pay {c.autopayEnabled ? 'enabled' : 'disabled'}</div>
          </div>
          {c.isDefault && (
            <span style={{ marginLeft: 'auto', fontSize: 11, fontWeight: 600, color: B.green, background: `${B.green}15`, padding: '3px 8px', borderRadius: 6 }}>Active</span>
          )}
        </div>
      ))}

      {/* Payment history */}
      <div style={{ fontSize: 15, fontWeight: 700, color: B.navy }}>Payment History</div>
      {payments.map(p => (
        <div key={p.id} style={{
          background: B.white, borderRadius: 12, padding: '14px 18px',
          border: `1px solid ${B.lightGray}`,
          display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        }}>
          <div>
            <div style={{ fontSize: 13, fontWeight: 600, color: B.navy }}>{p.description}</div>
            <div style={{ fontSize: 11, color: B.gray, marginTop: 2 }}>
              {new Date(p.date + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
              {p.lastFour && ` · ${p.cardBrand} ••••${p.lastFour}`}
            </div>
          </div>
          <div style={{ textAlign: 'right' }}>
            <div style={{ fontSize: 15, fontWeight: 700, color: B.navy }}>${p.amount.toFixed(2)}</div>
            <span style={{
              fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.5,
              padding: '3px 8px', borderRadius: 20,
              background: p.status === 'paid' ? '#E8F5E9' : '#FFF3E0',
              color: p.status === 'paid' ? B.green : B.orange,
            }}>{p.status}</span>
          </div>
        </div>
      ))}
    </div>
  );
}

// =========================================================================
// MAIN PORTAL
// =========================================================================
const TABS = [
  { id: 'dashboard', label: 'Home', icon: '🏠' },
  { id: 'services', label: 'History', icon: '📋' },
  { id: 'schedule', label: 'Schedule', icon: '📅' },
  { id: 'billing', label: 'Billing', icon: '💳' },
];

export default function PortalPage() {
  const { customer, logout } = useAuth();
  const [activeTab, setActiveTab] = useState('dashboard');

  if (!customer) return null;

  const initials = `${customer.firstName?.[0] || ''}${customer.lastName?.[0] || ''}`;

  return (
    <div style={{
      minHeight: '100vh',
      background: `linear-gradient(180deg, ${B.sand}, ${B.cream})`,
      fontFamily: "'DM Sans', sans-serif",
    }}>
      <link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700;800&family=Playfair+Display:wght@700;800&display=swap" rel="stylesheet" />

      {/* Header */}
      <div style={{
        background: 'rgba(255,255,255,0.92)', backdropFilter: 'blur(12px)',
        borderBottom: `1px solid ${B.lightGray}`, padding: '14px 20px',
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        position: 'sticky', top: 0, zIndex: 100,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{
            width: 36, height: 36, borderRadius: 10,
            background: `linear-gradient(135deg, ${B.teal}, ${B.aqua})`,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            color: '#fff', fontSize: 18, fontWeight: 800,
          }}>W</div>
          <div>
            <div style={{ fontSize: 15, fontWeight: 800, color: B.navy }}>Waves Pest Control</div>
            <div style={{ fontSize: 10, color: B.teal, fontWeight: 600, letterSpacing: 0.5, textTransform: 'uppercase' }}>Customer Portal</div>
          </div>
        </div>
        <div onClick={logout} style={{
          width: 36, height: 36, borderRadius: '50%',
          background: `linear-gradient(135deg, ${B.teal}, ${B.blue})`,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          color: '#fff', fontSize: 14, fontWeight: 700, cursor: 'pointer',
        }} title="Sign out">{initials}</div>
      </div>

      {/* Tabs */}
      <div style={{ padding: '14px 16px 0' }}>
        <TabBar tabs={TABS} active={activeTab} onSelect={setActiveTab} />
      </div>

      {/* Content */}
      <div style={{ padding: '16px 16px 100px', maxWidth: 700, margin: '0 auto' }}>
        {activeTab === 'dashboard' && <DashboardTab customer={customer} />}
        {activeTab === 'services' && <ServicesTab />}
        {activeTab === 'schedule' && <ScheduleTab customer={customer} />}
        {activeTab === 'billing' && <BillingTab />}
      </div>

      {/* Bottom CTA */}
      <div style={{
        position: 'fixed', bottom: 0, left: 0, right: 0,
        background: 'rgba(255,255,255,0.95)', backdropFilter: 'blur(12px)',
        borderTop: `1px solid ${B.lightGray}`, padding: '12px 20px',
        display: 'flex', gap: 10, justifyContent: 'center', zIndex: 100,
      }}>
        <a href="tel:+19415550100" style={{
          flex: 1, maxWidth: 200, padding: 12, borderRadius: 12, border: 'none',
          background: `linear-gradient(135deg, ${B.teal}, ${B.aqua})`,
          color: '#fff', fontSize: 14, fontWeight: 700, textAlign: 'center',
          textDecoration: 'none', boxShadow: `0 4px 15px ${B.teal}40`,
        }}>📞 Call Us</a>
        <a href="sms:+19415550100" style={{
          flex: 1, maxWidth: 200, padding: 12, borderRadius: 12, border: 'none',
          background: B.navy, color: '#fff', fontSize: 14, fontWeight: 700,
          textAlign: 'center', textDecoration: 'none', boxShadow: `0 4px 15px ${B.navy}30`,
        }}>💬 Text Us</a>
      </div>
    </div>
  );
}
