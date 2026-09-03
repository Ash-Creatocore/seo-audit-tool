'use strict';

const WEIGHTS = { error: 5, warning: 2, notice: 0.5 };

const CATEGORY_LABELS = {
  meta: 'Meta & Indexing',
  content: 'Content & Keywords',
  structure: 'Headings & Structure',
  links: 'Links & URLs',
  images: 'Images',
  technical: 'Technical HTML',
  security: 'Security',
  performance: 'Performance',
  social: 'Social',
  crawl: 'Crawlability',
};

/**
 * Score a single page 0-100 from its own issue list, using the same
 * severity weights as the site-wide score.
 */
function computePageScore(issues) {
  let penalty = 0;
  for (const iss of issues) penalty += WEIGHTS[iss.severity] || 0;
  return Math.max(0, Math.min(100, Math.round(100 - penalty)));
}

function computeSiteIssues(crawlResult, pageAudits) {
  const siteIssues = [];

  if (!crawlResult.robots.exists) {
    siteIssues.push({ id: 'missing-robots-txt', severity: 'notice', category: 'crawl', message: 'No robots.txt found at site root.', affected: 1 });
  }
  if (!crawlResult.sitemap.exists) {
    siteIssues.push({ id: 'missing-sitemap', severity: 'notice', category: 'crawl', message: 'No sitemap.xml found at site root or declared in robots.txt.', affected: 1 });
  }

  const titleMap = new Map();
  const descMap = new Map();
  const h1Map = new Map();
  const contentMap = new Map();
  for (const { meta, details } of pageAudits) {
    if (meta.blockedByRobots || meta.status >= 300) continue;
    if (meta.title) {
      const key = meta.title.toLowerCase();
      if (!titleMap.has(key)) titleMap.set(key, []);
      titleMap.get(key).push(meta.finalUrl);
    }
    if (meta.metaDescription) {
      const key = meta.metaDescription.toLowerCase();
      if (!descMap.has(key)) descMap.set(key, []);
      descMap.get(key).push(meta.finalUrl);
    }
    if (meta.h1 && meta.h1[0]) {
      const key = meta.h1[0].toLowerCase();
      if (!h1Map.has(key)) h1Map.set(key, []);
      h1Map.get(key).push(meta.finalUrl);
    }
    // Duplicate-content detection: identical top-keyword profile + word count
    // within 2% is a strong, measurable signal of near-identical pages.
    const kw = details?.keywords?.topKeywords?.slice(0, 8).map((k) => k.term).join('|');
    if (kw && meta.wordCount > 100) {
      const key = `${kw}::${Math.round(meta.wordCount / 50)}`;
      if (!contentMap.has(key)) contentMap.set(key, []);
      contentMap.get(key).push(meta.finalUrl);
    }
  }
  for (const [title, urls] of titleMap.entries()) {
    if (urls.length > 1) {
      siteIssues.push({ id: 'duplicate-title', severity: 'warning', category: 'meta', message: `Duplicate title "${title}" used on ${urls.length} pages.`, affected: urls.length, urls });
    }
  }
  for (const [, urls] of descMap.entries()) {
    if (urls.length > 1) {
      siteIssues.push({ id: 'duplicate-meta-description', severity: 'notice', category: 'meta', message: `Duplicate meta description used on ${urls.length} pages.`, affected: urls.length, urls });
    }
  }
  for (const [h1, urls] of h1Map.entries()) {
    if (urls.length > 1) {
      siteIssues.push({ id: 'duplicate-h1', severity: 'notice', category: 'structure', message: `Duplicate H1 "${h1}" used on ${urls.length} pages.`, affected: urls.length, urls });
    }
  }
  for (const [, urls] of contentMap.entries()) {
    if (urls.length > 1) {
      siteIssues.push({ id: 'duplicate-content', severity: 'warning', category: 'content', message: `${urls.length} pages have near-identical content (same keyword profile and length).`, affected: urls.length, urls });
    }
  }

  const brokenExternal = (crawlResult.externalLinkResults || []).filter((l) => l.broken);
  if (brokenExternal.length > 0) {
    siteIssues.push({
      id: 'broken-external-links', severity: 'warning', category: 'links',
      message: `${brokenExternal.length} broken external link(s) returned 4xx/5xx (sampled ${crawlResult.externalLinkResults.length}).`,
      affected: brokenExternal.length, urls: brokenExternal.map((l) => `${l.url} → HTTP ${l.status}`),
    });
  }
  const unreachableExternal = (crawlResult.externalLinkResults || []).filter((l) => l.unreachable);
  if (unreachableExternal.length > 0) {
    siteIssues.push({
      id: 'unreachable-external-links', severity: 'notice', category: 'links',
      message: `${unreachableExternal.length} external link(s) could not be reached from this server (DNS/timeout) — verify manually; may be transient or a network restriction.`,
      affected: unreachableExternal.length, urls: unreachableExternal.map((l) => `${l.url} (${l.error || 'unreachable'})`),
    });
  }

  const orphanPages = crawlResult.orphanPages || [];
  if (orphanPages.length > 0) {
    siteIssues.push({ id: 'orphan-pages', severity: 'notice', category: 'crawl', message: `${orphanPages.length} orphan page(s) in the sitemap have no internal links pointing to them.`, affected: orphanPages.length, urls: orphanPages });
  }

  const deep = pageAudits.filter((p) => (p.depth ?? 0) > 3).map((p) => p.meta.finalUrl);
  if (deep.length) {
    siteIssues.push({ id: 'deep-pages', severity: 'notice', category: 'crawl', message: `${deep.length} page(s) need more than 3 clicks from the homepage.`, affected: deep.length, urls: deep.slice(0, 20) });
  }

  // Pages with exactly one inbound link (weak internal linking)
  const inbound = crawlResult.inboundLinkCount || {};
  const weak = pageAudits.filter((p) => !p.meta.blockedByRobots && p.meta.status < 300 && (inbound[p.meta.finalUrl] || 0) === 1 && p.depth > 0).map((p) => p.meta.finalUrl);
  if (weak.length) {
    siteIssues.push({ id: 'single-inbound-link', severity: 'notice', category: 'links', message: `${weak.length} page(s) have only one internal link pointing to them.`, affected: weak.length, urls: weak.slice(0, 20) });
  }

  return { siteIssues, duplicateUrls: new Set([...titleMap.values(), ...descMap.values()].filter((g) => g.length > 1).flat()) };
}

