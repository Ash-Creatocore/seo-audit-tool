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
async function getCoreWebVitals(url, { apiKey = process.env.GOOGLE_PAGESPEED_API_KEY } = {}) {
  if (!apiKey) {
    return { configured: false, reason: 'GOOGLE_PAGESPEED_API_KEY is not set.' };
  }
  const params = new URLSearchParams({
    url,
    key: apiKey,
    strategy: 'mobile',
  });
  params.append('category', 'performance');

  const res = await fetch(`${PAGESPEED_ENDPOINT}?${params.toString()}`, { method: 'GET' });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    return { configured: true, ok: false, status: res.status, error: body.slice(0, 500) };
  }
  const data = await res.json();

  const audits = data?.lighthouseResult?.audits || {};
  const perfScore = data?.lighthouseResult?.categories?.performance?.score;
  // Field data (real Chrome UX Report data for this URL) when available,
  // falling back to lab data from the Lighthouse run — both are real
  // measurements from Google, never synthesized locally.
  const lcpMs =
    data?.loadingExperience?.metrics?.LARGEST_CONTENTFUL_PAINT_MS?.percentile ??
    (audits['largest-contentful-paint']?.numericValue ?? null);
  const cls =
    data?.loadingExperience?.metrics?.CUMULATIVE_LAYOUT_SHIFT_SCORE?.percentile != null
      ? data.loadingExperience.metrics.CUMULATIVE_LAYOUT_SHIFT_SCORE.percentile / 100
      : (audits['cumulative-layout-shift']?.numericValue ?? null);
  const inpMs = data?.loadingExperience?.metrics?.INTERACTION_TO_NEXT_PAINT?.percentile ?? null;

  return {
    configured: true,
    ok: true,
    lcpSeconds: lcpMs != null ? Math.round((lcpMs / 1000) * 100) / 100 : null,
    cls: cls != null ? Math.round(cls * 1000) / 1000 : null,
    inpMs: inpMs != null ? Math.round(inpMs) : null,
    performanceScore: perfScore != null ? Math.round(perfScore * 100) : null,
    fieldDataAvailable: !!data?.loadingExperience?.metrics,
    source: 'Google PageSpeed Insights API',
  };
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

module.exports = { getCoreWebVitals, checkIndexing, checkKeywordRank };
