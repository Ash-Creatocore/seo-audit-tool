# SEO Audit Tool

A self-hosted, full-site SEO crawler and audit dashboard — similar in spirit to
Semrush Site Audit, SEO Site Checkup, or Seobility. Give it a URL, it crawls the
site (same-origin, respecting `robots.txt`), analyzes every page it finds, and
gives you a scored report across three tabs: **On-Page SEO**, **Site Crawl**,
and **Google Index & Rank**.

**Every number in this tool is either computed from a real crawl/API call, or
the UI explicitly says it's not configured. Nothing is ever faked, randomized,
or hard-coded to look plausible.** That includes the two optional Google
integrations below — if you don't add API keys, those sections show an honest
"unavailable — not configured" message instead of a made-up score.

## What it checks

**Per page:** title tag (missing/too short/too long), meta description
(missing/short/long), H1 tags (missing/multiple), thin content (word count),
images missing `alt` text, canonical tag (missing/not self-referencing), mobile
viewport meta tag, HTTPS usage, HTTP status (4xx/5xx, redirects), slow response
time, `noindex` detection, Open Graph tags, Twitter Card tags, structured data
(JSON-LD/microdata).

**Site-wide (Site Crawl tab):** `robots.txt` present, `sitemap.xml` present,
duplicate titles across pages, duplicate meta descriptions across pages,
broken internal/external links, orphan pages (in the sitemap but not linked
from anywhere crawled), crawl-depth distribution, a per-page score, and an
overall **Site Health** score.

**Core Web Vitals (On-Page tab):** real LCP / CLS / INP / Performance score
from the Google PageSpeed Insights API (free, real-user field data when
available, Lighthouse lab data otherwise). Requires a free API key — see
below.

**Google Index & Rank tab:** an indexing heuristic (a live `site:` query
against the Google Custom Search API) and a keyword rank tracker (pages
through real Custom Search results looking for your domain), with
Change/Best-Position computed from a small local history file. Requires two
free API credentials — see below.

Each finding is scored **error / warning / notice**, rolled into an overall
0–100 SEO score, and grouped into a "Top issues" list showing how many pages
each issue affects (click a row to see the URLs).

## Requirements

- Node.js 18+

## Run it

```bash
npm install
npm start
```

Then open **http://localhost:3000**, enter a URL, choose how many pages to
crawl (10–100), and click **Run audit**. Results update live as pages are
crawled.

Set a different port with `PORT=8080 npm start`.

## Optional: enable the real Google integrations

Without these, the tool still works fully for crawling and on-page analysis —
the Core Web Vitals and Google Index & Rank sections will just show an honest
"not configured" message instead of data.

### 1. Core Web Vitals — Google PageSpeed Insights API (free)

