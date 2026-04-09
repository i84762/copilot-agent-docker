/* ── Archon — app.js ────────────────────────────────────────────────────────
 *  State machine:
 *    idle       → user fills form, no active container
 *    planning   → container running in plan mode (interactive terminal)
 *    running    → container running in normal mode  (log stream)
 *    plan_done  → plan mode container exited, PLAN.md created
 *    error      → something went wrong
 * ─────────────────────────────────────────────────────────────────────────── */

'use strict';

// ── xterm.js setup ───────────────────────────────────────────────────────────

const term    = new Terminal({
  theme: {
    background:  '#0d1117',
    foreground:  '#e6edf3',
    cursor:      '#e6edf3',
    selection:   'rgba(56,139,253,0.3)',
    black:       '#484f58',
    brightBlack: '#6e7681',
    red:         '#f85149',
    green:       '#3fb950',
    yellow:      '#d29922',
    blue:        '#388bfd',
    magenta:     '#a371f7',
    cyan:        '#39c5cf',
    white:       '#b1bac4',
    brightWhite: '#e6edf3',
  },
  fontFamily: "'Cascadia Code', 'Consolas', 'Fira Code', monospace",
  fontSize:   13,
  lineHeight: 1.35,
  cursorBlink: true,
  scrollback:  5000,
});
const fitAddon = new FitAddon.FitAddon();
term.loadAddon(fitAddon);
term.open(document.getElementById('terminal'));
fitAddon.fit();

term.writeln('\x1b[90mArchon — ready.\x1b[0m');
term.writeln('\x1b[90mFill in the form on the left and click Plan or Start.\x1b[0m\r\n');

// Resize observer → keep xterm fitted
const resizeObs = new ResizeObserver(() => fitAddon.fit());
resizeObs.observe(document.getElementById('terminalPanel'));

window.addEventListener('resize', () => fitAddon.fit());

// ── xterm keyboard input → container stdin (used for TUI plan agents) ─────────
let termInputEnabled = false; // only forward keys when a TUI plan session is active
term.onData(data => {
  if (!termInputEnabled) return;
  wsSend({ type: 'terminal_input', data: btoa(data) });
});

// ── State ─────────────────────────────────────────────────────────────────────

let state = 'idle'; // idle | planning | running | plan_done | error
let ws    = null;
let activeContainerId = null;
let containerStartedAt = 0;  // timestamp when container_started was received
let lastConfig        = null;       // config used for last run (for Execute Plan)
let logBuffer         = '';         // raw log accumulation for download
let containerRefreshTimer = null;

// ── WebSocket ─────────────────────────────────────────────────────────────────

function connectWS() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${proto}//${location.host}`);

  ws.onopen = () => {
    setStatus('Connected');
    listContainers();
    checkDockerStatus();
    checkImageStatus();
  };

  ws.onclose = () => {
    setStatus('Disconnected — reconnecting…', 'error');
    // If server restarted, active container is gone — reset UI state
    if (state === 'planning' || state === 'running') {
      activeContainerId = null;
      setActiveContainerLabel(null);
      enterState('idle');
      appendChatBubble('system', '⚠️ Connection lost. Server may have restarted. Ready for a new session.');
      scrollChatToBottom();
    }
    setTimeout(connectWS, 3000);
  };

  ws.onerror = (e) => {
    console.warn('[ws] error:', e.message || e);
    setStatus('Connection error — reconnecting…', 'error');
  };

  ws.onmessage = ev => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch (e) {
      console.warn('[ws] failed to parse message:', e.message);
      return;
    }

    switch (msg.type) {

      case 'connected':
        break;

      case 'docker_status':
        // Docker connection updated (e.g. after /api/docker/connect)
        if (msg.connected) checkImageStatus();
        break;

      case 'output': {
        const raw = Uint8Array.from(atob(msg.data), c => c.charCodeAt(0));
        term.write(raw);
        logBuffer += new TextDecoder().decode(raw);
        break;
      }

      // ── Chat UI events (plan mode) ─────────────────────────────────────────
      // All agents (including copilot/aider) output is routed through chat.
      // During streaming: append raw text for low-latency display.
      // On message_end: re-render the completed bubble as markdown.

      case 'chat_chunk': {
        hideChatTyping();
        let bubble = document.getElementById('currentAgentBubble');
        if (!bubble) {
          bubble = appendChatBubble('agent', '');
          bubble.id = 'currentAgentBubble';
        }
        // Accumulate on the element itself for final markdown render
        bubble._rawText = (bubble._rawText || '') + msg.text;
        // Stream as pre-text for immediate feedback
        const textEl = bubble.querySelector('.bubble-text');
        textEl.textContent = bubble._rawText;
        scrollChatToBottom();
        break;
      }

      case 'chat_message_end': {
        const bubble = document.getElementById('currentAgentBubble');
        if (bubble && bubble._rawText) {
          // Render accumulated text as markdown
          renderBubbleMarkdown(bubble);
        }
        if (bubble) bubble.removeAttribute('id');
        hideChatTyping();
        scrollChatToBottom();
        break;
      }

      case 'chat_typing': {
        showChatTyping();
        scrollChatToBottom();
        break;
      }

      case 'chat_system': {
        appendChatBubble('system', msg.text);
        hideChatTyping();
        scrollChatToBottom();
        break;
      }
      // ──────────────────────────────────────────────────────────────────────

      case 'container_started':
        activeContainerId = msg.containerId;
        containerStartedAt = Date.now();
        setActiveContainerLabel(msg.containerId);
        if (msg.mode === 'plan') {
          enterState('planning');
          // Show welcome system message in chat
          appendChatBubble('system', '🗺 Planning session started. The agent is analyzing your project…');
          scrollChatToBottom();
          // Still sync PTY size for the underlying terminal process
          sendResize();
        } else {
          enterState('running');
        }
        listContainers();
        break;

      case 'container_stopped':
        termInputEnabled = false; // stop forwarding keys to container
        if (state === 'planning') {
          enterState('plan_done');
        } else {
          enterState('idle');
        }
        activeContainerId = null;
        setActiveContainerLabel(null);
        listContainers();
        break;

      case 'plan_complete':
        termInputEnabled = false; // stop forwarding keys to container
        enterState('plan_done');
        toast('Plan complete — click Execute Plan to run', 'success');
        break;

      case 'containers_list':
        renderContainerList(msg.containers);
        // Auto-recover: if we think a container is active but it's gone, reset to idle.
        // Skip for virtual API session IDs (plan-api-*) — they have no Docker container.
        // Skip for 5s after container_started to avoid a race where the docker_event
        // 'start' triggers a list refresh before the container appears.
        if (activeContainerId && !activeContainerId.startsWith('plan-api-') &&
            state !== 'idle' && (Date.now() - containerStartedAt) > 5000) {
          const stillExists = msg.containers && msg.containers.some(c => c.id === activeContainerId);
          if (!stillExists) {
            activeContainerId = null;
            setActiveContainerLabel(null);
            enterState('idle');
          }
        }
        break;

      case 'docker_event':
        // Refresh container list when any copilot container starts/stops
        if (msg.action === 'start' || msg.action === 'die' || msg.action === 'kill') {
          listContainers();
        }
        break;

      case 'error':
        term.writeln(`\r\n\x1b[31m[error] ${msg.message}\x1b[0m\r\n`);
        toast(msg.message, 'error');
        break;

      case 'dev_log':
        appendDevLog(msg.text);
        break;

      case 'dev_log_status':
        // No longer used — server always streams dev_log
        break;

      case 'progress': {
        // Show/update launch progress overlay
        showLaunchProgress(true);
        setProgressStep(msg.step, msg.text, msg.status);
        break;
      }

      case 'progress_done':
        showLaunchProgress(false);
        break;

      case 'progress_error':
        setProgressTitle('Failed', 'error');
        // Leave panel visible so user can read the step that failed
        break;

      default:
        console.debug('[ws] unhandled message type:', msg.type, msg);
    }
  };
}

