// proposeFix.js — the guarded "fix and open a PR" layer.
//
// Hard rules, enforced in code, not just prompted for:
// 1. Never touches `main` directly. Only ever opens a PR.
// 2. Only ever edits ONE file. If Groq's proposed fix touches more than
//    one file, it's rejected before anything happens.
// 3. Only proceeds if the diff is small (default: under 15 changed lines).
//    Anything bigger is flagged "needs manual review" instead of a PR.
// 4. Uses a token scoped ONLY to the target site's repo (FIX_PR_TOKEN) —
//    this script has no access to any other repo, including Cian-os itself.
// 5. If anything is ambiguous or fetch/parsing fails, it fails CLOSED —
//    no PR, just a note in the email — never guesses its way into a commit.

const { Octokit } = require('@octokit/rest');
const Groq = require('groq-sdk');

const MAX_CHANGED_LINES = 15;

function candidatePathsFromUrl(url) {
  let pathname;
  try {
    pathname = new URL(url).pathname;
  } catch {
    return [];
  }
  const trimmed = pathname.replace(/^\/+|\/+$/g, '');
  if (!trimmed) return [];
  return [
    `${trimmed}.js`,
    `${trimmed}.ts`,
    `pages/${trimmed}.js`,
    `pages/${trimmed}.ts`,
    `app/${trimmed}/route.js`,
    `app/${trimmed}/route.ts`,
  ];
}

function countChangedLines(oldContent, newContent) {
  const oldLines = oldContent.split('\n');
  const newLines = newContent.split('\n');
  // Simple, conservative measure: not a real diff algorithm, just a
  // fast proxy for "how big is this change" used purely as a safety gate.
  const lenDiff = Math.abs(oldLines.length - newLines.length);
  let changed = lenDiff;
  const shorter = Math.min(oldLines.length, newLines.length);
  for (let i = 0; i < shorter; i++) {
    if (oldLines[i] !== newLines[i]) changed++;
  }
  return changed;
}

