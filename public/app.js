(function () {
  const form = document.getElementById('audit-form');
  const submitBtn = document.getElementById('submit-btn');
  const formError = document.getElementById('form-error');
  const progressPanel = document.getElementById('progress-panel');
  const progressFill = document.getElementById('progress-fill');
  const progressCount = document.getElementById('progress-count');
  const progressUrl = document.getElementById('progress-url');
  const progressLabel = document.getElementById('progress-label');
  const results = document.getElementById('results');
  const downloadBtn = document.getElementById('download-btn');
  const rankForm = document.getElementById('rank-form');

  const RING_CIRCUMFERENCE = 327;
  let pollTimer = null;
  let currentStartUrl = '';
  let currentIssues = [];
  let activeFilter = 'all';

  const CATEGORY_ORDER = ['meta', 'content', 'structure', 'links', 'images', 'technical', 'security', 'performance', 'social', 'crawl'];

  function scoreColor(score) {
    if (score >= 90) return getCss('--good');
    if (score >= 70) return getCss('--warning');
    if (score >= 50) return getCss('--serious');
    return getCss('--critical');
  }
  function getCss(varName) {
    return getComputedStyle(document.documentElement).getPropertyValue(varName).trim();
  }
  function escapeHtml(str) {
    return String(str ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function fmtBytes(b) {
    if (b == null) return 'n/a';
    if (b > 1024 * 1024) return (b / 1024 / 1024).toFixed(1) + ' MB';
    if (b > 1024) return Math.round(b / 1024) + ' KB';
    return b + ' B';
  }

  function setProgress(job) {
    const pct = job.total > 0 ? Math.min(100, Math.round((job.crawled / job.total) * 100)) : 0;
    const phase = job.phase || 'crawling';
    const labels = { crawling: 'Crawling…', analyzing: 'Analyzing pages…', 'site checks': 'Running server, DNS & TLS checks…', pagespeed: 'Running Google PageSpeed Insights (can take up to 90s)…', done: 'Done' };
    progressLabel.textContent = labels[phase] || phase;
    progressFill.style.width = (phase === 'crawling' ? pct : 100) + '%';
    progressCount.textContent = phase === 'crawling' ? `${job.crawled} / ${job.total}` : `${job.crawled} pages`;
    progressUrl.textContent = phase === 'crawling' ? job.currentUrl || '' : '';
  }

  function badge(text, ok, cls) {
    const span = document.createElement('span');
    span.className = 'badge ' + (cls || (ok ? 'good' : 'bad'));
    span.innerHTML = `<span class="dot"></span>${escapeHtml(text)}`;
    return span;
  }
  function severityIcon(sev) {
    return { error: '⛔', warning: '⚠️', notice: 'ℹ️' }[sev] || 'ℹ️';
  }
  function drawRing(ringFillEl, valueEl, score) {
    valueEl.textContent = score;
    const offset = RING_CIRCUMFERENCE - (RING_CIRCUMFERENCE * score) / 100;
    ringFillEl.style.stroke = scoreColor(score);
    requestAnimationFrame(() => { ringFillEl.style.strokeDashoffset = offset; });
  }

  // ---------- Tabs ----------
  function initTabs() {
    const buttons = document.querySelectorAll('.tab-btn');
    buttons.forEach((btn) => {
      btn.addEventListener('click', () => {
        buttons.forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        document.querySelectorAll('.tab-panel').forEach((p) => { p.hidden = p.id !== `tab-${btn.dataset.tab}`; });
      });
    });
  }

  // ---------- Category strip ----------
  function renderCategoryStrip(cats) {
    const el = document.getElementById('category-strip');
    el.innerHTML = CATEGORY_ORDER.filter((c) => cats[c]).map((c) => {
      const s = cats[c];
      return `<div class="cat-tile"><div class="cat-score" style="color:${scoreColor(s.score)}">${s.score}</div><div class="cat-label">${escapeHtml(s.label)}</div><div class="cat-issues">${s.issueCount} issue${s.issueCount === 1 ? '' : 's'}</div></div>`;
    }).join('');
  }

  // ---------- SERP preview ----------
  function renderSerp(home) {
    const el = document.getElementById('serp-preview');
    if (!home) { el.innerHTML = '<p class="unconfigured-note">Homepage could not be analyzed.</p>'; return; }
    const title = home.title || '(no title tag)';
    const desc = home.metaDescription || '(no meta description — Google will pick text from the page)';
    let host = '', path = '';
    try { const u = new URL(home.url); host = u.host; path = u.pathname === '/' ? '' : u.pathname.replace(/\//g, ' › '); } catch { host = home.url; }
    el.innerHTML = `
      <div class="serp-url">${escapeHtml(host)}${escapeHtml(path)}</div>
      <div class="serp-title">${escapeHtml(title.length > 60 ? title.slice(0, 57) + '…' : title)}</div>
      <div class="serp-desc">${escapeHtml(desc.length > 160 ? desc.slice(0, 157) + '…' : desc)}</div>
      <div class="serp-meta">Title ${title.length} chars · Description ${(home.metaDescription || '').length} chars</div>`;
  }

  // ---------- Core Web Vitals ----------
  function metricPill(val, target, unit, higherIsWorse = true) {
    if (val == null) return `<span class="pill">n/a</span>`;
    const bad = higherIsWorse ? val > target : val < target;
    return `<span class="pill ${bad ? 'warn' : 'ok'}">${val}${unit}</span>`;
  }
  function renderCoreWebVitals(cwv) {
    const el = document.getElementById('cwv-content');
    if (!cwv || !cwv.configured) {
      el.innerHTML = `<p class="unconfigured-note">${escapeHtml(cwv?.reason || 'PageSpeed Insights not configured.')}</p>`;
      return;
    }
    if (!cwv.ok) {
      el.innerHTML = `<p class="unconfigured-note">PageSpeed Insights could not measure this URL: ${escapeHtml(cwv.error || 'unknown error')}. Nothing is shown here rather than an estimate.</p>`;
      return;
    }
    const rows = ['mobile', 'desktop'].filter((s) => cwv.strategies?.[s]).map((s) => {
      const r = cwv.strategies[s];
      if (!r.ok) return `<tr><td>${s}</td><td colspan="8" class="muted">${escapeHtml(r.error || 'failed')}</td></tr>`;
      const sc = r.scores || {};
      const scorePill = (v) => (v == null ? '<span class="pill">n/a</span>' : `<span class="pill ${v >= 90 ? 'ok' : v >= 50 ? 'warn' : 'err'}">${v}</span>`);
      return `<tr>
        <td><strong>${s}</strong></td>
        <td>${scorePill(sc.performance)}</td><td>${scorePill(sc.seo)}</td><td>${scorePill(sc.accessibility)}</td><td>${scorePill(sc.bestPractices)}</td>
        <td>${metricPill(r.lcpSeconds, 2.5, 's')}</td><td>${metricPill(r.cls, 0.1, '')}</td><td>${r.inpMs != null ? metricPill(r.inpMs, 200, 'ms') : '<span class="pill">no field data</span>'}</td>
        <td>${metricPill(r.fcpSeconds, 1.8, 's')}</td><td>${metricPill(r.tbtMs, 200, 'ms')}</td><td>${r.ttfbMs != null ? metricPill(r.ttfbMs, 800, 'ms') : '<span class="pill">n/a</span>'}</td>
        <td>${fmtBytes(r.totalBytes)}</td><td>${r.requestCount ?? 'n/a'}</td>
      </tr>`;
    }).join('');
    el.innerHTML = `
      <div class="table-scroll"><table class="cwv-table">
        <thead><tr><th>Device</th><th>Performance</th><th>SEO</th><th>Accessibility</th><th>Best practices</th><th>LCP</th><th>CLS</th><th>INP</th><th>FCP</th><th>TBT</th><th>TTFB</th><th>Page weight</th><th>Requests</th></tr></thead>
        <tbody>${rows}</tbody></table></div>
      <p class="panel-sub">${cwv.fieldDataAvailable ? 'LCP / CLS / INP include real-user (field) data from the Chrome UX Report.' : 'No Chrome UX Report field data for this URL yet — LCP/CLS are lab values from this Lighthouse run; INP is unavailable without field data.'} ${cwv.keyed ? '' : 'Running keyless (small quota) — add GOOGLE_PAGESPEED_API_KEY for a larger quota.'}</p>`;
  }

  // ---------- Lighthouse audits table ----------
  function renderLighthouse(cwv) {
    const el = document.getElementById('lighthouse-content');
    const run = cwv?.strategies?.mobile?.ok ? cwv.strategies.mobile : cwv?.strategies?.desktop?.ok ? cwv.strategies.desktop : null;
    if (!run) {
      el.innerHTML = `<p class="unconfigured-note">${escapeHtml(cwv?.error || cwv?.reason || 'PageSpeed Insights data unavailable for this audit.')}</p>`;
      return;
    }
    const groups = {};
    for (const a of run.audits || []) (groups[a.group] = groups[a.group] || []).push(a);
    const labels = { performance: 'Performance', mobile: 'Mobile usability', seo: 'SEO (Lighthouse)', accessibility: 'Accessibility', security: 'Security', technical: 'Technical' };
    el.innerHTML = Object.entries(groups).map(([g, list]) => `
      <h3 class="subhead">${escapeHtml(labels[g] || g)}</h3>
      <table class="checks-table"><tbody>
        ${list.map((a) => `<tr>
          <td class="check-status"><span class="status-dot ${a.passed === null ? 'notice' : a.passed ? 'good' : 'error'}"></span></td>
          <td>${escapeHtml(a.label)}</td>
          <td>${escapeHtml(a.displayValue || (a.passed === null ? 'informational' : a.passed ? 'Passed' : 'Needs attention'))}</td>
        </tr>`).join('')}
      </tbody></table>`).join('');
  }

  // ---------- Site checks ----------
  function renderSiteChecks(checks) {
    const tbody = document.getElementById('site-checks-tbody');
    tbody.innerHTML = '';
    for (const c of checks || []) {
      const tr = document.createElement('tr');
      const dot = { pass: 'good', warn: 'warning', fail: 'error', unknown: 'notice' }[c.status] || 'notice';
      const statusText = { pass: 'Pass', warn: 'Warning', fail: 'Fail', unknown: 'Could not check' }[c.status] || c.status;
      const broken = c.broken && c.broken.length ? `<div class="issue-urls">${c.broken.map((b) => `<span>${escapeHtml(b.url)} → ${b.status || escapeHtml(b.error || 'failed')}</span>`).join('')}</div>` : '';
      tr.innerHTML = `
        <td class="check-status"><span class="status-dot ${dot}"></span><div class="check-status-text">${statusText}</div></td>
        <td><strong>${escapeHtml(c.label)}</strong></td>
        <td><div class="check-value">${escapeHtml(c.value ?? '')}</div>${c.note ? `<div class="check-note">${escapeHtml(c.note)}</div>` : ''}${broken}</td>`;
      tbody.appendChild(tr);
    }
  }

  // ---------- Tech / structured data ----------
  function renderTech(home) {
    const el = document.getElementById('tech-content');
    if (!home) { el.innerHTML = ''; return; }
    const tech = home.technologies || [];
    const sd = home.structuredData || {};
    const m = home.meta || {};
    el.innerHTML = `
      <div class="badge-row">${tech.length ? tech.map((t) => badge(t, true, 'neutral').outerHTML).join('') : '<span class="muted">No recognizable technology signatures found in the homepage HTML.</span>'}</div>
      <table class="kv-table">
        <tr><th>JSON-LD blocks</th><td>${sd.jsonLdBlocks ?? 0}${sd.jsonLdErrors ? ` (<span class="err-text">${sd.jsonLdErrors} invalid</span>)` : ''}</td></tr>
        <tr><th>Schema types</th><td>${(sd.jsonLdTypes || []).length ? (sd.jsonLdTypes || []).map(escapeHtml).join(', ') : '<span class="muted">none</span>'}</td></tr>
        <tr><th>Microdata items</th><td>${sd.microdataItems ?? 0}</td></tr>
        <tr><th>Identity schema (Organization / Person / LocalBusiness)</th><td>${m.hasIdentitySchema ? 'Yes' : 'No'}</td></tr>
        <tr><th>Web server header</th><td>${escapeHtml(m.serverHeader || 'not disclosed')}</td></tr>
        <tr><th>Charset</th><td>${escapeHtml(m.charset || 'not declared')}</td></tr>
        <tr><th>Language (html lang)</th><td>${escapeHtml(m.lang || 'not declared')}</td></tr>
        <tr><th>AMP</th><td>${m.isAmp ? 'Yes' : 'No'}</td></tr>
        <tr><th>Hreflang entries</th><td>${m.hreflangCount || 0}</td></tr>
      </table>`;
  }

  function renderSafeBrowsing(sb) {
    const el = document.getElementById('safebrowsing-content');
    if (!sb || !sb.configured) {
      el.innerHTML = `<p class="unconfigured-note">Google Safe Browsing not checked — <code>GOOGLE_SAFE_BROWSING_API_KEY</code> is not configured (free key). Shown as unchecked rather than "clean".</p>`;
      return;
    }
    if (!sb.ok) { el.innerHTML = `<p class="unconfigured-note">Safe Browsing lookup failed: ${escapeHtml(sb.error)}</p>`; return; }
    el.innerHTML = `<div class="badge-row">${badge(sb.flagged ? `Flagged: ${sb.threats.join(', ')}` : 'No threats listed by Google Safe Browsing', !sb.flagged).outerHTML}</div>`;
  }

  // ---------- Content tab ----------
  function renderKeywords(home) {
    const tbody = document.getElementById('keyword-tbody');
    const phrases = document.getElementById('phrase-row');
    tbody.innerHTML = '';
    phrases.innerHTML = '';
    const kw = home?.keywords;
    if (!kw || !kw.topKeywords?.length) {
      tbody.innerHTML = '<tr><td colspan="6" class="muted">Not enough visible text on the homepage to compute keywords.</td></tr>';
      return;
    }
    const yn = (b) => (b ? '<span class="pill ok">yes</span>' : '<span class="pill warn">no</span>');
    for (const k of kw.topKeywords) {
      const tr = document.createElement('tr');
      tr.innerHTML = `<td><strong>${escapeHtml(k.term)}</strong></td><td>${k.count}</td><td>${k.density}%</td><td>${yn(k.inTitle)}</td><td>${yn(k.inDescription)}</td><td>${yn(k.inH1)}</td>`;
      tbody.appendChild(tr);
    }
    if (kw.topPhrases?.length) {
      phrases.innerHTML = `<span class="muted">Repeated phrases:</span> ${kw.topPhrases.map((p) => `<span class="pill">${escapeHtml(p.term)} ×${p.count}</span>`).join(' ')}`;
    }
  }
  function renderHeadings(home) {
    const counts = document.getElementById('heading-counts');
    const ol = document.getElementById('heading-outline');
    ol.innerHTML = '';
    counts.innerHTML = '';
    if (!home) return;
    const hc = home.headingCounts || {};
    counts.innerHTML = ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'].map((h) => `<span class="pill ${h === 'h1' ? (hc.h1 === 1 ? 'ok' : 'warn') : ''}">${h.toUpperCase()}: ${hc[h] ?? 0}</span>`).join(' ');
    for (const h of home.headings || []) {
      const li = document.createElement('li');
      li.className = `hl-${h.level}`;
      li.innerHTML = `<span class="hl-tag">H${h.level}</span> ${escapeHtml(h.text || '(empty)')}`;
      ol.appendChild(li);
    }
    if (!(home.headings || []).length) ol.innerHTML = '<li class="muted">No headings found.</li>';
  }
  function renderContentTable(pages) {
    const tbody = document.getElementById('content-tbody');
    tbody.innerHTML = '';
    for (const p of pages) {
      if (p.meta.blockedByRobots || p.meta.status >= 300 || p.meta.contentStripped) continue;
      const tr = document.createElement('tr');
      const top = p.details?.keywords?.topKeywords?.[0];
      tr.innerHTML = `
        <td><a href="${escapeHtml(p.meta.finalUrl)}" target="_blank" rel="noopener">${escapeHtml(p.meta.finalUrl)}</a></td>
        <td>${p.meta.wordCount ?? 0}</td>
        <td>${p.meta.textToHtmlRatio != null ? p.meta.textToHtmlRatio + '%' : '–'}</td>
        <td>${p.meta.headingCounts?.h1 ?? 0}</td>
        <td>${p.meta.headingCounts?.h2 ?? 0}</td>
        <td>${p.meta.imagesTotal ?? 0}</td>
        <td>${p.meta.imagesMissingAlt ?? 0}</td>
        <td>${top ? escapeHtml(top.term) + ' ×' + top.count : '–'}</td>`;
      tbody.appendChild(tr);
    }
  }
  function renderSocial(home) {
    const el = document.getElementById('social-content');
    if (!home) { el.innerHTML = ''; return; }
    const og = home.openGraph || {}, tw = home.twitter || {}, profiles = home.socialProfiles || {};
    const names = { facebook: 'Facebook', x: 'X / Twitter', instagram: 'Instagram', linkedin: 'LinkedIn', youtube: 'YouTube', tiktok: 'TikTok', pinterest: 'Pinterest' };
    el.innerHTML = `
      <h3 class="subhead">Profiles linked from the site (any crawled page)</h3>
      <div class="badge-row">${Object.keys(names).map((k) => badge(names[k] + (profiles[k] ? ' linked' : ' not linked'), !!profiles[k], profiles[k] ? 'good' : 'muted-badge').outerHTML).join('')}</div>
      <h3 class="subhead">Open Graph</h3>
      <table class="kv-table">${['og:title', 'og:description', 'og:image', 'og:url', 'og:type'].map((k) => `<tr><th>${k}</th><td>${og[k] ? escapeHtml(og[k]) : '<span class="muted">missing</span>'}</td></tr>`).join('')}</table>
      <h3 class="subhead">Twitter / X card</h3>
      <table class="kv-table">${['twitter:card', 'twitter:title', 'twitter:description', 'twitter:image'].map((k) => `<tr><th>${k}</th><td>${tw[k] ? escapeHtml(tw[k]) : '<span class="muted">missing</span>'}</td></tr>`).join('')}</table>
      <p class="panel-sub">Facebook Pixel: ${(home.technologies || []).includes('Facebook Pixel') ? 'detected' : 'not detected'} · Analytics: ${(home.technologies || []).some((t) => /Analytics|Tag Manager/.test(t)) ? 'detected' : 'not detected'}</p>`;
  }

  // ---------- Indexing / rank ----------
  function renderIndexing(indexing) {
    const el = document.getElementById('indexing-content');
    if (!indexing || !indexing.configured) {
      el.innerHTML = `<p class="unconfigured-note">Indexing check unavailable — <code>GOOGLE_CUSTOM_SEARCH_API_KEY</code> / <code>GOOGLE_CUSTOM_SEARCH_ENGINE_ID</code> are not configured on the server. See the README for how to set up a free Programmable Search Engine.</p>`;
      return;
    }
    if (indexing.error) { el.innerHTML = `<p class="unconfigured-note">Indexing check failed: ${escapeHtml(indexing.error)}.</p>`; return; }
    const label = { indexed: 'Indexed', not_indexed: 'Not indexed', uncertain: 'Uncertain' }[indexing.status] || 'Uncertain';
    el.innerHTML = `<div class="badge-row">${badge(label, indexing.status === 'indexed').outerHTML}${badge(`${indexing.totalResults ?? 0} result(s) for site: query`, true, 'neutral').outerHTML}</div>`;
  }
  function renderRankResults(data) {
    const el = document.getElementById('rank-content');
    if (!data || !data.results || data.results.length === 0) { el.innerHTML = ''; return; }
    if (!data.results[0].configured) {
      el.innerHTML = `<p class="unconfigured-note">Rank tracking unavailable — <code>GOOGLE_CUSTOM_SEARCH_API_KEY</code> / <code>GOOGLE_CUSTOM_SEARCH_ENGINE_ID</code> are not configured on the server.</p>`;
      return;
    }
    const rows = data.results.map((r) => {
      if (!r.ok) return `<tr><td>${escapeHtml(r.keyword)}</td><td colspan="3" class="muted">${escapeHtml(r.error || 'check failed')}</td></tr>`;
      const pos = r.position != null ? `#${r.position}` : 'not in top results';
      const change = r.change == null ? '–' : r.change > 0 ? `▲ ${r.change}` : r.change < 0 ? `▼ ${Math.abs(r.change)}` : '– 0';
      const best = r.bestPosition != null ? `#${r.bestPosition}` : '–';
      return `<tr><td>${escapeHtml(r.keyword)}</td><td>${pos}</td><td>${change}</td><td>${best}</td></tr>`;
    }).join('');
    el.innerHTML = `<table class="rank-table"><thead><tr><th>Keyword</th><th>Position</th><th>Change</th><th>Best</th></tr></thead><tbody>${rows}</tbody></table>`;
  }
  rankForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const raw = document.getElementById('rank-keywords').value.trim();
    if (!raw || !currentStartUrl) return;
    const keywords = raw.split(',').map((k) => k.trim()).filter(Boolean).slice(0, 10);
    if (!keywords.length) return;
    const btn = document.getElementById('rank-submit-btn');
    btn.disabled = true; btn.textContent = 'Checking…';
    try {
      const domain = new URL(currentStartUrl).host;
      const res = await fetch('/api/rank-check', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ domain, keywords }) });
      renderRankResults(await res.json());
    } catch (err) {
      document.getElementById('rank-content').innerHTML = `<p class="unconfigured-note">Request failed: ${escapeHtml(err.message)}</p>`;
    } finally {
      btn.disabled = false; btn.textContent = 'Check rankings';
    }
  });

  // ---------- Depth chart ----------
  function renderDepthChart(dist) {
    const el = document.getElementById('depth-chart');
    const order = ['0', '1', '2', '3', '4+'];
    const max = Math.max(1, ...order.map((k) => dist[k] || 0));
    el.innerHTML = order.map((k) => {
      const count = dist[k] || 0;
      return `<div class="depth-row"><span class="depth-label">Depth ${k}</span><div class="depth-track"><div class="depth-fill" style="width:${Math.round((count / max) * 100)}%"></div></div><span class="depth-count">${count}</span></div>`;
    }).join('');
  }

  // ---------- Issues table with category filter ----------
  function renderIssues() {
    const tbody = document.getElementById('issues-tbody');
    tbody.innerHTML = '';
    const template = document.getElementById('issue-row-template');
    const labels = { meta: 'Meta', content: 'Content', structure: 'Structure', links: 'Links', images: 'Images', technical: 'Technical', security: 'Security', performance: 'Performance', social: 'Social', crawl: 'Crawl' };
    for (const iss of currentIssues) {
      if (activeFilter !== 'all' && iss.category !== activeFilter) continue;
      const frag = template.content.cloneNode(true);
      const rows = frag.querySelectorAll('tr');
      const mainRow = rows[0], detailRow = rows[1];
      mainRow.querySelector('.status-dot').classList.add(iss.severity);
      mainRow.querySelector('.issue-message').textContent = iss.sampleMessage;
      mainRow.querySelector('.issue-category').innerHTML = `<span class="pill cat-${escapeHtml(iss.category)}">${escapeHtml(labels[iss.category] || iss.category)}</span>`;
      mainRow.querySelector('.issue-count').textContent = iss.count;
      mainRow.addEventListener('click', () => {
        detailRow.hidden = !detailRow.hidden;
        mainRow.querySelector('.issue-toggle').textContent = detailRow.hidden ? '▾' : '▴';
      });
      const wrap = detailRow.querySelector('.issue-urls');
      if (iss.urls && iss.urls.length) {
        for (const u of iss.urls) {
          const a = document.createElement('a');
          a.href = u; a.textContent = u; a.target = '_blank'; a.rel = 'noopener';
          wrap.appendChild(a);
        }
      } else {
        wrap.textContent = 'Site-wide finding.';
      }
      tbody.appendChild(mainRow);
      tbody.appendChild(detailRow);
    }
    if (!tbody.children.length) tbody.innerHTML = '<tr><td colspan="5" class="muted">No issues in this category.</td></tr>';
  }
  function renderIssueFilters(cats) {
    const el = document.getElementById('issue-filters');
    const all = `<button class="filter-btn ${activeFilter === 'all' ? 'active' : ''}" data-cat="all">All (${currentIssues.length})</button>`;
    el.innerHTML = all + CATEGORY_ORDER.filter((c) => cats[c]).map((c) => {
      const n = currentIssues.filter((i) => i.category === c).length;
      return `<button class="filter-btn ${activeFilter === c ? 'active' : ''}" data-cat="${c}">${escapeHtml(cats[c].label)} (${n})</button>`;
    }).join('');
    el.querySelectorAll('.filter-btn').forEach((b) => b.addEventListener('click', () => { activeFilter = b.dataset.cat; renderIssueFilters(cats); renderIssues(); }));
  }

  // ---------- Main render ----------
  function renderSummary(job) {
    const s = job.summary;
    currentStartUrl = job.startUrl;
    currentIssues = s.topIssues || [];
    activeFilter = 'all';

    renderCategoryStrip(s.categoryScores || {});
    drawRing(document.getElementById('ring-fill'), document.getElementById('score-value'), s.score);
    document.getElementById('stat-pages').textContent = s.totalPagesCrawled;
    document.getElementById('stat-errors').textContent = s.counts.error || 0;
    document.getElementById('stat-warnings').textContent = s.counts.warning || 0;
    document.getElementById('stat-notices').textContent = s.counts.notice || 0;

    const badges = document.getElementById('site-badges');
    badges.innerHTML = '';
    badges.appendChild(badge('robots.txt ' + (s.robotsTxtFound ? 'found' : 'missing'), s.robotsTxtFound));
    badges.appendChild(badge('sitemap ' + (s.sitemapFound ? 'found' : 'missing'), s.sitemapFound));
    badges.appendChild(badge(`${s.brokenPages} broken page(s)`, s.brokenPages === 0));
    badges.appendChild(badge(`${s.externalLinksChecked} external link(s) checked`, true, 'neutral'));
    const https = s.homepage?.meta?.isHttps;
    badges.appendChild(badge(https ? 'HTTPS' : 'Not HTTPS', !!https));
    if (s.renderJs && s.renderJs.requested) {
      badges.appendChild(badge(s.renderJs.used ? 'JavaScript rendered' : 'JS rendering unavailable', s.renderJs.used));
    }
    const renderNote = document.getElementById('renderjs-note');
    if (s.renderJs && s.renderJs.requested && !s.renderJs.used) {
      renderNote.hidden = false;
      renderNote.textContent = `You asked for JavaScript rendering, but it didn't run: ${s.renderJs.unavailableReason || 'unknown reason'} This audit used plain HTML instead, so content that only appears after JavaScript runs may be under-reported.`;
    } else {
      renderNote.hidden = true;
    }

    renderSerp(s.homepage);
    renderCoreWebVitals(s.coreWebVitals);
    renderIssueFilters(s.categoryScores || {});
    renderIssues();

    // Content tab
    renderKeywords(s.homepage);
    renderHeadings(s.homepage);
    renderContentTable(job.pages || []);
    renderSocial(s.homepage);

    // Site Crawl tab
    drawRing(document.getElementById('health-ring-fill'), document.getElementById('health-value'), s.siteHealthScore);
    document.getElementById('stat-crawl-time').textContent = s.crawlTimeMs != null ? `${(s.crawlTimeMs / 1000).toFixed(1)}s` : '–';
    document.getElementById('stat-broken').textContent = s.brokenLinksTotal ?? 0;
    document.getElementById('stat-duplicates').textContent = s.duplicatePagesCount ?? 0;
    document.getElementById('stat-orphans').textContent = s.orphanPagesCount ?? 0;
    renderDepthChart(s.depthDistribution || {});

    const scoreByUrl = new Map((s.pageScores || []).map((p) => [p.url, p.score]));
    const pagesBody = document.getElementById('pages-tbody');
    pagesBody.innerHTML = '';
    for (const p of job.pages || []) {
      const tr = document.createElement('tr');
      const isBlocked = p.meta.blockedByRobots;
      const statusClass = isBlocked ? 'warn' : p.meta.status === 0 ? 'err' : p.meta.status >= 400 ? 'err' : p.meta.status >= 300 ? 'warn' : 'ok';
      const statusLabel = isBlocked ? 'BLOCKED' : (p.meta.status || 'ERR');
      const errCount = p.issues.filter((i) => i.severity === 'error').length;
      const warnCount = p.issues.filter((i) => i.severity === 'warning').length;
      const noticeCount = p.issues.filter((i) => i.severity === 'notice').length;
      const titleCell = isBlocked ? '<span class="muted">disallowed by robots.txt</span>' : (p.meta.title ? escapeHtml(p.meta.title) : '<span class="muted">missing</span>');
      const pageScore = scoreByUrl.get(p.meta.finalUrl);
      tr.innerHTML = `
        <td><a href="${escapeHtml(p.meta.finalUrl)}" target="_blank" rel="noopener">${escapeHtml(p.meta.finalUrl)}</a></td>
        <td><span class="pill ${statusClass}">${statusLabel}</span></td>
        <td>${p.depth ?? '–'}</td>
        <td>${titleCell}</td>
        <td>${isBlocked ? '–' : (p.meta.wordCount || 0)}</td>
        <td>${isBlocked ? '–' : (pageScore ?? '–')}</td>
        <td class="mini-issue-badges">
          ${errCount ? `<span>${severityIcon('error')} ${errCount}</span>` : ''}
          ${warnCount ? `<span>${severityIcon('warning')} ${warnCount}</span>` : ''}
          ${noticeCount ? `<span>${severityIcon('notice')} ${noticeCount}</span>` : ''}
          ${!errCount && !warnCount && !noticeCount ? '<span style="color:var(--good)">clean</span>' : ''}
        </td>`;
      pagesBody.appendChild(tr);
    }

    // Technical tab
    renderSiteChecks(s.siteChecks || []);
    renderLighthouse(s.coreWebVitals);
    renderTech(s.homepage);
    renderSafeBrowsing(s.safeBrowsing);

    // Index tab
    renderIndexing(s.indexing);
    document.getElementById('rank-content').innerHTML = '';
    document.getElementById('rank-keywords').value = '';

    results.hidden = false;
  }

  // ---------- Download report ----------
  downloadBtn.addEventListener('click', () => {
    const panels = document.querySelectorAll('.tab-panel');
    const previouslyHidden = [...panels].map((p) => p.hidden);
    panels.forEach((p) => (p.hidden = false));
    window.print();
    panels.forEach((p, i) => (p.hidden = previouslyHidden[i]));
  });

  // ---------- Poll ----------
  async function poll(jobId) {
    try {
      const res = await fetch(`/api/audit/${jobId}`);
      if (!res.ok) throw new Error('Job not found');
      const job = await res.json();
      setProgress(job);
      if (job.status === 'done') {
        clearInterval(pollTimer);
        progressPanel.hidden = true;
        submitBtn.disabled = false;
        renderSummary(job);
      } else if (job.status === 'error') {
        clearInterval(pollTimer);
        progressPanel.hidden = true;
        submitBtn.disabled = false;
        showError(job.error || 'Audit failed.');
      }
    } catch (err) {
      clearInterval(pollTimer);
      progressPanel.hidden = true;
      submitBtn.disabled = false;
      showError(err.message);
    }
  }
  function showError(msg) { formError.textContent = msg; formError.hidden = false; }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    formError.hidden = true;
    results.hidden = true;
    submitBtn.disabled = true;
    const url = document.getElementById('url').value.trim();
    const maxPages = document.getElementById('maxPages').value;
    const checkExternalLinks = document.getElementById('checkExternalLinks').checked;
    const renderJs = document.getElementById('renderJs').checked;
    try {
      const res = await fetch('/api/audit', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url, maxPages, checkExternalLinks, renderJs }) });
      const data = await res.json();
      if (!res.ok) { submitBtn.disabled = false; showError(data.error || 'Could not start audit.'); return; }
      progressPanel.hidden = false;
      setProgress({ crawled: 0, total: 1, currentUrl: url, phase: 'crawling' });
      pollTimer = setInterval(() => poll(data.id), 1200);
    } catch (err) {
      submitBtn.disabled = false;
      showError('Could not reach the server.');
    }
  });

  initTabs();
})();