function wsSend(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(obj));
  }
}

// ── State machine ─────────────────────────────────────────────────────────────

function enterState(newState) {
  console.log('[state]', newState);
  state = newState;
  updateButtons();
  updateTerminalTitle();

  const modeTag = $('modeTag');
  modeTag.classList.remove('hidden', 'mode-plan', 'mode-run', 'mode-resume');

  // Toggle between terminal and chat panel
  const inPlanMode = (newState === 'planning');
  $('terminal').classList.toggle('hidden', inPlanMode);
  $('chatPanel').classList.toggle('hidden', !inPlanMode);
  // Always clear any lingering progress overlay when switching state
  showLaunchProgress(false);

  if (newState === 'planning') {
    modeTag.textContent = '🗺 Planning';
    modeTag.classList.add('mode-plan');
  } else if (newState === 'running') {
    modeTag.textContent = '▶ Running';
    modeTag.classList.add('mode-run');
  } else if (newState === 'plan_done') {
    modeTag.textContent = '✅ Plan ready';
    modeTag.classList.add('mode-resume');
  } else {
    modeTag.classList.add('hidden');
  }
}

function updateButtons() {
  const idle     = state === 'idle';
  const active   = state === 'planning' || state === 'running';
  const planDone = state === 'plan_done';

  $('planBtn').disabled    = active || planDone;
  $('startBtn').disabled   = active || planDone;
  $('resumeBtn').disabled  = active || planDone;
  $('newBtn').disabled     = active || planDone;
  $('cancelBtn').disabled  = idle || planDone;
  $('abortBtn').disabled   = idle || planDone;
  $('execPlanBtn').classList.toggle('hidden', !planDone);
}

function updateTerminalTitle() {
  const t = $('terminalTitle');
  t.className = 'terminal-title';
  if (state === 'planning') { t.textContent = 'Plan Session — Interactive';  t.classList.add('active-plan'); }
  else if (state === 'running')  { t.textContent = 'Agent Output — Live Log'; t.classList.add('active-run'); }
  else if (state === 'plan_done'){ t.textContent = 'Planning Complete'; }
  else                           { t.textContent = 'Idle'; }
}

// ── Agent metadata ────────────────────────────────────────────────────────────

const AGENT_INFO = {
  copilot: {
    name: 'GitHub Copilot CLI',
    desc: 'Official GitHub Copilot agent. Requires a GitHub Copilot subscription and a Personal Access Token with <code>repo</code> + <code>copilot</code> scopes.',
    link: 'https://github.com/settings/tokens/new?scopes=repo,copilot',
    linkText: 'Create GitHub token ↗',
    color: 'var(--green)',
  },
  claude: {
    name: 'Claude Code',
    desc: 'Anthropic\'s coding agent (Claude 3.5 Sonnet by default). Requires an Anthropic API key. Highly capable for large refactors and complex reasoning.',
    link: 'https://console.anthropic.com/settings/keys',
    linkText: 'Get Anthropic key ↗',
    color: 'var(--orange)',
  },
  gemini: {
    name: 'Gemini CLI',
    desc: 'Google\'s Gemini coding agent. Requires a Google AI Studio API key. Best for multi-modal tasks and large context windows.',
    link: 'https://aistudio.google.com/app/apikey',
    linkText: 'Get Gemini key ↗',
    color: 'var(--blue)',
  },
  aider: {
    name: 'Aider',
    desc: 'Flexible open-source coding agent. Works with OpenAI, Anthropic, or Gemini models. Provide at least one API key — the model is auto-detected.',
    link: 'https://aider.chat/docs/llms.html',
    linkText: 'Supported models ↗',
    color: 'var(--purple)',
  },
};

