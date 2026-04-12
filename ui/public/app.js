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
// Don't fit yet — terminal panel starts hidden; fit when first shown
try { fitAddon.fit(); } catch (_) {}
term.writeln('\x1b[90mArchon — ready.\x1b[0m\r\n');

// Resize observer → keep xterm fitted (safe if panel is hidden)
const resizeObs = new ResizeObserver(() => {
  try { if (!$('terminalPanel')?.classList.contains('hidden')) fitAddon.fit(); } catch (_) {}
});
resizeObs.observe(document.getElementById('terminalPanel'));

window.addEventListener('resize', () => {
  try { if (!$('terminalPanel')?.classList.contains('hidden')) fitAddon.fit(); } catch (_) {}
});

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
let containerStartedAt = 0;
let lastConfig        = null;
let pendingPlanConfig = null;  // held while waiting for plan_session_info check
let logBuffer         = '';
let containerRefreshTimer = null;
// ── Planning wizard state ────────────────────────────────────────────────────
let planningState = {
  decisions: [],        // { id, title, answer, step }
  analysis: [],         // { title, body, step }
  currentQuestion: null,
  step: 'requirements',
  completedSteps: [],
  agentTurnBuffer: '',  // accumulates streaming text for current agent reply
};

// ── Screen management ────────────────────────────────────────────────────────
// screen controls which panel is visible (orthogonal to state machine)

let screen = 'home'; // 'home' | 'planning' | 'execution'

function setScreen(newScreen) {
  screen = newScreen;
  $('homeScreen')?.classList.toggle('hidden', newScreen !== 'home');
  $('terminalPanel')?.classList.toggle('hidden', newScreen === 'home');
  $('homeBtn')?.classList.toggle('hidden', newScreen === 'home');
  if (newScreen === 'execution') {
    $('chatPanel')?.classList.add('hidden');
    $('terminal')?.classList.remove('hidden');
    setTimeout(() => { try { fitAddon.fit(); } catch (_) {} }, 50);
  }
  if (newScreen === 'home') {
    renderAgentCards();
    updateHomeButtons();
  }
}

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
        // Accumulate streaming text; show thinking spinner
        planningState.agentTurnBuffer += (msg.text || '');
        showThinking(true);
        break;
      }

      case 'chat_message_end': {
        // Parse the full agent turn and dispatch to wizard UI
        const turnText = planningState.agentTurnBuffer;
        planningState.agentTurnBuffer = '';
        if (turnText) processAgentTurn(turnText);
        break;
      }

      case 'chat_history': {
        // Replay saved assistant messages through the tag parser
        const msgs = msg.messages || [];
        msgs.forEach(m => {
          if (m.role === 'assistant' && m.content) {
            processAgentTurn(m.content);
          }
        });
        break;
      }

      case 'quota_update': {
        updateQuotaBadge(msg.remaining, msg.limit, msg.provider, msg.reset);
        break;
      }

      case 'plan_step': {
        updateProgressRail(msg.stepId, msg.done);
        break;
      }

      case 'plan_session_info': {
        const cfg = pendingPlanConfig;
        pendingPlanConfig = null;
        if (!cfg) break;
        // Show terminal panel so resume prompt / launch progress is visible
        setScreen('execution');
        if (msg.exists && msg.meta) {
          showResumePrompt(msg.meta, cfg);
        } else {
          launchPlan(cfg, false);
        }
        break;
      }

      case 'chat_typing': {
        showThinking(true);
        break;
      }

      case 'chat_system': {
        // System messages are shown as toast notifications
        toast(msg.text, 'info');
        break;
      }
      // ──────────────────────────────────────────────────────────────────────

      case 'container_started':
        activeContainerId = msg.containerId;
        containerStartedAt = Date.now();
        setActiveContainerLabel(msg.containerId);
        if (msg.mode === 'plan') {
          enterState('planning');
          updateChatHeader(msg.agent, msg.model);
          if (!msg.resumed) {
            resetPlanningState();
            initProgressRail();
            updatePlanningContext();
            showThinking(true);
          }
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

  // Screen transitions
  if (newState === 'planning') {
    setScreen('planning');
    $('terminal').classList.add('hidden');
    $('chatPanel').classList.remove('hidden');
    updatePlanningContext();
    requestAnimationFrame(() => $('chatInput')?.focus());
  } else if (newState === 'running') {
    setScreen('execution');
    $('terminal').classList.remove('hidden');
    $('chatPanel').classList.add('hidden');
  } else if (newState === 'plan_done') {
    // Stay on planning screen to show planReadyCard
  } else if (newState === 'idle') {
    setScreen('home');
    resetPlanningState();
    toggleModelPicker(true);
    _chatHeaderAgent = '';
    updateQuotaBadge(null, null, null);
  }

  showLaunchProgress(false);
}

