// Jarvis weekly report: PageSpeed + Playwright smoke test + visual regression
// + security headers -> two AI-written reports (technical + client-friendly)
// -> stored in Vercel Blob -> emailed -> indexed for the dashboard.
//
// Run by .github/workflows/weekly-report.yml, once a week.
//
// Requires these GitHub Actions secrets in addition to the existing ones:
//   BLOB_READ_WRITE_TOKEN  - from Vercel Storage > your Blob store > .env.local tab
//   PAGESPEED_API_KEY      - optional; works without one at a lower rate limit

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { put, list, del } = require('@vercel/blob');
const { PNG } = require('pngjs');
const pixelmatch = require('pixelmatch');
const Groq = require('groq-sdk');
const { Resend } = require('resend');

const SITES_PATH = path.join(__dirname, '..', 'sites.json');
const REPORTS_INDEX_PATH = path.join(__dirname, '..', 'dashboard', 'reports-index.json');
const MAX_REPORTS_PER_SITE = 12; // roughly a quarter's worth at weekly cadence
const MAX_AGE_DAYS = 95;

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
const resend = new Resend(process.env.RESEND_API_KEY);
const NOTIFY_EMAIL = process.env.NOTIFY_EMAIL;

function slugify(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

function loadJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

// ---------- PageSpeed Insights: perf, accessibility, SEO, best practices in one call ----------
async function runPageSpeed(url) {
  const key = process.env.PAGESPEED_API_KEY;
  const categories = ['performance', 'accessibility', 'seo', 'best-practices']
    .map((c) => `category=${c}`).join('&');
  const keyParam = key ? `&key=${key}` : '';
  const apiUrl = `https://www.googleapis.com/pagespeedonline/v5/runPagespeed?url=${encodeURIComponent(url)}&strategy=mobile&${categories}${keyParam}`;

  const res = await fetch(apiUrl, { signal: AbortSignal.timeout(45_000) });
  if (!res.ok) throw new Error(`PageSpeed API returned ${res.status}`);
  const data = await res.json();
  const cats = data.lighthouseResult?.categories || {};
  const audits = data.lighthouseResult?.audits || {};
  const pct = (c) => (cats[c]?.score != null ? Math.round(cats[c].score * 100) : null);

  return {
    performance: pct('performance'),
    accessibility: pct('accessibility'),
    seo: pct('seo'),
    bestPractices: pct('best-practices'),
    lcpMs: audits['largest-contentful-paint']?.numericValue ?? null,
    clsScore: audits['cumulative-layout-shift']?.numericValue ?? null,
    tbtMs: audits['total-blocking-time']?.numericValue ?? null,
  };
}

// ---------- Security headers ----------
async function checkSecurityHeaders(url) {
  const expected = [
    'strict-transport-security',
    'x-content-type-options',
    'x-frame-options',
    'content-security-policy',
    'referrer-policy',
  ];
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  const present = expected.filter((h) => res.headers.get(h));
  const missing = expected.filter((h) => !res.headers.get(h));
  return { present, missing };
}

// ---------- Playwright: smoke test + screenshot for visual regression ----------
async function runSmokeTest(url) {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const consoleErrors = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });

  let loaded = false;
  let title = '';
  let brokenLinks = [];
  let screenshot = null;

  try {
    const response = await page.goto(url, { waitUntil: 'networkidle', timeout: 25_000 });
    loaded = Boolean(response && response.ok());
    title = await page.title();

    const links = await page.$$eval('a[href^="http"]', (as) =>
      [...new Set(as.map((a) => a.href))].slice(0, 8)
    );
    for (const link of links) {
      try {
        const r = await fetch(link, { method: 'HEAD', signal: AbortSignal.timeout(6_000) });
        if (!r.ok) brokenLinks.push({ link, status: r.status });
      } catch {
        brokenLinks.push({ link, status: 'unreachable' });
      }
    }

    screenshot = await page.screenshot({ fullPage: true });
  } finally {
    await browser.close();
  }

  return { loaded, title, consoleErrors, brokenLinks, screenshot };
}