function renderAgentCard(agent) {
  const info = AGENT_INFO[agent];
  if (!info) { $('agentCard').classList.remove('visible'); return; }
  $('agentCard').style.borderLeftColor = info.color;
  $('agentCard').innerHTML =
    `<strong>${info.name}</strong> — ${info.desc}<br>` +
    `<a href="${info.link}" target="_blank">${info.linkText}</a>`;
  $('agentCard').classList.add('visible');
}

// ── Setup hint (first-time) ───────────────────────────────────────────────────

function checkSetupHint() {
  const hasToken = ($('ghToken')?.value || $('anthropicApiKey')?.value || '').trim();
  if (!hasToken) {
    $('setupHint').classList.remove('hidden');
  } else {
    $('setupHint').classList.add('hidden');
  }
  updateCredentialsBadge();
}

// Show a "✓ configured" or "⚠ not set" badge on the credentials summary
function updateCredentialsBadge() {
  const hint = $('credentialsHint');
  if (!hint) return;
  // Don't overwrite an error hint
  if (hint.textContent.startsWith('⚠ ') && hint.textContent.includes('required')) return;

  const agent = $('agent')?.value || 'copilot';
  const keyMap = {
    copilot: 'ghToken',
    claude:  'anthropicApiKey',
    gemini:  'geminiApiKey',
    aider:   'openaiApiKey',
  };
  const keyId = keyMap[agent];
  const hasKey = keyId && $(keyId) && $(keyId).value.trim().length > 0;
  if (hasKey) {
    hint.textContent = '✓ configured';
    hint.style.color = 'var(--green)';
  } else {
    hint.textContent = '';
  }
}

// ── Inline field validation ───────────────────────────────────────────────────

function setFieldError(inputId, msg) {
  const el = $(inputId);
  if (!el) return;
  if (msg) {
    el.classList.add('field-invalid');
    let errEl = el.parentNode.querySelector('.field-error-msg');
    if (!errEl) {
      errEl = document.createElement('p');
      errEl.className = 'field-error-msg';
      el.parentNode.insertBefore(errEl, el.nextSibling);
    }
    errEl.textContent = msg;
    errEl.classList.add('visible');

    // Auto-expand any <details> ancestor and scroll field into view
    let node = el.parentNode;
    while (node && node !== document.body) {
      if (node.tagName === 'DETAILS') {
        node.open = true;
        // Pulse the summary to draw attention
        const sum = node.querySelector('summary');
        if (sum) {
          sum.classList.remove('cg-error-pulse');
          void sum.offsetWidth; // reflow to restart animation
          sum.classList.add('cg-error-pulse');
        }
      }
      node = node.parentNode;
    }
    setTimeout(() => el.scrollIntoView({ behavior: 'smooth', block: 'center' }), 50);
  } else {
    el.classList.remove('field-invalid');
    const errEl = el.parentNode.querySelector('.field-error-msg');
    if (errEl) errEl.classList.remove('visible');
  }
}

function clearFieldErrors() {
  document.querySelectorAll('.field-invalid').forEach(el => el.classList.remove('field-invalid'));
  document.querySelectorAll('.field-error-msg.visible').forEach(el => el.classList.remove('visible'));
  document.querySelectorAll('.cg-error-pulse').forEach(el => el.classList.remove('cg-error-pulse'));
  // Reset credentials hint (re-evaluate configured state)
  const hint = $('credentialsHint');
  if (hint) { hint.textContent = ''; hint.style.color = ''; }
  updateCredentialsBadge();
}

['projectPath','ghToken','anthropicApiKey','geminiApiKey'].forEach(id => {
  const el = $(id);
  if (!el) return;
  el.addEventListener('blur', () => {
    if (el.value.trim()) setFieldError(id, null);
  });
  el.addEventListener('input', () => {
    if (el.value.trim()) setFieldError(id, null);
  });
});

// ── Form helpers ──────────────────────────────────────────────────────────────

function getConfig() {
  const agent = $('agent').value;
  return {
    projectPath:          $('projectPath').value.trim(),
    agent:                agent,
    ghToken:              $('ghToken')?.value.trim() || '',
    anthropicApiKey:      agent === 'aider' ? ($('anthropicApiKey2')?.value.trim() || '') : ($('anthropicApiKey')?.value.trim() || ''),
    geminiApiKey:         agent === 'aider' ? ($('geminiApiKey2')?.value.trim() || '') : ($('geminiApiKey')?.value.trim() || ''),
    openaiApiKey:         $('openaiApiKey')?.value.trim() || '',
    aiderModel:           $('aiderModel')?.value.trim() || '',
    task:                 $('task').value.trim(),
    taskFile:             $('taskFile').value.trim(),
    instructionsRepo:     $('instructionsRepo').value.trim(),
    instructionsFile:     $('instructionsFile').value.trim(),
    instructionsBranch:   $('instructionsBranch').value.trim(),
    useHostInstructions:  $('useHostInstructions').checked,
    gitUserName:          $('gitUserName').value.trim(),
    gitUserEmail:         $('gitUserEmail').value.trim(),
    flutterVersion:       $('flutterVersion').value.trim(),
    goVersion:            $('goVersion').value.trim(),
    firebaseProjectId:    $('firebaseProjectId').value.trim(),
    gcloudKeyFile:        $('gcloudKeyFile').value.trim(),
    firebaseTestDevice:   $('firebaseTestDevice').value.trim(),
  };
}

