import { useState, useEffect, useRef } from 'react';

// During-visit recap clip capture for the tech portal ("Your Visit, in Motion", P4b).
// Native camera -> tag the action -> presigned PUT to S3 -> lands in the customer's
// recap. All optional; rendered only on the active (on_site) PEST job behind the
// pest-recap-v1 flag. Mirrors the admin closeout RecapCapture but uses the tech
// bearer-token `request` helper + the tech dark palette.
const C = {
  bg: '#0f1923', card: '#1e293b', border: '#334155', teal: '#0ea5e9',
  text: '#e2e8f0', muted: '#94a3b8', red: '#ef4444', green: '#22c55e',
};

// role keys must match server ROLE_MAP (recap-media.js).
const CHIPS_TOP = [
  { role: 'perimeter', label: 'Spray — perimeter' },
  { role: 'eaves', label: 'Spray — eaves/soffits' },
  { role: 'entry', label: 'Spray — entry points' },
  { role: 'deweb', label: 'De-web — eaves/corners' },
  { role: 'sweep', label: 'Sweep — lanai/pool cage' },
  { role: 'bait', label: 'Bait placement' },
  { role: 'granule', label: 'Granule spread' },
  { role: 'pest', label: 'Live pest (found)' },
];
const CHIPS_MORE = [
  { role: 'inside', label: 'Spray — inside' },
  { role: 'foundation', label: 'Spray — foundation/weep holes' },
  { role: 'garage', label: 'Spray — garage' },
  { role: 'shrubs', label: 'Spray — shrubs/beds' },
  { role: 'dust', label: 'Dust — crack & crevice' },
  { role: 'wasp', label: 'Wasp nest removal' },
  { role: 'acpad', label: 'Treat AC pad' },
  { role: 'before', label: 'Before' },
  { role: 'after', label: 'After' },
];
const ROLE_LABELS = new Map([...CHIPS_TOP, ...CHIPS_MORE].map(({ role, label }) => [role, label]));
const TERMINAL_CONFIRM_STATUSES = new Set([413, 422]);

function readVideoDurationMs(file) {
  return new Promise((resolve) => {
    try {
      const url = URL.createObjectURL(file);
      const v = document.createElement('video');
      v.preload = 'metadata';
      v.onloadedmetadata = () => { URL.revokeObjectURL(url); resolve(Number.isFinite(v.duration) ? Math.round(v.duration * 1000) : null); };
      v.onerror = () => { URL.revokeObjectURL(url); resolve(null); };
      v.src = url;
    } catch { resolve(null); }
  });
}

async function reconcileConfirmDraft(draft, request) {
  const media = await request(`/tech/services/${draft.serviceId}/recap-media`);
  if (!Array.isArray(media?.items)) throw new Error('Couldn’t verify the pending upload — try again.');
  const existing = media.items.find((item) => item.id === draft.mediaId);
  if (existing?.status === 'ready') return { draft, readyItems: media.items };
  if (!existing) {
    return { draft: { ...draft, mediaId: null, uploadUrl: null, uploaded: false, needsReconcile: false }, readyItems: null };
  }
  return { draft: { ...draft, needsReconcile: false }, readyItems: null };
}

async function deleteKnownDraft(draft, request) {
  try {
    await request(`/tech/services/${draft.serviceId}/recap-media/${draft.mediaId}`, { method: 'DELETE' });
  } catch (error) {
    if (error?.status !== 404) throw error;
  }
}

