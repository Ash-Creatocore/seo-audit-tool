'use strict';

const cheerio = require('cheerio');
const { URL } = require('url');

/**
 * Per-page analyzer.
 *
 * Every check in this file is computed from the page's actual fetched HTML
 * and HTTP response headers. Nothing here estimates, guesses, or fills in a
 * plausible value — if a signal isn't present in the response, the check
 * either reports the absence as a finding or is skipped. Each issue carries
 * a `category` so the dashboard can score and group them the way tools like
 * Seobility / SEOptimer / SEO Site Checkup do.
 */

const SEVERITY = { ERROR: 'error', WARNING: 'warning', NOTICE: 'notice' };

const CATEGORIES = {
  META: 'meta',
  CONTENT: 'content',
  STRUCTURE: 'structure',
  LINKS: 'links',
  IMAGES: 'images',
  TECHNICAL: 'technical',
  SECURITY: 'security',
  PERFORMANCE: 'performance',
  SOCIAL: 'social',
  CRAWL: 'crawl',
};

function issue(id, severity, category, message, extra = {}) {
  return { id, severity, category, message, ...extra };
}

// --- Keyword analysis helpers ------------------------------------------------

const STOPWORDS = new Set(
  (
    'a about above after again against all am an and any are as at be because been before being below between both but by ' +
    'can could did do does doing down during each few for from further had has have having he her here hers herself him himself ' +
    'his how i if in into is it its itself just let me more most my myself no nor not now of off on once only or other our ours ' +
    'ourselves out over own same she should so some such than that the their theirs them themselves then there these they this ' +
    'those through to too under until up us very was we were what when where which while who whom why will with would you your ' +
    'yours yourself yourselves get got also like one two new use using via etc per may might must shall'
  ).split(/\s+/)
);

