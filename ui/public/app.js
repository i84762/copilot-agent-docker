/* ── Archon Pro — app.js ───────────────────────────────────────────────────
 *  State machine:
 *    idle       → user fills form, no active container
 *    planning   → container running in plan mode (interactive terminal)
 *    running    → container running in normal mode (log stream)
 *    plan_done  → plan mode container exited, PLAN.md created
 *    error      → something went wrong
 * ─────────────────────────────────────────────────────────────────────────── */

'use strict';

if (typeof marked !== 'undefined') {
  marked.use({ breaks: true, gfm: true });
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function $(id) { return document.getElementById(id); }

window.toggleSidebarSection = function(id) {
  const el = $(id);
  if (el) el.classList.toggle('is-collapsed');
};

function toast(msg, type = 'info') {
  const t = $('toast');
  if (!t) return;
  t.textContent = msg;
  t.className = `toast-pro toast-${type}`;
  t.classList.remove('hidden');
  setTimeout(() => t.classList.add('hidden'), 3000);
}

function setStatus(msg, type = 'info') {
  const el = $('statusMsg');
  if (!el) return;
  el.textContent = msg;
  el.style.color = type === 'error' ? 'var(--accent-red)' : '';
}

function setActiveContainerLabel(id) {
  const el = $('activeContainerLabel');
  if (el) el.textContent = id ? `[${id.slice(0, 8)}]` : '';
}

// ── Thinking / Progress ──────────────────────────────────────────────────────

let _thinkingVisible = false;
let _thinkingStart = 0;
let _thinkingTimer = null;
let _thinkingState = 'thinking'; // 'thinking' | 'rate-limited' | 'error'

function showThinking(visible) {
  const el = $('thinkingCard');
  if (!el) return;
  if (visible === _thinkingVisible) return;
  _thinkingVisible = visible;
  el.classList.toggle('hidden', !visible);

  clearInterval(_thinkingTimer);

  if (visible) {
    _thinkingStart = Date.now();
    _thinkingState = 'thinking';
    _updateThinkingUI('Agent is thinking...', '');
    $('thinkingCancelBtn')?.classList.add('hidden');

    // Tick every second to show elapsed time
    _thinkingTimer = setInterval(() => {
      const secs = Math.floor((Date.now() - _thinkingStart) / 1000);
      const elapsed = $('thinkingElapsed');
      if (elapsed) elapsed.textContent = secs > 3 ? `${secs}s` : '';

      // After 15s, show cancel button
      if (secs >= 15) $('thinkingCancelBtn')?.classList.remove('hidden');

      // After 90s, auto-stop
      if (secs >= 90) {
        appendDevLog('[error] Agent response timed out after 90s');
        showThinking(false);
        _showThinkingError('Request timed out after 90s. The agent may be rate limited.');
      }
    }, 1000);
  } else {
    const elapsed = $('thinkingElapsed');
    if (elapsed) elapsed.textContent = '';
  }
}

function setThinkingStatus(message) {
  _thinkingState = message.includes('Rate limited') ? 'rate-limited' : 'thinking';
  _updateThinkingUI(message, '');
  $('thinkingCancelBtn')?.classList.remove('hidden');
}

function _updateThinkingUI(text) {
  const txt = $('thinkingCard')?.querySelector('.thinking-text');
  if (txt) txt.textContent = text;
}

function _showThinkingError(message) {
  const flow = $('planningFlow');
  if (!flow) return;
  const err = document.createElement('div');
  err.className = 'planning-error';
  err.innerHTML = `<span class="error-text">${message}</span><button class="btn btn-ghost btn-xs planning-retry-btn">Retry</button>`;
  err.querySelector('.planning-retry-btn').addEventListener('click', () => {
    err.remove();
    // Resend the last user message
    const lastUserMsg = [...(planningState.decisions || [])].pop();
    const retryText = lastUserMsg?.answer || 'Continue from where you left off.';
    appendDevLog(`[user] Retrying: ${retryText.slice(0, 60)}`);
    wsSend({ type: 'chat_input', text: retryText });
    showThinking(true);
  });
  flow.appendChild(err);
  err.scrollIntoView({ behavior: 'smooth' });
}

function _showContinuePrompt() {
  const flow = $('planningFlow');
  if (!flow) return;
  // Remove any existing continue prompts
  flow.querySelectorAll('.continue-prompt').forEach(el => el.remove());
  const prompt = document.createElement('div');
  prompt.className = 'continue-prompt';
  prompt.innerHTML = `
    <span class="continue-text">Agent shared analysis but didn't ask a question.</span>
    <button class="btn btn-ghost btn-xs continue-btn">Ask to continue →</button>
    <button class="btn btn-ghost btn-xs continue-done-btn">Mark step done →</button>`;
  prompt.querySelector('.continue-btn').addEventListener('click', () => {
    prompt.remove();
    wsSend({ type: 'chat_input', text: 'Continue — ask your next question for this step.' });
    appendDevLog('[user] Asked agent to continue');
    showThinking(true);
  });
  prompt.querySelector('.continue-done-btn').addEventListener('click', () => {
    prompt.remove();
    wsSend({ type: 'advance_step' });
    appendDevLog('[user] Manually advanced step');
    showThinking(true);
  });
  flow.appendChild(prompt);
  prompt.scrollIntoView({ behavior: 'smooth' });
}

function _showActionableError(rawMessage) {
  const flow = $('planningFlow');
  if (!flow) { toast(rawMessage, 'error'); return; }

  // Parse the error to suggest appropriate action
  const msg = rawMessage.toLowerCase();
  let suggestion = '';
  let actions = '';

  if (msg.includes('credit') || msg.includes('balance') || msg.includes('billing') || msg.includes('quota')) {
    suggestion = 'API credits exhausted. Switch agent/model or top up your account.';
  } else if (msg.includes('rate limit') || msg.includes('429')) {
    suggestion = 'Rate limited. Wait a moment then retry.';
  } else if (msg.includes('filtered') || msg.includes('content management') || msg.includes('content filter')) {
    suggestion = 'Content filter triggered. Try a different model or rephrase your task description.';
  } else if (msg.includes('401') || msg.includes('auth') || msg.includes('token') || msg.includes('key')) {
    suggestion = 'Authentication failed. Check your API key in Settings.';
  } else {
    suggestion = 'An error occurred with the current agent.';
  }
  // All errors get the same action set — never leave user stranded
  actions = `
    <button class="btn btn-ghost btn-xs planning-retry-btn">Retry</button>
    <button class="btn btn-ghost btn-xs planning-switch-btn">Switch Agent</button>
    <button class="btn btn-ghost btn-xs planning-settings-btn">Settings</button>`;

  const err = document.createElement('div');
  err.className = 'planning-error';
  err.innerHTML = `
    <div class="error-text">${suggestion}</div>
    <div class="error-actions">${actions}</div>`;

  // Wire action buttons
  err.querySelector('.planning-retry-btn')?.addEventListener('click', () => {
    err.remove();
    const lastMsg = [...(planningState.decisions || [])].pop();
    const retryText = lastMsg?.answer || 'Continue from where you left off.';
    appendDevLog(`[user] Retrying: ${retryText.slice(0, 60)}`);
    wsSend({ type: 'chat_input', text: retryText });
    showThinking(true);
  });
  err.querySelector('.planning-switch-btn')?.addEventListener('click', () => {
    // Focus agent dropdown but keep the error card — user can retry after switching
    const sel = $('planningAgentSelect');
    if (sel) { sel.focus(); sel.click(); }
  });
  err.querySelector('.planning-settings-btn')?.addEventListener('click', () => {
    $('settingsDrawer')?.classList.remove('hidden');
  });

  flow.appendChild(err);
  err.scrollIntoView({ behavior: 'smooth' });
}

// Cancel thinking — abort waiting and show error
$('thinkingCancelBtn')?.addEventListener('click', () => {
  appendDevLog('[user] Cancelled waiting for agent');
  showThinking(false);
  _showThinkingError('Cancelled. You can type a message below to retry, or start a fresh session.');
});

function showLaunchProgress(vis) {
  const el = $('launchProgress');
  if (!el) return;
  el.classList.toggle('hidden', !vis);
  if (!vis) showThinking(false);
}

function setProgressTitle(text, status = 'active') {
  const el = $('lpTitle');
  if (el) {
    el.textContent = text;
    el.className = `lp-status-text lp-status-${status}`;
  }
}

function setProgressStep(stepId, text, status) {
  const container = $('lpSteps');
  if (!container) return;
  
  setProgressTitle(text, status);

  let stepEl = container.querySelector(`[data-step="${stepId}"]`);
  if (!stepEl) {
    stepEl = document.createElement('div');
    stepEl.className = 'lp-step-dot';
    stepEl.dataset.step = stepId;
    container.appendChild(stepEl);
  }
  stepEl.className = `lp-step-dot lp-step-${status}`;
}

// ── Developer Logging ────────────────────────────────────────────────────────

const MAX_DEV_LOGS = 1000;
let devLogLines = [];

function appendDevLog(text) {
  const now = new Date().toLocaleTimeString();
  const line = `[${now}] ${text}`;
  devLogLines.push(line);
  if (devLogLines.length > MAX_DEV_LOGS) devLogLines.shift();

  const el = $('devLogContentModal');
  if (el) {
    const div = document.createElement('div');
    div.textContent = line;
    el.appendChild(div);
    if (el.childNodes.length > MAX_DEV_LOGS) el.removeChild(el.firstChild);
    el.scrollTop = el.scrollHeight;
  }
  console.log(line);
}

function openDevLogs() {
  $('devLogsModal')?.classList.remove('hidden');
  const el = $('devLogContentModal');
  if (el) el.scrollTop = el.scrollHeight;
}

$('devLogsBtn')?.addEventListener('click', openDevLogs);
$('closeDevLogsModalBtn')?.addEventListener('click', () => $('devLogsModal').classList.add('hidden'));
$('devLogsModalBackdrop')?.addEventListener('click', () => $('devLogsModal').classList.add('hidden'));

// ── App Logic ───────────────────────────────────────────────────────────────

function updatePlanningContext() {
  const box = $('planningContextInfo');
  if (!box) return;
  const project = ($('projectPath')?.value || '').trim();
  const task = ($('task')?.value || '').trim();
  const agent = $('agent')?.value || 'copilot';
  const agentName = AGENT_INFO[agent]?.name || agent;
  const session = ($('sessionName')?.value || '').trim();
  const model = getConfig().model || 'default';

  box.innerHTML = `
    <div class="ctx-item"><span class="ctx-label">Project</span><span class="ctx-value">${project.split(/[/\\]/).pop() || project || '—'}</span></div>
    <div class="ctx-item"><span class="ctx-label">Agent</span><span class="ctx-value">${agentName} (${model})</span></div>
    ${session ? `<div class="ctx-item"><span class="ctx-label">Session</span><span class="ctx-value">${session}</span></div>` : ''}
    ${task ? `<div class="ctx-item ctx-task"><div class="ctx-task-header"><span class="ctx-label">Task</span><button class="ctx-task-expand" id="expandTaskBtn" title="View full task">⛶</button></div><div class="ctx-task-text">${task}</div></div>` : ''}
    <div class="ctx-item"><span class="ctx-label">Path</span><span class="ctx-value ctx-path">${project || '—'}</span></div>`;

  // Also update the agent/model label in the chat input area
  const label = $('planningAgentLabel');
  if (label) label.textContent = `${agentName} · ${model}`;

  // Wire expand task button
  $('expandTaskBtn')?.addEventListener('click', () => {
    const overlay = document.createElement('div');
    overlay.className = 'task-fullscreen';
    overlay.innerHTML = `
      <div class="task-fullscreen-card">
        <div class="task-fullscreen-header">
          <span>Task Description</span>
          <button class="btn btn-ghost btn-xs" id="closeTaskFullscreen">✕ Close</button>
        </div>
        <div class="task-fullscreen-body">${task}</div>
      </div>`;
    overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
    overlay.querySelector('#closeTaskFullscreen').addEventListener('click', () => overlay.remove());
    document.body.appendChild(overlay);
  });
}

function updateChatHeader(agent, model) {
  const info = AGENT_INFO[agent];
  const title = $('terminalTitle');
  if (title) title.textContent = `Planning: ${info ? info.name : agent} (${model || 'default'})`;
}

function getConfig() {
  const agent = $('agent')?.value || 'copilot';
  const modelMap = { copilot: 'copilotModel', claude: 'claudeModel', gemini: 'geminiModel' };
  return {
    projectPath: $('projectPath')?.value.trim() || '',
    agent: agent,
    model: $(modelMap[agent])?.value || '',
    ghToken: $('ghToken')?.value.trim() || '',
    anthropicApiKey: agent === 'aider' ? ($('anthropicApiKey2')?.value.trim() || '') : ($('anthropicApiKey')?.value.trim() || ''),
    geminiApiKey: agent === 'aider' ? ($('geminiApiKey2')?.value.trim() || '') : ($('geminiApiKey')?.value.trim() || ''),
    openaiApiKey: $('openaiApiKey')?.value.trim() || '',
    aiderModel: $('aiderModel')?.value.trim() || '',
    task: $('task')?.value.trim() || '',
    taskFile: $('taskFile')?.value.trim() || '',
    instructionsRepo: $('instructionsRepo')?.value.trim() || '',
    instructionsFile: $('instructionsFile')?.value.trim() || '',
    instructionsBranch: $('instructionsBranch')?.value.trim() || '',
    useHostInstructions: $('useHostInstructions')?.checked || false,
    gitUserName: $('gitUserName')?.value.trim() || '',
    gitUserEmail: $('gitUserEmail')?.value.trim() || '',
    flutterVersion: $('flutterVersion')?.value.trim() || '',
    goVersion: $('goVersion')?.value.trim() || '',
    mcpServers: mcpServers || [],
  };
}

// ── State Management ─────────────────────────────────────────────────────────

let state = 'idle';
let ws = null;
let activeContainerId = null;
let containerStartedAt = 0;
let lastConfig = null;
let pendingPlanConfig = null;
let logBuffer = '';
let mcpServers = [];
let planningState = {
  decisions: [],
  analysis: [],
  currentQuestion: null,
  step: 'requirements',
  completedSteps: [],
  agentTurnBuffer: '',
};

const AGENT_INFO = {
  copilot: { name: 'Copilot', icon: '🤖', key: 'ghToken' },
  claude: { name: 'Claude', icon: '🟠', key: 'anthropicApiKey' },
  gemini: { name: 'Gemini', icon: '🔵', key: 'geminiApiKey' },
  aider: { name: 'Aider', icon: '🛠️', key: 'openaiApiKey' },
  custom: { name: 'Custom', icon: '🔧', key: 'customApiKey' },
};

function setScreen(newScreen) {
  $('taskSection')?.classList.toggle('hidden', newScreen !== 'task');
  $('planningSection')?.classList.toggle('hidden', newScreen !== 'planning');
  $('terminalSection')?.classList.toggle('hidden', newScreen !== 'execution');

  $('planningProgressRail')?.classList.toggle('hidden', newScreen !== 'planning');
  $('decisionsSidebar')?.classList.toggle('hidden', newScreen !== 'planning');
  
  const isPlanning = newScreen === 'planning';
  $('agentSection')?.classList.toggle('hidden', isPlanning);
  $('authSection')?.classList.toggle('hidden', isPlanning);
  $('planningContextSidebar')?.classList.toggle('hidden', !isPlanning);

  // Show home button when not on task screen
  $('homeBtn')?.classList.toggle('hidden', newScreen === 'task');

  if (isPlanning) { updatePlanningContext(); populatePlanningSelects(); }
  if (newScreen === 'execution') setTimeout(() => { try { fitAddon.fit(); } catch (_) {} }, 50);
  if (newScreen === 'task') refreshUI();
}

function enterState(newState) {
  state = newState;
  const idle = state === 'idle';
  const active = state === 'planning' || state === 'running';
  const planDone = state === 'plan_done';

  if ($('planBtn')) $('planBtn').disabled = active || planDone;
  if ($('startBtn')) $('startBtn').disabled = active || planDone;
  if ($('cancelBtn')) $('cancelBtn').disabled = idle || planDone;
  if ($('abortBtn')) $('abortBtn').disabled = idle || planDone;
  if ($('execPlanBtn')) $('execPlanBtn').classList.toggle('hidden', !planDone);

  if (newState === 'planning') setScreen('planning');
  else if (newState === 'running') setScreen('execution');
  else if (newState === 'plan_done') $('planReadyCard')?.classList.remove('hidden');
  else if (newState === 'idle') { setScreen('task'); $('planReadyCard')?.classList.add('hidden'); }
}

// ── UI Refresh ───────────────────────────────────────────────────────────────

function isAgentReady(agent) {
  const info = AGENT_INFO[agent];
  if (!info) return false;
  if (agent === 'aider') return true;
  const keyField = $(info.key);
  return keyField && keyField.value.trim().length > 0;
}

function refreshUI() {
  updateCredentialsBadge();
  renderAgentCards();
  updateHomeButtons();
}

function updateHomeButtons() {
  const hasProject = ($('projectPath')?.value || '').trim().length > 0;
  const agent = $('agent')?.value || 'copilot';
  const ready = isAgentReady(agent);
  const canStart = hasProject && ready && state === 'idle';
  if ($('planBtn'))  $('planBtn').disabled  = !canStart;
  if ($('startBtn')) $('startBtn').disabled = !canStart;
}

function renderAgentCards() {
  const grid = $('agentCards');
  if (!grid) return;
  grid.innerHTML = '';
  const currentAgent = $('agent')?.value || 'copilot';

  Object.entries(AGENT_INFO).forEach(([key, info]) => {
    const ready = isAgentReady(key);
    const card = document.createElement('div');
    card.className = `agent-pick-card-pro${key === currentAgent ? ' is-selected' : ''}`;
    card.innerHTML = `
      <span class="agent-icon-sm">${info.icon}</span>
      <span class="agent-name-sm">${info.name}</span>
      <span class="badge ${ready ? 'badge-online' : 'badge-offline'}" style="margin-left:auto">${ready ? 'Ready' : 'Setup'}</span>
    `;
    card.addEventListener('click', () => {
      $('agent').value = key;
      updateAgentFields(key);
      saveForm();
      refreshUI();
    });
    grid.appendChild(card);
  });
}

function updateCredentialsBadge() {
  Object.entries(AGENT_INFO).forEach(([key, info]) => {
    const badge = $(`badge-${key}`);
    if (!badge) return;
    const ready = isAgentReady(key);
    badge.textContent = ready ? '✓' : '?';
    badge.className = `cred-badge ${ready ? 'badge-online' : 'badge-offline'}`;
  });
}

function updateAgentFields(agent) {
  document.querySelectorAll('.agent-fields-group').forEach(el => el.style.display = 'none');
  const active = document.getElementById('agentFields-' + agent);
  if (active) active.style.display = '';
}

// ── WebSocket ─────────────────────────────────────────────────────────────────

function connectWS() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${proto}//${location.host}`);

  ws.onopen = () => {
    setStatus('Connected');
    appendDevLog('[ws] Connected to backend');
    listContainers();
    checkDockerStatus();
    checkImageStatus();
  };

  ws.onclose = () => {
    setStatus('Disconnected', 'error');
    appendDevLog('[ws] Disconnected');
    setTimeout(connectWS, 3000);
  };

  ws.onmessage = ev => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch (e) { return; }
    // Only log meaningful events, skip high-frequency noise
    const QUIET = new Set(['chat_chunk','output','containers_list','connected','chat_typing','docker_status','dev_log']);
    if (!QUIET.has(msg.type)) appendDevLog(`[ws] ${msg.type}`);

    switch (msg.type) {
      case 'docker_status': if (msg.connected) checkImageStatus(); break;
      case 'output': {
        const raw = Uint8Array.from(atob(msg.data), c => c.charCodeAt(0));
        term.write(raw);
        logBuffer += new TextDecoder().decode(raw);
        break;
      }
      case 'chat_chunk': {
        const chunk = msg.text || '';
        // Internal dev log messages from server
        if (chunk.startsWith('__DEV_LOG__')) {
          appendDevLog(chunk.replace('__DEV_LOG__', ''));
          break;
        }
        planningState.agentTurnBuffer += chunk;
        showThinking(true);
        if (chunk.includes('Rate limited')) {
          appendDevLog(`[warn] ${chunk.trim()}`);
          setThinkingStatus(chunk.trim());
        }
        break;
      }
      case 'chat_message_end': {
        const turnText = planningState.agentTurnBuffer;
        planningState.agentTurnBuffer = '';
        if (turnText) {
          appendDevLog(`[plan] Agent response (${turnText.length} chars)`);
          processAgentTurn(turnText);
        } else {
          // Empty response — could be a step transition or an error already handled
          if (planningState._errorShown) {
            planningState._errorShown = false;
            appendDevLog('[plan] Empty response after error (already handled)');
          } else {
            appendDevLog('[plan] Empty response (step transition only)');
          }
          showThinking(false);
        }
        break;
      }
      case 'chat_typing': {
        showThinking(true);
        break;
      }
      case 'chat_system': {
        appendDevLog(`[system] ${msg.text}`);
        showThinking(false);
        // Show actionable error inline in the planning flow
        const isError = msg.text && (msg.text.includes('error') || msg.text.includes('Error') || msg.text.includes('filtered') || msg.text.includes('⚠️'));
        if (isError && state === 'planning') {
          planningState._errorShown = true;
          _showActionableError(msg.text);
        } else {
          toast(msg.text, isError ? 'error' : 'info');
        }
        break;
      }
      case 'plan_session_info': {
        const cfg = pendingPlanConfig;
        pendingPlanConfig = null;
        if (!cfg) break;
        if (msg.exists && msg.meta) showResumePrompt(msg.meta, cfg);
        else launchPlan(cfg, false);
        break;
      }
      case 'container_started':
        activeContainerId = msg.containerId;
        setActiveContainerLabel(msg.containerId);
        appendDevLog(`[session] Started: ${msg.mode} mode, agent=${msg.agent}, model=${msg.model || 'default'}`);
        if (msg.mode === 'plan') {
          enterState('planning');
          if (!msg.resumed) { resetPlanningState(); initProgressRail(); showThinking(true); }
          sendResize();
        } else { enterState('running'); }
        listContainers();
        break;
      case 'container_stopped':
        activeContainerId = null;
        setActiveContainerLabel(null);
        enterState(state === 'planning' ? 'plan_done' : 'idle');
        listContainers();
        break;
      case 'plan_step': {
        appendDevLog(`[plan] Step → ${msg.stepId}${msg.done ? ' (done)' : ''}`);
        updateProgressRail(msg.stepId, msg.done);
        // Auto-advance when step completes
        if (msg.done) {
          showThinking(false);
          showStepDone(msg.stepId);
        }
        break;
      }
      case 'plan_complete': enterState('plan_done'); appendDevLog('[plan] Plan complete'); toast('Plan complete', 'success'); break;
      case 'containers_list': renderContainerList(msg.containers); break;
      case 'dev_log': appendDevLog(`[server] ${msg.text}`); break;
      case 'quota_update': {
        if (msg.remaining != null) {
          const rem = parseInt(msg.remaining, 10);
          const lim = parseInt(msg.limit, 10) || 0;
          const used = lim - rem;
          const pct = lim > 0 ? ((rem / lim) * 100).toFixed(1) : '?';
          appendDevLog(`[quota] ${used.toLocaleString()} tokens used, ${rem.toLocaleString()}/${lim.toLocaleString()} remaining (${pct}%) — ${msg.provider}`);
          // Update header badge
          const badge = $('quotaBadge');
          if (badge) {
            badge.textContent = `${(used / 1000).toFixed(0)}K / ${(lim / 1000).toFixed(0)}K tokens`;
            badge.title = `${rem.toLocaleString()} tokens remaining (${pct}%) — resets every 60s`;
            badge.classList.remove('hidden');
            badge.className = `quota-badge ${pct > 50 ? '' : pct > 20 ? 'quota-warn' : 'quota-low'}`;
          }
        }
        break;
      }
      case 'error': toast(msg.message, 'error'); appendDevLog(`[error] ${msg.message}`); break;
      case 'progress': {
        showLaunchProgress(true);
        setProgressStep(msg.step, msg.text, msg.status);
        break;
      }
      case 'progress_done': {
        showLaunchProgress(false);
        break;
      }
      case 'progress_error': {
        setProgressTitle('Launch Failed', 'error');
        appendDevLog(`[ws] Progress Error: ${msg.message}`);
        break;
      }
    }
  };
}

