import { useEffect, useRef, useState } from 'react';
import { completionDraftKey } from '../lib/completion-drafts';
import { getAdminUser } from '../lib/adminAuth';

export default function useServiceRecapDraft(serviceId, ready, snapshot) {
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
    if (baseline.current === null) { baseline.current = serialized; return; }
    if (candidate) return;
    try {
      if (serialized === baseline.current) localStorage.removeItem(key);
      else localStorage.setItem(key, JSON.stringify({ ...JSON.parse(serialized), serviceId, savedAt: Date.now() }));
      setSaved(serialized !== baseline.current);
      setStorageError('');
    } catch {
      setSaved(false);
      setStorageError('Draft could not be saved on this device. Keep this visit open until completion succeeds.');
    }
  }, [candidate, key, ready, serialized, serviceId]);

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

  return { candidate, saved, storageError, discard, finish, restored: () => setCandidate(null) };
}
