'use strict';

const axios = require('axios');
const cheerio = require('cheerio');
const robotsParser = require('robots-parser');
const { URL } = require('url');

const USER_AGENT = 'SEOAuditBot/1.0 (+https://example.com/bot)';

// File extensions we never want to fetch/parse as HTML pages
const SKIP_EXTENSIONS = /\.(jpg|jpeg|png|gif|svg|webp|ico|css|js|json|xml|pdf|zip|rar|7z|mp4|mp3|wav|avi|mov|woff|woff2|ttf|eot|otf|doc|docx|xls|xlsx|ppt|pptx)$/i;

function normalizeUrl(rawUrl) {
  try {
    const u = new URL(rawUrl);
    u.hash = '';
    // strip trailing slash except root
    if (u.pathname.length > 1 && u.pathname.endsWith('/')) {
      u.pathname = u.pathname.slice(0, -1);
    }
    return u.toString();
  } catch {
    return null;
  }
}

async function fetchRobots(origin) {
  const robotsUrl = origin + '/robots.txt';
  try {
    const res = await axios.get(robotsUrl, {
      timeout: 8000,
      headers: { 'User-Agent': USER_AGENT },
      validateStatus: () => true,
    });
    if (res.status >= 200 && res.status < 300 && typeof res.data === 'string') {
      return { exists: true, content: res.data, parser: robotsParser(robotsUrl, res.data) };
    }
    return { exists: false, content: null, parser: robotsParser(robotsUrl, '') };
  } catch {
    return { exists: false, content: null, parser: robotsParser(robotsUrl, '') };
  }
}

/** Pull every `Sitemap:` directive out of a robots.txt body (there can be more than one). */
function extractSitemapDirectives(robotsContent) {
  if (!robotsContent) return [];
  const matches = robotsContent.match(/^\s*sitemap:\s*(\S+)/gim) || [];
  return matches.map((line) => line.replace(/^\s*sitemap:\s*/i, '').trim()).filter(Boolean);
}

/** A sitemap file is either a <urlset> of real pages, or a <sitemapindex> of other sitemaps. */
function parseSitemapXml(raw) {
  const isIndex = /<sitemapindex[\s>]/i.test(raw);
  const isUrlset = /<urlset[\s>]/i.test(raw);
  const locMatches = raw.match(/<loc>([^<]+)<\/loc>/gi) || [];
  const locs = locMatches.map((m) => m.replace(/<\/?loc>/gi, '').trim());
  // A sitemap that has neither root element is not a valid sitemap file
  // (often an HTML error page served with a 200 status).
  return { isIndex, locs, malformed: !isIndex && !isUrlset };
}

async function fetchXmlFile(url) {
  try {
    const res = await axios.get(url, {
      timeout: 8000,
      headers: { 'User-Agent': USER_AGENT },
      validateStatus: () => true,
    });
    if (res.status >= 200 && res.status < 300 && typeof res.data === 'string') {
      return res.data;
    }
  } catch {
    /* candidate just doesn't exist / isn't reachable — not an error */
  }
  return null;
}

/**
 * Find and parse this site's sitemap(s): the conventional /sitemap.xml AND
 * any sitemap(s) declared via `Sitemap:` lines in robots.txt (a common real
 * -world pattern this tool previously missed). Follows one level of
 * <sitemapindex> so a real page-URL list comes back either way, instead of
 * mistaking a sitemap index's own file URLs for page URLs.
 */