function wsSend(obj) { if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj)); }

// ── Form Save/Load ───────────────────────────────────────────────────────────

let _saveTimer = null;
function saveForm() {
  clearTimeout(_saveTimer);
  _saveTimer = setTimeout(() => {
    const data = {};
    const fields = ['agent','copilotModel','claudeModel','geminiModel','ghToken','anthropicApiKey','geminiApiKey','openaiApiKey','instructionsRepo','instructionsFile','instructionsBranch','gitUserName','gitUserEmail','flutterVersion','goVersion','sessionName','projectPath','task','taskFile'];
    fields.forEach(id => { const el = $(id); if (el) data[id] = el.value; });
    const checks = ['useHostInstructions'];
    checks.forEach(id => { const el = $(id); if (el) data[id] = el.checked; });
    fetch('/api/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
    refreshUI();
  }, 800);
}

async function loadForm() {
  try {
    const res = await fetch('/api/config');
    if (!res.ok) return;
    const data = await res.json();
    const fields = ['agent','copilotModel','claudeModel','geminiModel','ghToken','anthropicApiKey','geminiApiKey','openaiApiKey','instructionsRepo','instructionsFile','instructionsBranch','gitUserName','gitUserEmail','flutterVersion','goVersion','sessionName','projectPath','task','taskFile'];
    fields.forEach(id => { const el = $(id); if (el && id in data) el.value = data[id]; });
    const checks = ['useHostInstructions'];
    checks.forEach(id => { const el = $(id); if (el && id in data) el.checked = data[id]; });
    updateAgentFields($('agent')?.value || 'copilot');
    refreshUI();
  } catch (_) {}
}

// ── Planning / Execution ─────────────────────────────────────────────────────

// ── Model fetching ──────────────────────────────────────────────────────────
const MODEL_TOKEN_FIELD = { copilot: 'ghToken', claude: 'anthropicApiKey', gemini: 'geminiApiKey' };
const MODEL_SELECT_ID   = { copilot: 'copilotModel', claude: 'claudeModel', gemini: 'geminiModel' };

async function fetchModels(agent) {
  const tokenField = MODEL_TOKEN_FIELD[agent];
  const selectId = MODEL_SELECT_ID[agent];
  if (!tokenField || !selectId) return;
  const token = $(tokenField)?.value?.trim();
  if (!token) return;
  const select = $(selectId);
  if (!select) return;
  const prevValue = select.value;
  try {
    const res = await fetch(`/api/models?agent=${encodeURIComponent(agent)}&token=${encodeURIComponent(token)}`);
    const data = await res.json();
    if (data.error) return;
    select.innerHTML = '';
    (data.models || []).forEach(m => {
      const opt = document.createElement('option');
      opt.value = m.id;
      opt.textContent = m.id;
      select.appendChild(opt);
    });
    if (prevValue && [...select.options].some(o => o.value === prevValue)) select.value = prevValue;
    appendDevLog(`[models] Fetched ${data.models?.length || 0} models for ${agent}`);
  } catch (e) {
    appendDevLog(`[models] Fetch failed for ${agent}: ${e.message}`);
  }
}

async function fetchAllModels() {
  for (const agent of ['copilot', 'claude', 'gemini']) {
    const tok = $(MODEL_TOKEN_FIELD[agent])?.value?.trim();
    if (tok) await fetchModels(agent);
  }
}

function launchPlan(cfg, resume = false) {
  appendDevLog(`[session] Plan ${resume ? 'resume' : 'start'}: ${cfg.projectPath}`);
  setScreen('execution');
  clearTerminal();
  wsSend({ type: 'plan_container', config: cfg, resume: resume });
}

function showResumePrompt(meta, cfg) {
  if ($('rppStep')) $('rppStep').textContent = meta.stepLabel || meta.currentStep || 'unknown';
  if ($('rppTime')) {
    const date = new Date(meta.savedAt);
    $('rppTime').textContent = isNaN(date.getTime()) ? 'Unknown' : date.toLocaleString();
  }
  if ($('rppTask')) $('rppTask').textContent = meta.taskPreview || '';
  $('resumePlanPrompt')?.classList.remove('hidden');
  const onResume = () => { $('resumePlanPrompt').classList.add('hidden'); launchPlan(cfg, true); cleanup(); };
  const onFresh = () => { $('resumePlanPrompt').classList.add('hidden'); launchPlan(cfg, false); cleanup(); };
  const cleanup = () => { 
    $('rppResumeBtn')?.removeEventListener('click', onResume); 
    $('rppFreshBtn')?.removeEventListener('click', onFresh); 
  };
  $('rppResumeBtn')?.addEventListener('click', onResume);
  $('rppFreshBtn')?.addEventListener('click', onFresh);
}

function processAgentTurn(text) {
  try {
    const parsed = parseAgentTurn(text);
    if (parsed.step) {
      appendDevLog(`[plan] Step: ${parsed.step}${parsed.stepDone ? ' (done)' : ''}`);
      updateProgressRail(parsed.step, parsed.stepDone);
    }
    if (parsed.analysis.length) appendDevLog(`[plan] ${parsed.analysis.length} analysis block(s)`);
    parsed.analysis.forEach(a => appendAnalysisItem(a.title, a.body, planningState.step));
    if (parsed.plan) { appendDevLog('[plan] Final plan received'); showPlanReady(parsed.plan); }
    else if (parsed.stepDone) showStepDone(parsed.step);
    else if (parsed.question) { appendDevLog(`[plan] Question: ${parsed.question.title || '?'}`); renderQuestionCard(parsed.question); }
    else if (parsed.analysis.length && !parsed.stepDone && !parsed.question) {
      // Agent sent analysis but no question — show a continue prompt so user isn't stuck
      appendDevLog('[plan] No question received — showing continue prompt');
      _showContinuePrompt();
    }
  } catch (err) {
    appendDevLog(`[error] processAgentTurn: ${err.message}`);
  } finally {
    showThinking(false);
  }
}

function parseAgentTurn(text) {
  const result = { step: null, stepDone: false, analysis: [], question: null, plan: null };
  const stepMatch = text.match(/<STEP:(\w+)>/);
  if (stepMatch) result.step = stepMatch[1];
  const stepDoneMatch = text.match(/<STEP_DONE:(\w+)>/);
  if (stepDoneMatch) { result.step = stepDoneMatch[1]; result.stepDone = true; }
  const analysisRe = /<ANALYSIS title="([^"]*)">([\s\S]*?)<\/ANALYSIS>/g;
  let m;
  while ((m = analysisRe.exec(text)) !== null) result.analysis.push({ title: m[1], body: m[2].trim() });
  const questionMatch = text.match(/<QUESTION>([\s\S]*?)<\/QUESTION>/);
  if (questionMatch) try { result.question = JSON.parse(questionMatch[1].trim()); } catch (e) {}
  const planMatch = text.match(/<PLAN_START>([\s\S]*?)<PLAN_END>/);
  if (planMatch) result.plan = planMatch[1].trim();
  return result;
}