function categoryScores(pageAudits, siteIssues, siteCheckIssues) {
  const cats = Object.keys(CATEGORY_LABELS);
  const scores = {};
  for (const c of cats) {
    // Page-level: average of per-page category scores over crawlable pages.
    const pages = pageAudits.filter((p) => !p.meta.blockedByRobots);
    let pageAvg = 100;
    if (pages.length) {
      let sum = 0;
      for (const p of pages) {
        let penalty = 0;
        for (const iss of p.issues) if (iss.category === c) penalty += WEIGHTS[iss.severity] || 0;
        sum += Math.max(0, 100 - penalty);
      }
      pageAvg = sum / pages.length;
    }
    // Site-level issues in this category apply once.
    let sitePenalty = 0;
    for (const iss of [...siteIssues, ...siteCheckIssues]) if (iss.category === c) sitePenalty += (WEIGHTS[iss.severity] || 0) * 2;
    const issueCount = pages.reduce((n, p) => n + p.issues.filter((i) => i.category === c).length, 0) + [...siteIssues, ...siteCheckIssues].filter((i) => i.category === c).length;
    scores[c] = { label: CATEGORY_LABELS[c], score: Math.max(0, Math.min(100, Math.round(pageAvg - sitePenalty))), issueCount };
  }
  return scores;
}