async function recoverUploadFailure(error, draft, request) {
  let retainedDraft = draft;
  let message = error?.message || 'Couldn’t add that clip — try again or discard it.';
  if (error?.status === 403 && !error.cleanupFailed && !draft.uploaded && draft.mediaId) {
    try {
      // S3 answers 403 when a presign is no longer usable. Remove its known
      // uploading row before allowing Retry to mint a replacement row/key.
      await deleteKnownDraft(draft, request);
      retainedDraft = { ...draft, mediaId: null, uploadUrl: null, cleanupBeforeRetry: false };
      message = 'Upload link expired — retry to request a new link.';
    } catch {
      // Keep the rejected presign until cleanup succeeds. This prevents a
      // fresh presign from leaving the known pending row orphaned.
      retainedDraft = { ...draft, cleanupBeforeRetry: true };
      message = 'Upload link expired, but cleanup failed. Retry to clean it up and request a new link.';
    }
  }
  if (draft.needsReconcile && TERMINAL_CONFIRM_STATUSES.has(error?.status)) {
    retainedDraft = { ...draft, retryable: false };
  }
  if (draft.presignAttempted && !draft.mediaId && error?.status === 400) {
    retainedDraft = { ...draft, retryable: false };
  }
  return { retainedDraft, message };
}

function discardButtonLabel(draft) {
  if (draft.discardPending) return 'Discarding…';
  return draft.discardRequested ? 'Retry discard' : 'Discard';
}

function rememberFailedDraft(map, serviceId, draft, message) {
  map.delete(serviceId);
  map.set(serviceId, { draft, message });
}

function forgetFailedDraft(map, serviceId, attemptId) {
  const retained = map.get(serviceId);
  if (!retained || attemptId === undefined || retained.draft.attemptId === attemptId) map.delete(serviceId);
}

