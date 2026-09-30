// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import CustomerEngagementTimeline from "./CustomerEngagementTimeline";

const ev = (id, kind, title, extra = {}) => ({
  id, at: "2026-09-20T15:00:00.000Z", channel: "sms", kind, title, detail: null, engaged: ["clicked", "viewed", "replied"].includes(kind), ...extra,
});

function respond(body, status = 200) {
  return { ok: status < 400, status, json: async () => body };
}

describe("CustomerEngagementTimeline", () => {
  beforeEach(() => { localStorage.setItem("waves_admin_token", "t"); });
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

  it("renders nothing at all while the gate is dark", async () => {
    const fetchMock = vi.fn(async () => respond({ enabled: false }));
    vi.stubGlobal("fetch", fetchMock);
    const { container } = render(<CustomerEngagementTimeline customerId="c1" />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(String(fetchMock.mock.calls[0][0])).toContain("/admin/customers/c1/activity");
    expect(container).toBeEmptyDOMElement();
  });

  it("never fetches or renders for a non-admin viewer", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { container } = render(<CustomerEngagementTimeline customerId="c1" adminOnly={false} />);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(container).toBeEmptyDOMElement();
  });

  it("badges only first-party evidence as Engaged and labels the informational summary fields", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => respond({
      enabled: true,
      events: [
        ev("a", "replied", "Replied by text", { detail: "Sounds good" }),
        ev("b", "opened", "Email opened (not reliable)", { channel: "email" }),
        ev("c", "clicked", "Clicked the invoice link"),
        ev("d", "viewed", "Opened the appointment page", { channel: "page" }),
        ev("e", "sent", "Text sent"),
        ev("f", "provider_clicked", "Link clicked (reported by email provider — may be a scanner)", { channel: "email", detail: "Your estimate · to s***@example.test" }),
        ev("g", "viewed_unfiltered", "Viewed their estimate (unfiltered)", { channel: "page" }),
      ],
      hasMore: false,
      summary: {
        lastEngagedAt: "2026-09-20T15:00:00.000Z",
        lastEmailOpenAt: "2026-09-21T15:00:00.000Z",
        lastProviderClickAt: "2026-09-22T15:00:00.000Z",
        lastSeenAt: "2026-09-23T15:00:00.000Z",
      },
      unavailableSources: [],
    })));
    render(<CustomerEngagementTimeline customerId="c1" />);
    const list = within(await screen.findByRole("list", { name: "Customer engagement history" }));
    const badged = (title) => within(list.getByText(title).closest("li")).queryByText("Engaged");
    expect(badged("Replied by text")).toBeInTheDocument();
    expect(badged("Clicked the invoice link")).toBeInTheDocument();
    expect(badged("Opened the appointment page")).toBeInTheDocument();
    expect(badged("Email opened (not reliable)")).not.toBeInTheDocument();
    expect(badged("Text sent")).not.toBeInTheDocument();
    expect(badged("Link clicked (reported by email provider — may be a scanner)")).not.toBeInTheDocument();
    expect(badged("Viewed their estimate (unfiltered)")).not.toBeInTheDocument();
    expect(screen.getByText("Your estimate · to s***@example.test")).toBeInTheDocument();
    expect(screen.getByTestId("engagement-summary")).toHaveTextContent(/Last engaged/);
    expect(screen.getByTestId("engagement-last-open")).toHaveTextContent(/unreliable/i);
    expect(screen.getByTestId("engagement-last-provider-click")).toHaveTextContent(/unfiltered/i);
    expect(screen.getByTestId("engagement-last-provider-click")).toHaveTextContent(/not counted/i);
    expect(screen.queryByText(/Not tracked yet/)).not.toBeInTheDocument();
    // presence line: shown when the server sent it, and it is not the engagement line
    expect(screen.getByTestId("engagement-last-seen")).toHaveTextContent(/Last seen in the portal or app Sep 23/);
    expect(screen.getByTestId("engagement-summary")).not.toHaveTextContent(/Sep 23/);
  });

  it("omits the last-seen line when the customer has never been seen", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => respond({
      enabled: true, events: [ev("a", "sent", "Text sent")], hasMore: false,
      summary: { lastEngagedAt: null, lastEmailOpenAt: null, lastSeenAt: null }, unavailableSources: [],
    })));
    render(<CustomerEngagementTimeline customerId="c1" />);
    await screen.findByTestId("engagement-summary");
    expect(screen.queryByTestId("engagement-last-seen")).not.toBeInTheDocument();
  });

  it("draws a channel-less link click with the neutral link icon, not the text icon", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => respond({
      enabled: true,
      events: [
        ev("a", "clicked", "Clicked the invoice link", { channel: "link" }),
        ev("b", "clicked", "Clicked the estimate link", { channel: "sms" }),
      ],
      hasMore: false,
      summary: { lastEngagedAt: "2026-09-20T15:00:00.000Z" },
      unavailableSources: [],
    })));
    render(<CustomerEngagementTimeline customerId="c1" />);
    const list = within(await screen.findByRole("list", { name: "Customer engagement history" }));
    expect(within(list.getByText("Clicked the invoice link").closest("li")).getByLabelText("Link")).toBeInTheDocument();
    expect(within(list.getByText("Clicked the estimate link").closest("li")).getByLabelText("Text")).toBeInTheDocument();
  });

  it("loads older events with the cursor and appends them without repeats", async () => {
    const fetchMock = vi.fn(async (url) => {
      if (String(url).includes("before=")) {
        return respond({ enabled: true, events: [ev("a", "sent", "Text sent"), ev("z", "sent", "Older text")], hasMore: false, nextCursor: null });
      }
      return respond({ enabled: true, events: [ev("a", "sent", "Text sent")], hasMore: true, nextCursor: "2026-09-20T15:00:00.000Z",
        summary: { lastEngagedAt: null, lastEmailOpenAt: null } });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<CustomerEngagementTimeline customerId="c1" />);
    fireEvent.click(await screen.findByRole("button", { name: "Load older" }));
    await screen.findByText("Older text");
    expect(String(fetchMock.mock.calls[1][0])).toContain("before=2026-09-20T15%3A00%3A00.000Z");
    expect(screen.getAllByText("Text sent")).toHaveLength(1);
    expect(screen.queryByRole("button", { name: "Load older" })).not.toBeInTheDocument();
    // the first-page summary survives paging
    expect(screen.getByTestId("engagement-summary")).toHaveTextContent("No engagement recorded yet");
  });

  it("a late response for the previous customer never lands under the new one", async () => {
    const pending = {};
    vi.stubGlobal("fetch", vi.fn((url) => new Promise((resolve) => {
      const id = String(url).match(/customers\/([^/]+)\/activity/)[1];
      pending[id] = () => resolve(respond({ enabled: true, events: [ev(`e-${id}`, "sent", `Text for ${id}`)], hasMore: false }));
    })));
    const { rerender } = render(<CustomerEngagementTimeline customerId="A" />);
    rerender(<CustomerEngagementTimeline customerId="B" />);
    pending.A();
    pending.B();
    await screen.findByText("Text for B");
    expect(screen.queryByText("Text for A")).not.toBeInTheDocument();
  });

  it("shows a retry when the request fails", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(respond({ error: "boom" }, 500))
      .mockResolvedValueOnce(respond({ enabled: true, events: [], hasMore: false }));
    vi.stubGlobal("fetch", fetchMock);
    render(<CustomerEngagementTimeline customerId="c1" />);
    fireEvent.click(await screen.findByRole("button", { name: "Retry" }));
    await screen.findByText("Nothing recorded for this customer yet.");
  });

  it("a failed Load older keeps the loaded events, says so, and retries the same cursor", async () => {
    const cursor = "2026-09-20T15:00:00.000Z";
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(respond({ enabled: true, events: [ev("a", "sent", "Text sent")], hasMore: true, nextCursor: cursor, summary: { lastEngagedAt: null, lastEmailOpenAt: null } }))
      .mockResolvedValueOnce(respond({ error: "boom" }, 500))
      .mockResolvedValueOnce(respond({ enabled: true, events: [ev("z", "sent", "Older text")], hasMore: false, nextCursor: null }));
    vi.stubGlobal("fetch", fetchMock);
    render(<CustomerEngagementTimeline customerId="c1" />);
    fireEvent.click(await screen.findByRole("button", { name: "Load older" }));
    expect(await screen.findByText("Could not load older events.")).toBeInTheDocument();
    // loaded events and the summary stay visible; the first-load error box is not used
    expect(screen.getByText("Text sent")).toBeInTheDocument();
    expect(screen.getByTestId("engagement-summary")).toBeInTheDocument();
    expect(screen.queryByText("Could not load engagement activity.")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await screen.findByText("Older text");
    expect(String(fetchMock.mock.calls[2][0])).toContain("before=2026-09-20T15%3A00%3A00.000Z");
    expect(screen.queryByText("Could not load older events.")).not.toBeInTheDocument();
    expect(screen.getByText("Text sent")).toBeInTheDocument();
  });
});