function validateConfig() {
  clearFieldErrors();
  const cfg = getConfig();
  let valid = true;

  function credHint(msg) {
    const hint = $('credentialsHint');
    if (hint) hint.textContent = '⚠ ' + msg;
  }

  if (!cfg.projectPath) {
    setFieldError('projectPath', 'Project path is required');
    valid = false;
  }
  if (cfg.agent === 'copilot' && !cfg.ghToken) {
    credHint('GitHub Token required');
    setFieldError('ghToken', 'GitHub Token is required for Copilot agent');
    valid = false;
  }
  if (cfg.agent === 'claude' && !cfg.anthropicApiKey) {
    credHint('Anthropic API Key required');
    setFieldError('anthropicApiKey', 'Anthropic API Key is required for Claude agent');
    valid = false;
  }
  if (cfg.agent === 'gemini' && !cfg.geminiApiKey) {
    credHint('Gemini API Key required');
    setFieldError('geminiApiKey', 'Gemini API Key is required for Gemini agent');
    valid = false;
  }
  if (cfg.agent === 'aider' && !cfg.anthropicApiKey && !cfg.openaiApiKey && !cfg.geminiApiKey) {
    credHint('At least one API key required');
    const sec = $('credentialsSection');
    if (sec) {
      sec.open = true;
      const sum = sec.querySelector('summary');
      if (sum) { sum.classList.remove('cg-error-pulse'); void sum.offsetWidth; sum.classList.add('cg-error-pulse'); }
      setTimeout(() => sec.scrollIntoView({ behavior: 'smooth', block: 'start' }), 50);
    }
    valid = false;
  }
  return valid ? cfg : null;
}

// ── Persistence ───────────────────────────────────────────────────────────────
// Global fields (tokens, keys, instructions, defaults) → server-side config file
//   Persists across browsers, survives page reload, shared with remote clients.

// All config is stored server-side via GET/POST /api/config.
// No localStorage — single source of truth, easy to export/migrate.

const ALL_FIELDS = [
  'agent',
  'ghToken','anthropicApiKey','geminiApiKey','openaiApiKey',
  'anthropicApiKey2','geminiApiKey2','aiderModel',
  'instructionsRepo','instructionsFile','instructionsBranch',
  'gitUserName','gitUserEmail','flutterVersion','goVersion',
  'firebaseProjectId','gcloudKeyFile','firebaseTestDevice',
  'sessionName','projectPath','task','taskFile',
];
const ALL_CHECKBOXES = ['useHostInstructions'];