function updateButtons() {
  const idle     = state === 'idle';
  const active   = state === 'planning' || state === 'running';
  const planDone = state === 'plan_done';

  if ($('planBtn'))  $('planBtn').disabled  = active || planDone;
  if ($('startBtn')) $('startBtn').disabled = active || planDone;
  if ($('cancelBtn')) $('cancelBtn').disabled = idle || planDone;
  if ($('abortBtn'))  $('abortBtn').disabled  = idle || planDone;
  if ($('execPlanBtn')) $('execPlanBtn').classList.toggle('hidden', !planDone);
  updateHomeButtons();
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
  custom: {
    name: 'Custom (OpenAI-compatible)',
    desc: 'Any OpenAI-compatible API endpoint: Together, Groq, OpenRouter, local Ollama, etc.',
    link: 'https://openrouter.ai/keys',
    linkText: 'OpenRouter keys ↗',
    color: 'var(--text-muted)',
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
  // Setup hint removed — home screen replaces it
  updateCredentialsBadge();
  updateHomeButtons();
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
  const modelMap = { copilot: 'copilotModel', claude: 'claudeModel', gemini: 'geminiModel' };
  return {
    projectPath:          $('projectPath').value.trim(),
    agent:                agent,
    model:                $(modelMap[agent])?.value || '',
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
    customApiBase:        $('customApiBase')?.value.trim() || '',
    customApiKey:         $('customApiKey')?.value.trim() || '',
    customModel:          $('customModel')?.value.trim() || '',
    mcpServers:           mcpServers,
  };
}

function validateConfig() {
  clearFieldErrors();
  const cfg = getConfig();
  let valid = true;
  let credError = false;

  if (!cfg.projectPath) {
    setFieldError('projectPath', 'Project path is required');
    toast('Enter a project path', 'warning');
    valid = false;
  }
  if (cfg.agent === 'copilot' && !cfg.ghToken) {
    setFieldError('ghToken', 'GitHub Token is required');
    credError = true; valid = false;
  }
  if (cfg.agent === 'claude' && !cfg.anthropicApiKey) {
    setFieldError('anthropicApiKey', 'Anthropic API Key is required');
    credError = true; valid = false;
  }
  if (cfg.agent === 'gemini' && !cfg.geminiApiKey) {
    setFieldError('geminiApiKey', 'Gemini API Key is required');
    credError = true; valid = false;
  }
  if (cfg.agent === 'aider' && !cfg.anthropicApiKey && !cfg.openaiApiKey && !cfg.geminiApiKey) {
    credError = true; valid = false;
  }
  if (cfg.agent === 'custom' && (!cfg.customApiBase || !cfg.customApiKey)) {
    if (!cfg.customApiBase) setFieldError('customApiBase', 'API Base URL is required');
    if (!cfg.customApiKey) setFieldError('customApiKey', 'API Key is required');
    credError = true; valid = false;
  }

  // Open settings drawer to credentials tab if key is missing
  if (credError) {
    toast('API key required — configure in Settings', 'warning');
    $('settingsDrawer')?.classList.remove('hidden');
    document.querySelectorAll('.drawer-tab').forEach(t => t.classList.remove('is-active'));
    document.querySelectorAll('.drawer-tab-panel').forEach(p => p.classList.remove('is-active'));
    document.querySelector('[data-tab="credentials"]')?.classList.add('is-active');
    document.querySelector('[data-panel="credentials"]')?.classList.add('is-active');
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
  'copilotModel','claudeModel','geminiModel',
  'ghToken','anthropicApiKey','geminiApiKey','openaiApiKey',
  'anthropicApiKey2','geminiApiKey2','aiderModel',
  'instructionsRepo','instructionsFile','instructionsBranch',
  'gitUserName','gitUserEmail','flutterVersion','goVersion',
  'firebaseProjectId','gcloudKeyFile','firebaseTestDevice',
  'sessionName','projectPath','task','taskFile',
  'customApiBase','customApiKey','customModel',
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
    // Load MCP servers
    if (Array.isArray(data.mcpServers)) { mcpServers = data.mcpServers; renderMcpServers(); }
  } catch (_) {}
}

// Auto-save on any input change; hide setup hint once user starts
document.querySelectorAll('.input-field, input[type="checkbox"]').forEach(el => {
  el.addEventListener('change', () => { saveForm(); checkSetupHint(); });
  el.addEventListener('input',  () => { saveForm(); checkSetupHint(); });
});

// ── Model discovery ───────────────────────────────────────────────────────────

const MODEL_TOKEN_FIELD = { copilot: 'ghToken', claude: 'anthropicApiKey', gemini: 'geminiApiKey' };
const MODEL_SELECT_ID   = { copilot: 'copilotModel', claude: 'claudeModel', gemini: 'geminiModel' };

async function fetchModels(agent) {
  const tokenField = MODEL_TOKEN_FIELD[agent];
  const selectId   = MODEL_SELECT_ID[agent];
  if (!tokenField || !selectId) return;

  const token = $(tokenField)?.value.trim();
  if (!token) return;

  const select = $(selectId);
  if (!select) return;
  const prevValue = select.value;

  select.disabled = true;
  const loadingOpt = document.createElement('option');
  loadingOpt.value = '';
  loadingOpt.textContent = 'Fetching models…';
  select.insertBefore(loadingOpt, select.firstChild);
  select.value = '';

  try {
    const res  = await fetch(`/api/models?agent=${encodeURIComponent(agent)}&token=${encodeURIComponent(token)}`);
    const data = await res.json();
    if (data.error) throw new Error(data.error);

    // Rebuild the <select> with live models
    select.innerHTML = '';
    data.models.forEach(m => {
      const opt = document.createElement('option');
      opt.value       = m.id;
      opt.textContent = m.name !== m.id ? `${m.id} — ${m.name}` : m.id;
      select.appendChild(opt);
    });

    // Restore previous selection if still present
    if (prevValue && [...select.options].some(o => o.value === prevValue)) {
      select.value = prevValue;
    }
    saveForm();
    syncHeaderModelSelect(); // keep header in sync if we're in a chat session
  } catch (e) {
    // On error, remove the loading option and show a brief error
    loadingOpt.remove();
    select.disabled = false;
    console.warn('[models] fetch failed:', e.message);
    // Show error inline using first option's text temporarily
    const errOpt = document.createElement('option');
    errOpt.value = prevValue;
    errOpt.textContent = `⚠️ ${e.message.slice(0, 60)}`;
    select.insertBefore(errOpt, select.firstChild);
    select.value = prevValue;
    setTimeout(() => { errOpt.remove(); if (!select.value) select.value = prevValue; }, 4000);
    return;
  }
  select.disabled = false;
}

// Refresh models when token field loses focus (and has a value)
Object.entries(MODEL_TOKEN_FIELD).forEach(([agent, fieldId]) => {
  const el = $(fieldId);
  if (!el) return;
  el.addEventListener('blur', () => {
    if (el.value.trim()) fetchModels(agent);
  });
});

// Refresh button (↻) next to each model label
document.querySelectorAll('.btn-fetch-models').forEach(btn => {
  btn.addEventListener('click', () => fetchModels(btn.dataset.agent));
});

// Auto-fetch after loadForm if token is already saved
async function fetchAllSavedModels() {
  for (const agent of ['copilot', 'claude', 'gemini']) {
    const tok = $(MODEL_TOKEN_FIELD[agent])?.value.trim();
    if (tok) await fetchModels(agent);
  }
}

// ── Container list ────────────────────────────────────────────────────────────

function listContainers() {
  wsSend({ type: 'list_containers' });
}

function renderContainerList(containers) {
  // Populate hidden containerSelect for backward compat
  const sel = $('containerSelect');
  if (sel) {
    const prev = sel.value;
    sel.innerHTML = '';
    if (!containers || containers.length === 0) {
      sel.innerHTML = '<option value="">— none —</option>';
    } else {
      sel.innerHTML = '<option value="">Select…</option>';
      containers.forEach(c => {
        const opt = document.createElement('option');
        opt.value = c.id;
        opt.dataset.agent = c.agent || 'copilot';
        opt.textContent = c.sessionName || c.shortId || c.id.slice(0, 12);
        sel.appendChild(opt);
      });
      if (prev && containers.find(c => c.id === prev)) sel.value = prev;
    }
  }
  // Populate home screen sessions list
  renderSessionsList(containers);
}

// ── Action buttons ────────────────────────────────────────────────────────────

$('planBtn').addEventListener('click', () => {
  const cfg = validateConfig();
  if (!cfg) return;
  lastConfig = cfg;
  // Check if a saved planning session exists for this project folder
  if (cfg.projectPath) {
    wsSend({ type: 'check_plan_session', projectPath: cfg.projectPath });
    pendingPlanConfig = cfg;  // held until plan_session_info response
  } else {
    launchPlan(cfg, false);
  }
});

$('startBtn').addEventListener('click', () => {
  const cfg = validateConfig();
  if (!cfg) return;
  lastConfig = cfg;
  setScreen('execution');
  clearTerminal();
  term.writeln('\x1b[32m[start] Launching agent…\x1b[0m\r\n');
  wsSend({ type: 'start_container', config: cfg, mode: 'normal' });
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

// ── Planning wizard helpers ──────────────────────────────────────────────────

// Initialise marked once with global defaults
marked.use({ breaks: true, gfm: true });

const PLANNING_STEPS = [
  { id: 'requirements', label: 'Requirements',      icon: '📋' },
  { id: 'codebase',     label: 'Codebase Review',   icon: '🔍' },
  { id: 'gaps',         label: 'Gaps & Unknowns',   icon: '❓' },
  { id: 'approach',     label: 'Technical Approach', icon: '🏗️' },
  { id: 'testing',      label: 'Testing Strategy',   icon: '🧪' },
  { id: 'plan',         label: 'Final Plan',         icon: '✅' },
];

/** Parse a complete agent turn into structured blocks */
function parseAgentTurn(text) {
  const result = { step: null, stepDone: false, analysis: [], question: null, plan: null };

  const stepMatch = text.match(/<STEP:(\w+)>/);
  if (stepMatch) result.step = stepMatch[1];

  const stepDoneMatch = text.match(/<STEP_DONE:(\w+)>/);
  if (stepDoneMatch) { result.step = stepDoneMatch[1]; result.stepDone = true; }

  // Extract all ANALYSIS blocks
  const analysisRe = /<ANALYSIS title="([^"]*)">([\s\S]*?)<\/ANALYSIS>/g;
  let m;
  while ((m = analysisRe.exec(text)) !== null) {
    result.analysis.push({ title: m[1], body: m[2].trim() });
  }

  // Extract QUESTION block (JSON)
  const questionMatch = text.match(/<QUESTION>([\s\S]*?)<\/QUESTION>/);
  if (questionMatch) {
    try { result.question = JSON.parse(questionMatch[1].trim()); }
    catch (e) { console.warn('[wizard] bad QUESTION JSON:', e); }
  }

  // Extract PLAN block
  const planMatch = text.match(/<PLAN_START>([\s\S]*?)<PLAN_END>/);
  if (planMatch) result.plan = planMatch[1].trim();

  return result;
}

/** Process a completed agent turn — dispatch to wizard UI zones */
function processAgentTurn(text) {
  const parsed = parseAgentTurn(text);

  if (parsed.step) {
    updateProgressRail(parsed.step, parsed.stepDone);
  }

  parsed.analysis.forEach(a => {
    appendAnalysisItem(a.title, a.body, planningState.step);
  });

  if (parsed.plan) {
    showPlanReady(parsed.plan);
    return;
  }

  if (parsed.stepDone) {
    showStepDone(parsed.step);
    return;
  }

  if (parsed.question) {
    renderQuestionCard(parsed.question);
    return;
  }

  // If we got analysis but no question/step_done/plan, show a waiting state
  // This shouldn't happen with the updated prompt, but handles edge cases
  // If we got analysis but no question, just hide thinking — content is visible in the flow
  showThinking(false);
}

/** Populate the progress rail with step dots */
function initProgressRail() {
  const ol = $('progressSteps');
  if (!ol) return;
  ol.innerHTML = '';
  PLANNING_STEPS.forEach(step => {
    const li = document.createElement('li');
    li.className = 'progress-step';
    li.id = `progress-${step.id}`;
    li.innerHTML = `<span class="progress-step-dot"></span><span class="progress-step-label">${step.icon} ${step.label}</span>`;
    ol.appendChild(li);
  });
  updateProgressRail(planningState.step, false);
}

/** Populate the left sidebar with session context */
function updatePlanningContext() {
  const ctx = $('planningContext');
  if (!ctx) return;
  const project = (lastConfig?.projectPath || $('projectPath')?.value || '').trim();
  const task = (lastConfig?.task || lastConfig?.copilotTask || $('task')?.value || '').trim();
  const agent = lastConfig?.agent || $('agent')?.value || 'copilot';
  const sessionName = (lastConfig?.sessionName || $('sessionName')?.value || '').trim();
  const agentName = (AGENT_INFO[agent]?.name || agent).split('(')[0].trim();
  ctx.innerHTML = `
    <div class="panel-context-item"><span class="panel-context-label">project</span><br><span class="panel-context-value">${project.split(/[/\\]/).pop() || project || '—'}</span></div>
    ${sessionName ? `<div class="panel-context-item"><span class="panel-context-label">session</span><br><span class="panel-context-value">${sessionName}</span></div>` : ''}
    ${task ? `<div class="panel-context-item"><span class="panel-context-label">task</span><br><span class="panel-context-value">${task.length > 72 ? task.slice(0, 72) + '…' : task}</span></div>` : ''}
    <div class="panel-context-item"><span class="panel-context-label">agent</span><br><span class="panel-context-value">${agentName}</span></div>`;
}

/** Update progress rail active/done states */
function updateProgressRail(stepId, done) {
  if (!stepId) return;
  planningState.step = stepId;
  if (done && !planningState.completedSteps.includes(stepId)) {
    planningState.completedSteps.push(stepId);
  }
  PLANNING_STEPS.forEach(step => {
    const el = $(`progress-${step.id}`);
    if (!el) return;
    el.classList.remove('is-active', 'is-done');
    if (planningState.completedSteps.includes(step.id)) {
      el.classList.add('is-done');
    } else if (step.id === stepId && !done) {
      el.classList.add('is-active');
    }
  });
}

/** Show/hide thinking spinner */
function showThinking(visible) {
  const card = $('thinkingCard');
  if (card) card.classList.toggle('hidden', !visible);
}

/** Render a typed question card in the center pane */
function renderQuestionCard(question) {
  const flow = $('planningFlow');
  if (!flow || !question) return;

  planningState.currentQuestion = question;
  const type = question.type || 'choice';

  // Remove any previous active question card
  flow.querySelectorAll('.question-card-active').forEach(el => el.remove());

  const card = document.createElement('div');
  card.className = 'question-card question-card-active';

  let optionsHtml = '';
  if (type === 'choice' || type === 'confirm' || type === 'multi') {
    optionsHtml = (question.options || []).map((opt, i) => {
      const isRec = opt.recommended;
      const val = (opt.value || opt.label || '').replace(/"/g, '&quot;');
      return `<button class="qc-chip${isRec ? ' qc-chip-rec' : ''}" data-index="${i}" data-value="${val}" data-action="pick">${opt.label || opt.value}</button>`;
    }).join('');
  } else if (type === 'text' || type === 'number') {
    const inputType = type === 'number' ? 'number' : 'text';
    const defaultVal = question.default || '';
    optionsHtml = `<input class="qc-inline-input" type="${inputType}" placeholder="${question.placeholder || 'Type your answer...'}" value="${defaultVal}">
      <button class="qc-chip qc-chip-rec" data-action="submit">confirm</button>
      <button class="qc-chip qc-chip-ghost" data-action="skip">skip</button>`;
  }

  card.innerHTML = `
    <div class="qc-question-line">${question.title || question.text || 'Question'}</div>
    <div class="qc-choices">${optionsHtml}${type === 'choice' || type === 'confirm' || type === 'multi' ? '<button class="qc-chip qc-chip-ghost" data-action="skip">skip</button>' : ''}</div>`;

  // Wire chip clicks — picking an option submits immediately
  card.querySelectorAll('[data-action="pick"]').forEach(chip => {
    chip.addEventListener('click', () => {
      if (type === 'multi') {
        chip.classList.toggle('qc-chip-selected');
      } else {
        // Single choice — select and submit
        card.querySelectorAll('[data-action="pick"]').forEach(c => c.classList.remove('qc-chip-selected'));
        chip.classList.add('qc-chip-selected');
        submitQuestionAnswer();
      }
    });
  });
  card.querySelector('[data-action="submit"]')?.addEventListener('click', () => submitQuestionAnswer());
  card.querySelector('[data-action="skip"]')?.addEventListener('click', () => submitQuestionAnswer(false, true));

  flow.appendChild(card);
  $('thinkingCard')?.classList.add('hidden');
  // Scroll to the question
  card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

/** Submit the user's answer for the current question card */
function submitQuestionAnswer(useRec = false, skip = false) {
  const q = planningState.currentQuestion;
  if (!q) return;

  const card = document.querySelector('.question-card-active');
  const type = q.type || 'choice';
  let answerText = '';
  let answerLabel = '';

  if (skip) {
    answerText = 'Skipping this question — use your best judgment.';
    answerLabel = 'Skipped';
  } else if (useRec) {
    const rec = (q.options || []).find(o => o.recommended);
    answerText = `I'll go with your recommendation: ${rec?.label || rec?.value || 'recommended option'}.`;
    answerLabel = rec?.label || 'Recommended';
  } else if (type === 'text' || type === 'number') {
    const input = card?.querySelector('.qc-inline-input');
    answerText = input?.value || q.default || '';
    answerLabel = answerText || '(empty)';
    if (!answerText.trim()) { toast('Please enter a value', 'warning'); return; }
  } else if (type === 'multi') {
    const selected = card?.querySelectorAll('.qc-chip-selected') || [];
    if (!selected.length) { toast('Select at least one option', 'warning'); return; }
    const labels = [...selected].map(el => el.textContent.replace(' ✓', '').trim());
    answerText = `Selected: ${labels.join(', ')}`;
    answerLabel = labels.join(', ');
  } else {
    const selected = card?.querySelector('.qc-chip-selected');
    if (!selected) { toast('Select an option', 'warning'); return; }
    answerLabel = selected.textContent.replace(' ✓', '').trim();
    answerText = answerLabel;
  }

  // Record decision in sidebar
  appendDecisionChip(q.id || q.title, q.title || q.text, answerLabel, planningState.step);

  // Send answer to agent
  wsSend({ type: 'chat_input', text: answerText });

  // Remove the active question card from the flow
  document.querySelectorAll('.question-card-active').forEach(el => el.remove());
  planningState.currentQuestion = null;
  showThinking(true);
}

/** Add a collapsible analysis card to the analysis drawer */
function appendAnalysisItem(title, body, stepId) {
  const flow = $('planningFlow');
  if (!flow) return;

  const stepLabel = PLANNING_STEPS.find(s => s.id === stepId)?.label || stepId;

  const item = document.createElement('div');
  item.className = 'analysis-item is-open';

  const header = document.createElement('div');
  header.className = 'analysis-item-header';
  header.innerHTML = `
    <span class="analysis-item-caret">▸</span>
    <span class="analysis-item-title">${title}</span>
    <span class="analysis-item-step">${stepLabel}</span>`;

  const bodyEl = document.createElement('div');
  bodyEl.className = 'analysis-item-body';
  try { bodyEl.innerHTML = marked.parse(body); }
  catch (e) { bodyEl.textContent = body; }

  header.addEventListener('click', () => {
    item.classList.toggle('is-open');
    header.querySelector('.analysis-item-caret').textContent = item.classList.contains('is-open') ? '▾' : '▸';
  });

  item.appendChild(header);
  item.appendChild(bodyEl);
  flow.appendChild(item);

  planningState.analysis.push({ title, body, step: stepId });
  // Scroll to latest
  item.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

/** Add a decision chip to the decisions sidebar */
function appendDecisionChip(id, title, answer, stepId) {
  const list = $('decisionsList');
  if (!list) return;

  const empty = list.querySelector('.decisions-empty');
  if (empty) empty.remove();

  const stepLabel = PLANNING_STEPS.find(s => s.id === stepId)?.label || stepId;

  const chip = document.createElement('div');
  chip.className = 'decision-chip';
  chip.innerHTML = `
    <div class="decision-step">${stepLabel}</div>
    <div class="decision-title">${title}</div>
    <div class="decision-answer">${answer}</div>`;

  list.prepend(chip);
  planningState.decisions.push({ id, title, answer, step: stepId });
  const count = $('decisionsCount');
  if (count) count.textContent = planningState.decisions.length;
}

/** Show the "step complete" card with advance button */
function showStepDone(stepId) {
  const flow = $('planningFlow');
  if (!flow) return;
  const stepLabel = PLANNING_STEPS.find(s => s.id === stepId)?.label || stepId;

  const card = document.createElement('div');
  card.className = 'step-done-card';
  card.innerHTML = `
    <span class="sd-icon">✓</span>
    <span class="sd-body"><strong>${stepLabel}</strong> complete.</span>
    <button class="btn btn-primary btn-sm" onclick="document.querySelectorAll('.step-done-card').forEach(e=>e.remove()); wsSend({type:'advance_step'}); showThinking(true);">Continue →</button>`;

  flow.appendChild(card);
  $('thinkingCard')?.classList.add('hidden');
  card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

/** Show the final plan inline */
function showPlanReady(planMarkdown) {
  const flow = $('planningFlow');
  if (!flow) return;

  // Render plan as an analysis item
  appendAnalysisItem('Final Plan', planMarkdown, 'plan');

  // Add execute button
  const card = document.createElement('div');
  card.className = 'plan-ready-card';
  card.innerHTML = `
    <span class="pr-body">Plan ready — review above, then execute.</span>
    <button class="btn btn-start btn-sm" id="execPlanBtnInline">▶ Execute Plan</button>`;
  flow.appendChild(card);

  card.querySelector('#execPlanBtnInline')?.addEventListener('click', () => {
    const cfg = lastConfig || validateConfig();
    if (!cfg) return;
    clearTerminal();
    term.writeln('\\x1b[32m[execute plan] Running agent on planned work…\\x1b[0m\\r\\n');
    wsSend({ type: 'start_container', config: cfg, mode: 'normal' });
    enterState('running');
  });

  $('thinkingCard')?.classList.add('hidden');
  card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

/** Reset wizard state and clear all UI zones */
function resetPlanningState() {
  planningState = {
    decisions: [], analysis: [], currentQuestion: null,
    step: 'requirements', completedSteps: [], agentTurnBuffer: '',
  };
  const dl = $('decisionsList');
  if (dl) dl.innerHTML = '<div class="decisions-empty">Choices you make appear here.</div>';
  const flow = $('planningFlow');
  if (flow) flow.innerHTML = '';
  const dc = $('decisionsCount');
  if (dc) dc.textContent = '0';
  showThinking(false);
}

/** Send freeform text via the chat escape hatch */
function sendChatText(text, clearInput = false) {
  if (!text.trim()) return false;
  wsSend({ type: 'chat_input', text });
  if (clearInput) {
    const input = $('chatInput');
    if (input) { input.value = ''; input.style.height = 'auto'; }
  }
  showThinking(true);
  return true;
}

function sendChatMessage() {
  const input = $('chatInput');
  const text  = input.value;
  if (!text.trim()) return;
  sendChatText(text, true);
}

function resizeChatInput() {
  const input = $('chatInput');
  if (!input) return;
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, 180) + 'px';
}

// ── Wizard event handlers ────────────────────────────────────────────────────

$('chatSendBtn').addEventListener('click', sendChatMessage);

$('chatInput').addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendChatMessage();
  }
});

$('chatInput').addEventListener('input', resizeChatInput);

$('advanceStepBtn').addEventListener('click', () => {
  if (ws && ws.readyState === WebSocket.OPEN) {
    wsSend({ type: 'advance_step' });
    $('stepDoneCard')?.classList.add('hidden');
    showThinking(true);
  }
});

// ── Home screen: agent cards ─────────────────────────────────────────────────

function renderAgentCards() {
  const grid = $('agentCards');
  if (!grid) return;
  grid.innerHTML = '';
  const currentAgent = $('agent')?.value || 'copilot';

  const agents = [
    { key: 'copilot', icon: '🤖', keyField: 'ghToken' },
    { key: 'claude',  icon: '🟠', keyField: 'anthropicApiKey' },
    { key: 'gemini',  icon: '🔵', keyField: 'geminiApiKey' },
    { key: 'aider',   icon: '🛠️', keyField: 'openaiApiKey' },
    { key: 'custom',  icon: '🔧', keyField: 'customApiKey' },
  ];

  agents.forEach(({ key, icon, keyField }) => {
    const info = AGENT_INFO[key];
    if (!info) return;
    const configured = $(keyField)?.value?.trim()?.length > 0;
    const card = document.createElement('div');
    card.className = `agent-pick-card${key === currentAgent ? ' is-selected' : ''}`;
    card.dataset.agent = key;
    card.innerHTML = `
      <div class="agent-pick-icon">${icon}</div>
      <div class="agent-pick-name">${info.name.split('(')[0].split(' —')[0].trim()}</div>
      <div class="agent-pick-badge ${configured ? '' : 'not-configured'}">${configured ? '✓ Ready' : 'Setup needed'}</div>`;

    card.addEventListener('click', () => {
      grid.querySelectorAll('.agent-pick-card').forEach(c => c.classList.remove('is-selected'));
      card.classList.add('is-selected');
      $('agent').value = key;
      updateAgentFields(key);
      saveForm();
      updateHomeButtons();
    });
    grid.appendChild(card);
  });
}

function updateHomeButtons() {
  const hasProject = ($('projectPath')?.value || '').trim().length > 0;
  const agent = $('agent')?.value || 'copilot';
  const keyMap = { copilot: 'ghToken', claude: 'anthropicApiKey', gemini: 'geminiApiKey', aider: 'openaiApiKey', custom: 'customApiKey' };
  const hasKey = ($(keyMap[agent])?.value || '').trim().length > 0;
  const canStart = hasProject && hasKey && state === 'idle';
  if ($('planBtn'))  $('planBtn').disabled  = !canStart;
  if ($('startBtn')) $('startBtn').disabled = !canStart;
}

// ── Home screen: sessions list ───────────────────────────────────────────────

function renderSessionsList(containers) {
  const list = $('sessionsList');
  if (!list) return;
  if (!containers || containers.length === 0) {
    list.innerHTML = '<div class="sessions-empty">No active sessions</div>';
    return;
  }
  list.innerHTML = '';
  containers.forEach(c => {
    const displayName = c.sessionName || c.shortId || c.id?.slice(0, 12) || '?';
    const item = document.createElement('div');
    item.className = 'session-item';
    const statusColor = c.state === 'running' ? 'var(--green)' : 'var(--text-dim)';
    const agentInfo = AGENT_INFO[c.agent] || { name: c.agent || 'Agent' };
    item.innerHTML = `
      <span style="color:${statusColor};font-size:10px">●</span>
      <div style="flex:1;min-width:0">
        <div style="font-size:13px;font-weight:500;color:var(--text)">${displayName}</div>
        <div style="font-size:11px;color:var(--text-muted)">${c.project || ''} · ${agentInfo.name.split(' ')[0]} · ${c.status || c.state || ''}</div>
      </div>
      <span style="font-size:10px;color:var(--text-dim)">${c.mode || ''}</span>`;
    item.addEventListener('click', () => {
      setScreen('execution');
      clearTerminal(false);
      wsSend({ type: 'subscribe_logs', containerId: c.id });
      activeContainerId = c.id;
      setActiveContainerLabel(c.id);
      $('cancelBtn').disabled = false;
      $('abortBtn').disabled  = false;
      $('terminalTitle').textContent = 'Log View — ' + (c.sessionName || c.shortId || c.id.slice(0, 12));
    });
    list.appendChild(item);
  });
}

// ── Home button (back to home) ───────────────────────────────────────────────

$('homeBtn')?.addEventListener('click', () => {
  if (state === 'planning' || state === 'running') {
    if (!confirm('Return to home? Active session continues in background.')) return;
  }
  setScreen('home');
});

// ── Settings drawer ──────────────────────────────────────────────────────────

$('settingsBtn')?.addEventListener('click', () => $('settingsDrawer')?.classList.remove('hidden'));
$('headerSettingsBtn')?.addEventListener('click', () => $('settingsDrawer')?.classList.remove('hidden'));
$('closeSettingsBtn')?.addEventListener('click', () => $('settingsDrawer')?.classList.add('hidden'));
$('settingsBackdrop')?.addEventListener('click', () => $('settingsDrawer')?.classList.add('hidden'));

document.querySelectorAll('.drawer-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.drawer-tab').forEach(t => t.classList.remove('is-active'));
    document.querySelectorAll('.drawer-tab-panel').forEach(p => p.classList.remove('is-active'));
    tab.classList.add('is-active');
    document.querySelector(`[data-panel="${tab.dataset.tab}"]`)?.classList.add('is-active');
  });
});