async function proposeFix({ site, incident, explanation, groqApiKey, fixPrToken, repoOwner, repoName }) {
  if (!fixPrToken || !repoOwner || !repoName) {
    return { attempted: false, reason: 'Fix-PR not configured for this site.' };
  }

  const octokit = new Octokit({ auth: fixPrToken });
  const groq = new Groq({ apiKey: groqApiKey });

  // Step 1: before spending a Groq call, try deterministic candidate paths
  // derived from the URL that actually failed (e.g. /api/health ->
  // api/health.js, pages/api/health.ts, app/api/health/route.js, ...).
  let guessedPath;
  let fileData;
  const candidates = candidatePathsFromUrl(site.url);
  for (const candidate of candidates) {
    try {
      const res = await octokit.repos.getContent({ owner: repoOwner, repo: repoName, path: candidate });
      if (!Array.isArray(res.data) && res.data.content) {
        guessedPath = candidate;
        fileData = res.data;
        console.log('  proposeFix: matched deterministic candidate:', candidate);
        break;
      }
    } catch {
      // Doesn't exist at this path - try the next candidate.
    }
  }

  if (!guessedPath) {
    // Step 1b: no deterministic candidate matched - fall back to asking Groq
    // which single file is most likely responsible, based only on the
    // incident symptoms (not the codebase yet).
    const guessResp = await groq.chat.completions.create({
      model: 'openai/gpt-oss-120b',
      messages: [{
        role: 'user',
        content: `A site returned this error: ${explanation}\n\nSite URL: ${site.url}\n\nAdditional context: ${incident.rawContext || ''}\n\nIf you had to guess the ONE file in a typical Next.js/React project most likely responsible for this specific issue, what is its most likely path (e.g. "app/page.tsx", "next.config.js", "vercel.json")? Reply with ONLY the file path, nothing else. If you genuinely can't narrow it to one likely file, reply exactly: UNKNOWN`,
      }],
      max_tokens: 150,
      reasoning_effort: 'low',
    });
    const rawGuess = guessResp.choices[0].message.content.trim();
    console.log('  proposeFix: raw Groq file guess:', JSON.stringify(rawGuess));

    if (!rawGuess || rawGuess === 'UNKNOWN' || rawGuess.includes(' ')) {
      return { attempted: false, reason: 'Could not confidently identify a single file to check.' };
    }
    guessedPath = rawGuess;

    // Step 2: actually fetch that file from the TARGET site's repo (read-only at this point).
    try {
      const res = await octokit.repos.getContent({ owner: repoOwner, repo: repoName, path: guessedPath });
      fileData = res.data;
    } catch (err) {
      return { attempted: false, reason: `Guessed file "${guessedPath}" doesn't exist or isn't readable — skipping auto-fix.` };
    }
    if (Array.isArray(fileData) || !fileData.content) {
      return { attempted: false, reason: 'Guessed path is a directory, not a file — skipping auto-fix.' };
    }
  }
  const originalContent = Buffer.from(fileData.content, 'base64').toString('utf8');

  // Step 3: ask Groq for a proposed fix, constrained to this one file only —
  // as an old_str/new_str snippet pair rather than a full-file rewrite, so
  // every unrelated line, comment, and the trailing newline stay untouched.
  const fixResp = await groq.chat.completions.create({
    model: 'openai/gpt-oss-120b',
    messages: [{
      role: 'user',
      content: `This file (${guessedPath}) is the likely cause of: ${explanation}\n\nCurrent content:\n---\n${originalContent}\n---\n\nIf there is a small, confident, low-risk fix, reply with EXACTLY this format and nothing else — no explanation, no markdown fences:\n\nOLD_STR_START\n<the exact original snippet that needs to change, copied verbatim from the file above>\nOLD_STR_END\nNEW_STR_START\n<the exact replacement text>\nNEW_STR_END\n\nThe OLD_STR snippet must appear EXACTLY ONCE in the file, character-for-character, or the fix will be rejected. Keep it as short as possible while still being uniquely identifiable. If you are not highly confident, or the fix would require touching more than this one file, reply with exactly: NO_CONFIDENT_FIX`,
    }],
    max_tokens: 2000,
    reasoning_effort: 'low',
  });
  const rawFix = fixResp.choices[0].message.content.trim();

  if (!rawFix || rawFix === 'NO_CONFIDENT_FIX') {
    return { attempted: false, reason: 'AI did not have a confident, low-risk fix for this file.' };
  }

  const oldMatch = rawFix.match(/OLD_STR_START\n([\s\S]*?)\nOLD_STR_END/);
  const newMatch = rawFix.match(/NEW_STR_START\n([\s\S]*?)\nNEW_STR_END/);
  if (!oldMatch || !newMatch) {
    return { attempted: false, reason: 'Could not parse proposed fix — expected OLD_STR/NEW_STR format.' };
  }
  const oldStr = oldMatch[1];
  const newStr = newMatch[1];

  if (!oldStr) {
    return { attempted: false, reason: 'fix rejected: snippet not uniquely found' };
  }
  const occurrences = originalContent.split(oldStr).length - 1;
  if (occurrences !== 1) {
    return { attempted: false, reason: 'fix rejected: snippet not uniquely found' };
  }

  const proposedContent = originalContent.replace(oldStr, newStr);

  if (proposedContent === originalContent) {
    return { attempted: false, reason: 'Proposed content was identical to the original — nothing to fix.' };
  }

  // Step 4: the hard safety gate. Refuse anything too large, no exceptions.
  const changedLines = countChangedLines(originalContent, proposedContent);
  if (changedLines > MAX_CHANGED_LINES) {
    return {
      attempted: false,
      reason: `Proposed fix changes ~${changedLines} lines — over the ${MAX_CHANGED_LINES}-line auto-fix limit. Flagged for manual review instead of opening a PR.`,
    };
  }

  // Step 5: passed every gate — open a PR (never merge, never touch main directly).
  const branch = `jarvis/fix-${Date.now()}`;
  const { data: ref } = await octokit.git.getRef({ owner: repoOwner, repo: repoName, ref: 'heads/main' });
  await octokit.git.createRef({ owner: repoOwner, repo: repoName, ref: `refs/heads/${branch}`, sha: ref.object.sha });

  await octokit.repos.createOrUpdateFileContents({
    owner: repoOwner,
    repo: repoName,
    path: guessedPath,
    message: `Jarvis auto-fix: ${explanation.slice(0, 60)}`,
    content: Buffer.from(proposedContent).toString('base64'),
    sha: fileData.sha,
    branch,
  });

  const { data: pr } = await octokit.pulls.create({
    owner: repoOwner,
    repo: repoName,
    head: branch,
    base: 'main',
    title: `Jarvis auto-fix: ${incident.summary || site.name + ' issue'}`,
    body: `**Detected issue:** ${explanation}\n\n**File changed:** \`${guessedPath}\` (~${changedLines} lines)\n\nThis PR was opened automatically after passing safety checks (single file, small diff). It has NOT been merged — review the diff and merge manually, or use the dashboard's approve action once CI passes.`,
  });

  return {
    attempted: true,
    opened: true,
    prUrl: pr.html_url,
    file: guessedPath,
    changedLines,
  };
}

module.exports = { proposeFix };