function appendAnalysisItem(title, body, stepId) {
  const flow = $('planningFlow');
  if (!flow) return;
  const item = document.createElement('div');
  item.className = 'analysis-card-pro';
  item.innerHTML = `<strong>${title}</strong><div class="analysis-body">${marked.parse(body)}</div>`;
  flow.appendChild(item);
  item.scrollIntoView({ behavior: 'smooth' });
}

function updateProgressRail(stepId, done) {
  planningState.step = stepId;
  if (done && !planningState.completedSteps.includes(stepId)) planningState.completedSteps.push(stepId);
  const steps = ['requirements','codebase','gaps','approach','testing','plan'];
  steps.forEach(id => {
    const el = $(`progress-${id}`);
    if (el) {
      el.classList.toggle('is-done', planningState.completedSteps.includes(id));
      el.classList.toggle('is-active', id === stepId && !done);
    }
  });
}

const PLANNING_STEPS = [{id:'requirements',label:'Requirements',icon:'📋'},{id:'codebase',label:'Codebase',icon:'🔍'},{id:'gaps',label:'Gaps',icon:'❓'},{id:'approach',label:'Approach',icon:'🏗️'},{id:'testing',label:'Testing',icon:'🧪'},{id:'plan',label:'Final Plan',icon:'✅'}];

