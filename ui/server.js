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
app.use(express.static(path.join(__dirname, 'public')));

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

// ── Helpers ───────────────────────────────────────────────────────────────────

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
    GH_TOKEN:                     cfg.ghToken || '',
    COPILOT_TASK:                 cfg.task || '',
    COPILOT_TASK_FILE:            cfg.taskFile || '',
    COPILOT_INSTRUCTIONS_REPO:    cfg.instructionsRepo || '',
    COPILOT_INSTRUCTIONS_FILE:    cfg.instructionsFile || 'copilot-instructions.md',
    COPILOT_INSTRUCTIONS_BRANCH:  cfg.instructionsBranch || 'main',
    COPILOT_USE_HOST_INSTRUCTIONS: (cfg.useHostInstructions !== false) ? 'true' : 'false',
    GIT_USER_NAME:                cfg.gitUserName || 'Copilot Agent',
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

async function createAndStart(cfg, mode) {
  const name        = `copilot-agent-${Date.now()}`;
  const interactive = mode === 'plan';

  const container = await docker.createContainer({
    name,
    Image:        'copilot-agent:latest',
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
      'copilot-agent':   'true',
      'copilot-mode':    mode,
      'copilot-project': cfg.projectPath ? path.basename(cfg.projectPath) : 'unknown',
    },
  });

  await container.start();
  return container;
}

function containerSummary(c) {
  return {
    id:      c.Id,
    shortId: c.Id.slice(0, 12),
    name:    (c.Names[0] || c.Id).replace(/^\//, ''),
    status:  c.Status,
    state:   c.State,
    mode:    c.Labels?.['copilot-mode'] || 'normal',
    project: c.Labels?.['copilot-project'] || '—',
    image:   c.Image,
  };
}

// ── REST API ──────────────────────────────────────────────────────────────────

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
        c.Labels?.['copilot-agent'] ||
        c.Image.includes('copilot-agent') ||
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
    const info = await docker.getImage('copilot-agent:latest').inspect();
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
    const stream = await docker.buildImage(ROOT_DIR, { t: 'copilot-agent:latest' });

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
  let logStream       = null;
  let containerStream = null; // plan mode interactive stream
  let activeId        = null;

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

    switch (msg.type) {

      // ── Stream logs of an existing container ───────────────────────────────
      case 'subscribe_logs': {
        cleanup();
        activeId = msg.containerId;
        try {
          const c = docker.getContainer(activeId);
          logStream = await c.logs({ stdout: true, stderr: true, follow: true, tail: 300, timestamps: false });

          logStream.on('data', chunk => {
            const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            safeSend(ws, { type: 'output', data: buf.toString('base64') });
          });
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
        try {
          const container = await createAndStart(msg.config, msg.mode || 'normal');
          activeId = container.id;
          safeSend(ws, { type: 'container_started', containerId: container.id, mode: msg.mode });

          logStream = await container.logs({ stdout: true, stderr: true, follow: true, tail: 0, timestamps: false });
          logStream.on('data', chunk => {
            safeSend(ws, { type: 'output', data: bufToB64(chunk) });
          });
          logStream.on('end', () => {
            safeSend(ws, { type: 'output', data: toB64('\r\n\x1b[90m[container exited]\x1b[0m\r\n') });
            safeSend(ws, { type: 'container_stopped', containerId: container.id });
          });
        } catch (err) {
          safeSend(ws, { type: 'error', message: `Start failed: ${err.message}` });
        }
        break;
      }

      // ── Start container in plan mode — full interactive PTY ───────────────
      case 'plan_container': {
        cleanup();
        try {
          const container = await createAndStart(msg.config, 'plan');
          activeId = container.id;
          safeSend(ws, { type: 'container_started', containerId: container.id, mode: 'plan' });

          containerStream = await container.attach({
            stream: true, stdin: true, stdout: true, stderr: true, hijack: true,
          });

          containerStream.on('data', chunk => {
            safeSend(ws, { type: 'output', data: bufToB64(chunk) });
          });
          containerStream.on('end', () => {
            safeSend(ws, { type: 'output', data: toB64('\r\n\x1b[90m[planning session ended — click Execute Plan to run]\x1b[0m\r\n') });
            safeSend(ws, { type: 'container_stopped', containerId: container.id });
            safeSend(ws, { type: 'plan_complete' });
          });
        } catch (err) {
          safeSend(ws, { type: 'error', message: `Plan start failed: ${err.message}` });
        }
        break;
      }

      // ── Send keyboard input to plan terminal ──────────────────────────────
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
        const isCopilot = attrs['copilot-agent'] || (attrs.image || '').includes('copilot-agent');
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
  console.log(`\n🤖  Copilot Agent UI`);
  console.log(`    Local:  http://localhost:${PORT}`);
  console.log(`    Remote: ssh -L ${PORT}:localhost:${PORT} user@host  →  http://localhost:${PORT}\n`);
  watchDockerEvents();
});