// ---------- Visual regression against last week's screenshot ----------
async function compareScreenshot(slug, newScreenshotBuffer) {
  let previousUrl = null;
  try {
    const { blobs } = await list({ prefix: `reports/${slug}/baseline` });
    if (blobs.length > 0) previousUrl = blobs[0].url;
  } catch {
    // no baseline yet, that's fine
  }

  let diffPercent = null;
  let note = 'No previous baseline — this screenshot becomes the new baseline.';

  if (previousUrl) {
    try {
      const prevRes = await fetch(previousUrl);
      const prevBuffer = Buffer.from(await prevRes.arrayBuffer());
      const prevPng = PNG.sync.read(prevBuffer);
      const newPng = PNG.sync.read(newScreenshotBuffer);

      if (prevPng.width === newPng.width && prevPng.height === newPng.height) {
        const diff = new PNG({ width: prevPng.width, height: prevPng.height });
        const diffPixels = pixelmatch(
          prevPng.data, newPng.data, diff.data, prevPng.width, prevPng.height, { threshold: 0.1 }
        );
        diffPercent = Math.round((diffPixels / (prevPng.width * prevPng.height)) * 1000) / 10;
        note = `${diffPercent}% of pixels changed since last week.`;
      } else {
        note = 'Page dimensions changed since last week — skipping pixel comparison, new baseline stored.';
      }
    } catch (err) {
      note = `Could not compare to previous baseline: ${err.message}`;
    }
  }

  // New screenshot becomes this week's baseline for next week's comparison.
  await put(`reports/${slug}/baseline.png`, newScreenshotBuffer, {
    access: 'public',
    contentType: 'image/png',
    addRandomSuffix: false,
    allowOverwrite: true,
  });

  return { diffPercent, note };
}

// ---------- AI-written reports ----------
async function writeReport({ site, pageUrl, pageSpeed, headers, smoke, visual }) {
  const findingsText = `
Site: ${site.name} (${pageUrl})

PageSpeed (mobile):
- Performance: ${pageSpeed?.performance ?? 'unavailable'}
- Accessibility: ${pageSpeed?.accessibility ?? 'unavailable'}
- SEO: ${pageSpeed?.seo ?? 'unavailable'}
- Best Practices: ${pageSpeed?.bestPractices ?? 'unavailable'}
- Largest Contentful Paint: ${pageSpeed?.lcpMs ? Math.round(pageSpeed.lcpMs) + 'ms' : 'unavailable'}
- Cumulative Layout Shift: ${pageSpeed?.clsScore ?? 'unavailable'}

Security headers present: ${headers.present.join(', ') || 'none'}
Security headers missing: ${headers.missing.join(', ') || 'none'}

Smoke test:
- Page loaded: ${smoke.loaded}
- Console errors: ${smoke.consoleErrors.length} ${smoke.consoleErrors.slice(0, 3).join(' | ')}
- Broken links checked: ${smoke.brokenLinks.length} found broken

Visual regression: ${visual.note}
`.trim();

  const [technical, client] = await Promise.all([
    groq.chat.completions.create({
      model: 'openai/gpt-oss-120b',
      messages: [{
        role: 'user',
        content: `Write a technical weekly site health report in markdown from these raw findings. Be direct, use headers, call out anything that needs action. Don't pad with disclaimers.\n\n${findingsText}`,
      }],
      max_tokens: 700,
    }),
    groq.chat.completions.create({
      model: 'openai/gpt-oss-120b',
      messages: [{
        role: 'user',
        content: `Write a short, friendly, non-technical weekly summary for a client who owns this website, from these raw findings. No jargon, no scores as raw numbers without context, 3 short paragraphs max. If everything looks fine, say so plainly and briefly.\n\n${findingsText}`,
      }],
      max_tokens: 650,
    }),
  ]);

  return {
    technicalMd: technical.choices[0].message.content,
    clientMd: client.choices[0].message.content,
    raw: { pageSpeed, headers, smoke: { ...smoke, screenshot: undefined }, visual },
  };
}

