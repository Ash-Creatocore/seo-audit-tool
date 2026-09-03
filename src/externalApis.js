'use strict';

/**
 * Real external API calls for Core Web Vitals, indexing status, and keyword
 * rank checking. Every function here either returns REAL data from a REAL
 * API call, or throws/returns an explicit "not configured" / "error" state.
 *
 * NONE of these functions may ever fabricate a number. If a required API key
 * is missing, or the upstream call fails, the caller must surface that
 * honestly in the UI (e.g. "Core Web Vitals unavailable — API key not
 * configured") rather than showing a plausible-looking fake value. This file
 * exists specifically to replace a prior implementation that faked all of
 * this client-side with no real network calls at all — do not reintroduce
 * that pattern.
 */

const PAGESPEED_ENDPOINT = 'https://www.googleapis.com/pagespeedonline/v5/runPagespeed';
const CUSTOM_SEARCH_ENDPOINT = 'https://www.googleapis.com/customsearch/v1';

/**
 * Fetch real Core Web Vitals + Performance score from Google PageSpeed Insights.
 * Requires GOOGLE_PAGESPEED_API_KEY. Returns { configured: false } if no key is set
 * — never returns fabricated LCP/CLS/INP numbers.
 */
// Lighthouse audits worth surfacing individually — the same ones SEO Site
// Checkup / SEOptimer report as named tests. Each value below is whatever
// Lighthouse actually measured; we never compute a substitute.
const SURFACED_AUDITS = [
  ['first-contentful-paint', 'First Contentful Paint', 'performance'],
  ['largest-contentful-paint', 'Largest Contentful Paint', 'performance'],
  ['speed-index', 'Speed Index', 'performance'],
  ['total-blocking-time', 'Total Blocking Time', 'performance'],
  ['cumulative-layout-shift', 'Cumulative Layout Shift', 'performance'],
  ['server-response-time', 'Time to First Byte', 'performance'],
  ['bootup-time', 'JavaScript execution time', 'performance'],
  ['total-byte-weight', 'Total page weight', 'performance'],
  ['render-blocking-resources', 'Render-blocking resources', 'performance'],
  ['unminified-css', 'CSS minification', 'performance'],
  ['unminified-javascript', 'JavaScript minification', 'performance'],
  ['uses-long-cache-ttl', 'Cache headers on static assets', 'performance'],
  ['uses-optimized-images', 'Image compression', 'performance'],
  ['modern-image-formats', 'Modern image formats (WebP/AVIF)', 'performance'],
  ['uses-responsive-images', 'Properly sized images', 'performance'],
  ['uses-text-compression', 'Text compression', 'performance'],
  ['dom-size', 'DOM size', 'performance'],
  ['network-requests', 'Network requests', 'performance'],
  ['errors-in-console', 'Browser console errors', 'technical'],
  ['viewport', 'Viewport meta tag', 'mobile'],
  ['font-size', 'Legible font sizes (mobile)', 'mobile'],
  ['tap-targets', 'Tap target sizing (mobile)', 'mobile'],
  ['crawlable-anchors', 'Crawlable links', 'seo'],
  ['is-crawlable', 'Page is indexable', 'seo'],
  ['robots-txt', 'robots.txt validity', 'seo'],
  ['hreflang', 'hreflang validity', 'seo'],
  ['canonical', 'Canonical validity', 'seo'],
  ['image-alt', 'Image alt attributes', 'accessibility'],
  ['color-contrast', 'Color contrast', 'accessibility'],
  ['is-on-https', 'Served over HTTPS', 'security'],
  ['redirects-http', 'HTTP → HTTPS redirect (Lighthouse)', 'security'],
];

async function runPageSpeed(url, strategy, apiKey) {
  const params = new URLSearchParams({ url, strategy });
  if (apiKey) params.set('key', apiKey);
  for (const c of ['performance', 'seo', 'accessibility', 'best-practices']) params.append('category', c);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 90000);
  try {
    const res = await fetch(`${PAGESPEED_ENDPOINT}?${params.toString()}`, { method: 'GET', signal: controller.signal });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      let message = body.slice(0, 300);
      try { message = JSON.parse(body)?.error?.message || message; } catch { /* keep raw */ }
      return { ok: false, status: res.status, error: message };
    }
    return { ok: true, data: await res.json() };
  } catch (err) {
    return { ok: false, status: 0, error: err.name === 'AbortError' ? 'PageSpeed request timed out after 90s' : err.message };
  } finally {
    clearTimeout(timer);
  }
}

