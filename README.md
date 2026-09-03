# SEO Audit Tool

A self-hosted, full-site SEO crawler and audit dashboard — similar in spirit to
Semrush Site Audit, SEO Site Checkup, or Seobility. Give it a URL, it crawls the
site (same-origin, respecting `robots.txt`), analyzes every page it finds, and
gives you a scored report across five tabs: **On-Page SEO**, **Content &
Keywords**, **Site Crawl**, **Technical & Security**, and **Google Index &
Rank**.

**Every number in this tool is either computed from a real crawl/API call, or
the UI explicitly says it's not configured. Nothing is ever faked, randomized,
or hard-coded to look plausible.** That includes the two optional Google
integrations below — if you don't add API keys, those sections show an honest
"unavailable — not configured" message instead of a made-up score.

## What it checks

The check list was built by cataloguing what Semrush Site Audit, SEO Site
Checkup, SEOptimer, Seobility and Rank Math's analyzer report, then
implementing every check that can be **measured directly** from the site.
Checks that require paid third-party data (backlinks, domain authority,
traffic estimates, keyword volume, competitor lists) are deliberately left
out and the dashboard says so, rather than showing an estimate.

**Meta & indexing (per page):** title (missing / length / multiple), meta
description (missing / length), `lang`, charset, doctype, canonical (missing
/ multiple / relative / http-on-https / malformed / self-referencing),
`noindex` via meta *and* `X-Robots-Tag` header, `nofollow`, meta refresh,
hreflang (invalid values, duplicates, missing self-reference, missing
x-default), favicon declaration.

**Content & keywords:** word count / thin content, text-to-HTML ratio, most
common keywords with density and whether each appears in title /
description / H1, repeated phrases, keyword-stuffing signal, duplicate titles
/ descriptions / H1s across pages, near-duplicate content across pages.

**Headings & structure:** H1 missing / multiple / identical to title / too
long, empty headings, skipped heading levels, H2 absence on long pages, full
heading outline.

**Links & URLs:** internal / external / nofollow counts, empty and generic
("click here") anchor text, too many links, `target=_blank` without
`rel=noopener`, HTTP links on HTTPS pages, underscores / uppercase / long /
parameter-heavy URLs, broken internal links (4xx/5xx), redirect chains and
loops (every hop recorded), temporary vs permanent redirects, sampled
broken external links (4xx/5xx reported separately from "unreachable"),
pages with a single inbound link, pages deeper than 3 clicks, orphan pages.

**Images:** missing alt, missing width/height, lazy-loading, WebP/AVIF and
srcset usage, sampled broken images (real HEAD requests).

**Technical HTML:** deprecated tags, frames, iframes, Flash, inline styles,
nested tables, DOM size, HTML size, viewport (presence and
`width=device-width`), media queries, AMP, render-blocking `<head>`
resources, script/stylesheet counts, mixed content, sampled broken JS/CSS
files, JSON-LD parse validity and `@type` list, microdata, identity /
LocalBusiness schema, analytics / tag-manager / Facebook Pixel detection,
signature-based tech detection (WordPress, Shopify, Wix, Webflow,
GoHighLevel, React/Next, jQuery, CDN assets…), plaintext email addresses.

**Server & security (site level — real requests, TLS handshakes and DNS
lookups):** HTTP→HTTPS redirect, www/non-www resolution, homepage redirect
chain, TLS certificate (issuer, expiry, trust, protocol version), HTTP/2 via
ALPN, A/AAAA records, IPv6, nameservers, SPF, DMARC, HSTS and five other
security headers, server signature / X-Powered-By exposure, gzip/brotli
compression, custom 404 (soft-404 detection), `llms.txt`, `ads.txt`,
robots.txt validity and `Sitemap:` directive, sitemap format / http-URLs /
off-host URLs, favicon.

**Performance (Google PageSpeed Insights, real Lighthouse runs — mobile and
desktop):** Performance / SEO / Accessibility / Best-practices scores, LCP,
CLS, INP (field data when Google has it), FCP, TBT, Speed Index, TTFB,
total page weight, request count, plus named audits: render-blocking
resources, JS execution time, CSS/JS minification, cache TTLs, image
compression / modern formats / sizing, text compression, DOM size, console
errors, legible font sizes, tap targets, crawlable links, indexability,
robots.txt validity, hreflang, canonical, image alt, color contrast, HTTPS.
PageSpeed works **without an API key** at a small quota; a free key raises
it.

**Google Index & Rank (optional Custom Search API):** `site:` indexing
heuristic and keyword position tracking with real history. **Safe Browsing
(optional key):** malware / phishing listing status.

Each finding is scored **error / warning / notice**, rolled into an overall
0–100 score, ten category scores (Meta, Content, Structure, Links, Images,
Technical, Security, Performance, Social, Crawlability) and a Site Health
score, and listed with the affected URLs.

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

