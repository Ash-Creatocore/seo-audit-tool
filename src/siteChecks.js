'use strict';

const axios = require('axios');
const dns = require('dns').promises;
const tls = require('tls');
const http2 = require('http2');
const { URL } = require('url');

/**
 * Site-level technical checks.
 *
 * Every function here performs a real network / DNS / TLS request and
 * reports what it measured. When a measurement cannot be made (timeout,
 * DNS failure, sandbox restrictions), the check returns status 'unknown'
 * with a reason — it never substitutes a guessed value. The dashboard shows
 * 'unknown' as "could not check", not as pass or fail.
 */

const USER_AGENT = 'SEOAuditBot/1.0 (+https://example.com/bot)';
const TIMEOUT = 8000;

function result(id, label, status, value, note, category = 'technical', severity = null) {
  return { id, label, status, value: value ?? null, note: note || null, category, severity };
}

async function head(url, opts = {}) {
  try {
    const res = await axios.get(url, {
      timeout: TIMEOUT,
      maxRedirects: 0,
      headers: { 'User-Agent': USER_AGENT, ...(opts.headers || {}) },
      validateStatus: () => true,
      responseType: 'text',
      transformResponse: [(d) => d],
      ...opts,
    });
    return { ok: true, status: res.status, headers: res.headers, data: res.data };
  } catch (err) {
    return { ok: false, error: err.code || err.message };
  }
}

async function followChain(startUrl, maxHops = 8) {
  const chain = [];
  let current = startUrl;
  for (let i = 0; i < maxHops; i++) {
    const r = await head(current);
    if (!r.ok) return { chain, final: current, error: r.error };
    if (r.status >= 300 && r.status < 400 && r.headers.location) {
      let next;
      try { next = new URL(r.headers.location, current).toString(); } catch { return { chain, final: current, status: r.status }; }
      chain.push({ from: current, to: next, status: r.status });
      if (chain.filter((h) => h.from === next).length) return { chain, final: next, loop: true };
      current = next;
      continue;
    }
    return { chain, final: current, status: r.status, headers: r.headers, data: r.data };
  }
  return { chain, final: current, tooLong: true };
}

// --- HTTPS redirect ---------------------------------------------------------
async function checkHttpsRedirect(origin) {
  const u = new URL(origin);
  if (u.protocol !== 'https:') {
    return result('https-redirect', 'HTTP → HTTPS redirect', 'fail', 'Site audited over HTTP', 'The audited URL itself is not HTTPS.', 'security', 'error');
  }
  const httpUrl = `http://${u.host}/`;
  const r = await followChain(httpUrl);
  if (r.error) return result('https-redirect', 'HTTP → HTTPS redirect', 'unknown', null, `Could not fetch ${httpUrl}: ${r.error}`, 'security');
  const landsOnHttps = r.final.startsWith('https://');
  if (landsOnHttps) {
    return result('https-redirect', 'HTTP → HTTPS redirect', 'pass', `${httpUrl} → ${r.final} (${r.chain.map((h) => h.status).join(' → ') || 'no redirect'})`, null, 'security');
  }
  return result('https-redirect', 'HTTP → HTTPS redirect', 'fail', `${httpUrl} served over HTTP (status ${r.status})`, 'The HTTP version of the site does not redirect to HTTPS.', 'security', 'error');
}

// --- www / non-www canonicalization ------------------------------------------
async function checkWwwResolve(origin) {
  const u = new URL(origin);
  const host = u.hostname;
  const isWww = host.startsWith('www.');
  const altHost = isWww ? host.slice(4) : `www.${host}`;
  const altUrl = `${u.protocol}//${altHost}/`;
  const r = await followChain(altUrl);
  if (r.error) {
    return result('www-resolve', 'www / non-www resolution', 'unknown', null, `${altHost} could not be fetched (${r.error}) — it may not be configured at all, which means one variant of the domain is dead.`, 'technical');
  }
  let finalHost = null;
  try { finalHost = new URL(r.final).hostname; } catch { /* ignore */ }
  if (finalHost === host) {
    return result('www-resolve', 'www / non-www resolution', 'pass', `${altHost} → ${host} (${r.chain.map((h) => h.status).join(' → ')})`, null, 'technical');
  }
  if (r.status && r.status < 300) {
    return result('www-resolve', 'www / non-www resolution', 'fail', `${altHost} serves content directly (HTTP ${r.status}) instead of redirecting to ${host}`, 'Both www and non-www serve the site — duplicate content risk. Redirect one to the other.', 'technical', 'error');
  }
  return result('www-resolve', 'www / non-www resolution', 'warn', `${altHost} → ${r.final}`, 'The alternate hostname redirects somewhere other than the audited host.', 'technical', 'warning');
}

