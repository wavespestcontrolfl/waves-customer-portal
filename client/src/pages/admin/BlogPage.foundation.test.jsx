// @vitest-environment jsdom
import React from "react";
import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./ContentCalendar", () => ({
  default: () => <div>Calendar workspace</div>,
}));
vi.mock("./AutonomousContentReviewPage", () => ({
  default: () => <div>Autopilot workspace</div>,
}));
vi.mock("./ContentRegistryPage", () => ({
  default: () => <div>Registry workspace</div>,
}));

import BlogPage from "./BlogPage";

const post = {
  id: "post-17",
  title: "Synthetic termite guide",
  content: "Synthetic article content",
  meta_description:
    "Synthetic description long enough to exercise the existing blog editor fields without changing their behavior.",
  keyword: "synthetic termites",
  tag: "Termites",
  city: "Sarasota",
  status: "draft",
  author_slug: "author-1",
  reviewer_slug: "",
  technically_reviewed_at: null,
  fact_checked_at: null,
  category: "termite",
  post_type: "diagnostic",
  service_areas_tag: ["Sarasota"],
  related_services: [],
  target_sites: ["wavespestcontrol.com"],
  hero_image_alt: "Synthetic termite evidence",
  featured_image_url: "https://example.invalid/blog.jpg",
  word_count: 3,
  seo_score: 72,
};

const jsonResponse = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

function LocationSearch() {
  return <output data-testid="location-search">{useLocation().search}</output>;
}

function fixture(url, options = {}) {
  const parsed = new URL(String(url), "http://localhost");
  if (parsed.pathname === "/api/admin/content/blog/analytics")
    return { byStatus: { published: 1, draft: 1, queued: 2, idea: 3 } };
  if (parsed.pathname === "/api/admin/content/blog")
    return { posts: [post], counts: {} };
  if (parsed.pathname === "/api/admin/content/weather")
    return {
      weather: {
        temp: 88,
        humidity: 70,
        rainfall: 1.2,
        soilTemp: 81,
        station: "Synthetic station",
      },
      signals: ["Synthetic seasonal signal"],
    };
  if (parsed.pathname === "/api/admin/content/blog/audit")
    return {
      audit: {
        total: 10,
        published: 4,
        drafts: 1,
        queued: 2,
        ideas: 3,
        recommendations: [
          {
            priority: "critical",
            title: "Synthetic content gap",
            action: "Review the synthetic fixture before publishing.",
          },
        ],
        topicDistribution: {
          counts: { Termites: 4, Mosquitoes: 6 },
          gaps: ["Synthetic rodent guide"],
        },
        cityDistribution: {
          counts: { Sarasota: 6, Bradenton: 4 },
          overrepresented: [{ city: "Sarasota" }],
        },
        duplicates: [],
        topPerformers: [{ score: 91, title: "Synthetic top performer" }],
      },
    };
  if (parsed.pathname === "/api/admin/content/authors")
    return {
      authors: [
        { slug: "author-1", name: "Synthetic author", fdacs_license: null },
      ],
    };
  if (parsed.pathname === "/api/public/service-areas")
    return { serviceAreas: [{ slug: "sarasota", city: "Sarasota" }] };
  if (
    parsed.pathname === "/api/admin/content/blog/post-17" &&
    options.method === "PUT"
  )
    return { post: { ...post, ...JSON.parse(options.body) } };
  if (parsed.pathname === "/api/admin/content/blog/post-17") return { post };
  if (
    parsed.pathname === "/api/admin/content/generate" &&
    options.method === "POST"
  )
    return { id: "generated-post" };
  return {};
}

beforeEach(() => {
  localStorage.setItem("waves_admin_token", "synthetic-token");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url, options = {}) => jsonResponse(fixture(url, options))),
  );
});

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.unstubAllGlobals();
});