function initProgressRail() {
  const ol = $('progressSteps');
  if (!ol) return;
  ol.innerHTML = '';
  PLANNING_STEPS.forEach(s => {
    const li = document.createElement('li');
    li.className = 'progress-step-pro';
    li.id = `progress-${s.id}`;
    li.innerHTML = `<span>${s.icon}</span><span>${s.label}</span>`;
    li.addEventListener('click', () => jumpToStep(s.id));
    ol.appendChild(li);
  });
}

function jumpToStep(stepId) {
  if (stepId === planningState.step) return;
  const stepLabel = PLANNING_STEPS.find(s => s.id === stepId)?.label || stepId;
  if (!confirm(`Jump to "${stepLabel}" step? Current conversation will continue from that step.`)) return;
  appendDevLog(`[user] Jumping to step: ${stepId}`);
  planningState.step = stepId;
  updateProgressRail(stepId, false);
  wsSend({ type: 'chat_input', text: `Let's go back to step: ${stepLabel}. Continue from there with analysis and a question.` });
  showThinking(true);
}

function renderQuestionCard(question) {
  const flow = $('planningFlow');
  if (!flow) return;
  planningState.currentQuestion = question;
  const card = document.createElement('div');
  card.className = 'question-card-pro';
  let opts = (question.options || []).map((o, i) => `<button class="qc-chip ${o.recommended ? 'qc-chip-rec' : ''}" data-index="${i}">${o.label || o.value}</button>`).join('');
  if (question.type === 'text' || question.type === 'number') opts = `<input class="qc-inline-input" type="text" placeholder="${question.placeholder || ''}"><button class="qc-chip qc-chip-rec" data-action="submit">Confirm</button>`;
  card.innerHTML = `<div class="qc-question-line">${question.title || question.text}</div><div class="qc-choices">${opts}</div>`;
  card.querySelectorAll('.qc-chip').forEach(btn => btn.addEventListener('click', () => {
    if (btn.dataset.action === 'submit') submitQuestionAnswer();
    else { btn.classList.add('qc-chip-selected'); submitQuestionAnswer(); }
  }));
  flow.appendChild(card);
  card.scrollIntoView({ behavior: 'smooth' });
}