async function fetchSitemap(origin, robotsContent) {
  const declared = extractSitemapDirectives(robotsContent);
  const candidates = [...new Set([origin + '/sitemap.xml', ...declared])];

  const foundSitemapUrls = [];
  const childSitemapsToFetch = [];
  const pageUrls = new Set();
  let malformed = 0;

  for (const sitemapUrl of candidates) {
    const raw = await fetchXmlFile(sitemapUrl);
    if (raw == null) continue;
    foundSitemapUrls.push(sitemapUrl);
    const { isIndex, locs, malformed: bad } = parseSitemapXml(raw);
    if (bad) malformed++;
    if (isIndex) {
      childSitemapsToFetch.push(...locs);
    } else {
      for (const loc of locs) {
        const n = normalizeUrl(loc);
        if (n) pageUrls.add(n);
      }
    }
  }

  // One level of sitemap-index recursion, capped so a pathological/hostile
  // index can't turn one audit into thousands of extra requests.
  for (const childUrl of childSitemapsToFetch.slice(0, 20)) {
    if (pageUrls.size >= 5000) break;
    const raw = await fetchXmlFile(childUrl);
    if (raw == null) continue;
    const { locs, malformed: bad } = parseSitemapXml(raw);
    if (bad) malformed++;
    for (const loc of locs) {
      const n = normalizeUrl(loc);
      if (n) pageUrls.add(n);
    }
  }

  return {
    exists: foundSitemapUrls.length > 0,
    sitemapUrls: foundSitemapUrls,
    urls: [...pageUrls].slice(0, 5000),
    malformed,
  };
}

/**
 * Fetch a single URL and return raw response info (does not throw).
 */
async function fetchPage(pageUrl) {
  const startedAt = Date.now();
  // Follow redirects by hand (maxRedirects: 0 per hop) so we can record the
  // real chain: every hop's URL and status code. That is what makes
  // "redirect chain", "redirect loop" and "temporary redirect" findings
  // measurable instead of guessed.
  const redirectChain = [];
  const redirectStatuses = [];
  let currentUrl = pageUrl;
  try {
    let res;
    for (let hop = 0; hop <= 8; hop++) {
      res = await axios.get(currentUrl, {
        timeout: 15000,
        maxRedirects: 0,
        headers: { 'User-Agent': USER_AGENT, Accept: 'text/html,application/xhtml+xml' },
        validateStatus: () => true,
        responseType: 'text',
        transformResponse: [(d) => d],
      });
      if (res.status >= 300 && res.status < 400 && res.headers.location) {
        let next;
        try { next = new URL(res.headers.location, currentUrl).toString(); } catch { break; }
        redirectChain.push({ from: currentUrl, to: next, status: res.status });
        redirectStatuses.push(res.status);
        if (redirectChain.some((h, i) => i < redirectChain.length - 1 && h.from === next) || next === currentUrl) {
          // loop
          return {
            ok: true, url: pageUrl, finalUrl: currentUrl, redirected: true, status: res.status,
            contentType: '', isHtml: false, html: '', responseTimeMs: Date.now() - startedAt,
            headers: res.headers, redirectChain, redirectStatuses, redirectLoop: true, htmlBytes: 0,
          };
        }
        currentUrl = next;
        continue;
      }
      break;
    }
    const responseTimeMs = Date.now() - startedAt;
    const contentType = res.headers['content-type'] || '';
    const html = typeof res.data === 'string' ? res.data : '';
    return {
      ok: true,
      url: pageUrl,
      finalUrl: currentUrl,
      redirected: normalizeUrl(currentUrl) !== normalizeUrl(pageUrl),
      status: res.status,
      contentType,
      isHtml: contentType.includes('text/html') || contentType === '',
      html,
      htmlBytes: Buffer.byteLength(html, 'utf8'),
      responseTimeMs,
      headers: res.headers,
      redirectChain,
      redirectStatuses,
      redirectLoop: false,
    };
  } catch (err) {
    return {
      ok: false,
      url: pageUrl,
      finalUrl: pageUrl,
      redirected: false,
      status: err.response?.status || 0,
      contentType: '',
      isHtml: false,
      html: '',
      responseTimeMs: Date.now() - startedAt,
      error: err.code || err.message || 'request_failed',
    };
  }
}

// Playwright is an optional dependency: if it isn't installed (or its
// browser binary can't launch — e.g. a memory-constrained free host), JS
// rendering degrades to a clearly-labeled "unavailable" state rather than
// silently crawling as plain HTML while claiming otherwise.
let _playwright = null;
let _playwrightLoadAttempted = false;
function loadPlaywright() {
  if (_playwrightLoadAttempted) return _playwright;
  _playwrightLoadAttempted = true;
  try {
    _playwright = require('playwright');
  } catch {
    _playwright = null;
  }
  return _playwright;
}

