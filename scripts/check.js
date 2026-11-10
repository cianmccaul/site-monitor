// Jarvis-lite: health check -> AI explanation -> email, only on state changes.
//
// Run by .github/workflows/check.yml every 15 minutes.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Groq = require('groq-sdk');
const { Resend } = require('resend');
const { proposeFix } = require('./proposeFix');

const SITES_PATH = path.join(__dirname, '..', 'sites.json');
const STATE_PATH = path.join(__dirname, '..', 'dashboard', 'status.json');
const INCIDENTS_PATH = path.join(__dirname, '..', 'dashboard', 'incidents.json');
const MAX_INCIDENTS = 50;
const DASHBOARD_URL = 'https://cian-os-five.vercel.app';

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
const resend = new Resend(process.env.RESEND_API_KEY);
const NOTIFY_EMAIL = process.env.NOTIFY_EMAIL;

function loadJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

// Builds a signed, time-limited "approve & merge" link for the alert email.
// Signed with FIX_PR_TOKEN so no extra secret is needed - api/approve.js on
// the dashboard verifies it the same way. Never merges on its own; this is
// just the link that opens the confirmation page.
function buildApproveLink(prUrl) {
  const m = String(prUrl || '').match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
  if (!m || !process.env.FIX_PR_TOKEN) return null;
  const [, owner, repo, prNumber] = m;
  const payload = Buffer.from(JSON.stringify({
    owner, repo, prNumber: Number(prNumber),
    exp: Date.now() + 1000 * 60 * 60 * 24 * 7, // link works for 7 days
  })).toString('base64url');
  const sig = crypto.createHmac('sha256', process.env.FIX_PR_TOKEN).update(payload).digest('hex');
  return `${DASHBOARD_URL}/api/approve?token=${payload}.${sig}`;
}

async function checkSite(site) {
  const startedAt = Date.now();
  try {
    const res = await fetch(site.url, { signal: AbortSignal.timeout(10_000) });
    return {
      up: res.ok,
      statusCode: res.status,
      responseTimeMs: Date.now() - startedAt,
    };
  } catch (err) {
    return {
      up: false,
      statusCode: null,
      responseTimeMs: Date.now() - startedAt,
      error: err.message,
    };
  }
}

async function explainOutage(site, result) {
  const completion = await groq.chat.completions.create({
    model: 'openai/gpt-oss-120b',
    messages: [
      {
        role: 'user',
        content: `A website I run just failed a health check. Here's what we know:

Site: ${site.name} (${site.url})
HTTP status returned: ${result.statusCode ?? 'none (request failed)'}
Error: ${result.error ?? 'n/a'}
Response time before failure: ${result.responseTimeMs}ms

In 3-4 plain-English sentences: explain what this combination of symptoms most likely means, and suggest one or two concrete things I should check first. Don't pad with disclaimers.`,
      },
    ],
    max_tokens: 300,
  });
  return completion.choices[0].message.content;
}

async function sendEmail({ subject, html }) {
  const result = await resend.emails.send({
    from: 'onboarding@resend.dev', // Resend's shared sandbox sender - fine for now
    to: NOTIFY_EMAIL,
    subject,
    html,
  });
  console.log('  resend.emails.send result:', JSON.stringify(result));
}

function recordIncident(incidents, { site, url, event, explanation, prUrl }) {
  const incident = {
    site: site.name,
    url,
    event,
    timestamp: new Date().toISOString(),
    explanation: explanation ?? null,
  };
  if (prUrl) incident.prUrl = prUrl;
  incidents.push(incident);
  return incidents.slice(-MAX_INCIDENTS);
}

