import { useState, useEffect, useCallback, useRef } from "react";
import { etDateString } from "../../lib/timezone";
import { ChevronLeft, ChevronRight, X } from "lucide-react";
import { ActionFeedback, Badge, Button, Card, Checkbox, Dialog, DialogBody, DialogFooter, DialogHeader, DialogTitle, Field, Input, Select, UiSurface } from "../../components/ui";
const API_BASE = import.meta.env.VITE_API_URL || "/api";
function adminFetch(path, options = {}) {
  return fetch(`${API_BASE}${path}`, {
    headers: {
      Authorization: `Bearer ${localStorage.getItem("waves_admin_token")}`,
      "Content-Type": "application/json",
    },
    ...options,
  }).then(async r => {
    if (r.ok) return r.json();
    const body = await Promise.resolve().then(() => r.json()).catch(() => ({}));
    throw new Error(body?.error || `HTTP ${r.status}`);
  });
}
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const TYPE_LABELS = { blog: "Blog", social: "Social", rss: "RSS Auto" };
// A scheduled blog opens its preview PR at the set time and goes live after
// an admin approves it, so its publish_status reads as these steps (BLOG-02).
const BLOG_STATUS_LABELS = {
  pending: "Scheduled",
  publishing: "Opening preview",
  pending_review: "Awaiting approval",
  published: "Published",
  failed: "Failed",
};
const statusLabel = item => (item.type === "blog" && BLOG_STATUS_LABELS[item.status]) || item.status;
// The scheduled run skips drafts with a PR, a failed publish or no body, so
// the picker offers only drafts it can publish (BLOG-03).
const schedulableDraft = post => Boolean(post.content) && !post.astro_pr_number && !post.astro_branch_name && (!post.astro_status || post.astro_status === "draft") && post.publish_status !== "publishing";
// Compact form for the month cells, where a full "RSS Auto" would eat the row.
const TYPE_SHORT = { blog: "Blog", social: "Social", rss: "RSS" };
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
function calendarDateKey(value) {
  if (!value) return "";
  const text = String(value);
  if (DATE_ONLY.test(text)) return text;
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? "" : etDateString(parsed);
}
export default function ContentCalendar() {
  const [month, setMonth] = useState(() => {
    const d = new Date();
    return {
      year: d.getFullYear(),
      month: d.getMonth()
    };
  });
  const [items, setItems] = useState([]);
  const [selectedDay, setSelectedDay] = useState(null);
  const [showSchedule, setShowSchedule] = useState(false);
  // A scheduling POST is a write: Escape and backdrop clicks must not unmount
  // the form while it is in flight, which would leave the result ambiguous.
  const [scheduling, setScheduling] = useState(false);
  const [scheduleForm, setScheduleForm] = useState({
    type: "blog",
    blogPostId: "",
    title: "",
    date: "",
    time: "09:00",
    autoShare: true
  });
  const [draftPosts, setDraftPosts] = useState([]);
  const [hiddenDrafts, setHiddenDrafts] = useState(0);
  const [draftError, setDraftError] = useState("");
  const [loadingDrafts, setLoadingDrafts] = useState(false);
  const [unscheduling, setUnscheduling] = useState(null);
  const [toast, setToast] = useState("");
  const [loadError, setLoadError] = useState("");
  const loadGen = useRef(0);
  const loadCalendar = useCallback(async () => {
    // Only the newest month request may commit: a slow earlier month must not
    // replace the events of the month now on screen.
    const gen = ++loadGen.current;
    setLoadError("");
    const start = etDateString(new Date(month.year, month.month, 1, 12));
    const end = etDateString(new Date(month.year, month.month + 1, 0, 12));
    try {
      const data = await adminFetch(
        `/admin/content/calendar?start=${start}&end=${end}`,
      );
      if (gen !== loadGen.current) return;
      setItems(data.calendar || data.items || []);
    } catch (e) {
      if (gen !== loadGen.current) return;
      setItems([]);
      setLoadError(e.message);
    }
  }, [month]);
  useEffect(() => {
    loadCalendar();
  }, [loadCalendar]);
  const showToast = m => {
    setToast(m);
    setTimeout(() => setToast(""), 3500);
  };
  useEffect(() => {
    if (!showSchedule || scheduleForm.type !== "blog") return;
    setLoadingDrafts(true);
    setDraftError("");
    adminFetch(
      "/admin/content/blog?status=draft&limit=100&sort=updated_at&order=desc",
    ).then(data => {
      const drafts = data.posts || [];
      const eligible = drafts.filter(schedulableDraft);
      setDraftPosts(eligible);
      setHiddenDrafts(drafts.length - eligible.length);
    }).catch(e => {
      setDraftPosts([]);
      setHiddenDrafts(0);
      setDraftError(e.message);
    }).finally(() => setLoadingDrafts(false));
  }, [showSchedule, scheduleForm.type]);
  const shiftMonth = dir => {
    // A selected day belongs to the month it was picked in (Oct 31 does not
    // exist in November), so a month change clears it.
    setSelectedDay(null);
    setMonth(prev => {
      let m = prev.month + dir;
      let y = prev.year;
      if (m < 0) {
        m = 11;
        y--;
      }
      if (m > 11) {
        m = 0;
        y++;
      }
      return {
        year: y,
        month: m
      };
    });
  };

  // Build calendar grid
  const firstDay = new Date(month.year, month.month, 1).getDay();
  const daysInMonth = new Date(month.year, month.month + 1, 0).getDate();
  const weeks = [];
  let week = new Array(firstDay).fill(null);
  for (let d = 1; d <= daysInMonth; d++) {
    week.push(d);
    if (week.length === 7) {
      weeks.push(week);
      week = [];
    }
  }
  if (week.length > 0) {
    while (week.length < 7) week.push(null);
    weeks.push(week);
  }
  const getItemsForDay = day => {
    if (!day) return [];
    const dateStr = `${month.year}-${String(month.month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    return items.filter(i => calendarDateKey(i.scheduledDate || i.date) === dateStr);
  };
  const today = new Date();
  const isToday = day => day && today.getFullYear() === month.year && today.getMonth() === month.month && today.getDate() === day;
  const monthName = new Date(month.year, month.month).toLocaleString("en-US", {
    month: "long",
    year: "numeric"
  });
  const openSchedule = (type = "blog", day = selectedDay) => {
    const date = day ? etDateString(new Date(month.year, month.month, day, 12)) : etDateString(new Date());
    setScheduleForm(prev => ({
      ...prev,
      type,
      date,
      blogPostId: "",
      title: ""
    }));
    setShowSchedule(true);
  };
  const closeSchedule = () => {
    if (scheduling) return;
    setShowSchedule(false);
  };

  const handleSchedule = async () => {
    if (scheduling) return;
    if (!scheduleForm.date) {
      showToast("Pick a date");
      return;
    }
    const publishAt = `${scheduleForm.date}T${scheduleForm.time}:00`;
    setScheduling(true);
    try {
      if (scheduleForm.type === "blog") {
        if (!scheduleForm.blogPostId) {
          showToast("Pick a blog draft");
          setScheduling(false);
          return;
        }
        await adminFetch(
          `/admin/content/schedule-blog/${scheduleForm.blogPostId}`,
          {
            method: "POST",
            body: JSON.stringify({
              publishAt,
              autoShareSocial: scheduleForm.autoShare,
            }),
          },
        );
      } else {
        if (!scheduleForm.title.trim()) {
          showToast("Add a title");
          return;
        }
        await adminFetch("/admin/content/schedule-social", {
          method: "POST",
          body: JSON.stringify({
            title: scheduleForm.title.trim(),
            description: "",
            link: "",
            scheduledFor: publishAt,
            platforms: [],
          }),
        });
      }
      showToast(scheduleForm.type === "blog" ? "Scheduled. The preview PR opens at that time." : "Scheduled!");
      setShowSchedule(false);
      loadCalendar();
    } catch (e) {
      showToast(`Failed: ${e.message}`);
    } finally {
      setScheduling(false);
    }
  };
  // Withdraws a blog schedule the run has not started (BLOG-05). The server
  // refuses once publishing has begun and names a preview PR left open.
  const handleUnschedule = async item => {
    if (unscheduling) return;
    setUnscheduling(item.id);
    try {
      const result = await adminFetch(`/admin/content/schedule/${item.id}`, { method: "DELETE" });
      showToast(result.pr_number ? `Unscheduled. Preview PR #${result.pr_number} stays open in the post editor.` : "Unscheduled");
    } catch (e) {
      showToast(`Couldn't unschedule: ${e.message}`);
    } finally {
      setUnscheduling(null);
      loadCalendar();
    }
  };
  return (
    <UiSurface density="comfortable" className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <Button variant="secondary" aria-label="Previous month" onClick={() => shiftMonth(-1)}><ChevronLeft size={18} /></Button>
          <h2 className="m-0 min-w-0 text-center text-18 font-medium text-zinc-900">{monthName}</h2>
          <Button variant="secondary" aria-label="Next month" onClick={() => shiftMonth(1)}><ChevronRight size={18} /></Button>
        </div>
        <div className="flex flex-wrap items-center gap-3 text-ui-body text-ink-secondary">
          {Object.values(TYPE_LABELS).map(label => <Badge key={label} tone="neutral">{label}</Badge>)}
          {!loadError && <span>{items.length} posts this month</span>}
          <Button onClick={() => openSchedule("blog")}>Schedule</Button>
        </div>
      </div>
      {loadError && <ActionFeedback error onRetry={loadCalendar}>Calendar unavailable: {loadError}</ActionFeedback>}
      <Card className="overflow-hidden">
        <div className="grid grid-cols-7 border-b border-hairline border-zinc-200">
          {DAYS.map(day => <div key={day} className="py-2 text-center text-ui-body font-medium text-ink-secondary">{day}</div>)}
        </div>
        {weeks.map((week, wi) => (
          <div key={wi} className="grid grid-cols-7 border-b border-hairline border-zinc-200 last:border-b-0">
            {week.map((day, di) => {
              const dayItems = getItemsForDay(day);
              const dateLabel = day ? new Date(month.year, month.month, day).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" }) : "";
              return day ? (
                <button key={di} type="button" aria-label={`${dateLabel}, ${dayItems.length} scheduled items`} aria-pressed={day === selectedDay}
                  onClick={() => setSelectedDay(day === selectedDay ? null : day)}
                  className={`flex flex-col items-stretch justify-start min-w-0 min-h-[100px] border-0 border-r border-hairline border-zinc-200 last:border-r-0 p-1 text-ui-body text-left align-top cursor-pointer u-focus-ring ${day === selectedDay ? "bg-zinc-100" : isToday(day) ? "bg-zinc-50" : "bg-white"}`}>
                  <span className={`block px-1 py-0.5 text-ui-body ${isToday(day) ? "font-medium text-zinc-900" : "text-ink-secondary"}`}>{day}</span>
                  {dayItems.slice(0, 3).map((item, ii) => (
                    // The type has to be readable in the cell, not only in a
                    // hover title: main distinguished blog/social/rss by colour,
                    // and colour alone is not a sanctioned cue (and is no cue at
                    // all on touch). The short label also makes the legend mean
                    // something.
                    <span key={ii} title={`${TYPE_LABELS[item.type] || item.type}: ${item.title || ""}`} className="mb-0.5 block truncate rounded-xs bg-zinc-100 px-1 py-0.5 text-ui-body text-zinc-900">
                      <span className="font-medium text-ink-secondary">{TYPE_SHORT[item.type] || item.type}</span>{" · "}{item.title?.substring(0, 25)}
                    </span>
                  ))}
                  {dayItems.length > 3 && <span className="block px-1 text-ui-body text-ink-secondary">+{dayItems.length - 3} more</span>}
                </button>
              ) : <div key={di} className="min-h-[100px] border-r border-hairline border-zinc-200 last:border-r-0 bg-zinc-50" />;
            })}
          </div>
        ))}
      </Card>
      {selectedDay && (
        <Card className="p-4">
          <h3 className="m-0 mb-3 text-ui-body font-medium text-zinc-900">{new Date(month.year, month.month, selectedDay).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" })}</h3>
          <div className="mb-3 flex flex-wrap gap-2">
            <Button variant="secondary" onClick={() => openSchedule("blog", selectedDay)}>Schedule Blog</Button>
            <Button variant="secondary" onClick={() => openSchedule("social", selectedDay)}>Schedule Social</Button>
          </div>
          {getItemsForDay(selectedDay).length === 0 ? <div className="text-ui-body text-ink-secondary">No content scheduled for this day</div> : getItemsForDay(selectedDay).map((item, i) => (
            <div key={i} className="flex flex-wrap items-center gap-3 border-b border-hairline border-zinc-200 py-2 last:border-b-0 text-ui-body">
              <div className="min-w-0 flex-1">
                <div className="break-words font-medium text-zinc-900">{item.title}</div>
                <div className="text-ink-secondary">{statusLabel(item)} · {item.platforms?.join(", ") || item.type}</div>
              </div>
              <Badge tone="neutral">{statusLabel(item)}</Badge>
              {item.type === "blog" && item.status === "pending" && (
                <Button variant="secondary" onClick={() => handleUnschedule(item)} loading={unscheduling === item.id} disabled={Boolean(unscheduling)}>Unschedule</Button>
              )}
            </div>
          ))}
        </Card>
      )}
      <Dialog open={showSchedule} onClose={closeSchedule} layer={250}>
        <DialogHeader className="flex items-center justify-between gap-3">
          <DialogTitle>Schedule Content</DialogTitle>
          <Button variant="ghost" aria-label="Close schedule" onClick={closeSchedule} disabled={scheduling}><X size={18} /></Button>
        </DialogHeader>
        <DialogBody className="space-y-3">
          <Field label="Type">
            <Select value={scheduleForm.type} onChange={e => setScheduleForm(prev => ({ ...prev, type: e.target.value, blogPostId: "", title: "" }))}>
              <option value="blog">Blog Draft</option><option value="social">Social Post</option>
            </Select>
          </Field>
          {scheduleForm.type === "blog" ? (
            <Field
              label="Draft"
              help={`A preview PR opens at this time. The post goes live after you approve it in the post editor.${hiddenDrafts ? ` ${hiddenDrafts} draft${hiddenDrafts === 1 ? "" : "s"} with a PR, a failed publish or no body ${hiddenDrafts === 1 ? "is" : "are"} not listed.` : ""}`}
              error={draftError ? `Couldn't load drafts: ${draftError}` : undefined}
            >
              <Select value={scheduleForm.blogPostId} onChange={e => setScheduleForm(prev => ({ ...prev, blogPostId: e.target.value }))}>
                <option value="">{loadingDrafts ? "Loading drafts..." : "Select draft..."}</option>
                {draftPosts.map(post => <option key={post.id} value={post.id}>{post.title}</option>)}
              </Select>
            </Field>
          ) : <Field label="Title"><Input value={scheduleForm.title} onChange={e => setScheduleForm(prev => ({ ...prev, title: e.target.value }))} /></Field>}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-[minmax(0,1fr)_140px]">
            <Field label="Date"><Input type="date" value={scheduleForm.date} onChange={e => setScheduleForm(prev => ({ ...prev, date: e.target.value }))} /></Field>
            <Field label="Time"><Input type="time" value={scheduleForm.time} onChange={e => setScheduleForm(prev => ({ ...prev, time: e.target.value }))} /></Field>
          </div>
          {scheduleForm.type === "blog" && <Checkbox label="Share to social after the post is live" checked={scheduleForm.autoShare} onChange={e => setScheduleForm(prev => ({ ...prev, autoShare: e.target.checked }))} />}
        </DialogBody>
        <DialogFooter>
          <Button variant="secondary" onClick={closeSchedule} disabled={scheduling}>Cancel</Button>
          <Button onClick={handleSchedule} loading={scheduling}>Schedule</Button>
        </DialogFooter>
      </Dialog>
      {toast && <ActionFeedback className="pointer-events-none fixed bottom-5 right-5 z-[300] max-w-[calc(100%-40px)] rounded-md border-hairline border-zinc-200 bg-white p-3 shadow-sm">{toast}</ActionFeedback>}
    </UiSurface>
  );
}
