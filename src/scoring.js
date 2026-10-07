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

/**
 * Plain-English layer.
 *
 * Every finding also carries a version written for the business owner rather
 * than their developer: what it means, why it costs them something, and who
 * fixes it. "32 render-blocking scripts in <head>" tells a roofing contractor
 * nothing; "your pages load slowly on phones" tells them whether to care.
 *
 * The technical message is never replaced - it stays on the finding for anyone
 * who wants it. Findings with no entry here simply have no plain version, and
 * the dashboard falls back to the technical wording rather than inventing one.
 */
const PLAIN_ENGLISH = {
  // --- Found by search engines ---
  'missing-title': { title: 'A page has no headline in Google', why: 'The title is the blue link people click in search results. Without one, Google invents something from the page, which is rarely what you would choose.', fix: 'Add a page title describing the page in about 60 characters.' },
  'title-too-long': { title: 'A page title gets cut off in Google', why: 'Longer titles are truncated mid-sentence in search results, so the end of your message never gets read.', fix: 'Shorten the title to roughly 60 characters.' },
  'title-too-short': { title: 'A page title is very short', why: 'Short titles waste space you could use to say what you do and where you do it.', fix: 'Expand the title to describe the service and the area you serve.' },
  'multiple-title': { title: 'A page has more than one title', why: 'Search engines pick one and ignore the rest, so you do not control which is shown.', fix: 'Keep a single title tag per page.' },
  'duplicate-title': { title: 'Several pages share the same title', why: 'Google struggles to tell these pages apart and may show the wrong one, or none of them.', fix: 'Give each page its own title describing that specific page.' },
  'missing-meta-description': { title: 'A page has no description in Google', why: 'The description is the grey summary under your link. Without one, Google pulls a random sentence from the page, which often reads badly.', fix: 'Write a 150-character summary that gives someone a reason to click.' },
  'meta-description-short': { title: 'A search description is very short', why: 'You have about 150 characters of free advertising under your link and are not using it.', fix: 'Expand the description to around 150 characters.' },
  'meta-description-long': { title: 'A search description gets cut off', why: 'Anything past roughly 160 characters is replaced with an ellipsis, so your closing line never appears.', fix: 'Trim the description to about 155 characters.' },
  'duplicate-meta-description': { title: 'Several pages share one description', why: 'Identical summaries make your pages look interchangeable in search results.', fix: 'Write a distinct description for each page.' },
  'noindex': { title: 'A page is hidden from Google', why: 'This page carries an instruction telling search engines not to list it. If that was not deliberate, the page cannot be found at all.', fix: 'Remove the noindex tag unless the page is meant to be private.' },
  'noindex-header': { title: 'A page is hidden from Google by the server', why: 'The server sends an instruction telling search engines not to list this page, so it will never appear in results.', fix: 'Ask your developer to remove the X-Robots-Tag noindex header.' },
  'missing-canonical': { title: 'A page does not say which address is the real one', why: 'The same page can often be reached by several web addresses. Without a canonical tag, Google may treat them as duplicates and split your ranking between them.', fix: 'Add a canonical tag pointing at the preferred address.' },
  'missing-sitemap': { title: 'No sitemap for search engines', why: 'A sitemap is the index that tells Google every page you have. Without one, newer pages can take much longer to be found.', fix: 'Generate a sitemap.xml - most website platforms do this automatically.' },
  'missing-robots-txt': { title: 'No robots.txt file', why: 'This small file tells search engines how to crawl the site and where the sitemap is. Its absence is not fatal but it is a missed signal.', fix: 'Add a robots.txt at the site root with a Sitemap: line.' },

  // --- Content ---
  'missing-h1': { title: 'A page has no main heading', why: 'The main heading tells both visitors and Google what the page is about in one line. Without it, the page reads as unstructured.', fix: 'Add one clear H1 heading at the top of the page.' },
  'multiple-h1': { title: 'A page has several main headings', why: 'More than one top-level heading muddies what the page is actually about.', fix: 'Keep one H1 and demote the others to H2.' },
  'thin-content': { title: 'A page has very little text', why: 'Pages with little content rarely rank, and give visitors little reason to stay or call.', fix: 'Expand the page to properly answer what a customer would want to know.' },
  'low-text-ratio': { title: 'A page is mostly code, not words', why: 'There is far more markup than readable text, which slows the page and gives search engines little to work with.', fix: 'Add more written content, or ask your developer to trim unused code.' },
  'heading-hierarchy': { title: 'Headings skip levels', why: 'Jumping from a main heading straight to a small one makes the page structure harder for Google and screen readers to follow.', fix: 'Use headings in order - H2 under H1, H3 under H2.' },
  'no-h2': { title: 'A long page has no subheadings', why: 'Walls of text without subheadings are skimmed and abandoned, especially on phones.', fix: 'Break the page up with descriptive subheadings.' },
  'keyword-stuffing': { title: 'One phrase is repeated very often', why: 'Heavy repetition reads awkwardly to customers and can look manipulative to Google.', fix: 'Use natural variations instead of repeating the same phrase.' },
  'duplicate-content': { title: 'Several pages have near-identical text', why: 'Google picks one and largely ignores the others, so the work put into those pages is wasted.', fix: 'Rewrite them to cover genuinely different topics, or merge them.' },
  'duplicate-h1': { title: 'Several pages share the same main heading', why: 'Identical headings make distinct services look like the same page.', fix: 'Give each page a heading specific to its own subject.' },

  // --- Images ---
  'images-missing-alt': { title: 'Some images have no description', why: 'Alt text is what screen readers announce and what Google uses to understand a picture. Without it, your photos are invisible to both.', fix: 'Describe each image in a few words - "crew replacing asphalt shingle roof".' },
  'images-missing-dimensions': { title: 'Images make the page jump while loading', why: 'Without a declared size, the layout shifts as photos load, and people tap the wrong thing.', fix: 'Set width and height on image tags.' },
  'images-no-lazy': { title: 'All images load at once', why: 'Photos far down the page download immediately, slowing the first view on mobile data.', fix: 'Add lazy loading so images load as they are scrolled to.' },
  'images-not-modern': { title: 'Photos use older, heavier formats', why: 'Modern formats like WebP are often half the size for the same quality, which matters most on phones.', fix: 'Convert large photos to WebP or AVIF.' },

  // --- Speed ---
  'render-blocking': { title: 'Pages load slowly on phones', why: 'Several files must finish downloading before anything appears on screen. Visitors on mobile data may leave before seeing your page.', fix: 'Ask your developer to defer non-essential scripts and styles.' },
  'render-blocking-some': { title: 'Some files delay the first view', why: 'A few scripts or stylesheets hold up the first paint of the page.', fix: 'Defer or inline the ones that are not needed immediately.' },
  'uncompressed-html': { title: 'Pages are sent uncompressed', why: 'Compression typically cuts page size by about 70% for free. Without it every visitor downloads far more than they need.', fix: 'Enable gzip or brotli on the server - usually a one-line change.' },
  'html-large': { title: 'A page is unusually heavy', why: 'Large pages are slow on phones and cost visitors their mobile data.', fix: 'Trim unused code and compress images.' },
  'html-too-large': { title: 'A page is very heavy', why: 'Pages this size are slow even on good connections, and slow pages lose calls.', fix: 'Ask your developer to reduce the page size.' },
  'too-many-assets': { title: 'A page loads a lot of separate files', why: 'Each file is its own round trip to the server, and they add up on a phone.', fix: 'Combine or remove scripts and stylesheets that are not needed.' },
  'dom-too-large': { title: 'A page is very complex to render', why: 'Very large pages make older phones sluggish to scroll and tap.', fix: 'Simplify the page structure or split it in two.' },
  'slow-response': { title: 'The server is slow to respond', why: 'Visitors wait before anything starts loading, and Google counts this against you.', fix: 'Ask your host about server response time, or consider better hosting.' },
  'moderate-response': { title: 'The server responds sluggishly', why: 'Not critical, but a faster server makes every page feel quicker.', fix: 'Worth raising with your host if it gets worse.' },

  // --- Links ---
  'not-found': { title: 'A page is broken', why: 'Visitors who follow this link hit a dead end, and search engines drop it from your site.', fix: 'Fix the link or redirect it to the right page.' },
  'broken-external-links': { title: 'Links to other sites are broken', why: 'Dead outbound links look neglected and send visitors nowhere.', fix: 'Update or remove the broken links.' },
  'redirect-chain': { title: 'Some links bounce through several hops', why: 'Each hop adds delay and loses a little ranking strength.', fix: 'Point links at the final address directly.' },
  'redirect-loop': { title: 'A page redirects in a circle', why: 'This page can never load - visitors see an error.', fix: 'Fix the redirect rule causing the loop.' },
  'too-many-links': { title: 'A page has a very large number of links', why: 'Attention and ranking strength are spread thin across too many destinations.', fix: 'Reduce the links to the ones that matter.' },
  'empty-anchor-text': { title: 'Some links have no words', why: 'A link with no text tells nobody - visitor or search engine - where it goes.', fix: 'Give every link descriptive wording.' },
  'generic-anchor-text': { title: 'Links say "click here"', why: 'Vague wording wastes a chance to tell Google what the linked page is about.', fix: 'Use descriptive text like "see our roof repair prices".' },
  'orphan-pages': { title: 'Some pages have no links to them', why: 'Pages nothing links to are hard for visitors and search engines to find, however good they are.', fix: 'Link to them from a relevant page or the main menu.' },
  'deep-pages': { title: 'Some pages are buried deep', why: 'Pages more than three clicks from the home page get less traffic and are crawled less often.', fix: 'Move important pages closer to the main navigation.' },
  'http-links-on-https': { title: 'Secure pages link to insecure ones', why: 'Mixing secure and insecure links can trigger browser warnings.', fix: 'Update those links to https://.' },

  // --- Trust and security ---
  'not-https': { title: 'The site is not secure', why: 'Browsers show a "Not secure" warning on sites without HTTPS, which costs enquiries from anyone who notices.', fix: 'Install an SSL certificate - most hosts provide one free.' },
  'mixed-content': { title: 'A secure page loads insecure files', why: 'This breaks the padlock in the address bar and can make the page look unsafe.', fix: 'Load all images and scripts over https://.' },
  'missing-hsts': { title: 'Browsers are not told to stay secure', why: 'A visitor’s first request can still go over an insecure connection before being redirected.', fix: 'Ask your developer to add a Strict-Transport-Security header.' },
  'x-powered-by': { title: 'The server announces its software version', why: 'Publishing exact version numbers makes it easier for attackers to target known weaknesses.', fix: 'Ask your developer to remove the X-Powered-By header.' },
  'server-signature': { title: 'The server announces its software', why: 'Minor, but there is no reason to advertise what you run.', fix: 'Ask your host to suppress the server signature.' },
  'missing-x-content-type-options': { title: 'A browser protection header is missing', why: 'A standard safeguard against certain file-type attacks is not switched on.', fix: 'Add the X-Content-Type-Options: nosniff header.' },
  'missing-x-frame-options': { title: 'The site can be embedded by others', why: 'Without this, another site can frame your pages and trick visitors into clicking things.', fix: 'Add X-Frame-Options or a frame-ancestors policy.' },
  'missing-csp': { title: 'No content security policy', why: 'An extra layer of protection against injected scripts is not configured.', fix: 'Worth adding, though lower priority than the items above.' },
  'unsafe-cross-origin': { title: 'Links that open new tabs are unsafe', why: 'Links opening in a new tab without protection let the destination site interfere with yours.', fix: 'Add rel="noopener" to those links.' },

  // --- Mobile and technical ---
  'missing-viewport': { title: 'The site is not set up for phones', why: 'Without this, phones render the desktop layout shrunk down - text too small to read and buttons too small to tap. Most of your visitors are on phones.', fix: 'Add a viewport meta tag. This is urgent.' },
  'viewport-no-width': { title: 'The mobile layout is misconfigured', why: 'The page may not size itself correctly to the phone screen.', fix: 'Set the viewport to width=device-width.' },
  'missing-lang': { title: 'The page does not state its language', why: 'Screen readers and search engines have to guess what language the content is in.', fix: 'Add lang="en" to the html tag.' },
  'missing-charset': { title: 'The page does not state its text encoding', why: 'Accented characters and symbols can display as nonsense.', fix: 'Add a charset meta tag.' },
  'missing-doctype': { title: 'The page is missing its opening declaration', why: 'Browsers may fall back to a legacy rendering mode and display the page incorrectly.', fix: 'Add <!DOCTYPE html> as the first line.' },
  'missing-structured-data': { title: 'Search engines cannot read your business details', why: 'Structured data is how Google and AI assistants learn your name, address, phone and hours. Without it they have to guess.', fix: 'Add LocalBusiness structured data - most SEO plugins can generate it.' },
  'invalid-structured-data': { title: 'Your business details have an error', why: 'Broken structured data is ignored entirely, so the information never reaches Google.', fix: 'Validate it with Google’s Rich Results Test and fix the error.' },
  'missing-open-graph': { title: 'Links look plain when shared', why: 'Shared on Facebook or WhatsApp, your pages appear without an image or summary and get far fewer clicks.', fix: 'Add Open Graph tags with a title, description and image.' },
  'incomplete-open-graph': { title: 'Shared links are missing some detail', why: 'Part of the preview is there but incomplete, so it looks half-finished.', fix: 'Fill in the missing Open Graph tags.' },
  'iframes': { title: 'A page embeds content from elsewhere', why: 'Embedded content is not read as part of your page, so any words inside it do not help you rank.', fix: 'Fine for maps and video - just do not put important text in one.' },
  'inline-styles': { title: 'Styling is written into the page itself', why: 'Makes pages heavier and harder to maintain consistently.', fix: 'Move styling into a stylesheet.' },
  'deprecated-html': { title: 'The page uses outdated code', why: 'Old tags may stop working in future browsers.', fix: 'Ask your developer to update them.' },
  'plaintext-emails': { title: 'Email addresses are exposed', why: 'Addresses written plainly get harvested by spam bots.', fix: 'Use a contact form, or obfuscate the address.' },
  'underscore-urls': { title: 'Some addresses use underscores', why: 'Google reads hyphens as word separators but not underscores, so the words run together.', fix: 'Use hyphens in new addresses - do not rename existing ones without redirects.' },
  'url-underscore': { title: 'An address uses underscores', why: 'Google reads hyphens as word separators but not underscores.', fix: 'Prefer hyphens for new pages.' },
  'uppercase-urls': { title: 'Some addresses mix capitals', why: 'Web addresses are case-sensitive, so capitals cause duplicates and broken links.', fix: 'Use lowercase addresses.' },
  'long-urls': { title: 'Some addresses are very long', why: 'Long addresses are awkward to share and get truncated in search results.', fix: 'Keep addresses short and descriptive.' },
  'url-too-long': { title: 'An address is very long', why: 'Hard to share and gets cut off in search results.', fix: 'Shorten it where practical.' },
  'param-heavy-urls': { title: 'Some addresses carry many parameters', why: 'Parameter-heavy addresses can create duplicate versions of the same page.', fix: 'Use clean addresses where possible.' },
  'no-analytics': { title: 'No website analytics detected', why: 'Without analytics you cannot tell how many people visit, or which pages bring enquiries.', fix: 'Install Google Analytics or similar.' },
  'partial-sitemap-coverage': { title: 'Only part of the site was checked', why: 'This audit looked at a sample of pages. Findings apply to those pages, not the whole site.', fix: 'Not a problem - run a deeper crawl for full coverage.' },

  // --- Site-wide checks (ids arrive prefixed "site:") ---
  'https-redirect': { title: 'The site does not force a secure connection', why: 'Someone typing your address without "https" stays on an unencrypted page. Browsers label those "Not secure", and Google prefers secure sites.', fix: 'Redirect all http:// traffic to https:// at the server or host.' },
  'tls-cert': { title: 'A problem with the security certificate', why: 'This is what turns the padlock on. An expired or mismatched certificate shows visitors a full-page warning before they ever see your site.', fix: 'Renew or reissue the certificate - most hosts do this free and automatically.' },
  'www-resolve': { title: 'Only one of www and non-www works', why: 'Anyone who types the other version gets an error. Old links, printed material and directory listings use whichever form they were given.', fix: 'Point both at the site and redirect one to the other.' },
  'start-redirect-chain': { title: 'Your address redirects more than once', why: 'Each hop costs time before anything appears, and some of the ranking value of links passes through each one.', fix: 'Redirect straight to the final address in a single step.' },
  'compression': { title: 'Pages are sent uncompressed', why: 'Compression typically cuts page weight by two thirds. Without it every visitor downloads several times more than they need, which is most noticeable on phones.', fix: 'Switch on gzip or brotli - usually one setting on the host.' },
  'response-time': { title: 'The server is slow to answer', why: 'Nothing can appear on screen until the server responds. This delay is added to every single page view.', fix: 'Ask your host about server response time, or add caching.' },
  'http2': { title: 'The site uses an older connection protocol', why: 'HTTP/2 loads many files at once instead of queueing them. On the older protocol a page with lots of images and scripts is noticeably slower.', fix: 'Enable HTTP/2 - most hosts and CDNs offer it as a switch.' },
  'html-size': { title: 'The page code is unusually large', why: 'A heavy page costs mobile visitors time and data before any of your content appears.', fix: 'Remove unused page builder sections, plugins and inline code.' },
  'security-headers': { title: 'Protective headers are missing', why: 'These are instructions to the browser that block common attacks on your visitors. They are not required, but they are free.', fix: 'Ask your developer to add the standard security headers.' },
  'hsts': { title: 'Browsers are not told to always use HTTPS', why: 'On a first visit a browser can still be pushed to the unencrypted version of your site before the redirect happens.', fix: 'Add a Strict-Transport-Security header.' },
  'spf': { title: 'No SPF record for your email', why: 'SPF lists who may send email as your domain. Without it, anyone can forge email from your address, and your own email is more likely to land in spam.', fix: 'Add an SPF record in your DNS settings - your email provider publishes the exact line.' },
  'dmarc': { title: 'No DMARC policy for your email', why: 'DMARC tells other mail servers what to do with email that fails your checks. Without it, impersonation of your domain goes unreported.', fix: 'Add a DMARC record in your DNS settings, starting with a monitoring-only policy.' },
  'dns': { title: 'Your domain settings could not be read', why: 'This check could not confirm where your domain points. That may be a restriction on the checking server rather than a fault with your site.', fix: 'Nothing to do unless your site is also unreachable for visitors.' },
  'nameservers': { title: 'Which service controls your domain', why: 'Informational: this is where your DNS records live, which is useful to know before anyone changes them.', fix: 'No action needed.' },
  'ipv6': { title: 'The site is not reachable over the newer internet protocol', why: 'Some mobile networks are IPv6-only and reach such sites through a translation layer, which adds a little delay. It is a minor point, not a fault.', fix: 'Optional - ask your host whether IPv6 is available.' },
  'favicon': { title: 'No site icon', why: 'The small icon in the browser tab and in bookmarks. Without one your site shows a blank page symbol, which looks unfinished.', fix: 'Add a favicon - any square logo image will do.' },
  'custom-404': { title: 'No proper page for broken links', why: 'When someone follows an old or mistyped link they should land on a page that offers a way back. A bare error page usually loses the visitor.', fix: 'Create a custom 404 page with your menu and a link home.' },
  'robots-txt': { title: 'A problem with your robots.txt file', why: 'This file tells search engines how to crawl the site. A mistake in it can quietly hide pages from Google.', fix: 'Review the file at yoursite.com/robots.txt and remove anything you did not intend.' },
  'robots-sitemap-directive': { title: 'Your robots.txt does not point at the sitemap', why: 'One line in robots.txt saves search engines guessing where your sitemap is. Small, free, and takes a minute.', fix: 'Add a line reading Sitemap: followed by your sitemap address.' },
  'sitemap': { title: 'A problem with your sitemap', why: 'The sitemap is the index that tells Google every page you have. Without a usable one, newer pages take longer to be found.', fix: 'Generate a sitemap.xml - most website platforms do this automatically.' },
  'sitemap-format': { title: 'Your sitemap cannot be read', why: 'The file exists but contains errors, so search engines skip it. You get none of the benefit of having one.', fix: 'Regenerate the sitemap with your platform or SEO plugin.' },
  'server-software': { title: 'Which web server you run', why: 'Informational: useful context for whoever maintains the site.', fix: 'No action needed.' },
  // --- AI assistants ---
  'ai-chatgpt': { title: 'ChatGPT cannot read your website', why: 'Your robots.txt tells OpenAI’s crawler to stay out, so ChatGPT cannot describe or recommend your business when someone asks.', fix: 'Remove the Disallow rule for GPTBot in robots.txt.' },
  'ai-claude': { title: 'Claude cannot read your website', why: 'Your robots.txt blocks Anthropic’s crawler, so Claude cannot reference your business.', fix: 'Remove the Disallow rule for ClaudeBot in robots.txt.' },
  'ai-gemini': { title: 'Google Gemini cannot use your content', why: 'Google-Extended is blocked, which keeps your content out of Gemini answers and AI Overviews.', fix: 'Remove the Disallow rule for Google-Extended in robots.txt.' },
  'ai-perplexity': { title: 'Perplexity cannot read your website', why: 'Perplexity’s crawler is blocked, so it cannot cite you as a source.', fix: 'Remove the Disallow rule for PerplexityBot in robots.txt.' },
  'ai-grok': { title: 'Grok cannot read your website', why: 'A crawler associated with xAI is blocked in robots.txt.', fix: 'Remove that Disallow rule if you want Grok to see the site.' },
  'ai-commoncrawl': { title: 'Common Crawl cannot read your website', why: 'Common Crawl is a public dataset that many AI models learn from. Blocking it keeps you out of several assistants at once.', fix: 'Remove the Disallow rule for CCBot in robots.txt.' },
};

