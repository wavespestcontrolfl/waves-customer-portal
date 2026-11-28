// @vitest-environment jsdom
import React from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EmailInbox } from "./EmailMailbox";

vi.mock("./EmailReply", () => ({ default: () => <div data-testid="reply" /> }));

afterEach(cleanup);

describe("EmailMailbox extracted_data display (C2-28)", () => {
  it("reads nested extracted fields and is_urgent from classifier output", () => {
    const email = {
      id: "e1",
      gmail_thread_id: "t1",
      from_name: "Jane Doe",
      from_address: "jane@example.com",
      subject: "Termite issue",
      snippet: "Seeing swarmers",
      received_at: "2026-11-27T15:00:00Z",
      is_read: true,
      is_starred: false,
      classification: "lead_inquiry",
      extracted_data: JSON.stringify({
        category: "lead_inquiry",
        confidence: 0.95,
        is_urgent: true,
        extracted: {
          urgency_reason: "Active swarm",
          person_name: "Jane Doe",
          phone: "941-555-0100",
          service_interest: "Termite treatment",
          invoice_amount: "250.00",
        },
      }),
    };
    const mailbox = {
      stats: { total: 1, unread: 0, starred: 0, vendor: 0 },
      statsState: { loading: false, error: false },
      inboxState: { loading: false, error: false },
      threadState: { loading: false, error: false },
      messageState: { loading: false, error: false },
      total: 1,
      visibleEmails: [email],
      selectedEmail: email,
      thread: [],
      filter: "all",
      setFilter: () => {},
      search: "",
      setSearch: () => {},
      page: 1,
      setPage: () => {},
      showArchived: false,
      setShowArchived: () => {},
      openEmail: () => {},
      closeEmail: () => {},
      loadThread: () => {},
      loadEmails: () => {},
      handleStar: () => {},
      removeEmail: () => {},
      handleReclassify: () => {},
      reclassifyLabels: [],
      handleDownloadAttachment: () => {},
      pendingAction: null,
    };
    const editor = { drafts: { replies: {}, compose: {} } };

    render(<EmailInbox active mailbox={mailbox} editor={editor} />);
    expect(screen.getByText(/Urgency: Active swarm/)).toBeTruthy();
    expect(screen.getByText("941-555-0100")).toBeTruthy();
    expect(screen.getByText("Termite treatment")).toBeTruthy();
    expect(screen.getByText("$250.00")).toBeTruthy();
  });

  it("skips non-scalar extracted values without crashing React", () => {
    const email = {
      id: "e2",
      gmail_thread_id: "t2",
      from_name: "Bob",
      from_address: "bob@example.com",
      subject: "Malformed extracted",
      snippet: "Test",
      received_at: "2026-11-27T15:00:00Z",
      is_read: true,
      is_starred: false,
      classification: "other",
      extracted_data: JSON.stringify({
        category: "other",
        is_urgent: true,
        extracted: {
          urgency_reason: { nested: "bad" },
          phone: ["941-555-0100"],
          invoice_amount: { amount: 100 },
        },
      }),
    };
    const mailbox = {
      stats: { total: 1, unread: 0, starred: 0, vendor: 0 },
      statsState: { loading: false, error: false },
      inboxState: { loading: false, error: false },
      threadState: { loading: false, error: false },
      messageState: { loading: false, error: false },
      total: 1,
      visibleEmails: [email],
      selectedEmail: email,
      thread: [],
      filter: "all", setFilter: () => {}, search: "", setSearch: () => {},
      page: 1, setPage: () => {}, showArchived: false, setShowArchived: () => {},
      openEmail: () => {}, closeEmail: () => {}, loadThread: () => {}, loadEmails: () => {},
      handleStar: () => {}, removeEmail: () => {}, handleReclassify: () => {},
      reclassifyLabels: [], handleDownloadAttachment: () => {}, pendingAction: null,
    };
    render(<EmailInbox active mailbox={mailbox} editor={{ drafts: { replies: {}, compose: {} } }} />);
    expect(screen.getByText(/Urgency: High/)).toBeTruthy();
  });
});
