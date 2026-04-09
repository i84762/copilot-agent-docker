'use strict';

const express   = require('express');
const WebSocket = require('ws');
const Docker    = require('dockerode');
const http      = require('http');
const path      = require('path');
const fs        = require('fs');
const os        = require('os');

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

// ── WebSocket ─────────────────────────────────────────────────────────────────

wss.on('connection', ws => {
  const connId = Date.now();
  console.log(`[ws] client connected (id=${connId})`);
  ws.on('close',   () => console.log(`[ws] client disconnected (id=${connId})`));

  let logStream       = null;
  let containerStream = null; // plan mode interactive stream
  let activeId        = null;
  let activePlanAgent = 'copilot'; // track agent type for correct line ending
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

      // ── Start container in plan mode — full interactive PTY ───────────────
      case 'plan_container': {
        cleanup();

        function stepP(id, text, status) {
          safeSend(ws, { type: 'progress', step: id, text, status });
        }

        try {
          stepP('validate', 'Validating configuration',    'ok');
          devLog(`[plan] agent=${msg.config?.agent} project=${msg.config?.projectPath}`);

          // ── Pre-flight: check copilot token type before wasting container startup ─
          const preAgent = (msg.config?.agent || 'copilot').toLowerCase();
          if (preAgent === 'copilot' && msg.config?.ghToken) {
            const tok = msg.config.ghToken.trim();
            if (tok.startsWith('ghp_') || tok.startsWith('gho_') || tok.startsWith('ghu_')) {
              throw new Error(
                'Classic PAT detected (ghp_/gho_/ghu_). GitHub Copilot CLI v1.0.21+ requires a fine-grained PAT. ' +
                'Create one at github.com/settings/personal-access-tokens/new with Models (read) + Repositories (read) + User (read) permissions. ' +
                'Alternatively, switch to the Claude agent.'
              );
            }
          }

          stepP('docker',   'Connecting to Docker',        'active');
          await docker.ping();
          stepP('docker',   'Docker connected',            'ok');

          stepP('image',    'Checking agent image',        'active');
          try { await docker.getImage('archon:latest').inspect(); }
          catch { throw new Error('Image archon:latest not found — build it first via "🔨 Build Image"'); }
          stepP('image',    'Image ready',                 'ok');

          // ── CRITICAL: attach BEFORE start so we capture all output ──────────
          stepP('create',   'Creating container (plan mode)', 'active');
          const container = await createContainer(msg.config, 'plan');
          activeId = container.id;
          devLog(`[plan] containerId=${container.id}`);

          // Declare planAgent early — needed by the stream handler below
          const planAgent = (msg.config?.agent || 'copilot').toLowerCase();
          activePlanAgent = planAgent;

          stepP('attach',   'Attaching interactive PTY',   'active');
          containerStream = await container.attach({
            stream: true, stdin: true, stdout: true, stderr: true, hijack: true,
          });
          devLog(`[plan] PTY attached — starting container`);

          // ── All agents → chat UI (ANSI stripped, debounced bubbles) ──────────
          // Route all output through chat UI. Output BEFORE the initial planning
          // message is sent (entrypoint.sh startup banner, copilot TUI init) goes
          // only to devLog so the chat stays clean. Once agentReady=true, all
          // visible text is forwarded to chat bubbles.
          agentReady  = false;
          agentTyping = false;
          if (chatDebounce) { clearTimeout(chatDebounce); chatDebounce = null; }
          const DEBOUNCE_MS  = 2000;

          containerStream.on('data', chunk => {
            const rawBytes = chunk.length;
            const raw  = chunk.toString('utf8');
            const text = stripAnsi(raw);
            devLog(`[plan stream] ${rawBytes}b → ${text.length}ch visible${agentReady ? '' : ' (startup, suppressed)'}`);
            if (!agentReady || !text) return;

            // Signal typing indicator on first chunk of a new message
            if (!agentTyping) {
              agentTyping = true;
              safeSend(ws, { type: 'chat_typing' });
            }

            safeSend(ws, { type: 'chat_chunk', text });

            // Debounce: silence longer than DEBOUNCE_MS → end of agent response
            if (chatDebounce) clearTimeout(chatDebounce);
            chatDebounce = setTimeout(() => {
              agentTyping = false;
              safeSend(ws, { type: 'chat_message_end' });
            }, DEBOUNCE_MS);
          });

          containerStream.on('end', async () => {
            devLog(`[plan] stream ended for ${container.id}`);
            if (chatDebounce) clearTimeout(chatDebounce);

            // Fetch container exit code to surface in logs
            try {
              const info = await container.inspect();
              const exitCode = info.State?.ExitCode;
              devLog(`[plan] container exit code: ${exitCode}`);
              if (exitCode !== 0) {
                // Fetch last lines of docker logs for diagnosis
                const rawLogs = await container.logs({ stdout: true, stderr: true, tail: 30 });
                const lastLines = rawLogs.toString('utf8').replace(/[\x00-\x08\x0e-\x1f\x7f]/g, '').trim();
                devLog(`[plan] container last logs:\n${lastLines}`);
                safeSend(ws, { type: 'chat_system', text: `⚠️ Container exited with code ${exitCode}. Check Dev Logs for details.` });
              }
            } catch (e) { devLog(`[plan] inspect after exit failed: ${e.message}`); }

            safeSend(ws, { type: 'chat_message_end' });
            safeSend(ws, { type: 'chat_system', text: '📋 Planning session ended — click Execute Plan to run.' });
            safeSend(ws, { type: 'container_stopped', containerId: container.id });
            safeSend(ws, { type: 'plan_complete' });
          });
          containerStream.on('error', err => {
            devLog(`[plan stream error] ${err.message}`);
            safeSend(ws, { type: 'chat_system', text: `⚠️ Stream error: ${err.message}` });
          });

          // ── Watch copilot log file for auth errors (surfaced to chat UI) ──────
          // Copilot logs errors to a process log file but never to stdout/PTY.
          // Poll the log dir and tail the newest log file to catch auth failures.
          if (planAgent === 'copilot') {
            const logPollTimer = setInterval(async () => {
              try {
                const exec = await container.exec({
                  Cmd: ['bash', '-c',
                    'f=$(ls -t /workspace/.copilot-session/copilot-home/logs/process-*.log 2>/dev/null | head -1); ' +
                    '[ -f "$f" ] && grep -E "ERROR|Logged out|not supported|unauthorized|unauthenticated" "$f" | tail -5'],
                  AttachStdout: true, AttachStderr: false,
                });
                const s = await exec.start({ hijack: false, stdin: false });
                let out = '';
                s.on('data', d => { out += d.toString('utf8').replace(/[\x00-\x08]/g, ''); });
                s.on('end', () => {
                  if (!out.trim()) return;
                  if (out.includes('Classic PATs are not supported')) {
                    clearInterval(logPollTimer);
                    safeSend(ws, { type: 'chat_system',
                      text: '❌ **Authentication failed:** Your GitHub token is a Classic PAT, which Copilot CLI v1.0.21 no longer supports.\n\n' +
                            '**Fix options:**\n' +
                            '1. Switch to the **Claude** agent (recommended — no GitHub auth needed, add ANTHROPIC_API_KEY)\n' +
                            '2. Generate a **fine-grained PAT** at github.com/settings/tokens?type=beta and update your GH_TOKEN' });
                  } else if (out.includes('Logged out') || out.includes('unauthorized') || out.includes('unauthenticated')) {
                    clearInterval(logPollTimer);
                    safeSend(ws, { type: 'chat_system',
                      text: '❌ **Copilot authentication failed.** Check your GH_TOKEN and ensure it has Copilot access. Check Dev Logs for details.' });
                    devLog(`[plan auth-check] errors found:\n${out.trim()}`);
                  }
                });
              } catch (_) { /* container may have exited */ clearInterval(logPollTimer); }
            }, 5000);
            // Stop polling once agentReady (message sent) + 60s
            setTimeout(() => clearInterval(logPollTimer), 90000);
          }

          await container.start();
          stepP('create',   'Container started',           'ok');
          stepP('attach',   'Interactive session ready',   'ok');

          // ── Auto-setup: grant permissions then send initial planning message ─
          const planTask     = (msg.config?.task     || '').trim();
          const planTaskFile = (msg.config?.taskFile || '').trim();

          // Build rich initial message. The instructions file (written by plan-mode.sh)
          // provides the system context / "how to behave"; this message provides the WHAT.
          let taskBlock = '';
          if (planTask) taskBlock += '## Task / Requirements\n\n' + planTask + '\n\n';
          if (planTaskFile) {
            taskBlock += '## Additional requirements file\n\nA requirements file was provided at: `' +
              planTaskFile + '`\n' +
              'Please read it: `cat "/workspace/' + planTaskFile.replace(/\\/g, '/').replace(/^[A-Za-z]:\//, '') + '" 2>/dev/null`\n\n';
          }
          if (!taskBlock) taskBlock = '## Task\n\n(No task provided — please ask the user what they want to build.)\n\n';

          const INITIAL_PLAN_MSG = taskBlock +
            '## Your mission\n\n' +
            'You are the planning agent in a **fully automated development pipeline**. ' +
            'After this planning session, a separate AI agent will receive PLAN.md as its only input ' +
            'and execute every milestone **completely autonomously** — no humans, no clarification, no stopping. ' +
            'The plan you write is the sole source of truth. Make it thorough.\n\n' +
            '## Begin: deep exploration first\n\n' +
            'Before writing a single word of your response, run ALL of these:\n' +
            '- `find /workspace -type f | grep -v \'.git\\|node_modules\\|.dart_tool\\|build\\|.pub-cache\' | sort | head -150`\n' +
            '- Read the project manifest (pubspec.yaml / package.json / go.mod / Cargo.toml / pom.xml)\n' +
            '- Read entry points, core architecture files, state management, routing\n' +
            '- Read EVERY requirements/spec/task document in /workspace\n' +
            '- `git -C /workspace log --oneline -30` — understand recent history\n' +
            '- `find /workspace -name \'*_test*\' -o -name \'*.test.*\' -o -name \'*.spec.*\' | grep -v node_modules | head -30`\n\n' +
            '## Then return ONE structured analysis with ALL these sections:\n\n' +
            '1. **Project Overview** — stack, architecture, key components, current state\n' +
            '2. **Requirements Analysis** — what you understood + mapping to affected code\n' +
            '3. **Gaps & Ambiguities** — numbered, exhaustive — every unclear or underspecified requirement\n' +
            '4. **Technical Risks** — breaking changes, conflicts, constraints from existing patterns\n' +
            '5. **Suggestions** — better approaches, simplifications, scope recommendations\n' +
            '6. **Clarifying Questions** — numbered — every answer that would meaningfully change the plan\n\n' +
            'Do NOT write code. Do NOT write PLAN.md yet. Deliver the analysis only.\n' +
            'I will answer your questions, then you write the plan.';

          // Write the initial planning brief to a file in the container so we can
          // send a single-line prompt to the agent PTY (multiline stdin writes
          // send multiple Enter keypresses, confusing TUI apps like copilot).
          const writeBrief = async () => {
            try {
              const exec = await container.exec({
                Cmd: ['bash', '-c', `cat > /workspace/.planning-brief.md << 'BRIEFEOF'\n${INITIAL_PLAN_MSG}\nBRIEFEOF`],
                AttachStdout: true, AttachStderr: true,
              });
              const s = await exec.start({ hijack: true, stdin: false });
              await new Promise(r => s.on('end', r));
              devLog('[plan auto-setup] planning brief written to /workspace/.planning-brief.md');
            } catch (e) {
              devLog(`[plan auto-setup] brief write failed: ${e.message}`);
            }
          };

          if (planAgent === 'copilot') {
            // Step 1 (15s): send /allow-all to grant filesystem permissions
            setTimeout(() => {
              if (containerStream) {
                devLog('[plan auto-setup] sending /allow-all');
                containerStream.write(Buffer.from('/allow-all\r'));
              }
            }, 15000);
            // Step 2 (20s): write brief + send trigger + flip agentReady
            setTimeout(async () => {
              await writeBrief();
              if (containerStream) {
                devLog('[plan auto-setup] sending initial planning message');
                agentReady = true;
                safeSend(ws, { type: 'chat_system', text: '🔍 Agent is now exploring your project — this may take several minutes…' });
                safeSend(ws, { type: 'chat_typing' });
                agentTyping = true;
                containerStream.write(Buffer.from(
                  'Please read /workspace/.planning-brief.md and follow all instructions in it exactly. ' +
                  'Start by running the exploration commands listed there before writing your first response.\r'
                ));
              }
            }, 20000);
          } else {
            // claude/gemini/aider: write brief then send single-line trigger
            const delay = planAgent === 'claude' ? 4000 : 5000;
            setTimeout(async () => {
              await writeBrief();
              if (containerStream) {
                devLog('[plan auto-setup] sending initial planning message');
                agentReady = true;
                safeSend(ws, { type: 'chat_system', text: '🔍 Agent is now exploring your project…' });
                safeSend(ws, { type: 'chat_typing' });
                agentTyping = true;
                containerStream.write(Buffer.from(
                  'Please read /workspace/.planning-brief.md and follow all instructions in it exactly. ' +
                  'Start by running the exploration commands listed there before writing your first response.\n'
                ));
              }
            }, delay);
          }

          safeSend(ws, { type: 'progress_done' });
          safeSend(ws, { type: 'container_started', containerId: container.id, mode: 'plan' });

        } catch (err) {
          devLog(`[plan error] ${err.stack || err.message}`);
          safeSend(ws, { type: 'progress_error', message: err.message });
          safeSend(ws, { type: 'error', message: `Plan start failed: ${err.message}` });
        }
        break;
      }

      // ── Send user message to planning chat ────────────────────────────────
      case 'chat_input': {
        if (containerStream && msg.text) {
          try {
            devLog(`[chat_input] ${msg.text.slice(0, 120)}`);
            // Ensure agent is in ready mode (user reply always enables output)
            agentReady = true;
            // Show typing indicator immediately so user gets feedback
            if (!agentTyping) {
              agentTyping = true;
              safeSend(ws, { type: 'chat_typing' });
            }
            // copilot and aider are TUI apps running in raw PTY mode — they expect
            // \r (Enter key) not \n to submit a message. Claude/Gemini use line mode (\n).
            const lineEnd = (activePlanAgent === 'copilot' || activePlanAgent === 'aider') ? '\r' : '\n';
            containerStream.write(Buffer.from(msg.text + lineEnd));
          } catch (err) {
            safeSend(ws, { type: 'error', message: `Chat input: ${err.message}` });
          }
        }
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
              c.Labels?.['copilot-agent'] ||
              c.Image.includes('copilot-agent') ||
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
          try {
            const info = await docker.getContainer(activeId).inspect();
            devLog(`[inspect] name=${info.Name} state=${info.State?.Status}`);
            devLog(`[inspect] started=${info.State?.StartedAt} pid=${info.State?.Pid}`);
            const envLines = (info.Config?.Env || [])
              .map(e => e.startsWith('GH_TOKEN') || e.includes('API_KEY') || e.includes('KEY=')
                ? e.replace(/=(.{4}).*/, '=****') : e);
            devLog(`[inspect] env:\n  ${envLines.join('\n  ')}`);
          } catch (e) { devLog(`[inspect] ${e.message}`); }
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