function tokenize(text) {
  return (text.toLowerCase().match(/[a-z0-9][a-z0-9'-]{1,}/g) || []).filter(
    (w) => w.length > 2 && !STOPWORDS.has(w) && !/^\d+$/.test(w)
  );
}

function topTerms(tokens, n) {
  const freq = new Map();
  for (const t of tokens) freq.set(t, (freq.get(t) || 0) + 1);
  return [...freq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([term, count]) => ({ term, count }));
}

function topPhrases(tokens, size, n) {
  const freq = new Map();
  for (let i = 0; i + size <= tokens.length; i++) {
    const phrase = tokens.slice(i, i + size).join(' ');
    freq.set(phrase, (freq.get(phrase) || 0) + 1);
  }
  return [...freq.entries()]
    .filter(([, c]) => c > 1)
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([term, count]) => ({ term, count }));
}

function countWords(text) {
  return (text.trim().match(/\S+/g) || []).length;
}

// --- Detection tables --------------------------------------------------------

const DEPRECATED_TAGS = ['font', 'center', 'marquee', 'blink', 'frame', 'frameset', 'applet', 'big', 'strike', 'tt', 'u', 'basefont', 'dir', 'acronym', 'isindex'];
const GENERIC_ANCHORS = new Set(['click here', 'here', 'read more', 'more', 'link', 'this', 'learn more', 'click', 'go', 'this page', 'website']);
const SOCIAL_PATTERNS = {
  facebook: /(^|\.)facebook\.com$|(^|\.)fb\.com$/i,
  x: /(^|\.)twitter\.com$|(^|\.)x\.com$/i,
  instagram: /(^|\.)instagram\.com$/i,
  linkedin: /(^|\.)linkedin\.com$/i,
  youtube: /(^|\.)youtube\.com$|(^|\.)youtu\.be$/i,
  tiktok: /(^|\.)tiktok\.com$/i,
  pinterest: /(^|\.)pinterest\.com$/i,
};

function headerValue(headers, name) {
  if (!headers) return null;
  const key = Object.keys(headers).find((k) => k.toLowerCase() === name.toLowerCase());
  return key ? headers[key] : null;
}

/**
 * Analyze a single crawled page. `page` is the raw object from crawler.js
 * (url, finalUrl, status, isHtml, html, responseTimeMs, redirected,
 * blockedByRobots, headers, htmlBytes).
 */
function analyzePage(page, siteContext = {}) {
  const issues = [];
  // Server-configuration findings (security headers, server signature,
  // analytics snippet) are properties of the site, not of each page, so
  // they are raised once — on the start page — to avoid ×N noise.
  const siteWide = !!siteContext.isStartPage;
  const headers = page.headers || {};
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
    isHttps: (page.finalUrl || page.url).startsWith('https:'),
    metaRobotsNoindex: false,
    metaRobotsNofollow: false,
    hasOpenGraph: false,
    hasTwitterCard: false,
    hasStructuredData: false,
    responseTimeMs: page.responseTimeMs || 0,
    redirected: !!page.redirected,
    blockedByRobots: !!page.blockedByRobots,
    htmlBytes: page.htmlBytes || (page.html ? Buffer.byteLength(page.html, 'utf8') : 0),
    headersAvailable: Object.keys(headers).length > 0,
    contentStripped: !!page.contentStripped,
  };
  const details = {};

  if (page.blockedByRobots) {
    issues.push(issue('blocked-by-robots', SEVERITY.NOTICE, CATEGORIES.CRAWL, 'This URL is disallowed by robots.txt and was not crawled.'));
    return { meta, issues, details };
  }

  // --- Status / response checks ---
  if (!page.ok || page.status === 0) {
    issues.push(issue('request-failed', SEVERITY.ERROR, CATEGORIES.CRAWL, `Request failed: ${page.error || 'unknown error'}`));
    return { meta, issues, details };
  }
  if (page.status >= 500) {
    issues.push(issue('server-error', SEVERITY.ERROR, CATEGORIES.CRAWL, `Server error (HTTP ${page.status}).`));
  } else if (page.status === 404) {
    issues.push(issue('not-found', SEVERITY.ERROR, CATEGORIES.LINKS, 'Page returns 404 Not Found (broken internal link).'));
  } else if (page.status >= 400) {
    issues.push(issue('client-error', SEVERITY.ERROR, CATEGORIES.CRAWL, `Client error (HTTP ${page.status}).`));
  } else if (page.status >= 300) {
    issues.push(issue('redirect', SEVERITY.WARNING, CATEGORIES.LINKS, `Page returns a redirect (HTTP ${page.status}).`));
  }
  if (page.redirectLoop) {
    issues.push(issue('redirect-loop', SEVERITY.ERROR, CATEGORIES.LINKS, `Redirect loop detected (${(page.redirectChain || []).length} hops).`, { chain: page.redirectChain }));
    return { meta, issues, details };
  }
  if (page.redirectChain && page.redirectChain.length >= 2) {
    issues.push(issue('redirect-chain', SEVERITY.WARNING, CATEGORIES.LINKS, `Redirect chain of ${page.redirectChain.length} hops before reaching ${page.finalUrl}.`, { chain: page.redirectChain }));
  }
  if (page.redirected) {
    const permanent = page.redirectStatuses && page.redirectStatuses.length > 0 && page.redirectStatuses.every((s) => s === 301 || s === 308);
    issues.push(
      issue(
        permanent === false ? 'temporary-redirect' : 'was-redirected',
        permanent === false ? SEVERITY.WARNING : SEVERITY.NOTICE,
        CATEGORIES.LINKS,
        permanent === false ? `URL uses a temporary (302/307) redirect to ${page.finalUrl}.` : `URL redirected to ${page.finalUrl}.`
      )
    );
  }
  if (page.status >= 400) {
    // An error page is a broken link, not a content page: don't pile on
    // "thin content / missing description" findings for it.
    try {
      const t = cheerio.load(page.html || '')('title').first().text().trim();
      meta.title = t || null;
      meta.titleLength = t.length;
    } catch { /* ignore */ }
    return { meta, issues, details };
  }
  if (page.responseTimeMs > 3000) {
    issues.push(issue('slow-response', SEVERITY.WARNING, CATEGORIES.PERFORMANCE, `Slow server response time (${page.responseTimeMs}ms).`));
  } else if (page.responseTimeMs > 1000) {
    issues.push(issue('moderate-response', SEVERITY.NOTICE, CATEGORIES.PERFORMANCE, `Server response time is ${page.responseTimeMs}ms (aim for under 1s).`));
  }
  if (!meta.isHttps) {
    issues.push(issue('not-https', SEVERITY.ERROR, CATEGORIES.SECURITY, 'Page is not served over HTTPS.'));
  }

  // --- Header-based checks (only when real headers were captured) ---
  const xRobots = headerValue(headers, 'x-robots-tag');
  if (xRobots && /noindex/i.test(String(xRobots))) {
    meta.metaRobotsNoindex = true;
    issues.push(issue('noindex-header', SEVERITY.WARNING, CATEGORIES.META, 'Page is blocked from indexing by an X-Robots-Tag: noindex HTTP header.'));
  }
  if (meta.headersAvailable) {
    const enc = headerValue(headers, 'content-encoding');
    meta.compression = enc ? String(enc) : null;
    if (!enc && meta.htmlBytes > 1024) {
      issues.push(issue('uncompressed-html', SEVERITY.WARNING, CATEGORIES.PERFORMANCE, 'HTML is served without gzip/brotli compression.'));
    }
    const cacheControl = headerValue(headers, 'cache-control');
    meta.cacheControl = cacheControl ? String(cacheControl) : null;
    const server = headerValue(headers, 'server');
    meta.serverHeader = server ? String(server) : null;
    if (siteWide && server && /\d+\.\d+/.test(String(server))) {
      issues.push(issue('server-signature', SEVERITY.NOTICE, CATEGORIES.SECURITY, `Server header exposes version information (${server}).`));
    }
    const poweredBy = headerValue(headers, 'x-powered-by');
    if (siteWide && poweredBy) {
      issues.push(issue('x-powered-by', SEVERITY.NOTICE, CATEGORIES.SECURITY, `X-Powered-By header exposes technology (${poweredBy}).`));
    }
    const securityHeaders = {
      'strict-transport-security': headerValue(headers, 'strict-transport-security'),
      'content-security-policy': headerValue(headers, 'content-security-policy'),
      'x-content-type-options': headerValue(headers, 'x-content-type-options'),
      'x-frame-options': headerValue(headers, 'x-frame-options'),
      'referrer-policy': headerValue(headers, 'referrer-policy'),
      'permissions-policy': headerValue(headers, 'permissions-policy'),
    };
    meta.securityHeaders = Object.fromEntries(Object.entries(securityHeaders).map(([k, v]) => [k, !!v]));
    if (siteWide && meta.isHttps && !securityHeaders['strict-transport-security']) {
      issues.push(issue('missing-hsts', SEVERITY.NOTICE, CATEGORIES.SECURITY, 'No Strict-Transport-Security (HSTS) header.'));
    }
    if (siteWide && !securityHeaders['x-content-type-options']) {
      issues.push(issue('missing-x-content-type-options', SEVERITY.NOTICE, CATEGORIES.SECURITY, 'No X-Content-Type-Options: nosniff header.'));
    }
    if (siteWide && !securityHeaders['x-frame-options'] && !(securityHeaders['content-security-policy'] && /frame-ancestors/i.test(String(securityHeaders['content-security-policy'])))) {
      issues.push(issue('missing-x-frame-options', SEVERITY.NOTICE, CATEGORIES.SECURITY, 'No X-Frame-Options or CSP frame-ancestors (clickjacking protection).'));
    }
    if (siteWide && !securityHeaders['content-security-policy']) {
      issues.push(issue('missing-csp', SEVERITY.NOTICE, CATEGORIES.SECURITY, 'No Content-Security-Policy header.'));
    }
    const contentType = String(headerValue(headers, 'content-type') || '');
    meta.charsetFromHeader = /charset=([\w-]+)/i.test(contentType) ? contentType.match(/charset=([\w-]+)/i)[1] : null;
  }

  if (page.contentStripped) {
    // Redirect to an already-crawled page: the redirect itself was reported above.
    return { meta, issues, details };
  }
  if (!page.isHtml || !page.html) {
    if (page.status < 300) {
      issues.push(issue('non-html', SEVERITY.NOTICE, CATEGORIES.CRAWL, 'Resource is not an HTML page; skipped content checks.'));
    }
    return { meta, issues, details };
  }

  // --- Parse HTML ---
  let $;
  try {
    $ = cheerio.load(page.html);
  } catch {
    issues.push(issue('parse-error', SEVERITY.ERROR, CATEGORIES.TECHNICAL, 'Could not parse HTML.'));
    return { meta, issues, details };
  }
  const html = page.html;
  const pageUrl = new URL(meta.finalUrl);

  // --- Document basics ---
  meta.hasDoctype = /^\s*<!doctype\s+html/i.test(html);
  if (!meta.hasDoctype) {
    issues.push(issue('missing-doctype', SEVERITY.WARNING, CATEGORIES.TECHNICAL, 'No <!DOCTYPE html> declaration.'));
  }
  const metaCharset = $('meta[charset]').attr('charset') || ($('meta[http-equiv="Content-Type"]').attr('content') || '').match(/charset=([\w-]+)/i)?.[1] || null;
  meta.charset = metaCharset || meta.charsetFromHeader || null;
  if (!meta.charset) {
    issues.push(issue('missing-charset', SEVERITY.WARNING, CATEGORIES.TECHNICAL, 'No character encoding declared (meta charset or Content-Type header).'));
  }
  meta.lang = $('html').attr('lang') || null;
  if (!meta.lang) {
    issues.push(issue('missing-lang', SEVERITY.WARNING, CATEGORIES.META, 'No lang attribute on <html>.'));
  }

  // --- Title ---
  const titles = $('title');
  const title = titles.first().text().trim();
  meta.title = title || null;
  meta.titleLength = title.length;
  if (!title) {
    issues.push(issue('missing-title', SEVERITY.ERROR, CATEGORIES.META, 'Missing <title> tag.'));
  } else if (title.length < 30) {
    issues.push(issue('title-too-short', SEVERITY.WARNING, CATEGORIES.META, `Title is short (${title.length} chars); aim for 50-60.`));
  } else if (title.length > 65) {
    issues.push(issue('title-too-long', SEVERITY.WARNING, CATEGORIES.META, `Title is long (${title.length} chars) and may be truncated in search results.`));
  }
  if (titles.length > 1) {
    issues.push(issue('multiple-title', SEVERITY.WARNING, CATEGORIES.META, `Multiple <title> tags found (${titles.length}).`));
  }

  // --- Meta description ---
  const metaDesc = $('meta[name="description"]').attr('content')?.trim() || '';
  meta.metaDescription = metaDesc || null;
  meta.metaDescriptionLength = metaDesc.length;
  if (!metaDesc) {
    issues.push(issue('missing-meta-description', SEVERITY.WARNING, CATEGORIES.META, 'Missing meta description.'));
  } else if (metaDesc.length < 70) {
    issues.push(issue('meta-description-short', SEVERITY.NOTICE, CATEGORIES.META, `Meta description is short (${metaDesc.length} chars); aim for 120-160.`));
  } else if (metaDesc.length > 165) {
    issues.push(issue('meta-description-long', SEVERITY.NOTICE, CATEGORIES.META, `Meta description is long (${metaDesc.length} chars) and may be truncated.`));
  }

  // --- Meta robots / refresh ---
  const robotsContent = ($('meta[name="robots"]').attr('content') || '').toLowerCase();
  if (robotsContent.includes('noindex')) {
    meta.metaRobotsNoindex = true;
    issues.push(issue('noindex', SEVERITY.WARNING, CATEGORIES.META, 'Page is marked noindex and will be excluded from search results.'));
  }
  meta.metaRobotsNofollow = robotsContent.includes('nofollow');
  if (meta.metaRobotsNofollow) {
    issues.push(issue('meta-nofollow', SEVERITY.NOTICE, CATEGORIES.META, 'Page is marked nofollow; links on it pass no signals.'));
  }
  if ($('meta[http-equiv="refresh"]').length > 0) {
    issues.push(issue('meta-refresh', SEVERITY.WARNING, CATEGORIES.TECHNICAL, 'Page uses a <meta http-equiv="refresh"> redirect.'));
  }

  // --- Canonical ---
  const canonicals = $('link[rel="canonical"]');
  const canonical = canonicals.attr('href') || null;
  meta.canonical = canonical;
  if (canonicals.length > 1) {
    issues.push(issue('multiple-canonical', SEVERITY.ERROR, CATEGORIES.META, `Multiple canonical tags found (${canonicals.length}).`));
  }
  if (!canonical) {
    issues.push(issue('missing-canonical', SEVERITY.NOTICE, CATEGORIES.META, 'Missing canonical link tag.'));
  } else {
    try {
      const canonicalAbs = new URL(canonical, meta.finalUrl);
      meta.canonicalResolved = canonicalAbs.toString();
      meta.isSelfCanonical = canonicalAbs.toString().replace(/\/$/, '') === meta.finalUrl.replace(/\/$/, '');
      if (!/^https?:/.test(canonical) && !canonical.startsWith('/')) {
        issues.push(issue('relative-canonical', SEVERITY.NOTICE, CATEGORIES.META, `Canonical URL is relative (${canonical}); use an absolute URL.`));
      }
      if (meta.isHttps && canonicalAbs.protocol === 'http:') {
        issues.push(issue('canonical-http', SEVERITY.WARNING, CATEGORIES.META, 'Canonical points to an HTTP URL on an HTTPS page.'));
      }
    } catch {
      meta.isSelfCanonical = null;
      issues.push(issue('malformed-canonical', SEVERITY.WARNING, CATEGORIES.META, `Canonical URL is malformed (${canonical}).`));
    }
  }

  // --- Hreflang ---
  const hreflangs = $('link[rel="alternate"][hreflang]')
    .map((_, el) => ({ lang: ($(el).attr('hreflang') || '').trim(), href: $(el).attr('href') || '' }))
    .get();
  meta.hreflangCount = hreflangs.length;
  if (hreflangs.length) {
    const seen = new Set();
    for (const h of hreflangs) {
      if (!/^([a-z]{2,3}(-[A-Za-z]{2,4})?|x-default)$/i.test(h.lang)) {
        issues.push(issue('invalid-hreflang', SEVERITY.ERROR, CATEGORIES.META, `Invalid hreflang value "${h.lang}".`));
      }
      if (seen.has(h.lang.toLowerCase())) {
        issues.push(issue('duplicate-hreflang', SEVERITY.ERROR, CATEGORIES.META, `Hreflang "${h.lang}" declared more than once (conflict).`));
      }
      seen.add(h.lang.toLowerCase());
    }
    const selfRef = hreflangs.some((h) => {
      try { return new URL(h.href, meta.finalUrl).toString().replace(/\/$/, '') === meta.finalUrl.replace(/\/$/, ''); } catch { return false; }
    });
    if (!selfRef) {
      issues.push(issue('hreflang-no-self', SEVERITY.WARNING, CATEGORIES.META, 'Hreflang set does not include a self-referencing entry.'));
    }
    if (!hreflangs.some((h) => h.lang.toLowerCase() === 'x-default')) {
      issues.push(issue('hreflang-no-xdefault', SEVERITY.NOTICE, CATEGORIES.META, 'Hreflang set has no x-default entry.'));
    }
    details.hreflang = hreflangs;
  }

  // --- Favicon ---
  meta.hasFaviconLink = $('link[rel~="icon"], link[rel="shortcut icon"], link[rel="apple-touch-icon"]').length > 0;

  // --- Headings ---
  const headings = [];
  $('h1, h2, h3, h4, h5, h6').each((_, el) => {
    headings.push({ level: parseInt(el.tagName.slice(1), 10), text: $(el).text().replace(/\s+/g, ' ').trim() });
  });
  const h1s = headings.filter((h) => h.level === 1).map((h) => h.text).filter(Boolean);
  meta.h1 = h1s;
  meta.h2Count = headings.filter((h) => h.level === 2).length;
  meta.headingCounts = [1, 2, 3, 4, 5, 6].reduce((acc, l) => ({ ...acc, [`h${l}`]: headings.filter((h) => h.level === l).length }), {});
  details.headings = headings.slice(0, 60);
  if (h1s.length === 0) {
    issues.push(issue('missing-h1', SEVERITY.WARNING, CATEGORIES.STRUCTURE, 'Missing <h1> tag.'));
  } else if (h1s.length > 1) {
    issues.push(issue('multiple-h1', SEVERITY.NOTICE, CATEGORIES.STRUCTURE, `Multiple <h1> tags found (${h1s.length}).`));
  }
  if (h1s.length && title && h1s[0].toLowerCase() === title.toLowerCase()) {
    issues.push(issue('h1-equals-title', SEVERITY.NOTICE, CATEGORIES.STRUCTURE, 'H1 is identical to the title tag; consider differentiating them.'));
  }
  if (h1s.length && h1s[0].length > 70) {
    issues.push(issue('h1-too-long', SEVERITY.NOTICE, CATEGORIES.STRUCTURE, `H1 is long (${h1s[0].length} chars).`));
  }
  const emptyHeadings = headings.filter((h) => !h.text).length;
  if (emptyHeadings) {
    issues.push(issue('empty-headings', SEVERITY.NOTICE, CATEGORIES.STRUCTURE, `${emptyHeadings} empty heading tag(s).`));
  }
  let skipped = 0;
  let prev = 0;
  for (const h of headings) {
    if (prev && h.level > prev + 1) skipped++;
    prev = h.level;
  }
  if (skipped) {
    issues.push(issue('heading-hierarchy', SEVERITY.NOTICE, CATEGORIES.STRUCTURE, `Heading levels are skipped ${skipped} time(s) (e.g. H2 → H4).`));
  }

  // --- Content & keywords ---
  const $content = cheerio.load(page.html);
  $content('script, style, noscript, template, svg').remove();
  const bodyText = $content('body').text().replace(/\s+/g, ' ').trim();
  meta.wordCount = countWords(bodyText);
  meta.textToHtmlRatio = meta.htmlBytes ? Math.round((Buffer.byteLength(bodyText, 'utf8') / meta.htmlBytes) * 1000) / 10 : 0;
  if (meta.wordCount < 300) {
    issues.push(issue('thin-content', SEVERITY.WARNING, CATEGORIES.CONTENT, `Thin content: only ~${meta.wordCount} words.`));
  }
  if (meta.htmlBytes > 5000 && meta.textToHtmlRatio < 10) {
    issues.push(issue('low-text-ratio', SEVERITY.NOTICE, CATEGORIES.CONTENT, `Low text-to-HTML ratio (${meta.textToHtmlRatio}%).`));
  }
  if (meta.headingCounts.h2 === 0 && meta.wordCount >= 300) {
    issues.push(issue('no-h2', SEVERITY.NOTICE, CATEGORIES.STRUCTURE, 'No <h2> subheadings on a page with substantial content.'));
  }
  const tokens = tokenize(bodyText);
  const keywords = topTerms(tokens, 10);
  const phrases2 = topPhrases(tokens, 2, 5);
  const phrases3 = topPhrases(tokens, 3, 5);
  const inTitle = (t) => title.toLowerCase().includes(t);
  const inDesc = (t) => metaDesc.toLowerCase().includes(t);
  const inH1 = (t) => h1s.some((h) => h.toLowerCase().includes(t));
  details.keywords = {
    totalWords: meta.wordCount,
    topKeywords: keywords.map((k) => ({
      ...k,
      density: tokens.length ? Math.round((k.count / tokens.length) * 1000) / 10 : 0,
      inTitle: inTitle(k.term),
      inDescription: inDesc(k.term),
      inH1: inH1(k.term),
    })),
    topPhrases: [...phrases2, ...phrases3],
  };
  if (keywords.length >= 3) {
    const top3 = keywords.slice(0, 3);
    if (title && !top3.some((k) => inTitle(k.term))) {
      issues.push(issue('keywords-not-in-title', SEVERITY.NOTICE, CATEGORIES.CONTENT, `None of the page's top keywords (${top3.map((k) => k.term).join(', ')}) appear in the title.`));
    }
    if (metaDesc && !top3.some((k) => inDesc(k.term))) {
      issues.push(issue('keywords-not-in-description', SEVERITY.NOTICE, CATEGORIES.CONTENT, 'None of the top keywords appear in the meta description.'));
    }
    const top = keywords[0];
    if (tokens.length > 200 && top.count / tokens.length > 0.05) {
      issues.push(issue('keyword-stuffing', SEVERITY.NOTICE, CATEGORIES.CONTENT, `"${top.term}" makes up ${Math.round((top.count / tokens.length) * 100)}% of words — possible keyword stuffing.`));
    }
  }

  // --- Deprecated / outdated HTML ---
  const deprecatedFound = DEPRECATED_TAGS.filter((t) => $(t).length > 0);
  if (deprecatedFound.length) {
    issues.push(issue('deprecated-html', SEVERITY.WARNING, CATEGORIES.TECHNICAL, `Deprecated HTML tags in use: <${deprecatedFound.join('>, <')}>.`));
  }
  if ($('frame, frameset').length) {
    issues.push(issue('frames', SEVERITY.WARNING, CATEGORIES.TECHNICAL, 'Page uses frames/framesets, which search engines index poorly.'));
  }
  meta.iframeCount = $('iframe').length;
  if (meta.iframeCount > 0) {
    issues.push(issue('iframes', SEVERITY.NOTICE, CATEGORIES.TECHNICAL, `Page embeds ${meta.iframeCount} iframe(s); iframe content is not indexed as page content.`));
  }
  if ($('object[type*="flash"], embed[src$=".swf"], object[data$=".swf"]').length) {
    issues.push(issue('flash', SEVERITY.ERROR, CATEGORIES.TECHNICAL, 'Page uses Adobe Flash, which no modern browser supports.'));
  }
  meta.inlineStyleCount = $('[style]').length;
  if (meta.inlineStyleCount > 20) {
    issues.push(issue('inline-styles', SEVERITY.NOTICE, CATEGORIES.TECHNICAL, `${meta.inlineStyleCount} elements use inline style attributes.`));
  }
  if ($('table table').length) {
    issues.push(issue('nested-tables', SEVERITY.NOTICE, CATEGORIES.TECHNICAL, 'Nested tables found; they slow rendering and hurt accessibility.'));
  }
  meta.domSize = $('*').length;
  if (meta.domSize > 1500) {
    issues.push(issue('dom-too-large', SEVERITY.WARNING, CATEGORIES.PERFORMANCE, `Large DOM: ${meta.domSize} elements (Lighthouse warns above 1,500).`));
  }
  if (meta.htmlBytes > 2 * 1024 * 1024) {
    issues.push(issue('html-too-large', SEVERITY.ERROR, CATEGORIES.PERFORMANCE, `HTML is ${(meta.htmlBytes / 1024 / 1024).toFixed(1)} MB (over 2 MB).`));
  } else if (meta.htmlBytes > 300 * 1024) {
    issues.push(issue('html-large', SEVERITY.NOTICE, CATEGORIES.PERFORMANCE, `HTML is ${Math.round(meta.htmlBytes / 1024)} KB; consider trimming markup.`));
  }

  // --- Viewport / mobile ---
  const viewport = $('meta[name="viewport"]').attr('content') || '';
  meta.hasViewport = viewport.length > 0;
  if (!meta.hasViewport) {
    issues.push(issue('missing-viewport', SEVERITY.WARNING, CATEGORIES.TECHNICAL, 'Missing mobile viewport meta tag.'));
  } else if (!/width\s*=\s*device-width/i.test(viewport)) {
    issues.push(issue('viewport-no-width', SEVERITY.WARNING, CATEGORIES.TECHNICAL, `Viewport meta tag lacks width=device-width (${viewport}).`));
  }
  meta.hasMediaQueries = /@media[^{]*\((max|min)-width/i.test(html);
  meta.isAmp = $('html[amp], html[⚡]').length > 0 || $('link[rel="amphtml"]').length > 0;

  // --- Resources: scripts / styles / render-blocking / mixed content ---
  const scripts = $('script[src]');
  const stylesheets = $('link[rel="stylesheet"]');
  meta.scriptCount = scripts.length;
  meta.stylesheetCount = stylesheets.length;
  let renderBlocking = 0;
  $('head script[src]').each((_, el) => {
    const a = $(el).attr('async'), d = $(el).attr('defer'), t = ($(el).attr('type') || '').toLowerCase();
    if (a === undefined && d === undefined && t !== 'module') renderBlocking++;
  });
  $('head link[rel="stylesheet"]').each((_, el) => {
    const media = ($(el).attr('media') || '').toLowerCase();
    if (!media || media === 'all' || media === 'screen') renderBlocking++;
  });
  meta.renderBlockingResources = renderBlocking;
  const assetUrls = new Set();
  scripts.each((_, el) => { try { assetUrls.add(new URL($(el).attr('src'), meta.finalUrl).toString()); } catch { /* ignore */ } });
  stylesheets.each((_, el) => { try { assetUrls.add(new URL($(el).attr('href'), meta.finalUrl).toString()); } catch { /* ignore */ } });
  details.assetUrls = [...assetUrls].slice(0, 100);
  if (renderBlocking > 6) {
    issues.push(issue('render-blocking', SEVERITY.WARNING, CATEGORIES.PERFORMANCE, `${renderBlocking} render-blocking scripts/stylesheets in <head>.`));
  } else if (renderBlocking > 3) {
    issues.push(issue('render-blocking-some', SEVERITY.NOTICE, CATEGORIES.PERFORMANCE, `${renderBlocking} render-blocking resources in <head>.`));
  }
  if (meta.scriptCount + meta.stylesheetCount > 30) {
    issues.push(issue('too-many-assets', SEVERITY.NOTICE, CATEGORIES.PERFORMANCE, `Page loads ${meta.scriptCount} script files and ${meta.stylesheetCount} stylesheets.`));
  }
  const mixed = [];
  if (meta.isHttps) {
    $('script[src], link[rel="stylesheet"][href], img[src], iframe[src], video[src], audio[src], source[src], object[data]').each((_, el) => {
      const src = $(el).attr('src') || $(el).attr('href') || $(el).attr('data') || '';
      if (/^http:\/\//i.test(src)) mixed.push(src);
    });
  }
  meta.mixedContentCount = mixed.length;
  if (mixed.length) {
    issues.push(issue('mixed-content', SEVERITY.ERROR, CATEGORIES.SECURITY, `${mixed.length} insecure (http://) resource(s) loaded on an HTTPS page.`, { samples: mixed.slice(0, 5) }));
  }

  // --- Images ---
  const images = $('img');
  meta.imagesTotal = images.length;
  let missingAlt = 0, missingDims = 0, lazy = 0, modernFormat = 0, srcset = 0;
  const imageUrls = new Set();
  images.each((_, el) => {
    const $el = $(el);
    const alt = $el.attr('alt');
    if (alt === undefined || alt.trim() === '') missingAlt++;
    if (!$el.attr('width') || !$el.attr('height')) missingDims++;
    if (($el.attr('loading') || '').toLowerCase() === 'lazy') lazy++;
    if ($el.attr('srcset') || $el.parent('picture').length) srcset++;
    const src = $el.attr('src') || $el.attr('data-src') || '';
    if (/\.(webp|avif)(\?|$)/i.test(src)) modernFormat++;
    if (src && !src.startsWith('data:')) {
      try { imageUrls.add(new URL(src, meta.finalUrl).toString()); } catch { /* ignore */ }
    }
  });
  meta.imagesMissingAlt = missingAlt;
  meta.imagesMissingDimensions = missingDims;
  meta.imagesLazy = lazy;
  meta.imagesModernFormat = modernFormat;
  meta.imagesResponsive = srcset;
  details.imageUrls = [...imageUrls].slice(0, 100);
  if (missingAlt > 0) {
    issues.push(issue('images-missing-alt', SEVERITY.WARNING, CATEGORIES.IMAGES, `${missingAlt} of ${images.length} image(s) missing alt text.`));
  }
  if (images.length && missingDims > 0) {
    issues.push(issue('images-missing-dimensions', SEVERITY.NOTICE, CATEGORIES.IMAGES, `${missingDims} image(s) lack width/height attributes (causes layout shift).`));
  }
  if (images.length >= 5 && lazy === 0) {
    issues.push(issue('images-no-lazy', SEVERITY.NOTICE, CATEGORIES.PERFORMANCE, `None of ${images.length} images use loading="lazy".`));
  }
  if (images.length >= 5 && modernFormat === 0 && srcset === 0) {
    issues.push(issue('images-not-modern', SEVERITY.NOTICE, CATEGORIES.PERFORMANCE, 'No WebP/AVIF images or srcset detected among page images.'));
  }
  // --- Links ---
  const linkStats = { internal: 0, external: 0, nofollowInternal: 0, nofollowExternal: 0, emptyAnchor: 0, genericAnchor: 0, unsafeCrossOrigin: 0, httpLinksOnHttps: 0, longUrls: 0, underscoreUrls: 0, uppercaseUrls: 0, paramHeavyUrls: 0, total: 0 };
  const anchorTexts = new Map();
  $('a[href]').each((_, el) => {
    const $el = $(el);
    const href = ($el.attr('href') || '').trim();
    if (!href || href.startsWith('#') || /^(mailto|tel|javascript):/i.test(href)) return;
    let abs;
    try { abs = new URL(href, meta.finalUrl); } catch { return; }
    if (!/^https?:$/.test(abs.protocol)) return;
    linkStats.total++;
    const rel = ($el.attr('rel') || '').toLowerCase();
    const text = $el.text().replace(/\s+/g, ' ').trim().toLowerCase();
    const hasImgAlt = $el.find('img[alt]').filter((_, i) => ($(i).attr('alt') || '').trim()).length > 0;
    const ariaLabel = ($el.attr('aria-label') || '').trim();
    const isInternal = abs.origin === pageUrl.origin;
    if (isInternal) {
      linkStats.internal++;
      if (rel.includes('nofollow')) linkStats.nofollowInternal++;
      anchorTexts.set(text, (anchorTexts.get(text) || 0) + 1);
      if (abs.href.length > 200) linkStats.longUrls++;
      if (/_/.test(abs.pathname)) linkStats.underscoreUrls++;
      if (/[A-Z]/.test(abs.pathname)) linkStats.uppercaseUrls++;
      if ([...abs.searchParams.keys()].length > 2) linkStats.paramHeavyUrls++;
    } else {
      linkStats.external++;
      if (rel.includes('nofollow')) linkStats.nofollowExternal++;
      const target = ($el.attr('target') || '').toLowerCase();
      if (target === '_blank' && !rel.includes('noopener') && !rel.includes('noreferrer')) linkStats.unsafeCrossOrigin++;
    }
    if (!text && !hasImgAlt && !ariaLabel) linkStats.emptyAnchor++;
    else if (text && GENERIC_ANCHORS.has(text)) linkStats.genericAnchor++;
    if (meta.isHttps && abs.protocol === 'http:') linkStats.httpLinksOnHttps++;
  });
  meta.links = linkStats;
  details.links = linkStats;
  if (linkStats.total > 100) {
    issues.push(issue('too-many-links', SEVERITY.NOTICE, CATEGORIES.LINKS, `Page has ${linkStats.total} links; very link-heavy pages dilute link value.`));
  }
  if (linkStats.emptyAnchor) {
    issues.push(issue('empty-anchor-text', SEVERITY.NOTICE, CATEGORIES.LINKS, `${linkStats.emptyAnchor} link(s) have no anchor text, alt text, or aria-label.`));
  }
  if (linkStats.genericAnchor) {
    issues.push(issue('generic-anchor-text', SEVERITY.NOTICE, CATEGORIES.LINKS, `${linkStats.genericAnchor} link(s) use non-descriptive anchor text like "click here".`));
  }
  if (linkStats.unsafeCrossOrigin) {
    issues.push(issue('unsafe-cross-origin', SEVERITY.WARNING, CATEGORIES.SECURITY, `${linkStats.unsafeCrossOrigin} external target="_blank" link(s) lack rel="noopener".`));
  }
  if (linkStats.httpLinksOnHttps) {
    issues.push(issue('http-links-on-https', SEVERITY.NOTICE, CATEGORIES.SECURITY, `${linkStats.httpLinksOnHttps} link(s) on this HTTPS page point to http:// URLs.`));
  }
  if (linkStats.nofollowInternal) {
    issues.push(issue('nofollow-internal', SEVERITY.NOTICE, CATEGORIES.LINKS, `${linkStats.nofollowInternal} internal link(s) carry rel="nofollow".`));
  }
  if (linkStats.underscoreUrls) {
    issues.push(issue('underscore-urls', SEVERITY.NOTICE, CATEGORIES.LINKS, `${linkStats.underscoreUrls} internal link(s) point to URLs containing underscores.`));
  }
  if (linkStats.uppercaseUrls) {
    issues.push(issue('uppercase-urls', SEVERITY.NOTICE, CATEGORIES.LINKS, `${linkStats.uppercaseUrls} internal link(s) point to URLs with uppercase characters.`));
  }
  if (linkStats.paramHeavyUrls) {
    issues.push(issue('param-heavy-urls', SEVERITY.NOTICE, CATEGORIES.LINKS, `${linkStats.paramHeavyUrls} internal link(s) have more than two URL parameters.`));
  }
  if (linkStats.longUrls) {
    issues.push(issue('long-urls', SEVERITY.NOTICE, CATEGORIES.LINKS, `${linkStats.longUrls} internal link(s) are longer than 200 characters.`));
  }
  if (linkStats.internal === 0 && page.status < 300) {
    issues.push(issue('no-internal-links', SEVERITY.WARNING, CATEGORIES.LINKS, 'Page has no internal links (dead end for crawlers).'));
  }

  // --- Own URL quality ---
  if (pageUrl.href.length > 200) {
    issues.push(issue('url-too-long', SEVERITY.NOTICE, CATEGORIES.LINKS, `This page's URL is ${pageUrl.href.length} characters long.`));
  }
  if (/_/.test(pageUrl.pathname)) {
    issues.push(issue('url-underscore', SEVERITY.NOTICE, CATEGORIES.LINKS, 'URL contains underscores; hyphens are the recommended word separator.'));
  }

  // --- Social / Open Graph / Twitter ---
  const og = {};
  $('meta[property^="og:"]').each((_, el) => { og[$(el).attr('property')] = $(el).attr('content') || ''; });
  const tw = {};
  $('meta[name^="twitter:"]').each((_, el) => { tw[$(el).attr('name')] = $(el).attr('content') || ''; });
  meta.hasOpenGraph = Object.keys(og).length > 0;
  meta.hasTwitterCard = !!tw['twitter:card'];
  details.openGraph = og;
  details.twitter = tw;
  if (!meta.hasOpenGraph) {
    issues.push(issue('missing-open-graph', SEVERITY.NOTICE, CATEGORIES.SOCIAL, 'Missing Open Graph tags (affects social share previews).'));
  } else {
    const missing = ['og:title', 'og:description', 'og:image', 'og:url'].filter((k) => !og[k]);
    if (missing.length) {
      issues.push(issue('incomplete-open-graph', SEVERITY.NOTICE, CATEGORIES.SOCIAL, `Open Graph is missing ${missing.join(', ')}.`));
    }
  }
  if (!meta.hasTwitterCard) {
    issues.push(issue('missing-twitter-card', SEVERITY.NOTICE, CATEGORIES.SOCIAL, 'Missing Twitter/X card meta tags.'));
  }
  const socialLinks = {};
  $('a[href]').each((_, el) => {
    try {
      const u = new URL($(el).attr('href'), meta.finalUrl);
      for (const [name, re] of Object.entries(SOCIAL_PATTERNS)) {
        if (re.test(u.hostname) && !socialLinks[name]) socialLinks[name] = u.toString();
      }
    } catch { /* ignore */ }
  });
  details.socialProfiles = socialLinks;
  meta.socialProfileCount = Object.keys(socialLinks).length;

  // --- Analytics / pixels / tech signatures (signature-based detection only) ---
  const tech = [];
  if (/googletagmanager\.com\/gtm\.js|GTM-[A-Z0-9]+/i.test(html)) tech.push('Google Tag Manager');
  if (/gtag\(|googletagmanager\.com\/gtag\/js|google-analytics\.com\/analytics\.js|G-[A-Z0-9]{6,}/i.test(html)) tech.push('Google Analytics');
  if (/connect\.facebook\.net\/[^"']*fbevents\.js|fbq\(/i.test(html)) tech.push('Facebook Pixel');
  if (/hotjar\.com|hj\(/i.test(html)) tech.push('Hotjar');
  if (/clarity\.ms/i.test(html)) tech.push('Microsoft Clarity');
  const generator = ($('meta[name="generator"]').attr('content') || '').trim();
  if (generator) tech.push(`Generator: ${generator}`);
  if (/wp-content\/|wp-includes\//i.test(html)) tech.push('WordPress');
  if (/cdn\.shopify\.com|Shopify\./i.test(html)) tech.push('Shopify');
  if (/static\.wixstatic\.com|wix\.com/i.test(html)) tech.push('Wix');
  if (/squarespace\.com|static1\.squarespace/i.test(html)) tech.push('Squarespace');
  if (/webflow\.com|data-wf-/i.test(html)) tech.push('Webflow');
  if (/leadconnectorhq\.com|msgsndr\.com|gohighlevel/i.test(html)) tech.push('GoHighLevel');
  if (/react(-dom)?(\.production)?\.min\.js|__NEXT_DATA__|data-reactroot/i.test(html)) tech.push('React/Next.js');
  if (/__NUXT__|nuxt/i.test(html)) tech.push('Vue/Nuxt');
  if (/jquery(\.min)?\.js/i.test(html)) tech.push('jQuery');
  if (/cdn\.jsdelivr\.net|cdnjs\.cloudflare\.com|unpkg\.com|cloudfront\.net|cloudflare/i.test(html)) tech.push('CDN assets');
  details.technologies = tech;
  meta.hasAnalytics = tech.some((t) => /Analytics|Tag Manager/.test(t));
  if (siteWide && !meta.hasAnalytics) {
    issues.push(issue('no-analytics', SEVERITY.NOTICE, CATEGORIES.TECHNICAL, 'No Google Analytics / Tag Manager snippet detected.'));
  }

  // --- Structured data ---
  const jsonLdTypes = [];
  let jsonLdErrors = 0;
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const parsed = JSON.parse($(el).contents().text());
      const collect = (node) => {
        if (!node || typeof node !== 'object') return;
        if (Array.isArray(node)) return node.forEach(collect);
        if (node['@type']) jsonLdTypes.push(...[].concat(node['@type']));
        if (node['@graph']) collect(node['@graph']);
      };
      collect(parsed);
    } catch {
      jsonLdErrors++;
    }
  });
  const microdata = $('[itemscope]').length;
  meta.hasStructuredData = jsonLdTypes.length > 0 || microdata > 0;
  details.structuredData = { jsonLdTypes: [...new Set(jsonLdTypes)], jsonLdBlocks: $('script[type="application/ld+json"]').length, jsonLdErrors, microdataItems: microdata };
  if (jsonLdErrors) {
    issues.push(issue('invalid-structured-data', SEVERITY.ERROR, CATEGORIES.TECHNICAL, `${jsonLdErrors} JSON-LD block(s) contain invalid JSON.`));
  }
  if (!meta.hasStructuredData) {
    issues.push(issue('missing-structured-data', SEVERITY.NOTICE, CATEGORIES.TECHNICAL, 'No structured data (JSON-LD/microdata) detected.'));
  }
  meta.hasIdentitySchema = jsonLdTypes.some((t) => /^(Organization|Person|LocalBusiness|Corporation|.*Business)$/i.test(String(t)));
  meta.hasLocalBusinessSchema = jsonLdTypes.some((t) => /LocalBusiness|Business$/i.test(String(t)));

  // --- Local / contact signals (real detection only) ---
  meta.hasTelLink = $('a[href^="tel:"]').length > 0;
  meta.hasAddressMarkup = $('address, [itemtype*="PostalAddress"]').length > 0;

  // --- Privacy: plaintext emails ---
  const emails = new Set((bodyText.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) || []).map((e) => e.toLowerCase()));
  $('a[href^="mailto:"]').each((_, el) => emails.add(($(el).attr('href') || '').replace(/^mailto:/i, '').split('?')[0].toLowerCase()));
  meta.plaintextEmailCount = emails.size;
  if (emails.size) {
    issues.push(issue('plaintext-emails', SEVERITY.NOTICE, CATEGORIES.SECURITY, `${emails.size} email address(es) exposed in plain text (spam harvesting risk).`));
  }

  return { meta, issues, details };
}

module.exports = { analyzePage, SEVERITY, CATEGORIES };