// --- Redirect chain for the start URL ----------------------------------------
async function checkStartRedirects(startUrl) {
  const r = await followChain(startUrl);
  if (r.error) return result('start-redirect-chain', 'Homepage redirect chain', 'unknown', null, r.error, 'technical');
  if (r.loop) return result('start-redirect-chain', 'Homepage redirect chain', 'fail', 'Redirect loop', 'The audited URL redirects in a loop.', 'technical', 'error');
  if (r.chain.length === 0) return result('start-redirect-chain', 'Homepage redirect chain', 'pass', 'No redirects', null, 'technical');
  const status = r.chain.length > 1 ? 'warn' : 'pass';
  return result('start-redirect-chain', 'Homepage redirect chain', status, r.chain.map((h) => `${h.status} ${h.from} → ${h.to}`).join('\n'), r.chain.length > 1 ? `${r.chain.length} hops — collapse to a single redirect.` : null, 'technical', r.chain.length > 1 ? 'warning' : null);
}

// --- TLS certificate -----------------------------------------------------------
function checkTls(origin) {
  const u = new URL(origin);
  if (u.protocol !== 'https:') return Promise.resolve(result('tls-cert', 'SSL/TLS certificate', 'fail', 'Not HTTPS', 'No certificate to check because the site is not served over HTTPS.', 'security', 'error'));
  return new Promise((resolve) => {
    const socket = tls.connect({ host: u.hostname, port: u.port || 443, servername: u.hostname, timeout: TIMEOUT, rejectUnauthorized: false }, () => {
      try {
        const cert = socket.getPeerCertificate();
        const protocol = socket.getProtocol();
        const authorized = socket.authorized;
        const validTo = cert.valid_to ? new Date(cert.valid_to) : null;
        const daysLeft = validTo ? Math.round((validTo - Date.now()) / 86400000) : null;
        const value = `${cert.subject?.CN || '?'} · issued by ${cert.issuer?.O || cert.issuer?.CN || '?'} · expires ${validTo ? validTo.toISOString().slice(0, 10) : '?'} (${daysLeft} days) · ${protocol}`;
        let status = 'pass', note = null, severity = null;
        if (!authorized) { status = 'fail'; note = `Certificate is not trusted: ${socket.authorizationError}`; severity = 'error'; }
        else if (daysLeft != null && daysLeft < 0) { status = 'fail'; note = 'Certificate has expired.'; severity = 'error'; }
        else if (daysLeft != null && daysLeft < 14) { status = 'warn'; note = 'Certificate expires within two weeks.'; severity = 'warning'; }
        if (protocol && /TLSv1(\.0|\.1)?$/.test(protocol)) { status = 'fail'; note = `Negotiated ${protocol}, an outdated protocol.`; severity = 'error'; }
        resolve({ ...result('tls-cert', 'SSL/TLS certificate', status, value, note, 'security', severity), details: { subject: cert.subject?.CN, issuer: cert.issuer?.O || cert.issuer?.CN, validTo: validTo ? validTo.toISOString() : null, daysLeft, protocol, authorized } });
      } catch (err) {
        resolve(result('tls-cert', 'SSL/TLS certificate', 'unknown', null, err.message, 'security'));
      } finally {
        socket.end();
      }
    });
    socket.on('error', (err) => resolve(result('tls-cert', 'SSL/TLS certificate', 'unknown', null, `TLS connection failed: ${err.code || err.message}`, 'security')));
    socket.on('timeout', () => { socket.destroy(); resolve(result('tls-cert', 'SSL/TLS certificate', 'unknown', null, 'TLS connection timed out', 'security')); });
  });
}

