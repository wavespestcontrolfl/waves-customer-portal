/**
 * useIntelligenceBar — shared state + API for every Intelligence Bar surface.
 *
 * Options:
 *   context          — IB context string ('dashboard' | 'schedule' | ...) or undefined
 *                      (undefined → server defaults to customers context)
 *   buildPageData    — fn → object injected as pageData on each submit
 *   fallbackActions  — array of {id,label,prompt} when quick-actions API fails
 *   onAfterSubmit    — (data) => void, runs after every successful query
 */
import { useState, useEffect, useCallback, useRef } from 'react';
import {
  getRecents,
  addRecent,
  getFavorites,
  toggleFavorite as toggleFavoriteStorage,
} from '../utils/ibStorage';
import { filesToImageParts, MAX_ATTACHMENTS } from '../utils/ibImages';
import { createRequestIdentity, ibSessionId } from '../utils/ibSession';
import { retainTaskReceipt } from '../utils/ibTaskReceipts';

const API_BASE = import.meta.env.VITE_API_URL || '/api';

function adminFetch(path, options = {}) {
  return fetch(`${API_BASE}${path}`, {
    headers: {
      Authorization: `Bearer ${localStorage.getItem('waves_admin_token')}`,
      'Content-Type': 'application/json',
    },
    ...options,
  }).then(async (r) => {
    if (!r.ok) {
      const body = await r.json().catch(() => ({}));
      const error = new Error(body.message || body.error || `HTTP ${r.status}`);
      error.status = r.status;
      throw error;
    }
    return r.json();
  });
}

