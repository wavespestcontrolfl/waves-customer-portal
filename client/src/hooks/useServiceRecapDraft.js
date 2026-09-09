import { useEffect, useRef, useState } from 'react';
import { completionDraftKey } from '../lib/completion-drafts';
import { getAdminUser } from '../lib/adminAuth';

export default function useServiceRecapDraft(serviceId, ready, snapshot, sourceIdentity) {
  const user = getAdminUser();
  const [key] = useState(() => completionDraftKey(serviceId, `recap_${user?.id || 'local'}_${user?.role || 'local'}`));
  const [storageError, setStorageError] = useState('');
  const [saved, setSaved] = useState(false);
  const [candidate, setCandidate] = useState(() => {
    try {
      const draft = JSON.parse(localStorage.getItem(key) || 'null');
      return draft?.serviceId === serviceId && Array.isArray(draft?.selectedProducts) ? draft : null;
    } catch { return null; }
  });
  const baseline = useRef(null);
  const complete = useRef(false);
  const serialized = JSON.stringify(snapshot);

  useEffect(() => {
    if (!ready || complete.current) return;
    if (baseline.current === null) { baseline.current = { serialized, sourceIdentity }; return; }
    if (candidate) return;
    try {
      if (serialized === baseline.current.serialized) localStorage.removeItem(key);
      else localStorage.setItem(key, JSON.stringify({ ...JSON.parse(serialized), serviceId, sourceIdentity: baseline.current.sourceIdentity, savedAt: Date.now() }));
      setSaved(serialized !== baseline.current.serialized);
      setStorageError('');
    } catch {
      setSaved(false);
      setStorageError('Draft could not be saved on this device. Keep this visit open until completion succeeds.');
    }
  }, [candidate, key, ready, serialized, serviceId, sourceIdentity]);

  useEffect(() => {
    if (!storageError || candidate || complete.current || serialized === baseline.current?.serialized) return undefined;
    const warn = (event) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [candidate, serialized, storageError]);

  const discard = () => {
    try { localStorage.removeItem(key); }
    catch {
      setStorageError('Could not remove the saved draft on this device.');
      return false;
    }
    setCandidate(null);
    setSaved(false);
    setStorageError('');
    return true;
  };

  const finish = () => {
    complete.current = true;
    discard();
  };

  const restoreError = candidate && (!ready || sourceIdentity === null || candidate.sourceIdentity !== sourceIdentity)
    ? 'Could not verify this draft against the current visit. Close and reopen to refresh, or discard the draft to use the current record.' : '';
  return { candidate, saved, storageError, restoreError, discard, finish, restored: () => setCandidate(null) };
}