function summarize(crawlResult, pageAudits, meta = {}) {
  const { siteIssues, duplicateUrls } = computeSiteIssues(crawlResult, pageAudits);
  const siteCheckIssues = meta.siteCheckIssues || [];

  const counts = { error: 0, warning: 0, notice: 0 };
  const issueFrequency = new Map();

  const tally = (list, isPageIssue, pageUrl) => {
    for (const iss of list) {
      counts[iss.severity] = (counts[iss.severity] || 0) + 1;
      if (!issueFrequency.has(iss.id)) {
        issueFrequency.set(iss.id, { id: iss.id, severity: iss.severity, category: iss.category || 'technical', sampleMessage: iss.message, count: 0, urls: [] });
      }
      const entry = issueFrequency.get(iss.id);
      entry.count += 1;
      if (isPageIssue && pageUrl && entry.urls.length < 20) entry.urls.push(pageUrl);
      if (!isPageIssue && iss.urls) entry.urls = iss.urls.slice(0, 20);
    }
  };

  for (const { meta: m, issues } of pageAudits) tally(issues, true, m.finalUrl);
  tally(siteIssues, false, null);
  tally(siteCheckIssues, false, null);

  let penalty = 0;
  for (const sev of ['error', 'warning', 'notice']) penalty += counts[sev] * WEIGHTS[sev];
  // Normalise by page count so a 100-page crawl isn't punished 10× harder
  // than a 10-page crawl for the same per-page hygiene.
  const pagesForNorm = Math.max(1, pageAudits.filter((p) => !p.meta.blockedByRobots).length);
  const normalizedPenalty = penalty / Math.sqrt(pagesForNorm);
  const score = Math.max(0, Math.min(100, Math.round(100 - normalizedPenalty)));

  const order = { error: 0, warning: 1, notice: 2 };
  const topIssues = [...issueFrequency.values()].sort((a, b) => (order[a.severity] - order[b.severity]) || (b.count - a.count));

  const pagesWithErrors = pageAudits.filter((p) => p.issues.some((i) => i.severity === 'error')).length;
  const brokenPages = pageAudits.filter((p) => !p.meta.blockedByRobots && (p.meta.status >= 400 || p.meta.status === 0)).length;

  const pageScores = pageAudits.map((p) => ({ url: p.meta.finalUrl, status: p.meta.status, score: computePageScore(p.issues), depth: p.depth ?? null }));
  const avgPageScore = pageScores.length ? pageScores.reduce((s, p) => s + p.score, 0) / pageScores.length : 0;
  const brokenLinksTotal =
    (crawlResult.pages || []).filter((p) => !p.blockedByRobots && (p.status >= 400 || p.status === 0)).length +
    (crawlResult.externalLinkResults || []).filter((l) => l.broken).length;
  const orphanCount = (crawlResult.orphanPages || []).length;
  const duplicateCount = duplicateUrls.size;
  const siteHealthPenalty = brokenLinksTotal * 3 + duplicateCount * 2 + orphanCount * 1.5;
  const siteHealthScore = Math.max(0, Math.min(100, Math.round(avgPageScore - siteHealthPenalty)));

  return {
    score,
    counts,
    categoryScores: categoryScores(pageAudits, siteIssues, siteCheckIssues),
    totalPagesCrawled: pageAudits.length,
    pagesWithErrors,
    brokenPages,
    robotsTxtFound: crawlResult.robots.exists,
    sitemapFound: crawlResult.sitemap.exists,
    internalLinksFound: crawlResult.totalInternalLinksFound,
    externalLinksFound: crawlResult.totalExternalLinksFound,
    externalLinksChecked: (crawlResult.externalLinkResults || []).length,
    topIssues,
    siteIssues,
    siteHealthScore,
    crawlTimeMs: meta.crawlTimeMs ?? null,
    brokenLinksTotal,
    duplicatePagesCount: duplicateCount,
    orphanPagesCount: orphanCount,
    depthDistribution: crawlResult.depthDistribution || {},
    pageScores,
  };
}

module.exports = { summarize, computePageScore, CATEGORY_LABELS };