// ── MCP Server config ────────────────────────────────────────────────────────

let mcpServers = [];

function renderMcpServers() {
  const list = $('mcpServerList');
  if (!list) return;
  list.innerHTML = '';
  mcpServers.forEach((srv, idx) => {
    const entry = document.createElement('div');
    entry.className = 'mcp-server-entry';
    entry.innerHTML = `
      <div class="mcp-server-header">
        <input class="mcp-server-name" type="text" placeholder="Server name" value="${srv.name || ''}">
        <button class="mcp-server-remove btn btn-ghost btn-xs">✕</button>
      </div>
      <label class="field-label">Transport</label>
      <select class="mcp-server-transport input-field">
        <option value="stdio" ${srv.transport !== 'sse' ? 'selected' : ''}>stdio (command)</option>
        <option value="sse" ${srv.transport === 'sse' ? 'selected' : ''}>SSE (URL)</option>
      </select>
      <div class="mcp-stdio-fields" ${srv.transport === 'sse' ? 'style="display:none"' : ''}>
        <label class="field-label">Command</label>
        <input class="mcp-server-command input-field" type="text" placeholder="npx -y @modelcontextprotocol/server-filesystem" value="${srv.command || ''}">
        <label class="field-label">Args (space-separated)</label>
        <input class="mcp-server-args input-field" type="text" placeholder="/path/to/dir" value="${srv.args || ''}">
      </div>
      <div class="mcp-sse-fields" ${srv.transport !== 'sse' ? 'style="display:none"' : ''}>
        <label class="field-label">URL</label>
        <input class="mcp-server-url input-field" type="text" placeholder="http://localhost:8080/sse" value="${srv.url || ''}">
      </div>
      <label class="field-label">Env (KEY=VALUE, comma-separated)</label>
      <input class="mcp-server-env input-field" type="text" placeholder="API_KEY=xxx" value="${srv.env || ''}">`;

    // Wire transport toggle
    const transportSel = entry.querySelector('.mcp-server-transport');
    transportSel.addEventListener('change', () => {
      entry.querySelector('.mcp-stdio-fields').style.display = transportSel.value === 'sse' ? 'none' : '';
      entry.querySelector('.mcp-sse-fields').style.display = transportSel.value === 'sse' ? '' : 'none';
      saveMcpConfig();
    });

    // Wire remove
    entry.querySelector('.mcp-server-remove').addEventListener('click', () => {
      mcpServers.splice(idx, 1);
      renderMcpServers();
      saveMcpConfig();
    });

    // Auto-save on change
    entry.querySelectorAll('input, select').forEach(el => {
      el.addEventListener('change', () => syncMcpEntry(entry, idx));
      el.addEventListener('input', () => syncMcpEntry(entry, idx));
    });

    list.appendChild(entry);
  });
}

