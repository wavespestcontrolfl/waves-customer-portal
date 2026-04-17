import { useState, useEffect, useCallback } from "react";
import { useParams, useSearchParams } from "react-router-dom";

const API_BASE = import.meta.env.VITE_API_URL || "/api";

// ── Brand tokens ──
// Mirrored from wavespestcontrol.com — semantic keys preserved, values swapped to brand
const BRAND = {
  navy: "#04395E",
  teal: "#097ABD",
  tealDark: "#065A8C",
  tealLight: "#E3F5FD",
  sand: "#FEF7E0",
  warmWhite: "#FFFFFF",
  coral: "#C0392B",
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

  return (
    <div style={{ minHeight: "100vh", background: BRAND.sand, fontFamily: "'DM Sans', sans-serif" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=DM+Sans:ital,opsz,wght@0,9..40,300;0,9..40,400;0,9..40,500;0,9..40,600;1,9..40,400&display=swap');
        @keyframes rippleOut { to { transform: scale(4); opacity: 0; } }
        @keyframes slideUp { from { opacity:0; transform:translateY(16px) } to { opacity:1; transform:translateY(0) } }
        @keyframes checkPop { 0% { transform:scale(0) rotate(-45deg) } 60% { transform:scale(1.2) rotate(0deg) } 100% { transform:scale(1) rotate(0deg) } }
        @keyframes fadeIn { from { opacity:0 } to { opacity:1 } }
        @keyframes pulse { 0%,100% { transform:scale(1) } 50% { transform:scale(1.04) } }
        * { box-sizing: border-box; margin: 0; padding: 0; }
        input, select, button, textarea { font-family: inherit; }
      `}</style>

      {/* ── Header ── */}
      <div style={{
        position: 'relative', overflow: 'hidden',
        background: BRAND.navy,
        padding: "20px 24px",
        display: "flex",
        alignItems: "center",
        gap: 12,
      }}>
        {/* Hero video — waves-hero-service.mp4 */}
        <video autoPlay muted loop playsInline preload="none" poster="/brand/waves-hero-service.webp"
          style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover', opacity: 0.3, zIndex: 0, pointerEvents: 'none' }}
          aria-hidden="true">
          <source src="/brand/waves-hero-service.mp4" type="video/mp4" />
        </video>
        <div style={{
          position: 'relative', zIndex: 1,
          width: 36, height: 36, borderRadius: "50%",
          background: BRAND.teal, display: "flex",
          alignItems: "center", justifyContent: "center",
        }}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2.5" strokeLinecap="round">
            <path d="M3 12c3-6 6-9 9-9s6 3 9 9c-3 6-6 9-9 9s-6-3-9-9z"/>
            <path d="M8 12c1.5-3 3-4.5 4.5-4.5S15 9 16.5 12c-1.5 3-3 4.5-4.5 4.5S9.5 15 8 12z"/>
          </svg>
        </div>
        <div style={{ position: 'relative', zIndex: 1 }}>
          <h1 style={{
            color: "#fff",
            fontFamily: "'Luckiest Guy', 'Baloo 2', cursive",
            fontWeight: 400, fontSize: 22,
            letterSpacing: "0.02em", lineHeight: 1,
            margin: 0,
          }}>
            Waves Pest Control
          </h1>
          <div style={{ color: BRAND.gray400, fontSize: 12, marginTop: 4 }}>
            Book your service
          </div>
        </div>
      </div>

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
      <div style={{ maxWidth: 480, margin: "0 auto", padding: "24px 20px 40px" }}>

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
              onClick={() => setStep(1)}
              style={{
                width: "100%", padding: "14px 0",
                background: "#FFD700", color: BRAND.navy,
                border: "none", borderRadius: 9999,
                fontSize: 15, fontWeight: 800,
                letterSpacing: "0.02em",
                cursor: "pointer",
                transition: "background 0.15s cubic-bezier(0.4,0,0.2,1)",
                fontFamily: "'Baloo 2', 'Nunito', sans-serif",
              }}
              onMouseEnter={(e) => (e.target.style.background = "#FFF176")}
              onMouseLeave={(e) => (e.target.style.background = "#FFD700")}
            >
              Show available times
            </button>
          </div>
        )}

        {/* ════ STEP 1: Pick a Date ════ */}
        {step === 1 && (
          <div style={{ animation: "slideUp 0.4s ease-out" }}>
            <button
              onClick={() => { setStep(0); setSelectedDate(null); setSelectedSlot(null); }}
              style={{
                background: "none", border: "none", color: BRAND.gray400,
                fontSize: 13, cursor: "pointer", marginBottom: 16,
                display: "flex", alignItems: "center", gap: 4,
              }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M15 18l-6-6 6-6"/></svg>
              Back
            </button>

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
            <button
              onClick={() => { setStep(1); setSelectedSlot(null); }}
              style={{
                background: "none", border: "none", color: BRAND.gray400,
                fontSize: 13, cursor: "pointer", marginBottom: 16,
                display: "flex", alignItems: "center", gap: 4,
              }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M15 18l-6-6 6-6"/></svg>
              Back to dates
            </button>

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
                onClick={() => setStep(3)}
                style={{
                  width: "100%", marginTop: 24, padding: "14px 0",
                  background: "#FFD700", color: BRAND.navy,
                  border: "none", borderRadius: 9999,
                  fontSize: 15, fontWeight: 800,
                  letterSpacing: "0.02em",
                  cursor: "pointer",
                  animation: "slideUp 0.3s ease-out",
                  transition: "background 0.15s cubic-bezier(0.4,0,0.2,1)",
                  fontFamily: "'Baloo 2', 'Nunito', sans-serif",
                }}
                onMouseEnter={(e) => (e.target.style.background = "#FFF176")}
                onMouseLeave={(e) => (e.target.style.background = "#FFD700")}
              >
                Continue
              </button>
            )}
          </div>
        )}

        {/* ════ STEP 3: Confirm ════ */}
        {step === 3 && selectedDay && selectedSlot && (
          <div style={{ animation: "slideUp 0.4s ease-out" }}>
            <button
              onClick={() => setStep(2)}
              style={{
                background: "none", border: "none", color: BRAND.gray400,
                fontSize: 13, cursor: "pointer", marginBottom: 16,
                display: "flex", alignItems: "center", gap: 4,
              }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M15 18l-6-6 6-6"/></svg>
              Back
            </button>

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
              onClick={handleConfirm}
              disabled={loading}
              style={{
                width: "100%", padding: "15px 0",
                background: loading ? BRAND.gray300 : "#FFD700",
                color: loading ? "#fff" : BRAND.navy,
                border: "none", borderRadius: 9999,
                fontSize: 16, fontWeight: 800,
                letterSpacing: "0.02em",
                cursor: loading ? "wait" : "pointer",
                transition: "all 0.15s cubic-bezier(0.4,0,0.2,1)",
                position: "relative",
                fontFamily: "'Baloo 2', 'Nunito', sans-serif",
              }}
            >
              {loading ? (
                <span style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 8 }}>
                  <span style={{
                    width: 18, height: 18, borderRadius: "50%",
                    border: "2.5px solid rgba(255,255,255,0.3)",
                    borderTopColor: "#fff",
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
      </div>
    </div>
  );
}