**Enabling JavaScript rendering** requires Playwright's Chromium binary.
`npm install` runs `scripts/install-browser.js` (a `postinstall` hook) which
downloads it best-effort and **never fails the build** — if a host can't
download or run it, the app still deploys and "Render JavaScript" reports
itself as unavailable. On Render, set `PLAYWRIGHT_BROWSERS_PATH` to
`/opt/render/project/src/.playwright` so the binary downloaded during the
build persists into the running service. Set `SKIP_BROWSER_INSTALL=1` to
skip the download entirely.

## Protecting this before you deploy it publicly

Out of the box, `/api/audit` and `/api/rank-check` are open to anyone who
finds your server's URL — and each request does real work (a live crawl, or
Google API quota). Before pointing a public frontend (e.g. a GHL AI Studio
app) at a deployed instance, set these two things:

- **`API_SHARED_SECRET`** — an optional shared secret. When set, both
  endpoints require an `X-API-Key` header matching it, or they respond `401`.
  Leave it unset for local development; the server logs a warning on startup
  reminding you it's open if you forget to set it before deploying.
- **Rate limiting** is on by default (20 audits and 20 rank-checks per IP per
  15 minutes) — no setup needed, but tune it with `RATE_LIMIT_MAX_AUDITS`,
  `RATE_LIMIT_MAX_RANK_CHECKS`, and `RATE_LIMIT_WINDOW_MINUTES` if your usage
  pattern needs something different.

```bash
export API_SHARED_SECRET=pick-a-long-random-string
npm start
```

Then have your frontend send `X-API-Key: pick-a-long-random-string` on every
call to `/api/audit` and `/api/rank-check` (not needed for `GET /api/audit/:id`,
which only returns data for a job ID the caller already has).

## Optional: enable the real Google integrations

Without these, the tool still works fully for crawling, on-page analysis,
server/security checks and (keyless, low-quota) PageSpeed — the Google Index
& Rank and Safe Browsing sections show an honest "not configured" message
instead of data.

### 0. Safe Browsing (optional, free)

Enable the **Safe Browsing API** in Google Cloud Console and set
`GOOGLE_SAFE_BROWSING_API_KEY`. Without it the dashboard shows "not checked"
— never "clean".

### 1. Core Web Vitals — Google PageSpeed Insights API (free; key optional)

PageSpeed Insights already runs without a key, but Google's keyless quota is
small (a handful of runs per day per IP). A free key raises it substantially.

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

- `src/crawler.js` — BFS crawler. Fetches `robots.txt` and every sitemap it
  declares (following one level of sitemap-index), follows same-origin links
  up to `maxPages`, respects `robots.txt` disallow rules, tracks crawl depth
  and inbound link counts (for orphan-page detection), optionally renders
  pages through a real headless browser (Playwright) instead of a plain HTTP
  GET when JS rendering is requested and available, and (optionally)
  spot-checks a sample of external links for broken status codes.
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
- **Deeper crawling** — increase `maxPages`, add a real job queue (BullMQ +
  Redis) so large crawls don't run in-process.
- **CSV export** — the report already exports to PDF via the browser's print
  dialog; a raw CSV/JSON export of issues would help users feed data into
  other tools.
- **Automated tests** — everything so far has been verified with manual
  curl/Playwright runs against a small local fixture site; a real test suite
  (Jest/Vitest) would catch regressions as this keeps growing.

## Deploying this so a frontend builder (e.g. GHL AI Studio) can call it

This is a real Express server with real server-side crawling, so it can't run
inside a client-side-only page builder — those can't make cross-origin
requests to arbitrary sites (CORS) or call these APIs without exposing keys.
The pattern that works: deploy this backend somewhere it can run as a Node
process (Render, Railway, Fly.io, a small VPS — any of them work; free tiers
exist on the first three), then point a frontend built anywhere else at its
three endpoints:

- `POST /api/audit` — `{ url, maxPages, checkExternalLinks, renderJs }` → `{ id }`
- `GET /api/audit/:id` — poll for `{ status, crawled, total, summary, pages }`
- `POST /api/rank-check` — `{ domain, keywords }` → `{ results }`

CORS and rate limiting are already built in — you don't need to add
anything. Set `ALLOWED_ORIGIN` to your frontend's exact URL once you have it
(otherwise CORS defaults to open, fine while you're still testing), and set
`API_SHARED_SECRET` per the section above so the two POST endpoints require
your frontend's `X-API-Key` header. Set `GOOGLE_PAGESPEED_API_KEY`,
`GOOGLE_CUSTOM_SEARCH_API_KEY`, and `GOOGLE_CUSTOM_SEARCH_ENGINE_ID` too if
you want the Core Web Vitals and Google Index & Rank tabs populated — all
five are just environment variables on whatever host you deploy to.

If you plan to use JavaScript rendering regularly, budget more RAM than a
bare-minimum free tier — a headless Chromium tab is heavier than a plain
HTTP request, and a host with only ~512MB can struggle if it also has to run
your Node process at the same time. It's fine as an occasional opt-in
feature on a free tier; for routine use on SPA-heavy sites, a small paid
instance is the safer choice.

## Notes on running this in a sandboxed/cloud environment

If you're running this inside a restricted network sandbox (no general
outbound internet access), the crawler will only be able to reach allow-listed
hosts. On your own machine or a normal server it can reach any public site.