// ---------- Storage + index ----------
async function storeReport(slug, report, screenshotBuffer) {
  const timestamp = new Date().toISOString();
  const base = `reports/${slug}/${timestamp}`;

  const [technical, client, raw] = await Promise.all([
    put(`${base}/technical.md`, report.technicalMd, { access: 'public', contentType: 'text/markdown', addRandomSuffix: false }),
    put(`${base}/client.md`, report.clientMd, { access: 'public', contentType: 'text/markdown', addRandomSuffix: false }),
    put(`${base}/raw.json`, JSON.stringify(report.raw, null, 2), { access: 'public', contentType: 'application/json', addRandomSuffix: false }),
  ]);

  return { timestamp, technicalUrl: technical.url, clientUrl: client.url, rawUrl: raw.url };
}

async function pruneOldReports(slug) {
  try {
    const { blobs } = await list({ prefix: `reports/${slug}/20` }); // dated report folders start with a year
    const cutoff = Date.now() - MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
    const stale = blobs.filter((b) => new Date(b.uploadedAt).getTime() < cutoff);
    if (stale.length > 0) {
      await del(stale.map((b) => b.url));
    }
  } catch (err) {
    console.error(`  prune failed for ${slug}:`, err.message);
  }
}

function updateReportsIndex(site, entry) {
  const index = loadJson(REPORTS_INDEX_PATH, {});
  const list = index[site.name] || [];
  list.push(entry);
  index[site.name] = list.slice(-MAX_REPORTS_PER_SITE);
  fs.writeFileSync(REPORTS_INDEX_PATH, JSON.stringify(index, null, 2));
}

async function emailReport(site, entry, report) {
  const scoreLine = report.raw.pageSpeed
    ? `Performance ${report.raw.pageSpeed.performance ?? '—'} · Accessibility ${report.raw.pageSpeed.accessibility ?? '—'} · SEO ${report.raw.pageSpeed.seo ?? '—'} · Best Practices ${report.raw.pageSpeed.bestPractices ?? '—'}`
    : 'PageSpeed check unavailable this run';

  await resend.emails.send({
    from: 'onboarding@resend.dev',
    to: NOTIFY_EMAIL,
    subject: `📋 Weekly report: ${site.name}`,
    html: `
      <p><strong>${site.name}</strong> weekly report is ready.</p>
      <p>${scoreLine}</p>
      <p>${report.clientMd.replace(/\n/g, '<br/>')}</p>
      <hr/>
      <p><a href="${entry.technicalUrl}">Full technical report</a> · <a href="${entry.rawUrl}">Raw data</a></p>
    `,
  });
}

async function runForSite(site) {
  const slug = slugify(site.name);
  const pageUrl = site.pageUrl || site.url; // full-page checks need a real page, not a health-check endpoint
  console.log(`[${site.name}] starting weekly report... (checking ${pageUrl})`);

  const [pageSpeed, headers, smoke] = await Promise.all([
    runPageSpeed(pageUrl).catch((err) => {
      console.error(`  PageSpeed failed: ${err.message}`);
      return null;
    }),
    checkSecurityHeaders(pageUrl).catch((err) => {
      console.error(`  Header check failed: ${err.message}`);
      return { present: [], missing: [] };
    }),
    runSmokeTest(pageUrl).catch((err) => {
      console.error(`  Smoke test failed: ${err.message}`);
      return { loaded: false, title: '', consoleErrors: [], brokenLinks: [], screenshot: null };
    }),
  ]);

  const visual = smoke.screenshot
    ? await compareScreenshot(slug, smoke.screenshot).catch((err) => ({ diffPercent: null, note: `Visual check failed: ${err.message}` }))
    : { diffPercent: null, note: 'No screenshot captured — smoke test did not complete.' };

  const report = await writeReport({ site, pageUrl, pageSpeed, headers, smoke, visual });
  const entry = await storeReport(slug, report, smoke.screenshot);
  updateReportsIndex(site, entry);
  await pruneOldReports(slug);
  await emailReport(site, entry, report);

  console.log(`  -> report stored and emailed. Technical: ${entry.technicalUrl}`);
}

async function main() {
  const sites = loadJson(SITES_PATH, []);
  for (const site of sites) {
    try {
      await runForSite(site);
    } catch (err) {
      console.error(`[${site.name}] weekly report failed entirely:`, err.message);
    }
  }
}

main().catch((err) => {
  console.error('Fatal error in weekly report script:', err);
  process.exit(1);
});