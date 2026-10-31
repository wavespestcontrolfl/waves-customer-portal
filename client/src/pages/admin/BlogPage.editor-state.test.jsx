// @vitest-environment jsdom
import React from "react";
import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./ContentCalendar", () => ({ default: () => <div>Calendar</div> }));
vi.mock("./AutonomousContentReviewPage", () => ({
  default: () => <div>Autopilot</div>,
}));
vi.mock("./ContentRegistryPage", () => ({ default: () => <div>Registry</div> }));

import BlogPage from "./BlogPage";

// Audit 2026-10-30 (BLOG-01, 06, 07, 08, 11, 12): editor responses keep
// unsaved edits, failures say so, removal shows the draft it left, the Posts
// search keeps focus while loading, and the list pages past one response.

const basePost = {
  id: "post-17",
  title: "Synthetic termite guide",
  content: "Synthetic article content",
  meta_description: "Synthetic description",
  keyword: "synthetic termites",
  tag: "Termites",
  city: "Sarasota",
  status: "draft",
  author_slug: "author-1",
  service_areas_tag: ["Sarasota"],
  related_services: [],
  target_sites: ["wavespestcontrol.com"],
  hero_image_alt: "Synthetic termite evidence",
  featured_image_url: "https://example.invalid/old.jpg",
  word_count: 3,
  seo_score: 72,
};

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

let routes;
function stubFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url, options = {}) => {
      const parsed = new URL(String(url), "http://localhost");
      const key = `${options.method || "GET"} ${parsed.pathname}`;
      const handler = routes[key];
      if (handler) return handler(parsed, options);
      if (parsed.pathname === "/api/admin/content/authors")
        return json({ authors: [] });
      if (parsed.pathname === "/api/public/service-areas")
        return json({ serviceAreas: [] });
      return json({});
    }),
  );
}

function openEditor(post) {
  routes["GET /api/admin/content/blog/post-17"] = () => json({ post });
  render(
    <MemoryRouter initialEntries={["/admin/blog?post=post-17"]}>
      <BlogPage />
    </MemoryRouter>,
  );
  return screen.findByDisplayValue(post.title);
}

beforeEach(() => {
  localStorage.setItem("waves_admin_token", "synthetic-token");
  routes = {};
  stubFetch();
});

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Blog editor keeps unsaved edits (BLOG-06)", () => {
  it("a new hero image does not undo an unsaved title", async () => {
    routes["POST /api/admin/content/blog/post-17/regenerate-image"] = () =>
      json({
        success: true,
        post: { ...basePost, featured_image_url: "https://example.invalid/new.jpg" },
      });
    const title = await openEditor(basePost);
    fireEvent.change(title, { target: { value: "Corrected title" } });
    fireEvent.click(screen.getByRole("button", { name: "Regenerate image" }));

    await waitFor(() =>
      expect(screen.getByAltText("Featured")).toHaveAttribute(
        "src",
        "https://example.invalid/new.jpg",
      ),
    );
    expect(screen.getByDisplayValue("Corrected title")).toBeInTheDocument();
  });

  it("a status refresh takes the Astro state but not the saved title", async () => {
    const open = { ...basePost, astro_status: "pr_open", astro_branch_name: "b-1", astro_pr_number: 7 };
    routes["POST /api/admin/content/blog/post-17/refresh-astro"] = () =>
      json({
        success: true,
        post: { ...open, astro_preview_url: "https://preview.invalid/p" },
      });
    const title = await openEditor(open);
    fireEvent.change(title, { target: { value: "Corrected title" } });
    fireEvent.click(screen.getByRole("button", { name: "Refresh status" }));

    await screen.findByRole("link", { name: /open preview/i });
    expect(screen.getByDisplayValue("Corrected title")).toBeInTheDocument();
  });
});