// --- HTTP/2 ----------------------------------------------------------------------
function checkHttp2(origin) {
  const u = new URL(origin);
  if (u.protocol !== 'https:') return Promise.resolve(result('http2', 'HTTP/2 support', 'fail', 'Not HTTPS', 'Browsers only use HTTP/2 over HTTPS.', 'performance', 'warning'));
  return new Promise((resolve) => {
    let settled = false;
    const done = (r) => { if (!settled) { settled = true; resolve(r); } };
    const timer = setTimeout(() => { try { client.destroy(); } catch { /* ignore */ } done(result('http2', 'HTTP/2 support', 'unknown', null, 'Connection timed out', 'performance')); }, TIMEOUT);
    const client = http2.connect(origin, { rejectUnauthorized: false });
    client.on('connect', (session, socket) => {
      clearTimeout(timer);
      const alpn = socket.alpnProtocol;
      client.close();
      if (alpn === 'h2') done(result('http2', 'HTTP/2 support', 'pass', 'HTTP/2 (h2) negotiated', null, 'performance'));
      else done(result('http2', 'HTTP/2 support', 'warn', `Negotiated ${alpn || 'HTTP/1.1'}`, 'Server does not offer HTTP/2; multiplexing and header compression are unavailable.', 'performance', 'notice'));
    });
    client.on('error', (err) => {
      clearTimeout(timer);
      // ERR_HTTP2_ERROR on a server that only speaks HTTP/1.1 is a real "no h2" answer.
      if (/HTTP2|ALPN|EPROTO/i.test(err.code || err.message)) done(result('http2', 'HTTP/2 support', 'warn', 'HTTP/1.1 only', 'Server rejected an HTTP/2 connection.', 'performance', 'notice'));
      else done(result('http2', 'HTTP/2 support', 'unknown', null, `Could not test: ${err.code || err.message}`, 'performance'));
    });
  });
}

// --- DNS ------------------------------------------------------------------------
async function checkDns(origin) {
  const host = new URL(origin).hostname;
  if (host === 'localhost' || /^\d+\.\d+\.\d+\.\d+$/.test(host)) {
    return [result('dns', 'DNS (A / AAAA records)', 'unknown', host, 'Not a public hostname — DNS checks skipped.', 'technical')];
  }
  const out = [];
  let a = [], aaaa = [], ns = [];
  try { a = await dns.resolve4(host); } catch { /* none */ }
  try { aaaa = await dns.resolve6(host); } catch { /* none */ }
  try { ns = await dns.resolveNs(host.replace(/^www\./, '')); } catch { /* none */ }
  if (!a.length && !aaaa.length) {
    out.push(result('dns', 'DNS (A / AAAA records)', 'unknown', null, 'DNS lookup returned no A/AAAA records (could be a resolver restriction on this server).', 'technical'));
  } else {
    out.push({ ...result('dns', 'DNS (A / AAAA records)', 'pass', `A: ${a.join(', ') || 'none'} · AAAA: ${aaaa.join(', ') || 'none'}`, null, 'technical'), details: { a, aaaa } });
    out.push(result('ipv6', 'IPv6 (AAAA record)', aaaa.length ? 'pass' : 'warn', aaaa.length ? aaaa.join(', ') : 'No AAAA record', aaaa.length ? null : 'Site is not reachable over IPv6.', 'technical', aaaa.length ? null : 'notice'));
  }
  if (ns.length) out.push(result('nameservers', 'Nameservers', 'pass', ns.join(', '), null, 'technical'));
  // SPF / DMARC (email authentication — reported by SEOptimer/SEO Site Checkup)
  const apex = host.replace(/^www\./, '');
  try {
    const txt = (await dns.resolveTxt(apex)).map((r) => r.join(''));
    const spf = txt.find((t) => /^v=spf1/i.test(t));
    out.push(result('spf', 'SPF record', spf ? 'pass' : 'warn', spf || 'No v=spf1 TXT record', spf ? null : 'Without SPF, mail claiming to be from this domain is easier to spoof.', 'security', spf ? null : 'notice'));
  } catch (err) {
    out.push(result('spf', 'SPF record', 'unknown', null, `TXT lookup failed: ${err.code || err.message}`, 'security'));
  }
  try {
    const txt = (await dns.resolveTxt(`_dmarc.${apex}`)).map((r) => r.join(''));
    const dmarc = txt.find((t) => /^v=DMARC1/i.test(t));
    out.push(result('dmarc', 'DMARC record', dmarc ? 'pass' : 'warn', dmarc || 'No _dmarc TXT record', dmarc ? null : 'No DMARC policy published.', 'security', dmarc ? null : 'notice'));
  } catch (err) {
    out.push(result('dmarc', 'DMARC record', /ENOTFOUND|ENODATA/.test(err.code || '') ? 'warn' : 'unknown', /ENOTFOUND|ENODATA/.test(err.code || '') ? 'No _dmarc record' : null, /ENOTFOUND|ENODATA/.test(err.code || '') ? 'No DMARC policy published.' : `Lookup failed: ${err.code || err.message}`, 'security', /ENOTFOUND|ENODATA/.test(err.code || '') ? 'notice' : null));
  }
  return out;
}