let _saveTimer = null;
function saveForm() {
  clearTimeout(_saveTimer);
  _saveTimer = setTimeout(() => {
    const data = {};
    ALL_FIELDS.forEach(id => { const el = $(id); if (el) data[id] = el.value; });
    ALL_CHECKBOXES.forEach(id => { const el = $(id); if (el) data[id] = el.checked; });
    fetch('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    }).catch(() => {});
  }, 800);
}

async function loadForm() {
  try {
    const res = await fetch('/api/config');
    if (!res.ok) return;
    const data = await res.json();
    ALL_FIELDS.forEach(id => { const el = $(id); if (el && id in data) el.value = data[id]; });
    ALL_CHECKBOXES.forEach(id => { const el = $(id); if (el && id in data) el.checked = data[id]; });
  } catch (_) {}
}

// Auto-save on any input change; hide setup hint once user starts
document.querySelectorAll('.input-field, input[type="checkbox"]').forEach(el => {
  el.addEventListener('change', () => { saveForm(); checkSetupHint(); });
  el.addEventListener('input',  () => { saveForm(); checkSetupHint(); });
});

// ── Container list ────────────────────────────────────────────────────────────

function listContainers() {
  wsSend({ type: 'list_containers' });
}

function renderContainerList(containers) {
  const sel = $('containerSelect');
  const prev = sel.value;
  sel.innerHTML = '';

  if (!containers || containers.length === 0) {
    sel.innerHTML = '<option value="">— no running containers —</option>';
    $('containerInfo').classList.add('hidden');
    $('switchAgentBar').classList.add('hidden');
    return;
  }

  sel.innerHTML = '<option value="">Select a container…</option>';
  containers.forEach(c => {
    const opt  = document.createElement('option');
    opt.value  = c.id;
    opt.dataset.agent = c.agent || 'copilot';
    // Show: "My Feature  ·  [plan]  office-app" or "copilot-agent-17…  ·  [normal]  …"
    const label = c.sessionName
      ? `${c.sessionName}  ·  [${c.mode}]  ${c.project}`
      : `${c.shortId}  ·  [${c.mode}]  ${c.project}`;
    opt.textContent = label;
    sel.appendChild(opt);
  });

  if (prev && containers.find(c => c.id === prev)) {
    sel.value = prev;
    showContainerInfo(containers.find(c => c.id === prev));
  }
}

function showContainerInfo(c) {
  if (!c) {
    $('containerInfo').classList.add('hidden');
    $('switchAgentBar').classList.add('hidden');
    return;
  }
  const stateClass = c.state === 'running' ? 'ci-running' : 'ci-exited';
  const modeClass  = c.mode === 'plan' ? 'ci-plan' : '';
  const agentInfo  = AGENT_INFO[c.agent] || { name: c.agent || 'copilot' };
  const nameHtml   = c.sessionName
    ? `<span class="ci-session-name">${c.sessionName}</span> <span class="ci-docker-id">${c.shortId}</span>`
    : `<span class="ci-name">${c.shortId}</span>`;
  $('containerInfo').innerHTML =
    `${nameHtml}  ` +
    `<span class="ci-badge ${stateClass}">${c.state}</span>  ` +
    (c.mode !== 'normal' ? `<span class="ci-badge ${modeClass}">${c.mode}</span>  ` : '') +
    `<span class="ci-badge" style="background:var(--surface);border:1px solid var(--border)">${agentInfo.name}</span>` +
    `<br><span class="ci-status-text">${c.status}</span>`;
  $('containerInfo').classList.remove('hidden');

  // Sync agent dropdown to match this container's agent
  if (c.agent && $('agent').value !== c.agent) {
    $('agent').value = c.agent;
    updateAgentFields(c.agent);
  }

  // Show switch-agent bar
  $('switchAgentSelect').value = c.agent || 'copilot';
  $('switchAgentBar').classList.remove('hidden');
}

$('containerSelect').addEventListener('change', ev => {
  const id = ev.target.value;
  if (!id) {
    $('containerInfo').classList.add('hidden');
    $('switchAgentBar').classList.add('hidden');
    return;
  }
  // Get agent from option data attribute
  const opt = ev.target.options[ev.target.selectedIndex];
  const agent = opt?.dataset?.agent || 'copilot';
  showContainerInfo({ id, state: 'running', mode: 'normal', name: id.slice(0, 12), status: '', agent });

  // Attach log stream
  if (state === 'idle' || state === 'plan_done') {
    clearTerminal(false);
    wsSend({ type: 'subscribe_logs', containerId: id });
    activeContainerId = id;
    setActiveContainerLabel(id);
    $('cancelBtn').disabled = false;
    $('abortBtn').disabled  = false;
    $('terminalTitle').textContent = 'Log View — ' + id.slice(0, 12);
  }
});

// ── Action buttons ────────────────────────────────────────────────────────────

$('planBtn').addEventListener('click', () => {
  const cfg = validateConfig();
  if (!cfg) return;
  lastConfig = cfg;
  clearTerminal();
  term.writeln('\x1b[35m[plan mode] Starting interactive planning session…\x1b[0m\r\n');
  wsSend({ type: 'plan_container', config: cfg });
});

$('startBtn').addEventListener('click', () => {
  const cfg = validateConfig();
  if (!cfg) return;
  lastConfig = cfg;
  clearTerminal();
  term.writeln('\x1b[32m[start] Launching agent…\x1b[0m\r\n');
  wsSend({ type: 'start_container', config: cfg, mode: 'normal' });
});

$('resumeBtn').addEventListener('click', () => {
  const cfg = validateConfig();
  if (!cfg) return;
  lastConfig = cfg;
  clearTerminal();
  term.writeln('\x1b[34m[resume] Resuming last session…\x1b[0m\r\n');
  wsSend({ type: 'start_container', config: cfg, mode: 'resume' });
});

$('newBtn').addEventListener('click', () => {
  if (!confirm('This will wipe all saved session state. Continue?')) return;
  const cfg = validateConfig();
  if (!cfg) return;
  lastConfig = cfg;
  clearTerminal();
  term.writeln('\x1b[33m[new session] Clearing state and starting fresh…\x1b[0m\r\n');
  wsSend({ type: 'start_container', config: cfg, mode: 'new' });
});

$('cancelBtn').addEventListener('click', () => {
  if (!activeContainerId) return;
  term.writeln('\r\n\x1b[33m[cancel] Sending graceful stop (generates report)…\x1b[0m');
  wsSend({ type: 'stop_container', containerId: activeContainerId });
});

$('abortBtn').addEventListener('click', () => {
  if (!confirm('Force kill the container? This will NOT save a report.')) return;
  if (!activeContainerId) return;
  term.writeln('\r\n\x1b[31m[abort] Force killing container…\x1b[0m');
  wsSend({ type: 'abort_container', containerId: activeContainerId });
});

$('execPlanBtn').addEventListener('click', () => {
  const cfg = lastConfig || validateConfig();
  if (!cfg) return;
  clearTerminal();
  term.writeln('\x1b[32m[execute plan] Running agent on planned work…\x1b[0m\r\n');
  wsSend({ type: 'start_container', config: cfg, mode: 'normal' });
  enterState('running');
  $('execPlanBtn').classList.add('hidden');
});

// ── Terminal toolbar ──────────────────────────────────────────────────────────

$('clearTermBtn').addEventListener('click', () => clearTerminal(false));

$('downloadLogsBtn').addEventListener('click', () => {
  const blob = new Blob([logBuffer], { type: 'text/plain' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = `archon-${Date.now()}.log`;
  a.click();
  URL.revokeObjectURL(url);
});

function clearTerminal(resetBuffer = true) {
  term.clear();
  if (resetBuffer) logBuffer = '';
}

// ── Chat UI helpers ───────────────────────────────────────────────────────────

/**
 * Append a bubble to the chat panel.
 * type: 'agent' | 'user' | 'system'
 * Returns the bubble element.
 */
function appendChatBubble(type, text = '') {
  const messages = $('chatMessages');
  const wrap = document.createElement('div');
  wrap.className = `chat-bubble chat-bubble-${type}`;

  const textEl = document.createElement('pre');
  textEl.className = 'bubble-text';
  textEl.textContent = text;
  wrap.appendChild(textEl);
  messages.appendChild(wrap);
  return wrap;
}

/**
 * Replace the streaming <pre> text in an agent bubble with rendered markdown.
 * Called once per agent message when chat_message_end arrives.
 */
function renderBubbleMarkdown(bubble) {
  const textEl = bubble.querySelector('.bubble-text');
  if (!textEl || !bubble._rawText) return;
  try {
    const html = marked.parse(bubble._rawText, { breaks: true, gfm: true });
    const div = document.createElement('div');
    div.className = 'bubble-markdown';
    div.innerHTML = html;
    textEl.replaceWith(div);
  } catch (_) {
    // keep plain text if marked fails
  }
}

function scrollChatToBottom() {
  const el = $('chatMessages');
  if (el) el.scrollTop = el.scrollHeight;
}

function showChatTyping() {
  $('chatTyping').classList.remove('hidden');
}

function hideChatTyping() {
  $('chatTyping').classList.add('hidden');
}

function sendChatMessage() {
  const input = $('chatInput');
  const text  = input.value;
  if (!text.trim()) return;

  // Show user bubble
  appendChatBubble('user', text);
  scrollChatToBottom();

  // Send to server
  wsSend({ type: 'chat_input', text });

  input.value = '';
  input.style.height = 'auto';
  showChatTyping();
}

$('chatSendBtn').addEventListener('click', sendChatMessage);

$('chatInput').addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendChatMessage();
  }
});

// Auto-resize textarea
$('chatInput').addEventListener('input', function () {
  this.style.height = 'auto';
  this.style.height = Math.min(this.scrollHeight, 180) + 'px';
});

