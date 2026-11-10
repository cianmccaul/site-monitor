// api/login.js — sets a long-lived session cookie after checking the dashboard password.
//
// Kept deliberately simple: no database, no per-user accounts, since this
// dashboard has exactly one operator (you). The cookie's value is a random
// secret (DASHBOARD_SESSION_SECRET), NOT your actual password — so if it
// ever needs rotating, it can be, independently of your real credentials.

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Use POST.' });
    return;
  }

  const { username, password } = req.body || {};

  const validUser = process.env.DASHBOARD_USER;
  const validPass = process.env.DASHBOARD_PASSWORD;
  const secret = process.env.DASHBOARD_SESSION_SECRET;

  if (!validUser || !validPass || !secret) {
    res.status(500).json({ error: 'Dashboard auth is not fully configured on this project.' });
    return;
  }

  if (username !== validUser || password !== validPass) {
    res.status(401).json({ error: 'Incorrect username or password.' });
    return;
  }

  // 180-day session — this is what makes "Add to Home Screen" stop re-asking.
  const maxAge = 60 * 60 * 24 * 180;
  res.setHeader(
    'Set-Cookie',
    `jarvis_session=${secret}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`
  );
  res.status(200).json({ ok: true });
};