// --- Well-known files ----------------------------------------------------------
async function checkWellKnownFile(origin, path, id, label, category, onMissing) {
  const r = await head(origin + path);
  if (!r.ok) return result(id, label, 'unknown', null, `Could not fetch ${path}: ${r.error}`, category);
  const ct = String(r.headers['content-type'] || '');
  if (r.status >= 200 && r.status < 300 && !/text\/html/i.test(ct)) {
    return { ...result(id, label, 'pass', `${path} found (${r.status}, ${ct.split(';')[0] || 'unknown type'})`, null, category), body: typeof r.data === 'string' ? r.data.slice(0, 20000) : '' };
  }
  if (r.status >= 200 && r.status < 300) {
    return result(id, label, 'warn', `${path} returns HTML (${r.status})`, `The server answers ${path} with an HTML page — likely a soft-404 or catch-all route rather than the real file.`, category, 'notice');
  }
  return result(id, label, onMissing.status, `${path} → HTTP ${r.status}`, onMissing.note, category, onMissing.severity);
}

async function checkFavicon(origin, hasFaviconLink) {
  const r = await head(origin + '/favicon.ico');
  const fileOk = r.ok && r.status >= 200 && r.status < 300;
  if (fileOk || hasFaviconLink) {
    return result('favicon', 'Favicon', 'pass', fileOk ? '/favicon.ico found' : 'Declared via <link rel="icon">', null, 'technical');
  }
  return result('favicon', 'Favicon', 'warn', 'No /favicon.ico and no <link rel="icon">', 'Browsers and search results show a blank icon.', 'technical', 'notice');
}

async function checkCustom404(origin) {
  const path = `/seo-audit-404-probe-${Date.now().toString(36)}`;
  const r = await head(origin + path);
  if (!r.ok) return result('custom-404', 'Custom 404 page', 'unknown', null, r.error, 'technical');
  if (r.status !== 404) {
    return result('custom-404', 'Custom 404 page', r.status < 300 ? 'fail' : 'warn', `Random URL returned HTTP ${r.status}`, r.status < 300 ? 'Non-existent URLs return 200 (soft 404) — search engines may index junk URLs.' : 'Non-existent URLs do not return 404.', 'technical', r.status < 300 ? 'error' : 'warning');
  }
  const size = typeof r.data === 'string' ? r.data.length : 0;
  const looksCustom = size > 1500 && /<a\s/i.test(r.data || '');
  return result('custom-404', 'Custom 404 page', looksCustom ? 'pass' : 'warn', `Returns 404 (${Math.round(size / 1024)} KB body)`, looksCustom ? null : 'The 404 page is very small / has no links — consider a helpful custom 404 page.', 'technical', looksCustom ? null : 'notice');
}

// --- Sampled resource checks (images, JS/CSS) ---------------------------------------
async function checkResources(urls, id, label, sampleSize = 30) {
  const sample = [...new Set(urls)].slice(0, sampleSize);
  if (!sample.length) return result(id, label, 'pass', 'No resources to check', null, 'links');
  const broken = [];
  const unreachable = [];
  let idx = 0;
  await Promise.all(Array.from({ length: Math.min(6, sample.length) }, async () => {
    while (idx < sample.length) {
      const u = sample[idx++];
      try {
        const res = await axios.head(u, { timeout: TIMEOUT, maxRedirects: 5, headers: { 'User-Agent': USER_AGENT }, validateStatus: () => true });
        if (res.status >= 400) broken.push({ url: u, status: res.status });
        else if (res.status === 405 || res.status === 403) {
          const g = await axios.get(u, { timeout: TIMEOUT, maxRedirects: 5, headers: { 'User-Agent': USER_AGENT }, validateStatus: () => true, responseType: 'stream' });
          g.data.destroy();
          if (g.status >= 400) broken.push({ url: u, status: g.status });
        }
      } catch (err) {
        unreachable.push({ url: u, status: 0, error: err.code || err.message });
      }
    }
  }));
  const status = broken.length ? 'fail' : unreachable.length ? 'unknown' : 'pass';
  const value = `${broken.length} broken (4xx/5xx)${unreachable.length ? `, ${unreachable.length} unreachable` : ''} of ${sample.length} checked`;
  const note = broken.length ? 'Broken resources produce 4xx/5xx errors for users and crawlers.' : unreachable.length ? 'Some resources could not be fetched from this server (DNS/timeout) — not counted as broken.' : null;
  return { ...result(id, label, status, value, note, 'links', broken.length ? 'warning' : null), broken: [...broken, ...unreachable].slice(0, 20), checked: sample.length };
}

