'use strict';

const WEIGHTS = { error: 5, warning: 2, notice: 0.5 };

/**
 * Score a single page 0-100 from its own issue list, using the same
 * severity weights as the site-wide score. Used for the per-page "Score"
 * column in the crawled-pages table.
 */
function computePageScore(issues) {
  let penalty = 0;
  for (const iss of issues) {
    penalty += WEIGHTS[iss.severity] || 0;
  }
  return Math.max(0, Math.min(100, Math.round(100 - penalty)));
}

function computeSiteIssues(crawlResult, pageAudits) {
  const siteIssues = [];

  if (!crawlResult.robots.exists) {
    siteIssues.push({ id: 'missing-robots-txt', severity: 'notice', message: 'No robots.txt found at site root.', affected: 1 });
  }
  if (!crawlResult.sitemap.exists) {
    siteIssues.push({ id: 'missing-sitemap', severity: 'notice', message: 'No sitemap.xml found at site root.', affected: 1 });
  }

  // Duplicate titles
  const titleMap = new Map();
  const descMap = new Map();
  for (const { meta } of pageAudits) {
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
  }
  for (const [title, urls] of titleMap.entries()) {
    if (urls.length > 1) {
      siteIssues.push({
        id: 'duplicate-title',
        severity: 'warning',
        message: `Duplicate title "${title}" used on ${urls.length} pages.`,
        affected: urls.length,
        urls,
      });
    }
  }
  for (const [desc, urls] of descMap.entries()) {
    if (urls.length > 1) {
      siteIssues.push({
        id: 'duplicate-meta-description',
        severity: 'notice',
        message: `Duplicate meta description used on ${urls.length} pages.`,
        affected: urls.length,
        urls,
      });
    }
  }

  // Broken external links
  const brokenExternal = (crawlResult.externalLinkResults || []).filter((l) => l.broken);
  if (brokenExternal.length > 0) {
    siteIssues.push({
      id: 'broken-external-links',
      severity: 'warning',
      message: `${brokenExternal.length} broken external link(s) found (sampled ${crawlResult.externalLinkResults.length}).`,
      affected: brokenExternal.length,
      urls: brokenExternal.map((l) => l.url),
    });
  }

  // Orphan pages — in the sitemap but never linked to from any crawled page.
  const orphanPages = crawlResult.orphanPages || [];
  if (orphanPages.length > 0) {
    siteIssues.push({
      id: 'orphan-pages',
      severity: 'notice',
      message: `${orphanPages.length} orphan page(s) found in sitemap.xml with no internal links pointing to them.`,
      affected: orphanPages.length,
      urls: orphanPages,
    });
  }

  return { siteIssues, duplicateUrls: new Set([...titleMap.values(), ...descMap.values()].filter((g) => g.length > 1).flat()) };
}

function summarize(crawlResult, pageAudits, meta = {}) {
  const { siteIssues, duplicateUrls } = computeSiteIssues(crawlResult, pageAudits);

  const counts = { error: 0, warning: 0, notice: 0 };
  const issueFrequency = new Map(); // id -> { id, severity, message(sample), count, urls: [] }

  const tally = (list, isPageIssue, pageUrl) => {
    for (const iss of list) {
      counts[iss.severity] = (counts[iss.severity] || 0) + 1;
      if (!issueFrequency.has(iss.id)) {
        issueFrequency.set(iss.id, { id: iss.id, severity: iss.severity, sampleMessage: iss.message, count: 0, urls: [] });
      }
      const entry = issueFrequency.get(iss.id);
      entry.count += 1;
      if (isPageIssue && pageUrl && entry.urls.length < 20) entry.urls.push(pageUrl);
    }
  };

  for (const { meta, issues } of pageAudits) {
    tally(issues, true, meta.finalUrl);
  }
  tally(siteIssues, false, null);

  let penalty = 0;
  for (const sev of ['error', 'warning', 'notice']) {
    penalty += counts[sev] * WEIGHTS[sev];
  }
  const score = Math.max(0, Math.min(100, Math.round(100 - penalty)));

  const topIssues = [...issueFrequency.values()].sort((a, b) => {
    const order = { error: 0, warning: 1, notice: 2 };
    if (order[a.severity] !== order[b.severity]) return order[a.severity] - order[b.severity];
    return b.count - a.count;
  });

  const pagesWithErrors = pageAudits.filter((p) => p.issues.some((i) => i.severity === 'error')).length;
  // "Broken" excludes robots-blocked pages (status 0 there means "not fetched
  // by design", not "dead link") — only count real 4xx/5xx or failed requests.
  const brokenPages = pageAudits.filter(
    (p) => !p.meta.blockedByRobots && (p.meta.status >= 400 || p.meta.status === 0)
  ).length;

  // Per-page scores for the "Crawled Pages List" table.
  const pageScores = pageAudits.map((p) => ({
    url: p.meta.finalUrl,
    status: p.meta.status,
    score: computePageScore(p.issues),
  }));

  // Site Health = average per-page score, further penalized for site-wide
  // crawl-level problems (broken links, duplicate pages, orphans) that no
  // single page's own score captures.
  const avgPageScore = pageScores.length
    ? pageScores.reduce((sum, p) => sum + p.score, 0) / pageScores.length
    : 0;
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
    // Site Crawl tab data
    siteHealthScore,
    crawlTimeMs: meta.crawlTimeMs ?? null,
    brokenLinksTotal,
    duplicatePagesCount: duplicateCount,
    orphanPagesCount: orphanCount,
    depthDistribution: crawlResult.depthDistribution || {},
    pageScores,
  };
}

module.exports = { summarize, computePageScore };
