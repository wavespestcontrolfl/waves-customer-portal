// Loads the layout saved for an estimate, once, when the misting layout designer opens.
// { status: 'ready', saved: null } at once when there is no estimate id (an unsaved estimate has no layout).
// A failed read is an error, not "no layout": the designer then does not start blank and let a save
// overwrite a layout it could not read.
import { useEffect, useState } from 'react';
import { fetchSavedLayout } from '../../../lib/mistingLayoutPersist';

export default function useSavedMistingLayout(estimateId) {
  const [state, setState] = useState(estimateId ? { status: 'loading' } : { status: 'ready', saved: null });
  useEffect(() => {
    if (!estimateId) {
      setState({ status: 'ready', saved: null });
      return undefined;
    }
    let cancelled = false;
    setState({ status: 'loading' });
    fetchSavedLayout(estimateId)
      .then((saved) => { if (!cancelled) setState({ status: 'ready', saved }); })
      .catch((err) => {
        if (!cancelled) setState({ status: 'error', message: err?.message || 'The saved layout could not be loaded.' });
      });
    return () => { cancelled = true; };
  }, [estimateId]);
  return state;
}
