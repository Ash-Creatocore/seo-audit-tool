(function () {
  const form = document.getElementById('audit-form');
  const submitBtn = document.getElementById('submit-btn');
  const formError = document.getElementById('form-error');
  const progressPanel = document.getElementById('progress-panel');
  const progressFill = document.getElementById('progress-fill');
  const progressCount = document.getElementById('progress-count');
  const progressUrl = document.getElementById('progress-url');
  const results = document.getElementById('results');
  const downloadBtn = document.getElementById('download-btn');
  const rankForm = document.getElementById('rank-form');

  const RING_CIRCUMFERENCE = 327;
  let pollTimer = null;
  let currentStartUrl = '';

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
    return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function setProgress(crawled, total, currentUrl) {
    const pct = total > 0 ? Math.min(100, Math.round((crawled / total) * 100)) : 0;
    progressFill.style.width = pct + '%';
    progressCount.textContent = `${crawled} / ${total}`;
    progressUrl.textContent = currentUrl || '';
  }

  function badge(text, ok) {
    const span = document.createElement('span');
    span.className = 'badge ' + (ok ? 'good' : 'bad');
    span.innerHTML = `<span class="dot"></span>${text}`;
    return span;
  }

  function severityIcon(sev) {
    return { error: '⛔', warning: '⚠️', notice: 'ℹ️' }[sev] || 'ℹ️';
  }

  function drawRing(ringFillEl, valueEl, score) {
    valueEl.textContent = score;
    const offset = RING_CIRCUMFERENCE - (RING_CIRCUMFERENCE * score) / 100;
    ringFillEl.style.stroke = scoreColor(score);
    requestAnimationFrame(() => {
      ringFillEl.style.strokeDashoffset = offset;
    });
  }

  // ---------- Tabs ----------
  function initTabs() {
    const buttons = document.querySelectorAll('.tab-btn');
    buttons.forEach((btn) => {
      btn.addEventListener('click', () => {
        buttons.forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        document.querySelectorAll('.tab-panel').forEach((p) => {
          p.hidden = p.id !== `tab-${btn.dataset.tab}`;
        });
      });
    });
  }

  // ---------- Core Web Vitals ----------
  function renderCoreWebVitals(cwv) {
    const el = document.getElementById('cwv-content');
    if (!cwv || !cwv.configured) {
      el.innerHTML = `<p class="unconfigured-note">Core Web Vitals unavailable — <code>GOOGLE_PAGESPEED_API_KEY</code> is not configured on the server. This section intentionally shows nothing rather than a fake measurement. See the README for how to add a free key.</p>`;
      return;
    }
    if (!cwv.ok) {
      el.innerHTML = `<p class="unconfigured-note">PageSpeed Insights call failed: ${escapeHtml(cwv.error || 'unknown error')}.</p>`;
      return;
    }
    const metric = (val, target, unit, higherIsWorse = true) => {
      if (val == null) return { cls: 'notice', text: 'n/a' };
      const bad = higherIsWorse ? val > target : val < target;
      return { cls: bad ? 'warn' : 'ok', text: `${val}${unit}` };
    };
    const lcp = metric(cwv.lcpSeconds, 2.5, 's');
    const cls = metric(cwv.cls, 0.1, '', true);
    const inp = metric(cwv.inpMs, 200, 'ms');
    const perf = cwv.performanceScore;
    el.innerHTML = `
      <div class="cwv-grid">
        <div class="cwv-tile"><div class="cwv-label">LCP</div><div class="cwv-value pill ${lcp.cls}">${lcp.text}</div><div class="cwv-target">Target: ≤ 2.5s</div></div>
        <div class="cwv-tile"><div class="cwv-label">CLS</div><div class="cwv-value pill ${cls.cls}">${cls.text}</div><div class="cwv-target">Target: ≤ 0.1</div></div>
        <div class="cwv-tile"><div class="cwv-label">INP</div><div class="cwv-value pill ${inp.cls}">${inp.text}</div><div class="cwv-target">Target: ≤ 200ms</div></div>
        <div class="cwv-tile"><div class="cwv-label">Performance</div><div class="cwv-value pill ${perf != null && perf < 90 ? 'warn' : 'ok'}">${perf != null ? perf + '/100' : 'n/a'}</div><div class="cwv-target">Target: ≥ 90</div></div>
      </div>
      <p class="panel-sub">${cwv.fieldDataAvailable ? 'Includes real-user (field) data from the Chrome UX Report where available.' : 'Lab data from a live Lighthouse run (no Chrome UX Report field data available for this URL yet).'}</p>`;
  }

  // ---------- Indexing ----------
  function renderIndexing(indexing) {
    const el = document.getElementById('indexing-content');
    if (!indexing || !indexing.configured) {
      el.innerHTML = `<p class="unconfigured-note">Indexing check unavailable — <code>GOOGLE_CUSTOM_SEARCH_API_KEY</code> / <code>GOOGLE_CUSTOM_SEARCH_ENGINE_ID</code> are not configured on the server. See the README for how to set up a free Programmable Search Engine.</p>`;
      return;
    }
    if (indexing.error) {
      el.innerHTML = `<p class="unconfigured-note">Indexing check failed: ${escapeHtml(indexing.error)}.</p>`;
      return;
    }
    const label = { indexed: 'Indexed', not_indexed: 'Not indexed', uncertain: 'Uncertain' }[indexing.status] || 'Uncertain';
    const ok = indexing.status === 'indexed';
    el.innerHTML = `
      <div class="badge-row">${badge(label, ok).outerHTML}${badge(`${indexing.totalResults ?? 0} result(s) for site: query`, true).outerHTML}</div>`;
  }

  // ---------- Rank checking ----------
  function renderRankResults(data) {
    const el = document.getElementById('rank-content');
    if (!data || !data.results || data.results.length === 0) {
      el.innerHTML = '';
      return;
    }
    if (!data.results[0].configured) {
      el.innerHTML = `<p class="unconfigured-note">Rank tracking unavailable — <code>GOOGLE_CUSTOM_SEARCH_API_KEY</code> / <code>GOOGLE_CUSTOM_SEARCH_ENGINE_ID</code> are not configured on the server.</p>`;
      return;
    }
    const rows = data.results
      .map((r) => {
        if (!r.ok) {
          return `<tr><td>${escapeHtml(r.keyword)}</td><td colspan="3" class="unconfigured-note">${escapeHtml(r.error || 'check failed')}</td></tr>`;
        }
        const pos = r.position != null ? `#${r.position}` : 'not in top results';
        const change = r.change == null ? '–' : r.change > 0 ? `▲ ${r.change}` : r.change < 0 ? `▼ ${Math.abs(r.change)}` : '– 0';
        const best = r.bestPosition != null ? `#${r.bestPosition}` : '–';
        return `<tr><td>${escapeHtml(r.keyword)}</td><td>${pos}</td><td>${change}</td><td>${best}</td></tr>`;
      })
      .join('');
    el.innerHTML = `
      <table class="rank-table">
        <thead><tr><th>Keyword</th><th>Position</th><th>Change</th><th>Best</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>`;
  }

  rankForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const raw = document.getElementById('rank-keywords').value.trim();
    if (!raw || !currentStartUrl) return;
    const keywords = raw.split(',').map((k) => k.trim()).filter(Boolean).slice(0, 10);
    if (keywords.length === 0) return;

    const btn = document.getElementById('rank-submit-btn');
    btn.disabled = true;
    btn.textContent = 'Checking…';
    try {
      const domain = new URL(currentStartUrl).host;
      const res = await fetch('/api/rank-check', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ domain, keywords }),
      });
      const data = await res.json();
      renderRankResults(data);
    } catch (err) {
      document.getElementById('rank-content').innerHTML = `<p class="unconfigured-note">Request failed: ${escapeHtml(err.message)}</p>`;
    } finally {
      btn.disabled = false;
      btn.textContent = 'Check rankings';
    }
  });

  // ---------- Depth chart ----------
  function renderDepthChart(dist) {
    const el = document.getElementById('depth-chart');
    const order = ['0', '1', '2', '3', '4+'];
    const max = Math.max(1, ...order.map((k) => dist[k] || 0));
    el.innerHTML = order
      .map((k) => {
        const count = dist[k] || 0;
        const pct = Math.round((count / max) * 100);
        return `
          <div class="depth-row">
            <span class="depth-label">Depth ${k}</span>
            <div class="depth-track"><div class="depth-fill" style="width:${pct}%"></div></div>
            <span class="depth-count">${count}</span>
          </div>`;
      })
      .join('');
  }

  // ---------- Main render ----------
  function renderSummary(job) {
    const s = job.summary;
    currentStartUrl = job.startUrl;

    // On-Page tab
    drawRing(document.getElementById('ring-fill'), document.getElementById('score-value'), s.score);
    document.getElementById('stat-pages').textContent = s.totalPagesCrawled;
    document.getElementById('stat-errors').textContent = s.counts.error || 0;
    document.getElementById('stat-warnings').textContent = s.counts.warning || 0;
    document.getElementById('stat-notices').textContent = s.counts.notice || 0;

    const badges = document.getElementById('site-badges');
    badges.innerHTML = '';
    badges.appendChild(badge('robots.txt ' + (s.robotsTxtFound ? 'found' : 'missing'), s.robotsTxtFound));
    badges.appendChild(badge('sitemap.xml ' + (s.sitemapFound ? 'found' : 'missing'), s.sitemapFound));
    badges.appendChild(badge(`${s.brokenPages} broken page(s)`, s.brokenPages === 0));
    badges.appendChild(badge(`${s.externalLinksChecked} external link(s) checked`, true));
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

    renderCoreWebVitals(s.coreWebVitals);

    const tbody = document.getElementById('issues-tbody');
    tbody.innerHTML = '';
    const template = document.getElementById('issue-row-template');
    for (const iss of s.topIssues) {
      const frag = template.content.cloneNode(true);
      const rows = frag.querySelectorAll('tr');
      const mainRow = rows[0];
      const detailRow = rows[1];
      mainRow.querySelector('.status-dot').classList.add(iss.severity);
      mainRow.querySelector('.issue-message').textContent = iss.sampleMessage;
      mainRow.querySelector('.issue-count').textContent = iss.count;
      mainRow.addEventListener('click', () => {
        detailRow.hidden = !detailRow.hidden;
        mainRow.querySelector('.issue-toggle').textContent = detailRow.hidden ? '▾' : '▴';
      });
      if (iss.urls && iss.urls.length) {
        const wrap = detailRow.querySelector('.issue-urls');
        for (const u of iss.urls) {
          const a = document.createElement('a');
          a.href = u; a.textContent = u; a.target = '_blank'; a.rel = 'noopener';
          wrap.appendChild(a);
        }
      } else {
        detailRow.querySelector('.issue-urls').textContent = 'Site-wide issue.';
      }
      tbody.appendChild(mainRow);
      tbody.appendChild(detailRow);
    }

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
    for (const p of job.pages) {
      const tr = document.createElement('tr');
      const isBlocked = p.meta.blockedByRobots;
      const statusClass = isBlocked ? 'warn' : p.meta.status === 0 ? 'err' : p.meta.status >= 400 ? 'err' : p.meta.status >= 300 ? 'warn' : 'ok';
      const statusLabel = isBlocked ? 'BLOCKED' : (p.meta.status || 'ERR');
      const errCount = p.issues.filter((i) => i.severity === 'error').length;
      const warnCount = p.issues.filter((i) => i.severity === 'warning').length;
      const noticeCount = p.issues.filter((i) => i.severity === 'notice').length;
      const titleCell = isBlocked
        ? '<span style="color:var(--text-muted)">disallowed by robots.txt</span>'
        : (p.meta.title ? escapeHtml(p.meta.title) : '<span style="color:var(--text-muted)">missing</span>');
      const pageScore = scoreByUrl.get(p.meta.finalUrl);
      tr.innerHTML = `
        <td><a href="${p.meta.finalUrl}" target="_blank" rel="noopener">${p.meta.finalUrl}</a></td>
        <td><span class="pill ${statusClass}">${statusLabel}</span></td>
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

    // Google Index & Rank tab
    renderIndexing(s.indexing);
    document.getElementById('rank-content').innerHTML = '';
    document.getElementById('rank-keywords').value = '';

    results.hidden = false;
  }

  // ---------- Download report (real browser print-to-PDF of the live DOM) ----------
  downloadBtn.addEventListener('click', () => {
    const panels = document.querySelectorAll('.tab-panel');
    const previouslyHidden = [...panels].map((p) => p.hidden);
    panels.forEach((p) => (p.hidden = false));
    window.print();
    // Restore whichever tab was active before printing.
    panels.forEach((p, i) => (p.hidden = previouslyHidden[i]));
  });

  // ---------- Poll job ----------
  async function poll(jobId) {
    try {
      const res = await fetch(`/api/audit/${jobId}`);
      if (!res.ok) throw new Error('Job not found');
      const job = await res.json();

      setProgress(job.crawled, job.total, job.currentUrl);

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

  function showError(msg) {
    formError.textContent = msg;
    formError.hidden = false;
  }

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
      const res = await fetch('/api/audit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url, maxPages, checkExternalLinks, renderJs }),
      });
      const data = await res.json();
      if (!res.ok) {
        submitBtn.disabled = false;
        showError(data.error || 'Could not start audit.');
        return;
      }
      progressPanel.hidden = false;
      setProgress(0, 1, url);
      pollTimer = setInterval(() => poll(data.id), 1200);
    } catch (err) {
      submitBtn.disabled = false;
      showError('Could not reach the server.');
    }
  });

  initTabs();
})();
