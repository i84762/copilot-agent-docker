/* ── Copilot Agent UI — app.js ──────────────────────────────────────────────
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

term.writeln('\x1b[90mCopilot Agent UI — ready.\x1b[0m');
term.writeln('\x1b[90mFill in the form on the left and click Plan or Start.\x1b[0m\r\n');

// Resize observer → keep xterm fitted
const resizeObs = new ResizeObserver(() => fitAddon.fit());
resizeObs.observe(document.getElementById('terminalPanel'));

window.addEventListener('resize', () => fitAddon.fit());

// ── State ─────────────────────────────────────────────────────────────────────

let state = 'idle'; // idle | planning | running | plan_done | error
let ws    = null;
let activeContainerId = null;
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
    setTimeout(connectWS, 3000);
  };

  ws.onerror = () => {};

  ws.onmessage = ev => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }

    switch (msg.type) {

      case 'connected':
        break;

      case 'output': {
        const raw = Uint8Array.from(atob(msg.data), c => c.charCodeAt(0));
        term.write(raw);
        logBuffer += new TextDecoder().decode(raw);
        break;
      }

      case 'container_started':
        activeContainerId = msg.containerId;
        setActiveContainerLabel(msg.containerId);
        if (msg.mode === 'plan') {
          enterState('planning');
          // Forward xterm input to server
          term.onData(data => {
            if (ws && ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({
                type: 'terminal_input',
                data: btoa(data),
              }));
            }
          });
          // Sync terminal size
          sendResize();
        } else {
          enterState('running');
        }
        listContainers();
        break;

      case 'container_stopped':
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
        enterState('plan_done');
        toast('Plan complete — click Execute Plan to run', 'success');
        break;

      case 'containers_list':
        renderContainerList(msg.containers);
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
  state = newState;
  updateButtons();
  updateTerminalTitle();

  const modeTag = $('modeTag');
  modeTag.classList.remove('hidden', 'mode-plan', 'mode-run', 'mode-resume');

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

  // Terminal is only writable in planning mode
  term.options.disableStdin = (state !== 'planning');
}

function updateTerminalTitle() {
  const t = $('terminalTitle');
  t.className = 'terminal-title';
  if (state === 'planning') { t.textContent = 'Plan Session — Interactive';  t.classList.add('active-plan'); }
  else if (state === 'running')  { t.textContent = 'Agent Output — Live Log'; t.classList.add('active-run'); }
  else if (state === 'plan_done'){ t.textContent = 'Planning Complete'; }
  else                           { t.textContent = 'Idle'; }
}

// ── Form helpers ──────────────────────────────────────────────────────────────

function getConfig() {
  return {
    projectPath:          $('projectPath').value.trim(),
    ghToken:              $('ghToken').value.trim(),
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
  const cfg = getConfig();
  if (!cfg.projectPath) { toast('Project Path is required', 'error'); return null; }
  if (!cfg.ghToken)     { toast('GitHub Token is required', 'error'); return null; }
  return cfg;
}

// ── Persistence (localStorage) ────────────────────────────────────────────────

const STORAGE_KEY = 'copilot-agent-ui-config';

const FORM_FIELDS = [
  'projectPath','ghToken','task','taskFile',
  'instructionsRepo','instructionsFile','instructionsBranch',
  'gitUserName','gitUserEmail','flutterVersion','goVersion',
  'firebaseProjectId','gcloudKeyFile','firebaseTestDevice',
];

function saveForm() {
  const data = {};
  FORM_FIELDS.forEach(id => {
    const el = $(id);
    if (!el) return;
    data[id] = el.type === 'checkbox' ? el.checked : el.value;
  });
  data.useHostInstructions = $('useHostInstructions').checked;
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(data)); } catch (_) {}
}

function loadForm() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const data = JSON.parse(raw);
    FORM_FIELDS.forEach(id => {
      const el = $(id);
      if (!el || !(id in data)) return;
      el.value = data[id];
    });
    if ('useHostInstructions' in data) {
      $('useHostInstructions').checked = data.useHostInstructions;
    }
  } catch (_) {}
}

// Auto-save on any input change
document.querySelectorAll('.input-field, input[type="checkbox"]').forEach(el => {
  el.addEventListener('change', saveForm);
  el.addEventListener('input',  saveForm);
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
    return;
  }

  sel.innerHTML = '<option value="">Select a container…</option>';
  containers.forEach(c => {
    const opt  = document.createElement('option');
    opt.value  = c.id;
    opt.textContent = `${c.name}  [${c.mode}]  ${c.project}`;
    sel.appendChild(opt);
  });

  if (prev && containers.find(c => c.id === prev)) {
    sel.value = prev;
    showContainerInfo(containers.find(c => c.id === prev));
  }
}

function showContainerInfo(c) {
  if (!c) { $('containerInfo').classList.add('hidden'); return; }
  const stateClass = c.state === 'running' ? 'ci-running' : 'ci-exited';
  const modeClass  = c.mode === 'plan' ? 'ci-plan' : '';
  $('containerInfo').innerHTML =
    `<span class="ci-name">${c.name}</span>  ` +
    `<span class="ci-badge ${stateClass}">${c.state}</span>  ` +
    (c.mode !== 'normal' ? `<span class="ci-badge ${modeClass}">${c.mode}</span>  ` : '') +
    `<br>${c.status}`;
  $('containerInfo').classList.remove('hidden');
}

$('containerSelect').addEventListener('change', ev => {
  const id = ev.target.value;
  if (!id) { $('containerInfo').classList.add('hidden'); return; }
  // Find container info from options text (stored in previous render)
  showContainerInfo({ id, state: 'running', mode: 'normal', name: id.slice(0, 12), status: '' });

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
  a.download = `copilot-agent-${Date.now()}.log`;
  a.click();
  URL.revokeObjectURL(url);
});

function clearTerminal(resetBuffer = true) {
  term.clear();
  if (resetBuffer) logBuffer = '';
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
  if (!confirm('Clear saved form values?')) return;
  try { localStorage.removeItem(STORAGE_KEY); } catch (_) {}
  FORM_FIELDS.forEach(id => { const el = $(id); if (el) el.value = ''; });
  $('useHostInstructions').checked = true;
  toast('Form cleared', 'info');
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

loadForm();
updateButtons();
updateTerminalTitle();
connectWS();

// Periodic container list refresh
setInterval(listContainers, 10000);
