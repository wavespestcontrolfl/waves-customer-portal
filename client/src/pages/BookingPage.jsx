import { useState, useEffect, useCallback } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import BrandFooter from "../components/BrandFooter";
import { Button } from "../components/Button";
import { GOLD_CTA } from "../theme-brand";

const API_BASE = import.meta.env.VITE_API_URL || "/api";

const WAVES_PHONE_DISPLAY = '(941) 318-7612';
const WAVES_PHONE_TEL = '+19413187612';

// ── Brand tokens ──
// Mirrored from wavespestcontrol.com (van-wrap spec). Page background is slate-50
// instead of warm sand so the surface reads as the marketing brand.
const BRAND = {
  navy: "#1B2C5B",      // brand-blueDeeper (PMS 2766)
  teal: "#009CDE",      // brand-blue (PMS 2925)
  tealDark: "#065A8C",  // brand-blueDark
  tealLight: "#E3F5FD", // brand-blueLight
  sand: "#F8FAFC",      // slate-50 — soft background
  warmWhite: "#FFFFFF",
  coral: "#C8102E",     // brand-red (PMS 186)
  green: "#16A34A",
  greenLight: "#DCFCE7",
  gray100: "#F1F5F9",
  gray200: "#E2E8F0",
  gray300: "#CBD5E1",
  gray400: "#94A3B8",
  gray600: "#475569",
  gray800: "#1E293B",
};

// Real API calls
async function fetchAvailability(city, estimateId) {
  const res = await fetch(`${API_BASE}/booking/availability?city=${encodeURIComponent(city)}${estimateId ? `&estimate_id=${estimateId}` : ''}`);
  const data = await res.json();
  return data.days || [];
}

async function fetchEstimate(token) {
  const res = await fetch(`${API_BASE}/estimates/${token}`);
  if (!res.ok) return null;
  return res.json();
}

async function confirmBooking(estimateId, customerId, date, startTime, notes) {
  const res = await fetch(`${API_BASE}/booking/confirm`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ estimate_id: estimateId, customer_id: customerId, slot_date: date, slot_start: startTime, customer_notes: notes }),
  });
  return res.json();
}

// ── Ripple animation on tap ──
function Ripple({ x, y }) {
  return (
    <span
      style={{
        position: "absolute",
        left: x - 20,
        top: y - 20,
        width: 40,
        height: 40,
        borderRadius: "50%",
        background: `${BRAND.teal}33`,
        animation: "rippleOut 0.5s ease-out forwards",
        pointerEvents: "none",
      }}
    />
  );
}

