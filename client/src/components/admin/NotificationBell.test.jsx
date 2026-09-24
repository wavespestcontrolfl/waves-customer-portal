// @vitest-environment jsdom
import React from "react";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import NotificationBell from "./NotificationBell";

vi.mock("../../lib/push-subscribe.js", () => ({
  ensurePushSubscription: vi.fn(async () => ({ ok: true })),
  isPushEnabled: vi.fn(async () => true),
}));

function jsonResponse(body) {
  return { ok: true, json: async () => body };
}

beforeEach(() => {
  global.fetch = vi.fn(async (url) => {
    if (String(url).includes("/unread-count")) return jsonResponse({ count: 0 });
    return jsonResponse({ notifications: [] });
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("admin NotificationBell settings gear", () => {
  it("deep-links to the notification events tab (CommunicationsPageV2 reads #tab=events), not the retired #notifications hash", async () => {
    render(<NotificationBell />);
    fireEvent.click(screen.getByTitle("Notifications"));
    const link = await screen.findByRole("link", { name: /notification settings/i });
    expect(link).toHaveAttribute("href", "/admin/communications#tab=events");
  });
});
