import { useState, useEffect, useCallback, useRef } from "react";
import { ArrowLeft, Leaf } from "lucide-react";
import AdminCommandHeader from "../../components/admin/AdminCommandHeader";

const API_BASE = import.meta.env.VITE_API_URL || "/api";
// V2 token pass: teal/purple fold to zinc-900. Semantic green/amber/red preserved.
const D = {
  bg: "#F4F4F5",
  card: "#FFFFFF",
  border: "#E4E4E7",
  teal: "#18181B",
  green: "#15803D",
  amber: "#A16207",
  red: "#991B1B",
  purple: "#18181B",
  text: "#27272A",
  muted: "#71717A",
  white: "#FFFFFF",
  input: "#FFFFFF",
  heading: "#09090B",
  inputBorder: "#D4D4D8",
};
const MONO = "'JetBrains Mono', monospace";

function adminFetch(path, options = {}) {
  return fetch(`${API_BASE}${path}`, {
    headers: {
      Authorization: `Bearer ${localStorage.getItem("waves_admin_token")}`,
      "Content-Type": "application/json",
    },
    ...options,
  }).then((r) => {
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  });
}

const scoreColor = (v) => (v >= 75 ? D.green : v >= 50 ? D.amber : D.red);
const isMobile = typeof window !== "undefined" && window.innerWidth < 768;

function formatPerformanceRate(value) {
  const n = Number(value);
  return Number.isFinite(n) ? `${Math.round(n * 100)}%` : "—";
}

function RecommendationPerformanceSummary({ performance }) {
  if (!performance) return null;
  const counts = performance.counts || {};
  const shown = counts.recommendation_shown || counts.shown || 0;
  const clicked = counts.recommendation_clicked || counts.clicked || 0;
  const followUp = counts.follow_up_requested || 0;
  const latest = performance.latestEventAt
    ? new Date(performance.latestEventAt).toLocaleDateString()
    : null;
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(4, minmax(0, 1fr))",
        gap: 6,
        marginTop: 8,
      }}
    >
      {[
        ["Shown", shown],
        ["Clicked", clicked],
        ["CTR", formatPerformanceRate(performance.clickThroughRate)],
        ["Follow-up", followUp],
      ].map(([label, value]) => (
        <div
          key={label}
          style={{
            border: `1px solid ${D.border}`,
            borderRadius: 8,
            padding: "7px 8px",
            background: "#FAFAFA",
          }}
        >
          <div style={{ fontSize: 10, color: D.muted, fontWeight: 800, textTransform: "uppercase" }}>
            {label}
          </div>
          <div style={{ fontSize: 14, color: D.heading, fontWeight: 850, marginTop: 2 }}>
            {value}
          </div>
        </div>
      ))}
      {latest && (
        <div style={{ gridColumn: "1 / -1", fontSize: 11, color: D.muted }}>
          Latest customer event: {latest}
        </div>
      )}
    </div>
  );
}

// Resize phone photos before base64 upload — caps the long edge so a 4-8MB camera shot
// becomes ~200-400KB. Opus 4.7 vision works on the smaller image without loss for turf
// assessment, and the upload doesn't choke on slow LTE.
function resizeImage(dataUrl, maxEdge = 1600, quality = 0.85) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const longEdge = Math.max(img.width, img.height);
      if (longEdge <= maxEdge) {
        resolve(dataUrl);
        return;
      }
      const scale = maxEdge / longEdge;
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      const ctx = canvas.getContext("2d");
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      resolve(canvas.toDataURL("image/jpeg", quality));
    };
    img.onerror = () => resolve(dataUrl); // fall through with original on decode error
    img.src = dataUrl;
  });
}

// Allowed values mirror server/routes/admin-customer-turf-profile.js.
// Keep them in sync — the API rejects anything outside the closed set.
// sun_exposure uses 'heavy_shade' (not 'shade') so the value name
// signals severity to the future plan engine.
const TURF_PROFILE_OPTIONS = {
  grass_type: [
    "st_augustine",
    "bermuda",
    "zoysia",
    "bahia",
    "mixed",
    "unknown",
  ],
  sun_exposure: ["full_sun", "partial_shade", "heavy_shade"],
  irrigation_type: ["in_ground", "manual", "none", "mixed"],
};

const EMPTY_TURF_PROFILE = {
  grass_type: "",
  track_key: "",
  cultivar: "",
  sun_exposure: "",
  lawn_sqft: "",
  irrigation_type: "",
  irrigation_inches_per_week: "",
  municipality: "",
  county: "",
  soil_test_date: "",
  soil_ph: "",
  known_chinch_history: false,
  known_disease_history: false,
  known_drought_stress: false,
  annual_n_budget_target: "",
  active: true,
};