// ── Dev logs panel ────────────────────────────────────────────────────────────
// Logs are ALWAYS captured in the background; the panel just shows/hides them.

let devPanelOpen = false;
let devLogBuffer = '';
let devSearchQuery = '';

function setDevPanelOpen(open) {
  devPanelOpen = open;
  const btn   = $('devLogsBtn');
  const panel = $('devLogPanel');
  if (open) {
    btn.classList.add('btn-active');
    panel.classList.remove('hidden');
    // Request a state dump from server now that panel is visible
    wsSend({ type: 'toggle_dev_logs' });
    // Scroll to bottom
    const pre = $('devLogContent');
    if (pre) pre.parentElement.scrollTop = pre.parentElement.scrollHeight;
  } else {
    btn.classList.remove('btn-active');
    panel.classList.add('hidden');
  }
}

function appendDevLog(text) {
  const ts   = new Date().toISOString().slice(11, 23); // HH:MM:SS.mmm
  const line = `[${ts}] ${text}\n`;
  devLogBuffer += line;

  // Update inline panel
  const el = $('devLogContent');
  if (el) {
    if (!devSearchQuery || line.toLowerCase().includes(devSearchQuery)) {
      el.textContent += line;
      const wrap = el.parentElement;
      const nearBottom = wrap.scrollHeight - wrap.scrollTop - wrap.clientHeight < 80;
      if (nearBottom) wrap.scrollTop = wrap.scrollHeight;
    }
  }

  // Also update modal if open
  const modal = $('devLogsModal');
  if (modal && !modal.classList.contains('hidden')) {
    const mc = $('devLogContentModal');
    const mq = $('devLogSearchModal').value.toLowerCase().trim();
    if (!mq || line.toLowerCase().includes(mq)) {
      mc.textContent += line;
      const nearBottom = mc.scrollHeight - mc.scrollTop - mc.clientHeight < 80;
      if (nearBottom) mc.scrollTop = mc.scrollHeight;
    }
  }
}

function applyDevSearch(query) {
  devSearchQuery = query.toLowerCase().trim();
  const el = $('devLogContent');
  if (!el) return;
  if (!devSearchQuery) {
    el.textContent = devLogBuffer;
  } else {
    const lines = devLogBuffer.split('\n');
    el.textContent = lines.filter(l => l.toLowerCase().includes(devSearchQuery)).join('\n');
  }
  const wrap = el.parentElement;
  wrap.scrollTop = wrap.scrollHeight;
}

$('devLogsBtn').addEventListener('click', () => setDevPanelOpen(!devPanelOpen));

$('clearDevLogsBtn').addEventListener('click', () => {
  devLogBuffer = '';
  const el = $('devLogContent');
  if (el) el.textContent = '';
});