function summarizeLighthouse(data) {
  const lhr = data?.lighthouseResult || {};
  const audits = lhr.audits || {};
  const cat = (k) => (lhr.categories?.[k]?.score != null ? Math.round(lhr.categories[k].score * 100) : null);
  const field = data?.loadingExperience?.metrics || null;
  const lcpMs = field?.LARGEST_CONTENTFUL_PAINT_MS?.percentile ?? audits['largest-contentful-paint']?.numericValue ?? null;
  const cls = field?.CUMULATIVE_LAYOUT_SHIFT_SCORE?.percentile != null ? field.CUMULATIVE_LAYOUT_SHIFT_SCORE.percentile / 100 : (audits['cumulative-layout-shift']?.numericValue ?? null);
  const inpMs = field?.INTERACTION_TO_NEXT_PAINT?.percentile ?? null;
  const surfaced = SURFACED_AUDITS
    .filter(([id]) => audits[id])
    .map(([id, label, group]) => {
      const a = audits[id];
      return {
        id, label, group,
        score: a.score, // null = informational, 0..1 otherwise (real Lighthouse score)
        displayValue: a.displayValue || null,
        numericValue: a.numericValue ?? null,
        numericUnit: a.numericUnit || null,
        passed: a.score == null ? null : a.score >= 0.9,
        description: (a.title || label),
      };
    });
  return {
    scores: { performance: cat('performance'), seo: cat('seo'), accessibility: cat('accessibility'), bestPractices: cat('best-practices') },
    lcpSeconds: lcpMs != null ? Math.round((lcpMs / 1000) * 100) / 100 : null,
    cls: cls != null ? Math.round(cls * 1000) / 1000 : null,
    inpMs: inpMs != null ? Math.round(inpMs) : null,
    fcpSeconds: audits['first-contentful-paint']?.numericValue != null ? Math.round(audits['first-contentful-paint'].numericValue / 10) / 100 : null,
    tbtMs: audits['total-blocking-time']?.numericValue != null ? Math.round(audits['total-blocking-time'].numericValue) : null,
    speedIndexSeconds: audits['speed-index']?.numericValue != null ? Math.round(audits['speed-index'].numericValue / 10) / 100 : null,
    ttfbMs: audits['server-response-time']?.numericValue != null ? Math.round(audits['server-response-time'].numericValue) : null,
    totalBytes: audits['total-byte-weight']?.numericValue ?? null,
    requestCount: Array.isArray(audits['network-requests']?.details?.items) ? audits['network-requests'].details.items.length : null,
    fieldDataAvailable: !!field,
    audits: surfaced,
    lighthouseVersion: lhr.lighthouseVersion || null,
    fetchTime: lhr.fetchTime || null,
    finalUrl: lhr.finalDisplayedUrl || lhr.finalUrl || null,
  };
}

/**
 * Real Lighthouse / Core Web Vitals data from Google PageSpeed Insights.
 * Works WITHOUT an API key (Google allows a small unauthenticated quota);
 * GOOGLE_PAGESPEED_API_KEY raises the quota. Never returns fabricated
 * numbers: any failure (quota, timeout, unreachable URL) comes back as
 * { ok: false, error } and the UI shows that message.
 */
async function getCoreWebVitals(url, { apiKey = process.env.GOOGLE_PAGESPEED_API_KEY, strategies = ['mobile', 'desktop'] } = {}) {
  const out = { configured: true, keyed: !!apiKey, ok: false, source: 'Google PageSpeed Insights API (Lighthouse)', strategies: {} };
  const results = await Promise.all(strategies.map((s) => runPageSpeed(url, s, apiKey)));
  results.forEach((r, i) => {
    const s = strategies[i];
    out.strategies[s] = r.ok ? { ok: true, ...summarizeLighthouse(r.data) } : { ok: false, status: r.status, error: r.error };
  });
  const mobile = out.strategies.mobile;
  const anyOk = Object.values(out.strategies).some((s) => s.ok);
  out.ok = anyOk;
  if (!anyOk) {
    const first = Object.values(out.strategies)[0];
    out.error = first?.error || 'PageSpeed Insights returned no data.';
    if (!apiKey && /quota|rate|429/i.test(String(out.error) + String(first?.status))) {
      out.error += ' — the keyless quota is small; set GOOGLE_PAGESPEED_API_KEY (free) for a much larger quota.';
    }
    return out;
  }
  // Headline metrics come from the mobile run when available (Google's default).
  const primary = mobile?.ok ? mobile : Object.values(out.strategies).find((s) => s.ok);
  out.lcpSeconds = primary.lcpSeconds;
  out.cls = primary.cls;
  out.inpMs = primary.inpMs;
  out.performanceScore = primary.scores.performance;
  out.fieldDataAvailable = primary.fieldDataAvailable;
  return out;
}

/**
 * Optional Google Safe Browsing lookup. Free API, but it requires a key —
 * without one this reports { configured: false }, never "clean".
 */
