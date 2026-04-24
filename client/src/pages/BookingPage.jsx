import { COLORS, FONTS } from '../theme-brand';
import { useState, useEffect, useCallback } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import BrandFooter from "../components/BrandFooter";
import { Button } from "../components/Button";
import Icon from "../components/Icon";

const API_BASE = import.meta.env.VITE_API_URL || "/api";

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
        background: `${COLORS.wavesBlue}33`,
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
    <div style={{ minHeight: "100vh", background: COLORS.sand, fontFamily: FONTS.body }}>
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
        background: COLORS.blueDeeper,
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
          background: COLORS.wavesBlue, display: "flex",
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
            fontFamily: FONTS.display,
            fontWeight: 400, fontSize: 22,
            letterSpacing: "0.02em", lineHeight: 1,
            margin: 0,
          }}>
            Waves Pest Control
          </h1>
          <div style={{ color: COLORS.slate400, fontSize: 12, marginTop: 4 }}>
            Book your service
          </div>
        </div>
      </div>

      {/* ── Progress bar ── */}
      {step < 4 && (
        <div style={{ background: COLORS.slate200, height: 3 }}>
          <div style={{
            height: 3,
            background: COLORS.wavesBlue,
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
                fontSize: 22, fontWeight: 600, color: COLORS.blueDeeper,
                letterSpacing: "-0.5px", marginBottom: 8,
              }}>
                Confirm your area
              </h2>
              <p style={{ fontSize: 16, color: COLORS.slate600, lineHeight: 1.5 }}>
                We'll show you appointment times when we're already working near you — no wasted drive time, fastest service.
              </p>
            </div>

            {/* Estimate summary card */}
            <div style={{
              background: COLORS.white,
              border: `1px solid ${COLORS.slate200}`,
              borderRadius: 14,
              padding: "16px 18px",
              marginBottom: 24,
            }}>
              <div style={{ fontSize: 12, fontWeight: 500, color: COLORS.slate400, textTransform: "uppercase", letterSpacing: "0.8px", marginBottom: 10 }}>
                Estimate #{ESTIMATE.id}
              </div>
              <div style={{ fontSize: 15, fontWeight: 500, color: COLORS.blueDeeper, marginBottom: 4 }}>
                {ESTIMATE.services.join(" + ")}
              </div>
              <div style={{ fontSize: 14, color: COLORS.slate600 }}>
                {ESTIMATE.address}, {ESTIMATE.city}
              </div>
            </div>

            {/* City selector */}
            <div style={{ marginBottom: 28 }}>
              <label style={{ fontSize: 14, fontWeight: 500, color: COLORS.slate600, display: "block", marginBottom: 8 }}>
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
                      border: `1.5px solid ${city === c ? COLORS.wavesBlue : COLORS.grayLight}`,
                      background: city === c ? COLORS.blueLight : "transparent",
                      color: city === c ? COLORS.blueDark : COLORS.slate600,
                      fontSize: 14,
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

            <Button
              variant="primary"
              onClick={() => setStep(1)}
              style={{ width: "100%" }}
            >
              Show available times
            </Button>
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
              fontSize: 22, fontWeight: 600, color: COLORS.blueDeeper,
              letterSpacing: "-0.5px", marginBottom: 6,
            }}>
              Pick a date
            </h2>
            <p style={{ fontSize: 14, color: COLORS.slate400, marginBottom: 20 }}>
              Showing days we're already in <span style={{ color: COLORS.wavesBlue, fontWeight: 600 }}>{city}</span>
            </p>

            {loading ? (
              <div style={{ textAlign: "center", padding: "48px 0" }}>
                <div style={{
                  width: 36, height: 36, borderRadius: "50%",
                  border: `3px solid ${COLORS.slate200}`,
                  borderTopColor: COLORS.wavesBlue,
                  animation: "spin 0.7s linear infinite",
                  margin: "0 auto 12px",
                }} />
                <style>{`@keyframes spin { to { transform: rotate(360deg) } }`}</style>
                <div style={{ fontSize: 14, color: COLORS.slate400 }}>
                  Finding available times near {city}...
                </div>
              </div>
            ) : availability.length === 0 ? (
              <div style={{
                background: COLORS.white,
                border: `1px solid ${COLORS.slate200}`,
                borderRadius: 14, padding: "32px 20px",
                textAlign: "center",
              }}>
                <div style={{ marginBottom: 12, color: COLORS.slate400 }}><Icon name="mail" size={28} strokeWidth={1.5} /></div>
                <div style={{ fontSize: 15, fontWeight: 500, color: COLORS.blueDeeper, marginBottom: 6 }}>
                  No availability this period
                </div>
                <div style={{ fontSize: 16, color: COLORS.slate400, lineHeight: 1.5 }}>
                  We don't have techs routed near {city} in the next 2 weeks. Call us at (941) 297-5749 and we'll get you scheduled.
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
                          border: `1.5px solid ${isSelected ? COLORS.wavesBlue : COLORS.grayLight}`,
                          background: isSelected ? COLORS.blueLight : COLORS.white,
                          cursor: "pointer",
                          textAlign: "center",
                          transition: "all 0.2s",
                        }}
                      >
                        {isFirst && (
                          <div style={{
                            position: "absolute", top: -1, left: "50%", transform: "translateX(-50%)",
                            background: COLORS.wavesBlue, color: "#fff",
                            fontSize: 9, fontWeight: 600,
                            padding: "2px 8px", borderRadius: "0 0 6px 6px",
                            letterSpacing: "0.3px",
                          }}>
                            NEXT
                          </div>
                        )}
                        <div style={{ fontSize: 12, color: COLORS.slate400, fontWeight: 500, marginBottom: 2, marginTop: isFirst ? 8 : 0 }}>
                          {day.dayOfWeek}
                        </div>
                        <div style={{ fontSize: 22, fontWeight: 600, color: isSelected ? COLORS.blueDark : COLORS.blueDeeper }}>
                          {day.dayNum}
                        </div>
                        <div style={{ fontSize: 10, color: COLORS.slate400, marginTop: 2 }}>
                          {day.month}
                        </div>
                        <div style={{
                          marginTop: 6, fontSize: 10, fontWeight: 600,
                          color: COLORS.wavesBlue,
                        }}>
                          {day.slots.length} slot{day.slots.length > 1 ? "s" : ""}
                        </div>
                        {ripple && <Ripple {...ripple} />}
                      </button>
                    );
                  })}
                </div>
                <div style={{ fontSize: 12, color: COLORS.slate400, textAlign: "center" }}>
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
              fontSize: 22, fontWeight: 600, color: COLORS.blueDeeper,
              letterSpacing: "-0.5px", marginBottom: 6,
            }}>
              {selectedDay.fullDate}
            </h2>
            <p style={{ fontSize: 14, color: COLORS.slate400, marginBottom: 24 }}>
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
                      border: `1.5px solid ${isSelected ? COLORS.wavesBlue : COLORS.grayLight}`,
                      background: isSelected ? COLORS.blueLight : COLORS.white,
                      cursor: "pointer",
                      transition: "all 0.15s",
                      textAlign: "left",
                    }}
                  >
                    {/* Clock icon */}
                    <div style={{
                      width: 40, height: 40, borderRadius: 10,
                      background: isSelected ? `${COLORS.wavesBlue}22` : COLORS.offWhite,
                      display: "flex", alignItems: "center", justifyContent: "center",
                      flexShrink: 0,
                      transition: "background 0.2s",
                    }}>
                      <svg width="20" height="20" viewBox="0 0 24 24" fill="none"
                        stroke={isSelected ? COLORS.wavesBlue : COLORS.slate400}
                        strokeWidth="2" strokeLinecap="round">
                        <circle cx="12" cy="12" r="10"/>
                        <path d="M12 6v6l4 2"/>
                      </svg>
                    </div>
                    <div style={{ flex: 1 }}>
                      <div style={{
                        fontSize: 16, fontWeight: 600,
                        color: isSelected ? COLORS.blueDark : COLORS.blueDeeper,
                        marginBottom: 2,
                      }}>
                        {slot.start} – {slot.end}
                      </div>
                      <div style={{ fontSize: 12, color: COLORS.slate400 }}>
                        1 hour · {selectedDay.zone}
                      </div>
                    </div>
                    {/* Check */}
                    {isSelected && (
                      <div style={{
                        width: 24, height: 24, borderRadius: "50%",
                        background: COLORS.wavesBlue,
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
              <Button
                variant="primary"
                onClick={() => setStep(3)}
                style={{ width: "100%", marginTop: 24, animation: "slideUp 0.3s ease-out" }}
              >
                Continue
              </Button>
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
              fontSize: 22, fontWeight: 600, color: COLORS.blueDeeper,
              letterSpacing: "-0.5px", marginBottom: 20,
            }}>
              Confirm your appointment
            </h2>

            {/* Summary card */}
            <div style={{
              background: COLORS.white,
              border: `1px solid ${COLORS.slate200}`,
              borderRadius: 14, overflow: "hidden",
              marginBottom: 20,
            }}>
              {/* Date/time hero */}
              <div style={{
                background: COLORS.blueDeeper, padding: "20px 18px",
                color: "#fff",
              }}>
                <div style={{ fontSize: 12, fontWeight: 500, textTransform: "uppercase", letterSpacing: "0.8px", opacity: 0.6, marginBottom: 6 }}>
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
                      borderBottom: i < 3 ? `1px solid ${COLORS.offWhite}` : "none",
                    }}
                  >
                    <span style={{ fontSize: 14, color: COLORS.slate400 }}>{row.label}</span>
                    <span style={{ fontSize: 14, fontWeight: 500, color: COLORS.blueDeeper, textAlign: "right", maxWidth: "60%" }}>
                      {row.value}
                    </span>
                  </div>
                ))}
              </div>
            </div>

            {/* Notes */}
            <div style={{ marginBottom: 24 }}>
              <label style={{
                fontSize: 14, fontWeight: 500, color: COLORS.slate600,
                display: "block", marginBottom: 6,
              }}>
                Notes for your tech <span style={{ fontWeight: 400, color: COLORS.slate400 }}>(optional)</span>
              </label>
              <textarea
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="Gate code, pet info, specific concerns..."
                rows={3}
                style={{
                  width: "100%", padding: "12px 14px",
                  border: `1.5px solid ${COLORS.grayLight}`,
                  borderRadius: 10, fontSize: 14,
                  color: COLORS.blueDeeper, background: COLORS.white,
                  resize: "vertical", outline: "none",
                  transition: "border-color 0.2s",
                  lineHeight: 1.5,
                }}
                onFocus={(e) => (e.target.style.borderColor = COLORS.wavesBlue)}
                onBlur={(e) => (e.target.style.borderColor = COLORS.grayLight)}
              />
            </div>

            {/* SMS consent */}
            <div style={{
              display: "flex", gap: 10, alignItems: "flex-start",
              marginBottom: 24, padding: "12px 14px",
              background: COLORS.offWhite, borderRadius: 10,
            }}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke={COLORS.slate400}
                strokeWidth="2" strokeLinecap="round" style={{ flexShrink: 0, marginTop: 1 }}>
                <path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/>
              </svg>
              <span style={{ fontSize: 12, color: COLORS.slate400, lineHeight: 1.5 }}>
                We'll text you a confirmation and a reminder the day before. Standard messaging rates apply.
              </span>
            </div>

            <Button
              variant="primary"
              onClick={handleConfirm}
              disabled={loading}
              style={{ width: "100%", fontSize: 16, cursor: loading ? "wait" : "pointer" }}
            >
              {loading ? (
                <span style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 8 }}>
                  <span style={{
                    width: 18, height: 18, borderRadius: "50%",
                    border: "2.5px solid rgba(27,44,91,0.3)",
                    borderTopColor: COLORS.blueDeeper,
                    animation: "spin 0.7s linear infinite",
                    display: "inline-block",
                  }} />
                  Booking...
                </span>
              ) : (
                "Confirm appointment"
              )}
            </Button>
          </div>
        )}

        {/* ════ STEP 4: Confirmation ════ */}
        {step === 4 && (
          <div style={{ animation: "fadeIn 0.5s ease-out", textAlign: "center", paddingTop: 32 }}>
            {/* Success check */}
            <div style={{
              width: 72, height: 72, borderRadius: "50%",
              background: COLORS.greenLight,
              display: "flex", alignItems: "center", justifyContent: "center",
              margin: "0 auto 20px",
              animation: "checkPop 0.6s ease-out",
            }}>
              <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke={COLORS.green} strokeWidth="2.5" strokeLinecap="round">
                <path d="M5 12l5 5L19 7"/>
              </svg>
            </div>

            <h2 style={{
              fontSize: 24, fontWeight: 600, color: COLORS.blueDeeper,
              letterSpacing: "-0.5px", marginBottom: 8,
            }}>
              You're all set
            </h2>
            <p style={{ fontSize: 16, color: COLORS.slate600, marginBottom: 28, lineHeight: 1.5 }}>
              Your appointment is confirmed. We've texted you the details.
            </p>

            {/* Confirmation code card */}
            <div style={{
              background: COLORS.white,
              border: `1.5px solid ${COLORS.slate200}`,
              borderRadius: 14, padding: "24px 20px",
              marginBottom: 24,
            }}>
              <div style={{ fontSize: 12, fontWeight: 500, color: COLORS.slate400, textTransform: "uppercase", letterSpacing: "0.8px", marginBottom: 8 }}>
                Confirmation code
              </div>
              <div style={{
                fontSize: 32, fontWeight: 600, color: COLORS.wavesBlue,
                letterSpacing: "3px", marginBottom: 20,
                fontFamily: FONTS.mono,
              }}>
                {confCode}
              </div>

              <div style={{
                borderTop: `1px solid ${COLORS.slate200}`,
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
                    <span style={{ fontSize: 14, color: COLORS.slate400, flexShrink: 0 }}>{row.label}</span>
                    <span style={{ fontSize: 14, fontWeight: 500, color: COLORS.blueDeeper, textAlign: "right" }}>
                      {row.value}
                    </span>
                  </div>
                ))}
              </div>
            </div>

            {/* Reminder info */}
            <div style={{
              background: COLORS.blueLight,
              borderRadius: 10,
              padding: "14px 16px",
              display: "flex", alignItems: "flex-start",
              gap: 10, textAlign: "left",
            }}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke={COLORS.wavesBlue}
                strokeWidth="2" strokeLinecap="round" style={{ flexShrink: 0, marginTop: 1 }}>
                <path d="M18 8A6 6 0 006 8c0 7-3 9-3 9h18s-3-2-3-9"/>
                <path d="M13.73 21a2 2 0 01-3.46 0"/>
              </svg>
              <span style={{ fontSize: 16, color: COLORS.blueDark, lineHeight: 1.5 }}>
                We'll send you a reminder the day before. Reply <strong>RESCHEDULE</strong> to that text if anything changes.
              </span>
            </div>
          </div>
        )}

        <BrandFooter />
      </div>
    </div>
  );
}