/**
 * Fetch a page through a real headless browser so client-rendered
 * (React/Vue/SPA-style) content is captured — a plain HTTP GET only ever
 * sees the pre-JS HTML, which is empty or near-empty for such sites.
 */
async function fetchPageRendered(pageUrl, browser) {
  const startedAt = Date.now();
  let page = null;
  try {
    page = await browser.newPage({ userAgent: USER_AGENT });
    let response;
    try {
      response = await page.goto(pageUrl, { waitUntil: 'networkidle', timeout: 15000 });
    } catch {
      // Some pages never go fully idle (analytics beacons, polling); a
      // DOM-ready load still captures rendered content for our purposes.
      response = await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
    }
    const status = response ? response.status() : 0;
    const finalUrl = page.url();
    const html = await page.content();
    let headers = {};
    try { headers = response ? await response.allHeaders() : {}; } catch { headers = {}; }
    // Reconstruct the redirect chain from the response's request history.
    const redirectChain = [];
    const redirectStatuses = [];
    try {
      let req = response ? response.request().redirectedFrom() : null;
      const hops = [];
      while (req) { hops.unshift(req); req = req.redirectedFrom(); }
      for (const r of hops) {
        const rr = await r.response();
        const st = rr ? rr.status() : 0;
        redirectStatuses.push(st);
        redirectChain.push({ from: r.url(), status: st });
      }
    } catch { /* chain unavailable — leave empty rather than invent */ }
    return {
      ok: true,
      url: pageUrl,
      finalUrl,
      redirected: normalizeUrl(finalUrl) !== normalizeUrl(pageUrl),
      status,
      contentType: 'text/html',
      isHtml: true,
      html,
      htmlBytes: Buffer.byteLength(html, 'utf8'),
      responseTimeMs: Date.now() - startedAt,
      headers,
      redirectChain,
      redirectStatuses,
      redirectLoop: false,
    };
  } catch (err) {
    return {
      ok: false,
      url: pageUrl,
      finalUrl: pageUrl,
      redirected: false,
      status: 0,
      contentType: '',
      isHtml: false,
      html: '',
      responseTimeMs: Date.now() - startedAt,
      error: err.message || 'render_failed',
    };
  } finally {
    if (page) await page.close().catch(() => {});
  }
}

function extractLinks(html, baseUrl, siteOrigin) {
  const internal = new Set();
  const external = new Set();
  try {
    const $ = cheerio.load(html);
    $('a[href]').each((_, el) => {
      const href = $(el).attr('href');
      if (!href || href.startsWith('mailto:') || href.startsWith('tel:') || href.startsWith('javascript:')) return;
      try {
        const abs = new URL(href, baseUrl);
        if (abs.protocol !== 'http:' && abs.protocol !== 'https:') return;
        const normalized = normalizeUrl(abs.toString());
        if (!normalized) return;
        if (abs.origin === siteOrigin) {
          internal.add(normalized);
        } else {
          external.add(normalized);
        }
      } catch {
        /* ignore malformed hrefs */
      }
    });
  } catch {
    /* ignore parse errors */
  }
  return { internal: [...internal], external: [...external] };
}

/**
 * Simple async concurrency pool runner.
 */
async function runPool(items, limit, worker) {
  const results = [];
  let idx = 0;
  async function next() {
    while (idx < items.length) {
      const current = idx++;
      results[current] = await worker(items[current], current);
    }
  }
  const workers = Array.from({ length: Math.min(limit, items.length) }, next);
  await Promise.all(workers);
  return results;
}

/**
 * Crawl a site starting at startUrl using BFS, up to maxPages pages, same-origin only.
 * Calls onProgress({ crawled, total, currentUrl }) after each page.
 * Returns { pages: [...], robots, sitemap, externalLinksChecked: [...] }
 */
