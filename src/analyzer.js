'use strict';

const cheerio = require('cheerio');

const SEVERITY = { ERROR: 'error', WARNING: 'warning', NOTICE: 'notice' };

function issue(id, severity, message) {
  return { id, severity, message };
}

function countWords(text) {
  return (text.trim().match(/\S+/g) || []).length;
}

/**
 * Analyze a single crawled page. `page` is the raw object from crawler.js
 * (url, finalUrl, status, isHtml, html, responseTimeMs, redirected, blockedByRobots).
 */
function analyzePage(page, siteUrlObj) {
  const issues = [];
  const meta = {
    url: page.url,
    finalUrl: page.finalUrl || page.url,
    status: page.status,
    title: null,
    titleLength: 0,
    metaDescription: null,
    metaDescriptionLength: 0,
    h1: [],
    h2Count: 0,
    canonical: null,
    isSelfCanonical: null,
    wordCount: 0,
    imagesTotal: 0,
    imagesMissingAlt: 0,
    hasViewport: false,
    isHttps: page.finalUrl ? page.finalUrl.startsWith('https:') : page.url.startsWith('https:'),
    metaRobotsNoindex: false,
    metaRobotsNofollow: false,
    hasOpenGraph: false,
    hasTwitterCard: false,
    hasStructuredData: false,
    responseTimeMs: page.responseTimeMs || 0,
    redirected: !!page.redirected,
    blockedByRobots: !!page.blockedByRobots,
  };

  if (page.blockedByRobots) {
    issues.push(issue('blocked-by-robots', SEVERITY.NOTICE, 'This URL is disallowed by robots.txt and was not crawled.'));
    return { meta, issues };
  }

  // --- Status code checks ---
  if (!page.ok || page.status === 0) {
    issues.push(issue('request-failed', SEVERITY.ERROR, `Request failed: ${page.error || 'unknown error'}`));
    return { meta, issues };
  }
  if (page.status >= 500) {
    issues.push(issue('server-error', SEVERITY.ERROR, `Server error (HTTP ${page.status}).`));
  } else if (page.status === 404) {
    issues.push(issue('not-found', SEVERITY.ERROR, 'Page returns 404 Not Found.'));
  } else if (page.status >= 400) {
    issues.push(issue('client-error', SEVERITY.ERROR, `Client error (HTTP ${page.status}).`));
  } else if (page.status >= 300) {
    issues.push(issue('redirect', SEVERITY.WARNING, `Page returns a redirect (HTTP ${page.status}).`));
  }

  if (page.redirected) {
    issues.push(issue('was-redirected', SEVERITY.NOTICE, `URL redirected to ${page.finalUrl}.`));
  }

  if (page.responseTimeMs > 3000) {
    issues.push(issue('slow-response', SEVERITY.WARNING, `Slow server response time (${page.responseTimeMs}ms).`));
  }

  if (!meta.isHttps) {
    issues.push(issue('not-https', SEVERITY.ERROR, 'Page is not served over HTTPS.'));
  }

  if (!page.isHtml || !page.html) {
    if (page.status < 300) {
      issues.push(issue('non-html', SEVERITY.NOTICE, 'Resource is not an HTML page; skipped content checks.'));
    }
    return { meta, issues };
  }

  // --- Parse HTML for on-page checks ---
  let $;
  try {
    $ = cheerio.load(page.html);
  } catch {
    issues.push(issue('parse-error', SEVERITY.ERROR, 'Could not parse HTML.'));
    return { meta, issues };
  }

  // Title
  const title = $('title').first().text().trim();
  meta.title = title || null;
  meta.titleLength = title.length;
  if (!title) {
    issues.push(issue('missing-title', SEVERITY.ERROR, 'Missing <title> tag.'));
  } else if (title.length < 30) {
    issues.push(issue('title-too-short', SEVERITY.WARNING, `Title is short (${title.length} chars); aim for 50-60.`));
  } else if (title.length > 65) {
    issues.push(issue('title-too-long', SEVERITY.WARNING, `Title is long (${title.length} chars) and may be truncated in search results.`));
  }

  // Meta description
  const metaDesc = $('meta[name="description"]').attr('content')?.trim() || '';
  meta.metaDescription = metaDesc || null;
  meta.metaDescriptionLength = metaDesc.length;
  if (!metaDesc) {
    issues.push(issue('missing-meta-description', SEVERITY.WARNING, 'Missing meta description.'));
  } else if (metaDesc.length < 70) {
    issues.push(issue('meta-description-short', SEVERITY.NOTICE, `Meta description is short (${metaDesc.length} chars); aim for 120-160.`));
  } else if (metaDesc.length > 165) {
    issues.push(issue('meta-description-long', SEVERITY.NOTICE, `Meta description is long (${metaDesc.length} chars) and may be truncated.`));
  }

  // H1
  const h1s = $('h1').map((_, el) => $(el).text().trim()).get().filter(Boolean);
  meta.h1 = h1s;
  meta.h2Count = $('h2').length;
  if (h1s.length === 0) {
    issues.push(issue('missing-h1', SEVERITY.WARNING, 'Missing <h1> tag.'));
  } else if (h1s.length > 1) {
    issues.push(issue('multiple-h1', SEVERITY.NOTICE, `Multiple <h1> tags found (${h1s.length}).`));
  }

  // Canonical
  const canonical = $('link[rel="canonical"]').attr('href') || null;
  meta.canonical = canonical;
  if (!canonical) {
    issues.push(issue('missing-canonical', SEVERITY.NOTICE, 'Missing canonical link tag.'));
  } else {
    try {
      const canonicalAbs = new URL(canonical, meta.finalUrl).toString().replace(/\/$/, '');
      const selfAbs = meta.finalUrl.replace(/\/$/, '');
      meta.isSelfCanonical = canonicalAbs === selfAbs;
    } catch {
      meta.isSelfCanonical = null;
    }
  }

  // Word count (visible text, rough)
  $('script, style, noscript').remove();
  const bodyText = $('body').text().replace(/\s+/g, ' ').trim();
  meta.wordCount = countWords(bodyText);
  if (meta.wordCount < 300) {
    issues.push(issue('thin-content', SEVERITY.WARNING, `Thin content: only ~${meta.wordCount} words.`));
  }

  // Images / alt text
  const images = $('img');
  meta.imagesTotal = images.length;
  let missingAlt = 0;
  images.each((_, el) => {
    const alt = $(el).attr('alt');
    if (alt === undefined || alt.trim() === '') missingAlt++;
  });
  meta.imagesMissingAlt = missingAlt;
  if (missingAlt > 0) {
    issues.push(issue('images-missing-alt', SEVERITY.WARNING, `${missingAlt} of ${images.length} image(s) missing alt text.`));
  }

  // Viewport
  meta.hasViewport = $('meta[name="viewport"]').length > 0;
  if (!meta.hasViewport) {
    issues.push(issue('missing-viewport', SEVERITY.WARNING, 'Missing mobile viewport meta tag.'));
  }

  // Meta robots
  const robotsContent = ($('meta[name="robots"]').attr('content') || '').toLowerCase();
  meta.metaRobotsNoindex = robotsContent.includes('noindex');
  meta.metaRobotsNofollow = robotsContent.includes('nofollow');
  if (meta.metaRobotsNoindex) {
    issues.push(issue('noindex', SEVERITY.NOTICE, 'Page is marked noindex and will be excluded from search results.'));
  }

  // Open Graph / Twitter Card
  meta.hasOpenGraph = $('meta[property^="og:"]').length > 0;
  meta.hasTwitterCard = $('meta[name^="twitter:"]').length > 0;
  if (!meta.hasOpenGraph) {
    issues.push(issue('missing-open-graph', SEVERITY.NOTICE, 'Missing Open Graph tags (affects social share previews).'));
  }

  // Structured data
  meta.hasStructuredData = $('script[type="application/ld+json"]').length > 0 || $('[itemscope]').length > 0;
  if (!meta.hasStructuredData) {
    issues.push(issue('missing-structured-data', SEVERITY.NOTICE, 'No structured data (JSON-LD/microdata) detected.'));
  }

  return { meta, issues };
}

module.exports = { analyzePage, SEVERITY };