$('downloadDevLogsBtn').addEventListener('click', () => {
  const blob = new Blob([devLogBuffer], { type: 'text/plain' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = `dev-logs-${Date.now()}.txt`;
  a.click();
  URL.revokeObjectURL(url);
});

$('devLogSearch').addEventListener('input', e => applyDevSearch(e.target.value));

// ── Dev logs fullscreen modal ─────────────────────────────────────────────────

function openDevLogsModal() {
  const modal = $('devLogsModal');
  const modalContent = $('devLogContentModal');
  // Sync content
  const query = $('devLogSearch').value.toLowerCase().trim();
  if (!query) {
    modalContent.textContent = devLogBuffer;
  } else {
    modalContent.textContent = devLogBuffer.split('\n')
      .filter(l => l.toLowerCase().includes(query)).join('\n');
  }
  $('devLogSearchModal').value = $('devLogSearch').value;
  modal.classList.remove('hidden');
  modalContent.scrollTop = modalContent.scrollHeight;
}

function closeDevLogsModal() {
  $('devLogsModal').classList.add('hidden');
}

$('expandDevLogsBtn').addEventListener('click', openDevLogsModal);
$('closeDevLogsModalBtn').addEventListener('click', closeDevLogsModal);
$('devLogsModalBackdrop').addEventListener('click', closeDevLogsModal);

$('devLogSearchModal').addEventListener('input', e => {
  const q = e.target.value.toLowerCase().trim();
  const mc = $('devLogContentModal');
  if (!q) {
    mc.textContent = devLogBuffer;
  } else {
    mc.textContent = devLogBuffer.split('\n').filter(l => l.toLowerCase().includes(q)).join('\n');
  }
  mc.scrollTop = mc.scrollHeight;
  // Keep inline search in sync
  $('devLogSearch').value = e.target.value;
  applyDevSearch(e.target.value);
});

$('downloadDevLogsModalBtn').addEventListener('click', () => {
  const blob = new Blob([devLogBuffer], { type: 'text/plain' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url; a.download = `dev-logs-${Date.now()}.txt`; a.click();
  URL.revokeObjectURL(url);
});

// Escape key closes the modal
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') closeDevLogsModal();
});

// ── Launch progress panel ─────────────────────────────────────────────────────

const STEP_LABELS = {
  validate: 'Validating configuration',
  docker:   'Connecting to Docker',
  image:    'Checking agent image',
  create:   'Creating container',
  attach:   'Attaching log stream',
};

function showLaunchProgress(visible) {
  const panel = $('launchProgress');
  if (!panel) return;
  if (visible) {
    panel.classList.remove('hidden');
    if (!$('lpSteps').children.length) {
      // Pre-populate all steps as pending
      Object.entries(STEP_LABELS).forEach(([id, label]) => {
        const li = document.createElement('li');
        li.className = 'lp-step pending';
        li.id = `lp-${id}`;
        li.innerHTML = `<span class="lp-icon"></span><span class="lp-text">${label}</span>`;
        $('lpSteps').appendChild(li);
      });
    }
  } else {
    panel.classList.add('hidden');
    $('lpSteps').innerHTML = '';
    setProgressTitle('Launching…', '');
  }
}

function setProgressStep(id, text, status) {
  // Ensure panel is open and pre-populated
  showLaunchProgress(true);
  let li = $(`lp-${id}`);
  if (!li) {
    li = document.createElement('li');
    li.id = `lp-${id}`;
    $('lpSteps').appendChild(li);
  }
  li.className = `lp-step ${status}`;
  li.innerHTML = `<span class="lp-icon"></span><span class="lp-text">${text}</span>`;
  // Update title to show current active step
  if (status === 'active') setProgressTitle(text, '');
  if (status === 'ok' && id === 'attach') setProgressTitle('Agent starting…', '');
}

function setProgressTitle(text, state) {
  const el = $('lpTitle');
  if (!el) return;
  el.textContent = text;
  el.className = `lp-title${state ? ' ' + state : ''}`;
}

// ── Docker status ─────────────────────────────────────────────────────────────

async function checkDockerStatus() {
  try {
    const r = await fetch('/api/docker/status');
    const d = await r.json();
    const badge = $('dockerStatus');
    const label = $('dockerLabel');
    if (d.connected) {
      badge.textContent = '● Connected';
      badge.className   = 'badge badge-online';
      const cfg = d.config;
      label.textContent = cfg.type === 'ssh' ? `SSH: ${cfg.host}` :
                          cfg.type === 'tcp' ? `TCP: ${cfg.host}:${cfg.port}` : 'Local Docker';
    } else {
      badge.textContent = '● Offline';
      badge.className   = 'badge badge-error';
      label.textContent = 'Docker unreachable';
    }
  } catch (_) {}
}

// ── Image status ──────────────────────────────────────────────────────────────

async function checkImageStatus() {
  try {
    const r = await fetch('/api/image/status');
    const d = await r.json();
    const badge = $('imageStatus');
    if (d.exists) {
      badge.textContent = `✓ ${d.id}`;
      badge.className   = 'badge badge-ok';
    } else {
      badge.textContent = '✗ Not built';
      badge.className   = 'badge badge-missing';
    }
  } catch (_) {}
}

$('buildImageBtn').addEventListener('click', async () => {
  $('buildModal').classList.remove('hidden');
  const out    = $('buildOutput');
  const closeB = $('closeBuildBtn');
  out.textContent = '';
  closeB.disabled = true;

  try {
    const resp = await fetch('/api/image/build', { method: 'POST' });
    const reader = resp.body.getReader();
    const dec    = new TextDecoder();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = dec.decode(value);
      out.textContent += chunk;
      out.scrollTop    = out.scrollHeight;
    }
    checkImageStatus();
  } catch (err) {
    out.textContent += `\n❌ ${err.message}`;
  }

  closeB.disabled = false;
});

$('closeBuildBtn').addEventListener('click', () => $('buildModal').classList.add('hidden'));
$('buildModalBackdrop').addEventListener('click', () => $('buildModal').classList.add('hidden'));

// ── Remote Docker modal ───────────────────────────────────────────────────────

$('remoteBtn').addEventListener('click', () => $('remoteModal').classList.remove('hidden'));
$('cancelDockerBtn').addEventListener('click', () => $('remoteModal').classList.add('hidden'));
$('remoteModalBackdrop').addEventListener('click', () => $('remoteModal').classList.add('hidden'));

// Show/hide SSH/TCP fields based on radio selection
document.querySelectorAll('input[name="dockerType"]').forEach(radio => {
  radio.addEventListener('change', () => {
    $('sshFields').classList.toggle('hidden', radio.value !== 'ssh');
    $('tcpFields').classList.toggle('hidden', radio.value !== 'tcp');
  });
});

$('testDockerBtn').addEventListener('click', async () => {
  const cfg    = getDockerCfg();
  const result = $('dockerTestResult');
  result.classList.remove('hidden', 'success', 'failure');
  result.textContent = 'Testing…';

  try {
    const r = await fetch('/api/docker/connect', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(cfg),
    });
    const d = await r.json();
    if (d.success) {
      result.textContent = '✓ Connected successfully';
      result.classList.add('success');
      checkDockerStatus();
    } else {
      result.textContent = `✗ ${d.error}`;
      result.classList.add('failure');
    }
  } catch (err) {
    result.textContent = `✗ ${err.message}`;
    result.classList.add('failure');
  }
});

$('connectDockerBtn').addEventListener('click', async () => {
  const cfg = getDockerCfg();
  try {
    const r = await fetch('/api/docker/connect', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(cfg),
    });
    const d = await r.json();
    if (d.success) {
      $('remoteModal').classList.add('hidden');
      checkDockerStatus();
      toast('Docker host connected', 'success');
    } else {
      toast(`Connection failed: ${d.error}`, 'error');
    }
  } catch (err) {
    toast(err.message, 'error');
  }
});

function getDockerCfg() {
  const type = document.querySelector('input[name="dockerType"]:checked')?.value || 'local';
  if (type === 'ssh') {
    return {
      type,
      host:     $('sshHost').value.trim(),
      port:     parseInt($('sshPort').value) || 22,
      username: $('sshUser').value.trim(),
      keyPath:  $('sshKeyPath').value.trim(),
      password: $('sshPassword').value,
    };
  }
  if (type === 'tcp') {
    return {
      type,
      host: $('tcpHost').value.trim(),
      port: parseInt($('tcpPort').value) || 2375,
    };
  }
  return { type: 'local' };
}

// ── Refresh button ────────────────────────────────────────────────────────────

$('refreshContainersBtn').addEventListener('click', () => {
  listContainers();
  checkDockerStatus();
  checkImageStatus();
});

$('clearFormBtn').addEventListener('click', () => {
  if (!confirm('Clear all saved settings (tokens, keys, instructions)?')) return;
  fetch('/api/config', { method: 'DELETE' }).catch(() => {});
  ALL_FIELDS.forEach(id => { const el = $(id); if (el) el.value = ''; });
  ALL_CHECKBOXES.forEach(id => { const el = $(id); if (el) el.checked = false; });
  $('useHostInstructions').checked = true;
  $('agent').value = 'copilot';
  updateAgentFields('copilot');
  clearFieldErrors();
  checkSetupHint();
  toast('All saved settings cleared', 'info');
});

