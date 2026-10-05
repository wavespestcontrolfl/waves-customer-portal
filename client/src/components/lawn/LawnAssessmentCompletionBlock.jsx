// client/src/components/lawn/LawnAssessmentCompletionBlock.jsx
//
// The lawn photo, analyze and confirm step of a lawn completion: the shot list
// (or the three legacy slots), Analyze lawn, the four scores and Confirm
// assessment (the evidence review is not shown here), with the optional mowing
// height reading. Moved out of pages/admin/SchedulePage.jsx unchanged so the
// full completion form and the lawn Fast Complete sheet share ONE
// implementation. Two differences from the code as it stood in SchedulePage:
// the fetcher is the `request` prop (SchedulePage passes its own adminFetch),
// and the text that was 12 or 13px is now 14px (the portal brand gate allows
// nothing smaller on a new file).
import React, { useEffect, useRef, useState } from "react";
import lawnScores from '@lawn-scores';
import { createVisitReview, visitReviewPayload } from "./LawnVisitReview";
import { SHOTS as LAWN_SHOTS, SHOT_CAP as LAWN_SHOT_CAP, addPhotos as addLawnPhotos, assignShotZone, describeAddResult, planFileReads, shotIsFull, shotListHint } from "../../lib/lawn-photo-shots";

// The admin palette values the block uses (same values as SchedulePage's D).
const D = {
  border: "#E2E8F0",
  green: "#16A34A",
  amber: "#F0A500",
  red: "#C0392B",
  text: "#334155",
  muted: "#64748B",
  white: "#FFFFFF",
  heading: "#0F172A",
};

// The four scores the tech reviews and may change until the assessment is
// confirmed (owner ruling 2026-10-04), matching the customer report's
// consolidated diagnosis (Density / Weeds / Color / Stress-Damage). The AI still
// assesses the underlying fungus/thatch/insect/drought/mechanical signals — those
// stay on the assessment row for analytics + folding into stress_damage — but the
// tech corrects one "Condition" score directly. There are no separate Fungus or
// Thatch fields: one the AI left blank takes its "no finding" score at confirm.
export const LAWN_ASSESSMENT_METRICS = [
  { key: "turf_density", label: "Density" },
  { key: "weed_suppression", label: "Weed control" },
  { key: "color_health", label: "Color" },
  { key: "stress_damage", label: "Condition" },
];

// Owner ruling 2026-09-24: an optional per-photo slot label. All optional —
// no count requirement, no blocking. 'front' is the only slot the report's
// before/after slider pairs across visits (server/services/lawn-visit-input.js
// PHOTO_ZONES); close_up/trouble are a different spot every visit and never
// pair. Kept in parity with PHOTO_ZONE_LABELS in
// client/src/components/lawn/LawnVisitReview.jsx.
const LAWN_PHOTO_ZONES = [
  { value: "front", label: "Front" },
  { value: "close_up", label: "Close-up" },
  { value: "trouble", label: "Trouble / watch area" },
];

// Stress flags and the "Protocol field checks" inputs (thatch, chinch pair,
// nematode/large-patch pills, Soil K, protocol notes) were removed from this
// sheet entirely (owner trim 2026-08-07) — nearly all were captured on every
// visit and read by nothing, and the owner ruled the rest off too. The
// completion capture is now photos, the gauge reading, and the four score
// counters. The server endpoints still accept the retired keys from old
// payloads. Soil K no longer has a client input anywhere, so the plan
// engine's profile-completeness check no longer requires it; drought_stress
// likewise no longer reaches the planner's drought-prep selection — both are
// deliberate owner rulings, not oversights.

function lawnScoreColor(value) {
  const n = Number(value) || 0;
  if (n >= 75) return D.green;
  if (n >= 50) return D.amber;
  return D.red;
}

// A - or + beside a score: the block's own control look (white, hairline border,
// 8px radius) at the 44px touch size.
function stepButtonStyle(off) {
  return {
    flexShrink: 0,
    width: 44,
    height: 44,
    padding: 0,
    borderRadius: 8,
    border: `1px solid ${D.border}`,
    background: D.white,
    color: D.heading,
    fontSize: 18,
    lineHeight: 1,
    cursor: off ? "not-allowed" : "pointer",
    opacity: off ? 0.55 : 1,
  };
}