export default function TechRecapCapture({ service, request }) {
  const serviceId = service?.id;
  const [itemState, setItemState] = useState({ serviceId: null, items: [] });
  const [pendingFile, setPendingFile] = useState(null);
  const [failedUpload, setFailedUpload] = useState(null);
  const [showMore, setShowMore] = useState(false);
  const [uploading, setUploading] = useState(0);
  const [err, setErr] = useState(null);
  const fileRef = useRef(null);
  const serviceIdRef = useRef(serviceId);
  const serviceGenerationRef = useRef(0);
  const mountedRef = useRef(false);
  const uploadAttemptRef = useRef(0);
  const latestUploadByServiceRef = useRef(new Map());
  const failedDraftsRef = useRef(new Map());
  serviceIdRef.current = serviceId;

  const isCurrentService = (targetServiceId, generation) => (
    serviceIdRef.current === targetServiceId && serviceGenerationRef.current === generation
  );

  const refresh = async (targetServiceId = serviceId, generation = serviceGenerationRef.current) => {
    try {
      const data = await request(`/tech/services/${targetServiceId}/recap-media`);
      if (isCurrentService(targetServiceId, generation)) {
        setItemState({ serviceId: targetServiceId, items: data?.items || [] });
      }
    } catch { /* keep the last confirmed list for this visit */ }
  };

  useEffect(() => {
    serviceIdRef.current = serviceId;
    const generation = serviceGenerationRef.current + 1;
    serviceGenerationRef.current = generation;
    const retained = failedDraftsRef.current.get(serviceId);
    setPendingFile(null);
    setFailedUpload(retained?.draft || null);
    setShowMore(false);
    setUploading(0);
    setErr(retained?.message || null);
    if (serviceId) refresh(serviceId, generation);
    return () => {
      serviceIdRef.current = null;
      if (serviceGenerationRef.current === generation) serviceGenerationRef.current += 1;
    };
  }, [serviceId]); // eslint: react-hooks plugin is not configured in this repo;

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const onPick = (e) => {
    const file = e.target.files && e.target.files[0];
    if (fileRef.current) fileRef.current.value = '';
    if (file && serviceId) { setPendingFile({ file, serviceId }); setShowMore(false); }
  };

  const upload = async (uploadDraft) => {
    let draft = uploadDraft;
    const targetServiceId = draft.serviceId;
    const generation = serviceGenerationRef.current;
    if (!isCurrentService(targetServiceId, generation)) return;
    const attemptId = uploadAttemptRef.current + 1;
    uploadAttemptRef.current = attemptId;
    latestUploadByServiceRef.current.set(targetServiceId, attemptId);
    forgetFailedDraft(failedDraftsRef.current, targetServiceId);
    draft = { ...draft, attemptId };
    const canRetainAttempt = () => mountedRef.current
      && latestUploadByServiceRef.current.get(targetServiceId) === attemptId;
    const canApplyAttempt = () => canRetainAttempt() && serviceIdRef.current === targetServiceId;
    setPendingFile(null);
    setFailedUpload(null);
    setShowMore(false);
    setUploading((n) => n + 1);
    setErr(null);
    try {
      if (draft.durationMs === undefined) {
        const durationMs = draft.mediaType === 'video' ? await readVideoDurationMs(draft.file) : null;
        draft = { ...draft, durationMs };
      }

      if (draft.cleanupBeforeRetry && draft.mediaId) {
        try {
          await deleteKnownDraft(draft, request);
        } catch (cleanupError) {
          cleanupError.cleanupFailed = true;
          cleanupError.message = 'Upload link expired, but cleanup failed. Retry to clean it up and request a new link.';
          throw cleanupError;
        }
        draft = { ...draft, mediaId: null, uploadUrl: null, uploaded: false, cleanupBeforeRetry: false };
      }

      if (draft.needsReconcile && draft.mediaId) {
        const reconciled = await reconcileConfirmDraft(draft, request);
        draft = reconciled.draft;
        if (reconciled.readyItems) {
          if (isCurrentService(targetServiceId, generation)) {
            setItemState({ serviceId: targetServiceId, items: reconciled.readyItems });
          }
          return;
        }
      }

      if (!draft.mediaId || !draft.uploadUrl) {
        draft = { ...draft, presignAttempted: true };
        const presigned = await request(`/tech/services/${targetServiceId}/recap-media/presign`, {
          method: 'POST',
          body: JSON.stringify({ role: draft.role, mediaType: draft.mediaType, contentType: draft.contentType }),
        });
        draft = { ...draft, mediaId: presigned.mediaId, uploadUrl: presigned.uploadUrl };
      }

      if (!draft.uploaded) {
        const put = await fetch(draft.uploadUrl, { method: 'PUT', headers: { 'Content-Type': draft.contentType }, body: draft.file });
        if (!put.ok) {
          const putError = new Error(`upload failed (${put.status})`);
          putError.status = put.status;
          throw putError;
        }
        draft = { ...draft, uploaded: true };
      }

      // Once PUT starts, finish confirmation against the captured original
      // service even if the tech navigates away. The generation guard below
      // still suppresses every stale UI update in the newly selected visit.
      draft = { ...draft, needsReconcile: true };
      await request(`/tech/services/${targetServiceId}/recap-media/${draft.mediaId}/confirm`, {
        method: 'POST', body: JSON.stringify({ durationMs: draft.durationMs }),
      });
      if (serviceIdRef.current === targetServiceId) {
        await refresh(targetServiceId, serviceGenerationRef.current);
      }
    } catch (e) {
      const { retainedDraft, message } = await recoverUploadFailure(e, draft, request);
      if (canRetainAttempt()) {
        rememberFailedDraft(failedDraftsRef.current, targetServiceId, retainedDraft, message);
      }
      if (canApplyAttempt()) {
        // Keep the in-memory File, role, and any completed upload stages so Retry
        // can resume without asking the tech to capture or tag the clip again.
        setFailedUpload(retainedDraft);
        setErr(message);
      }
    } finally {
      if (isCurrentService(targetServiceId, generation)) {
        setUploading((n) => Math.max(0, n - 1));
      }
    }
  };

  const tag = (role) => {
    const file = pendingFile?.file;
    const targetServiceId = pendingFile?.serviceId;
    if (!file || !targetServiceId || targetServiceId !== serviceId) return;
    const mediaType = file.type.startsWith('image/') ? 'image' : 'video';
    const contentType = file.type || (mediaType === 'image' ? 'image/jpeg' : 'video/mp4');
    upload({ file, role, serviceId: targetServiceId, mediaType, contentType, durationMs: undefined, mediaId: null, uploadUrl: null, uploaded: false, needsReconcile: false, retryable: true, cleanupBeforeRetry: false, presignAttempted: false });
  };

  const discardFailedUpload = async () => {
    const discarded = failedUpload;
    if (!discarded) return;
    if (!discarded.mediaId) {
      forgetFailedDraft(failedDraftsRef.current, discarded.serviceId, discarded.attemptId);
      setFailedUpload(null);
      setErr(null);
      return;
    }
    const cleanupDraft = { ...discarded, retryable: false, discardRequested: true, discardPending: true };
    rememberFailedDraft(failedDraftsRef.current, discarded.serviceId, cleanupDraft, err);
    setFailedUpload(cleanupDraft);
    try {
      await deleteKnownDraft(discarded, request);
      const latest = latestUploadByServiceRef.current.get(discarded.serviceId) === discarded.attemptId;
      if (latest) forgetFailedDraft(failedDraftsRef.current, discarded.serviceId, discarded.attemptId);
      if (latest && mountedRef.current && serviceIdRef.current === discarded.serviceId) {
        setFailedUpload(null);
        setErr(null);
      }
    } catch {
      const latest = latestUploadByServiceRef.current.get(discarded.serviceId) === discarded.attemptId;
      const failedCleanup = { ...cleanupDraft, discardPending: false };
      const message = 'Couldn’t discard this clip from the visit. Retry discard.';
      if (latest && mountedRef.current) rememberFailedDraft(failedDraftsRef.current, discarded.serviceId, failedCleanup, message);
      if (latest && mountedRef.current && serviceIdRef.current === discarded.serviceId) {
        setFailedUpload(failedCleanup);
        setErr(message);
      }
    }
  };

  const remove = async (id) => {
    try { await request(`/tech/services/${serviceId}/recap-media/${id}`, { method: 'DELETE' }); await refresh(); } catch { /* ignore */ }
  };

  if (!serviceId) return null;

  const items = itemState.serviceId === serviceId ? itemState.items : [];
  const visiblePendingFile = pendingFile?.serviceId === serviceId ? pendingFile.file : null;
  const captureDisabled = Boolean(uploading) + Boolean(failedUpload) > 0;
  const chip = { display: 'flex', alignItems: 'center', gap: 7, padding: '12px 10px', borderRadius: 11, background: C.bg, border: `1px solid ${C.border}`, color: C.text, fontSize: 12.5, fontWeight: 700, cursor: 'pointer', textAlign: 'left' };

  return (
    <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 12, padding: 14, marginTop: 10 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 700, fontSize: 14, color: C.text }}>
          <span style={{ width: 8, height: 8, borderRadius: '50%', background: C.teal }} /> Recap clips
        </span>
        <span style={{ fontSize: 12, color: C.muted }}>{items.length ? `${items.length} captured` : 'optional'}</span>
      </div>
      <div style={{ fontSize: 12.5, color: C.muted, margin: '6px 0 10px', lineHeight: 1.45 }}>
        Grab a few 5-sec clips while you work — live pests, spraying, the lanai sweep. They play in the customer’s recap. Skip it and the recap still generates.
      </div>

      <input ref={fileRef} type="file" accept="video/*,image/*" capture="environment" onChange={onPick} style={{ display: 'none' }} />

      {items.length > 0 && (
        <div style={{ display: 'grid', gap: 8, marginBottom: 10 }}>
          {items.map((m) => (
            <div key={m.id} style={{ display: 'flex', alignItems: 'center', gap: 10, background: C.bg, border: `1px solid ${C.border}`, borderRadius: 10, padding: 8 }}>
              <div style={{ width: 38, height: 38, borderRadius: 7, background: 'linear-gradient(135deg,#0ea5e9,#0b1220)', flexShrink: 0 }} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 12.5, fontWeight: 700, color: C.text, textTransform: 'capitalize' }}>{m.role}</div>
                <div style={{ fontSize: 11.5, color: C.teal }}>“{m.caption}”</div>
              </div>
              <span style={{ fontSize: 10.5, color: m.status === 'ready' ? C.green : C.muted, fontWeight: 700 }}>{m.status === 'ready' ? 'Uploaded' : m.status}</span>
              <button onClick={() => remove(m.id)} style={{ background: 'none', border: 'none', color: C.muted, fontSize: 18, cursor: 'pointer' }}>×</button>
            </div>
          ))}
        </div>
      )}

      {err && (
        <div role="alert" style={{ color: C.red, margin: '0 0 10px', lineHeight: 1.4 }}>
          <div style={{ fontSize: 14 }}>{err}</div>
          {failedUpload && (
            <>
              <div style={{ fontSize: 14, color: C.muted, marginTop: 4, overflowWrap: 'anywhere' }}>
                {failedUpload.file.name} · {ROLE_LABELS.get(failedUpload.role)}
              </div>
              <div style={{ display: 'flex', gap: 8, marginTop: 9 }}>
                {failedUpload.retryable && <button type="button" onClick={() => upload(failedUpload)} style={{ flex: 1, minHeight: 44, padding: 10, borderRadius: 9, border: 'none', background: C.teal, color: '#04240f', fontWeight: 800, fontSize: 14, cursor: 'pointer' }}>Retry upload</button>}
                <button type="button" disabled={failedUpload.discardPending} onClick={discardFailedUpload} style={{ flex: 1, minHeight: 44, padding: 10, borderRadius: 9, border: `1px solid ${C.border}`, background: 'none', color: C.text, fontWeight: 700, fontSize: 14, cursor: 'pointer' }}>{discardButtonLabel(failedUpload)}</button>
              </div>
            </>
          )}
        </div>
      )}
      <button type="button" disabled={captureDisabled} onClick={() => fileRef.current && fileRef.current.click()} style={{ width: '100%', padding: 12, borderRadius: 10, border: 'none', background: C.teal, color: '#04240f', fontWeight: 800, fontSize: 14, cursor: captureDisabled ? 'default' : 'pointer', opacity: captureDisabled ? 0.65 : 1 }}>
        {uploading ? `Uploading… (${uploading})` : failedUpload ? 'Resolve pending clip' : '+ Capture recap clip'}
      </button>

      {/* zIndex 1000 like the other tech sheets: the bottom nav is fixed at 50 and later in the DOM, so at 50 it painted over the sheet's last rows. */}
      {visiblePendingFile && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(5,8,13,.7)', zIndex: 1000, display: 'flex', alignItems: 'flex-end' }} onClick={() => setPendingFile(null)}>
          <div onClick={(e) => e.stopPropagation()} style={{ width: '100%', background: C.card, borderRadius: '18px 18px 0 0', border: `1px solid ${C.border}`, boxSizing: 'border-box', padding: '16px 14px calc(22px + env(safe-area-inset-bottom, 0px))', maxHeight: '82%', overflowY: 'auto' }}>
            <div style={{ width: 40, height: 4, background: C.border, borderRadius: 3, margin: '0 auto 12px' }} />
            <div style={{ fontWeight: 800, fontSize: 16, color: C.text, textAlign: 'center' }}>What were you doing?</div>
            <div style={{ fontSize: 12, color: C.muted, textAlign: 'center', margin: '4px 0 12px' }}>One tap. We caption it for the customer.</div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
              {(showMore ? [...CHIPS_TOP, ...CHIPS_MORE] : CHIPS_TOP).map((c) => (
                <button type="button" key={c.role} onClick={() => tag(c.role)} style={chip}><span style={{ width: 9, height: 9, borderRadius: '50%', background: C.teal, flexShrink: 0 }} />{c.label}</button>
              ))}
            </div>
            {!showMore && <button type="button" onClick={() => setShowMore(true)} style={{ marginTop: 9, width: '100%', padding: 10, borderRadius: 9, background: 'none', border: `1px solid ${C.border}`, color: C.muted, fontSize: 12.5, cursor: 'pointer' }}>More actions…</button>}
          </div>
        </div>
      )}
    </div>
  );
}