function SnapshotReviewPanel({
  review,
  loading,
  onSnapshotAction,
  onRecommendationAction,
}) {
  const snapshot = review?.snapshot;
  const cards = review?.recommendationCards || [];
  const [summary, setSummary] = useState("");
  const [cardCopy, setCardCopy] = useState({});

  useEffect(() => {
    setSummary(snapshot?.summary_customer || "");
    setCardCopy(
      Object.fromEntries(cards.map((card) => [card.id, card.customer_copy || ""])),
    );
  }, [snapshot?.id, cards.length]);

  if (loading && !snapshot) {
    return (
      <div style={{ ...cardStyle, marginTop: 14 }}>
        <div style={{ fontSize: 13, color: D.muted }}>Loading snapshot review...</div>
      </div>
    );
  }

  if (!snapshot) {
    return (
      <div style={{ ...cardStyle, marginTop: 14 }}>
        <div style={{ fontSize: 14, fontWeight: 700, color: D.heading }}>
          Customer Snapshot
        </div>
        <div style={{ fontSize: 12, color: D.muted, marginTop: 6 }}>
          No snapshot has been generated for this assessment yet.
        </div>
      </div>
    );
  }

  return (
    <div style={{ ...cardStyle, marginTop: 14 }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 10, alignItems: "center" }}>
        <div>
          <div style={{ fontSize: 15, fontWeight: 800, color: D.heading }}>
            Customer Snapshot
          </div>
          <div style={{ fontSize: 11, color: D.muted, marginTop: 2 }}>
            {snapshot.status} · {snapshot.customer_visible ? "Customer visible" : "Internal only"}
          </div>
        </div>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", justifyContent: "flex-end" }}>
          <button
            type="button"
            onClick={() => onSnapshotAction(snapshot.id, { approve: true })}
            style={{ ...btnOutline, padding: "7px 9px", color: D.green }}
          >
            Approve
          </button>
          <button
            type="button"
            onClick={() => onSnapshotAction(snapshot.id, { customer_visible: true })}
            style={{ ...btnOutline, padding: "7px 9px", color: D.teal }}
          >
            Show
          </button>
          <button
            type="button"
            onClick={() => onSnapshotAction(snapshot.id, { hide: true })}
            style={{ ...btnOutline, padding: "7px 9px", color: D.red }}
          >
            Hide
          </button>
        </div>
      </div>

      <div style={{ marginTop: 12 }}>
        <div style={{ fontSize: 11, color: D.muted, fontWeight: 700, marginBottom: 4 }}>
          Customer summary
        </div>
        <textarea
          value={summary}
          onChange={(event) => setSummary(event.target.value)}
          rows={4}
          style={{ ...inputStyle, resize: "vertical", lineHeight: 1.5 }}
        />
        <button
          type="button"
          onClick={() => onSnapshotAction(snapshot.id, { summary_customer: summary })}
          style={{ ...btnOutline, marginTop: 8, padding: "7px 10px" }}
        >
          Save summary
        </button>
      </div>

      {!!snapshot.findings?.length && (
        <div style={{ marginTop: 12, display: "grid", gap: 6 }}>
          {snapshot.findings.slice(0, 3).map((finding) => (
            <div
              key={finding.key}
              style={{
                padding: 8,
                borderRadius: 8,
                border: `1px solid ${D.border}`,
                background: D.input,
                fontSize: 12,
                color: D.text,
              }}
            >
              <strong>{finding.label}</strong> · Severity {finding.severity}
              <div style={{ color: D.muted, marginTop: 3 }}>{finding.customer_copy}</div>
            </div>
          ))}
        </div>
      )}

      <div style={{ marginTop: 16, fontSize: 13, fontWeight: 800, color: D.heading }}>
        Recommendation Cards
      </div>
      {cards.length === 0 ? (
        <div style={{ fontSize: 12, color: D.muted, marginTop: 6 }}>
          No recommendation cards generated.
        </div>
      ) : (
        <div style={{ marginTop: 8, display: "grid", gap: 10 }}>
          {cards.map((card) => (
            <div key={card.id} style={{ border: `1px solid ${D.border}`, borderRadius: 8, padding: 10 }}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                <div>
                  <div style={{ fontSize: 13, fontWeight: 800, color: D.heading }}>{card.title}</div>
                  <div style={{ fontSize: 11, color: D.muted, marginTop: 2 }}>
                    {card.type} · {card.priority} · {card.status} · {card.customer_visible ? "Customer visible" : "Internal only"}
                  </div>
                </div>
                <div style={{ display: "flex", gap: 5, flexWrap: "wrap", justifyContent: "flex-end" }}>
                  <button
                    type="button"
                    onClick={() => onRecommendationAction(card.id, { approve: true })}
                    style={{ ...btnOutline, padding: "6px 8px", color: D.green }}
                  >
                    Approve
                  </button>
                  <button
                    type="button"
                    onClick={() => onRecommendationAction(card.id, { customer_visible: true })}
                    style={{ ...btnOutline, padding: "6px 8px", color: D.teal }}
                  >
                    Show
                  </button>
                  <button
                    type="button"
                    onClick={() => onRecommendationAction(card.id, { dismiss: true })}
                    style={{ ...btnOutline, padding: "6px 8px", color: D.red }}
                  >
                    Dismiss
                  </button>
                </div>
              </div>
              <textarea
                value={cardCopy[card.id] || ""}
                onChange={(event) => setCardCopy((prev) => ({ ...prev, [card.id]: event.target.value }))}
                rows={3}
                style={{ ...inputStyle, marginTop: 8, resize: "vertical", lineHeight: 1.5 }}
              />
              <RecommendationPerformanceSummary performance={card.performance} />
              <button
                type="button"
                onClick={() => onRecommendationAction(card.id, { customer_copy: cardCopy[card.id] || "" })}
                style={{ ...btnOutline, marginTop: 7, padding: "6px 9px" }}
              >
                Save copy
              </button>
              {card.internal_reason && (
                <div style={{ fontSize: 11, color: D.muted, marginTop: 7 }}>
                  Internal: {card.internal_reason}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default function LawnAssessmentPanel() {
  // 'profile' step lets the tech edit a customer's turf profile from
  // the lawn-care surface — feeds the WaveGuard plan engine later.
  const [step, setStep] = useState("select"); // select, capture, analyzing, review, history, profile
  const [customers, setCustomers] = useState([]);
  const [selectedCustomer, setSelectedCustomer] = useState(null);
  const [search, setSearch] = useState("");
  const [photos, setPhotos] = useState([]); // { data, preview, file }
  const [analyzing, setAnalyzing] = useState(false);
  const [result, setResult] = useState(null);
  const [turfProfile, setTurfProfile] = useState(EMPTY_TURF_PROFILE);
  const [profileLoading, setProfileLoading] = useState(false);
  const [profileSaving, setProfileSaving] = useState(false);
  // Tech-confirmed scores. Initialized from the server-adjusted /assess
  // scores; the tech can nudge any tile up/down before confirm.
  // recordTechCalibration on the server uses the AI vs tech delta to
  // train its weighting, so this state is the input that makes the
  // calibration pipeline actually meaningful.
  const [techScores, setTechScores] = useState(null);
  const [protocolChecks, setProtocolChecks] = useState({
    irrigation_inches_per_week: "",
    protocol_field_notes: "",
  });
  const [confirming, setConfirming] = useState(false);
  const [assessmentConfirmed, setAssessmentConfirmed] = useState(false);
  const [snapshotReview, setSnapshotReview] = useState(null);
  const [snapshotLoading, setSnapshotLoading] = useState(false);
  const [history, setHistory] = useState([]);
  const [showGuide, setShowGuide] = useState(
    () => !localStorage.getItem("lawn_guide_seen"),
  );
  const fileRef = useRef(null);

  // Load customers
  useEffect(() => {
    adminFetch("/admin/lawn-assessment/customers")
      .then((d) => setCustomers(d.customers || []))
      .catch(() => {});
  }, []);

  // Server-side search when local results are empty
  useEffect(() => {
    if (!search.trim() || search.trim().length < 2) return;
    const t = setTimeout(() => {
      adminFetch(
        `/admin/lawn-assessment/customers?q=${encodeURIComponent(search.trim())}`,
      )
        .then((d) => {
          const serverResults = d.customers || [];
          setCustomers((prev) => {
            const ids = new Set(prev.map((c) => c.id));
            return [...prev, ...serverResults.filter((c) => !ids.has(c.id))];
          });
        })
        .catch(() => {});
    }, 300);
    return () => clearTimeout(t);
  }, [search]);

  const filteredCustomers = customers.filter((c) => {
    if (!search.trim()) return true;
    const q = search.toLowerCase();
    return (
      `${c.firstName} ${c.lastName}`.toLowerCase().includes(q) ||
      (c.phone || "").includes(q) ||
      (c.address || "").toLowerCase().includes(q)
    );
  });

  const handlePhotoCapture = (e) => {
    const files = Array.from(e.target.files);
    files.forEach(async (file) => {
      if (photos.length >= 3) return;
      const reader = new FileReader();
      reader.onload = async (ev) => {
        const resized = await resizeImage(ev.target.result, 1600, 0.85);
        setPhotos((prev) => [
          ...prev.slice(0, 2),
          { data: resized, preview: resized, file },
        ]);
      };
      reader.readAsDataURL(file);
    });
    e.target.value = "";
  };

  const removePhoto = (idx) =>
    setPhotos((prev) => prev.filter((_, i) => i !== idx));

  const handleAnalyze = async () => {
    if (!selectedCustomer || photos.length === 0) return;
    setAnalyzing(true);
    setStep("analyzing");
    try {
      const photoData = photos.map((p) => ({
        data: p.data.split(",")[1], // base64 without prefix
        mimeType: p.data.match(/data:([^;]+)/)?.[1] || "image/jpeg",
      }));
      const r = await adminFetch("/admin/lawn-assessment/assess", {
        method: "POST",
        body: JSON.stringify({
          customerId: selectedCustomer.id,
          // serviceId is present when the picker showed today's scheduled
          // services; absent on the customer-only fallback path.
          serviceId: selectedCustomer.serviceId || undefined,
          photos: photoData,
        }),
      });
      setResult(r);
      // Pre-fill grass type from the AI read when the turf profile has none yet,
      // so the tech sees + can confirm/override. The server already COALESCE-
      // persisted it; this just surfaces it in the profile form.
      if (r.detectedGrassType) {
        setTurfProfile((prev) => (prev.grass_type ? prev : { ...prev, grass_type: r.detectedGrassType }));
      }
      setSnapshotReview(null);
      setAssessmentConfirmed(false);
      // Seed from the server's season-adjusted scores so the review
      // tiles match what will be persisted if the tech makes no changes.
      const initialScores = r.adjustedScores || r.displayScores;
      setTechScores(initialScores ? { ...initialScores } : null);
      setProtocolChecks({
        irrigation_inches_per_week: "",
        protocol_field_notes: "",
      });
      setStep("review");
    } catch (e) {
      alert("Analysis failed: " + e.message);
      setStep("capture");
    }
    setAnalyzing(false);
  };

  const handleConfirm = async () => {
    if (!result?.assessment?.id) return;
    setConfirming(true);
    try {
      // Send the tech-confirmed scores. Falls back to the server-adjusted
      // scores when the tech didn't change anything.
      const adjustedScores = techScores || result.adjustedScores || result.displayScores;
      const protocol_field_checks = Object.fromEntries(
        Object.entries(protocolChecks).filter(([, value]) => value !== "" && value !== null),
      );
      const response = await adminFetch("/admin/lawn-assessment/confirm", {
        method: "POST",
        body: JSON.stringify({
          assessmentId: result.assessment.id,
          adjustedScores,
          protocol_field_checks,
        }),
      });
      setResult((prev) => ({
        ...prev,
        assessment: response.assessment || prev.assessment,
      }));
      setAssessmentConfirmed(true);
      await loadSnapshotReview(response?.assessment?.id || result.assessment.id);
      alert("Assessment confirmed. Snapshot is ready for admin review.");
    } catch (e) {
      alert("Confirm failed: " + e.message);
    }
    setConfirming(false);
  };

  const finishAssessment = () => {
    setStep("select");
    setPhotos([]);
    setResult(null);
    setTechScores(null);
    setProtocolChecks({
      irrigation_inches_per_week: "",
      protocol_field_notes: "",
    });
    setSnapshotReview(null);
    setAssessmentConfirmed(false);
    setSelectedCustomer(null);
  };

  const loadSnapshotReview = async (assessmentId) => {
    if (!assessmentId) return null;
    setSnapshotLoading(true);
    try {
      const review = await adminFetch(
        `/admin/lawn-assessment/${assessmentId}/snapshot`,
      );
      setSnapshotReview(review);
      return review;
    } catch {
      setSnapshotReview(null);
      return null;
    } finally {
      setSnapshotLoading(false);
    }
  };

  const patchSnapshot = async (snapshotId, body) => {
    if (!snapshotId || !result?.assessment?.id) return;
    setSnapshotLoading(true);
    try {
      await adminFetch(`/admin/lawn-assessment/snapshots/${snapshotId}`, {
        method: "PATCH",
        body: JSON.stringify(body),
      });
      await loadSnapshotReview(result.assessment.id);
    } catch (e) {
      alert("Snapshot update failed: " + e.message);
      setSnapshotLoading(false);
    }
  };

  const patchRecommendation = async (recommendationId, body) => {
    if (!recommendationId || !result?.assessment?.id) return;
    setSnapshotLoading(true);
    try {
      await adminFetch(
        `/admin/lawn-assessment/recommendations/${recommendationId}`,
        {
          method: "PATCH",
          body: JSON.stringify(body),
        },
      );
      await loadSnapshotReview(result.assessment.id);
    } catch (e) {
      alert("Recommendation update failed: " + e.message);
      setSnapshotLoading(false);
    }
  };

  // Clamp + step the tech-edited score. Range matches the AI display
  // scale (0–100, integers). Step 5 keeps the UX coarse enough that
  // a tech can't generate noise by tapping +/- repeatedly.
  const adjustTechScore = (key, delta) => {
    setTechScores((prev) => {
      if (!prev) return prev;
      const current = Number.isFinite(prev[key]) ? prev[key] : 0;
      const next = Math.min(100, Math.max(0, Math.round(current + delta)));
      return { ...prev, [key]: next };
    });
  };

  const loadHistory = async (customerId) => {
    try {
      const d = await adminFetch(
        `/admin/lawn-assessment/history/${customerId}`,
      );
      setHistory(d.history || d.assessments || []);
      setStep("history");
    } catch {
      setHistory([]);
    }
  };

  const loadTurfProfile = async (customerId) => {
    setProfileLoading(true);
    try {
      const d = await adminFetch(`/admin/customers/${customerId}/turf-profile`);
      // Server returns { profile: row | null }. Coerce nulls to ''
      // so the form's controlled inputs don't drop to uncontrolled.
      const p = d.profile;
      setTurfProfile(
        p
          ? {
              ...EMPTY_TURF_PROFILE,
              ...Object.fromEntries(
                Object.entries(p).map(([k, v]) => [
                  k,
                  v == null ? (EMPTY_TURF_PROFILE[k] ?? "") : v,
                ]),
              ),
            }
          : EMPTY_TURF_PROFILE,
      );
      setStep("profile");
    } catch (e) {
      alert("Failed to load turf profile: " + e.message);
    } finally {
      setProfileLoading(false);
    }
  };

  const saveTurfProfile = async () => {
    if (!selectedCustomer) return;
    // Strip empty strings so the API receives null/undefined instead of
    // empty strings that fail numeric/date parsing on the server.
    const payload = Object.fromEntries(
      Object.entries(turfProfile).filter(([, v]) => v !== "" && v !== null),
    );
    setProfileSaving(true);
    try {
      const d = await adminFetch(
        `/admin/customers/${selectedCustomer.id}/turf-profile`,
        {
          method: "PUT",
          body: JSON.stringify(payload),
        },
      );
      alert("Turf profile saved");
      // Reflect the saved row back into form state so the user sees
      // any server-applied normalisation immediately.
      const p = d.profile;
      setTurfProfile({
        ...EMPTY_TURF_PROFILE,
        ...Object.fromEntries(
          Object.entries(p).map(([k, v]) => [
            k,
            v == null ? (EMPTY_TURF_PROFILE[k] ?? "") : v,
          ]),
        ),
      });
    } catch (e) {
      alert("Save failed: " + e.message);
    } finally {
      setProfileSaving(false);
    }
  };

  const updateProfileField = (key, value) =>
    setTurfProfile((prev) => ({ ...prev, [key]: value }));

  // First-use guide
  if (showGuide) {
    return (
      <div>
        {" "}
        <AdminCommandHeader title="Lawn Assessment" icon={Leaf} />{" "}
        <div
          style={{
            ...cardStyle,
            maxWidth: 420,
            margin: "0 auto",
            textAlign: "center",
            padding: 30,
          }}
        >
          {" "}
          <div style={{ fontSize: 40, marginBottom: 12 }}></div>{" "}
          <div
            style={{
              fontSize: 18,
              fontWeight: 700,
              color: D.heading,
              marginBottom: 8,
            }}
          >
            Lawn Assessment Guide
          </div>{" "}
          <div
            style={{
              fontSize: 13,
              color: D.muted,
              lineHeight: 1.7,
              marginBottom: 20,
            }}
          >
            {" "}
            <p style={{ marginBottom: 8 }}>
              Stand upright, point camera at the turf at roughly 45°, capture a
              6–8 ft area of lawn.
            </p>{" "}
            <p style={{ marginBottom: 8 }}>Avoid shadows and feet in frame.</p>{" "}
            <p>
              Take 1-3 photos per visit: front yard, side yard, trouble spots.
            </p>{" "}
          </div>{" "}
          <button
            onClick={() => {
              setShowGuide(false);
              localStorage.setItem("lawn_guide_seen", "1");
            }}
            style={btnStyle(D.teal)}
          >
            Got It — Let's Go
          </button>{" "}
        </div>{" "}
      </div>
    );
  }

  return (
    <div>
      {" "}
      <AdminCommandHeader
        title="Lawn Assessment"
        icon={Leaf}
        action={
          step !== "select"
            ? {
                label: "Back",
                icon: ArrowLeft,
                variant: "secondary",
                onClick: () => {
                  setStep("select");
                  setPhotos([]);
                  setResult(null);
                  setSnapshotReview(null);
                  setAssessmentConfirmed(false);
                },
              }
            : null
        }
      />
      {/* STEP 1: Select Customer */}
      {step === "select" && (
        <div>
          {" "}
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search today's lawn customers..."
            style={inputStyle}
          />{" "}
          <div style={{ marginTop: 12, display: "grid", gap: 8 }}>
            {filteredCustomers.slice(0, 20).map((c) => (
              // key uses serviceId when present so a customer with two
              // scheduled visits on the same day renders as two distinct
              // rows. Falls back to customer id on the no-services path.
              <div
                key={c.serviceId || c.id}
                style={{
                  ...cardStyle,
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  padding: "12px 16px",
                  cursor: "pointer",
                }}
                onClick={() => {
                  setSelectedCustomer(c);
                  setStep("capture");
                }}
              >
                {" "}
                <div>
                  {" "}
                  <div
                    style={{ fontSize: 14, fontWeight: 600, color: D.heading }}
                  >
                    {c.windowStart && (
                      <span style={{ color: D.teal, marginRight: 8 }}>
                        {c.windowStart}
                      </span>
                    )}
                    {c.firstName} {c.lastName}
                  </div>{" "}
                  <div style={{ fontSize: 11, color: D.muted }}>
                    {c.address} · {c.phone}
                  </div>
                  {c.serviceType && (
                    <div style={{ fontSize: 10, color: D.green, marginTop: 2 }}>
                      {c.serviceType}
                    </div>
                  )}
                </div>{" "}
                <div style={{ display: "flex", gap: 6 }}>
                  {c.lastAssessment && (
                    <span style={{ fontSize: 10, color: D.muted }}>
                      Last: {new Date(c.lastAssessment).toLocaleDateString()}
                    </span>
                  )}
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      setSelectedCustomer(c);
                      loadTurfProfile(c.id);
                    }}
                    style={{ ...btnOutline, padding: "4px 8px", fontSize: 10 }}
                  >
                    Profile
                  </button>{" "}
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      loadHistory(c.id);
                      setSelectedCustomer(c);
                    }}
                    style={{ ...btnOutline, padding: "4px 8px", fontSize: 10 }}
                  >
                    History
                  </button>{" "}
                </div>{" "}
              </div>
            ))}
            {filteredCustomers.length === 0 && (
              <div style={{ color: D.muted, textAlign: "center", padding: 30 }}>
                No lawn services scheduled today (or all assessed)
              </div>
            )}
          </div>{" "}
        </div>
      )}
      {/* STEP 2: Capture Photos */}
      {step === "capture" && selectedCustomer && (
        <div style={{ maxWidth: 480, margin: "0 auto" }}>
          {" "}
          <div style={{ ...cardStyle, textAlign: "center", marginBottom: 16 }}>
            {" "}
            <div style={{ fontSize: 14, fontWeight: 600, color: D.teal }}>
              {selectedCustomer.firstName} {selectedCustomer.lastName}
            </div>{" "}
            <div style={{ fontSize: 12, color: D.muted }}>
              {selectedCustomer.address}
            </div>{" "}
          </div>
          {/* Photo grid */}
          <div
            style={{
              display: "grid",
              gridTemplateColumns: isMobile
                ? "repeat(2, 1fr)"
                : "repeat(3, 1fr)",
              gap: 10,
              marginBottom: 16,
            }}
          >
            {photos.map((p, i) => (
              <div
                key={i}
                style={{
                  position: "relative",
                  aspectRatio: "4/3",
                  borderRadius: 10,
                  overflow: "hidden",
                  border: `1px solid ${D.border}`,
                }}
              >
                {" "}
                <img
                  src={p.preview}
                  alt=""
                  style={{ width: "100%", height: "100%", objectFit: "cover" }}
                />{" "}
                <button
                  onClick={() => removePhoto(i)}
                  style={{
                    position: "absolute",
                    top: 4,
                    right: 4,
                    background: D.red,
                    color: "#fff",
                    border: "none",
                    borderRadius: "50%",
                    width: 24,
                    height: 24,
                    fontSize: 12,
                    cursor: "pointer",
                  }}
                >
                  ×
                </button>{" "}
              </div>
            ))}
            {photos.length < 3 && (
              <div
                onClick={() => fileRef.current?.click()}
                style={{
                  aspectRatio: "4/3",
                  borderRadius: 10,
                  border: `2px dashed ${D.border}`,
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "center",
                  justifyContent: "center",
                  cursor: "pointer",
                  color: D.muted,
                }}
              >
                {" "}
                <span style={{ fontSize: 28 }}>+</span>{" "}
                <span style={{ fontSize: 11, marginTop: 4 }}>
                  Add Photo
                </span>{" "}
              </div>
            )}
          </div>{" "}
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            capture="environment"
            multiple
            onChange={handlePhotoCapture}
            style={{ display: "none" }}
          />{" "}
          <button
            onClick={handleAnalyze}
            disabled={photos.length === 0}
            style={{
              ...btnStyle(D.green),
              width: "100%",
              padding: 14,
              fontSize: 15,
              opacity: photos.length === 0 ? 0.5 : 1,
            }}
          >
            Analyze {photos.length} Photo{photos.length !== 1 ? "s" : ""} with
            AI
          </button>{" "}
        </div>
      )}
      {/* STEP 3: Analyzing */}
      {step === "analyzing" && (
        <div style={{ textAlign: "center", padding: 60 }}>
          {" "}
          <div style={{ fontSize: 32, marginBottom: 16 }}></div>{" "}
          <div
            style={{
              fontSize: 16,
              fontWeight: 600,
              color: D.heading,
              marginBottom: 8,
            }}
          >
            Analyzing with Claude + Gemini...
          </div>{" "}
          <div style={{ fontSize: 12, color: D.muted }}>
            Running dual-model vision analysis for accuracy
          </div>{" "}
          <div
            style={{
              marginTop: 20,
              display: "flex",
              gap: 8,
              justifyContent: "center",
            }}
          >
            {["Claude Sonnet", "Gemini Flash"].map((m) => (
              <div
                key={m}
                style={{
                  padding: "8px 16px",
                  background: D.input,
                  borderRadius: 8,
                  fontSize: 12,
                  color: D.teal,
                }}
              >
                {m}
              </div>
            ))}
          </div>{" "}
        </div>
      )}
      {/* STEP 4: Review Scores */}
      {step === "review" && result && (
        <div style={{ maxWidth: 520, margin: "0 auto" }}>
          {" "}
          <div style={{ ...cardStyle, marginBottom: 16 }}>
            {" "}
            <div
              style={{
                fontSize: 15,
                fontWeight: 600,
                color: D.heading,
                marginBottom: 12,
              }}
            >
              AI Scorecard — {selectedCustomer?.firstName}{" "}
              {selectedCustomer?.lastName}
            </div>
            {/* Divergence summary — shown when Claude and Gemini disagreed on at least one metric.
                Multi-photo assessments emit one flag per photo, so dedupe by metric to match the
                number of highlighted tiles below. */}
            {(() => {
              const uniqueMetrics = new Set(
                (result.divergenceFlags || []).map((f) => f.metric),
              );
              if (uniqueMetrics.size === 0) return null;
              return (
                <div
                  style={{
                    marginBottom: 12,
                    padding: 10,
                    background: `${D.amber}15`,
                    border: `1px solid ${D.amber}`,
                    borderRadius: 8,
                  }}
                >
                  {" "}
                  <div
                    style={{
                      fontSize: 12,
                      fontWeight: 700,
                      color: D.amber,
                      marginBottom: 4,
                    }}
                  >
                    AI models disagreed on {uniqueMetrics.size} metric
                    {uniqueMetrics.size === 1 ? "" : "s"}
                  </div>{" "}
                  <div
                    style={{ fontSize: 11, color: D.muted, lineHeight: 1.5 }}
                  >
                    Tiles below marked{" "}
                    <span style={{ color: D.amber, fontWeight: 600 }}>
                      DIVERGENCE
                    </span>
                    are where Claude and Gemini gave scores that differed by
                    more than 20 points. Verify by eye before confirming.
                  </div>{" "}
                </div>
              );
            })()}
            {/* Scores — AI value on top, tech-confirmed value below with
                +/- nudge buttons. Tech edits feed adjustedScores on
                /confirm, which is what recordTechCalibration measures
                AI-vs-tech delta against. Step 5 to keep the input
                coarse and the calibration signal stable. */}
            <div
              style={{
                display: "grid",
                gridTemplateColumns: isMobile ? "1fr 1fr" : "repeat(3, 1fr)",
                gap: 10,
              }}
            >
              {[
                { key: "turf_density", label: "Turf Density" },
                { key: "weed_suppression", label: "Weed Suppression" },
                { key: "color_health", label: "Color Health" },
                { key: "fungus_control", label: "Fungus Control" },
                { key: "thatch_level", label: "Thatch Level" },
              ].map((m) => {
                const aiVal = result.adjustedScores?.[m.key] ?? result.displayScores?.[m.key] ?? 0;
                const techVal = techScores?.[m.key] ?? aiVal;
                const flag = (result.divergenceFlags || []).find(
                  (f) => f.metric === m.key,
                );
                const overridden = techVal !== aiVal;
                return (
                  <div
                    key={m.key}
                    style={{
                      padding: 14,
                      background: D.input,
                      borderRadius: 10,
                      textAlign: "center",
                      border: flag
                        ? `2px solid ${D.amber}`
                        : `1px solid ${D.border}`,
                    }}
                  >
                    {" "}
                    <div
                      style={{
                        fontSize: 9,
                        color: D.muted,
                        fontWeight: 600,
                        letterSpacing: 0.5,
                      }}
                    >
                      AI
                    </div>{" "}
                    <div
                      style={{
                        fontFamily: MONO,
                        fontSize: 22,
                        fontWeight: 700,
                        color: scoreColor(aiVal),
                      }}
                    >
                      {aiVal}%
                    </div>{" "}
                    <div
                      style={{
                        fontSize: 12,
                        fontWeight: 600,
                        color: D.heading,
                        marginTop: 2,
                      }}
                    >
                      {m.label}
                    </div>
                    {flag && (
                      <>
                        {" "}
                        <div
                          style={{ fontSize: 10, color: D.muted, marginTop: 4 }}
                        >
                          Claude: {flag.claude}% · Gemini: {flag.gemini}%
                        </div>{" "}
                        <div
                          style={{
                            fontSize: 9,
                            color: D.amber,
                            fontWeight: 700,
                            marginTop: 2,
                          }}
                        >
                          DIVERGENCE — verify
                        </div>{" "}
                      </>
                    )}
                    <div
                      style={{
                        marginTop: 10,
                        paddingTop: 8,
                        borderTop: `1px solid ${D.border}`,
                      }}
                    >
                      {" "}
                      <div
                        style={{
                          fontSize: 9,
                          color: overridden ? D.teal : D.muted,
                          fontWeight: 600,
                          letterSpacing: 0.5,
                        }}
                      >
                        TECH {overridden ? "· EDITED" : ""}
                      </div>{" "}
                      <div
                        style={{
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                          gap: 6,
                          marginTop: 4,
                        }}
                      >
                        {" "}
                        <button
                          type="button"
                          onClick={() => adjustTechScore(m.key, -5)}
                          aria-label={`Decrease ${m.label}`}
                          style={{
                            width: 28,
                            height: 28,
                            borderRadius: 6,
                            border: `1px solid ${D.border}`,
                            background: D.white,
                            fontSize: 16,
                            fontWeight: 700,
                            cursor: "pointer",
                            color: D.heading,
                          }}
                        >
                          −
                        </button>{" "}
                        <div
                          style={{
                            fontFamily: MONO,
                            fontSize: 20,
                            fontWeight: 700,
                            minWidth: 56,
                            color: scoreColor(techVal),
                          }}
                        >
                          {techVal}%
                        </div>{" "}
                        <button
                          type="button"
                          onClick={() => adjustTechScore(m.key, 5)}
                          aria-label={`Increase ${m.label}`}
                          style={{
                            width: 28,
                            height: 28,
                            borderRadius: 6,
                            border: `1px solid ${D.border}`,
                            background: D.white,
                            fontSize: 16,
                            fontWeight: 700,
                            cursor: "pointer",
                            color: D.heading,
                          }}
                        >
                          +
                        </button>{" "}
                      </div>{" "}
                    </div>{" "}
                  </div>
                );
              })}
            </div>
            <div
              style={{
                marginTop: 12,
                padding: 12,
                background: D.input,
                borderRadius: 8,
                border: `1px solid ${D.border}`,
              }}
            >
              <div
                style={{
                  fontSize: 11,
                  fontWeight: 700,
                  color: D.heading,
                  marginBottom: 8,
                }}
              >
                Irrigation check
              </div>
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "1fr",
                  gap: 10,
                }}
              >
                <div>
                  <div style={{ fontSize: 11, color: D.muted, marginBottom: 4 }}>
                    Inches per week
                  </div>
                  <input
                    type="number"
                    min="0"
                    max="5"
                    step="0.25"
                    value={protocolChecks.irrigation_inches_per_week ?? ""}
                    onChange={(e) =>
                      setProtocolChecks((prev) => ({
                        ...prev,
                        irrigation_inches_per_week: e.target.value,
                      }))
                    }
                    placeholder="1.00"
                    style={{ ...inputStyle, marginBottom: 0 }}
                  />
                </div>
              </div>
              <div style={{ marginTop: 10 }}>
                <div style={{ fontSize: 11, color: D.muted, marginBottom: 4 }}>
                  Irrigation notes
                </div>
                <textarea
                  value={protocolChecks.protocol_field_notes || ""}
                  onChange={(e) =>
                    setProtocolChecks((prev) => ({
                      ...prev,
                      protocol_field_notes: e.target.value,
                    }))
                  }
                  placeholder="Dry spots, overwatering, runoff, broken heads, or customer controller notes"
                  rows={2}
                  style={{ ...inputStyle, marginBottom: 0, resize: "vertical" }}
                />
              </div>
            </div>
            {/* Observations */}
            {result.observations && (
              <div
                style={{
                  marginTop: 12,
                  padding: 12,
                  background: D.input,
                  borderRadius: 8,
                  fontSize: 12,
                  color: D.muted,
                  lineHeight: 1.6,
                }}
              >
                {" "}
                <div
                  style={{
                    fontSize: 11,
                    fontWeight: 600,
                    color: D.heading,
                    marginBottom: 4,
                  }}
                >
                  AI Observations
                </div>
                {result.observations}
              </div>
            )}
            {/* Season badge */}
            <div style={{ marginTop: 12, fontSize: 11, color: D.muted }}>
              Season:{" "}
              <span style={{ color: D.teal, fontWeight: 600 }}>
                {result.season}
              </span>
              {result.isBaseline && (
                <span
                  style={{ color: D.amber, marginLeft: 8, fontWeight: 600 }}
                >
                  This is the baseline assessment
                </span>
              )}
            </div>{" "}
          </div>{" "}
          <div style={{ display: "flex", gap: 8 }}>
            {" "}
            {assessmentConfirmed ? (
              <button
                onClick={finishAssessment}
                style={{ ...btnStyle(D.teal), flex: 1, padding: 14, fontSize: 15 }}
              >
                Done
              </button>
            ) : (
              <button
                onClick={handleConfirm}
                disabled={confirming}
                style={{
                  ...btnStyle(D.green),
                  flex: 1,
                  padding: 14,
                  fontSize: 15,
                  opacity: confirming ? 0.5 : 1,
                }}
              >
                {confirming ? "Confirming..." : "Confirm Scores"}
              </button>
            )}{" "}
            <button
              onClick={() => setStep("capture")}
              disabled={assessmentConfirmed}
              style={{ ...btnOutline, padding: "14px 20px" }}
            >
              Retake
            </button>{" "}
          </div>{" "}
          {(snapshotLoading || snapshotReview?.snapshot) && (
            <SnapshotReviewPanel
              review={snapshotReview}
              loading={snapshotLoading}
              onSnapshotAction={patchSnapshot}
              onRecommendationAction={patchRecommendation}
            />
          )}
        </div>
      )}
      {/* HISTORY VIEW */}
      {step === "history" && (
        <div>
          {" "}
          <div
            style={{
              fontSize: 15,
              fontWeight: 600,
              color: D.heading,
              marginBottom: 12,
            }}
          >
            {selectedCustomer?.firstName} {selectedCustomer?.lastName} —
            Assessment History
          </div>
          {history.length === 0 ? (
            <div
              style={{
                ...cardStyle,
                textAlign: "center",
                padding: 40,
                color: D.muted,
              }}
            >
              No assessments yet
            </div>
          ) : (
            history.map((a, i) => (
              <div key={a.id || i} style={{ ...cardStyle, marginBottom: 8 }}>
                {" "}
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    marginBottom: 8,
                  }}
                >
                  {" "}
                  <div
                    style={{ display: "flex", gap: 8, alignItems: "center" }}
                  >
                    {" "}
                    <span
                      style={{
                        fontSize: 13,
                        fontWeight: 600,
                        color: D.heading,
                      }}
                    >
                      {new Date(a.service_date).toLocaleDateString()}
                    </span>{" "}
                    <span
                      style={{
                        fontSize: 10,
                        padding: "2px 8px",
                        borderRadius: 4,
                        background: `${D.teal}22`,
                        color: D.teal,
                      }}
                    >
                      {a.season}
                    </span>
                    {a.is_baseline && (
                      <span
                        style={{
                          fontSize: 10,
                          padding: "2px 8px",
                          borderRadius: 4,
                          background: `${D.amber}22`,
                          color: D.amber,
                        }}
                      >
                        Baseline
                      </span>
                    )}
                  </div>{" "}
                </div>{" "}
                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: "repeat(5, 1fr)",
                    gap: isMobile ? 4 : 12,
                    fontSize: 12,
                  }}
                >
                  {[
                    ["Turf", a.turf_density],
                    ["Weed", a.weed_suppression],
                    ["Color", a.color_health],
                    ["Fungus", a.fungus_control],
                    ["Thatch", a.thatch_level],
                  ].map(([label, val]) => (
                    <div
                      key={label}
                      style={{ textAlign: "center", minWidth: 0 }}
                    >
                      {" "}
                      <div
                        style={{
                          fontFamily: MONO,
                          fontSize: isMobile ? 13 : 16,
                          fontWeight: 700,
                          color: scoreColor(val || 0),
                        }}
                      >
                        {val || 0}%
                      </div>{" "}
                      <div
                        style={{ fontSize: isMobile ? 9 : 10, color: D.muted }}
                      >
                        {label}
                      </div>{" "}
                    </div>
                  ))}
                </div>
                {a.observations && (
                  <div
                    style={{
                      fontSize: 11,
                      color: D.muted,
                      marginTop: 8,
                      lineHeight: 1.5,
                    }}
                  >
                    {a.observations}
                  </div>
                )}
              </div>
            ))
          )}
        </div>
      )}
      {/* TURF PROFILE VIEW — minimal form for the WaveGuard plan engine inputs */}
      {step === "profile" && (
        <div style={{ maxWidth: 520, margin: "0 auto" }}>
          {" "}
          <div
            style={{
              fontSize: 15,
              fontWeight: 600,
              color: D.heading,
              marginBottom: 12,
            }}
          >
            {selectedCustomer?.firstName} {selectedCustomer?.lastName} — Turf
            Profile
          </div>
          {profileLoading ? (
            <div
              style={{
                ...cardStyle,
                textAlign: "center",
                padding: 40,
                color: D.muted,
              }}
            >
              Loading…
            </div>
          ) : (
            <div style={{ ...cardStyle, padding: 16 }}>
              {/* Selects */}
              {[
                ["grass_type", "Grass type", TURF_PROFILE_OPTIONS.grass_type],
                [
                  "sun_exposure",
                  "Sun exposure",
                  TURF_PROFILE_OPTIONS.sun_exposure,
                ],
                [
                  "irrigation_type",
                  "Irrigation",
                  TURF_PROFILE_OPTIONS.irrigation_type,
                ],
              ].map(([key, label, opts]) => (
                <div key={key} style={{ marginBottom: 12 }}>
                  {" "}
                  <div
                    style={{ fontSize: 11, color: D.muted, marginBottom: 4 }}
                  >
                    {label}
                  </div>{" "}
                  <select
                    value={turfProfile[key] || ""}
                    onChange={(e) => updateProfileField(key, e.target.value)}
                    style={{ ...inputStyle, marginBottom: 0 }}
                  >
                    {" "}
                    <option value="">—</option>
                    {opts.map((o) => (
                      <option key={o} value={o}>
                        {o.replace(/_/g, " ")}
                      </option>
                    ))}
                  </select>{" "}
                </div>
              ))}
              {/* Text/numeric inputs */}
              {[
                ["track_key", "Track key (e.g. st_augustine)", "text"],
                ["cultivar", "Cultivar (e.g. Floratam, Palmetto)", "text"],
                ["lawn_sqft", "Lawn area (sqft)", "number"],
                ["irrigation_inches_per_week", "Irrigation inches / week", "number"],
                ["municipality", "Municipality (e.g. North Port)", "text"],
                ["county", "County (e.g. Sarasota)", "text"],
                ["soil_test_date", "Last soil test date", "date"],
                ["soil_ph", "Soil pH (0–14)", "number"],
                [
                  "annual_n_budget_target",
                  "Annual N budget (lb / 1,000 sqft)",
                  "number",
                ],
              ].map(([key, label, type]) => (
                <div key={key} style={{ marginBottom: 12 }}>
                  {" "}
                  <div
                    style={{ fontSize: 11, color: D.muted, marginBottom: 4 }}
                  >
                    {label}
                  </div>{" "}
                  <input
                    type={type}
                    step={
                      type === "number" &&
                      (key === "soil_ph" || key === "annual_n_budget_target")
                        ? "0.1"
                        : key === "irrigation_inches_per_week"
                          ? "0.25"
                        : undefined
                    }
                    value={turfProfile[key] ?? ""}
                    onChange={(e) => updateProfileField(key, e.target.value)}
                    style={{ ...inputStyle, marginBottom: 0 }}
                  />{" "}
                </div>
              ))}
              {/* Boolean history flags */}
              <div style={{ marginTop: 8, marginBottom: 12 }}>
                {" "}
                <div style={{ fontSize: 11, color: D.muted, marginBottom: 6 }}>
                  Known pressure history
                </div>
                {[
                  ["known_chinch_history", "Chinch bug history"],
                  ["known_disease_history", "Disease history"],
                  ["known_drought_stress", "Drought stress history"],
                ].map(([key, label]) => (
                  <label
                    key={key}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
                      fontSize: 13,
                      color: D.heading,
                      padding: "4px 0",
                      cursor: "pointer",
                    }}
                  >
                    {" "}
                    <input
                      type="checkbox"
                      checked={!!turfProfile[key]}
                      onChange={(e) =>
                        updateProfileField(key, e.target.checked)
                      }
                    />
                    {label}
                  </label>
                ))}
              </div>{" "}
              <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
                {" "}
                <button
                  onClick={saveTurfProfile}
                  disabled={profileSaving}
                  style={{
                    ...btnStyle(D.green),
                    flex: 1,
                    padding: 12,
                    fontSize: 14,
                    opacity: profileSaving ? 0.5 : 1,
                  }}
                >
                  {profileSaving ? "Saving…" : "Save Turf Profile"}
                </button>{" "}
              </div>{" "}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

const cardStyle = {
  background: D.card,
  border: `1px solid ${D.border}`,
  borderRadius: 12,
  padding: 20,
  marginBottom: 12,
};
const btnStyle = (bg) => ({
  padding: "8px 16px",
  background: bg,
  color: D.white,
  border: "none",
  borderRadius: 8,
  fontSize: 13,
  fontWeight: 600,
  cursor: "pointer",
});
const btnOutline = {
  padding: "8px 16px",
  background: "transparent",
  border: `1px solid ${D.border}`,
  borderRadius: 8,
  color: D.muted,
  fontSize: 13,
  cursor: "pointer",
};
const inputStyle = {
  width: "100%",
  padding: "10px 12px",
  background: D.input,
  border: `1px solid ${D.border}`,
  borderRadius: 8,
  color: D.text,
  fontSize: 13,
  outline: "none",
  boxSizing: "border-box",
};
