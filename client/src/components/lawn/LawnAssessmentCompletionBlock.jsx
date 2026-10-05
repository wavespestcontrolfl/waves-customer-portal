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
import React, { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import lawnScores from '@lawn-scores';
import { createVisitReview, visitReviewPayload } from "./LawnVisitReview";
import { Button, Input, Select, UiSurface } from "../ui";

// The full form's mobile page tokens (SchedulePage CompletionPanel): buttons are
// 999px pills, uppercase with 0.3px spacing, the secondary one an ink outline;
// fields are 12px-radius with a 1px #E5E5E5 hairline; cards 16px. The shared
// primitives are zinc, so these override (!) their radius, border and case.
const PILL = "!rounded-full !uppercase !tracking-[0.3px]";
const PILL_OUTLINE = `${PILL} !border !border-[#111111]`;
const FIELD = "!rounded-[12px] !border !border-[#E5E5E5]";
import { SHOTS as LAWN_SHOTS, SHOT_CAP as LAWN_SHOT_CAP, addPhotos as addLawnPhotos, assignShotZone, describeAddResult, planFileReads, shotIsFull, shotListHint } from "../../lib/lawn-photo-shots";

// The lawn sheet's (compact) shot list: four named slots, one short line each
// (owner 2026-10-05). Each maps onto an existing shot key and the server is not
// told anything new. "Back or side" tags the back overview; a photo already
// tagged with the side overview (or any hidden key: older visit, the generic Add
// turf photos button) still shows in its photo tile and counts as a photo.
// `keys` are the tags that make a slot read "(added)".
const COMPACT_SLOTS = [
  { key: "front", keys: ["front"], label: "Front", instruction: "Whole front lawn from the mailbox or driveway." },
  { key: "back", keys: ["back", "side"], label: "Back or side", instruction: "Whole back lawn, or one side if gated." },
  { key: "close_up", keys: ["close_up"], label: "Close-up", instruction: "Straight down, a foot up, typical spot." },
  { key: "trouble", keys: ["trouble"], label: "Problem area", instruction: "Only when something looks wrong." },
];

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

function LawnAssessmentCompletionBlock({
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
  // The Fast Complete sheet's one-screen mode (owner 2026-10-04): the shot list
  // is the four named slots (COMPACT_SLOTS), the count is a plain "n added",
  // no minimum-photos hint; only the four scores (the Fungus control and Thatch condition tiles never show),
  // each one the technician may change until the assessment is confirmed
  // (an input prefilled with the AI read, "AI n" under a changed one), then
  // Confirm assessment and Retake as ever. onProgress reports { photos,
  // assessed } so the sheet can say what is missing, plus whether each of this
  // block's own buttons can be pressed right now (canAddPhoto, canAnalyze,
  // canConfirm) and whether an analysis or confirm is running. The ref's handle
  // ({ analyze, confirm, openPhotoPicker }) lets the sheet's bottom button run
  // the same step as the in-flow button, with the same disabled rules. The full
  // completion form passes neither and is unchanged.
  compact = false,
  onProgress,
}, ref) {
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
      setError(assessmentId ? "" : compact
        ? "The photos did not give a full read. Fill any blank score, or tap Retake and analyze again."
        : "Scores saved. Complete the missing scores before confirming.");
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
  // posts like a typed number. From a blank score the step starts at the AI read
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
  // A step button steps once per tap (or Enter/Space). There is no hold-to-
  // repeat: a timer that keeps stepping between events outlived every state
  // change a technician can make with a second finger (confirm, retake, a
  // slide away), and each review round found another such edge. A tap is
  // the one gesture the owner asked for ("+ or -").
  function stepHandlers(key, delta) {
    return { onClick: () => stepScore(key, delta) };
  }

  const scoreSource = techScores || result?.adjustedScores || result?.displayScores || null;
  const hasResult = !!result?.assessment?.id;
  const confirmed = !!confirmedId;
  // What each button can do right now: the in-flow buttons' own disabled rules,
  // reported to the sheet and enforced again by the handle below. A photo still
  // being read holds Analyze for the sheet's button, so it cannot run on fewer
  // photos than the tech just added.
  const canAddPhoto = !hasResult && !(disabled || photos.length >= photoCap || analyzing || !modeKnown);
  const canAnalyze = !hasResult && !(disabled || photos.length === 0 || analyzing) && readingShots.length === 0;
  const canConfirm = hasResult && !confirmed && !(disabled || confirming);
  function openPhotoPicker() {
    pendingShotRef.current = null;
    fileRef.current?.click();
  }
  useImperativeHandle(ref, () => ({
    analyze: () => { if (canAnalyze) analyze(); },
    confirm: () => { if (canConfirm) confirm(); },
    openPhotoPicker: () => { if (canAddPhoto) openPhotoPicker(); },
  }));
  useEffect(() => {
    onProgress?.({ photos: photos.length, assessed: hasResult, canAddPhoto, canAnalyze, canConfirm, analyzing, confirming });
  }, [photos.length, hasResult, canAddPhoto, canAnalyze, canConfirm, analyzing, confirming]);
  // The lawn sheet (compact, with the shot list) shows lawn length as one more
  // row under the photo slots; everywhere else it stays beside the photo button.
  const gaugeInSlots = compact && shotList && !hasResult;
  const gaugeInput = (
    <Input
      type="number"
      inputMode="decimal"
      step="0.25"
      min="0.5"
      max="8"
      value={gaugeHeightIn ?? ""}
      disabled={disabled || analyzing}
      placeholder="e.g. 4"
      aria-label="Lawn length in inches"
      onChange={(e) => onGaugeHeight?.(e.target.value === "" ? null : Number(e.target.value))}
      className={`!w-20 ${FIELD}`}
    />
  );

  return (
    <UiSurface density="comfortable" className="flex flex-col gap-3 text-zinc-900">
      {loading && (
        <div className="text-14 text-zinc-500">Checking existing assessment...</div>
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
        className="hidden"
      />
      <div className="flex flex-wrap items-center gap-2">
        {!hasResult && (
          <>
            <Button
              variant="secondary"
              className={PILL_OUTLINE}
              onClick={openPhotoPicker}
              disabled={disabled || photos.length >= photoCap || analyzing || !modeKnown}
            >
              Add turf photos
            </Button>
            <span className="text-14 text-zinc-500">{compact ? `${photos.length} added` : `${photos.length}/${photoCap}`}</span>
            {!modeKnown && <span role="status" data-testid="lawn-photo-mode-pending" className="text-14 text-zinc-500">Checking photo options…</span>}
          </>
        )}
        {showGaugeReading && !gaugeInSlots && (
          <>
            <span className="text-14 font-medium text-zinc-500">Lawn length</span>
            {gaugeInput}
            <span className="text-14 text-zinc-500">inches</span>
          </>
        )}
      </div>
      {!hasResult && (
        <>
          {/* GATE_LAWN_SHOT_LIST: the named shots, one line of how-to each. A
              shot's Add button brings the photo in already tagged with it. */}
          {shotList && (
            <ul data-testid="lawn-shot-list" aria-label="Lawn photo shots" className="m-0 flex list-none flex-col gap-2 p-0">
              {(compact ? COMPACT_SLOTS : LAWN_SHOTS).map((shot) => {
                const added = photos.some((photo) => (shot.keys || [shot.key]).includes(photo.zone));
                return (
                  <li
                    key={shot.key}
                    data-testid={`lawn-shot-${shot.key}`}
                    className={`flex items-start gap-2 rounded-[12px] border px-3 py-2 ${added ? "border-[#111111] bg-[#F5F5F5]" : "border-[#E5E5E5] bg-white"}`}
                  >
                    <div className="min-w-0 flex-1">
                      <div className="text-14 font-medium text-zinc-900">
                        {shot.label}
                        {added ? " (added)" : ""}
                      </div>
                      <div className="text-14 leading-snug text-zinc-500">{shot.instruction}</div>
                    </div>
                    <Button
                      variant="secondary"
                      className={PILL_OUTLINE}
                      aria-label={`Add photo for ${shot.label}`}
                      disabled={disabled || analyzing || photos.length >= photoCap || shotIsFull(photos, shot.key) || readingShots.includes(shot.key)}
                      onClick={() => { pendingShotRef.current = shot.key; fileRef.current?.click(); }}
                    >
                      Add
                    </Button>
                  </li>
                );
              })}
              {showGaugeReading && gaugeInSlots && (
                <li data-testid="lawn-length-row" className="flex items-center gap-2 rounded-[12px] border border-[#E5E5E5] bg-white px-3 py-2">
                  <div className="min-w-0 flex-1">
                    <div className="text-14 font-medium text-zinc-900">Lawn length</div>
                    <div className="text-14 leading-snug text-zinc-500">In inches, if you measured it.</div>
                  </div>
                  {gaugeInput}
                </li>
              )}
            </ul>
          )}
          {photos.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {photos.map((photo, index) => (
                <div key={`${photo.name}-${index}`} className="relative w-28">
                  <img
                    src={photo.preview}
                    alt=""
                    className="block h-20 w-28 rounded-[12px] border border-[#E5E5E5] object-cover"
                  />
                  <button
                    type="button"
                    onClick={() => setPhotos((prev) => prev.filter((_, i) => i !== index))}
                    aria-label="Remove assessment photo"
                    className="absolute -right-2 -top-2 flex h-8 w-8 items-center justify-center rounded-full border-0 bg-zinc-900 p-0 text-14 leading-none text-white"
                  >
                    x
                  </button>
                  {/* Optional slot label — all optional, no count requirement.
                      Only one photo may hold "front" at a time (setPhotoZone). */}
                  <Select
                    value={photo.zone || ""}
                    disabled={disabled || analyzing}
                    onChange={(e) => setPhotoZone(index, e.target.value || null)}
                    aria-label={`Slot for photo ${index + 1}`}
                    className={`mt-1 !pl-2 !pr-6 !text-14 ${FIELD}`}
                  >
                    <option value="">No slot</option>
                    {(shotList ? LAWN_SHOTS.map((shot) => ({ value: shot.key, label: shot.label })) : LAWN_PHOTO_ZONES).map((zone) => (
                      <option key={zone.value} value={zone.value}>{zone.label}</option>
                    ))}
                  </Select>
                </div>
              ))}
            </div>
          )}
          {/* A soft hint, never a requirement (owner 2026-10-02): the report's
              "since your last visit" score line needs 2+ usable photos on both
              visits (lawn-progress.js COMPARABLE_LEVELS), so a 1-photo visit
              can never show it. Analyze stays enabled at one photo. */}
          {shotList && !compact && shotListHint(photos) && (
            <div data-testid="lawn-shot-list-hint" className="text-14 leading-snug text-zinc-500">
              {shotListHint(photos)}
            </div>
          )}
          {!shotList && photos.length < 2 && (
            <div data-testid="lawn-photo-nudge" className="text-14 leading-snug text-zinc-500">
              2 or 3 photos work best: front, close-up and any trouble spot. With one photo, next visit&apos;s report can&apos;t show whether the lawn improved.
            </div>
          )}
          <Button
            className={PILL}
            onClick={analyze}
            disabled={disabled || photos.length === 0 || analyzing}
          >
            {analyzing ? "Analyzing..." : "Analyze lawn"}
          </Button>
        </>
      )}
      {hasResult && (
        <>
          <ul aria-label="Lawn scores" className="m-0 list-none divide-y divide-[#E5E5E5] rounded-[16px] border border-[#E5E5E5] bg-white p-0">
            {LAWN_ASSESSMENT_METRICS.map((metric) => {
              const value = lawnScores.lawnScoreValue(scoreSource?.[metric.key]);
              // The AI's own read, from result.aiScores (the run's immutable
              // snapshot, or the server's read for a legacy no-run row; see
              // resolveAiScores) — shown under a score the tech changed or
              // emptied, so the original stays in view.
              const aiValue = lawnScores.lawnScoreValue(result?.aiScores?.[metric.key]);
              const busy = disabled || confirming;
              return (
                <li key={metric.key} className="flex min-h-[56px] items-center justify-between gap-3 px-3 py-2">
                  <div className="min-w-0">
                    <div className="text-14 font-medium text-zinc-900">{metric.label}</div>
                    {!confirmed && aiValue != null && aiValue !== value && (
                      <div data-testid={`lawn-ai-score-${metric.key}`} className="text-14 text-zinc-500">AI {aiValue}</div>
                    )}
                  </div>
                  {confirmed ? (
                    <div className="text-16 font-medium text-zinc-900">
                      {value == null ? "—" : `${value}/100`}
                    </div>
                  ) : (
                    <div className="flex shrink-0 items-center gap-1">
                      <Button
                        variant="secondary"
                        aria-label={`Lower ${metric.label} score`}
                        disabled={busy}
                        className={`ui-icon-action !text-18 ${PILL_OUTLINE}`}
                        {...stepHandlers(metric.key, -1)}
                      >
                        {"\u2212"}
                      </Button>
                      <Input
                        type="number"
                        inputMode="numeric"
                        min={0}
                        max={100}
                        value={techScores?.[metric.key] ?? ""}
                        disabled={busy}
                        aria-label={`${metric.label} score`}
                        placeholder="0-100"
                        onChange={(e) => fillScore(metric.key, e.target.value)}
                        className={`!w-[72px] ${FIELD} text-center font-medium [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none`}
                      />
                      <Button
                        variant="secondary"
                        aria-label={`Raise ${metric.label} score`}
                        disabled={busy}
                        className={`ui-icon-action !text-18 ${PILL_OUTLINE}`}
                        {...stepHandlers(metric.key, 1)}
                      >
                        +
                      </Button>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
          {/* The evidence review (photo quality, observation, photo findings,
              technician details) is not shown while completing a visit (owner
              2026-10-04: the technician takes photos, the AI reads them, the
              report is built). Confirm still sends the default review, which
              keeps every finding, so the report and tip ranking are unchanged.
              The office can still edit a review on the Lawn assessment page. */}
          <div className="flex gap-2">
            {confirmed ? (
              <div className="flex min-h-[44px] flex-1 items-center justify-center gap-2 rounded-[12px] border border-[#E5E5E5] bg-[#F5F5F5] px-3 text-14 font-medium text-zinc-900">
                <span aria-hidden="true">{"\u2713"}</span>
                Assessment confirmed
              </div>
            ) : (
              <Button
                className={`flex-1 ${PILL}`}
                onClick={confirm}
                disabled={disabled || confirming}
              >
                {confirming ? "Confirming..." : "Confirm assessment"}
              </Button>
            )}
            <Button
              variant="secondary"
              className={PILL_OUTLINE}
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
            >
              Retake
            </Button>
          </div>
        </>
      )}
      {error && <div className="text-14 leading-normal text-alert-fg">{error}</div>}
    </UiSurface>
  );
}

// A declared function wrapped at export keeps the handler name the IB coverage census records.
export default forwardRef(LawnAssessmentCompletionBlock);