async function main() {
  const sites = loadJson(SITES_PATH, []);
  const previousState = loadJson(STATE_PATH, {});
  const newState = { ...previousState };
  let incidents = loadJson(INCIDENTS_PATH, []);
  let incidentsChanged = false;

  for (const site of sites) {
    const result = await checkSite(site);
    const wasUp = previousState[site.url]?.up ?? true; // assume up if we've never checked
    const key = site.url;

    console.log(`[${site.name}] up=${result.up} status=${result.statusCode}`);

    if (!result.up && wasUp) {
      // Just went DOWN - investigate and alert
      console.log(`  -> state change: UP to DOWN. Investigating...`);
      let explanation = 'Could not reach the AI investigator for an explanation.';
      try {
        explanation = await explainOutage(site, result);
      } catch (err) {
        console.error('  Groq call failed:', err.message);
      }

      const incidentForFix = {
        summary: `${site.name} down`,
        rawContext: `${site.url} — status ${result.statusCode ?? 'none'}${result.error ? ` — ${result.error}` : ''}`,
      };
      let fixResult = { attempted: false, reason: 'Fix-PR not attempted.' };
      try {
        fixResult = await proposeFix({
          site,
          incident: incidentForFix,
          explanation,
          groqApiKey: process.env.GROQ_API_KEY,
          fixPrToken: process.env.FIX_PR_TOKEN,
          repoOwner: site.repoOwner,
          repoName: site.repoName,
        });
      } catch (err) {
        console.error('  proposeFix call failed:', err.message);
        fixResult = { attempted: false, reason: `proposeFix threw: ${err.message}` };
      }

      let prUrl;
      let approveLink;
      if (fixResult.opened) {
        prUrl = fixResult.prUrl;
        approveLink = buildApproveLink(prUrl);
        console.log(`  -> opened auto-fix PR: ${prUrl}`);
      } else {
        console.log(`  -> auto-fix not opened: ${fixResult.reason}`);
      }

      await sendEmail({
        subject: `🔴 ${site.name} is down`,
        html: `
          <p><strong>${site.name}</strong> (${site.url}) failed its health check at ${new Date().toISOString()}.</p>
          <p>Status code: ${result.statusCode ?? 'none'} ${result.error ? `— ${result.error}` : ''}</p>
          <hr/>
          <p><strong>What Jarvis thinks happened:</strong></p>
          <p>${explanation.replace(/\n/g, '<br/>')}</p>
          ${prUrl ? `<hr/><p><strong>Jarvis opened a fix PR:</strong> <a href="${prUrl}">${prUrl}</a></p>` : ''}
          ${approveLink ? `<p><a href="${approveLink}">Approve &amp; merge this fix</a></p>` : ''}
          <p><a href="${DASHBOARD_URL}/">Discuss this incident in Jarvis</a></p>
        `,
      });

      newState[key] = { up: false, since: new Date().toISOString() };
      incidents = recordIncident(incidents, { site, url: site.url, event: 'down', explanation, prUrl });
      incidentsChanged = true;
    } else if (result.up && !wasUp) {
      // Just came BACK UP - send a short recovery note
      console.log(`  -> state change: DOWN to UP. Sending recovery email...`);
      const downSince = previousState[key]?.since ?? 'unknown';

      await sendEmail({
        subject: `✅ ${site.name} is back up`,
        html: `
          <p><strong>${site.name}</strong> (${site.url}) is responding normally again.</p>
          <p>It had been down since approximately ${downSince}.</p>
        `,
      });

      newState[key] = { up: true, since: new Date().toISOString() };
      incidents = recordIncident(incidents, { site, url: site.url, event: 'up', explanation: null });
      incidentsChanged = true;
    } else {
      // No change - just quietly update the timestamp, no email
      newState[key] = { up: result.up, since: previousState[key]?.since ?? new Date().toISOString() };
    }
  }

  newState.lastChecked = new Date().toISOString();
  fs.writeFileSync(STATE_PATH, JSON.stringify(newState, null, 2));

  if (incidentsChanged) {
    fs.writeFileSync(INCIDENTS_PATH, JSON.stringify(incidents, null, 2));
  }
}

main().catch((err) => {
  console.error('Fatal error in check script:', err);
  process.exit(1);
});
