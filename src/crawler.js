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

async function fetchSitemap(origin) {
  const sitemapUrl = origin + '/sitemap.xml';
  try {
    const res = await axios.get(sitemapUrl, {
      timeout: 8000,
      headers: { 'User-Agent': USER_AGENT },
      validateStatus: () => true,
    });
    const exists = res.status >= 200 && res.status < 300;
    let urls = [];
    if (exists && typeof res.data === 'string') {
      // Cheap XML <loc> extraction — good enough for standard sitemaps and
      // sitemap indexes alike; a page count sanity cap avoids pathological files.
      const matches = res.data.match(/<loc>([^<]+)<\/loc>/gi) || [];
      urls = matches
        .map((m) => m.replace(/<\/?loc>/gi, '').trim())
        .map((u) => normalizeUrl(u))
        .filter(Boolean)
        .slice(0, 5000);
    }
    return { exists, url: sitemapUrl, status: res.status, urls };
  } catch {
    return { exists: false, url: sitemapUrl, status: null, urls: [] };
  }
}

/**
 * Fetch a single URL and return raw response info (does not throw).
 */
async function fetchPage(pageUrl) {
  const startedAt = Date.now();
  const redirectChain = [];
  try {
    const res = await axios.get(pageUrl, {
      timeout: 15000,
      maxRedirects: 5,
      headers: { 'User-Agent': USER_AGENT, Accept: 'text/html,application/xhtml+xml' },
      validateStatus: () => true,
      // axios doesn't expose the redirect chain directly; we approximate via request path
    });
    const responseTimeMs = Date.now() - startedAt;
    const finalUrl = res.request?.res?.responseUrl || res.request?._currentUrl || pageUrl;
    const contentType = res.headers['content-type'] || '';
    return {
      ok: true,
      url: pageUrl,
      finalUrl,
      redirected: normalizeUrl(finalUrl) !== normalizeUrl(pageUrl),
      status: res.status,
      contentType,
      isHtml: contentType.includes('text/html') || contentType === '',
      html: typeof res.data === 'string' ? res.data : '',
      responseTimeMs,
      headers: res.headers,
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

  const normalizedStart = normalizeUrl(startUrl);
  if (!normalizedStart) {
    throw new Error('Invalid start URL');
  }
  const startUrlObj = new URL(normalizedStart);
  const origin = startUrlObj.origin;

  const [robots, sitemap] = await Promise.all([fetchRobots(origin), fetchSitemap(origin)]);

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
    while (queue.length > 0 && batch.length < concurrency && visited.size + batch.length < maxPages) {
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

    const fetched = await runPool(batch, concurrency, async ({ url, depth }) => {
      const result = await fetchPage(url);
      result.depth = depth;
      return result;
    });

    for (const result of fetched) {
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
        return { url: link, status: res.status, broken: res.status >= 400 };
      } catch (err) {
        // Some servers reject HEAD; fall back to GET
        try {
          const res = await axios.get(link, {
            timeout: 8000,
            maxRedirects: 5,
            headers: { 'User-Agent': USER_AGENT },
            validateStatus: () => true,
          });
          return { url: link, status: res.status, broken: res.status >= 400 };
        } catch {
          return { url: link, status: 0, broken: true };
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
  };
}

module.exports = { crawlSite, normalizeUrl, fetchPage, extractLinks };
