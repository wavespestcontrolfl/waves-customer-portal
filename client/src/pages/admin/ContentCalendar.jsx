import { useState, useEffect, useCallback } from "react";
import { etDateString } from "../../lib/timezone";

const API_BASE = import.meta.env.VITE_API_URL || "/api";
// V2 token pass: teal/purple fold to zinc-900. Semantic green/amber/red preserved.
// TYPE_COLORS uses explicit hex map (NOT D refs) so blog/social/rss stay visually distinct
// after the fold (otherwise blog + social both collapse to zinc-900).
const D = {
  bg: "#F4F4F5",
  card: "#FFFFFF",
  border: "#E4E4E7",
  teal: "#18181B",
  green: "#15803D",
  amber: "#A16207",
  red: "#991B1B",
  purple: "#18181B",
  text: "#27272A",
  muted: "#71717A",
  white: "#FFFFFF",
  input: "#FFFFFF",
  heading: "#09090B",
  inputBorder: "#D4D4D8",
};

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

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const TYPE_COLORS = { blog: "#18181B", social: "#71717A", rss: "#15803D" };
const TYPE_ICONS = { blog: "", social: "", rss: "" };
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
    return { year: d.getFullYear(), month: d.getMonth() };
  });
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selectedDay, setSelectedDay] = useState(null);
  const [showSchedule, setShowSchedule] = useState(false);
  const [scheduleForm, setScheduleForm] = useState({
    type: "blog",
    blogPostId: "",
    title: "",
    date: "",
    time: "09:00",
    // Opt-IN: social sharing on a scheduled publish requires ticking the box
    // (owner rule — customer-facing sends are never a silent default).
    autoShare: false,
  });
  const [draftPosts, setDraftPosts] = useState([]);
  const [loadingDrafts, setLoadingDrafts] = useState(false);
  const [toast, setToast] = useState("");

  const loadCalendar = useCallback(async () => {
    const start = etDateString(new Date(month.year, month.month, 1, 12));
    const end = etDateString(new Date(month.year, month.month + 1, 0, 12));
    try {
      const data = await adminFetch(
        `/admin/content/calendar?start=${start}&end=${end}`,
      );
      setItems(data.calendar || data.items || []);
    } catch {
      setItems([]);
    }
    setLoading(false);
  }, [month]);

  useEffect(() => {
    loadCalendar();
  }, [loadCalendar]);
  const showToast = (m) => {
    setToast(m);
    setTimeout(() => setToast(""), 3500);
  };

  useEffect(() => {
    if (!showSchedule || scheduleForm.type !== "blog") return;
    setLoadingDrafts(true);
    adminFetch(
      "/admin/content/blog?status=draft&limit=100&sort=updated_at&order=desc",
    )
      .then((data) => setDraftPosts(data.posts || []))
      .catch(() => setDraftPosts([]))
      .finally(() => setLoadingDrafts(false));
  }, [showSchedule, scheduleForm.type]);

  const shiftMonth = (dir) => {
    setMonth((prev) => {
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
      return { year: y, month: m };
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

  const getItemsForDay = (day) => {
    if (!day) return [];
    const dateStr = `${month.year}-${String(month.month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    return items.filter(
      (i) => calendarDateKey(i.scheduledDate || i.date) === dateStr,
    );
  };

  const today = new Date();
  const isToday = (day) =>
    day &&
    today.getFullYear() === month.year &&
    today.getMonth() === month.month &&
    today.getDate() === day;
  const monthName = new Date(month.year, month.month).toLocaleString("en-US", {
    month: "long",
    year: "numeric",
  });

  const openSchedule = (type = "blog", day = selectedDay) => {
    const date = day
      ? etDateString(new Date(month.year, month.month, day, 12))
      : etDateString(new Date());
    setScheduleForm((prev) => ({
      ...prev,
      type,
      date,
      blogPostId: "",
      title: "",
      // Opt-in resets per schedule: one opted-in post must not silently
      // opt in the NEXT post scheduled from the remembered form state.
      autoShare: false,
    }));
    setShowSchedule(true);
  };

  const handleSchedule = async () => {
    if (!scheduleForm.date) {
      showToast("Pick a date");
      return;
    }
    const publishAt = `${scheduleForm.date}T${scheduleForm.time}:00`;
    try {
      if (scheduleForm.type === "blog") {
        if (!scheduleForm.blogPostId) {
          showToast("Pick a blog draft");
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
      showToast("Scheduled!");
      setShowSchedule(false);
      loadCalendar();
    } catch (e) {
      showToast(`Failed: ${e.message}`);
    }
  };

  return (
    <div>
      {/* Header */}
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: 16,
        }}
      >
        {" "}
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          {" "}
          <button
            onClick={() => shiftMonth(-1)}
            style={{
              background: "none",
              border: `1px solid ${D.border}`,
              borderRadius: 6,
              padding: "4px 10px",
              color: D.muted,
              cursor: "pointer",
            }}
          >
            ←
          </button>{" "}
          <div
            style={{
              fontSize: 18,
              fontWeight: 700,
              color: D.heading,
              minWidth: 200,
              textAlign: "center",
            }}
          >
            {monthName}
          </div>{" "}
          <button
            onClick={() => shiftMonth(1)}
            style={{
              background: "none",
              border: `1px solid ${D.border}`,
              borderRadius: 6,
              padding: "4px 10px",
              color: D.muted,
              cursor: "pointer",
            }}
          >
            →
          </button>{" "}
        </div>{" "}
        <div style={{ display: "flex", gap: 12, fontSize: 11, color: D.muted }}>
          {" "}
          <span>
            <span style={{ color: D.teal }}>●</span>Blog
          </span>{" "}
          <span>
            <span style={{ color: D.purple }}>●</span>Social
          </span>{" "}
          <span>
            <span style={{ color: D.green }}>●</span>RSS Auto
          </span>{" "}
          <span style={{ fontFamily: "'JetBrains Mono', monospace" }}>
            {items.length} posts this month
          </span>{" "}
          <button
            type="button"
            onClick={() => openSchedule("blog")}
            style={{
              padding: "4px 10px",
              borderRadius: 6,
              border: `1px solid ${D.border}`,
              background: D.card,
              color: D.heading,
              cursor: "pointer",
              fontSize: 11,
              fontWeight: 700,
            }}
          >
            Schedule
          </button>{" "}
        </div>{" "}
      </div>
      {/* Calendar grid */}
      <div
        style={{
          background: D.card,
          border: `1px solid ${D.border}`,
          borderRadius: 12,
          overflow: "hidden",
        }}
      >
        {/* Day headers */}
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(7, 1fr)",
            borderBottom: `1px solid ${D.border}`,
          }}
        >
          {DAYS.map((d) => (
            <div
              key={d}
              style={{
                padding: "8px 0",
                textAlign: "center",
                fontSize: 11,
                fontWeight: 600,
                color: D.muted,
                textTransform: "uppercase",
                letterSpacing: 1,
              }}
            >
              {d}
            </div>
          ))}
        </div>
        {/* Weeks */}
        {weeks.map((week, wi) => (
          <div
            key={wi}
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(7, 1fr)",
              borderBottom:
                wi < weeks.length - 1 ? `1px solid ${D.border}22` : "none",
            }}
          >
            {week.map((day, di) => {
              const dayItems = getItemsForDay(day);
              return (
                <div
                  key={di}
                  onClick={() =>
                    day && setSelectedDay(day === selectedDay ? null : day)
                  }
                  style={{
                    minHeight: 80,
                    padding: 4,
                    borderRight: di < 6 ? `1px solid ${D.border}11` : "none",
                    background: isToday(day)
                      ? `${D.teal}08`
                      : day === selectedDay
                        ? `${D.teal}05`
                        : "transparent",
                    cursor: day ? "pointer" : "default",
                    transition: "background .1s",
                  }}
                >
                  {day && (
                    <>
                      {" "}
                      <div
                        style={{
                          fontSize: 12,
                          fontWeight: isToday(day) ? 700 : 400,
                          color: isToday(day) ? D.teal : D.muted,
                          padding: "2px 4px",
                        }}
                      >
                        {day}
                      </div>
                      {dayItems.slice(0, 3).map((item, ii) => (
                        <div
                          key={ii}
                          style={{
                            fontSize: 9,
                            padding: "2px 4px",
                            marginBottom: 1,
                            borderRadius: 3,
                            background: `${TYPE_COLORS[item.type] || D.muted}15`,
                            color: TYPE_COLORS[item.type] || D.muted,
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                          }}
                        >
                          {TYPE_ICONS[item.type] || "•"}{" "}
                          {item.title?.substring(0, 25)}
                        </div>
                      ))}
                      {dayItems.length > 3 && (
                        <div
                          style={{
                            fontSize: 9,
                            color: D.muted,
                            padding: "0 4px",
                          }}
                        >
                          +{dayItems.length - 3} more
                        </div>
                      )}
                    </>
                  )}
                </div>
              );
            })}
          </div>
        ))}
      </div>
      {/* Selected day detail */}
      {selectedDay && (
        <div
          style={{
            marginTop: 12,
            background: D.card,
            border: `1px solid ${D.teal}`,
            borderRadius: 10,
            padding: 16,
          }}
        >
          {" "}
          <div
            style={{
              fontSize: 14,
              fontWeight: 600,
              color: D.heading,
              marginBottom: 12,
            }}
          >
            {new Date(month.year, month.month, selectedDay).toLocaleDateString(
              "en-US",
              { weekday: "long", month: "long", day: "numeric" },
            )}
          </div>{" "}
          <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
            {" "}
            <button
              type="button"
              onClick={() => openSchedule("blog", selectedDay)}
              style={{
                padding: "6px 10px",
                borderRadius: 6,
                border: `1px solid ${D.border}`,
                background: D.bg,
                color: D.heading,
                cursor: "pointer",
                fontSize: 12,
                fontWeight: 600,
              }}
            >
              Schedule Blog
            </button>{" "}
            <button
              type="button"
              onClick={() => openSchedule("social", selectedDay)}
              style={{
                padding: "6px 10px",
                borderRadius: 6,
                border: `1px solid ${D.border}`,
                background: D.bg,
                color: D.heading,
                cursor: "pointer",
                fontSize: 12,
                fontWeight: 600,
              }}
            >
              Schedule Social
            </button>{" "}
          </div>
          {getItemsForDay(selectedDay).length === 0 ? (
            <div style={{ fontSize: 13, color: D.muted }}>
              No content scheduled for this day
            </div>
          ) : (
            getItemsForDay(selectedDay).map((item, i) => (
              <div
                key={i}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  padding: "8px 0",
                  borderBottom: `1px solid ${D.border}22`,
                  fontSize: 13,
                }}
              >
                {" "}
                <span style={{ fontSize: 16 }}>
                  {TYPE_ICONS[item.type]}
                </span>{" "}
                <div style={{ flex: 1 }}>
                  {" "}
                  <div style={{ color: D.heading, fontWeight: 500 }}>
                    {item.title}
                  </div>{" "}
                  <div style={{ fontSize: 11, color: D.muted }}>
                    {item.status} · {item.platforms?.join(", ") || item.type}
                  </div>{" "}
                </div>{" "}
                <span
                  style={{
                    fontSize: 10,
                    padding: "2px 8px",
                    borderRadius: 4,
                    background: `${TYPE_COLORS[item.type]}22`,
                    color: TYPE_COLORS[item.type],
                  }}
                >
                  {item.status}
                </span>{" "}
              </div>
            ))
          )}
        </div>
      )}
      {showSchedule && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(24,24,27,0.42)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 250,
            padding: 16,
          }}
        >
          {" "}
          <div
            style={{
              width: "100%",
              maxWidth: 460,
              background: D.card,
              border: `1px solid ${D.border}`,
              borderRadius: 10,
              padding: 18,
              boxShadow: "0 18px 50px rgba(0,0,0,.22)",
            }}
          >
            {" "}
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                marginBottom: 14,
              }}
            >
              {" "}
              <div style={{ fontSize: 15, fontWeight: 700, color: D.heading }}>
                Schedule Content
              </div>{" "}
              <button
                type="button"
                onClick={() => setShowSchedule(false)}
                style={{
                  border: "none",
                  background: "transparent",
                  color: D.muted,
                  cursor: "pointer",
                  fontSize: 18,
                }}
              >
                ×
              </button>{" "}
            </div>{" "}
            <div style={{ display: "grid", gap: 10 }}>
              {" "}
              <label style={{ fontSize: 11, color: D.muted }}>
                Type
                <select
                  value={scheduleForm.type}
                  onChange={(e) =>
                    setScheduleForm((prev) => ({
                      ...prev,
                      type: e.target.value,
                      blogPostId: "",
                      title: "",
                    }))
                  }
                  style={{
                    width: "100%",
                    marginTop: 4,
                    padding: "8px 10px",
                    borderRadius: 6,
                    border: `1px solid ${D.inputBorder}`,
                    background: D.input,
                    color: D.text,
                  }}
                >
                  {" "}
                  <option value="blog">Blog Draft</option>{" "}
                  <option value="social">Social Post</option>{" "}
                </select>{" "}
              </label>
              {scheduleForm.type === "blog" ? (
                <label style={{ fontSize: 11, color: D.muted }}>
                  Draft
                  <select
                    value={scheduleForm.blogPostId}
                    onChange={(e) =>
                      setScheduleForm((prev) => ({
                        ...prev,
                        blogPostId: e.target.value,
                      }))
                    }
                    style={{
                      width: "100%",
                      marginTop: 4,
                      padding: "8px 10px",
                      borderRadius: 6,
                      border: `1px solid ${D.inputBorder}`,
                      background: D.input,
                      color: D.text,
                    }}
                  >
                    {" "}
                    <option value="">
                      {loadingDrafts ? "Loading drafts..." : "Select draft..."}
                    </option>
                    {draftPosts.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.title}
                      </option>
                    ))}
                  </select>{" "}
                </label>
              ) : (
                <label style={{ fontSize: 11, color: D.muted }}>
                  Title
                  <input
                    value={scheduleForm.title}
                    onChange={(e) =>
                      setScheduleForm((prev) => ({
                        ...prev,
                        title: e.target.value,
                      }))
                    }
                    style={{
                      width: "100%",
                      marginTop: 4,
                      padding: "8px 10px",
                      borderRadius: 6,
                      border: `1px solid ${D.inputBorder}`,
                      background: D.input,
                      color: D.text,
                    }}
                  />{" "}
                </label>
              )}
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "1fr 120px",
                  gap: 10,
                }}
              >
                {" "}
                <label style={{ fontSize: 11, color: D.muted }}>
                  Date
                  <input
                    type="date"
                    value={scheduleForm.date}
                    onChange={(e) =>
                      setScheduleForm((prev) => ({
                        ...prev,
                        date: e.target.value,
                      }))
                    }
                    style={{
                      width: "100%",
                      marginTop: 4,
                      padding: "8px 10px",
                      borderRadius: 6,
                      border: `1px solid ${D.inputBorder}`,
                      background: D.input,
                      color: D.text,
                    }}
                  />{" "}
                </label>{" "}
                <label style={{ fontSize: 11, color: D.muted }}>
                  Time
                  <input
                    type="time"
                    value={scheduleForm.time}
                    onChange={(e) =>
                      setScheduleForm((prev) => ({
                        ...prev,
                        time: e.target.value,
                      }))
                    }
                    style={{
                      width: "100%",
                      marginTop: 4,
                      padding: "8px 10px",
                      borderRadius: 6,
                      border: `1px solid ${D.inputBorder}`,
                      background: D.input,
                      color: D.text,
                    }}
                  />{" "}
                </label>{" "}
              </div>
              {scheduleForm.type === "blog" && (
                <label
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    fontSize: 12,
                    color: D.text,
                  }}
                >
                  {" "}
                  <input
                    type="checkbox"
                    checked={scheduleForm.autoShare}
                    onChange={(e) =>
                      setScheduleForm((prev) => ({
                        ...prev,
                        autoShare: e.target.checked,
                      }))
                    }
                  />
                  Share to social after the post is live
                </label>
              )}
            </div>{" "}
            <div
              style={{
                display: "flex",
                justifyContent: "flex-end",
                gap: 8,
                marginTop: 16,
              }}
            >
              {" "}
              <button
                type="button"
                onClick={() => setShowSchedule(false)}
                style={{
                  padding: "8px 12px",
                  borderRadius: 6,
                  border: `1px solid ${D.border}`,
                  background: "transparent",
                  color: D.muted,
                  cursor: "pointer",
                }}
              >
                Cancel
              </button>{" "}
              <button
                type="button"
                onClick={handleSchedule}
                style={{
                  padding: "8px 12px",
                  borderRadius: 6,
                  border: "none",
                  background: D.teal,
                  color: D.white,
                  cursor: "pointer",
                  fontWeight: 700,
                }}
              >
                Schedule
              </button>{" "}
            </div>{" "}
          </div>{" "}
        </div>
      )}
      {/* Toast */}
      <div
        style={{
          position: "fixed",
          bottom: 20,
          right: 20,
          background: D.card,
          border: `1px solid ${D.green}`,
          borderRadius: 8,
          padding: "10px 16px",
          display: "flex",
          alignItems: "center",
          gap: 8,
          boxShadow: "0 8px 32px rgba(0,0,0,.4)",
          zIndex: 300,
          fontSize: 12,
          transform: toast ? "translateY(0)" : "translateY(80px)",
          opacity: toast ? 1 : 0,
          transition: "all .3s",
          pointerEvents: "none",
        }}
      >
        {" "}
        <span style={{ color: D.green }}></span>
        <span style={{ color: D.text }}>{toast}</span>{" "}
      </div>{" "}
    </div>
  );
}