// --- robots.txt / sitemap quality ------------------------------------------------
function analyzeRobots(robots, origin) {
  const out = [];
  if (!robots || !robots.exists) {
    out.push(result('robots-txt', 'robots.txt', 'warn', 'Not found', 'No robots.txt at the site root.', 'crawl', 'notice'));
    return out;
  }
  const content = robots.content || '';
  const lines = content.split(/\r?\n/);
  const bad = lines.filter((l) => l.trim() && !l.trim().startsWith('#') && !/^(user-agent|disallow|allow|sitemap|crawl-delay|host|clean-param|noindex)\s*:/i.test(l.trim()));
  const hasSitemap = /^\s*sitemap\s*:/im.test(content);
  const blocksAll = /^\s*user-agent:\s*\*\s*$/im.test(content) && /^\s*disallow:\s*\/\s*$/im.test(content);
  out.push(result('robots-txt', 'robots.txt', bad.length || blocksAll ? 'fail' : 'pass', `${lines.length} lines · ${hasSitemap ? 'declares sitemap' : 'no Sitemap: line'}`, blocksAll ? 'robots.txt disallows the entire site for all crawlers.' : bad.length ? `${bad.length} unrecognized line(s): ${bad.slice(0, 2).join(' | ')}` : null, 'crawl', blocksAll ? 'error' : bad.length ? 'warning' : null));
  if (!hasSitemap) out.push(result('robots-sitemap-directive', 'Sitemap declared in robots.txt', 'warn', 'No Sitemap: directive', 'Add a Sitemap: line so crawlers find the sitemap without guessing.', 'crawl', 'notice'));
  else out.push(result('robots-sitemap-directive', 'Sitemap declared in robots.txt', 'pass', 'Sitemap: directive present', null, 'crawl'));
  return out;
}

function analyzeSitemap(sitemap, origin) {
  const out = [];
  if (!sitemap || !sitemap.exists) {
    out.push(result('sitemap', 'XML sitemap', 'warn', 'Not found', 'No sitemap.xml found at the root or declared in robots.txt.', 'crawl', 'notice'));
    return out;
  }
  const urls = sitemap.urls || [];
  const httpsSite = origin.startsWith('https:');
  const httpUrls = httpsSite ? urls.filter((u) => u.startsWith('http://')).length : 0;
  const offOrigin = urls.filter((u) => { try { return new URL(u).hostname.replace(/^www\./, '') !== new URL(origin).hostname.replace(/^www\./, ''); } catch { return true; } }).length;
  let status = 'pass', note = null, severity = null;
  if (httpUrls) { status = 'warn'; note = `${httpUrls} URL(s) in the sitemap use http:// on an HTTPS site.`; severity = 'warning'; }
  if (offOrigin) { status = 'warn'; note = `${(note || '')} ${offOrigin} URL(s) point to a different host.`.trim(); severity = 'warning'; }
  if (urls.length > 50000) { status = 'fail'; note = 'Sitemap lists more than 50,000 URLs (protocol limit).'; severity = 'error'; }
  out.push({ ...result('sitemap', 'XML sitemap', status, `${sitemap.sitemapUrls.length} sitemap file(s) · ${urls.length} URL(s)`, note, 'crawl', severity), sitemapUrls: sitemap.sitemapUrls, malformed: sitemap.malformed || 0 });
  if (sitemap.malformed) out.push(result('sitemap-format', 'Sitemap format', 'fail', `${sitemap.malformed} file(s) could not be parsed as XML`, 'Sitemap files contain XML errors.', 'crawl', 'error'));
  return out;
}

/**
 * Run all site-level checks. `ctx` = { startUrl, robots, sitemap, startPageMeta, imageUrls, assetUrls, sitemapUrlStatuses }.
 */