function syncMcpEntry(entry, idx) {
  mcpServers[idx] = {
    name: entry.querySelector('.mcp-server-name')?.value || '',
    transport: entry.querySelector('.mcp-server-transport')?.value || 'stdio',
    command: entry.querySelector('.mcp-server-command')?.value || '',
    args: entry.querySelector('.mcp-server-args')?.value || '',
    url: entry.querySelector('.mcp-server-url')?.value || '',
    env: entry.querySelector('.mcp-server-env')?.value || '',
  };
  saveMcpConfig();
}

function saveMcpConfig() {
  clearTimeout(_saveTimer);
  _saveTimer = setTimeout(() => {
    fetch('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mcpServers }),
    }).catch(() => {});
  }, 800);
}

$('addMcpServerBtn')?.addEventListener('click', () => {
  mcpServers.push({ name: '', transport: 'stdio', command: '', args: '', url: '', env: '' });
  renderMcpServers();
  saveMcpConfig();
});

// ── Project stats ────────────────────────────────────────────────────────────

async function fetchProjectStats() {
  const path = ($('projectPath')?.value || '').trim();
  const el = $('projectStats');
  if (!path || !el) { if (el) el.classList.add('hidden'); return; }
  try {
    const res = await fetch(`/api/project/stats?path=${encodeURIComponent(path)}`);
    const data = await res.json();
    if (data.exists) {
      el.textContent = `${data.totalFiles} files${data.truncated ? '+' : ''} · ${(data.languages || []).join(', ') || 'unknown'}`;
      el.classList.remove('hidden');
    } else {
      el.classList.add('hidden');
    }
  } catch { if (el) el.classList.add('hidden'); }
}