function resizeLawnAssessmentImage(dataUrl, maxEdge = 1600, quality = 0.85) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const longEdge = Math.max(img.width, img.height);
      if (longEdge <= maxEdge) return resolve(dataUrl);
      const scale = maxEdge / longEdge;
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
      resolve(canvas.toDataURL("image/jpeg", quality));
    };
    img.onerror = () => resolve(dataUrl);
    img.src = dataUrl;
  });
}

function readLawnAssessmentPhoto(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = async () => {
      const resized = await resizeLawnAssessmentImage(reader.result);
      resolve({
        data: resized,
        preview: resized,
        name: file.name,
        mimeType: resized.match(/data:([^;]+)/)?.[1] || file.type || "image/jpeg",
      });
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function parseAssessmentScores(row = {}) {
  const turf_density = lawnScores.lawnScoreValue(row.turf_density ?? row.turfDensity);
  const weed_suppression = lawnScores.lawnScoreValue(row.weed_suppression ?? row.weedSuppression);
  const color_health = lawnScores.lawnScoreValue(row.color_health ?? row.colorHealth);
  // Preserve known AI components.
  const fungus_control = lawnScores.lawnScoreValue(row.fungus_control ?? row.fungusControl);
  const thatch_level = lawnScores.lawnScoreValue(row.thatch_level ?? row.thatchLevel);
  // Legacy assessments (created before the stress_damage column) have a null
  // stress_damage. Coercing that to 0 would make a plain re-confirm POST
  // stress_damage: 0, which /confirm treats as an explicit "push Stress to 0"
  // override and persists an artificially low score. Instead derive it exactly the
  // way the server's confirm fallback does — min(fungus, thatch, AI-floor) with the
  // legacy 95 floor — so posting the seeded chip value is a no-op, not an override.
  const rawStress = lawnScores.lawnScoreValue(row.stress_damage ?? row.stressDamage);
  const components = [fungus_control, thatch_level].filter((value) => value != null);
  const stress_damage = rawStress != null
    ? rawStress
    : (components.length ? Math.min(...components, 95) : null);
  return { turf_density, weed_suppression, color_health, fungus_control, thatch_level, stress_damage };
}

// The AI's own read — shown beside a score the technician changed, never
// what's displayed (that's techScores/scoreSource, which may already hold the
// technician's entry from a prior partial save). Run-backed: the run's
// immutable scores_adjusted snapshot (visitAssessment.aiScores from the
// server), which a save never touches. Legacy (no run, visitAssessment null):
// the server's own read sent by the reload route, else the assessment row's
// RAW columns — stress_damage is read raw, never parseAssessmentScores's
// derived worst-of-fungus/thatch guess.
function resolveAiScores(assessment = {}, visitAssessment, serverAiScores) {
  if (visitAssessment?.aiScores) return visitAssessment.aiScores;
  // Legacy rows: the reload route sends the server's own AI read.
  if (serverAiScores) return serverAiScores;
  const raw = (a, b) => lawnScores.lawnScoreValue(assessment[a] ?? assessment[b]);
  return {
    turf_density: raw("turf_density", "turfDensity"),
    weed_suppression: raw("weed_suppression", "weedSuppression"),
    color_health: raw("color_health", "colorHealth"),
    fungus_control: raw("fungus_control", "fungusControl"),
    thatch_level: raw("thatch_level", "thatchLevel"),
    stress_damage: raw("stress_damage", "stressDamage"),
  };
}

export default function LawnAssessmentCompletionBlock({
  service,
  // The fetcher the lookup, analyze and confirm calls go through: the host
  // page's own admin fetch (it returns the parsed body and throws an Error
  // carrying .status and .code).
  request,
  disabled,
  onConfirmed,
  // Fires false while the existing-assessment lookup is in flight and true
  // once it settles — the parent must not treat the pre-load null confirmed
  // id as "retake pending".
  onReady,
  // Height measurement stays optional; separate lawn-length photo capture is retired.
  showGaugeReading = false,
  gaugeHeightIn = null,
  onGaugeHeight,
  // The tech's free-text visit notes (owned by CompletionPanel) — passed through
  // so the AI photo analysis can factor them in alongside the images.
  technicianNotes = "",
}) {
  const [photos, setPhotosState] = useState([]);
  // The photo list's source of truth is this ref: every change goes through
  // setPhotos below, which computes from the latest list and mirrors it into
  // state. A read that lands after a re-render (or another read) therefore
  // always decides against what is really held, with no stale closure.
  const photosRef = useRef([]);
  const setPhotos = (update) => {
    const next = typeof update === "function" ? update(photosRef.current) : update;
    photosRef.current = next;
    setPhotosState(next);
  };
  // GATE_LAWN_SHOT_LIST (lawn report rebuild P18): the server says so in the
  // existing-assessment lookup below. Off (the default, and on any lookup
  // failure) the step keeps its three optional slots and 3-photo cap.
  const [shotList, setShotList] = useState(false);
  // False until the lookup below has answered (or failed): the mode decides the
  // photo cap, so capture waits for it rather than truncating at 3 photos and
  // then switching to 8.
  const [modeKnown, setModeKnown] = useState(false);
  const pendingShotRef = useRef(null);
  // Shots whose photo is still being read: held so a second tap on the same
  // one-photo shot cannot queue a duplicate while the first decode is in flight.
  const [readingShots, setReadingShots] = useState([]);
  // Photos being decoded right now (total, and per tapped shot): counted so two
  // quick picks cannot each decode a full batch.
  const inFlightRef = useRef({ total: 0, byShot: {} });
  const photoCap = shotList ? LAWN_SHOT_CAP : 3;
  const [result, setResult] = useState(null);
  const [visitReview, setVisitReview] = useState(null);
  const [techScores, setTechScores] = useState(null);
  // Keys the technician actually typed this session. Only these are posted:
  // the server keeps the saved value of an omitted key, and resending a
  // server-derived value (e.g. Stress) would read as an explicit entry and
  // freeze it.
  const [typedKeys, setTypedKeys] = useState(() => new Set());
  const [confirmedId, setConfirmedId] = useState(null);
  const [loading, setLoading] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState("");
  const fileRef = useRef(null);
  useEffect(() => {
    let cancelled = false;
    setPhotos([]);
    setShotList(false);
    setModeKnown(false);
    pendingShotRef.current = null;
    setReadingShots([]);
    setResult(null);
    setVisitReview(null);
    setTechScores(null);
    setTypedKeys(new Set());
    setConfirmedId(null);
    setError("");
    onConfirmed?.(null);
    onReady?.(false);
    if (!service?.id) {
      setModeKnown(true);
      onReady?.(true);
      return () => { cancelled = true; };
    }

    setLoading(true);
    request(`/admin/lawn-assessment/service/${service.id}`)
      .then((data) => {
        if (!cancelled && data?.shotListEnabled === true) setShotList(true);
        if (cancelled || !data?.assessment) return;
        const assessment = data.assessment;
        const scores = parseAssessmentScores(assessment);
        setResult({
          success: true,
          visitAssessment: data.visitAssessment,
          assessment,
          adjustedScores: scores,
          displayScores: scores,
          aiScores: resolveAiScores(assessment, data.visitAssessment, data.aiScores),
          observations: assessment.observations || "",
        });
        // The row holds what was saved: the AI read, or the technician's
        // entry from an earlier save.
        setTechScores(scores);
        setTypedKeys(new Set());
        setVisitReview(createVisitReview(data.visitAssessment, assessment.observations));
        if (assessment.confirmed_by_tech) {
          setConfirmedId(assessment.id);
          onConfirmed?.(assessment.id);
        }
      })
      .then(() => {
        if (!cancelled) onReady?.(true);
      })
      .catch(() => {
        // The lookup learned NOTHING — report failed, never ready: the parent
        // omits lawnAssessmentId so the server's visit-linked fallback (DB
        // truth) still grounds any existing confirmed scores.
        if (!cancelled) onReady?.("failed");
      })
      .finally(() => {
        if (!cancelled) { setLoading(false); setModeKnown(true); }
      });

    return () => {
      cancelled = true;
    };
  }, [service?.id]);

  async function addPhotos(event) {
    const files = Array.from(event.target.files || []);
    // A shot's own "Add" button tags the photos it brings in; only set while
    // the shot list is on, so this is null (every photo untagged) off.
    const pendingZone = pendingShotRef.current;
    pendingShotRef.current = null;
    // Shot list off keeps its original pre-read cut at the 3-photo cap and its
    // all-at-once decode. On, the batch is bounded BEFORE any file is decoded
    // (room left after photos held and reads in flight; a shot's own room for its
    // Add button), the rest are named, and the kept files decode one at a time.
    let picked;
    let skipped = [];
    if (shotList) {
      ({ toRead: picked, skipped } = planFileReads(files, {
        held: photosRef.current,
        inFlight: inFlightRef.current.total,
        inFlightForShot: pendingZone ? (inFlightRef.current.byShot[pendingZone] || 0) : 0,
        shot: pendingZone,
      }));
    } else {
      picked = files.slice(0, Math.max(0, 3 - photosRef.current.length));
    }
    if (!files.length || (picked.length === 0 && skipped.length === 0)) return;
    setError(describeAddResult({ rejected: skipped }));
    if (picked.length === 0) { if (fileRef.current) fileRef.current.value = ""; return; }
    if (pendingZone) setReadingShots((prev) => [...prev, pendingZone]);
    if (shotList) {
      inFlightRef.current.total += picked.length;
      if (pendingZone) inFlightRef.current.byShot[pendingZone] = (inFlightRef.current.byShot[pendingZone] || 0) + picked.length;
    }
    try {
      let nextPhotos;
      if (shotList) {
        nextPhotos = [];
        for (const file of picked) nextPhotos.push(await readLawnAssessmentPhoto(file));
      } else {
        nextPhotos = await Promise.all(picked.map(readLawnAssessmentPhoto));
      }
      // One pure decision over the list as it is right now: photo cap, size
      // limits, per-shot room and tagging. Nothing is pre-checked outside it.
      const outcome = addLawnPhotos(photosRef.current, nextPhotos, { shot: pendingZone, shotList });
      const message = describeAddResult({ rejected: [...skipped, ...outcome.rejected], untagged: outcome.untagged });
      if (message) setError(message);
      if (outcome.photos.length === photosRef.current.length) return;
      setPhotos(outcome.photos);
      setResult(null);
      setTechScores(null);
      setTypedKeys(new Set());
      setConfirmedId(null);
      onConfirmed?.(null);
    } catch (err) {
      setError(err.message || "Photo read failed");
    } finally {
      if (shotList) {
        inFlightRef.current.total -= picked.length;
        if (pendingZone) inFlightRef.current.byShot[pendingZone] -= picked.length;
      }
      if (pendingZone) setReadingShots((prev) => { const at = prev.indexOf(pendingZone); return at < 0 ? prev : prev.filter((_, i) => i !== at); });
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  // Only one photo may carry the "front" slot at a time — the before/after
  // slider pairs on it, so picking Front on another photo clears the prior
  // one. Picking the same slot again clears it (every slot, including none,
  // is a valid choice).
  function setPhotoZone(index, zone) {
    // Shot list on: every shot allows one photo (a problem area, two), so
    // picking a shot another photo holds moves it, as Front always has.
    if (shotList) {
      setPhotos((prev) => assignShotZone(prev, index, zone));
      return;
    }
    setPhotos((prev) => {
      const current = prev[index]?.zone || null;
      const next = current === zone ? null : zone;
      return prev.map((photo, i) => {
        if (i === index) return { ...photo, zone: next };
        if (next === "front" && photo.zone === "front") return { ...photo, zone: null };
        return photo;
      });
    });
  }

  // Owner ruling 2026-10-04: the tech may change any of the four scores until
  // the assessment is confirmed. An emptied field posts null, which the
  // server reads as "back to the AI's score".
  function fillScore(key, rawValue) {
    setTypedKeys((prev) => new Set(prev).add(key));
    setTechScores((prev) => {
      if (!prev) return prev;
      if (rawValue === "") return { ...prev, [key]: null };
      const n = Number(rawValue);
      if (!Number.isFinite(n)) return prev;
      return { ...prev, [key]: Math.max(0, Math.min(100, Math.round(n))) };
    });
  }

  async function analyze() {
    if (!service?.customerId || photos.length === 0) return;
    setAnalyzing(true);
    // Same suspension as the confirmation POST: the vision analysis can run
    // long, and a report generated mid-analysis would carry an explicit-null
    // assessment state for scores that are about to be reviewed.
    onReady?.(false);
    setError("");
    try {
      const response = await request("/admin/lawn-assessment/assess", {
        method: "POST",
        body: JSON.stringify({
          customerId: service.customerId,
          serviceId: service.id,
          photos: photos.map((photo) => ({
            data: photo.data.split(",")[1],
            mimeType: photo.mimeType || "image/jpeg",
            ...(photo.zone ? { zone: photo.zone } : {}),
          })),
          // Extra context for the vision model (see buildVisionPrompt server-side).
          turfHeightIn: gaugeHeightIn,
          technicianNotes,
        }),
      });
      if (response.success === false) {
        setError(response.message || "Assessment failed. Retake photos and try again.");
        return;
      }
      const scores = response.adjustedScores || response.displayScores || {};
      setResult({ ...response, aiScores: resolveAiScores(response.assessment, response.visitAssessment) });
      setVisitReview(createVisitReview(response.visitAssessment, response.assessment?.observations !== undefined ? response.assessment.observations : response.observations));
      setTechScores({ ...scores });
      setTypedKeys(new Set());
      setConfirmedId(null);
      onConfirmed?.(null);
    } catch (err) {
      setError(err.message || "Assessment failed");
    } finally {
      setAnalyzing(false);
      // Settled either way: post-analysis the row is unconfirmed (or the
      // analysis failed with photos pending) — explicit null IS the true
      // "review outstanding" state.
      onReady?.(true);
    }
  }

  async function confirm() {
    if (!result?.assessment?.id) return;
    setConfirming(true);
    // Readiness is suspended while the confirmation POST is in flight — the
    // parent's id is stale until it lands, and generating meanwhile would
    // send an explicit null that suppresses the assessment being confirmed.
    onReady?.(false);
    setError("");
    try {
      const { confirmed: confirmationComplete, assessment: savedAssessment, visitAssessment } = await request("/admin/lawn-assessment/confirm", {
        method: "POST",
        body: JSON.stringify({
          assessmentId: result.assessment.id,
          adjustedScores: Object.fromEntries([...typedKeys].map((key) => [key, techScores?.[key] ?? null])),
          ...visitReviewPayload(visitReview),
        }),
      });
      setResult((prev) => ({
        ...prev,
        assessment: savedAssessment || prev.assessment,
        visitAssessment: visitAssessment ?? prev.visitAssessment,
      }));
      // Show what the server actually saved.
      if (savedAssessment) {
        const saved = parseAssessmentScores(savedAssessment);
        setTechScores(saved);
        setTypedKeys(new Set());
      }
      if (visitAssessment) {
        setVisitReview(createVisitReview(visitAssessment, savedAssessment?.observations));
      }
      const assessmentId = confirmationComplete === false ? null : savedAssessment?.id || result.assessment.id;
      setConfirmedId(assessmentId);
      onConfirmed?.(assessmentId);
      onReady?.(true);
      setError(assessmentId ? "" : "Scores saved. Complete the missing scores before confirming.");
    } catch (err) {
      setError(err.message || "Confirm failed");
      // A definitive 4xx rejection means the write did NOT commit — null is
      // the true state (retake still pending), so readiness returns true and
      // the explicit-null payload keeps any superseded row suppressed.
      // Ambiguous failures (network, 5xx, lost response) report failed: the
      // write may have committed, so the server grounds from DB truth.
      const definitiveRejection =
        Number(err?.status) >= 400 && Number(err?.status) < 500;
      onReady?.(definitiveRejection ? true : "failed");
    } finally {
      setConfirming(false);
    }
  }

  // The - and + buttons beside a score (owner 2026-10-05): one step per tap,
  // clamped 0 to 100, and a held press repeats. A step counts as typed, so it
  // posts like a typed number. From a blank score a step starts at the AI read
  // (0 when it left none).
  function stepScore(key, delta) {
    setTypedKeys((prev) => new Set(prev).add(key));
    setTechScores((prev) => {
      if (!prev) return prev;
      const current = Number(prev[key]);
      const base = prev[key] != null && prev[key] !== "" && Number.isFinite(current)
        ? current
        : lawnScores.lawnScoreValue(result?.aiScores?.[key]) ?? 0;
      return { ...prev, [key]: Math.max(0, Math.min(100, Math.round(base) + delta)) };
    });
  }
  const holdRef = useRef({ timer: null, repeated: false });
  function stopHold() {
    clearTimeout(holdRef.current.timer);
    clearInterval(holdRef.current.timer);
    holdRef.current.timer = null;
  }
  useEffect(() => stopHold, []);
  // Handlers for a step button: a tap (or Enter/Space) steps once; holding the
  // press steps again every 120ms after a short pause, and the click that ends
  // a hold does not step a second time.
  function holdToRepeat(key, delta) {
    return {
      onClick: () => {
        if (holdRef.current.repeated) { holdRef.current.repeated = false; return; }
        stepScore(key, delta);
      },
      onPointerDown: () => {
        stopHold();
        holdRef.current.repeated = false;
        holdRef.current.timer = setTimeout(() => {
          holdRef.current.repeated = true;
          stepScore(key, delta);
          holdRef.current.timer = setInterval(() => stepScore(key, delta), 120);
        }, 450);
      },
      onPointerUp: stopHold,
      onPointerLeave: stopHold,
      onPointerCancel: stopHold,
    };
  }

  const scoreSource = techScores || result?.adjustedScores || result?.displayScores || null;
  const hasResult = !!result?.assessment?.id;
  const confirmed = !!confirmedId;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      {loading && (
        <div style={{ fontSize: 14, color: D.muted }}>Checking existing assessment...</div>
      )}
      {/* Capture row — always visible so the mowing-height reading can be
          added even after the assessment is analyzed (Codex P1). "Add turf photos" +
          "Analyze lawn" stay pre-analysis only. */}
      <input
        ref={fileRef}
        type="file"
        aria-label="Add turf photos"
        accept="image/*"
        multiple
        onChange={addPhotos}
        style={{ display: "none" }}
      />
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        {!hasResult && (
          <>
            <button
              type="button"
              onClick={() => { pendingShotRef.current = null; fileRef.current?.click(); }}
              disabled={disabled || photos.length >= photoCap || analyzing || !modeKnown}
              style={{
                height: 38,
                padding: "0 14px",
                borderRadius: 8,
                border: `1px solid ${D.border}`,
                background: D.white,
                color: D.heading,
                fontSize: 14,
                fontWeight: 500,
                cursor: disabled || photos.length >= photoCap || analyzing || !modeKnown ? "not-allowed" : "pointer",
                opacity: disabled || photos.length >= photoCap || analyzing || !modeKnown ? 0.55 : 1,
              }}
            >
              Add turf photos
            </button>
            <span style={{ fontSize: 14, color: D.muted }}>{photos.length}/{photoCap}</span>
            {!modeKnown && <span role="status" data-testid="lawn-photo-mode-pending" style={{ fontSize: 14, color: D.muted }}>Checking photo options…</span>}
          </>
        )}
            {showGaugeReading && (
              <>
                <span style={{ fontSize: 14, color: D.muted, fontWeight: 500 }}>Lawn length</span>
                <input
                  type="number"
                  inputMode="decimal"
                  step="0.25"
                  min="0.5"
                  max="8"
                  value={gaugeHeightIn ?? ""}
                  disabled={disabled || analyzing}
                  placeholder="e.g. 4"
                  onChange={(e) => onGaugeHeight?.(e.target.value === "" ? null : Number(e.target.value))}
                  style={{
                    width: 64,
                    height: 38,
                    padding: "0 10px",
                    borderRadius: 8,
                    border: `1px solid ${D.border}`,
                    background: D.white,
                    color: D.heading,
                    fontSize: 14,
                  }}
                />
                <span style={{ fontSize: 14, color: D.muted }}>inches</span>
              </>
            )}
          </div>
          {!hasResult && (
            <>
          {/* GATE_LAWN_SHOT_LIST: the named shots, one line of how-to each. A
              shot's Add button brings the photo in already tagged with it. */}
          {shotList && (
            <ul data-testid="lawn-shot-list" aria-label="Lawn photo shots" style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 8 }}>
              {LAWN_SHOTS.map((shot) => (
                <li key={shot.key} data-testid={`lawn-shot-${shot.key}`} style={{ display: "flex", gap: 8, alignItems: "flex-start", padding: "8px 10px", border: `1px solid ${D.border}`, borderRadius: 8, background: D.white }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 14, fontWeight: 500, color: D.heading }}>
                      {shot.label}
                      {photos.some((photo) => photo.zone === shot.key) ? " (added)" : ""}
                    </div>
                    <div style={{ fontSize: 14, color: D.muted, lineHeight: 1.4 }}>{shot.instruction}</div>
                  </div>
                  <button
                    type="button"
                    aria-label={`Add photo for ${shot.label}`}
                    disabled={disabled || analyzing || photos.length >= photoCap || shotIsFull(photos, shot.key) || readingShots.includes(shot.key)}
                    onClick={() => { pendingShotRef.current = shot.key; fileRef.current?.click(); }}
                    style={{ height: 34, padding: "0 12px", borderRadius: 8, border: `1px solid ${D.border}`, background: D.white, color: D.heading, fontSize: 14, cursor: "pointer" }}
                  >
                    Add
                  </button>
                </li>
              ))}
            </ul>
          )}
          {photos.length > 0 && (
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              {photos.map((photo, index) => (
                <div key={`${photo.name}-${index}`} style={{ position: "relative", width: 96 }}>
                  <img
                    src={photo.preview}
                    alt=""
                    style={{
                      display: "block",
                      width: 96,
                      height: 78,
                      objectFit: "cover",
                      borderRadius: 8,
                      border: `1px solid ${D.border}`,
                    }}
                  />
                  <button
                    type="button"
                    onClick={() => setPhotos((prev) => prev.filter((_, i) => i !== index))}
                    aria-label="Remove assessment photo"
                    style={{
                      position: "absolute",
                      top: -7,
                      right: -7,
                      width: 22,
                      height: 22,
                      borderRadius: "50%",
                      border: "none",
                      background: D.heading,
                      color: "#fff",
                      cursor: "pointer",
                      lineHeight: 1,
                    }}
                  >
                    x
                  </button>
                  {/* Optional slot label — all optional, no count requirement.
                      Only one photo may hold "front" at a time (setPhotoZone). */}
                  <select
                    value={photo.zone || ""}
                    disabled={disabled || analyzing}
                    onChange={(e) => setPhotoZone(index, e.target.value || null)}
                    aria-label={`Slot for photo ${index + 1}`}
                    style={{
                      display: "block",
                      width: "100%",
                      marginTop: 4,
                      height: 34,
                      borderRadius: 6,
                      border: `1px solid ${D.border}`,
                      background: D.white,
                      color: D.heading,
                      fontSize: 14,
                      padding: "0 2px",
                    }}
                  >
                    <option value="">No slot</option>
                    {(shotList ? LAWN_SHOTS.map((shot) => ({ value: shot.key, label: shot.label })) : LAWN_PHOTO_ZONES).map((zone) => (
                      <option key={zone.value} value={zone.value}>{zone.label}</option>
                    ))}
                  </select>
                </div>
              ))}
            </div>
          )}
          {/* A soft hint, never a requirement (owner 2026-10-02): the report's
              "since your last visit" score line needs 2+ usable photos on both
              visits (lawn-progress.js COMPARABLE_LEVELS), so a 1-photo visit
              can never show it. Analyze stays enabled at one photo. */}
          {shotList && shotListHint(photos) && (
            <div data-testid="lawn-shot-list-hint" style={{ fontSize: 14, color: D.muted, lineHeight: 1.4 }}>
              {shotListHint(photos)}
            </div>
          )}
          {!shotList && photos.length < 2 && (
            <div data-testid="lawn-photo-nudge" style={{ fontSize: 14, color: D.muted, lineHeight: 1.4 }}>
              2 or 3 photos work best: front, close-up and any trouble spot. With one photo, next visit&apos;s report can&apos;t show whether the lawn improved.
            </div>
          )}
          <button
            type="button"
            onClick={analyze}
            disabled={disabled || photos.length === 0 || analyzing}
            style={{
              height: 40,
              borderRadius: 8,
              border: "none",
              background: D.green,
              color: "#fff",
              fontSize: 14,
              fontWeight: 500,
              cursor: disabled || photos.length === 0 || analyzing ? "not-allowed" : "pointer",
              opacity: disabled || photos.length === 0 || analyzing ? 0.55 : 1,
            }}
          >
            {analyzing ? "Analyzing..." : "Analyze lawn"}
          </button>
        </>
      )}
      {hasResult && (
        <>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 6 }}>
            {LAWN_ASSESSMENT_METRICS.map((metric) => {
              const value = lawnScores.lawnScoreValue(scoreSource?.[metric.key]);
              // The AI's own read, from result.aiScores (the run's immutable
              // snapshot, or the server's read for a legacy no-run row; see
              // resolveAiScores) — shown under a score the tech changed or
              // emptied, so the original stays in view.
              const aiValue = lawnScores.lawnScoreValue(result?.aiScores?.[metric.key]);
              return (
                <div
                  key={metric.key}
                  style={{
                    border: `1px solid ${D.border}`,
                    borderRadius: 8,
                    padding: "8px 4px",
                    textAlign: "center",
                    background: D.white,
                    minWidth: 0,
                  }}
                >
                  {confirmed ? (
                    <div style={{ fontSize: 15, fontWeight: 500, color: value == null ? D.muted : lawnScoreColor(value), lineHeight: 1.1 }}>
                      {value == null ? "—" : `${value}/100`}
                    </div>
                  ) : (
                    <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                      <button
                        type="button"
                        aria-label={`Lower ${metric.label} score`}
                        disabled={disabled || confirming}
                        style={stepButtonStyle(disabled || confirming)}
                        {...holdToRepeat(metric.key, -1)}
                      >
                        {"\u2212"}
                      </button>
                      <input
                        type="number"
                        inputMode="numeric"
                        min={0}
                        max={100}
                        value={techScores?.[metric.key] ?? ""}
                        disabled={disabled || confirming}
                        aria-label={`${metric.label} score`}
                        placeholder="0-100"
                        onChange={(e) => fillScore(metric.key, e.target.value)}
                        style={{
                          flex: 1,
                          minWidth: 0,
                          height: 36,
                          padding: "0 4px",
                          borderRadius: 6,
                          border: `1px solid ${D.border}`,
                          background: D.white,
                          color: value == null ? D.heading : lawnScoreColor(value),
                          // 16px keeps iOS Safari from zooming the page on focus.
                          fontSize: 16,
                          fontWeight: 500,
                          textAlign: "center",
                          boxSizing: "border-box",
                          MozAppearance: "textfield",
                        }}
                      />
                      <button
                        type="button"
                        aria-label={`Raise ${metric.label} score`}
                        disabled={disabled || confirming}
                        style={stepButtonStyle(disabled || confirming)}
                        {...holdToRepeat(metric.key, 1)}
                      >
                        +
                      </button>
                    </div>
                  )}
                  <div style={{ fontSize: 14, color: D.muted, marginTop: 3 }}>{metric.label}</div>
                  {!confirmed && aiValue != null && aiValue !== value && (
                    <div data-testid={`lawn-ai-score-${metric.key}`} style={{ fontSize: 14, color: D.muted, marginTop: 2 }}>AI {aiValue}</div>
                  )}
                </div>
              );
            })}
          </div>
          {/* The evidence review (photo quality, observation, photo findings,
              technician details) is not shown while completing a visit (owner
              2026-10-04: the technician takes photos, the AI reads them, the
              report is built). Confirm still sends the default review, which
              keeps every finding, so the report and tip ranking are unchanged.
              The office can still edit a review on the Lawn assessment page. */}
          <div style={{ display: "flex", gap: 8 }}>
            {confirmed ? (
              <div
                style={{
                  flex: 1,
                  padding: "10px 12px",
                  borderRadius: 8,
                  background: `${D.green}14`,
                  color: D.green,
                  fontSize: 14,
                  fontWeight: 500,
                  textAlign: "center",
                }}
              >
                Assessment confirmed
              </div>
            ) : (
              <button
                type="button"
                onClick={confirm}
                disabled={disabled || confirming}
                style={{
                  flex: 1,
                  height: 40,
                  borderRadius: 8,
                  border: "none",
                  background: D.green,
                  color: "#fff",
                  fontSize: 14,
                  fontWeight: 500,
                  cursor: disabled || confirming ? "not-allowed" : "pointer",
                  opacity: disabled || confirming ? 0.55 : 1,
                }}
              >
                {confirming ? "Confirming..." : "Confirm assessment"}
              </button>
            )}
            <button
              type="button"
              onClick={() => {
                setPhotos([]);
                setResult(null);
                setTechScores(null);
                setTypedKeys(new Set());
                setConfirmedId(null);
                setError("");
                onConfirmed?.(null);
              }}
              disabled={disabled || analyzing || confirming}
              style={{
                height: 40,
                padding: "0 14px",
                borderRadius: 8,
                border: `1px solid ${D.border}`,
                background: D.white,
                color: D.text,
                fontSize: 14,
                fontWeight: 500,
                cursor: disabled || analyzing || confirming ? "not-allowed" : "pointer",
                opacity: disabled || analyzing || confirming ? 0.55 : 1,
              }}
            >
              Retake
            </button>
          </div>
        </>
      )}
      {error && <div style={{ fontSize: 14, color: D.red, lineHeight: 1.45 }}>{error}</div>}
    </div>
  );
}
