'use strict';

const express   = require('express');
const WebSocket = require('ws');
const Docker    = require('dockerode');
const http      = require('http');
const path      = require('path');
const fs        = require('fs');
const os        = require('os');

const llmPlan   = require('./llm-plan');

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocket.Server({ server });

app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public'), {
  etag: false,
  lastModified: false,
  setHeaders: (res) => res.setHeader('Cache-Control', 'no-store'),
}));

const PORT     = process.env.UI_PORT || 3000;
const ROOT_DIR = path.join(__dirname, '..'); // copilot-agent-docker root

// ── Docker connection ─────────────────────────────────────────────────────────

function makeLocalDocker() {
  if (process.platform === 'win32') {
    return new Docker({ socketPath: '//./pipe/docker_engine' });
  }
  return new Docker({ socketPath: '/var/run/docker.sock' });
}

function makeDockerFromConfig(cfg) {
  if (!cfg || cfg.type === 'local') return makeLocalDocker();

  if (cfg.type === 'ssh') {
    const opts = {
      protocol: 'ssh',
      host: cfg.host,
      port: cfg.port || 22,
      username: cfg.username || os.userInfo().username,
    };
    if (cfg.keyPath && fs.existsSync(cfg.keyPath)) {
      opts.sshOptions = { privateKey: fs.readFileSync(cfg.keyPath) };
    } else if (cfg.password) {
      opts.sshOptions = { password: cfg.password };
    }
    return new Docker(opts);
  }

  if (cfg.type === 'tcp') {
    return new Docker({ host: cfg.host, port: cfg.port || 2375, protocol: 'http' });
  }

  return makeLocalDocker();
}

let dockerCfg = { type: 'local' };
let docker    = makeLocalDocker();

// ── Server-side config persistence ────────────────────────────────────────────
// Stored in <user-home>/.copilot-agent-ui/config.json so it survives restarts
// and is shared across all browser clients (including remote Tailscale/SSH ones).

const CONFIG_DIR  = path.join(os.homedir(), '.copilot-agent-ui');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