export function useIntelligenceBar({
  context,
  buildPageData,
  fallbackActions,
  onAfterSubmit,
  getRequestKey,
} = {}) {
  const [prompt, setPrompt] = useState('');
  const [loading, setLoading] = useState(false);
  const [response, setResponse] = useState(null);
  const [structuredData, setStructuredData] = useState(null);
  // Pending write proposals (issue #1568). The ids inside are confirmation
  // credentials — keep them here only; never copy into conversationHistory.
  const [pendingActions, setPendingActions] = useState([]);
  const [activeTask, setActiveTask] = useState(null);
  const [savedTasks, setSavedTasks] = useState([]);
  const [tasksAvailable, setTasksAvailable] = useState(false);
  const [taskHistoryError, setTaskHistoryError] = useState(null);
  const [conversationHistory, setConversationHistory] = useState([]);
  const [quickActions, setQuickActions] = useState([]);
  const [expanded, setExpanded] = useState(false);
  const [recentPrompts, setRecentPrompts] = useState(() => getRecents(context));
  const [favorites, setFavorites] = useState(() => getFavorites(context));
  // Attached photos for the next query (vision). Each: {mediaType,data,name,previewUrl}.
  const [attachments, setAttachments] = useState([]);
  const [attachmentsLoading, setAttachmentsLoading] = useState(false);
  const attachmentConversionRef = useRef(0);
  const attachmentsLoadingRef = useRef(false);
  const epochRef = useRef(0);
  const taskHistoryEpochRef = useRef(0);
  const submittingRef = useRef(false);
  const sessionIdRef = useRef(null);
  if (!sessionIdRef.current) sessionIdRef.current = ibSessionId();
  const identityRef = useRef(null);
  if (!identityRef.current) identityRef.current = createRequestIdentity(sessionIdRef.current);

  const buildPageDataRef = useRef(buildPageData);
  const onAfterSubmitRef = useRef(onAfterSubmit);
  const getRequestKeyRef = useRef(getRequestKey);
  useEffect(() => { buildPageDataRef.current = buildPageData; }, [buildPageData]);
  useEffect(() => { onAfterSubmitRef.current = onAfterSubmit; }, [onAfterSubmit]);
  useEffect(() => { getRequestKeyRef.current = getRequestKey; }, [getRequestKey]);
  useEffect(() => () => { epochRef.current += 1; }, []);

  const loadTasks = useCallback(async () => {
    const epoch = ++taskHistoryEpochRef.current;
    if (context === 'agent_estimate' || context === 'tech') {
      setTasksAvailable(false); setSavedTasks([]); setTaskHistoryError(null);
      return;
    }
    try {
      const data = await adminFetch(`/admin/intelligence-bar/tasks?session_id=${encodeURIComponent(sessionIdRef.current)}`);
      if (epoch !== taskHistoryEpochRef.current) return;
      setTasksAvailable(true);
      setSavedTasks(data.tasks || []);
      setTaskHistoryError(null);
    } catch (error) {
      if (epoch !== taskHistoryEpochRef.current) return;
      if (error.status === 404) { setTasksAvailable(false); setTaskHistoryError(null); }
      else setTaskHistoryError('Saved requests are temporarily unavailable.');
    }
  }, [context]);
  useEffect(() => {
    void loadTasks();
    return () => { taskHistoryEpochRef.current += 1; };
  }, [loadTasks]);

  const applyResponse = useCallback((data) => {
    setResponse(data.response || null);
    setStructuredData(data.structuredData || null);
    setPendingActions(data.pendingActions || []);
    setActiveTask(data.taskId ? data : null);
    setConversationHistory(data.conversationHistory || []);
    if (data.taskId) setTasksAvailable(true);
  }, []);

  const refreshTask = useCallback(async (id = activeTask?.taskId, operation = null, candidate = null) => {
    if (!id || submittingRef.current) return;
    const epoch = ++epochRef.current;
    const requestKey = getRequestKeyRef.current?.();
    const isStale = () => epoch !== epochRef.current || (getRequestKeyRef.current && requestKey !== getRequestKeyRef.current());
    submittingRef.current = true;
    setLoading(true);
    setExpanded(true);
    try {
      const data = await adminFetch(operation ? `/admin/intelligence-bar/tasks/${encodeURIComponent(id)}/${operation}`
        : `/admin/intelligence-bar/tasks/${encodeURIComponent(id)}?session_id=${encodeURIComponent(sessionIdRef.current)}`,
      operation ? { method: 'POST', body: JSON.stringify({ session_id: sessionIdRef.current,
        ...(candidate ? { customer_id: candidate.customer_id } : {}) }) } : {});
      if (!isStale()) applyResponse(data);
    } catch (error) {
      if (!isStale()) setResponse(`Status unavailable: ${error.message}`);
    } finally {
      if (epoch === epochRef.current) { submittingRef.current = false; setLoading(false); }
    }
  }, [activeTask?.taskId, applyResponse]);

  const actionEpoch = epochRef.current;
  const onActionResolved = useCallback((action, decision, body) => {
    if (actionEpoch !== epochRef.current) return;
    setPendingActions(previous => previous.map(item => item.id === action.id ? { ...item, receipt: body,
      resolvedStatus: decision === 'cancel' && (body.cancelled || body.outcome === 'canceled') ? 'cancelled' : undefined } : item));
    setActiveTask(task => retainTaskReceipt(task, action, decision, body));
    if (decision === 'confirm' && body?.success) onAfterSubmitRef.current?.({
      toolCalls: [{ name: action.tool }], confirmedAction: true, result: body.result,
    });
    if (activeTask) void refreshTask(activeTask.taskId);
  }, [actionEpoch, activeTask, refreshTask]);

  useEffect(() => {
    setRecentPrompts(getRecents(context));
    setFavorites(getFavorites(context));
  }, [context]);

  useEffect(() => {
    const qs = context ? `?context=${context}` : '';
    adminFetch(`/admin/intelligence-bar/quick-actions${qs}`)
      .then((d) => setQuickActions(d.actions || []))
      .catch(() => setQuickActions(fallbackActions || []));
  }, [context, fallbackActions]);

  const toggleFavorite = useCallback((text) => {
    if (!text) return;
    const next = toggleFavoriteStorage(context, text);
    setFavorites(next);
  }, [context]);

  const setAttachmentBusy = useCallback((busy) => {
    attachmentsLoadingRef.current = busy;
    setAttachmentsLoading(busy);
  }, []);

  const resetAttachments = useCallback(() => {
    attachmentConversionRef.current += 1;
    setAttachments([]);
    setAttachmentBusy(false);
  }, [setAttachmentBusy]);

  const addAttachments = useCallback(async (files) => {
    const conversionId = attachmentConversionRef.current + 1;
    attachmentConversionRef.current = conversionId;
    setAttachmentBusy(true);
    try {
      const parts = await filesToImageParts(files, attachments.length);
      if (attachmentConversionRef.current === conversionId && parts.length) {
        setAttachments((prev) => [...prev, ...parts].slice(0, MAX_ATTACHMENTS));
      }
    } finally {
      if (attachmentConversionRef.current === conversionId) {
        setAttachmentBusy(false);
      }
    }
  }, [attachments.length, setAttachmentBusy]);

  const removeAttachment = useCallback((index) => {
    setAttachments((prev) => prev.filter((_, i) => i !== index));
  }, []);

  const submit = useCallback(async (text) => {
    const q = (text ?? prompt).trim();
    if (!q || loading || submittingRef.current || attachmentsLoadingRef.current) return;
    submittingRef.current = true;
    const epoch = ++epochRef.current;

    setLoading(true);
    setExpanded(true);
    setResponse(null);
    setStructuredData(null);
    setPendingActions([]);
    setActiveTask(null);
    const requestKey = getRequestKeyRef.current?.();

    setRecentPrompts(addRecent(context, q));

    const body = { prompt: q, conversationHistory };
    if (context) body.context = context;
    if (attachments.length) {
      body.images = attachments.map(({ mediaType, data }) => ({ mediaType, data }));
    }
    if (buildPageDataRef.current) {
      const pd = buildPageDataRef.current();
      if (pd) body.pageData = pd;
    }

    // Stale settle (the surface's request key moved on — e.g. a lead switch
    // mid-flight): drop the result AND the shared cleanup. Clearing the prompt
    // or attachments here would clobber the new key's freshly primed state;
    // the surface's own switch handler (clear()) already reset them. Only the
    // loading flag is released — no new submit can start while it is held.
    const isStale = () => epoch !== epochRef.current || (getRequestKeyRef.current && requestKey !== getRequestKeyRef.current());

    // The request key outlives a dropped response: the same request
    // resubmitted replays the saved task instead of running it again.
    const identity = identityRef.current.begin(JSON.stringify(body));
    Object.assign(body, identity);
    let answered = false;
    try {
      const data = await adminFetch('/admin/intelligence-bar/query', {
        method: 'POST',
        body: JSON.stringify(body),
      });
      identityRef.current.settle(identity);
      answered = true;

      if (isStale()) {
        if (epoch === epochRef.current) { submittingRef.current = false; setLoading(false); }
        return;
      }

      applyResponse(data);

      if (onAfterSubmitRef.current) onAfterSubmitRef.current(data);
    } catch (err) {
      // A definitive HTTP failure was answered; only a dropped response keeps the key.
      if (err?.status) {
        identityRef.current.settle(identity);
        answered = true;
      }
      if (isStale()) {
        if (epoch === epochRef.current) { submittingRef.current = false; setLoading(false); }
        return;
      }
      setResponse(`Error: ${err.message}`);
    }

    submittingRef.current = false;
    setLoading(false);
    // A failed request keeps its prompt and attachments so a retry is the
    // same request; only an answered one clears the composer.
    if (answered) {
      setPrompt('');
      resetAttachments();
    }
  }, [prompt, loading, conversationHistory, context, attachments, resetAttachments, applyResponse]);

  const clear = useCallback(() => {
    epochRef.current += 1;
    submittingRef.current = false;
    setLoading(false);
    setConversationHistory([]);
    setResponse(null);
    setStructuredData(null);
    setPendingActions([]);
    setActiveTask(null);
    resetAttachments();
    setExpanded(false);
  }, [resetAttachments]);

  const handleKeyDown = useCallback((e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); }
    if (e.key === 'Escape') { setExpanded(false); setPrompt(''); }
  }, [submit]);

  return {
    prompt, setPrompt,
    loading,
    response,
    structuredData,
    pendingActions,
    activeTask,
    savedTasks,
    tasksAvailable,
    taskHistoryError,
    loadTasks,
    refreshTask,
    onActionResolved,
    conversationHistory,
    quickActions,
    expanded, setExpanded,
    recentPrompts,
    favorites,
    toggleFavorite,
    attachments,
    attachmentsLoading,
    addAttachments,
    removeAttachment,
    submit,
    clear,
    handleKeyDown,
  };
}