$('projectPath')?.addEventListener('blur', () => { fetchProjectStats(); updateHomeButtons(); });
$('projectPath')?.addEventListener('input', () => updateHomeButtons());

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
    panel.classList.remove('hidden', 'lp-done', 'lp-error');
    if (!$('lpSteps').children.length) {
      Object.entries(STEP_LABELS).forEach(([id, label]) => {
        const li = document.createElement('li');
        li.className = 'lp-step pending';
        li.id = `lp-${id}`;
        li.innerHTML = `<span class="lp-icon"></span><span class="lp-text">${label}</span>`;
        $('lpSteps').appendChild(li);
      });
    }
  } else {
    // Mark done → auto-collapse via CSS transition after 1.5s
    panel.classList.add('lp-done');
    setTimeout(() => {
      panel.classList.add('hidden');
      panel.classList.remove('lp-done');
      $('lpSteps').innerHTML = '';
      setProgressTitle('Launching…');
    }, 1500);
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
}

// ── Plan launch helpers ───────────────────────────────────────────────────────

function launchPlan(cfg, resume) {
  clearTerminal();
  term.writeln('\x1b[35m[plan mode] Starting interactive planning session…\x1b[0m\r\n');
  wsSend({ type: 'plan_container', config: cfg, resume });
}

function showResumePrompt(meta, cfg) {
  const prompt = $('resumePlanPrompt');
  if (!prompt) { launchPlan(cfg, false); return; }

  const savedAt  = new Date(meta.savedAt);
  const timeAgo  = formatTimeAgo(savedAt);
  $('rppStep').textContent  = meta.stepLabel || meta.currentStep;
  $('rppTime').textContent  = timeAgo;
  $('rppCount').textContent = `${meta.messageCount} message${meta.messageCount !== 1 ? 's' : ''}`;
  if (meta.taskPreview) $('rppTask').textContent = meta.taskPreview + (meta.taskPreview.length >= 80 ? '…' : '');

  prompt.classList.remove('hidden');

  $('rppResumeBtn').onclick = () => { prompt.classList.add('hidden'); launchPlan(cfg, true); };
  $('rppFreshBtn').onclick  = () => { prompt.classList.add('hidden'); launchPlan(cfg, false); };
  $('rppCancelBtn').onclick = () => { prompt.classList.add('hidden'); pendingPlanConfig = null; setScreen('home'); };
}