function readServerConfig() {
  try {
    if (!fs.existsSync(CONFIG_FILE)) return {};
    return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch (_) { return {}; }
}

function writeServerConfig(data) {
  try {
    if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true });
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(data, null, 2), 'utf8');
  } catch (err) {
    console.error('[config] write failed:', err.message);
    // Broadcast to all connected clients so the user knows their config wasn't saved
    broadcast({ type: 'error', message: `Config save failed: ${err.message}` });
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Strip ANSI/VT escape sequences and handle TUI overwrite patterns so that
 * output from any agent (including TUI apps like copilot/aider) is rendered
 * as clean readable text in the chat UI.
 */
function stripAnsi(str) {
  let s = str
    // CSI sequences: ESC [ ... (final byte A-Za-z ~)
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
    // OSC sequences: ESC ] ... ST (BEL or ESC \)
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    // Charset selection / other 2-byte sequences
    .replace(/\x1b[()][A-Za-z0-9=]/g, '')
    // Remaining lone ESC sequences
    .replace(/\x1b[^[\]()]/g, '')
    // Bare ESC
    .replace(/\x1b/g, '')
    // Non-printable control chars (keep \t \n \r)
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');

  // Handle TUI overwrite pattern: \r without \n means "rewrite current line".
  // Split on \n, then for each line apply the \r overwrite semantic so we keep
  // only the last segment (the final content the TUI rendered on that line).
  s = s.split('\n').map(line => {
    const parts = line.split('\r');
    // Last non-empty segment wins (TUI rewrites line by returning to col 0)
    for (let i = parts.length - 1; i >= 0; i--) {
      if (parts[i].trim()) return parts[i];
    }
    return '';
  }).join('\n');

  // Remove lines that are only spinner/progress characters
  s = s.split('\n')
    .filter(line => !/^[\s⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏|/\\—\-\.]+$/.test(line))
    .join('\n');

  // Collapse 3+ consecutive blank lines into 2
  s = s.replace(/\n{3,}/g, '\n\n');

  return s.trim();
}

function safeSend(ws, obj) {
  try {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
  } catch (_) {}
}

function broadcast(obj) {
  const msg = JSON.stringify(obj);
  wss.clients.forEach(ws => { if (ws.readyState === WebSocket.OPEN) ws.send(msg); });
}

// Write the finalized plan to PLAN.md in the project directory
function writePlanToProject(projectPath, planText) {
  try {
    if (!projectPath) return;
    const planFile = path.join(projectPath, 'PLAN.md');
    fs.writeFileSync(planFile, planText, 'utf8');
    console.log(`[plan] PLAN.md written to ${planFile}`);
  } catch (err) {
    console.error(`[plan] failed to write PLAN.md: ${err.message}`);
  }
}

// Build Docker env array from UI config object
function buildEnv(cfg, mode) {
  const pairs = {
    // ── Agent selection ──────────────────────────────────────
    AGENT:                        cfg.agent || 'copilot',

    // ── Per-agent API keys ───────────────────────────────────
    GH_TOKEN:                     cfg.ghToken || '',
    ANTHROPIC_API_KEY:            cfg.anthropicApiKey || '',
    GEMINI_API_KEY:               cfg.geminiApiKey || '',
    OPENAI_API_KEY:               cfg.openaiApiKey || '',
    AIDER_MODEL:                  cfg.aiderModel || '',

    // ── Task / instructions ──────────────────────────────────
    COPILOT_TASK:                 cfg.task || '',
    COPILOT_TASK_FILE:            cfg.taskFile || '',
    COPILOT_INSTRUCTIONS_REPO:    cfg.instructionsRepo || '',
    COPILOT_INSTRUCTIONS_FILE:    cfg.instructionsFile || 'copilot-instructions.md',
    COPILOT_INSTRUCTIONS_BRANCH:  cfg.instructionsBranch || 'main',
    COPILOT_USE_HOST_INSTRUCTIONS: (cfg.useHostInstructions !== false) ? 'true' : 'false',
    GIT_USER_NAME:                cfg.gitUserName || 'Archon',
    GIT_USER_EMAIL:               cfg.gitUserEmail || 'copilot@example.com',
    FLUTTER_VERSION:              cfg.flutterVersion || '3.24.5',
    GO_VERSION:                   cfg.goVersion || '1.22.5',
    FIREBASE_PROJECT_ID:          cfg.firebaseProjectId || '',
    FIREBASE_TEST_DEVICE:         cfg.firebaseTestDevice || 'model=oriole,version=33,locale=en,orientation=portrait',
    FIREBASE_TEST_TIMEOUT:        cfg.firebaseTestTimeout || '5m',
    GOOGLE_CREDENTIALS_JSON:      cfg.googleCredentialsJson || '',
    GOOGLE_APPLICATION_CREDENTIALS: cfg.gcloudKeyFile ? '/keys/sa-key.json' : '',
    COPILOT_PLAN_MODE:    mode === 'plan'   ? 'true' : 'false',
    COPILOT_FORCE_RESUME: mode === 'resume' ? 'true' : 'false',
    COPILOT_NEW_SESSION:  mode === 'new'    ? 'true' : 'false',
  };
  return Object.entries(pairs)
    .filter(([, v]) => v !== '')
    .map(([k, v]) => `${k}=${v}`);
}

function buildBinds(cfg) {
  const binds = [];

  if (cfg.projectPath) {
    binds.push(`${cfg.projectPath}:/workspace`);
  }

  binds.push('copilot_sdk_cache:/sdks');

  // Host ~/.copilot (auto-create if missing so bind always works)
  const hostCopilotHome = cfg.hostCopilotHome || path.join(os.homedir(), '.copilot');
  if (!fs.existsSync(hostCopilotHome)) {
    try { fs.mkdirSync(hostCopilotHome, { recursive: true }); } catch (_) {}
  }
  if (fs.existsSync(hostCopilotHome)) {
    binds.push(`${hostCopilotHome}:/host-copilot-home:ro`);
  }

  // Firebase SA key
  if (cfg.gcloudKeyFile && fs.existsSync(cfg.gcloudKeyFile)) {
    binds.push(`${cfg.gcloudKeyFile}:/keys/sa-key.json:ro`);
  }

  return binds;
}

async function createContainer(cfg, mode) {
  // Build a unique Docker container name: user-slug + timestamp
  const slug = (cfg.sessionName || '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
  const uniquePart = Date.now();
  const dockerName = slug ? `archon-${slug}-${uniquePart}` : `archon-${uniquePart}`;

  const interactive = mode === 'plan';

  return docker.createContainer({
    name: dockerName,
    Image:        'archon:latest',
    AttachStdin:  interactive,
    AttachStdout: true,
    AttachStderr: true,
    OpenStdin:    interactive,
    StdinOnce:    false,
    Tty:          true,
    Env:          buildEnv(cfg, mode),
    HostConfig: {
      Binds:      buildBinds(cfg),
      AutoRemove: false,
    },
    Labels: {
      'archon':               'true',
      'copilot-mode':         mode,
      'copilot-project':      cfg.projectPath ? path.basename(cfg.projectPath) : 'unknown',
      'archon-agent-type':    cfg.agent || 'copilot',
      'copilot-session-name': cfg.sessionName || '',
    },
  });
}

async function createAndStart(cfg, mode) {
  const container = await createContainer(cfg, mode);
  await container.start();
  return container;
}

function containerSummary(c) {
  const sessionName = c.Labels?.['copilot-session-name'] || '';
  const dockerName  = (c.Names[0] || c.Id).replace(/^\//, '');
  return {
    id:          c.Id,
    shortId:     c.Id.slice(0, 12),
    name:        dockerName,
    sessionName: sessionName,
    displayName: sessionName || dockerName,   // what the UI shows
    status:      c.Status,
    state:       c.State,
    mode:        c.Labels?.['copilot-mode']    || 'normal',
    project:     c.Labels?.['copilot-project'] || '—',
    agent:       c.Labels?.['archon-agent-type'] || 'copilot',
    image:       c.Image,
  };
}

// ── REST API ──────────────────────────────────────────────────────────────────

// Global config — read/write persisted settings (tokens, instructions, defaults)
app.get('/api/config', (_req, res) => {
  res.json(readServerConfig());
});

app.post('/api/config', (req, res) => {
  const current = readServerConfig();
  const updated = Object.assign(current, req.body);   // merge, never wipe
  writeServerConfig(updated);
  res.json({ ok: true });
});

app.delete('/api/config', (_req, res) => {
  try { if (fs.existsSync(CONFIG_FILE)) fs.unlinkSync(CONFIG_FILE); } catch (_) {}
  res.json({ ok: true });
});

app.get('/api/docker/status', async (_req, res) => {
  try {
    const info = await docker.info();
    res.json({ connected: true, name: info.Name, os: info.OperatingSystem, config: dockerCfg });
  } catch (err) {
    res.json({ connected: false, error: err.message, config: dockerCfg });
  }
});

app.post('/api/docker/connect', async (req, res) => {
  try {
    const cfg       = req.body;
    const testDocker = makeDockerFromConfig(cfg);
    await testDocker.info();          // verify connection
    docker    = testDocker;
    dockerCfg = cfg;
    broadcast({ type: 'docker_status', connected: true, config: cfg });
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/containers', async (_req, res) => {
  try {
    const list   = await docker.listContainers({ all: true });
    const agents = list
      .filter(c =>
        c.Labels?.['archon'] ||
        c.Image.includes('archon') ||
        c.Names.some(n => n.includes('copilot')))
      .map(containerSummary);
    res.json(agents);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/containers/:id/stop', async (req, res) => {
  try {
    await docker.getContainer(req.params.id).stop({ t: 15 });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/containers/:id/abort', async (req, res) => {
  try {
    await docker.getContainer(req.params.id).kill({ signal: 'SIGKILL' });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/image/status', async (_req, res) => {
  try {
    const info = await docker.getImage('archon:latest').inspect();
    res.json({ exists: true, id: info.Id.slice(7, 19), created: info.Created });
  } catch {
    res.json({ exists: false });
  }
});

// Stream Docker build output as chunked HTTP
app.post('/api/image/build', async (_req, res) => {
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Transfer-Encoding', 'chunked');
  res.setHeader('X-Accel-Buffering', 'no'); // disable nginx buffering

  try {
    const stream = await docker.buildImage(ROOT_DIR, { t: 'archon:latest' });

    await new Promise((resolve, reject) => {
      stream.on('data', chunk => {
        try {
          const d = JSON.parse(chunk.toString());
          if (d.stream)            res.write(d.stream);
          if (d.error)  { res.write(`\n❌ ${d.error}`); reject(new Error(d.error)); }
          if (d.status) res.write(`${d.status}\n`);
        } catch { res.write(chunk.toString()); }
      });
      stream.on('end',   resolve);
      stream.on('error', reject);
    });

    res.end('\n✅ Build complete\n');
  } catch (err) {
    res.end(`\n❌ Build failed: ${err.message}\n`);
  }
});

// ── Model discovery ───────────────────────────────────────────────────────────
// Fetch available models from each provider's API.
// Returns { models: [{id, name}], error? }

async function fetchCopilotModels(token) {
  const res = await fetch('https://models.inference.ai.azure.com/models', {
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  });
  if (!res.ok) throw new Error(`GitHub Models API ${res.status}`);
  const data = await res.json();
  const list = Array.isArray(data) ? data : (data.data || []);

  // Extract short model name from Azure ML registry URIs:
  // "azureml://registries/azure-openai/models/gpt-4o/versions/2" → "gpt-4o"
  function shortId(raw) {
    if (!raw) return raw;
    const m = raw.match(/\/models\/([^/]+)/);
    return m ? m[1] : raw;
  }

  // Only keep chat/completion models — always apply name heuristics
  const EXCLUDE_PATTERNS = ['embed', 'whisper', 'tts', 'dall-e', 'image', 'rerank', 'vision-ocr'];
  const CHAT_TASK_TYPES  = ['chat-completion', 'text-generation', 'conversational'];
  return list
    .filter(m => {
      const rawId = (m.id || m.name || '').toLowerCase();
      // Always exclude by name pattern first
      if (EXCLUDE_PATTERNS.some(p => rawId.includes(p))) return false;
      // Then check task types if available
      const tasks = m.supported_tasks || m.task_types || m.capabilities?.tasks || [];
      if (tasks.length) return tasks.some(t => CHAT_TASK_TYPES.includes(typeof t === 'string' ? t : t.task_type || t.id || t));
      return true;
    })
    .map(m => {
      const id = shortId(m.id || m.name);
      const name = m.friendly_name || m.display_name || id;
      return { id, name };
    })
    .filter(m => m.id)
    .sort((a, b) => a.id.localeCompare(b.id));
}

async function fetchClaudeModels(apiKey) {
  const res = await fetch('https://api.anthropic.com/v1/models', {
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
  });
  if (!res.ok) throw new Error(`Anthropic API ${res.status}`);
  const data = await res.json();
  return (data.data || [])
    .map(m => ({ id: m.id, name: m.display_name || m.id }))
    .sort((a, b) => b.id.localeCompare(a.id)); // newest first
}

async function fetchGeminiModels(apiKey) {
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`);
  if (!res.ok) throw new Error(`Gemini API ${res.status}`);
  const data = await res.json();
  return (data.models || [])
    .filter(m => m.supportedGenerationMethods?.includes('generateContent'))
    .map(m => ({
      id:   m.name.replace('models/', ''),
      name: m.displayName || m.name.replace('models/', ''),
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

app.get('/api/models', async (req, res) => {
  const { agent, token } = req.query;
  if (!agent || !token) return res.status(400).json({ error: 'agent and token required' });
  try {
    let models;
    if (agent === 'copilot')     models = await fetchCopilotModels(token);
    else if (agent === 'claude') models = await fetchClaudeModels(token);
    else if (agent === 'gemini') models = await fetchGeminiModels(token);
    else return res.status(400).json({ error: 'Unknown agent' });
    res.json({ models });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── WebSocket ─────────────────────────────────────────────────────────────────

wss.on('connection', ws => {
  const connId = Date.now();
  console.log(`[ws] client connected (id=${connId})`);
  ws.on('close',   () => console.log(`[ws] client disconnected (id=${connId})`));

  let logStream       = null;
  let containerStream = null; // plan mode interactive stream
  let activeId        = null;
  let activePlanAgent = 'copilot'; // track agent type for correct line ending
  let activePlanSessionId = null;  // non-null when using API-based planning (no container TUI)
  // Chat state — shared between plan_container and chat_input cases
  let agentReady      = false;
  let agentTyping     = false;
  let chatDebounce    = null;
  // Dev logs: streamed to client AND printed to server stdout for terminal visibility
  function devLog(text) {
    const ts = new Date().toISOString().slice(11, 23);
    process.stdout.write(`[${ts}] ${text}\n`);
    safeSend(ws, { type: 'dev_log', text });
  }

  function cleanup() {
    if (logStream)       { try { logStream.destroy();       } catch (_) {} logStream       = null; }
    if (containerStream) { try { containerStream.end();     } catch (_) {} containerStream = null; }
    if (activePlanSessionId) { llmPlan.deleteSession(activePlanSessionId); activePlanSessionId = null; }
  }

  ws.on('close', cleanup);
  ws.on('error', cleanup);

  safeSend(ws, { type: 'connected' });

  ws.on('message', async raw => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    console.log(`[ws] msg type=${msg.type} (id=${connId})`);

    switch (msg.type) {

      // ── Stream logs of an existing container ───────────────────────────────
      case 'subscribe_logs': {
        cleanup();
        activeId = msg.containerId;
        devLog(`[subscribe_logs] containerId=${activeId}`);
        try {
          const c = docker.getContainer(activeId);

          // Always emit container inspect info to dev log
          try {
            const info = await c.inspect();
            devLog(`[inspect] name=${info.Name} image=${info.Config?.Image} status=${info.State?.Status}`);
            devLog(`[inspect] created=${info.Created} started=${info.State?.StartedAt}`);
            devLog(`[inspect] mounts=${JSON.stringify(info.Mounts?.map(m => `${m.Source}→${m.Destination}`))}`);
            const envLines = (info.Config?.Env || [])
              .map(e => e.startsWith('GH_TOKEN') || e.includes('API_KEY') || e.includes('KEY=')
                ? e.replace(/=(.{4}).*/, '=****') : e);
            devLog(`[inspect] env=\n  ${envLines.join('\n  ')}`);
          } catch (e) { devLog(`[inspect] failed: ${e.message}`); }

          logStream = await c.logs({ stdout: true, stderr: true, follow: true, tail: 300, timestamps: false });

          const soPass = new (require('stream').PassThrough)();
          const sePass = new (require('stream').PassThrough)();
          docker.modem.demuxStream(logStream, soPass, sePass);
          const fwdChunk = chunk => {
            const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            safeSend(ws, { type: 'output', data: buf.toString('base64') });
          };
          soPass.on('data', fwdChunk);
          sePass.on('data', fwdChunk);
          logStream.on('end',   () => safeSend(ws, { type: 'output', data: toB64('\r\n\x1b[90m[container exited]\x1b[0m\r\n') }));
          logStream.on('error', err => safeSend(ws, { type: 'error', message: err.message }));
        } catch (err) {
          safeSend(ws, { type: 'error', message: `Log stream: ${err.message}` });
        }
        break;
      }

      // ── Start container — normal / resume / new-session ───────────────────
      case 'start_container': {
        cleanup();
        const mode = msg.mode || 'normal';
        const modeLabel = mode === 'resume' ? 'Resume' : mode === 'new' ? 'New Session' : 'Start';

        function step(id, text, status) {
          safeSend(ws, { type: 'progress', step: id, text, status });
        }

        try {
          step('validate',  'Validating configuration',    'ok');
          devLog(`[start] mode=${mode} agent=${msg.config?.agent} project=${msg.config?.projectPath}`);

          // Pre-flight token check for copilot agent
          const runAgent = (msg.config?.agent || 'copilot').toLowerCase();
          if (runAgent === 'copilot' && msg.config?.ghToken) {
            const tok = msg.config.ghToken.trim();
            if (tok.startsWith('ghp_') || tok.startsWith('gho_') || tok.startsWith('ghu_')) {
              throw new Error(
                'Classic PAT detected. Copilot CLI v1.0.21+ requires a fine-grained PAT. ' +
                'Create one at github.com/settings/personal-access-tokens/new with Models (read) + Repositories (read) + User (read).'
              );
            }
          }

          step('docker',    'Connecting to Docker',        'active');
          const dockerInfo = await docker.ping();
          step('docker',    'Docker connected',            'ok');
          devLog(`[docker] ping ok — ${JSON.stringify(dockerInfo)}`);

          step('image',     'Checking agent image',        'active');
          try {
            const imgInfo = await docker.getImage('archon:latest').inspect();
            step('image',   'Image ready',                 'ok');
            devLog(`[image] id=${imgInfo.Id.slice(7,19)} created=${imgInfo.Created} size=${(imgInfo.Size/1024/1024).toFixed(1)}MB`);
          } catch {
            throw new Error('Image archon:latest not found — build it first via "🔨 Build Image"');
          }

          step('create',    'Creating container',          'active');
          devLog(`[create] building env + binds for mode=${mode}`);
          const container = await createAndStart(msg.config, mode);
          activeId = container.id;
          step('create',    'Container created & started', 'ok');
          devLog(`[create] containerId=${container.id}`);

          if (true) {
            try {
              const info = await container.inspect();
              devLog(`[inspect] name=${info.Name}`);
              devLog(`[inspect] mounts=${JSON.stringify(info.Mounts?.map(m => `${m.Source}→${m.Destination}`))}`);
              const envLines = (info.Config?.Env || [])
                .map(e => e.startsWith('GH_TOKEN') || e.includes('API_KEY') || e.includes('KEY=')
                  ? e.replace(/=(.{4}).*/, '=****') : e);
              devLog(`[inspect] env:\n  ${envLines.join('\n  ')}`);
            } catch (e) { devLog(`[inspect] ${e.message}`); }
          }

          step('attach',    'Attaching log stream',        'active');
          // container.logs() always uses Docker multiplex framing (8-byte header)
          // even with Tty:true — use demuxStream to strip headers before sending to xterm
          logStream = await container.logs({ stdout: true, stderr: true, follow: true, tail: 0, timestamps: false });
          step('attach',    'Log stream attached — agent starting', 'ok');
          devLog(`[attach] streaming stdout+stderr`);

          safeSend(ws, { type: 'progress_done' });
          safeSend(ws, { type: 'container_started', containerId: container.id, mode });

          // demuxStream strips the 8-byte Docker stream header
          const stdoutPassthrough = new (require('stream').PassThrough)();
          const stderrPassthrough = new (require('stream').PassThrough)();
          docker.modem.demuxStream(logStream, stdoutPassthrough, stderrPassthrough);

          const forwardChunk = chunk => {
            devLog(`[log_stream] ${chunk.length}b`);
            safeSend(ws, { type: 'output', data: bufToB64(chunk) });
          };
          stdoutPassthrough.on('data', forwardChunk);
          stderrPassthrough.on('data', forwardChunk);

          logStream.on('end', () => {
            devLog(`[log_stream] ended for ${container.id}`);
            safeSend(ws, { type: 'output', data: toB64('\r\n\x1b[90m[container exited]\x1b[0m\r\n') });
            safeSend(ws, { type: 'container_stopped', containerId: container.id });
          });
        } catch (err) {
          devLog(`[error] ${err.stack || err.message}`);
          safeSend(ws, { type: 'progress_error', message: err.message });
          safeSend(ws, { type: 'error', message: `${modeLabel} failed: ${err.message}` });
        }
        break;
      }

      // ── Check for saved planning session in project folder ───────────────
      case 'check_plan_session': {
        const meta = msg.projectPath ? llmPlan.getSavedSessionMeta(msg.projectPath) : null;
        safeSend(ws, { type: 'plan_session_info', exists: !!meta, meta });
        break;
      }

      // ── Start API-based planning session (no Docker TUI needed) ─────────
      case 'plan_container': {
        cleanup();
        if (activePlanSessionId) { llmPlan.deleteSession(activePlanSessionId); activePlanSessionId = null; }

        function stepP(id, text, status) {
          safeSend(ws, { type: 'progress', step: id, text, status });
        }

        try {
          stepP('validate', 'Validating configuration', 'ok');
          const planAgent = (msg.config?.agent || 'copilot').toLowerCase();
          activePlanAgent = planAgent;
          devLog(`[plan] agent=${planAgent} project=${msg.config?.projectPath}`);

          // Token pre-flight for copilot (GitHub Models API uses same fine-grained PAT)
          if (planAgent === 'copilot' && msg.config?.ghToken) {
            const tok = msg.config.ghToken.trim();
            if (tok.startsWith('ghp_') || tok.startsWith('gho_') || tok.startsWith('ghu_')) {
              throw new Error(
                'Classic PAT detected (ghp_/gho_/ghu_). The GitHub Models API requires a fine-grained PAT. ' +
                'Create one at github.com/settings/personal-access-tokens/new with Models (read) permission, ' +
                'or switch to the Claude agent.'
              );
            }
          }

          stepP('docker', 'Reading project files', 'active');
          const resume = !!msg.resume;
          const planResult = llmPlan.startPlanSession(msg.config, resume);
          activePlanSessionId = planResult.sessionId;
          devLog(`[plan] session=${activePlanSessionId} agent=${planAgent} resumed=${planResult.resumed}`);
          stepP('docker', planResult.resumed ? 'Session restored' : 'Project context loaded', 'ok');

          stepP('image',  'Connecting to LLM API', 'active');
          stepP('create', 'Ready', 'ok');
          stepP('attach', 'Chat session open', 'ok');
          stepP('attach', 'Chat session open', 'ok');

          safeSend(ws, { type: 'progress_done' });
          const virtualId  = `plan-api-${Date.now()}`;
          activeId = virtualId;
          const selectedModel = msg.config?.model || '';
          const modelLabel = selectedModel ||
            (planAgent === 'copilot' ? 'gpt-4o'
            : planAgent === 'claude' ? 'claude-opus-4-5'
            : planAgent === 'gemini' ? 'gemini-2.0-flash'
            : planAgent === 'aider'  ? 'Aider' : '');
          safeSend(ws, { type: 'container_started', containerId: virtualId, mode: 'plan', agent: planAgent, model: modelLabel, resumed: planResult.resumed });

          const onStepChange = (stepId, done) => {
            safeSend(ws, { type: 'plan_step', stepId, done });
            devLog(`[plan step] ${stepId} done=${done}`);
          };

          if (planResult.resumed) {
            // Restore stepper state from saved session
            planResult.completedSteps.forEach(sid => onStepChange(sid, true));
            onStepChange(planResult.currentStep, false);
            // Send saved chat history to client for display
            const history = llmPlan.getSessionHistory(activePlanSessionId);
            if (history.length) safeSend(ws, { type: 'chat_history', messages: history });
            // Tell the agent to continue from where it left off
            const stepDef = llmPlan.PLANNING_STEPS.find(s => s.id === planResult.currentStep);
            const resumeMsg = `We are resuming our planning session. We were on Step: ${stepDef?.label || planResult.currentStep}. Please briefly summarize where we left off and continue from that point.`;
            safeSend(ws, { type: 'chat_system', text: `📂 Resumed from **${stepDef?.label || planResult.currentStep}** — ${history.length} messages restored` });
            safeSend(ws, { type: 'chat_typing' });
            agentTyping = true;
            llmPlan.sendPlanMessage(activePlanSessionId, resumeMsg,
              (chunk) => { safeSend(ws, { type: 'chat_chunk', text: chunk }); },
              (_full, quota) => {
                agentTyping = false;
                safeSend(ws, { type: 'chat_message_end' });
                if (quota?.remaining != null) safeSend(ws, { type: 'quota_update', ...quota });
              },
              (err) => {
                agentTyping = false;
                safeSend(ws, { type: 'chat_system', text: `⚠️ LLM API error: ${err.message}` });
                safeSend(ws, { type: 'chat_message_end' });
              },
              onStepChange,
              true  // internal — don't show this in history
            );
          } else {
            // Fresh session — kick off Step 1
            safeSend(ws, { type: 'plan_step', stepId: 'requirements', done: false });
            const initialMsg =
              'Please begin Step 1: Requirements Clarification. ' +
              'Restate the task in your own words, list what you understand as required, ' +
              'and ask any clarifying questions needed before proceeding. ' +
              'Do NOT review the codebase yet — that is Step 2.';
            safeSend(ws, { type: 'chat_typing' });
            agentTyping = true;
            llmPlan.sendPlanMessage(activePlanSessionId, initialMsg,
              (chunk) => { safeSend(ws, { type: 'chat_chunk', text: chunk }); },
              (_full, quota) => {
                agentTyping = false;
                safeSend(ws, { type: 'chat_message_end' });
                if (quota?.remaining != null) safeSend(ws, { type: 'quota_update', ...quota });
                const plan = llmPlan.extractFinalPlan(activePlanSessionId);
                if (plan) { writePlanToProject(msg.config?.projectPath, plan); safeSend(ws, { type: 'plan_complete' }); }
              },
              (err) => {
                agentTyping = false;
                devLog(`[plan api error] ${err.message}`);
                safeSend(ws, { type: 'chat_system', text: `⚠️ LLM API error: ${err.message}` });
                safeSend(ws, { type: 'chat_message_end' });
              },
              onStepChange,
              true  // internal — hide from history
            );
          }

          stepP('image', 'LLM API connected', 'ok');

        } catch (err) {
          devLog(`[plan error] ${err.stack || err.message}`);
          safeSend(ws, { type: 'progress_error', message: err.message });
          safeSend(ws, { type: 'error', message: `Plan start failed: ${err.message}` });
        }
        break;
      }

      // ── Send user message to planning chat ────────────────────────────────
      case 'chat_input': {
        if (!msg.text) break;

        // API-based planning session
        if (activePlanSessionId) {
          try {
            devLog(`[chat_input api] ${msg.text.slice(0, 120)}`);
            if (!agentTyping) {
              agentTyping = true;
              safeSend(ws, { type: 'chat_typing' });
            }
            llmPlan.sendPlanMessage(
              activePlanSessionId,
              msg.text,
              (chunk) => { safeSend(ws, { type: 'chat_chunk', text: chunk }); },
              (_full, quota) => {
                agentTyping = false;
                safeSend(ws, { type: 'chat_message_end' });
                if (quota?.remaining != null) safeSend(ws, { type: 'quota_update', ...quota });
                const plan = llmPlan.extractFinalPlan(activePlanSessionId);
                if (plan) {
                  const sess = llmPlan.getSession(activePlanSessionId);
                  writePlanToProject(sess?.config?.projectPath, plan);
                  safeSend(ws, { type: 'plan_complete' });
                }
              },
              (err) => {
                agentTyping = false;
                devLog(`[chat_input api error] ${err.message}`);
                safeSend(ws, { type: 'chat_system', text: `⚠️ LLM API error: ${err.message}` });
                safeSend(ws, { type: 'chat_message_end' });
              },
              (stepId, done) => { safeSend(ws, { type: 'plan_step', stepId, done }); }
            );
          } catch (err) {
            safeSend(ws, { type: 'error', message: `Chat input: ${err.message}` });
          }
          break;
        }

        // Container stream fallback (execution phase / other modes)
        if (containerStream) {
          try {
            devLog(`[chat_input stream] ${msg.text.slice(0, 120)}`);
            agentReady = true;
            if (!agentTyping) {
              agentTyping = true;
              safeSend(ws, { type: 'chat_typing' });
            }
            const lineEnd = (activePlanAgent === 'copilot' || activePlanAgent === 'aider') ? '\r' : '\n';
            containerStream.write(Buffer.from(msg.text + lineEnd));
          } catch (err) {
            safeSend(ws, { type: 'error', message: `Chat input: ${err.message}` });
          }
        }
        break;
      }

      // ── Advance to next planning step (triggered by "Next Phase" button) ────
      case 'advance_step': {
        if (!activePlanSessionId) break;
        const sess = llmPlan.getSession(activePlanSessionId);
        if (!sess) break;
        const steps = llmPlan.PLANNING_STEPS;
        const idx   = steps.findIndex(s => s.id === sess.currentStep);
        const next  = steps[idx + 1];
        if (!next) break;  // already on last step

        devLog(`[advance_step] ${sess.currentStep} → ${next.id}`);

        if (agentTyping) break;  // don't interrupt ongoing response

        agentTyping = true;
        safeSend(ws, { type: 'chat_typing' });

        const stepNum = idx + 2;  // 1-indexed, next step
        const advanceMsg =
          `The user has confirmed they are ready to move on. ` +
          `Please move to Step ${stepNum}: ${next.label}. ` +
          `Begin with <STEP:${next.id}> on its own line.`;

        llmPlan.sendPlanMessage(
          activePlanSessionId,
          advanceMsg,
          (chunk) => { safeSend(ws, { type: 'chat_chunk', text: chunk }); },
          (_full, quota) => {
            agentTyping = false;
            safeSend(ws, { type: 'chat_message_end' });
            if (quota?.remaining != null) safeSend(ws, { type: 'quota_update', ...quota });
            const plan = llmPlan.extractFinalPlan(activePlanSessionId);
            if (plan) {
              const s = llmPlan.getSession(activePlanSessionId);
              writePlanToProject(s?.config?.projectPath, plan);
              safeSend(ws, { type: 'plan_complete' });
            }
          },
          (err) => {
            agentTyping = false;
            safeSend(ws, { type: 'chat_system', text: `⚠️ LLM API error: ${err.message}` });
            safeSend(ws, { type: 'chat_message_end' });
          },
          (stepId, done) => { safeSend(ws, { type: 'plan_step', stepId, done }); },
          true  // internal — don't show in history as user message
        );
        break;
      }

      // ── Switch model mid-session ──────────────────────────────────────────
      case 'switch_model': {
        if (!activePlanSessionId || !msg.model) break;
        const sess = llmPlan.getSession(activePlanSessionId);
        if (!sess) break;
        sess.config.model = msg.model;
        devLog(`[switch_model] → ${msg.model}`);
        // Persist to config file so the selection is remembered
        const cfg = readServerConfig();
        cfg.model = msg.model;
        writeServerConfig(cfg);
        break;
      }

      // ── Send keyboard input to plan terminal (legacy / fallback) ──────────
      case 'terminal_input': {
        if (containerStream && msg.data) {
          try {
            containerStream.write(Buffer.from(msg.data, 'base64'));
          } catch (err) {
            safeSend(ws, { type: 'error', message: `Input: ${err.message}` });
          }
        }
        break;
      }

      // ── Resize PTY ────────────────────────────────────────────────────────
      case 'resize_terminal': {
        if (activeId && msg.cols && msg.rows) {
          try { await docker.getContainer(activeId).resize({ w: msg.cols, h: msg.rows }); }
          catch (_) {}
        }
        break;
      }

      // ── Stop (graceful) ───────────────────────────────────────────────────
      case 'stop_container': {
        const id = msg.containerId || activeId;
        if (!id) break;
        try {
          await docker.getContainer(id).stop({ t: 15 });
          safeSend(ws, { type: 'container_stopped', containerId: id });
        } catch (err) { safeSend(ws, { type: 'error', message: err.message }); }
        break;
      }

      // ── Abort (force kill) ────────────────────────────────────────────────
      case 'abort_container': {
        const id = msg.containerId || activeId;
        if (!id) break;
        try {
          await docker.getContainer(id).kill({ signal: 'SIGKILL' });
          safeSend(ws, { type: 'container_stopped', containerId: id });
        } catch (err) { safeSend(ws, { type: 'error', message: err.message }); }
        break;
      }

      // ── Refresh container list ────────────────────────────────────────────
      case 'list_containers': {
        try {
          const list   = await docker.listContainers({ all: false });
          const agents = list
            .filter(c =>
              c.Labels?.['archon'] ||
              c.Image.includes('archon') ||
              c.Names.some(n => n.includes('copilot')))
            .map(containerSummary);
          safeSend(ws, { type: 'containers_list', containers: agents });
        } catch (err) {
          safeSend(ws, { type: 'error', message: err.message });
        }
        break;
      }

      // ── Dev logs state dump (panel open) ───────────────────────────────────
      case 'toggle_dev_logs': {
        // Dev logs always stream; this message requests an immediate state dump
        // when user opens the panel so it isn't blank.
        const ts = new Date().toISOString();
        devLog(`[dev logs] panel opened ${ts}`);
        devLog(`[server] node ${process.version}  pid=${process.pid}`);
        devLog(`[docker] config=${JSON.stringify(dockerCfg)}`);
        if (activeId) {
          devLog(`[active container] ${activeId}`);
          if (activeId.startsWith('plan-api-')) {
            devLog('[inspect] virtual API session (no Docker container)');
          } else {
            try {
              const info = await docker.getContainer(activeId).inspect();
              devLog(`[inspect] name=${info.Name} state=${info.State?.Status}`);
              devLog(`[inspect] started=${info.State?.StartedAt} pid=${info.State?.Pid}`);
              const envLines = (info.Config?.Env || [])
                .map(e => e.startsWith('GH_TOKEN') || e.includes('API_KEY') || e.includes('KEY=')
                  ? e.replace(/=(.{4}).*/, '=****') : e);
              devLog(`[inspect] env:\n  ${envLines.join('\n  ')}`);
            } catch (e) { devLog(`[inspect] ${e.message}`); }
          }
        } else {
          devLog('[active container] none');
        }
        break;
      }
    }
  });
});

// ── Docker event monitor ──────────────────────────────────────────────────────

async function watchDockerEvents() {
  try {
    const stream = await docker.getEvents({ filters: { type: ['container'] } });
    stream.on('data', chunk => {
      try {
        const ev        = JSON.parse(chunk.toString());
        const attrs     = ev.Actor?.Attributes || {};
        const isCopilot = attrs['archon'] || (attrs.image || '').includes('archon');
        if (isCopilot) {
          broadcast({
            type:        'docker_event',
            action:      ev.Action,
            containerId: ev.Actor.ID,
            name:        attrs.name,
          });
        }
      } catch (_) {}
    });
    stream.on('error', () => setTimeout(watchDockerEvents, 5000));
    stream.on('end',   () => setTimeout(watchDockerEvents, 5000));
  } catch (_) {
    setTimeout(watchDockerEvents, 5000);
  }
}

// ── Utils ─────────────────────────────────────────────────────────────────────

function bufToB64(chunk) {
  const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
  return buf.toString('base64');
}
function toB64(str) { return Buffer.from(str).toString('base64'); }

// ── Start ─────────────────────────────────────────────────────────────────────

server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🤖  Archon`);
  console.log(`    Local:  http://localhost:${PORT}`);
  console.log(`    Remote: ssh -L ${PORT}:localhost:${PORT} user@host  →  http://localhost:${PORT}\n`);
  watchDockerEvents();
});