function submitQuestionAnswer() {
  const q = planningState.currentQuestion;
  const card = document.querySelector('.question-card-pro:last-child');
  if (!card) { appendDevLog('[error] No question card found to submit'); return; }
  let ans = q.type === 'text' || q.type === 'number' ? card.querySelector('input')?.value : card.querySelector('.qc-chip-selected')?.textContent || '';
  if (!ans) { appendDevLog('[error] No answer selected'); toast('Select an option first', 'warning'); return; }
  appendDevLog(`[user] Answered "${q.title || '?'}": ${ans}`);
  appendDecisionChip(q.id || q.title, q.title || q.text, ans, planningState.step);
  wsSend({ type: 'chat_input', text: ans });
  card.remove();
  showThinking(true);
}

function appendDecisionChip(id, title, answer, stepId) {
  const list = $('decisionsList');
  if (!list) return;
  if (list.querySelector('.decisions-empty')) list.innerHTML = '';
  const chip = document.createElement('div');
  chip.className = 'decision-chip-pro';
  chip.innerHTML = `<div class="decision-title">${title}</div><div class="decision-answer">✓ ${answer}</div>`;
  list.prepend(chip);
  planningState.decisions.push({ id, title, answer, step: stepId });
  $('decisionsCount').textContent = planningState.decisions.length;
}