function formatTimeAgo(date) {
  const secs = Math.floor((Date.now() - date) / 1000);
  if (secs < 60)   return `${secs}s ago`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
  return `${Math.floor(secs / 86400)}d ago`;
}



const AGENT_ICONS = {
  copilot: '🤖', claude: '🟠', gemini: '🔵', aider: '🛠️'
};


let _chatHeaderAgent = '';
let _headerModels    = [];  // [{id, name}] for the current agent

function updateChatHeader(agent, model) {
  _chatHeaderAgent = agent || '';
  const icon = AGENT_ICONS[_chatHeaderAgent.toLowerCase()] || '🤖';
  const name = (_chatHeaderAgent || 'Agent').replace(/^\w/, c => c.toUpperCase());
  const title = $('terminalTitle');
  if (title) {
    const modelChip = model
      ? `<span id="modelChip" class="model-chip" title="Click to change model">${model} ▾</span>`
      : '';
    title.innerHTML = `<span style="margin-right:5px">${icon}</span>${name}${modelChip}`;
    $('modelChip')?.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleModelPicker();
    });
  }
  updateQuotaBadge(null, null, null);
  initProgressRail();
}

function toggleModelPicker(forceClose) {
  const picker = $('modelPicker');
  if (!picker) return;
  if (forceClose || !picker.classList.contains('hidden')) {
    picker.classList.add('hidden');
    return;
  }
  // Rebuild picker options from source select
  const srcSelId = { copilot: 'copilotModel', claude: 'claudeModel', gemini: 'geminiModel' }[_chatHeaderAgent];
  const srcSel = srcSelId ? $(srcSelId) : null;
  if (!srcSel || !srcSel.options.length) return;
  const current = srcSel.value;
  picker.innerHTML = '';
  [...srcSel.options].forEach(o => {
    const item = document.createElement('div');
    item.className = 'mp-item' + (o.value === current ? ' mp-active' : '');
    item.textContent = o.textContent;
    item.dataset.value = o.value;
    item.addEventListener('click', () => {
      switchHeaderModel(o.value);
      picker.classList.add('hidden');
    });
    picker.appendChild(item);
  });
  // Position below the chip
  const chip = $('modelChip');
  if (chip) {
    const rect = chip.getBoundingClientRect();
    picker.style.left = rect.left + 'px';
    picker.style.top  = (rect.bottom + 4) + 'px';
  }
  picker.classList.remove('hidden');
}