export default function BookingPage() {
  const { estimateToken } = useParams();
  const [searchParams] = useSearchParams();
  const [step, setStep] = useState(0);
  const [navOpen, setNavOpen] = useState(false);
  const [city, setCity] = useState(searchParams.get('city') || 'Bradenton');
  const [estimate, setEstimate] = useState(null);
  const [availability, setAvailability] = useState([]);
  const [selectedDate, setSelectedDate] = useState(null);
  const [selectedSlot, setSelectedSlot] = useState(null);
  const [notes, setNotes] = useState("");
  const [confCode, setConfCode] = useState("");
  const [loading, setLoading] = useState(false);
  const [ripple, setRipple] = useState(null);

  const cities = [
    "Bradenton", "Parrish", "Palmetto", "Sarasota",
    "Lakewood Ranch", "Venice", "North Port", "Port Charlotte",
  ];

  // Load estimate data
  useEffect(() => {
    if (estimateToken) {
      fetchEstimate(estimateToken).then(data => {
        if (data) {
          setEstimate(data);
          if (data.city || data.serviceCity) setCity(data.city || data.serviceCity);
        }
      });
    }
  }, [estimateToken]);

  const loadAvailability = useCallback(async (c) => {
    setLoading(true);
    try {
      const days = await fetchAvailability(c, estimate?.id);
      setAvailability(days);
    } catch { setAvailability([]); }
    setLoading(false);
  }, [estimate]);

  useEffect(() => {
    if (step === 1) loadAvailability(city);
  }, [step, city, loadAvailability]);

  const handleConfirm = async () => {
    setLoading(true);
    try {
      const result = await confirmBooking(
        estimate?.id, estimate?.customer_id,
        selectedDate, selectedSlot?.startTime24 || selectedSlot?.start,
        notes
      );
      setConfCode(result.confirmationCode || result.booking?.confirmation_code || 'WPC-????');
      setStep(4);
    } catch { setConfCode('WPC-ERR'); setStep(4); }
    setLoading(false);
  };

  // Use estimate data or defaults
  const ESTIMATE = estimate || {
    id: null, customer: '', address: searchParams.get('address') || '',
    city: city, services: [searchParams.get('service') || 'Pest Control'],
    total: '', waveguard: '',
  };

  const doRipple = (e) => {
    const rect = e.currentTarget.getBoundingClientRect();
    setRipple({ x: e.clientX - rect.left, y: e.clientY - rect.top });
    setTimeout(() => setRipple(null), 500);
  };

  const selectedDay = availability.find((d) => d.date === selectedDate);

  const primaryCTA = (() => {
    if (step === 0) return { label: 'Show available times', onClick: () => setStep(1), disabled: false };
    if (step === 2 && selectedDay && selectedSlot) return { label: 'Continue', onClick: () => setStep(3), disabled: false };
    if (step === 3) return { label: loading ? 'Booking…' : 'Confirm appointment', onClick: handleConfirm, disabled: loading };
    return null;
  })();

  const showSticky = step < 4;

  const phoneIcon = (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/>
    </svg>
  );

  return (
    <div style={{ minHeight: "100vh", background: BRAND.sand, fontFamily: "'Inter', system-ui, sans-serif", paddingTop: 56, paddingBottom: showSticky ? 88 : 0 }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=DM+Sans:ital,opsz,wght@0,9..40,300;0,9..40,400;0,9..40,500;0,9..40,600;1,9..40,400&display=swap');
        @keyframes rippleOut { to { transform: scale(4); opacity: 0; } }
        @keyframes slideUp { from { opacity:0; transform:translateY(16px) } to { opacity:1; transform:translateY(0) } }
        @keyframes checkPop { 0% { transform:scale(0) rotate(-45deg) } 60% { transform:scale(1.2) rotate(0deg) } 100% { transform:scale(1) rotate(0deg) } }
        @keyframes fadeIn { from { opacity:0 } to { opacity:1 } }
        @keyframes pulse { 0%,100% { transform:scale(1) } 50% { transform:scale(1.04) } }
        * { box-sizing: border-box; margin: 0; padding: 0; }
        input, select, button, textarea { font-family: inherit; }

        .bp-nav { position: fixed; top: 0; left: 0; right: 0; height: 56px; z-index: 60;
          background: #fff; border-bottom: 1px solid ${BRAND.gray200};
          display: flex; align-items: center; justify-content: space-between;
          padding: 0 16px; }
        .bp-nav__brand { display: flex; align-items: center; gap: 8px; text-decoration: none;
          color: ${BRAND.navy}; font-weight: 700; font-size: 17px; letter-spacing: -0.2px; }
        .bp-nav__brand img { width: 32px; height: 32px; border-radius: 8px; }
        .bp-hamb { width: 44px; height: 44px; display: flex; align-items: center;
          justify-content: center; border: 0; background: transparent; cursor: pointer;
          color: ${BRAND.navy}; border-radius: 8px; }
        .bp-hamb:active { background: ${BRAND.gray100}; }
        .bp-menu { position: fixed; top: 56px; left: 0; right: 0; z-index: 55;
          background: #fff; border-bottom: 1px solid ${BRAND.gray200};
          padding: 8px 0 12px; transform: translateY(-100%); transition: transform .2s ease;
          box-shadow: 0 6px 20px rgba(15,23,35,.08); }
        .bp-menu.is-open { transform: translateY(0); }
        .bp-menu a { display: flex; align-items: center; gap: 10px; padding: 14px 20px;
          color: ${BRAND.navy}; text-decoration: none; font-size: 15px; font-weight: 500;
          border-bottom: 1px solid ${BRAND.gray100}; min-height: 48px; }
        .bp-menu a:last-child { border-bottom: 0; }

        .bp-sticky { position: fixed; left: 0; right: 0; bottom: 0; z-index: 50;
          background: #fff; border-top: 1px solid ${BRAND.gray200};
          display: flex; gap: 10px; padding: 12px 16px calc(12px + env(safe-area-inset-bottom)); }
        .bp-sb-cta { flex: 1 1 50%; min-height: 48px; border-radius: 12px;
          font-weight: 700; font-size: 15px; display: inline-flex;
          align-items: center; justify-content: center; gap: 8px;
          text-decoration: none; cursor: pointer; letter-spacing: 0.2px;
          border: 0; transition: opacity .15s, transform .05s; }
        .bp-sb-cta.gold { background: ${BRAND.gold}; color: ${BRAND.navy};
          box-shadow: 0 4px 14px rgba(255,215,0,.4); }
        .bp-sb-cta.gold:active { transform: scale(0.98); }
        .bp-sb-cta.gold:disabled { opacity: 0.55; cursor: not-allowed; box-shadow: none; }
        .bp-sb-cta.white { background: #fff; color: ${BRAND.navy};
          border: 1.5px solid ${BRAND.navy}; }
        .bp-sb-cta.white:active { background: ${BRAND.gray100}; }

        .bp-trust { list-style: none; margin: 16px 0 0; padding: 0;
          display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
        .bp-trust li { display: flex; align-items: flex-start; gap: 8px;
          padding: 10px 12px; background: ${BRAND.warmWhite};
          border: 1px solid ${BRAND.gray200}; border-radius: 10px;
          font-size: 13px; color: ${BRAND.navy}; font-weight: 500; line-height: 1.3; }
        .bp-trust li svg { flex: 0 0 16px; margin-top: 1px; color: ${BRAND.green}; }

        .bp-call-inline { display: inline-flex; align-items: center; justify-content: center;
          gap: 8px; width: 100%; min-height: 48px; padding: 12px 16px;
          margin-top: 12px; border-radius: 12px; background: #fff;
          border: 1.5px solid ${BRAND.navy}; color: ${BRAND.navy};
          text-decoration: none; font-size: 15px; font-weight: 700;
          box-shadow: 0 2px 6px rgba(27,44,91,.08); }
        .bp-call-inline:active { background: ${BRAND.gray100}; }
      `}</style>

      <header className="bp-nav">
        <a className="bp-nav__brand" href="/">
          <img src="/brand/waves-mark.png" alt="" aria-hidden="true" onError={(e) => { e.currentTarget.style.display = 'none'; }} />
          <span>Waves</span>
        </a>
        <button type="button" className="bp-hamb" aria-label="Menu" aria-expanded={navOpen}
          onClick={() => setNavOpen(v => !v)}>
          {navOpen ? (
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
              <path d="M6 6l12 12M18 6L6 18"/>
            </svg>
          ) : (
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
              <path d="M4 7h16M4 12h16M4 17h16"/>
            </svg>
          )}
        </button>
      </header>

      <nav className={`bp-menu${navOpen ? ' is-open' : ''}`} aria-hidden={!navOpen}>
        <a href={`tel:${WAVES_PHONE_TEL}`} onClick={() => setNavOpen(false)}>
          {phoneIcon} Call {WAVES_PHONE_DISPLAY}
        </a>
        <a href="mailto:contact@wavespestcontrol.com" onClick={() => setNavOpen(false)}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
            <path d="M4 4h16v16H4zM4 8l8 5 8-5"/>
          </svg>
          Email us
        </a>
        <a href="/" onClick={() => setNavOpen(false)}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
            <circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/>
          </svg>
          About Waves
        </a>
      </nav>

      {/* ── Progress bar ── */}
      {step < 4 && (
        <div style={{ background: BRAND.gray200, height: 3 }}>
          <div style={{
            height: 3,
            background: BRAND.teal,
            width: `${((step + 1) / 4) * 100}%`,
            transition: "width 0.5s cubic-bezier(.4,0,.2,1)",
            borderRadius: "0 2px 2px 0",
          }} />
        </div>
      )}

      {/* ── Content ── */}
      <div style={{ maxWidth: 480, margin: "0 auto", padding: "40px 24px 60px" }}>

        {/* ════ STEP 0: City Confirmation ════ */}
        {step === 0 && (
          <div style={{ animation: "slideUp 0.4s ease-out" }}>
            <div style={{ marginBottom: 28 }}>
              <h2 style={{
                fontSize: 22, fontWeight: 600, color: BRAND.navy,
                letterSpacing: "-0.5px", marginBottom: 8,
              }}>
                Confirm your area
              </h2>
              <p style={{ fontSize: 14, color: BRAND.gray600, lineHeight: 1.5 }}>
                We'll show you appointment times when we're already working near you — no wasted drive time, fastest service.
              </p>
            </div>

            {/* Estimate summary card */}
            <div style={{
              background: BRAND.warmWhite,
              border: `1px solid ${BRAND.gray200}`,
              borderRadius: 14,
              padding: "16px 18px",
              marginBottom: 24,
            }}>
              <div style={{ fontSize: 11, fontWeight: 500, color: BRAND.gray400, textTransform: "uppercase", letterSpacing: "0.8px", marginBottom: 10 }}>
                Estimate #{ESTIMATE.id}
              </div>
              <div style={{ fontSize: 15, fontWeight: 500, color: BRAND.navy, marginBottom: 4 }}>
                {ESTIMATE.services.join(" + ")}
              </div>
              <div style={{ fontSize: 13, color: BRAND.gray600 }}>
                {ESTIMATE.address}, {ESTIMATE.city}
              </div>
            </div>

            {/* City selector */}
            <div style={{ marginBottom: 28 }}>
              <label style={{ fontSize: 13, fontWeight: 500, color: BRAND.gray600, display: "block", marginBottom: 8 }}>
                Service city
              </label>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                {cities.map((c) => (
                  <button
                    key={c}
                    onClick={() => setCity(c)}
                    style={{
                      padding: "8px 16px",
                      borderRadius: 20,
                      border: `1.5px solid ${city === c ? BRAND.teal : BRAND.gray300}`,
                      background: city === c ? BRAND.tealLight : "transparent",
                      color: city === c ? BRAND.tealDark : BRAND.gray600,
                      fontSize: 13,
                      fontWeight: city === c ? 600 : 400,
                      cursor: "pointer",
                      transition: "all 0.2s",
                    }}
                  >
                    {c}
                  </button>
                ))}
              </div>
            </div>

            <button
              type="button"
              onClick={() => setStep(1)}
              style={{ ...GOLD_CTA, width: "100%" }}
            >
              Show available times
            </button>

            <a className="bp-call-inline" href={`tel:${WAVES_PHONE_TEL}`} aria-label="Call Waves Pest Control">
              {phoneIcon} CALL {WAVES_PHONE_DISPLAY}
            </a>

            <ul className="bp-trust" aria-label="Why customers choose Waves">
              <li><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12l5 5L19 7"/></svg>Family-owned, local</li>
              <li><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12l5 5L19 7"/></svg>No contracts, ever</li>
              <li><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12l5 5L19 7"/></svg>Pet &amp; kid safe</li>
              <li><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12l5 5L19 7"/></svg>100% guarantee</li>
            </ul>
          </div>
        )}

        {/* ════ STEP 1: Pick a Date ════ */}
        {step === 1 && (
          <div style={{ animation: "slideUp 0.4s ease-out" }}>
            <Button
              variant="tertiary"
              onClick={() => { setStep(0); setSelectedDate(null); setSelectedSlot(null); }}
              icon={<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M15 18l-6-6 6-6"/></svg>}
              iconPosition="left"
              style={{ marginBottom: 16 }}
            >
              Back
            </Button>

            <h2 style={{
              fontSize: 22, fontWeight: 600, color: BRAND.navy,
              letterSpacing: "-0.5px", marginBottom: 6,
            }}>
              Pick a date
            </h2>
            <p style={{ fontSize: 13, color: BRAND.gray400, marginBottom: 20 }}>
              Showing days we're already in <span style={{ color: BRAND.teal, fontWeight: 600 }}>{city}</span>
            </p>

            {loading ? (
              <div style={{ textAlign: "center", padding: "48px 0" }}>
                <div style={{
                  width: 36, height: 36, borderRadius: "50%",
                  border: `3px solid ${BRAND.gray200}`,
                  borderTopColor: BRAND.teal,
                  animation: "spin 0.7s linear infinite",
                  margin: "0 auto 12px",
                }} />
                <style>{`@keyframes spin { to { transform: rotate(360deg) } }`}</style>
                <div style={{ fontSize: 13, color: BRAND.gray400 }}>
                  Finding available times near {city}...
                </div>
              </div>
            ) : availability.length === 0 ? (
              <div style={{
                background: BRAND.warmWhite,
                border: `1px solid ${BRAND.gray200}`,
                borderRadius: 14, padding: "32px 20px",
                textAlign: "center",
              }}>
                <div style={{ fontSize: 28, marginBottom: 12 }}>📭</div>
                <div style={{ fontSize: 15, fontWeight: 500, color: BRAND.navy, marginBottom: 6 }}>
                  No availability this period
                </div>
                <div style={{ fontSize: 13, color: BRAND.gray400, lineHeight: 1.5 }}>
                  We don't have techs routed near {city} in the next 2 weeks. Call us at (941) 318-7612 and we'll get you scheduled.
                </div>
              </div>
            ) : (
              <>
                {/* Scrollable date cards */}
                <div style={{
                  display: "flex", gap: 10, overflowX: "auto",
                  paddingBottom: 8, marginBottom: 8,
                  WebkitOverflowScrolling: "touch",
                  scrollbarWidth: "none",
                }}>
                  {availability.map((day, i) => {
                    const isSelected = selectedDate === day.date;
                    const isFirst = i === 0;
                    return (
                      <button
                        key={day.date}
                        onClick={(e) => {
                          doRipple(e);
                          setSelectedDate(day.date);
                          setSelectedSlot(null);
                          setStep(2);
                        }}
                        style={{
                          position: "relative", overflow: "hidden",
                          flexShrink: 0, width: 72,
                          padding: "12px 8px",
                          borderRadius: 12,
                          border: `1.5px solid ${isSelected ? BRAND.teal : BRAND.gray300}`,
                          background: isSelected ? BRAND.tealLight : BRAND.warmWhite,
                          cursor: "pointer",
                          textAlign: "center",
                          transition: "all 0.2s",
                        }}
                      >
                        {isFirst && (
                          <div style={{
                            position: "absolute", top: -1, left: "50%", transform: "translateX(-50%)",
                            background: BRAND.teal, color: "#fff",
                            fontSize: 9, fontWeight: 600,
                            padding: "2px 8px", borderRadius: "0 0 6px 6px",
                            letterSpacing: "0.3px",
                          }}>
                            NEXT
                          </div>
                        )}
                        <div style={{ fontSize: 11, color: BRAND.gray400, fontWeight: 500, marginBottom: 2, marginTop: isFirst ? 8 : 0 }}>
                          {day.dayOfWeek}
                        </div>
                        <div style={{ fontSize: 22, fontWeight: 600, color: isSelected ? BRAND.tealDark : BRAND.navy }}>
                          {day.dayNum}
                        </div>
                        <div style={{ fontSize: 10, color: BRAND.gray400, marginTop: 2 }}>
                          {day.month}
                        </div>
                        <div style={{
                          marginTop: 6, fontSize: 10, fontWeight: 600,
                          color: BRAND.teal,
                        }}>
                          {day.slots.length} slot{day.slots.length > 1 ? "s" : ""}
                        </div>
                        {ripple && <Ripple {...ripple} />}
                      </button>
                    );
                  })}
                </div>
                <div style={{ fontSize: 11, color: BRAND.gray400, textAlign: "center" }}>
                  Scroll for more dates →
                </div>
              </>
            )}
          </div>
        )}

        {/* ════ STEP 2: Pick a Time ════ */}
        {step === 2 && selectedDay && (
          <div style={{ animation: "slideUp 0.4s ease-out" }}>
            <Button
              variant="tertiary"
              onClick={() => { setStep(1); setSelectedSlot(null); }}
              icon={<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M15 18l-6-6 6-6"/></svg>}
              iconPosition="left"
              style={{ marginBottom: 16 }}
            >
              Back to dates
            </Button>

            <h2 style={{
              fontSize: 22, fontWeight: 600, color: BRAND.navy,
              letterSpacing: "-0.5px", marginBottom: 6,
            }}>
              {selectedDay.fullDate}
            </h2>
            <p style={{ fontSize: 13, color: BRAND.gray400, marginBottom: 24 }}>
              {selectedDay.slots.length} opening{selectedDay.slots.length > 1 ? "s" : ""} in {selectedDay.zone}
            </p>

            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {selectedDay.slots.map((slot, i) => {
                const isSelected = selectedSlot?.start === slot.start;
                return (
                  <button
                    key={i}
                    onClick={() => setSelectedSlot(slot)}
                    style={{
                      position: "relative", overflow: "hidden",
                      display: "flex", alignItems: "center",
                      gap: 14, padding: "16px 18px",
                      borderRadius: 12,
                      border: `1.5px solid ${isSelected ? BRAND.teal : BRAND.gray300}`,
                      background: isSelected ? BRAND.tealLight : BRAND.warmWhite,
                      cursor: "pointer",
                      transition: "all 0.15s",
                      textAlign: "left",
                    }}
                  >
                    {/* Clock icon */}
                    <div style={{
                      width: 40, height: 40, borderRadius: 10,
                      background: isSelected ? `${BRAND.teal}22` : BRAND.gray100,
                      display: "flex", alignItems: "center", justifyContent: "center",
                      flexShrink: 0,
                      transition: "background 0.2s",
                    }}>
                      <svg width="20" height="20" viewBox="0 0 24 24" fill="none"
                        stroke={isSelected ? BRAND.teal : BRAND.gray400}
                        strokeWidth="2" strokeLinecap="round">
                        <circle cx="12" cy="12" r="10"/>
                        <path d="M12 6v6l4 2"/>
                      </svg>
                    </div>
                    <div style={{ flex: 1 }}>
                      <div style={{
                        fontSize: 16, fontWeight: 600,
                        color: isSelected ? BRAND.tealDark : BRAND.navy,
                        marginBottom: 2,
                      }}>
                        {slot.start} – {slot.end}
                      </div>
                      <div style={{ fontSize: 12, color: BRAND.gray400 }}>
                        1 hour · {selectedDay.zone}
                      </div>
                    </div>
                    {/* Check */}
                    {isSelected && (
                      <div style={{
                        width: 24, height: 24, borderRadius: "50%",
                        background: BRAND.teal,
                        display: "flex", alignItems: "center", justifyContent: "center",
                        animation: "checkPop 0.3s ease-out",
                      }}>
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="3" strokeLinecap="round"><path d="M5 12l5 5L19 7"/></svg>
                      </div>
                    )}
                  </button>
                );
              })}
            </div>

            {selectedSlot && (
              <button
                type="button"
                onClick={() => setStep(3)}
                style={{ ...GOLD_CTA, width: "100%", marginTop: 24, animation: "slideUp 0.3s ease-out" }}
              >
                Continue
              </button>
            )}
          </div>
        )}

        {/* ════ STEP 3: Confirm ════ */}
        {step === 3 && selectedDay && selectedSlot && (
          <div style={{ animation: "slideUp 0.4s ease-out" }}>
            <Button
              variant="tertiary"
              onClick={() => setStep(2)}
              icon={<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M15 18l-6-6 6-6"/></svg>}
              iconPosition="left"
              style={{ marginBottom: 16 }}
            >
              Back
            </Button>

            <h2 style={{
              fontSize: 22, fontWeight: 600, color: BRAND.navy,
              letterSpacing: "-0.5px", marginBottom: 20,
            }}>
              Confirm your appointment
            </h2>

            {/* Summary card */}
            <div style={{
              background: BRAND.warmWhite,
              border: `1px solid ${BRAND.gray200}`,
              borderRadius: 14, overflow: "hidden",
              marginBottom: 20,
            }}>
              {/* Date/time hero */}
              <div style={{
                background: BRAND.navy, padding: "20px 18px",
                color: "#fff",
              }}>
                <div style={{ fontSize: 11, fontWeight: 500, textTransform: "uppercase", letterSpacing: "0.8px", opacity: 0.6, marginBottom: 6 }}>
                  Your appointment
                </div>
                <div style={{ fontSize: 20, fontWeight: 600, marginBottom: 4 }}>
                  {selectedDay.fullDate}
                </div>
                <div style={{ fontSize: 16, opacity: 0.85 }}>
                  {selectedSlot.start} – {selectedSlot.end}
                </div>
              </div>

              <div style={{ padding: "16px 18px" }}>
                {[
                  { label: "Service", value: ESTIMATE.services.join(", ") },
                  { label: "Address", value: `${ESTIMATE.address}, ${city}` },
                  { label: "Zone", value: selectedDay.zone },
                  { label: "Duration", value: "1 hour" },
                ].map((row, i) => (
                  <div
                    key={i}
                    style={{
                      display: "flex", justifyContent: "space-between",
                      padding: "10px 0",
                      borderBottom: i < 3 ? `1px solid ${BRAND.gray100}` : "none",
                    }}
                  >
                    <span style={{ fontSize: 13, color: BRAND.gray400 }}>{row.label}</span>
                    <span style={{ fontSize: 13, fontWeight: 500, color: BRAND.navy, textAlign: "right", maxWidth: "60%" }}>
                      {row.value}
                    </span>
                  </div>
                ))}
              </div>
            </div>

            {/* Notes */}
            <div style={{ marginBottom: 24 }}>
              <label style={{
                fontSize: 13, fontWeight: 500, color: BRAND.gray600,
                display: "block", marginBottom: 6,
              }}>
                Notes for your tech <span style={{ fontWeight: 400, color: BRAND.gray400 }}>(optional)</span>
              </label>
              <textarea
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="Gate code, pet info, specific concerns..."
                rows={3}
                style={{
                  width: "100%", padding: "12px 14px",
                  border: `1.5px solid ${BRAND.gray300}`,
                  borderRadius: 10, fontSize: 14,
                  color: BRAND.navy, background: BRAND.warmWhite,
                  resize: "vertical", outline: "none",
                  transition: "border-color 0.2s",
                  lineHeight: 1.5,
                }}
                onFocus={(e) => (e.target.style.borderColor = BRAND.teal)}
                onBlur={(e) => (e.target.style.borderColor = BRAND.gray300)}
              />
            </div>

            {/* SMS consent */}
            <div style={{
              display: "flex", gap: 10, alignItems: "flex-start",
              marginBottom: 24, padding: "12px 14px",
              background: BRAND.gray100, borderRadius: 10,
            }}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke={BRAND.gray400}
                strokeWidth="2" strokeLinecap="round" style={{ flexShrink: 0, marginTop: 1 }}>
                <path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/>
              </svg>
              <span style={{ fontSize: 12, color: BRAND.gray400, lineHeight: 1.5 }}>
                We'll text you a confirmation and a reminder the day before. Standard messaging rates apply.
              </span>
            </div>

            <button
              type="button"
              onClick={handleConfirm}
              disabled={loading}
              style={{ ...GOLD_CTA, width: "100%", cursor: loading ? "wait" : "pointer" }}
            >
              {loading ? (
                <span style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 8 }}>
                  <span style={{
                    width: 18, height: 18, borderRadius: "50%",
                    border: "2.5px solid rgba(27,44,91,0.3)",
                    borderTopColor: BRAND.navy,
                    animation: "spin 0.7s linear infinite",
                    display: "inline-block",
                  }} />
                  Booking...
                </span>
              ) : (
                "Confirm appointment"
              )}
            </button>
          </div>
        )}

        {/* ════ STEP 4: Confirmation ════ */}
        {step === 4 && (
          <div style={{ animation: "fadeIn 0.5s ease-out", textAlign: "center", paddingTop: 32 }}>
            {/* Success check */}
            <div style={{
              width: 72, height: 72, borderRadius: "50%",
              background: BRAND.greenLight,
              display: "flex", alignItems: "center", justifyContent: "center",
              margin: "0 auto 20px",
              animation: "checkPop 0.6s ease-out",
            }}>
              <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke={BRAND.green} strokeWidth="2.5" strokeLinecap="round">
                <path d="M5 12l5 5L19 7"/>
              </svg>
            </div>

            <h2 style={{
              fontSize: 24, fontWeight: 600, color: BRAND.navy,
              letterSpacing: "-0.5px", marginBottom: 8,
            }}>
              You're all set
            </h2>
            <p style={{ fontSize: 14, color: BRAND.gray600, marginBottom: 28, lineHeight: 1.5 }}>
              Your appointment is confirmed. We've texted you the details.
            </p>

            {/* Confirmation code card */}
            <div style={{
              background: BRAND.warmWhite,
              border: `1.5px solid ${BRAND.gray200}`,
              borderRadius: 14, padding: "24px 20px",
              marginBottom: 24,
            }}>
              <div style={{ fontSize: 11, fontWeight: 500, color: BRAND.gray400, textTransform: "uppercase", letterSpacing: "0.8px", marginBottom: 8 }}>
                Confirmation code
              </div>
              <div style={{
                fontSize: 32, fontWeight: 600, color: BRAND.teal,
                letterSpacing: "3px", marginBottom: 20,
                fontFamily: "'DM Sans', monospace",
              }}>
                {confCode}
              </div>

              <div style={{
                borderTop: `1px solid ${BRAND.gray200}`,
                paddingTop: 16,
                textAlign: "left",
              }}>
                {[
                  { label: "When", value: `${selectedDay?.fullDate}, ${selectedSlot?.start} – ${selectedSlot?.end}` },
                  { label: "Where", value: `${ESTIMATE.address}, ${city}` },
                  { label: "Service", value: ESTIMATE.services.join(", ") },
                ].map((row, i) => (
                  <div key={i} style={{
                    display: "flex", justifyContent: "space-between",
                    padding: "8px 0", gap: 12,
                  }}>
                    <span style={{ fontSize: 13, color: BRAND.gray400, flexShrink: 0 }}>{row.label}</span>
                    <span style={{ fontSize: 13, fontWeight: 500, color: BRAND.navy, textAlign: "right" }}>
                      {row.value}
                    </span>
                  </div>
                ))}
              </div>
            </div>

            {/* Reminder info */}
            <div style={{
              background: BRAND.tealLight,
              borderRadius: 10,
              padding: "14px 16px",
              display: "flex", alignItems: "flex-start",
              gap: 10, textAlign: "left",
            }}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke={BRAND.teal}
                strokeWidth="2" strokeLinecap="round" style={{ flexShrink: 0, marginTop: 1 }}>
                <path d="M18 8A6 6 0 006 8c0 7-3 9-3 9h18s-3-2-3-9"/>
                <path d="M13.73 21a2 2 0 01-3.46 0"/>
              </svg>
              <span style={{ fontSize: 13, color: BRAND.tealDark, lineHeight: 1.5 }}>
                We'll send you a reminder the day before. Reply <strong>RESCHEDULE</strong> to that text if anything changes.
              </span>
            </div>
          </div>
        )}

        <BrandFooter />
      </div>

      {showSticky && (
        <div className="bp-sticky" role="region" aria-label="Primary actions">
          {primaryCTA ? (
            <button
              type="button"
              className="bp-sb-cta gold"
              onClick={primaryCTA.onClick}
              disabled={primaryCTA.disabled}
            >
              {primaryCTA.label}
            </button>
          ) : null}
          <a className="bp-sb-cta white" href={`tel:${WAVES_PHONE_TEL}`} aria-label="Call Waves Pest Control">
            {phoneIcon} Call
          </a>
        </div>
      )}
    </div>
  );
}
