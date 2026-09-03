'use strict';

const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const crypto = require('crypto');
const path = require('path');
const { crawlSite, normalizeUrl } = require('./src/crawler');
const { analyzePage } = require('./src/analyzer');
const { summarize } = require('./src/scoring');
const { getCoreWebVitals, checkIndexing, checkKeywordRank } = require('./src/externalApis');
const { recordAndDiff } = require('./src/rankHistory');

const app = express();
app.set('trust proxy', 1); // needed for correct per-IP rate limiting behind Render/Railway/etc.'s proxy

// CORS: needed if a frontend built elsewhere (e.g. GHL AI Studio) calls this
// API from a different domain. Restrict via ALLOWED_ORIGIN in production —
// left open by default since this ships as a self-hosted prototype.
const allowedOrigin = process.env.ALLOWED_ORIGIN;
app.use(cors(allowedOrigin ? { origin: allowedOrigin } : {}));

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

/**
 * Optional shared-secret gate for the two endpoints that actually cost money
 * / do work (a crawl, an API-quota-consuming rank check). Off by default so
 * local development and the bundled dashboard keep working with zero setup;
 * set API_SHARED_SECRET before deploying this publicly so a stranger who
 * finds the URL can't use your server as a free open crawler.
 */
function requireApiKey(req, res, next) {
  const required = process.env.API_SHARED_SECRET;
  if (!required) return next();
  if (req.get('X-API-Key') !== required) {
    return res.status(401).json({ error: 'Missing or invalid X-API-Key header.' });
  }
  next();
}

/**
 * Rate limiting for the same two endpoints — protects both your hosting bill
 * (each audit does real crawling) and your Google API daily quota. Defaults
 * are generous for a single small business's own use; tighten via env vars
 * if this is ever exposed more broadly.
 */
const auditLimiter = rateLimit({
  windowMs: (parseInt(process.env.RATE_LIMIT_WINDOW_MINUTES, 10) || 15) * 60 * 1000,
  max: parseInt(process.env.RATE_LIMIT_MAX_AUDITS, 10) || 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many audits requested from this IP recently. Please wait and try again.' },
});
const rankLimiter = rateLimit({
  windowMs: (parseInt(process.env.RATE_LIMIT_WINDOW_MINUTES, 10) || 15) * 60 * 1000,
  max: parseInt(process.env.RATE_LIMIT_MAX_RANK_CHECKS, 10) || 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many rank checks requested from this IP recently. Please wait and try again.' },
});

// In-memory job store (prototype only — swap for a DB/queue for production use)
const jobs = new Map();

function newJobId() {
  return crypto.randomBytes(8).toString('hex');
}

