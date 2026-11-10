// api/chat.js — the chat endpoint behind the dashboard's "Ask Jarvis" panel.
//
// Deliberately stateless: the browser sends the full incident context and
// message history on every call, so this function needs no database and no
// new npm dependencies (uses the native fetch available in Vercel's Node
// runtime, calling Groq's OpenAI-compatible REST API directly).
//
// Env var required: GROQ_API_KEY — set this in the Vercel project settings
// for the DASHBOARD project (cian-os), not just the GitHub Actions repo
// secrets. They are separate places even though the key value is the same.

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Use POST.' });
    return;
  }

  const { incident, messages } = req.body || {};

  if (!incident || !Array.isArray(messages) || messages.length === 0) {
    res.status(400).json({ error: 'Request must include incident context and a messages array.' });
    return;
  }

  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: 'GROQ_API_KEY is not set on this Vercel project.' });
    return;
  }

  // System prompt grounds every reply in the actual incident, so the AI
  // doesn't have to be re-explained the situation on every message.
  const systemPrompt = `You are Jarvis, an AI DevOps assistant discussing a specific monitoring incident with the developer who built you. Be direct, technical, and concise — this is a working conversation, not a customer support chat.

Incident context:
- Site: ${incident.site || 'unknown'}
- URL: ${incident.url || 'unknown'}
- Event: ${incident.event || 'unknown'}
- Time: ${incident.timestamp || 'unknown'}
- Original investigation: ${incident.explanation || 'none recorded'}
${incident.prUrl ? `- An auto-fix PR was opened: ${incident.prUrl}` : '- No auto-fix PR was opened for this incident.'}

You cannot merge PRs or redeploy yourself — but the dashboard has a real "Approve & Merge" button next to the PR link that the developer can click, which does actually merge it. If asked to merge something, tell them to use that button rather than saying you can't help at all.

Default to short replies — 2 to 4 sentences is normal. Only go longer when the technical detail genuinely requires it (e.g. walking through a multi-step diagnosis). Never pad a short answer with restated context or pleasantries.`;

  try {
    const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: 'openai/gpt-oss-120b',
        reasoning_effort: 'low',
        max_tokens: 600,
        messages: [{ role: 'system', content: systemPrompt }, ...messages],
      }),
    });

    if (!groqRes.ok) {
      const errText = await groqRes.text();
      res.status(502).json({ error: `Groq request failed: ${errText}` });
      return;
    }

    const data = await groqRes.json();
    const reply = data.choices?.[0]?.message?.content?.trim();

    if (!reply) {
      res.status(502).json({ error: 'Groq returned an empty response.' });
      return;
    }

    res.status(200).json({ reply });
  } catch (err) {
    res.status(500).json({ error: `Chat request failed: ${err.message}` });
  }
};