describe("Blog workspace foundation", () => {
  it("resolves legacy status links and keeps unrelated URL state", async () => {
    render(
      <MemoryRouter initialEntries={["/admin/blog?tab=drafts&keep=yes"]}>
        <BlogPage />
        <LocationSearch />
      </MemoryRouter>,
    );

    await screen.findByText("Synthetic termite guide");
    expect(
      fetch.mock.calls.some(([url]) =>
        String(url).includes("/admin/content/blog?status=draft"),
      ),
    ).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Queued (2)" }));
    await waitFor(() =>
      expect(
        fetch.mock.calls.some(([url]) =>
          String(url).includes("/admin/content/blog?status=queued"),
        ),
      ).toBe(true),
    );
    expect(screen.getByTestId("location-search")).toHaveTextContent("keep=yes");
    expect(screen.getByTestId("location-search")).toHaveTextContent(
      "tab=posts",
    );
    expect(screen.getByTestId("location-search")).toHaveTextContent(
      "status=queued",
    );
  });

  it("keeps the generate request and draft handoff intact", async () => {
    render(
      <MemoryRouter initialEntries={["/admin/blog?tab=generate&keep=yes"]}>
        <BlogPage />
        <LocationSearch />
      </MemoryRouter>,
    );

    fireEvent.click(await screen.findByText("Page Refresh", { exact: true }));
    fireEvent.change(
      screen.getByPlaceholderText(
        "Describe the topic or paste a working title...",
      ),
      { target: { value: "Synthetic refresh topic" } },
    );
    fireEvent.click(screen.getByRole("button", { name: "Sarasota" }));
    fireEvent.click(
      screen.getByRole("button", { name: "Generate Page Refresh" }),
    );

    await waitFor(() =>
      expect(fetch).toHaveBeenCalledWith(
        "/api/admin/content/generate",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({
            topic: "Synthetic refresh topic",
            contentType: "page_refresh",
            targetCity: "Sarasota",
          }),
        }),
      ),
    );
    expect(screen.getByTestId("location-search")).toHaveTextContent("keep=yes");
    expect(screen.getByTestId("location-search")).toHaveTextContent(
      "tab=posts",
    );
    expect(screen.getByTestId("location-search")).toHaveTextContent(
      "status=draft",
    );
  });

  it("renders the editor fields and preserves the save payload", async () => {
    render(
      <MemoryRouter initialEntries={["/admin/blog?status=draft"]}>
        <BlogPage />
        <LocationSearch />
      </MemoryRouter>,
    );

    fireEvent.click(await screen.findByText("Synthetic termite guide"));
    const title = await screen.findByDisplayValue("Synthetic termite guide");
    expect(screen.getByTestId("location-search")).toHaveTextContent(
      "post=post-17",
    );
    fireEvent.change(title, { target: { value: "Edited synthetic guide" } });
    fireEvent.click(screen.getByRole("button", { name: "Save Draft" }));

    await waitFor(() => {
      const request = fetch.mock.calls.find(
        ([url, options]) =>
          String(url).endsWith("/admin/content/blog/post-17") &&
          options?.method === "PUT",
      );
      expect(request).toBeTruthy();
      expect(JSON.parse(request[1].body)).toEqual({
        title: "Edited synthetic guide",
        content: post.content,
        meta_description: post.meta_description,
        keyword: post.keyword,
        tag: post.tag,
        status: post.status,
        author_slug: post.author_slug,
        reviewer_slug: null,
        technically_reviewed_at: null,
        fact_checked_at: null,
        category: post.category,
        post_type: post.post_type,
        service_areas_tag: post.service_areas_tag,
        related_services: post.related_services,
        target_sites: ["wavespestcontrol.com"],
        hero_image_alt: post.hero_image_alt,
      });
    });

    await waitFor(() =>
      expect(screen.getByTestId("location-search")).not.toHaveTextContent(
        "post=post-17",
      ),
    );

    expect(
      within(
        screen.getByRole("navigation", { name: "Blog section" }),
      ).getByRole("button", { name: "Posts" }),
    ).toBeInTheDocument();
  });

  it("preserves the existing audit scorecard and distribution charts", async () => {
    render(
      <MemoryRouter initialEntries={["/admin/blog?tab=audit"]}>
        <BlogPage />
      </MemoryRouter>,
    );

    expect(await screen.findByText("Content Health Scorecard")).toBeVisible();
    expect(screen.getByText("By Topic")).toBeVisible();
    expect(screen.getByText("By City")).toBeVisible();
    expect(screen.getByText("Synthetic top performer")).toBeVisible();
    expect(screen.getByText("Synthetic content gap")).toBeVisible();
    expect(screen.getByText(/Synthetic rodent guide/)).toBeVisible();
  });

  it("does not apply Blog token overrides to lazy embedded workspaces", async () => {
    render(
      <MemoryRouter initialEntries={["/admin/blog?tab=autopilot"]}>
        <BlogPage />
      </MemoryRouter>,
    );

    expect(await screen.findByText("Autopilot workspace")).toBeVisible();
    expect(document.querySelector(".admin-blog-token-scope")).toBeNull();
  });

  it("opens bookmarked posts directly and keeps list parameters on close", async () => {
    render(
      <MemoryRouter
        initialEntries={[
          "/admin/blog?tab=posts&status=draft&post=post-17&keep=yes",
        ]}
      >
        <BlogPage />
        <LocationSearch />
      </MemoryRouter>,
    );

    expect(
      await screen.findByDisplayValue("Synthetic termite guide"),
    ).toBeVisible();
    expect(
      fetch.mock.calls.some(([url]) =>
        String(url).endsWith("/admin/content/blog/post-17"),
      ),
    ).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: /Back to list/ }));
    await screen.findByText("Synthetic termite guide");
    expect(screen.getByTestId("location-search")).toHaveTextContent("keep=yes");
    expect(screen.getByTestId("location-search")).toHaveTextContent(
      "status=draft",
    );
    expect(screen.getByTestId("location-search")).not.toHaveTextContent(
      "post=post-17",
    );
  });

  it("recovers a bookmarked post after a failed read", async () => {
    let reads = 0;
    fetch.mockImplementation(async (url, options = {}) => {
      const parsed = new URL(String(url), "http://localhost");
      if (
        parsed.pathname === "/api/admin/content/blog/post-17" &&
        !options.method
      ) {
        reads += 1;
        if (reads === 1)
          return jsonResponse({ error: "Synthetic read failed" }, 503);
      }
      return jsonResponse(fixture(url, options));
    });

    render(
      <MemoryRouter initialEntries={["/admin/blog?post=post-17"]}>
        <BlogPage />
      </MemoryRouter>,
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Synthetic read failed",
    );
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(
      await screen.findByDisplayValue("Synthetic termite guide"),
    ).toBeVisible();
    expect(reads).toBe(2);
  });
});
