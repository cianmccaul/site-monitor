// api/approve.js — merges an auto-fix PR after an explicit human click.
//
// Two ways in, both require an explicit action, never an automatic one:
// 1. From the dashboard chat (already logged in via the jarvis_session
//    cookie) — a direct POST with {owner, repo, prNumber}.
// 2. From an email link — GET renders a confirmation page (never merges
//    on GET, since email scanners/prefetchers auto-follow links); the
//    page's own "Confirm merge" button then POSTs the same signed token.
//
// Requires FIX_PR_TOKEN in this Vercel project's env vars (Settings >
// Environment Variables) — same fine-grained token already scoped to
// your monitored repos, just needs adding here too, same dance as GROQ_API_KEY.
// It's also reused as the signing secret for email links, so no third
// new secret is needed anywhere.
//
// Note: merging to main auto-deploys via Vercel's GitHub integration —
// no separate "trigger a deployment" step needed after this runs.

const crypto = require('crypto');

function verifyToken(token, secret) {
  const [payload, sig] = String(token || '').split('.');
  if (!payload || !sig) return null;
  const expected = crypto.createHmac('sha256', secret).update(payload).digest('hex');
  const sigBuf = Buffer.from(sig);
  const expBuf = Buffer.from(expected);
  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) return null;
  let data;
  try {
    data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!data.exp || Date.now() > data.exp) return null;
  return data;
}

function hasValidSession(req) {
  const cookieHeader = req.headers.cookie || '';
  const cookies = Object.fromEntries(
    cookieHeader.split(';').map((c) => {
      const [k, ...v] = c.trim().split('=');
      return [k, v.join('=')];
    })
  );
  const session = cookies['jarvis_session'];
  const secret = process.env.DASHBOARD_SESSION_SECRET;
  return Boolean(session && secret && session === secret);
}

async function mergePR(owner, repo, prNumber) {
  const token = process.env.FIX_PR_TOKEN;
  if (!token) return { ok: false, error: 'FIX_PR_TOKEN is not set on this Vercel project.' };
  const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}/merge`, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ merge_method: 'squash' }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) return { ok: false, error: data.message || `GitHub returned ${res.status}` };

  // Best-effort: trigger an immediate recheck rather than waiting for the
  // next scheduled run, so recovery gets detected (and emailed) right away.
  // Uses a separate, narrowly-scoped token (Actions: write on Cian-os only)
  // since FIX_PR_TOKEN deliberately has no access to that repo. Failure
  // here doesn't fail the merge itself — the scheduled check still catches
  // it eventually either way.
  const triggerToken = process.env.WORKFLOW_TRIGGER_TOKEN;
  if (triggerToken) {
    try {
      await fetch('https://api.github.com/repos/cianmccaul/Cian-os/actions/workflows/check.yml/dispatches', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${triggerToken}`,
          Accept: 'application/vnd.github+json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ ref: 'main' }),
      });
    } catch (err) {
      console.error('Recheck trigger failed (non-fatal):', err.message);
    }
  }

  return { ok: true };
}

function confirmPage({ owner, repo, prNumber, token, error }) {
  return `<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  body{background:#06060a;color:#eee;font-family:-apple-system,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:20px;}
  .card{max-width:360px;background:#0d0d14;border:1px solid rgba(124,92,255,0.25);border-radius:16px;padding:28px 24px;text-align:center;}
  h1{font-size:17px;margin:0 0 10px;}
  p{color:#9696a5;font-size:13.5px;line-height:1.5;margin:0 0 18px;}
  button{background:linear-gradient(135deg,#3d7fff,#7c5cff);border:none;border-radius:8px;padding:11px 20px;color:#fff;font-size:14px;cursor:pointer;width:100%;}
  .err{color:#ff4d6a;font-size:13px;margin-top:14px;}
</style></head><body>
<div class="card">
  <h1>Merge fix for ${owner}/${repo}?</h1>
  <p>This merges PR #${prNumber} into main and auto-deploys via Vercel. Review the diff on GitHub first if you haven't already.</p>
  <button id="btn">Confirm merge</button>
  <div class="err" id="err">${error || ''}</div>
</div>
<script>
  document.getElementById('btn').addEventListener('click', async () => {
    const btn = document.getElementById('btn');
    btn.disabled = true; btn.textContent = 'Merging...';
    try {
      const res = await fetch('/api/approve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: '${token}' }),
      });
      const data = await res.json();
      if (data.ok) {
        document.querySelector('.card').innerHTML = '<h1>Merged</h1><p>PR #${prNumber} was merged and Vercel is deploying it now.</p>';
      } else {
        document.getElementById('err').textContent = data.error || 'Merge failed.';
        btn.disabled = false; btn.textContent = 'Confirm merge';
      }
    } catch (e) {
      document.getElementById('err').textContent = 'Network error — try again.';
      btn.disabled = false; btn.textContent = 'Confirm merge';
    }
  });
</script>
</body></html>`;
}

module.exports = async function handler(req, res) {
  if (req.method === 'GET') {
    const token = (req.query && req.query.token) || '';
    res.setHeader('Content-Type', 'text/html');
    const secret = process.env.FIX_PR_TOKEN;
    const data = secret ? verifyToken(token, secret) : null;
    if (!data) {
      res.status(400).send(confirmPage({ owner: '?', repo: '?', prNumber: '?', token, error: 'Link is invalid or expired.' }));
      return;
    }
    res.status(200).send(confirmPage({ owner: data.owner, repo: data.repo, prNumber: data.prNumber, token }));
    return;
  }

  if (req.method === 'POST') {
    const body = req.body || {};

    if (hasValidSession(req) && body.owner && body.repo && body.prNumber) {
      const result = await mergePR(body.owner, body.repo, body.prNumber);
      res.status(result.ok ? 200 : 502).json(result);
      return;
    }

    if (body.token) {
      const secret = process.env.FIX_PR_TOKEN;
      const data = secret ? verifyToken(body.token, secret) : null;
      if (!data) {
        res.status(400).json({ ok: false, error: 'Link is invalid or expired.' });
        return;
      }
      const result = await mergePR(data.owner, data.repo, data.prNumber);
      res.status(result.ok ? 200 : 502).json(result);
      return;
    }

    res.status(401).json({ ok: false, error: 'Not authenticated.' });
    return;
  }

  res.status(405).json({ error: 'Use GET or POST.' });
};