function switchHeaderModel(model) {
  if (!model) return;
  // Update chip text
  const chip = $('modelChip');
  if (chip) chip.textContent = model + ' ▾';
  // Mirror to config panel select
  const srcSelId = { copilot: 'copilotModel', claude: 'claudeModel', gemini: 'geminiModel' }[_chatHeaderAgent];
  if (srcSelId && $(srcSelId)) $(srcSelId).value = model;
  saveForm();
  wsSend({ type: 'switch_model', model });
  toast(`Model → ${model}`, 'success');
}

// Keep chip text in sync when fetchModels() refreshes the source dropdown
function syncHeaderModelSelect() {
  if (!_chatHeaderAgent) return;
  const chip = $('modelChip');
  if (!chip) return;
  const srcSelId = { copilot: 'copilotModel', claude: 'claudeModel', gemini: 'geminiModel' }[_chatHeaderAgent];
  const srcSel = srcSelId ? $(srcSelId) : null;
  if (srcSel?.value) chip.textContent = srcSel.value + ' ▾';
}

// Close picker when clicking outside
document.addEventListener('click', () => toggleModelPicker(true));


function updateQuotaBadge(remaining, limit, provider, reset) {
  const badge = $('quotaBadge');
  if (!badge) return;
  if (remaining === null || remaining === undefined) {
    badge.classList.add('hidden');
    return;
  }
  const rem = parseInt(remaining, 10);
  const lim = parseInt(limit, 10) || 0;
  badge.classList.remove('hidden', 'quota-ok', 'quota-warn', 'quota-low');
  const pct = lim > 0 ? rem / lim : 1;
  if (pct > 0.4)      badge.classList.add('quota-ok');
  else if (pct > 0.1) badge.classList.add('quota-warn');
  else                badge.classList.add('quota-low');
  const pctStr = (pct * 100).toFixed(1) + '%';
  const countStr = lim > 0 ? `${rem.toLocaleString()}/${lim.toLocaleString()}` : `${rem.toLocaleString()}`;
  badge.textContent = `${pctStr} left`;
  let tip = `${provider || 'API'}: ${countStr} requests remaining`;
  if (reset) {
    try {
      const resetDate = new Date(isNaN(Number(reset)) ? reset : Number(reset) * 1000);
      tip += ` · resets ${resetDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
    } catch (_) {}
  }
  badge.title = tip;
}



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
  await loadForm();
  updateAgentFields($('agent').value);
  renderAgentCards();
  updateHomeButtons();
  updateButtons();
  updateTerminalTitle();
  setScreen('home');
  connectWS();
  fetchAllSavedModels();
  fetchProjectStats();

  setInterval(listContainers, 10000);
})();