function showStepDone(stepId) {
  const flow = $('planningFlow');
  if (!flow) return;

  // Count how many decisions were made in this step
  const stepDecisions = planningState.decisions.filter(d => d.step === stepId).length;
  const expectedMin = { requirements: 3, codebase: 2, gaps: 3, approach: 5, testing: 3 };
  const min = expectedMin[stepId] || 2;
  const tooFewQuestions = stepDecisions < min;

  const card = document.createElement('div');
  card.className = 'step-done-card-pro';
  if (tooFewQuestions) {
    card.innerHTML = `
      <div class="sdc-warning">
        <strong>⚠ Only ${stepDecisions} decision${stepDecisions === 1 ? '' : 's'} recorded for this step.</strong>
        Typical planning needs ${min}+ for autonomous execution. Continue anyway or ask the agent for more detail?
      </div>
      <div class="sdc-actions">
        <button class="btn btn-ghost btn-sm sdc-more">Ask for more detail</button>
        <button class="btn btn-primary btn-sm sdc-continue">Continue anyway →</button>
      </div>`;
  } else {
    card.innerHTML = `
      <div><strong>✓ Step complete</strong> — ${stepDecisions} decision${stepDecisions === 1 ? '' : 's'} recorded</div>
      <button class="btn btn-primary btn-sm sdc-continue">Continue →</button>`;
  }

  card.querySelector('.sdc-continue')?.addEventListener('click', () => {
    card.remove();
    wsSend({ type: 'advance_step' });
    showThinking(true);
  });
  card.querySelector('.sdc-more')?.addEventListener('click', () => {
    card.remove();
    wsSend({ type: 'chat_input', text: `The current step needs more depth before we move on. Go through the step ${stepId} checklist and ask me any remaining decisions one by one.` });
    appendDevLog('[user] Requested more detail for step');
    showThinking(true);
  });
  flow.appendChild(card);
  card.scrollIntoView({ behavior: 'smooth' });
}

