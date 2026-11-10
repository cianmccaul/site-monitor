// chat.js — the "Ask Jarvis" chat panel.
//
// Self-contained: injects its own floating button, panel, and styles at
// runtime. Conversation history lives in localStorage per incident (no
// database — single-user dashboard, fine for now).

(function () {
  const STYLE = `
    #jarvis-chat-btn {
      position: fixed; bottom: 24px; right: 24px; z-index: 9999;
      width: 56px; height: 56px; border-radius: 50%;
      background: linear-gradient(135deg, #3d7fff, #7c5cff);
      border: none; cursor: pointer; box-shadow: 0 4px 20px rgba(61,127,255,0.4);
      display: flex; align-items: center; justify-content: center;
      font-family: 'Sora', sans-serif; font-size: 22px; color: #fff;
      transition: transform 0.15s ease;
    }
    #jarvis-chat-btn:hover { transform: scale(1.08); }
    @media (max-width: 780px) {
      #jarvis-chat-btn { bottom: calc(88px + env(safe-area-inset-bottom)); right: 16px; width: 50px; height: 50px; font-size: 19px; }
    }
    #jarvis-chat-panel {
      position: fixed; bottom: 92px; right: 24px; z-index: 9999;
      width: 360px; max-width: calc(100vw - 32px); height: 480px;
      max-height: calc(100vh - 140px);
      background: #06060a; border: 1px solid rgba(124,92,255,0.25);
      border-radius: 16px; box-shadow: 0 8px 40px rgba(0,0,0,0.5);
      display: none; flex-direction: column; overflow: hidden;
      font-family: 'Inter', sans-serif; color: #eee;
      transition: bottom 0.15s ease;
    }
    #jarvis-chat-panel.open { display: flex; }
    @media (max-width: 780px) {
      #jarvis-chat-panel {
        left: 12px; right: 12px; width: auto;
        bottom: calc(148px + env(safe-area-inset-bottom));
        max-height: calc(100vh - 200px);
      }
    }
    #jarvis-chat-header {
      padding: 14px 16px; border-bottom: 1px solid rgba(255,255,255,0.08);
      font-family: 'Sora', sans-serif; font-weight: 600; font-size: 14px;
      display: flex; justify-content: space-between; align-items: center;
    }
    #jarvis-chat-close { background: none; border: none; color: #888; cursor: pointer; font-size: 18px; }
    #jarvis-incident-select {
      margin: 10px 14px; padding: 8px 10px; border-radius: 8px;
      background: #0d0d14; border: 1px solid rgba(255,255,255,0.1);
      color: #eee; font-size: 13px; font-family: 'Inter', sans-serif;
    }
    #jarvis-messages {
      flex: 1; overflow-y: auto; padding: 8px 14px; display: flex;
      flex-direction: column; gap: 10px; -webkit-overflow-scrolling: touch;
    }
    .jarvis-msg { max-width: 88%; padding: 9px 12px; border-radius: 12px; font-size: 13px; line-height: 1.45; white-space: pre-wrap; word-break: break-word; }
    .jarvis-msg.user { align-self: flex-end; background: linear-gradient(135deg, #3d7fff, #4c8bff); color: #fff; }
    .jarvis-msg.assistant { align-self: flex-start; background: #12121a; border: 1px solid rgba(255,255,255,0.08); }
    .jarvis-msg.system { align-self: center; background: none; border: 1px dashed rgba(255,255,255,0.15); color: #9696a5; font-size: 12px; }
    .jarvis-msg a { color: #8a6bff; }
    #jarvis-input-row { display: flex; gap: 8px; padding: 12px 14px; border-top: 1px solid rgba(255,255,255,0.08); align-items: flex-end; }
    #jarvis-input {
      flex: 1; background: #0d0d14; border: 1px solid rgba(255,255,255,0.1);
      border-radius: 8px; padding: 8px 10px; color: #eee; font-size: 16px; resize: none;
      font-family: 'Inter', sans-serif; max-height: 100px; overflow-y: auto; line-height: 1.4;
    }
    #jarvis-send {
      background: linear-gradient(135deg, #3d7fff, #7c5cff); border: none;
      border-radius: 8px; padding: 9px 14px; color: #fff; cursor: pointer; font-size: 13px; flex-shrink: 0;
    }
    #jarvis-send:disabled { opacity: 0.5; cursor: default; }
    .jarvis-actions { display: flex; flex-wrap: wrap; gap: 8px; padding: 0 14px 10px; }
    .jarvis-pr-link, .jarvis-approve-btn {
      font-size: 12px; text-decoration: none; border-radius: 6px; padding: 6px 10px; cursor: pointer;
    }
    .jarvis-pr-link { color: #8a6bff; border: 1px solid rgba(138,107,255,0.4); background: none; }
    .jarvis-approve-btn { color: #fff; border: none; background: linear-gradient(135deg, #2ed4a3, #22b98c); font-family: inherit; }
    .jarvis-approve-btn:disabled { opacity: 0.5; }
  `;

  let currentIncidents = [];
  let currentKey = null;

  function storageKey(inc) {
    return `jarvis-chat:${inc.site}:${inc.timestamp}`;
  }

  function loadHistory(inc) {
    try {
      const raw = localStorage.getItem(storageKey(inc));
      return raw ? JSON.parse(raw) : [];
    } catch {
      return [];
    }
  }

  function saveHistory(inc, history) {
    try {
      localStorage.setItem(storageKey(inc), JSON.stringify(history));
    } catch {
      // localStorage full or unavailable — conversation just won't persist, not fatal.
    }
  }

  function renderMessages(history) {
    const el = document.getElementById('jarvis-messages');
    el.innerHTML = '';
    history.forEach((m) => {
      const div = document.createElement('div');
      div.className = `jarvis-msg ${m.role === 'system' ? 'system' : m.role === 'user' ? 'user' : 'assistant'}`;
      div.textContent = m.content;
      el.appendChild(div);
    });
    el.scrollTop = el.scrollHeight;
  }

  function findIncident(key) {
    return currentIncidents.find((inc) => storageKey(inc) === key);
  }

  function parsePrUrl(prUrl) {
    const m = String(prUrl || '').match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
    if (!m) return null;
    return { owner: m[1], repo: m[2], prNumber: Number(m[3]) };
  }

  async function loadIncidents() {
    try {
      const res = await fetch('/incidents.json', { cache: 'no-store' });
      const data = await res.json();
      currentIncidents = Array.isArray(data) ? data.slice().reverse() : [];
    } catch {
      currentIncidents = [];
    }
    const select = document.getElementById('jarvis-incident-select');
    select.innerHTML = '';
    if (currentIncidents.length === 0) {
      const opt = document.createElement('option');
      opt.textContent = 'No incidents recorded yet';
      select.appendChild(opt);
      return;
    }
    currentIncidents.forEach((inc) => {
      const opt = document.createElement('option');
      opt.value = storageKey(inc);
      opt.textContent = `${inc.site} — ${inc.event} — ${new Date(inc.timestamp).toLocaleString()}`;
      select.appendChild(opt);
    });
    return select;
  }

  function renderActions(inc) {
    const existing = document.getElementById('jarvis-actions');
    if (existing) existing.remove();
    if (!inc.prUrl) return;
    const parsed = parsePrUrl(inc.prUrl);
    const wrap = document.createElement('div');
    wrap.id = 'jarvis-actions';
    wrap.className = 'jarvis-actions';

    const a = document.createElement('a');
    a.href = inc.prUrl;
    a.target = '_blank';
    a.rel = 'noopener';
    a.className = 'jarvis-pr-link';
    a.textContent = 'Review PR on GitHub';
    wrap.appendChild(a);

    if (parsed) {
      const btn = document.createElement('button');
      btn.className = 'jarvis-approve-btn';
      btn.textContent = 'Approve & Merge';
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        btn.textContent = 'Merging...';
        const history = loadHistory(inc);
        try {
          const res = await fetch('/api/approve', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(parsed),
          });
          const data = await res.json();
          if (data.ok) {
            history.push({ role: 'system', content: `PR #${parsed.prNumber} merged. Vercel is deploying it now.` });
            btn.textContent = 'Merged ✓';
          } else {
            history.push({ role: 'system', content: `Merge failed: ${data.error || 'unknown error'}` });
            btn.disabled = false;
            btn.textContent = 'Approve & Merge';
          }
        } catch (e) {
          history.push({ role: 'system', content: `Merge request failed: ${e.message}` });
          btn.disabled = false;
          btn.textContent = 'Approve & Merge';
        }
        saveHistory(inc, history);
        renderMessages(history);
      });
      wrap.appendChild(btn);
    }

    document.getElementById('jarvis-incident-select').insertAdjacentElement('afterend', wrap);
  }

  function loadIncidentIntoPanel(key) {
    currentKey = key;
    const inc = findIncident(key);
    if (!inc) return;
    document.getElementById('jarvis-incident-select').value = key;
    let history = loadHistory(inc);
    if (history.length === 0 && inc.explanation) {
      history = [{ role: 'assistant', content: inc.explanation }];
      saveHistory(inc, history);
    }
    renderMessages(history);
    renderActions(inc);
  }

  async function sendMessage() {
    const input = document.getElementById('jarvis-input');
    const text = input.value.trim();
    if (!text || !currentKey) return;
    const inc = findIncident(currentKey);
    if (!inc) return;

    const history = loadHistory(inc);
    history.push({ role: 'user', content: text });
    renderMessages(history);
    saveHistory(inc, history);
    input.value = '';
    input.style.height = 'auto';

    const sendBtn = document.getElementById('jarvis-send');
    sendBtn.disabled = true;
    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ incident: inc, messages: history.filter((m) => m.role !== 'system') }),
      });
      const data = await res.json();
      if (data.reply) {
        history.push({ role: 'assistant', content: data.reply });
      } else {
        history.push({ role: 'assistant', content: `(error: ${data.error || 'no reply received'})` });
      }
      renderMessages(history);
      saveHistory(inc, history);
    } catch (err) {
      history.push({ role: 'assistant', content: `(request failed: ${err.message})` });
      renderMessages(history);
      saveHistory(inc, history);
    } finally {
      sendBtn.disabled = false;
    }
  }

  function build() {
    const style = document.createElement('style');
    style.textContent = STYLE;
    document.head.appendChild(style);

    const btn = document.createElement('button');
    btn.id = 'jarvis-chat-btn';
    btn.textContent = '💬';
    btn.title = 'Ask Jarvis about an incident';
    document.body.appendChild(btn);

    const panel = document.createElement('div');
    panel.id = 'jarvis-chat-panel';
    panel.innerHTML = `
      <div id="jarvis-chat-header">
        <span>Ask Jarvis</span>
        <button id="jarvis-chat-close">✕</button>
      </div>
      <select id="jarvis-incident-select"></select>
      <div id="jarvis-messages"></div>
      <div id="jarvis-input-row">
        <textarea id="jarvis-input" rows="1" placeholder="Ask about this incident..."></textarea>
        <button id="jarvis-send">Send</button>
      </div>
    `;
    document.body.appendChild(panel);

    async function openPanel(preselectKey) {
      panel.classList.add('open');
      await loadIncidents();
      const key = preselectKey && findIncident(preselectKey) ? preselectKey : (currentIncidents[0] ? storageKey(currentIncidents[0]) : null);
      if (key) loadIncidentIntoPanel(key);
    }

    btn.addEventListener('click', () => {
      if (panel.classList.contains('open')) {
        panel.classList.remove('open');
      } else {
        openPanel();
      }
    });
    document.getElementById('jarvis-chat-close').addEventListener('click', () => panel.classList.remove('open'));
    document.getElementById('jarvis-incident-select').addEventListener('change', (e) => loadIncidentIntoPanel(e.target.value));
    document.getElementById('jarvis-send').addEventListener('click', sendMessage);

    const input = document.getElementById('jarvis-input');
    input.addEventListener('input', () => {
      input.style.height = 'auto';
      input.style.height = Math.min(input.scrollHeight, 100) + 'px';
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
      }
    });

    // Keeps the panel pinned above the iOS keyboard instead of drifting or
    // getting overlapped — iOS doesn't update layout viewport height when
    // the keyboard shows, so we track visualViewport directly.
    if (window.visualViewport) {
      const reposition = () => {
        const keyboardInset = window.innerHeight - window.visualViewport.height - window.visualViewport.offsetTop;
        panel.style.bottom = keyboardInset > 60 ? `${keyboardInset + 8}px` : '';
      };
      window.visualViewport.addEventListener('resize', reposition);
      window.visualViewport.addEventListener('scroll', reposition);
    }

    // Exposed so other parts of the dashboard (incident rows, notifications)
    // can open the chat pre-loaded to a specific incident.
    window.jarvisOpenChatFor = function (site, timestamp) {
      const key = `jarvis-chat:${site}:${timestamp}`;
      openPanel(key);
    };
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', build);
  } else {
    build();
  }
})();