/** The plain-English version of a finding, or null if none is written. */
function plainEnglishFor(id) {
  if (PLAIN_ENGLISH[id]) return PLAIN_ENGLISH[id];
  // Site-wide checks arrive prefixed ("site:compression") because they describe
  // the whole site rather than one page. The wording is the same either way.
  if (typeof id === 'string' && id.startsWith('site:')) {
    return PLAIN_ENGLISH[id.slice(5)] || null;
  }
  return null;
}

/**
 * Orphan pages and crawl coverage, derived here from the raw crawl result.
 *
 * An orphan is a page in the sitemap that nothing links to. Inbound links are
 * only known for pages the crawl actually visited, so a sitemap URL that was
 * never reached tells us nothing - it is unvisited, not orphaned. Comparing a
 * whole sitemap against a capped crawl produces a false positive for every
 * page beyond the limit: a 157-URL sitemap crawled at 10 pages reported 147
 * "orphans", and the count grew as the crawl got smaller, which is backwards.
 */
function analyzeOrphansAndCoverage(crawlResult) {
  const sitemapUrls = (crawlResult.sitemap && crawlResult.sitemap.urls) || [];
  const inbound = crawlResult.inboundLinkCount || {};
  const startUrl = crawlResult.startUrl;

  const crawled = new Set();
  for (const page of crawlResult.pages || []) {
    if (page.url) crawled.add(page.url);
    if (page.finalUrl) crawled.add(page.finalUrl);
  }

  const orphanPages = sitemapUrls.filter(
    (u) => u !== startUrl && crawled.has(u) && !(u in inbound)
  );
  const sitemapUrlsCrawled = sitemapUrls.filter((u) => crawled.has(u)).length;

  return {
    orphanPages,
    coverage: {
      sitemapUrls: sitemapUrls.length,
      sitemapUrlsCrawled,
      fullyCrawled: sitemapUrls.length > 0 && sitemapUrlsCrawled === sitemapUrls.length,
    },
  };
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

  const { orphanPages, coverage: crawlCoverage } = analyzeOrphansAndCoverage(crawlResult);
  if (orphanPages.length > 0) {
    const n = orphanPages.length;
    siteIssues.push({ id: 'orphan-pages', severity: 'notice', category: 'crawl', message: `${n} crawled ${n === 1 ? 'page is' : 'pages are'} in the sitemap but ${n === 1 ? 'has' : 'have'} no internal links pointing to ${n === 1 ? 'it' : 'them'}.`, affected: n, urls: orphanPages });
  }

  // State the limits of the crawl rather than letting the reader assume the
  // whole sitemap was assessed.
  if (crawlCoverage.sitemapUrls > 0 && !crawlCoverage.fullyCrawled) {
    const unchecked = crawlCoverage.sitemapUrls - crawlCoverage.sitemapUrlsCrawled;
    siteIssues.push({ id: 'partial-sitemap-coverage', severity: 'notice', category: 'crawl', message: `This crawl covered ${crawlCoverage.sitemapUrlsCrawled} of the ${crawlCoverage.sitemapUrls} URLs in the sitemap. The remaining ${unchecked} were not visited, so orphan and duplicate findings apply only to the pages that were crawled. Raise "Pages to crawl" to cover more of the site.`, affected: unchecked, urls: [] });
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

  // Page findings are already reflected in each page's own score. Site-level
  // findings (configuration, security headers, crawlability) apply once to the
  // whole site, so they are counted separately and capped.
  let siteLevelPenalty = 0;
  for (const iss of [...siteIssues, ...siteCheckIssues]) siteLevelPenalty += WEIGHTS[iss.severity] || 0;
  const siteDeduction = Math.min(35, siteLevelPenalty);

  const order = { error: 0, warning: 1, notice: 2 };
  const topIssues = [...issueFrequency.values()]
    .sort((a, b) => (order[a.severity] - order[b.severity]) || (b.count - a.count))
    // Attach the owner-facing wording. Findings with no entry keep only
    // their technical message rather than getting an invented one.
    .map((i) => ({ ...i, plain: plainEnglishFor(i.id) }));

  const pagesWithErrors = pageAudits.filter((p) => p.issues.some((i) => i.severity === 'error')).length;
  const brokenPages = pageAudits.filter((p) => !p.meta.blockedByRobots && (p.meta.status >= 400 || p.meta.status === 0)).length;

  const pageScores = pageAudits.map((p) => ({ url: p.meta.finalUrl, status: p.meta.status, score: computePageScore(p.issues), depth: p.depth ?? null }));
  const avgPageScore = pageScores.length ? pageScores.reduce((s, p) => s + p.score, 0) / pageScores.length : 0;
  const brokenLinksTotal =
    (crawlResult.pages || []).filter((p) => !p.blockedByRobots && (p.status >= 400 || p.status === 0)).length +
    (crawlResult.externalLinkResults || []).filter((l) => l.broken).length;
  const { orphanPages: realOrphans, coverage: sitemapCoverage } = analyzeOrphansAndCoverage(crawlResult);
  const orphanCount = realOrphans.length;
  const duplicateCount = duplicateUrls.size;

  // Each deduction is capped on its own and the total is capped again, so one
  // noisy dimension cannot drive the score to zero on a site whose every page
  // scores in the eighties.
  const siteHealthPenalty = Math.min(
    50,
    Math.min(30, brokenLinksTotal * 3) + Math.min(20, duplicateCount * 2) + Math.min(20, orphanCount * 1.5)
  );
  const siteHealthScore = Math.max(0, Math.min(100, Math.round(avgPageScore - siteHealthPenalty)));

  // Headline = page quality minus capped site-wide problems. The previous
  // formula summed every issue across every page and divided by the square
  // root of the page count: the sum grows linearly with pages while the
  // divisor grows as a square root, so a larger crawl always scored worse for
  // identical per-page quality. That produced 53/100 above a page list where
  // every page scored 83-89.
  const score = Math.max(0, Math.min(100, Math.round(avgPageScore - siteDeduction)));

  return {
    score,
    avgPageScore: Math.round(avgPageScore),
    siteDeduction: Math.round(siteDeduction),
    sitemapCoverage,
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