app.post('/api/audit', requireApiKey, auditLimiter, async (req, res) => {
  const { url, maxPages, checkExternalLinks, renderJs } = req.body || {};
  const normalized = normalizeUrl(url || '');
  if (!normalized) {
    return res.status(400).json({ error: 'Please provide a valid URL, e.g. https://example.com' });
  }

  const id = newJobId();
  const job = {
    id,
    startUrl: normalized,
    status: 'running', // running | done | error
    crawled: 0,
    total: 1,
    currentUrl: normalized,
    createdAt: Date.now(),
    summary: null,
    pages: null,
    error: null,
  };
  jobs.set(id, job);
  res.json({ id });

  // Run the crawl + analysis asynchronously; job object is updated in place.
  (async () => {
    try {
      const crawlStartedAt = Date.now();
      const crawlResult = await crawlSite(
        normalized,
        {
          maxPages: Math.min(Math.max(parseInt(maxPages, 10) || 20, 1), 100),
          checkExternalLinks: checkExternalLinks !== false,
          renderJs: renderJs === true,
        },
        ({ crawled, total, currentUrl }) => {
          job.crawled = crawled;
          job.total = Math.max(total, crawled);
          job.currentUrl = currentUrl;
        }
      );
      const crawlTimeMs = Date.now() - crawlStartedAt;

      const pageAudits = crawlResult.pages.map((page) => analyzePage(page));
      const summary = summarize(crawlResult, pageAudits, { crawlTimeMs });
      // Honest JS-rendering status: whether it was asked for, whether it
      // actually ran, and why not if it didn't — never silently downgraded.
      summary.renderJs = {
        requested: crawlResult.renderJsRequested,
        used: crawlResult.renderJsUsed,
        unavailableReason: crawlResult.renderJsUnavailableReason,
      };

      // Real Core Web Vitals for the audited URL (PageSpeed Insights).
      // If no API key is configured, this returns { configured: false } —
      // the frontend must show that honestly, never a fake LCP/CLS/INP.
      try {
        summary.coreWebVitals = await getCoreWebVitals(normalized);
      } catch (err) {
        summary.coreWebVitals = { configured: true, ok: false, error: err.message };
      }

      // Real (heuristic) indexing check for the root URL only, to conserve
      // the Custom Search API's free daily quota. See METHODOLOGY note in
      // the frontend — this is a `site:` query, not Search Console data.
      try {
        summary.indexing = await checkIndexing(normalized);
      } catch (err) {
        summary.indexing = { configured: true, status: 'uncertain', error: err.message };
      }

      job.status = 'done';
      job.summary = summary;
      job.pages = pageAudits.map((p) => ({ meta: p.meta, issues: p.issues }));
      job.robots = crawlResult.robots.exists;
      job.sitemap = crawlResult.sitemap.exists;
    } catch (err) {
      job.status = 'error';
      job.error = err.message || 'Crawl failed';
    }
  })();
});

app.get('/api/audit/:id', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.json(job);
});

/**
 * On-demand keyword rank check — kept separate from /api/audit so the user
 * explicitly controls Custom Search API quota spend (each keyword costs up
 * to `maxPages` queries against the shared 100/day free quota). Body:
 * { domain: string, keywords: string[] }.
 */
app.post('/api/rank-check', requireApiKey, rankLimiter, async (req, res) => {
  const { domain, keywords } = req.body || {};
  if (!domain || !Array.isArray(keywords) || keywords.length === 0) {
    return res.status(400).json({ error: 'Provide { domain, keywords: [...] }.' });
  }
  const capped = keywords.slice(0, 10); // hard cap per request to protect quota

  const results = [];
  for (const keyword of capped) {
    try {
      const result = await checkKeywordRank(domain, keyword);
      if (!result.configured) {
        results.push(result);
        continue; // no point checking more if the API isn't configured at all
      }
      if (result.ok) {
        const { change, bestPosition, previousPosition } = recordAndDiff(domain, keyword, result.position);
        results.push({ ...result, change, bestPosition, previousPosition });
      } else {
        results.push(result);
      }
    } catch (err) {
      results.push({ configured: true, ok: false, keyword, error: err.message });
    }
  }
  res.json({ domain, results });
});

// Cleanup old jobs periodically (prototype hygiene)
setInterval(() => {
  const cutoff = Date.now() - 1000 * 60 * 60; // 1 hour
  for (const [id, job] of jobs.entries()) {
    if (job.createdAt < cutoff) jobs.delete(id);
  }
}, 1000 * 60 * 15).unref();

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`SEO Audit Tool running at http://localhost:${PORT}`);
  if (!process.env.GOOGLE_PAGESPEED_API_KEY) {
    console.warn('GOOGLE_PAGESPEED_API_KEY not set — Core Web Vitals will report as unconfigured, not fake data.');
  }
  if (!process.env.GOOGLE_CUSTOM_SEARCH_API_KEY || !process.env.GOOGLE_CUSTOM_SEARCH_ENGINE_ID) {
    console.warn('GOOGLE_CUSTOM_SEARCH_API_KEY / GOOGLE_CUSTOM_SEARCH_ENGINE_ID not set — indexing & rank checks will report as unconfigured, not fake data.');
  }
  if (!process.env.API_SHARED_SECRET) {
    console.warn('API_SHARED_SECRET not set — /api/audit and /api/rank-check are open to anyone who finds this URL. Set it before deploying publicly.');
  }
});
