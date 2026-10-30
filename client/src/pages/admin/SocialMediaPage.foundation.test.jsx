// @vitest-environment jsdom
import React from "react";
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, useLocation, useNavigate } from "react-router-dom";

vi.mock("./ContentCalendar", () => ({ default: () => <div>Calendar fixture</div> }));

import SocialMediaPage from "./SocialMediaPage";

function RouterState() {
  const location = useLocation();
  const navigate = useNavigate();
  return (
    <>
      <output data-testid="location">{location.search}{location.hash}</output>
      <button type="button" onClick={() => navigate(-1)}>Browser Back</button>
    </>
  );
}

function renderPage(initialEntries = ["/admin/social-media"]) {
  return render(
    <MemoryRouter initialEntries={initialEntries}>
      <SocialMediaPage />
      <RouterState />
    </MemoryRouter>,
  );
}

function response(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function fixtureFor(url, options = {}) {
  const path = String(url).replace(/^\/api/, "");
  if (path === "/admin/social-media/status") {
    return {
      automation: {
        enabled: true,
        paused: false,
        dryRun: false,
        rssAutopublish: true,
        scheduledPosts: true,
        newsletterAutoshare: true,
      },
      platforms: {
        facebook: { enabled: true, configured: true },
        instagram: { enabled: true, configured: true },
        gbp: { enabled: true, configured: true },
      },
    };
  }
  if (path === "/admin/social-media/stats") {
    return { total: 8, published: 7, failed: 1, last7d: 3 };
  }
  if (path === "/admin/social-media/history?limit=20") return { posts: [] };
  if (path === "/admin/social-media/health") {
    return {
      checkedAt: "2026-09-11T14:00:00Z",
      credentials: [
        { platform: "facebook", status: "healthy", details: { pageName: "Waves" } },
        { platform: "instagram", status: "healthy", details: { username: "waves" } },
      ],
    };
  }
  if (path === "/admin/social-media/alerts") return { active: false };
  if (path === "/admin/social-media/autonomous/status") {
    return { enabled: true, globalAutomationEnabled: true, channels: ["gbp", "facebook"] };
  }
  if (path === "/admin/social-media/campaign-builder/preview" && options.method === "POST") {
    return {
      drafts: { facebook: "Synthetic Facebook draft", gbp: "Synthetic GBP draft" },
      validation: { facebook: { valid: true }, gbp: { valid: true } },
      suggestedLink: "https://example.test/termite",
      sources: [{ type: "service", label: "Termite", detail: "Synthetic source fact" }],
    };
  }
  if (path === "/admin/social-media/campaign-builder/save" && options.method === "POST") {
    return { success: true };
  }
  if (path === "/admin/social-media/rss") return { items: [] };
  if (path === "/admin/social-media/autonomous/runs?limit=30") {
    return {
      runs: [
        {
          id: "run-1",
          status: "draft_created",
          topic: "Termite season",
          startedAt: "2026-09-11T14:00:00Z",
          channels: ["facebook"],
          preview: {
            drafts: { facebook: "Approve this draft" },
            visual: { variants: [{ imageUrl: "https://example.test/social.jpg" }] },
          },
        },
      ],
    };
  }
  if (path === "/admin/social-media/autonomous/runs/run-1/approve" && options.method === "POST") {
    return { published: true };
  }
  throw new Error(`Unexpected synthetic request: ${options.method || "GET"} ${path}`);
}

beforeEach(() => {
  vi.stubGlobal("localStorage", { getItem: () => "synthetic-admin-token" });
  vi.stubGlobal("fetch", vi.fn(async (url, options = {}) => response(fixtureFor(url, options))));
  Object.defineProperty(Element.prototype, "scrollIntoView", {
    configurable: true,
    value: vi.fn(),
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Social media workspace foundation", () => {
  it("preserves campaign draft payloads and autonomous approval actions", async () => {
    const view = renderPage();

    expect(await screen.findByText("Local Campaign")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Social media", level: 1 })).toBeInTheDocument();
    expect(view.container.querySelector(".border-hairline")).toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText("termite swarm season"), {
      target: { value: "rodent pressure" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Generate Drafts" }));
    expect(await screen.findByDisplayValue("Synthetic Facebook draft")).toBeInTheDocument();

    const previewCall = fetch.mock.calls.find(
      ([url]) => url === "/api/admin/social-media/campaign-builder/preview",
    );
    expect(previewCall[1]).toEqual(expect.objectContaining({ method: "POST" }));
    expect(JSON.parse(previewCall[1].body)).toEqual(
      expect.objectContaining({
        topic: "rodent pressure",
        city: "Sarasota",
        service: "termite",
        cta: "book inspection",
        channels: ["gbp", "facebook", "instagram"],
      }),
    );

    fireEvent.click(screen.getByRole("button", { name: "Save Draft" }));
    await waitFor(() =>
      expect(fetch).toHaveBeenCalledWith(
        "/api/admin/social-media/campaign-builder/save",
        expect.objectContaining({ method: "POST" }),
      ),
    );

    fireEvent.click(screen.getByRole("button", { name: "Automation" }));
    expect(await screen.findByText("Blog RSS Feed")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Audit" }));
    expect(await screen.findByText("Approve this draft")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Approve & Publish" }));

    await waitFor(() => {
      const approveCall = fetch.mock.calls.find(
        ([url]) => url === "/api/admin/social-media/autonomous/runs/run-1/approve",
      );
      expect(approveCall[1]).toEqual(expect.objectContaining({ method: "POST" }));
      expect(JSON.parse(approveCall[1].body)).toEqual({ variantIndex: 0 });
    });
  });

  it("deep-links leaf tabs and restores them with browser history", async () => {
    renderPage(["/admin/social-media?tab=history&source=audit#evidence"]);
    expect(screen.getByRole("button", { name: "History" })).toHaveClass(
      "bg-zinc-900",
    );

    fireEvent.click(screen.getByRole("button", { name: "Studio" }));
    expect(screen.getByTestId("location")).toHaveTextContent(
      "?tab=campaigns&source=audit#evidence",
    );
    fireEvent.click(screen.getByRole("button", { name: "Templates" }));
    expect(screen.getByTestId("location")).toHaveTextContent(
      "?tab=templates&source=audit#evidence",
    );
    fireEvent.click(screen.getByRole("button", { name: "Browser Back" }));
    await waitFor(() =>
      expect(screen.getByTestId("location")).toHaveTextContent(
        "?tab=campaigns&source=audit#evidence",
      ),
    );
  });

  it.each(["unknown", "constructor", "__proto__", "toString"])("falls back to Local Campaign for invalid tab %s", async (tab) => {
    renderPage([`/admin/social-media?tab=${tab}`]);
    expect(await screen.findByText("Local Campaign")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Studio" })).toHaveAttribute(
      "aria-current",
      "page",
    );
  });
});


it("resumes autonomous reads when a failed run supersedes the initial read", async () => {
  let finishRead;
  let reads = 0;
  fetch.mockImplementation(async (url, options = {}) => {
    if (String(url).includes("autonomous/runs?")) {
      reads += 1;
      if (reads === 1) return new Promise((resolve) => { finishRead = resolve; });
    }
    if (String(url).endsWith("autonomous/run")) throw new Error("run failed");
    return response(fixtureFor(url, options));
  });
  renderPage(["/admin/social-media?tab=audit"]);
  await waitFor(() => expect(finishRead).toBeTypeOf("function"));
  fireEvent.click(screen.getByRole("button", { name: "Run Draft" }));
  await screen.findByText("Autonomous run failed: run failed");
  await act(async () => { finishRead(response({ runs: [] })); });
  fireEvent(window, new Event("online"));
  await screen.findByText("Approve this draft");
  expect(reads).toBe(2);
});

it("does not restore a dismissed alert from an older refresh bundle", async () => {
  let finishHistory;
  let historyReads = 0;
  fetch.mockImplementation(async (url, options = {}) => {
    if (String(url).endsWith("/alerts")) return response(options.method === "DELETE" ? {} : {
      active: true, alert: { message: "Synthetic failure alert", raised_at: "2026-09-24T00:00:00Z" },
    });
    if (String(url).includes("/history?")) {
      historyReads += 1;
      if (historyReads === 2) return new Promise((resolve) => { finishHistory = resolve; });
    }
    return response(fixtureFor(url, options));
  });
  renderPage();
  await screen.findByText("Synthetic failure alert");
  fireEvent(window, new Event("online"));
  await waitFor(() => expect(finishHistory).toBeTypeOf("function"));
  fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
  await waitFor(() => expect(screen.queryByText("Synthetic failure alert")).not.toBeInTheDocument());
  await act(async () => { finishHistory(response({ posts: [] })); });
  expect(screen.queryByText("Synthetic failure alert")).not.toBeInTheDocument();
});

// Route overrides on top of the base fixture: a handler returns a Response, or
// undefined to fall through to the base fixture.
function routeFetch(handlers) {
  fetch.mockImplementation(async (url, options = {}) => {
    const path = String(url).replace(/^\/api/, "");
    for (const [match, handler] of handlers) {
      if (path.startsWith(match)) {
        const result = handler(options, path);
        if (result) return result;
      }
    }
    return response(fixtureFor(url, options));
  });
}
const unavailable = () => response({}, 503);

describe("Social media stale copy, failed reads and dismissal", () => {
  it("keeps a failed alert dismissal visible with a failure toast, then clears it on success", async () => {
    let deletes = 0;
    routeFetch([["/admin/social-media/alerts", (options) => {
      if (options.method === "DELETE") return ++deletes === 1 ? unavailable() : response({});
      return response({ active: true, alert: { message: "Synthetic failure alert", raised_at: "2026-09-24T00:00:00Z" } });
    }]]);
    renderPage();
    await screen.findByText("Synthetic failure alert");
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(await screen.findByText("Failed to dismiss alert: HTTP 503")).toBeInTheDocument();
    expect(screen.queryByText("Alert dismissed")).not.toBeInTheDocument();
    expect(screen.getByText("Synthetic failure alert")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(await screen.findByText("Alert dismissed")).toBeInTheDocument();
    expect(screen.queryByText("Synthetic failure alert")).not.toBeInTheDocument();
  });

  it("drops the campaign preview when its source changes and keeps caption edits otherwise", async () => {
    renderPage();
    await screen.findByText("Local Campaign");
    const saveBody = () => JSON.parse(fetch.mock.calls.filter(([url]) => url.endsWith("/campaign-builder/save")).at(-1)[1].body);
    fireEvent.click(screen.getByRole("button", { name: "Generate Drafts" }));
    const caption = await screen.findByDisplayValue("Synthetic Facebook draft");
    fireEvent.change(caption, { target: { value: "Edited caption" } });
    fireEvent.click(screen.getByRole("button", { name: "Save Draft" }));
    await waitFor(() => expect(saveBody().preview.drafts.facebook).toBe("Edited caption"));
    expect(saveBody().city).toBe("Sarasota");

    fireEvent.change(screen.getByDisplayValue("Sarasota"), { target: { value: "Bradenton" } });
    expect(screen.queryByDisplayValue("Edited caption")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save Draft" })).toBeDisabled();
    const saves = () => fetch.mock.calls.filter(([url]) => url.endsWith("/campaign-builder/save")).length;
    expect(saves()).toBe(1);

    fireEvent.click(screen.getByRole("button", { name: "Generate Drafts" }));
    await screen.findByDisplayValue("Synthetic Facebook draft");
    fireEvent.click(screen.getByRole("button", { name: "Save Draft" }));
    await waitFor(() => expect(saves()).toBe(2));
    expect(saveBody().city).toBe("Bradenton");
  });

  it("does not restore the saved preview when the form changed while the save was pending", async () => {
    let release;
    routeFetch([["/admin/social-media/campaign-builder/save", () => new Promise((resolve) => { release = resolve; })]]);
    renderPage();
    await screen.findByText("Local Campaign");
    fireEvent.click(screen.getByRole("button", { name: "Generate Drafts" }));
    await screen.findByDisplayValue("Synthetic Facebook draft");
    fireEvent.click(screen.getByRole("button", { name: "Save Draft" }));
    await waitFor(() => expect(release).toBeTypeOf("function"));
    fireEvent.change(screen.getByDisplayValue("Sarasota"), { target: { value: "Venice" } });
    const savedPreview = fixtureFor("/admin/social-media/campaign-builder/preview", { method: "POST" });
    await act(async () => { release(response({ success: true, preview: savedPreview })); });
    expect(screen.getByRole("button", { name: "Save Draft" })).toBeDisabled();
  });

  it("ignores a campaign preview that returns after the form changed", async () => {
    let release;
    routeFetch([["/admin/social-media/campaign-builder/preview", () => new Promise((resolve) => { release = resolve; })]]);
    renderPage();
    await screen.findByText("Local Campaign");
    fireEvent.click(screen.getByRole("button", { name: "Generate Drafts" }));
    await waitFor(() => expect(release).toBeTypeOf("function"));
    fireEvent.change(screen.getByDisplayValue("Sarasota"), { target: { value: "Venice" } });
    await act(async () => { release(response(fixtureFor("/admin/social-media/campaign-builder/preview", { method: "POST" }))); });
    expect(screen.queryByDisplayValue("Synthetic Facebook draft")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Generate Drafts" })).toBeEnabled();
  });

  it("does not publish captions generated for an earlier title, link or description", async () => {
    const previewFixture = { facebook: "Termite facebook caption", instagram: "", linkedin: "", gbp: "" };
    routeFetch([
      ["/admin/social-media/preview", () => response(previewFixture)],
      ["/admin/social-media/publish", () => response({ platforms: [] })],
    ]);
    renderPage(["/admin/social-media?tab=compose"]);
    const title = await screen.findByPlaceholderText("Blog post title or topic...");
    const publish = () => screen.getByRole("button", { name: "Publish All" });
    for (const [placeholder, value] of [
      ["Blog post title or topic...", "Bradenton lawn guide"],
      ["Brief description or excerpt...", "Lawn tips"],
      ["https://www.wavespestcontrol.com/blog/...", "https://example.test/lawn"],
    ]) {
      fireEvent.change(title, { target: { value: "Sarasota termite" } });
      fireEvent.click(screen.getByRole("button", { name: "Generate AI Preview" }));
      await screen.findByDisplayValue("Termite facebook caption");
      expect(publish()).toBeEnabled();
      fireEvent.change(screen.getByPlaceholderText(placeholder), { target: { value } });
      expect(screen.queryByDisplayValue("Termite facebook caption")).not.toBeInTheDocument();
      expect(publish()).toBeDisabled();
    }
    expect(fetch.mock.calls.some(([url]) => url.endsWith("/social-media/publish"))).toBe(false);
  });

  it("shows an unavailable state with retry for Graphics and Competitors, and keeps the empty state for an empty read", async () => {
    let healthy = false;
    routeFetch([
      ["/admin/social-media/review-graphics", () => (healthy ? response({ candidates: [], saved: [] }) : unavailable())],
      ["/admin/social-media/competitor-swipe", () => (healthy ? response({ profiles: [], posts: [], patterns: [] }) : unavailable())],
    ]);
    renderPage(["/admin/social-media?tab=reviews"]);
    expect(await screen.findByRole("alert")).toHaveTextContent("Review graphics unavailable: HTTP 503");
    expect(screen.queryByText("No eligible unsaved 5-star reviews found.")).not.toBeInTheDocument();
    healthy = true;
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("No eligible unsaved 5-star reviews found.")).toBeInTheDocument();

    healthy = false;
    fireEvent.click(screen.getByRole("button", { name: "Competitors" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Competitor swipe file unavailable: HTTP 503");
    healthy = true;
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("Copyable Patterns")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("shows an unknown autonomous studio status as unavailable, never as not enabled", async () => {
    let healthy = false;
    routeFetch([["/admin/social-media/autonomous/status", () => (healthy ? undefined : unavailable())]]);
    renderPage();
    expect(await screen.findByRole("alert")).toHaveTextContent("Autonomous studio status unavailable: HTTP 503");
    expect(screen.getByText("Status unknown")).toBeInTheDocument();
    expect(screen.queryByText("Not fully enabled")).not.toBeInTheDocument();
    healthy = true;
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("Autonomous")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("renders saved draft channel strings as neutral targets and keeps real failures red", async () => {
    routeFetch([["/admin/social-media/history", () => response({ posts: [
      { id: "draft", title: "Saved draft", status: "draft", created_at: "2026-10-30T12:00:00Z", platforms_posted: ["facebook", "instagram"] },
      { id: "sent", title: "Sent post", status: "failed", created_at: "2026-10-30T12:00:00Z", platforms_posted: [{ platform: "gbp", success: false }] },
    ] })]]);
    renderPage(["/admin/social-media?tab=history"]);
    await screen.findByText("Saved draft");
    const channel = (name) => screen.getByText(name).closest("span");
    expect(channel("facebook")).toHaveTextContent(/^facebook$/);
    expect(channel("instagram")).toHaveTextContent(/^instagram$/);
    // Only the real gbp failure keeps the failure rendering.
    expect(screen.queryByText(/(facebook|instagram): No/)).not.toBeInTheDocument();
    expect(screen.getAllByText(/gbp: No/).length).toBeGreaterThan(0);
  });
});