async function checkSafeBrowsing(url, { apiKey = process.env.GOOGLE_SAFE_BROWSING_API_KEY } = {}) {
  if (!apiKey) return { configured: false, reason: 'GOOGLE_SAFE_BROWSING_API_KEY is not set.' };
  try {
    const res = await fetch(`https://safebrowsing.googleapis.com/v4/threatMatches:find?key=${encodeURIComponent(apiKey)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client: { clientId: 'seo-audit-tool', clientVersion: '1.0' },
        threatInfo: {
          threatTypes: ['MALWARE', 'SOCIAL_ENGINEERING', 'UNWANTED_SOFTWARE', 'POTENTIALLY_HARMFUL_APPLICATION'],
          platformTypes: ['ANY_PLATFORM'],
          threatEntryTypes: ['URL'],
          threatEntries: [{ url }],
        },
      }),
    });
    if (!res.ok) return { configured: true, ok: false, error: `HTTP ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}` };
    const data = await res.json();
    const matches = data.matches || [];
    return { configured: true, ok: true, flagged: matches.length > 0, threats: matches.map((m) => m.threatType), source: 'Google Safe Browsing API v4' };
  } catch (err) {
    return { configured: true, ok: false, error: err.message };
  }
}

/**
 * Heuristic indexing check via a `site:` query against the Google Custom
 * Search JSON API. This is NOT authoritative (only Google Search Console's
 * URL Inspection API is), and must be labeled as a heuristic in the UI.
 * Requires GOOGLE_CUSTOM_SEARCH_API_KEY + GOOGLE_CUSTOM_SEARCH_ENGINE_ID.
 */
async function checkIndexing(url, {
  apiKey = process.env.GOOGLE_CUSTOM_SEARCH_API_KEY,
  cx = process.env.GOOGLE_CUSTOM_SEARCH_ENGINE_ID,
} = {}) {
  if (!apiKey || !cx) {
    return { configured: false, reason: 'GOOGLE_CUSTOM_SEARCH_API_KEY / GOOGLE_CUSTOM_SEARCH_ENGINE_ID not set.' };
  }
  const params = new URLSearchParams({
    key: apiKey,
    cx,
    q: `site:${url}`,
  });
  try {
    const res = await fetch(`${CUSTOM_SEARCH_ENDPOINT}?${params.toString()}`);
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      return { configured: true, status: 'uncertain', error: `HTTP ${res.status}: ${body.slice(0, 300)}` };
    }
    const data = await res.json();
    const totalResults = parseInt(data?.searchInformation?.totalResults || '0', 10);
    return {
      configured: true,
      status: totalResults > 0 ? 'indexed' : 'not_indexed',
      totalResults,
      source: 'Google Custom Search API (site: heuristic)',
    };
  } catch (err) {
    return { configured: true, status: 'uncertain', error: err.message };
  }
}

/**
 * Check a domain's position for one keyword by paging through real Google
 * Custom Search API results (10 per page). Costs one API call per page of
 * results checked — callers should budget against the 100/day free quota.
 * Requires GOOGLE_CUSTOM_SEARCH_API_KEY + GOOGLE_CUSTOM_SEARCH_ENGINE_ID.
 */
async function checkKeywordRank(domain, keyword, {
  apiKey = process.env.GOOGLE_CUSTOM_SEARCH_API_KEY,
  cx = process.env.GOOGLE_CUSTOM_SEARCH_ENGINE_ID,
  maxPages = 3, // 3 pages * 10 results = top 30, keeps quota usage sane
} = {}) {
  if (!apiKey || !cx) {
    return { configured: false, reason: 'GOOGLE_CUSTOM_SEARCH_API_KEY / GOOGLE_CUSTOM_SEARCH_ENGINE_ID not set.' };
  }
  const normalizedDomain = domain.replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/$/, '');

  for (let page = 0; page < maxPages; page++) {
    const start = page * 10 + 1;
    const params = new URLSearchParams({ key: apiKey, cx, q: keyword, start: String(start) });
    const res = await fetch(`${CUSTOM_SEARCH_ENDPOINT}?${params.toString()}`);
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      return { configured: true, ok: false, keyword, error: `HTTP ${res.status}: ${body.slice(0, 300)}` };
    }
    const data = await res.json();
    const items = data.items || [];
    for (let i = 0; i < items.length; i++) {
      const link = items[i].link || '';
      if (link.includes(normalizedDomain)) {
        return {
          configured: true,
          ok: true,
          keyword,
          position: start + i,
          url: link,
          source: 'Google Custom Search API',
        };
      }
    }
    if (items.length < 10) break; // no more results to page through
  }
  return { configured: true, ok: true, keyword, position: null, note: `Not found in top ${maxPages * 10} results.` };
}

module.exports = { getCoreWebVitals, checkIndexing, checkKeywordRank, checkSafeBrowsing };