async function runSiteChecks(ctx) {
  const origin = new URL(ctx.startUrl).origin;
  const checks = [];
  const push = (r) => (Array.isArray(r) ? checks.push(...r) : checks.push(r));

  const [httpsRedirect, wwwResolve, startChain, tlsCert, h2, dnsResults, favicon, custom404, llms, adsTxt, images, assets] = await Promise.all([
    checkHttpsRedirect(origin),
    checkWwwResolve(origin),
    checkStartRedirects(ctx.startUrl),
    checkTls(origin),
    checkHttp2(origin),
    checkDns(origin),
    checkFavicon(origin, !!ctx.startPageMeta?.hasFaviconLink),
    checkCustom404(origin),
    checkWellKnownFile(origin, '/llms.txt', 'llms-txt', 'llms.txt (AI crawler guidance)', 'crawl', { status: 'warn', note: 'No llms.txt — optional file that tells AI crawlers what the site is about.', severity: 'notice' }),
    checkWellKnownFile(origin, '/ads.txt', 'ads-txt', 'ads.txt', 'technical', { status: 'pass', note: 'No ads.txt — only needed if the site sells programmatic ad inventory.', severity: null }),
    checkResources(ctx.imageUrls || [], 'broken-images', 'Broken images (sampled)'),
    checkResources(ctx.assetUrls || [], 'broken-assets', 'Broken JS/CSS files (sampled)'),
  ]);
  push(httpsRedirect); push(wwwResolve); push(startChain); push(tlsCert); push(h2); push(dnsResults); push(favicon); push(custom404); push(llms); push(adsTxt); push(images); push(assets);
  push(analyzeRobots(ctx.robots, origin));
  push(analyzeSitemap(ctx.sitemap, origin));

  // HSTS / security headers on the start page (from the crawl's real headers)
  const sh = ctx.startPageMeta?.securityHeaders;
  if (sh) {
    const present = Object.entries(sh).filter(([, v]) => v).map(([k]) => k);
    const missing = Object.entries(sh).filter(([, v]) => !v).map(([k]) => k);
    push(result('security-headers', 'Security headers (homepage)', missing.length > 3 ? 'warn' : 'pass', `${present.length}/6 present${present.length ? ': ' + present.join(', ') : ''}`, missing.length ? `Missing: ${missing.join(', ')}` : null, 'security', missing.length > 3 ? 'notice' : null));
    push(result('hsts', 'HSTS', sh['strict-transport-security'] ? 'pass' : 'warn', sh['strict-transport-security'] ? 'Strict-Transport-Security header present' : 'No HSTS header', sh['strict-transport-security'] ? null : 'Browsers can still be downgraded to HTTP on first visit.', 'security', sh['strict-transport-security'] ? null : 'notice'));
  } else {
    push(result('security-headers', 'Security headers (homepage)', 'unknown', null, 'Response headers were not captured for the homepage.', 'security'));
  }
  if (ctx.startPageMeta) {
    const m = ctx.startPageMeta;
    push(result('compression', 'HTML compression', m.compression ? 'pass' : m.headersAvailable ? 'warn' : 'unknown', m.compression ? `Content-Encoding: ${m.compression}` : m.headersAvailable ? 'No Content-Encoding header' : null, m.compression ? null : m.headersAvailable ? 'Enable gzip or brotli on the server.' : 'Headers unavailable.', 'performance', m.compression || !m.headersAvailable ? null : 'warning'));
    push(result('server-software', 'Web server', 'pass', m.serverHeader || 'Not disclosed', null, 'technical'));
    push(result('html-size', 'Homepage HTML size', m.htmlBytes > 300 * 1024 ? 'warn' : 'pass', `${Math.round(m.htmlBytes / 1024)} KB · ${m.domSize} DOM elements`, m.htmlBytes > 300 * 1024 ? 'Large HTML slows first render.' : null, 'performance', m.htmlBytes > 300 * 1024 ? 'notice' : null));
    push(result('response-time', 'Homepage response time (TTFB-ish)', m.responseTimeMs > 1500 ? 'warn' : 'pass', `${m.responseTimeMs} ms`, m.responseTimeMs > 1500 ? 'Server takes over 1.5s to respond.' : null, 'performance', m.responseTimeMs > 1500 ? 'warning' : null));
  }

  // Derive issues from failing/warning checks so they flow into scoring.
  const issues = checks
    .filter((c) => c.severity)
    .map((c) => ({ id: `site:${c.id}`, severity: c.severity, category: c.category, message: `${c.label}: ${c.note || c.value}`, affected: 1, urls: c.broken ? c.broken.map((b) => b.url) : undefined }));

  return { checks, issues };
}

module.exports = { runSiteChecks };
