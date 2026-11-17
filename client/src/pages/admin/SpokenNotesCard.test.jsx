// @vitest-environment jsdom
import React from "react";
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import CallLogTabV2, { SpokenNotesCard } from "./CallLogTabV2";

const live = (spoken) => ({ live_transcription: { spoken_notes: spoken } });

describe("SpokenNotesCard", () => {
  afterEach(cleanup);

  it("shows the notes and each reminder with its due time in Eastern time", () => {
    render(
      <SpokenNotesCard
        metadata={live({
          notes: ["Gate code is on the lockbox."],
          // 2026-11-18 14:30 UTC = 9:30 AM EST; 2026-07-01 17:00 UTC = 1:00 PM EDT
          reminders: [
            { text: "Call Jordan Example back", due_at: "2026-11-18T14:30:00.000Z", raised_at: null },
            { text: "Send the quote", due_at: "2026-07-01T17:00:00.000Z", raised_at: null },
          ],
        })}
      />,
    );
    expect(screen.getByText("Notes from the call")).toBeInTheDocument();
    expect(screen.getByText("Gate code is on the lockbox.")).toBeInTheDocument();
    expect(screen.getByText("Reminders")).toBeInTheDocument();
    expect(screen.getByText(/Call Jordan Example back/)).toHaveTextContent("Nov 18, 9:30 AM ET");
    expect(screen.getByText(/Send the quote/)).toHaveTextContent("Jul 1, 1:00 PM ET");
  });

  it("hides the Reminders block when there are only notes, and the Notes block when there are only reminders", () => {
    const { rerender } = render(<SpokenNotesCard metadata={live({ notes: ["Dog is friendly."], reminders: [] })} />);
    expect(screen.getByText("Notes from the call")).toBeInTheDocument();
    expect(screen.queryByText("Reminders")).toBeNull();
    rerender(<SpokenNotesCard metadata={live({ notes: [], reminders: [{ text: "Call back", due_at: "2026-11-18T14:30:00.000Z" }] })} />);
    expect(screen.queryByText("Notes from the call")).toBeNull();
    expect(screen.getByText("Reminders")).toBeInTheDocument();
  });

  it("renders nothing when there is nothing to show, including metadata sent as a string", () => {
    for (const metadata of [null, {}, live({ checked_at: "x", notes: [], reminders: [] }), live({ notes: ["  "], reminders: [{ text: "" }] }), "not json"]) {
      const { container, unmount } = render(<SpokenNotesCard metadata={metadata} />);
      expect(container).toBeEmptyDOMElement();
      unmount();
    }
    render(<SpokenNotesCard metadata={JSON.stringify(live({ notes: ["From a string."], reminders: [] }))} />);
    expect(screen.getByText("From a string.")).toBeInTheDocument();
  });
});

describe("Calls tab row", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn(async (url) => ({
      ok: true,
      json: async () => (String(url).includes("/admin/calls")
        ? {
            calls: [{
              id: "call-1",
              direction: "inbound",
              from_phone: "+19415550123",
              answered_by: "missed",
              created_at: new Date().toISOString(),
              transcription: "Hello, this is a short call about ants.",
              metadata: live({ notes: ["Gate code is on the lockbox."], reminders: [] }),
            }],
          }
        : {}),
    })));
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("shows the notes directly after the transcription block", async () => {
    render(<MemoryRouter><CallLogTabV2 /></MemoryRouter>);
    const card = await screen.findByTestId("spoken-notes-card");
    const transcription = screen.getByText("Transcription", { exact: false }).closest("div.bg-zinc-50");
    expect(transcription.nextElementSibling).toBe(card);
    expect(card).toHaveTextContent("Gate code is on the lockbox.");
  });
});