async function crawlSite(startUrl, options = {}, onProgress = () => {}) {
  const maxPages = Math.min(options.maxPages || 30, 100);
  const concurrency = Math.min(options.concurrency || 5, 8);
  const checkExternalLinks = options.checkExternalLinks !== false;
  const renderJsRequested = !!options.renderJs;

  let normalizedStart = normalizeUrl(startUrl);
  if (!normalizedStart) {
    throw new Error('Invalid start URL');
  }
  // Resolve the start URL first. Sites commonly redirect www → non-www (or
  // http → https). If we kept crawling from the URL the user typed, every
  // link on the site would look "external" and the crawl would stop at one
  // page — so adopt the final origin when it is the same registrable host
  // (only the www prefix or scheme differs). The redirect itself is still
  // reported as a finding.
  let startRedirectedTo = null;
  try {
    const probe = await fetchPage(normalizedStart);
    if (probe.ok && probe.redirected && probe.finalUrl) {
      const a = new URL(normalizedStart).hostname.replace(/^www\./, '');
      const b = new URL(probe.finalUrl).hostname.replace(/^www\./, '');
      if (a === b) {
        startRedirectedTo = normalizeUrl(probe.finalUrl);
        normalizedStart = startRedirectedTo;
      }
    }
  } catch { /* fall back to the URL as typed */ }
  const startUrlObj = new URL(normalizedStart);
  const origin = startUrlObj.origin;

  // Sequential, not parallel: robots.txt may declare the sitemap's actual
  // location via a `Sitemap:` line, so we need its content before we know
  // every sitemap URL worth checking.
  const robots = await fetchRobots(origin);
  const sitemap = await fetchSitemap(origin, robots.content);

  // JS rendering is opt-in and must degrade honestly: if the caller asked
  // for it but this host can't actually do it (package missing, browser
  // won't launch — common on memory-constrained free hosts), we report that
  // plainly rather than silently falling back while claiming success.
  let browser = null;
  let renderJsUnavailableReason = null;
  if (renderJsRequested) {
    const pw = loadPlaywright();
    if (!pw) {
      renderJsUnavailableReason = 'The "playwright" package is not installed on this server. Pages were crawled as plain HTML instead.';
    } else {
      try {
        browser = await pw.chromium.launch({ headless: true });
      } catch (err) {
        renderJsUnavailableReason = `Could not launch a headless browser (${err.message}). Pages were crawled as plain HTML instead.`;
      }
    }
  }
  // Rendered pages are far heavier (a full browser tab each) than a plain
  // HTTP GET, so cap concurrency separately when rendering is active.
  const pageConcurrency = browser ? Math.min(concurrency, 3) : concurrency;

  try {
  const visited = new Set();
  const queue = [{ url: normalizedStart, depth: 0 }];
  const queuedUrls = new Set([normalizedStart]);
  const pages = [];
  const allExternalLinks = new Set();
  const allInternalLinksFound = new Set([normalizedStart]);
  const depthByUrl = new Map([[normalizedStart, 0]]);
  const inboundLinkCount = new Map(); // url -> number of crawled pages linking to it

  while (queue.length > 0 && visited.size < maxPages) {
    const batch = [];
    while (queue.length > 0 && batch.length < pageConcurrency && visited.size + batch.length < maxPages) {
      const { url: next, depth } = queue.shift();
      if (visited.has(next)) continue;
      if (SKIP_EXTENSIONS.test(new URL(next).pathname)) continue;
      let allowed = true;
      try {
        allowed = robots.parser.isAllowed(next, USER_AGENT) !== false;
      } catch {
        allowed = true;
      }
      if (!allowed) {
        visited.add(next);
        pages.push({
          url: next,
          finalUrl: next,
          status: 0,
          blockedByRobots: true,
          isHtml: false,
          html: '',
          responseTimeMs: 0,
          redirected: false,
          depth,
        });
        continue;
      }
      visited.add(next);
      batch.push({ url: next, depth });
    }
    if (batch.length === 0) continue;

    const fetched = await runPool(batch, pageConcurrency, async ({ url, depth }) => {
      const result = browser ? await fetchPageRendered(url, browser) : await fetchPage(url);
      result.depth = depth;
      return result;
    });

    for (const result of fetched) {
      // If a URL redirected to a page we already crawled (or will crawl),
      // keep only the redirect finding — analysing the target's content a
      // second time would double-count every issue on it.
      if (result.redirected) {
        const target = normalizeUrl(result.finalUrl);
        if (target && (visited.has(target) || queuedUrls.has(target))) {
          result.html = '';
          result.isHtml = false;
          result.contentStripped = true;
        } else if (target) {
          visited.add(target);
          queuedUrls.add(target);
          if (!depthByUrl.has(target)) depthByUrl.set(target, result.depth);
        }
      }
      pages.push(result);
      onProgress({ crawled: pages.length, total: Math.min(maxPages, visited.size + queue.length), currentUrl: result.url });

      if (result.isHtml && result.html) {
        const { internal, external } = extractLinks(result.html, result.finalUrl || result.url, origin);
        for (const link of internal) {
          allInternalLinksFound.add(link);
          inboundLinkCount.set(link, (inboundLinkCount.get(link) || 0) + 1);
          if (!visited.has(link) && !queuedUrls.has(link) && visited.size + queue.length < maxPages) {
            const childDepth = result.depth + 1;
            if (!depthByUrl.has(link)) depthByUrl.set(link, childDepth);
            queuedUrls.add(link);
            queue.push({ url: link, depth: childDepth });
          }
        }
        for (const link of external) {
          allExternalLinks.add(link);
        }
      }
    }
  }

  // Orphan pages: present in the sitemap but never linked to from any crawled page.
  const orphanPages = (sitemap.urls || []).filter(
    (u) => u !== normalizedStart && !inboundLinkCount.has(u)
  );

  // Depth distribution across crawled pages (bucket 4+ together).
  const depthDistribution = { 0: 0, 1: 0, 2: 0, 3: 0, '4+': 0 };
  for (const page of pages) {
    const d = page.depth ?? depthByUrl.get(page.url) ?? 0;
    const key = d >= 4 ? '4+' : String(d);
    depthDistribution[key] = (depthDistribution[key] || 0) + 1;
  }

  // Optionally spot-check a sample of external links for broken-ness (HEAD requests, capped)
  let externalLinkResults = [];
  if (checkExternalLinks) {
    const sample = [...allExternalLinks].slice(0, 25);
    externalLinkResults = await runPool(sample, 6, async (link) => {
      try {
        const res = await axios.head(link, {
          timeout: 8000,
          maxRedirects: 5,
          headers: { 'User-Agent': USER_AGENT },
          validateStatus: () => true,
        });
        return { url: link, status: res.status, broken: res.status >= 400, unreachable: false };
      } catch (err) {
        // Some servers reject HEAD; fall back to GET
        try {
          const res = await axios.get(link, {
            timeout: 8000,
            maxRedirects: 5,
            headers: { 'User-Agent': USER_AGENT },
            validateStatus: () => true,
          });
          return { url: link, status: res.status, broken: res.status >= 400, unreachable: false };
        } catch (err2) {
          // Could not connect at all (DNS, timeout, refused). Reported as
          // "unreachable", not "broken" — it may be transient or a network
          // restriction on this server rather than a dead link.
          return { url: link, status: 0, broken: false, unreachable: true, error: err2.code || err2.message };
        }
      }
    });
  }

  return {
    pages,
    robots: { exists: robots.exists, content: robots.content },
    sitemap,
    totalExternalLinksFound: allExternalLinks.size,
    externalLinkResults,
    totalInternalLinksFound: allInternalLinksFound.size,
    orphanPages,
    depthDistribution,
    inboundLinkCount: Object.fromEntries(inboundLinkCount),
    startUrl: normalizedStart,
    startRedirectedTo,
    renderJsRequested,
    renderJsUsed: !!browser,
    renderJsUnavailableReason,
  };
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

module.exports = { crawlSite, normalizeUrl, fetchPage, extractLinks };