1. Go to the [Google Cloud Console](https://console.cloud.google.com/), create
   or select a project.
2. Enable the **PageSpeed Insights API** (APIs & Services → Library → search
   for it → Enable).
3. Create an API key (APIs & Services → Credentials → Create Credentials →
   API key). Optionally restrict it to the PageSpeed Insights API.
4. Set it before starting the server:
   ```bash
   export GOOGLE_PAGESPEED_API_KEY=your-key-here
   npm start
   ```

This API is free with generous quota (no billing required for typical use).

### 2. Indexing & Rank Tracking — Google Custom Search JSON API (free tier)

This uses Google's official Custom Search API — not scraping — to check
indexing and approximate keyword rank. Free tier is **100 queries/day**; each
rank-tracker keyword uses up to 3 queries (paging through the top 30 results).

1. In the same Google Cloud project, enable the **Custom Search API**.
2. Create (or reuse) an API key as above → this is `GOOGLE_CUSTOM_SEARCH_API_KEY`.
3. Create a Programmable Search Engine at
   [programmablesearchengine.google.com](https://programmablesearchengine.google.com/):
   set it to **"Search the entire web"**, then copy its **Search engine ID**
   → this is `GOOGLE_CUSTOM_SEARCH_ENGINE_ID`.
4. Set both before starting the server:
   ```bash
   export GOOGLE_CUSTOM_SEARCH_API_KEY=your-key-here
   export GOOGLE_CUSTOM_SEARCH_ENGINE_ID=your-search-engine-id
   npm start
   ```

**Honest limitations, stated in the UI itself:** indexing status is a `site:`
query heuristic, not official Search Console data. Rank position is bounded
by what the Custom Search API returns (top 30 by default, top 100 max on the
free quota) — a keyword ranking below that shows as "not in top results," not
a guessed number. Search volume is intentionally omitted rather than
estimated, since that requires a paid keyword-data source this tool doesn't
integrate.

## How it works

- `src/crawler.js` — BFS crawler. Fetches `robots.txt` and `sitemap.xml`,
  follows same-origin links up to `maxPages`, respects `robots.txt` disallow
  rules, tracks crawl depth and inbound link counts (for orphan-page
  detection), and (optionally) spot-checks a sample of external links for
  broken status codes.
- `src/analyzer.js` — runs the on-page checks against each crawled page's HTML
  (via `cheerio`) and returns a structured list of issues.
- `src/scoring.js` — aggregates per-page issues plus site-wide checks
  (duplicate titles/descriptions, missing robots.txt/sitemap, broken links,
  orphan pages) into an overall SEO score, a per-page score, a Site Health
  score, and a ranked issue list.
- `src/externalApis.js` — the only file that talks to Google. Every function
  either returns a real result or `{ configured: false, reason }` — it never
  fabricates a number. This file exists specifically so that pattern is
  enforced in one place.
- `src/rankHistory.js` — tiny JSON-file-backed history so "Change" and "Best
  Position" in the rank tracker are computed from real prior observations,
  not invented. **Prototype-level persistence** — fine for one server
  instance, not safe for a multi-instance deployment (concurrent writes can
  race). Swap for a real database before scaling this beyond one process.
- `server.js` — a small Express API: `POST /api/audit` to start a crawl,
  `GET /api/audit/:id` to poll progress/results, `POST /api/rank-check` to
  check keyword rankings on demand (kept separate from `/api/audit` so you
  control when Custom Search quota gets spent) — plus the static dashboard in
  `public/`.
- `public/` — vanilla HTML/CSS/JS dashboard, three tabs (On-Page SEO / Site
  Crawl / Google Index & Rank) plus a print-to-PDF "Download Report" button.
  No build step, no frontend framework.

Jobs are stored in memory and auto-expire after an hour — this is a prototype,
not a production job queue. For real production use you'd want to swap the
in-memory `Map` in `server.js` for a database + queue (e.g. Postgres + BullMQ)
so audits survive a server restart and can run for very large sites without
blocking a single Node process.

## Extending it

Some natural next steps if you want to take this further:

- **Persist audits** — save each run to a real database (Postgres, etc.) so
  users can compare scores over time (this is what makes "site audit" tools
  sticky as a SaaS product) — also replaces the JSON-file rank history with
  something safe for multiple server instances.
- **Scheduled re-crawls** — cron a re-audit weekly and email a diff.
- **Search Console integration** — replace the `site:` query indexing
  heuristic with real Google Search Console API data (requires the site
  owner to grant OAuth access).
- **Multi-user accounts** — add auth and per-user project storage.
- **Deeper crawling** — honor `sitemap.xml` as a seed list, increase
  `maxPages`, add a real job queue (BullMQ + Redis) so large crawls don't run
  in-process.
- **CSV export** — the report already exports to PDF via the browser's print
  dialog; a raw CSV/JSON export of issues would help users feed data into
  other tools.

## Deploying this so a frontend builder (e.g. GHL AI Studio) can call it

This is a real Express server with real server-side crawling, so it can't run
inside a client-side-only page builder — those can't make cross-origin
requests to arbitrary sites (CORS) or call these APIs without exposing keys.
The pattern that works: deploy this backend somewhere it can run as a Node
process (Render, Railway, Fly.io, a small VPS — any of them work; free tiers
exist on the first three), then point a frontend built anywhere else at its
three endpoints:

- `POST /api/audit` — `{ url, maxPages, checkExternalLinks }` → `{ id }`
- `GET /api/audit/:id` — poll for `{ status, crawled, total, summary, pages }`
- `POST /api/rank-check` — `{ domain, keywords }` → `{ results }`

Set `GOOGLE_PAGESPEED_API_KEY`, `GOOGLE_CUSTOM_SEARCH_API_KEY`, and
`GOOGLE_CUSTOM_SEARCH_ENGINE_ID` as environment variables on whatever host you
deploy to, and enable CORS for your frontend's domain (add
`app.use(require('cors')())` in `server.js`, or restrict it to your specific
origin) since the frontend will now be on a different domain than the API.

## Notes on running this in a sandboxed/cloud environment

If you're running this inside a restricted network sandbox (no general
outbound internet access), the crawler will only be able to reach allow-listed
hosts. On your own machine or a normal server it can reach any public site.