function showPlanReady(plan) {
  appendAnalysisItem('Final Plan', plan, 'plan');

  // Show inline final action card in the flow
  const flow = $('planningFlow');
  if (flow) {
    flow.querySelectorAll('.plan-final-card').forEach(e => e.remove());
    const card = document.createElement('div');
    card.className = 'plan-final-card';
    card.innerHTML = `
      <div class="pfc-title">✅ Plan Complete</div>
      <div class="pfc-desc">PLAN.md has been saved to your project. Ready to execute?</div>
      <div class="pfc-actions">
        <button class="btn btn-primary btn-sm pfc-execute">▶ Execute Plan (Run Agent)</button>
        <button class="btn btn-ghost btn-sm pfc-review">Review & Edit First</button>
        <button class="btn btn-ghost btn-sm pfc-download">Download PLAN.md</button>
      </div>`;
    card.querySelector('.pfc-execute').addEventListener('click', () => {
      const cfg = getConfig();
      appendDevLog('[user] Executing plan');
      wsSend({ type: 'start_container', config: cfg, mode: 'normal' });
      enterState('running');
    });
    card.querySelector('.pfc-review').addEventListener('click', () => {
      jumpToStep('approach');
    });
    card.querySelector('.pfc-download').addEventListener('click', () => {
      const blob = new Blob([plan], { type: 'text/markdown' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = 'PLAN.md'; a.click();
      URL.revokeObjectURL(url);
    });
    flow.appendChild(card);
    card.scrollIntoView({ behavior: 'smooth' });
  }

  $('planReadyCard')?.classList.remove('hidden');
}

// ── Xterm / Terminal ─────────────────────────────────────────────────────────

const term = new Terminal({ theme: { background: '#000000', foreground: '#e6edf3', cursor: '#e6edf3', selection: 'rgba(56,139,253,0.3)', black: '#484f58', brightBlack: '#6e7681', red: '#f85149', green: '#3fb950', yellow: '#d29922', blue: '#388bfd', magenta: '#a371f7', cyan: '#39c5cf', white: '#b1bac4', brightWhite: '#e6edf3' }, fontFamily: "'Cascadia Code', 'Consolas', monospace", fontSize: 13, lineHeight: 1.35, cursorBlink: true, scrollback: 5000 });
const fitAddon = new FitAddon.FitAddon();
term.loadAddon(fitAddon);
const terminalEl = document.getElementById('terminal');
if (terminalEl) term.open(terminalEl);
try { fitAddon.fit(); } catch (_) {}
term.writeln('\x1b[90mArchon — ready.\x1b[0m\r\n');

window.addEventListener('resize', () => { try { if (!$('terminalSection').classList.contains('hidden')) fitAddon.fit(); } catch (_) {} });
term.onData(data => { wsSend({ type: 'terminal_input', data: btoa(data) }); });

function clearTerminal() { term.clear(); logBuffer = ''; }
function listContainers() { wsSend({ type: 'list_containers' }); }
function renderContainerList(containers) {
  const list = $('sessionsList');
  if (!list) return;
  if (!containers?.length) { list.innerHTML = '<div class="sessions-empty">No active agents</div>'; return; }
  list.innerHTML = containers.map(c => `<div class="session-item-pro" onclick="subscribeLogs('${c.id}')"><span class="status-dot ${c.state}"></span><div class="session-info"><div class="session-name">${c.sessionName || c.shortId}</div><div class="session-meta">${c.agent} · ${c.project}</div></div></div>`).join('');
}
window.subscribeLogs = (id) => { setScreen('execution'); term.clear(); wsSend({ type: 'subscribe_logs', containerId: id }); activeContainerId = id; setActiveContainerLabel(id); };
function sendResize() { const dims = fitAddon.proposeDimensions(); if (dims) wsSend({ type: 'resize_terminal', cols: dims.cols, rows: dims.rows }); }

// ── Events ───────────────────────────────────────────────────────────────────

document.querySelectorAll('.input-field, .input-field-dark, input[type="checkbox"]').forEach(el => { el.addEventListener('change', saveForm); el.addEventListener('input', saveForm); });
$('planBtn')?.addEventListener('click', () => {
  const cfg = getConfig();
  if (!cfg.projectPath) {
    toast('Project path required','error');
    return;
  }
  pendingPlanConfig = cfg;
  appendDevLog(`[session] Checking for saved session: ${cfg.projectPath}`);
  wsSend({ type: 'check_plan_session', projectPath: cfg.projectPath });
});
$('startBtn')?.addEventListener('click', () => { const cfg = getConfig(); if (!cfg.projectPath) { toast('Project path required','error'); return; } setScreen('execution'); term.clear(); wsSend({ type: 'start_container', config: cfg, mode: 'normal' }); });
$('execPlanBtn')?.addEventListener('click', () => { const cfg = getConfig(); wsSend({ type: 'start_container', config: cfg, mode: 'normal' }); enterState('running'); $('planReadyCard').classList.add('hidden'); });
$('headerSettingsBtn')?.addEventListener('click', () => { $('settingsDrawer')?.classList.remove('hidden'); });
$('homeBtn')?.addEventListener('click', () => {
  if (state === 'planning' || state === 'running') {
    if (!confirm('Return to home? Active session continues in background.')) return;
  }
  enterState('idle');
});
$('sidebarSettingsBtn')?.addEventListener('click', () => { $('settingsDrawer')?.classList.remove('hidden'); });
// Populate agent/model selects in planning input area
function populatePlanningSelects() {
  const agentSel = $('planningAgentSelect');
  const modelSel = $('planningModelSelect');
  if (!agentSel || !modelSel) return;

  const currentAgent = $('agent')?.value || 'copilot';

  // Populate agent select
  agentSel.innerHTML = '';
  Object.entries(AGENT_INFO).forEach(([key, info]) => {
    const opt = document.createElement('option');
    opt.value = key;
    opt.textContent = info.name;
    if (key === currentAgent) opt.selected = true;
    agentSel.appendChild(opt);
  });

  // Populate model select for current agent
  syncPlanningModelSelect(currentAgent);
}

function syncPlanningModelSelect(agentKey) {
  const modelSel = $('planningModelSelect');
  if (!modelSel) return;
  const modelSelects = { copilot: 'copilotModel', claude: 'claudeModel', gemini: 'geminiModel' };
  const srcSel = $(modelSelects[agentKey]);

  modelSel.innerHTML = '';
  if (srcSel && srcSel.options.length) {
    [...srcSel.options].forEach(opt => {
      const o = document.createElement('option');
      o.value = opt.value;
      o.textContent = opt.value;
      if (opt.selected) o.selected = true;
      modelSel.appendChild(o);
    });
  } else {
    const o = document.createElement('option');
    o.value = '';
    o.textContent = '(default)';
    modelSel.appendChild(o);
  }
}

$('planningAgentSelect')?.addEventListener('change', (e) => {
  const newAgent = e.target.value;
  $('agent').value = newAgent;
  updateAgentFields(newAgent);
  syncPlanningModelSelect(newAgent);
  saveForm();
  updatePlanningContext();
  appendDevLog(`[user] Switched agent → ${AGENT_INFO[newAgent]?.name || newAgent}`);
});

$('planningModelSelect')?.addEventListener('change', (e) => {
  const newModel = e.target.value;
  const agent = $('agent')?.value || 'copilot';
  const modelSelects = { copilot: 'copilotModel', claude: 'claudeModel', gemini: 'geminiModel' };
  const srcSel = $(modelSelects[agent]);
  if (srcSel) srcSel.value = newModel;
  saveForm();
  updatePlanningContext();
  wsSend({ type: 'switch_model', model: newModel });
  appendDevLog(`[user] Switched model → ${newModel}`);
  toast(`Model → ${newModel}`, 'info');
});
$('closeSettingsBtn')?.addEventListener('click', () => { $('settingsDrawer')?.classList.add('hidden'); updatePlanningContext(); });
$('settingsBackdrop')?.addEventListener('click', () => { $('settingsDrawer')?.classList.add('hidden'); updatePlanningContext(); });
$('focusModeBtn')?.addEventListener('click', toggleFocusMode);
$('projectPath')?.addEventListener('input', refreshUI);

function toggleFocusMode() {
  const ws = document.querySelector('.workspace');
  ws.classList.toggle('is-focused');
  const btn = $('focusModeBtn');
  if (btn) btn.textContent = ws.classList.contains('is-focused') ? '🗗 Exit Focus' : '⛶ Focus';
  setTimeout(() => { try { fitAddon.fit(); } catch (_) {} }, 200);
}

// ── Init ─────────────────────────────────────────────────────────────────────

async function checkDockerStatus() {
  try {
    const r = await fetch('/api/docker/status');
    const d = await r.json();
    const el = $('dockerStatus');
    if (el) { el.textContent = d.connected ? '● Connected' : '● Offline'; el.className = `badge badge-${d.connected ? 'online' : 'error'}`; }
  } catch (_) {}
}

async function checkImageStatus() {
  try {
    const r = await fetch('/api/image/status');
    const d = await r.json();
    const el = $('imageStatus');
    if (el) { el.textContent = d.exists ? `✓ ${d.id}` : '✗ Not built'; el.className = `badge badge-${d.exists ? 'ok' : 'missing'}`; }
  } catch (_) {}
}

function resetPlanningState() {
  planningState = { decisions: [], analysis: [], currentQuestion: null, step: 'requirements', completedSteps: [], agentTurnBuffer: '' };
  if ($('planningFlow')) $('planningFlow').innerHTML = '';
  if ($('decisionsList')) $('decisionsList').innerHTML = '<div class="decisions-empty">Decisions will appear here.</div>';
  if ($('decisionsCount')) $('decisionsCount').textContent = '0';
}

function sendChatMessage() {
  const input = $('chatInput');
  const text = input.value.trim();
  if (!text) return;
  appendDevLog(`[user] Chat: ${text.slice(0, 80)}${text.length > 80 ? '…' : ''}`);
  input.value = '';
  const flow = $('planningFlow');
  const div = document.createElement('div');
  div.className = 'user-message-pro';
  div.textContent = text;
  flow.appendChild(div);
  div.scrollIntoView({ behavior: 'smooth' });
  wsSend({ type: 'chat_input', text: text });
  showThinking(true);
}

$('chatSendBtn')?.addEventListener('click', sendChatMessage);
$('chatInput')?.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChatMessage(); } });

(async () => {
  await loadForm();
  connectWS();
  setScreen('task');
  checkDockerStatus();
  checkImageStatus();
  fetchAllModels();
  setInterval(checkDockerStatus, 10000);
  setInterval(checkImageStatus, 30000);
})();
