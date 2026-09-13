import { useState, useEffect, useRef } from "react";
import { ArrowLeft, Leaf } from "lucide-react";
import AdminCommandHeader from "../../components/admin/AdminCommandHeader";
import {
  ActionFeedback,
  Badge,
  Button,
  Card,
  Checkbox,
  Field,
  Input,
  Select,
  Textarea,
  UiSurface,
  cn,
} from "../../components/ui";

const API_BASE = import.meta.env.VITE_API_URL || "/api";

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

// Preserve the accepted score semantics while the surrounding workspace uses
// the shared zinc admin system.
const scoreColor = (v) =>
  v >= 75 ? "#15803D" : v >= 50 ? "#A16207" : "#991B1B";

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

// `embedded` — rendered as the "Field Assessment" tab inside
// AssessmentsHubPage: the hub owns the AdminCommandHeader, so skip ours and
// render the Back action as an inline button instead.
export default function LawnAssessmentPanel({ embedded = false }) {
  // 'profile' step lets the tech edit a customer's turf profile from
  // the lawn-care surface — feeds the WaveGuard plan engine later.
  const [step, setStep] = useState("select"); // select, capture, analyzing, review, history, profile
  const [customers, setCustomers] = useState([]);
  const [selectedCustomer, setSelectedCustomer] = useState(null);
  const [search, setSearch] = useState("");
  const [photos, setPhotos] = useState([]); // { data, preview, file }
  const [, setAnalyzing] = useState(false);
  const [result, setResult] = useState(null);
  const [turfProfile, setTurfProfile] = useState(EMPTY_TURF_PROFILE);
  const [profileLoading, setProfileLoading] = useState(false);
  const [profileSaving, setProfileSaving] = useState(false);
  // The county field was EDITED in this session. The save re-sends every
  // loaded field, so the server needs an explicit signal that the county
  // was reviewed for the current address — after a move, that review is
  // what lets the weekly watering plan trust the profile county again.
  const [countyTouched, setCountyTouched] = useState(false);
  const [grassTouched, setGrassTouched] = useState(false);
  // Move stamp the loaded turf form was rendered against (freshness token
  // echoed on save — codex #3565 gh-r44).
  const profileHomeStampRef = useRef(null);
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
        setTurfProfile((prev) =>
          prev.grass_type ? prev : { ...prev, grass_type: r.detectedGrassType },
        );
      }
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
      const adjustedScores = {
        ...(techScores || result.adjustedScores || result.displayScores || {}),
      };
      // This panel still edits Fungus/Thatch directly (no consolidated Stress chip),
      // so never post a stale stress_damage — /confirm would treat it as an explicit
      // override and ignore the Fungus/Thatch correction. Drop it so the server
      // re-derives Stress from the corrected fungus/thatch.
      delete adjustedScores.stress_damage;
      const protocol_field_checks = Object.fromEntries(
        Object.entries(protocolChecks).filter(
          ([, value]) => value !== "" && value !== null,
        ),
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
      alert("Assessment confirmed.");
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
    setAssessmentConfirmed(false);
    setSelectedCustomer(null);
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
      profileHomeStampRef.current = d.irrigation_home_changed_at ?? null;
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
      setCountyTouched(false);
      setGrassTouched(false);
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
    const payload = {
      ...Object.fromEntries(
        Object.entries(turfProfile).filter(([, v]) => v !== "" && v !== null),
      ),
      county_confirmed: countyTouched,
      grass_confirmed: grassTouched,
      confirmed_as_of: profileHomeStampRef.current ?? null,
    };
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
      setCountyTouched(false);
      setGrassTouched(false);
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

  const backToSelect = () => {
    setStep("select");
    setPhotos([]);
    setResult(null);
    setAssessmentConfirmed(false);
  };

  // First-use guide
  if (showGuide) {
    return (
      <UiSurface
        density="comfortable"
        className="mx-auto max-w-[1200px] text-ui-body"
      >
        {!embedded && (
          <AdminCommandHeader title="Lawn assessment" icon={Leaf} />
        )}
        <Card className="mx-auto max-w-[420px] p-6 text-center">
          <h2 className="mb-2 text-18 font-medium text-zinc-900">
            Lawn Assessment Guide
          </h2>
          <div className="mb-5 space-y-2 text-ui-body text-ink-secondary">
            <p>
              Stand upright, point camera at the turf at roughly 45°, capture a
              6–8 ft area of lawn.
            </p>
            <p>Avoid shadows and feet in frame.</p>
            <p>
              Take 1-3 photos per visit: front yard, side yard, trouble spots.
            </p>
          </div>
          <Button
            onClick={() => {
              setShowGuide(false);
              localStorage.setItem("lawn_guide_seen", "1");
            }}
          >
            Got It — Let&apos;s Go
          </Button>
        </Card>
      </UiSurface>
    );
  }

  return (
    <UiSurface
      density="comfortable"
      className="mx-auto max-w-[1200px] text-ui-body text-ink-primary"
    >
      {" "}
      {embedded ? (
        step !== "select" && (
          <Button
            onClick={backToSelect}
            variant="secondary"
            className="mb-3 gap-1.5"
          >
            <ArrowLeft size={14} aria-hidden="true" /> Back
          </Button>
        )
      ) : (
        <AdminCommandHeader
          title="Lawn assessment"
          icon={Leaf}
          action={
            step !== "select"
              ? {
                  label: "Back",
                  icon: ArrowLeft,
                  variant: "secondary",
                  onClick: backToSelect,
                }
              : null
          }
        />
      )}
      {/* STEP 1: Select Customer */}
      {step === "select" && (
        <div>
          {" "}
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search today's lawn customers..."
            aria-label="Search today's lawn customers"
          />{" "}
          <div className="mt-3 grid gap-2">
            {filteredCustomers.slice(0, 20).map((c) => (
              // key uses serviceId when present so a customer with two
              // scheduled visits on the same day renders as two distinct
              // rows. Falls back to customer id on the no-services path.
              <Card
                key={c.serviceId || c.id}
                className="flex cursor-pointer flex-col justify-between gap-3 p-4 sm:flex-row sm:items-center"
                onClick={() => {
                  setSelectedCustomer(c);
                  setStep("capture");
                }}
              >
                {" "}
                <div>
                  {" "}
                  <div className="text-ui-body font-medium text-zinc-900">
                    {c.windowStart && (
                      <span className="mr-2">{c.windowStart}</span>
                    )}
                    {c.firstName} {c.lastName}
                  </div>{" "}
                  <div className="text-ui-caption text-ink-secondary">
                    {c.address} · {c.phone}
                  </div>
                  {c.serviceType && (
                    <div className="mt-1 text-ui-caption text-ink-secondary">
                      {c.serviceType}
                    </div>
                  )}
                </div>{" "}
                <div className="flex flex-wrap items-center gap-2">
                  {c.lastAssessment && (
                    <span className="text-ui-caption text-ink-secondary">
                      Last: {new Date(c.lastAssessment).toLocaleDateString()}
                    </span>
                  )}
                  <Button
                    variant="secondary"
                    onClick={(e) => {
                      e.stopPropagation();
                      setSelectedCustomer(c);
                      loadTurfProfile(c.id);
                    }}
                  >
                    Profile
                  </Button>{" "}
                  <Button
                    variant="secondary"
                    onClick={(e) => {
                      e.stopPropagation();
                      loadHistory(c.id);
                      setSelectedCustomer(c);
                    }}
                  >
                    History
                  </Button>{" "}
                </div>{" "}
              </Card>
            ))}
            {filteredCustomers.length === 0 && (
              <ActionFeedback className="justify-center p-8 text-center">
                No lawn services scheduled today (or all assessed)
              </ActionFeedback>
            )}
          </div>{" "}
        </div>
      )}
      {/* STEP 2: Capture Photos */}
      {step === "capture" && selectedCustomer && (
        <div className="mx-auto max-w-[480px]">
          {" "}
          <Card className="mb-4 p-4 text-center">
            {" "}
            <div className="text-ui-body font-medium text-zinc-900">
              {selectedCustomer.firstName} {selectedCustomer.lastName}
            </div>{" "}
            <div className="text-ui-caption text-ink-secondary">
              {selectedCustomer.address}
            </div>{" "}
          </Card>
          {/* Photo grid */}
          <div className="mb-4 grid grid-cols-1 gap-2.5 sm:grid-cols-2">
            {photos.map((p, i) => (
              <div
                key={i}
                className="relative aspect-[4/3] overflow-hidden rounded-md border-hairline border-zinc-200"
              >
                {" "}
                <img
                  src={p.preview}
                  alt=""
                  className="h-full w-full object-cover"
                />{" "}
                <Button
                  onClick={() => removePhoto(i)}
                  variant="danger"
                  aria-label={`Remove photo ${i + 1}`}
                  className="absolute right-1 top-1 !h-11 !min-h-11 !w-11 !min-w-11 !rounded-full !p-0"
                >
                  ×
                </Button>{" "}
              </div>
            ))}
            {photos.length < 3 && (
              <Button
                onClick={() => fileRef.current?.click()}
                variant="secondary"
                className="aspect-[4/3] h-auto flex-col border-dashed text-ui-body"
              >
                {" "}
                <span className="text-24 leading-none" aria-hidden="true">
                  +
                </span>{" "}
                <span>Add Photo</span>{" "}
              </Button>
            )}
          </div>{" "}
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            capture="environment"
            multiple
            onChange={handlePhotoCapture}
            className="hidden"
          />{" "}
          <Button
            onClick={handleAnalyze}
            disabled={photos.length === 0}
            className="w-full"
          >
            Analyze {photos.length} Photo{photos.length !== 1 ? "s" : ""} with
            AI
          </Button>{" "}
        </div>
      )}
      {/* STEP 3: Analyzing */}
      {step === "analyzing" && (
        <ActionFeedback className="flex-col justify-center gap-2 p-10 text-center">
          <span className="text-16 font-medium text-zinc-900">
            Analyzing with Claude + Gemini...
          </span>{" "}
          <span>Running dual-model vision analysis for accuracy</span>{" "}
          <span className="mt-2 flex flex-wrap justify-center gap-2">
            {["Claude Sonnet", "Gemini Flash"].map((m) => (
              <Badge key={m} tone="neutral">
                {m}
              </Badge>
            ))}
          </span>{" "}
        </ActionFeedback>
      )}
      {/* STEP 4: Review Scores */}
      {step === "review" && result && (
        <div className="mx-auto max-w-[520px]">
          {" "}
          <Card className="mb-4 p-4">
            {" "}
            <h2 className="mb-3 text-18 font-medium text-zinc-900">
              AI Scorecard — {selectedCustomer?.firstName}{" "}
              {selectedCustomer?.lastName}
            </h2>
            {/* Divergence summary — shown when Claude and Gemini disagreed on at least one metric.
                Multi-photo assessments emit one flag per photo, so dedupe by metric to match the
                number of highlighted tiles below. */}
            {(() => {
              const uniqueMetrics = new Set(
                (result.divergenceFlags || []).map((f) => f.metric),
              );
              if (uniqueMetrics.size === 0) return null;
              return (
                <ActionFeedback className="mb-3 block rounded-md border-hairline border-warn-fg bg-warn-bg p-3 text-warn-fg">
                  {" "}
                  <div className="mb-1 text-ui-body font-medium">
                    AI models disagreed on {uniqueMetrics.size} metric
                    {uniqueMetrics.size === 1 ? "" : "s"}
                  </div>{" "}
                  <div className="text-ui-caption text-ink-secondary">
                    Tiles below marked{" "}
                    <span className="font-medium text-warn-fg">DIVERGENCE</span>{" "}
                    are where Claude and Gemini gave scores that differed by
                    more than 20 points. Verify by eye before confirming.
                  </div>{" "}
                </ActionFeedback>
              );
            })()}
            {/* Scores — AI value on top, tech-confirmed value below with
                +/- nudge buttons. Tech edits feed adjustedScores on
                /confirm, which is what recordTechCalibration measures
                AI-vs-tech delta against. Step 5 to keep the input
                coarse and the calibration signal stable. */}
            <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
              {[
                // Tech review stays granular so the tech can correct the
                // underlying signals (disease/thatch) that drive Stress
                // derivation and tech calibration. Customers see the four
                // consolidated categories on the report.
                { key: "turf_density", label: "Turf Density" },
                { key: "weed_suppression", label: "Weed Suppression" },
                { key: "color_health", label: "Color Health" },
                { key: "fungus_control", label: "Fungus Control" },
                { key: "thatch_level", label: "Thatch Level" },
              ].map((m) => {
                const aiVal =
                  result.adjustedScores?.[m.key] ??
                  result.displayScores?.[m.key] ??
                  0;
                const techVal = techScores?.[m.key] ?? aiVal;
                const flag = (result.divergenceFlags || []).find(
                  (f) => f.metric === m.key,
                );
                const overridden = techVal !== aiVal;
                return (
                  <Card
                    key={m.key}
                    className={cn(
                      "p-3 text-center",
                      flag && "border-2 border-warn-fg",
                    )}
                  >
                    {" "}
                    <div className="text-ui-caption font-medium text-ink-secondary">
                      AI
                    </div>{" "}
                    <div
                      style={{
                        color: scoreColor(aiVal),
                      }}
                      className="u-nums text-22 font-medium"
                    >
                      {aiVal}%
                    </div>{" "}
                    <div className="mt-0.5 text-ui-body font-medium text-zinc-900">
                      {m.label}
                    </div>
                    {flag && (
                      <>
                        {" "}
                        <div className="mt-1 text-ui-caption text-ink-secondary">
                          Claude: {flag.claude}% · Gemini: {flag.gemini}%
                        </div>{" "}
                        <div className="mt-0.5 text-ui-caption font-medium text-warn-fg">
                          DIVERGENCE — verify
                        </div>{" "}
                      </>
                    )}
                    <div className="mt-2.5 border-t border-hairline border-zinc-200 pt-2">
                      {" "}
                      <div
                        className={cn(
                          "text-ui-caption font-medium",
                          overridden ? "text-zinc-900" : "text-ink-secondary",
                        )}
                      >
                        TECH {overridden ? "· EDITED" : ""}
                      </div>{" "}
                      <div className="mt-1 flex items-center justify-center gap-1.5">
                        {" "}
                        <Button
                          type="button"
                          onClick={() => adjustTechScore(m.key, -5)}
                          aria-label={`Decrease ${m.label}`}
                          variant="secondary"
                          className="!w-11 !min-w-11 !p-0 text-16"
                        >
                          −
                        </Button>{" "}
                        <div
                          style={{ color: scoreColor(techVal) }}
                          className="min-w-14 u-nums text-20 font-medium"
                        >
                          {techVal}%
                        </div>{" "}
                        <Button
                          type="button"
                          onClick={() => adjustTechScore(m.key, 5)}
                          aria-label={`Increase ${m.label}`}
                          variant="secondary"
                          className="!w-11 !min-w-11 !p-0 text-16"
                        >
                          +
                        </Button>{" "}
                      </div>{" "}
                    </div>{" "}
                  </Card>
                );
              })}
            </div>
            <Card className="mt-3 p-3">
              <div className="mb-2 text-ui-body font-medium text-zinc-900">
                Irrigation check
              </div>
              <div className="grid gap-2.5">
                <Field label="Inches per week">
                  <Input
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
                  />
                </Field>
              </div>
              <Field label="Irrigation notes" className="mt-2.5">
                <Textarea
                  value={protocolChecks.protocol_field_notes || ""}
                  onChange={(e) =>
                    setProtocolChecks((prev) => ({
                      ...prev,
                      protocol_field_notes: e.target.value,
                    }))
                  }
                  placeholder="Dry spots, overwatering, runoff, broken heads, or customer controller notes"
                  rows={2}
                />
              </Field>
            </Card>
            {/* Observations */}
            {result.observations && (
              <Card className="mt-3 p-3 text-ui-body text-ink-secondary">
                {" "}
                <div className="mb-1 text-ui-body font-medium text-zinc-900">
                  AI Observations
                </div>
                {result.observations}
              </Card>
            )}
            {/* Season badge */}
            <div className="mt-3 flex flex-wrap items-center gap-2 text-ui-caption text-ink-secondary">
              Season: <Badge tone="neutral">{result.season}</Badge>
              {result.isBaseline && (
                <Badge tone="warn">This is the baseline assessment</Badge>
              )}
            </div>{" "}
          </Card>{" "}
          <div className="flex gap-2">
            {" "}
            {assessmentConfirmed ? (
              <Button onClick={finishAssessment} className="flex-1">
                Done
              </Button>
            ) : (
              <Button
                onClick={handleConfirm}
                disabled={confirming}
                className="flex-1"
              >
                {confirming ? "Confirming..." : "Confirm Scores"}
              </Button>
            )}{" "}
            <Button
              onClick={() => setStep("capture")}
              disabled={assessmentConfirmed}
              variant="secondary"
            >
              Retake
            </Button>{" "}
          </div>{" "}
        </div>
      )}
      {/* HISTORY VIEW */}
      {step === "history" && (
        <div>
          {" "}
          <h2 className="mb-3 text-18 font-medium text-zinc-900">
            {selectedCustomer?.firstName} {selectedCustomer?.lastName} —
            Assessment History
          </h2>
          {history.length === 0 ? (
            <ActionFeedback className="justify-center p-10 text-center">
              No assessments yet
            </ActionFeedback>
          ) : (
            history.map((a, i) => (
              <Card key={a.id || i} className="mb-2 p-4">
                {" "}
                <div className="mb-2 flex items-center justify-between">
                  {" "}
                  <div className="flex flex-wrap items-center gap-2">
                    {" "}
                    <span className="text-ui-body font-medium text-zinc-900">
                      {new Date(a.service_date).toLocaleDateString()}
                    </span>{" "}
                    <Badge tone="neutral">{a.season}</Badge>
                    {a.is_baseline && <Badge tone="warn">Baseline</Badge>}
                  </div>{" "}
                </div>{" "}
                <div className="grid grid-cols-5 gap-1 md:gap-3">
                  {[
                    ["Turf", a.turf_density],
                    ["Weed", a.weed_suppression],
                    ["Color", a.color_health],
                    ["Fungus", a.fungus_control],
                    ["Thatch", a.thatch_level],
                  ].map(([label, val]) => (
                    <div key={label} className="min-w-0 text-center">
                      {" "}
                      <div
                        style={{ color: scoreColor(val || 0) }}
                        className="u-nums text-ui-body font-medium md:text-16"
                      >
                        {val || 0}%
                      </div>{" "}
                      <div className="truncate text-ui-caption text-ink-secondary">
                        {label}
                      </div>{" "}
                    </div>
                  ))}
                </div>
                {a.observations && (
                  <div className="mt-2 text-ui-caption text-ink-secondary">
                    {a.observations}
                  </div>
                )}
              </Card>
            ))
          )}
        </div>
      )}
      {/* TURF PROFILE VIEW — minimal form for the WaveGuard plan engine inputs */}
      {step === "profile" && (
        <div className="mx-auto max-w-[520px]">
          {" "}
          <h2 className="mb-3 text-18 font-medium text-zinc-900">
            {selectedCustomer?.firstName} {selectedCustomer?.lastName} — Turf
            Profile
          </h2>
          {profileLoading ? (
            <ActionFeedback className="justify-center p-10 text-center">
              Loading…
            </ActionFeedback>
          ) : (
            <Card className="p-4">
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
                <Field key={key} label={label} className="mb-3">
                  <Select
                    value={turfProfile[key] || ""}
                    // Reviewing the grass without changing it (Bahia → Bahia
                    // move) must still count as a review — a native select
                    // fires no change event when the shown value is re-picked
                    // (codex #3565 gh-r46), so focusing the field marks it
                    // reviewed; a value with no review stays unconfirmed.
                    onFocus={() => {
                      if (key === "grass_type" && (turfProfile[key] || ""))
                        setGrassTouched(true);
                    }}
                    onChange={(e) => {
                      if (key === "grass_type") setGrassTouched(true);
                      updateProfileField(key, e.target.value);
                    }}
                  >
                    {" "}
                    <option value="">—</option>
                    {opts.map((o) => (
                      <option key={o} value={o}>
                        {o.replace(/_/g, " ")}
                      </option>
                    ))}
                  </Select>
                </Field>
              ))}
              {/* Text/numeric inputs */}
              {[
                ["track_key", "Track key (e.g. st_augustine)", "text"],
                ["cultivar", "Cultivar (e.g. Floratam, Palmetto)", "text"],
                ["lawn_sqft", "Lawn area (sqft)", "number"],
                [
                  "irrigation_inches_per_week",
                  "Irrigation inches / week",
                  "number",
                ],
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
                <Field
                  key={key}
                  label={label}
                  className="mb-3"
                  help={
                    key === "county"
                      ? "Sets the watering-restriction jurisdiction. After an address change, re-enter it here to confirm it for the new home."
                      : undefined
                  }
                >
                  <Input
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
                    onChange={(e) => {
                      if (key === "county") setCountyTouched(true);
                      updateProfileField(key, e.target.value);
                    }}
                  />
                </Field>
              ))}
              {/* Boolean history flags */}
              <fieldset className="mb-3 mt-2 grid gap-2 border-0 p-0">
                <legend className="mb-1 text-ui-body font-medium text-zinc-900">
                  Known pressure history
                </legend>
                {[
                  ["known_chinch_history", "Chinch bug history"],
                  ["known_disease_history", "Disease history"],
                  ["known_drought_stress", "Drought stress history"],
                ].map(([key, label]) => (
                  <Checkbox
                    key={key}
                    label={label}
                    checked={!!turfProfile[key]}
                    onChange={(e) => updateProfileField(key, e.target.checked)}
                  />
                ))}
              </fieldset>{" "}
              <div className="mt-3 flex gap-2">
                {" "}
                <Button
                  onClick={saveTurfProfile}
                  disabled={profileSaving}
                  className="flex-1"
                >
                  {profileSaving ? "Saving…" : "Save Turf Profile"}
                </Button>{" "}
              </div>{" "}
            </Card>
          )}
        </div>
      )}
    </UiSurface>
  );
}
