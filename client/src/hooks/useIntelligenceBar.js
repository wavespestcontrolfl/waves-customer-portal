/**
 * useIntelligenceBar — shared state + API for every Intelligence Bar surface.
 *
 * Options:
 *   context          — IB context string ('dashboard' | 'schedule' | ...) or undefined
 *                      (undefined → server defaults to customers context)
 *   buildPageData    — fn → object injected as pageData on each submit
 *   fallbackActions  — array of {id,label,prompt} when quick-actions API fails
 *   onAfterSubmit    — (data) => void, runs after every successful query
 *   recentsEnabled   — whether to track last-5 recent prompts (session-scoped)
 */
import { useState, useEffect, useCallback, useRef } from 'react';

const API_BASE = import.meta.env.VITE_API_URL || '/api';

function adminFetch(path, options = {}) {
  return fetch(`${API_BASE}${path}`, {
    headers: {
      Authorization: `Bearer ${localStorage.getItem('waves_admin_token')}`,
      'Content-Type': 'application/json',
    },
    ...options,
  }).then((r) => {
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  });
}

export function useIntelligenceBar({
  context,
  buildPageData,
  fallbackActions,
  onAfterSubmit,
  recentsEnabled = false,
} = {}) {
  const [prompt, setPrompt] = useState('');
  const [loading, setLoading] = useState(false);
  const [response, setResponse] = useState(null);
  const [structuredData, setStructuredData] = useState(null);
  const [conversationHistory, setConversationHistory] = useState([]);
  const [quickActions, setQuickActions] = useState([]);
  const [expanded, setExpanded] = useState(false);
  const [recentPrompts, setRecentPrompts] = useState([]);

  const buildPageDataRef = useRef(buildPageData);
  const onAfterSubmitRef = useRef(onAfterSubmit);
  useEffect(() => { buildPageDataRef.current = buildPageData; }, [buildPageData]);
  useEffect(() => { onAfterSubmitRef.current = onAfterSubmit; }, [onAfterSubmit]);

  useEffect(() => {
    const qs = context ? `?context=${context}` : '';
    adminFetch(`/admin/intelligence-bar/quick-actions${qs}`)
      .then((d) => setQuickActions(d.actions || []))
      .catch(() => setQuickActions(fallbackActions || []));
  }, [context, fallbackActions]);

  const submit = useCallback(async (text) => {
    const q = (text ?? prompt).trim();
    if (!q || loading) return;

    setLoading(true);
    setExpanded(true);
    setResponse(null);
    setStructuredData(null);

    if (recentsEnabled) {
      setRecentPrompts((prev) => {
        const filtered = prev.filter((p) => p !== q);
        return [q, ...filtered].slice(0, 5);
      });
    }

    const body = { prompt: q, conversationHistory };
    if (context) body.context = context;
    if (buildPageDataRef.current) {
      const pd = buildPageDataRef.current();
      if (pd) body.pageData = pd;
    }

    try {
      const data = await adminFetch('/admin/intelligence-bar/query', {
        method: 'POST',
        body: JSON.stringify(body),
      });

      setResponse(data.response);
      setStructuredData(data.structuredData);
      setConversationHistory(data.conversationHistory || []);

      if (onAfterSubmitRef.current) onAfterSubmitRef.current(data);
    } catch (err) {
      setResponse(`Error: ${err.message}`);
    }

    setLoading(false);
    setPrompt('');
  }, [prompt, loading, conversationHistory, context, recentsEnabled]);

  const clear = useCallback(() => {
    setConversationHistory([]);
    setResponse(null);
    setStructuredData(null);
    setExpanded(false);
  }, []);

  const handleKeyDown = useCallback((e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); }
    if (e.key === 'Escape') { setExpanded(false); setPrompt(''); }
  }, [submit]);

  return {
    prompt, setPrompt,
    loading,
    response,
    structuredData,
    conversationHistory,
    quickActions,
    expanded, setExpanded,
    recentPrompts,
    submit,
    clear,
    handleKeyDown,
  };
}