// ── Agent selector: show/hide per-agent fields + card ─────────────────────────
function updateAgentFields(agent) {
  document.querySelectorAll('.agent-fields').forEach(el => el.style.display = 'none');
  const active = document.getElementById('agentFields-' + agent);
  if (active) active.style.display = '';
  renderAgentCard(agent);
}

$('agent').addEventListener('change', () => {
  updateAgentFields($('agent').value);
  saveForm();
  updateCredentialsBadge();
});

// ── Switch Agent button ────────────────────────────────────────────────────────
$('switchAgentBtn').addEventListener('click', () => {
  const newAgent = $('switchAgentSelect').value;
  $('agent').value = newAgent;
  updateAgentFields(newAgent);
  saveForm();
  const info = AGENT_INFO[newAgent] || { name: newAgent };
  toast(`Agent switched to ${info.name} — update API key if needed, then click ▶ Start`, 'info');
  // Scroll config into view
  $('agent').scrollIntoView({ behavior: 'smooth', block: 'center' });
  $('agent').focus();
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function $(id) { return document.getElementById(id); }

function setStatus(msg, type = 'info') {
  $('statusMsg').textContent = msg;
  $('statusMsg').style.color = type === 'error' ? 'var(--red)' :
                               type === 'ok'    ? 'var(--green)' : '';
}

function setActiveContainerLabel(id) {
  $('activeContainerLabel').textContent = id ? `container: ${id.slice(0, 12)}` : '';
}

function sendResize() {
  const dims = fitAddon.proposeDimensions();
  if (dims) {
    wsSend({ type: 'resize_terminal', cols: dims.cols, rows: dims.rows });
  }
}

let toastTimer = null;
function toast(msg, type = 'info') {
  let el = $('toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast';
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.className   = `toast-${type}`;
  el.style.opacity = '1';
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.style.opacity = '0'; }, 3500);
}

// Sync resize to container when terminal panel resizes
const termResizeObs = new ResizeObserver(() => {
  fitAddon.fit();
  if (state === 'planning') sendResize();
});
termResizeObs.observe(document.getElementById('terminal'));

// ── Electron integration ──────────────────────────────────────────────────────

const isElectron = !!(window.electronAPI?.isElectron);

if (isElectron) {
  // Show Electron badge in header
  const badge = document.createElement('span');
  badge.textContent = '⚡ App';
  badge.className   = 'badge badge-electron';
  badge.title       = 'Running as native Electron app';
  document.querySelector('.header-right')?.prepend(badge);

  // Wire native folder picker to project path field
  const projectInput = $('projectPath');
  if (projectInput) {
    const browseBtn = document.createElement('button');
    browseBtn.textContent = '📁';
    browseBtn.title       = 'Browse for project folder';
    browseBtn.className   = 'btn btn-icon browse-btn';
    browseBtn.type        = 'button';
    browseBtn.addEventListener('click', async () => {
      const folder = await window.electronAPI.selectDirectory();
      if (folder) {
        projectInput.value = folder;
        saveForm();
      }
    });
    projectInput.parentNode.style.display = 'flex';
    projectInput.parentNode.style.gap     = '6px';
    projectInput.parentNode.insertBefore(browseBtn, projectInput.nextSibling);
  }

  // Wire native file picker to task file field
  const taskFileInput = $('taskFile');
  if (taskFileInput) {
    const browseTaskBtn = document.createElement('button');
    browseTaskBtn.textContent = '📄';
    browseTaskBtn.title       = 'Browse for task file';
    browseTaskBtn.className   = 'btn btn-icon browse-btn';
    browseTaskBtn.type        = 'button';
    browseTaskBtn.addEventListener('click', async () => {
      const file = await window.electronAPI.selectFile([
        { name: 'Markdown / Text', extensions: ['md', 'txt', 'task'] },
        { name: 'All Files', extensions: ['*'] },
      ]);
      if (file) {
        taskFileInput.value = file;
        saveForm();
      }
    });
    taskFileInput.parentNode.style.display = 'flex';
    taskFileInput.parentNode.style.gap     = '6px';
    taskFileInput.parentNode.insertBefore(browseTaskBtn, taskFileInput.nextSibling);
  }

  // Wire native file picker to SA key file field
  const keyFileInput = $('gcloudKeyFile');
  if (keyFileInput) {
    const browseKeyBtn = document.createElement('button');
    browseKeyBtn.textContent = '🔑';
    browseKeyBtn.title       = 'Browse for service account key';
    browseKeyBtn.className   = 'btn btn-icon browse-btn';
    browseKeyBtn.type        = 'button';
    browseKeyBtn.addEventListener('click', async () => {
      const file = await window.electronAPI.selectFile([
        { name: 'JSON Key', extensions: ['json'] },
      ]);
      if (file) {
        keyFileInput.value = file;
        saveForm();
      }
    });
    keyFileInput.parentNode.style.display = 'flex';
    keyFileInput.parentNode.style.gap     = '6px';
    keyFileInput.parentNode.insertBefore(browseKeyBtn, keyFileInput.nextSibling);
  }

  // Handle File > Open Project Folder… menu item
  window.electronAPI.onOpenProject(folder => {
    if (folder && $('projectPath')) {
      $('projectPath').value = folder;
      saveForm();
      toast(`Project set: ${folder}`, 'info');
    }
  });
}

// ── Init ──────────────────────────────────────────────────────────────────────

(async () => {
  await loadForm();                          // fetch all config from server
  checkSetupHint();
  updateAgentFields($('agent').value);       // show/hide fields based on saved agent
  updateButtons();
  updateTerminalTitle();
  connectWS();

  // Periodic container list refresh
  setInterval(listContainers, 10000);
})();