describe("Blog editor failures are visible (BLOG-11)", () => {
  it("a failed status refresh says so", async () => {
    routes["POST /api/admin/content/blog/post-17/refresh-astro"] = () =>
      json({ error: "Pages API down" }, 503);
    await openEditor({ ...basePost, astro_status: "pr_open", astro_branch_name: "b-1", astro_pr_number: 7 });
    fireEvent.click(screen.getByRole("button", { name: "Refresh status" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      /Couldn't refresh the publish status/,
    );
  });

  it("a failed image retry shows even when a hero is already there", async () => {
    routes["POST /api/admin/content/blog/post-17/regenerate-image"] = () =>
      json({ error: "Image screen flagged text" }, 400);
    await openEditor(basePost);
    fireEvent.click(screen.getByRole("button", { name: "Regenerate image" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Image not changed. Last attempt: Image screen flagged text",
    );
    expect(screen.getByAltText("Featured")).toHaveAttribute(
      "src",
      "https://example.invalid/old.jpg",
    );
  });
});

describe("Approve & Remove shows the draft it left (BLOG-07)", () => {
  it("asks about removal and applies the row the server returns", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    const removing = {
      ...basePost,
      status: "published",
      astro_status: "unpublish_pending",
      astro_pr_number: 9,
      astro_branch_name: "revert-1",
      astro_live_url: "https://www.wavespestcontrol.invalid/old/",
    };
    routes["POST /api/admin/content/blog/post-17/merge-astro"] = () =>
      json({
        success: true,
        merged: true,
        unpublished: true,
        live_url: null,
        post: {
          ...removing,
          status: "draft",
          astro_status: "draft",
          astro_pr_number: null,
          astro_branch_name: null,
          astro_live_url: null,
        },
      });
    await openEditor(removing);
    fireEvent.click(screen.getByRole("button", { name: "Approve & Remove" }));

    expect(confirm.mock.calls[0][0]).toMatch(/removal PR/);
    await screen.findByRole("button", { name: "Publish to Astro (preview)" });
    expect(screen.queryByText(/Live build in progress/i)).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /view live/i })).not.toBeInTheDocument();
  });
});

describe("Approve & Remove without the row in the response", () => {
  it("still shows the draft a removal leaves", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    routes["POST /api/admin/content/blog/post-17/merge-astro"] = () =>
      json({ success: true, merged: true, unpublished: true, live_url: null, post: null });
    await openEditor({
      ...basePost,
      status: "published",
      astro_status: "unpublish_pending",
      astro_pr_number: 9,
      astro_branch_name: "revert-1",
      astro_live_url: "https://www.wavespestcontrol.invalid/old/",
    });
    fireEvent.click(screen.getByRole("button", { name: "Approve & Remove" }));
    await screen.findByRole("button", { name: "Publish to Astro (preview)" });
    expect(screen.queryByText(/Live build in progress/i)).not.toBeInTheDocument();
  });
});

describe("Save Draft says where an edit stops (BLOG-01)", () => {
  it("names the open preview and the live page", async () => {
    await openEditor({ ...basePost, astro_status: "pr_open", astro_branch_name: "b-1", astro_pr_number: 7 });
    expect(
      screen.getByText(/Saved edits do not update this preview/),
    ).toBeInTheDocument();
    cleanup();

    await openEditor({ ...basePost, status: "published", astro_status: "live" });
    expect(
      screen.getByText(/Saved edits do not update the live page/),
    ).toBeInTheDocument();
  });

  it("stays quiet on a plain draft", async () => {
    await openEditor(basePost);
    expect(screen.queryByText(/Saved edits do not/)).not.toBeInTheDocument();
  });
});

describe("Posts list (BLOG-08, BLOG-12)", () => {
  it("Search stays mounted and focused while results load", async () => {
    let release;
    routes["GET /api/admin/content/blog"] = (parsed) =>
      parsed.searchParams.get("search")
        ? new Promise((resolve) => {
            release = () => resolve(json({ posts: [], counts: {}, total: 0 }));
          })
        : json({ posts: [basePost], counts: {}, total: 1 });
    render(
      <MemoryRouter initialEntries={["/admin/blog?status=draft"]}>
        <BlogPage />
      </MemoryRouter>,
    );
    await screen.findByText("Synthetic termite guide");

    const search = screen.getByPlaceholderText("Search...");
    search.focus();
    fireEvent.change(search, { target: { value: "t" } });
    await screen.findByText("Loading posts...");
    expect(screen.getByPlaceholderText("Search...")).toBe(search);
    expect(document.activeElement).toBe(search);
    fireEvent.change(search, { target: { value: "termite" } });
    expect(search).toHaveValue("termite");
    await act(async () => release());
  });

  it("pages by offset and shows the range of the total", async () => {
    routes["GET /api/admin/content/blog"] = (parsed) =>
      json({
        posts: [{ ...basePost, id: `p-${parsed.searchParams.get("offset") || 0}` }],
        counts: {},
        total: 450,
      });
    render(
      <MemoryRouter initialEntries={["/admin/blog?status=draft"]}>
        <BlogPage />
      </MemoryRouter>,
    );
    expect(await screen.findByText("1–1 of 450 posts")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Previous" })).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(await screen.findByText("2–2 of 450 posts")).toBeInTheDocument();
    expect(
      fetch.mock.calls.some(([url]) =>
        /\/admin\/content\/blog\?status=draft&limit=200&offset=1(&|$)/.test(String(url)),
      ),
    ).toBe(true);

    fireEvent.change(screen.getByPlaceholderText("Search..."), {
      target: { value: "ant" },
    });
    await waitFor(() =>
      expect(String(fetch.mock.calls.at(-1)[0])).not.toMatch(/offset=/),
    );
  });
});
