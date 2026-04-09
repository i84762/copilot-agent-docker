/**
 * llm-plan.js — Direct LLM API integration for Archon planning sessions.
 *
 * Planning uses streaming LLM APIs directly (no Docker container TUI).
 * Execution still uses the Docker container with the agent CLI.
 *
 * Supported agents:
 *   copilot  → GitHub Models API (OpenAI-compatible, uses GH_TOKEN with Models:read)
 *   claude   → Anthropic Messages API  (uses ANTHROPIC_API_KEY)
 *   gemini   → Google Generative Language API (uses GEMINI_API_KEY)
 *   aider    → falls back to claude or gemini based on which key is present
 */

'use strict';

const fs   = require('fs');
const path = require('path');

// ── Per-session state ────────────────────────────────────────────────────────

const sessions = new Map();   // sessionId → { agent, config, messages: [] }

function createSession(sessionId, agent, config) {
  sessions.set(sessionId, { agent, config, messages: [], currentStep: 'requirements', completedSteps: [] });
}

function getSession(sessionId) {
  return sessions.get(sessionId);
}

function deleteSession(sessionId) {
  sessions.delete(sessionId);
}

// ── Project context helpers ──────────────────────────────────────────────────

/**
 * Read key project files from the host projectPath and return them as a
 * single string suitable for inclusion in the LLM system prompt.
 * Limits each file to 4 KB; skips binaries and node_modules.
 */
function readProjectContext(projectPath, maxTotalChars = 40000) {
  if (!projectPath || !fs.existsSync(projectPath)) return '';

  const SKIP_DIRS  = new Set(['node_modules', '.git', '.dart_tool', 'build', 'dist', '.gradle', '.idea', '__pycache__']);
  const SKIP_EXTS  = new Set(['.png','.jpg','.jpeg','.gif','.svg','.ico','.woff','.woff2','.ttf','.eot',
                               '.pdf','.zip','.tar','.gz','.jar','.class','.pyc','.lock','.log']);
  const PRIO_FILES = ['README.md','pubspec.yaml','package.json','requirements.txt',
                      'Cargo.toml','go.mod','pom.xml','build.gradle',
                      'copilot-instructions.md','TASK.md','REQUIREMENTS.md'];

  const parts = [];
  let total   = 0;

  const tryAdd = (filePath, label) => {
    if (total >= maxTotalChars) return;
    try {
      const content = fs.readFileSync(filePath, 'utf8').slice(0, 4096);
      parts.push(`### ${label}\n\`\`\`\n${content}\n\`\`\``);
      total += content.length;
    } catch { /* skip unreadable */ }
  };

  // Priority files first
  for (const name of PRIO_FILES) {
    const full = path.join(projectPath, name);
    if (fs.existsSync(full)) tryAdd(full, name);
  }

  // Walk directory tree (BFS, skip heavy dirs)
  const queue = [projectPath];
  while (queue.length && total < maxTotalChars) {
    const dir = queue.shift();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) queue.push(full);
      } else if (e.isFile()) {
        const ext = path.extname(e.name).toLowerCase();
        if (!SKIP_EXTS.has(ext) && !PRIO_FILES.includes(e.name)) tryAdd(full, path.relative(projectPath, full));
      }
    }
  }

  return parts.join('\n\n');
}

// ── Planning steps definition ────────────────────────────────────────────────

const PLANNING_STEPS = [
  { id: 'requirements',  label: 'Requirements',    icon: '📋' },
  { id: 'codebase',      label: 'Codebase Review', icon: '🔍' },
  { id: 'gaps',          label: 'Gaps & Unknowns', icon: '❓' },
  { id: 'approach',      label: 'Technical Approach', icon: '🏗️' },
  { id: 'plan',          label: 'Final Plan',       icon: '✅' },
];

// ── System prompt ────────────────────────────────────────────────────────────

function buildSystemPrompt(config, projectContext) {
  const task = config.task || config.copilotTask || '';
  const name = config.sessionName || 'this project';

  return `You are Archon, an expert AI software engineer and technical architect.
You are engaged in a PLANNING SESSION for: "${name}".

## IMPORTANT — You are a text-only planning assistant
You do NOT have shell access, tool calls, or the ability to run commands.
All project context is embedded below in "Project Files". Reason from it directly.

## Structured 5-Step Planning Process
You MUST follow this process exactly — one step at a time, in order:

STEP 1 — requirements  : Requirements Clarification
STEP 2 — codebase      : Codebase Review & Context
STEP 3 — gaps          : Gaps & Unknowns
STEP 4 — approach      : Technical Approach
STEP 5 — plan          : Final Plan

### Rules
- Cover ONLY the current step. Do not jump ahead.
- At the START of every response, on its own line, output the step tag:
  <STEP:requirements>  or  <STEP:codebase>  etc.
- At the END of a step (when you believe you have enough info to move forward),
  output on its own line: <STEP_DONE:step_id>
  Then ask the user: "Shall I move to [next step name], or is there anything to revisit?"
- You MAY go back to a previous step if the user requests it or if new info changes things.
  When going back, emit the tag for that step.
- On STEP 5 only, after presenting the plan, wrap it in:
  <PLAN_START>
  ...full detailed plan...
  <PLAN_END>

### What each step covers
STEP 1 — requirements:
  - Restate the task in your own words
  - List what you understand as required features/outcomes
  - Ask targeted clarifying questions (numbered list) — ONLY things that affect architecture
  - Do NOT analyze code yet

STEP 2 — codebase:
  - Review the provided project files
  - Summarize the existing architecture, patterns, and tech stack
  - Identify relevant existing code that the task will interact with
  - No questions needed unless critical — summarize what you found

STEP 3 — gaps:
  - List specific gaps, unknowns, or conflicts between requirements and codebase
  - Ask the user to resolve any blockers before proceeding
  - Keep this focused — only real blockers, not hypotheticals

STEP 4 — approach:
  - Propose the technical approach: architecture decisions, libraries, patterns
  - Break work into ordered milestones with acceptance criteria
  - Call out risks and mitigations
  - Ask for approval or changes before finalizing

STEP 5 — plan:
  - Write the complete, detailed implementation plan
  - Include: file-by-file changes, milestone sequence, test strategy
  - Output the plan inside <PLAN_START>...<PLAN_END> tags when finalized

## Task / Requirements
${task}

## Project Files (your entire codebase context — reason from these directly)
${projectContext || '(No project files found — this may be a new project)'}`;
}

// ── Agent API implementations ────────────────────────────────────────────────

/**
 * GitHub Models API (OpenAI-compatible).
 * Fine-grained PAT with Models:read permission.
 */
async function streamCopilot(messages, config, onChunk, onDone, onError) {
  const token = config.ghToken;
  if (!token) { onError(new Error('GH_TOKEN not configured')); return; }

  const body = JSON.stringify({
    model:    'gpt-4o',
    messages,
    stream:   true,
    max_tokens: 4096,
  });

  let res;
  try {
    res = await fetch('https://models.inference.ai.azure.com/chat/completions', {
      method:  'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type':  'application/json',
        'Accept':        'text/event-stream',
      },
      body,
    });
  } catch (e) { onError(e); return; }

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    onError(new Error(`GitHub Models API ${res.status}: ${text.slice(0, 200)}`));
    return;
  }

  // Extract quota from response headers (GitHub Models returns these)
  const quota = {
    provider:  'GitHub Models',
    remaining: res.headers.get('x-ratelimit-remaining-requests') || res.headers.get('x-ms-quota-remaining-requests'),
    limit:     res.headers.get('x-ratelimit-limit-requests')     || res.headers.get('x-ms-quota-limit-requests'),
  };

  await consumeSSE(res, onChunk, (q) => onDone(q), onError, quota);
}

/**
 * Anthropic Messages API with streaming.
 */
async function streamClaude(messages, config, onChunk, onDone, onError) {
  const apiKey = config.anthropicApiKey;
  if (!apiKey) { onError(new Error('ANTHROPIC_API_KEY not configured')); return; }

  // Anthropic splits system prompt into top-level field
  const systemMsg = messages.find(m => m.role === 'system');
  const chatMsgs  = messages.filter(m => m.role !== 'system');

  const body = JSON.stringify({
    model:      'claude-opus-4-5',
    system:     systemMsg?.content || '',
    messages:   chatMsgs,
    stream:     true,
    max_tokens: 4096,
  });

  let res;
  try {
    res = await fetch('https://api.anthropic.com/v1/messages', {
      method:  'POST',
      headers: {
        'x-api-key':         apiKey,
        'anthropic-version': '2023-06-01',
        'Content-Type':      'application/json',
        'Accept':            'text/event-stream',
      },
      body,
    });
  } catch (e) { onError(e); return; }

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    onError(new Error(`Anthropic API ${res.status}: ${text.slice(0, 200)}`));
    return;
  }

  const quota = {
    provider:  'Anthropic',
    remaining: res.headers.get('anthropic-ratelimit-requests-remaining'),
    limit:     res.headers.get('anthropic-ratelimit-requests-limit'),
  };

  await consumeSSEAnthropic(res, onChunk, (q) => onDone(q), onError, quota);
}

/**
 * Google Generative Language API with streaming.
 */
async function streamGemini(messages, config, onChunk, onDone, onError) {
  const apiKey = config.geminiApiKey;
  if (!apiKey) { onError(new Error('GEMINI_API_KEY not configured')); return; }

  // Convert OpenAI-style messages to Gemini format
  const systemMsg = messages.find(m => m.role === 'system');
  const chatMsgs  = messages.filter(m => m.role !== 'system');
  const contents  = chatMsgs.map(m => ({
    role:  m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }],
  }));

  const body = JSON.stringify({
    system_instruction: systemMsg ? { parts: [{ text: systemMsg.content }] } : undefined,
    contents,
    generationConfig: { maxOutputTokens: 4096 },
  });

  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:streamGenerateContent?key=${apiKey}&alt=sse`;
  let res;
  try {
    res = await fetch(url, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });
  } catch (e) { onError(e); return; }

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    onError(new Error(`Gemini API ${res.status}: ${text.slice(0, 200)}`));
    return;
  }

  // Gemini doesn't expose quota headers — pass null
  await consumeSSEGemini(res, onChunk, () => onDone(null), onError);
}

// ── SSE stream consumers ─────────────────────────────────────────────────────

/** OpenAI-style SSE: data: {"choices":[{"delta":{"content":"..."}}]} */
async function consumeSSE(res, onChunk, onDone, onError, quota) {
  const reader  = res.body.getReader();
  const decoder = new TextDecoder();
  let   buf     = '';
  let   gotContent = false;

  // Stall timeout: if no data arrives for 60s, give up
  let stallTimer = null;
  const resetStall = () => {
    if (stallTimer) clearTimeout(stallTimer);
    stallTimer = setTimeout(() => {
      reader.cancel().catch(() => {});
      onError(new Error('LLM stream timed out after 60s of silence'));
    }, 60000);
  };
  resetStall();

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      resetStall();
      buf += decoder.decode(value, { stream: true });

      const lines = buf.split('\n');
      buf = lines.pop();    // keep incomplete line

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6).trim();
        if (data === '[DONE]') { clearTimeout(stallTimer); onDone(quota); return; }
        try {
          const obj  = JSON.parse(data);
          const text = obj.choices?.[0]?.delta?.content;
          if (text) { gotContent = true; onChunk(text); }
          // Detect finish_reason to end cleanly even if [DONE] is missing
          const finish = obj.choices?.[0]?.finish_reason;
          if (finish && finish !== 'null' && finish !== null) {
            // If model used tool_calls without any content, surface an error
            if (!gotContent && finish === 'tool_calls') {
              clearTimeout(stallTimer);
              onError(new Error('Model attempted tool_calls (not supported in planning mode). Try the Claude agent instead.'));
              return;
            }
            clearTimeout(stallTimer); onDone(quota); return;
          }
        } catch { /* skip malformed */ }
      }
    }
    clearTimeout(stallTimer);
    onDone(quota);
  } catch (e) {
    clearTimeout(stallTimer);
    onError(e);
  } finally {
    reader.releaseLock();
  }
}

/** Anthropic SSE: event: content_block_delta  data: {"delta":{"text":"..."}} */
async function consumeSSEAnthropic(res, onChunk, onDone, onError, quota) {
  const reader  = res.body.getReader();
  const decoder = new TextDecoder();
  let   buf     = '';

  let stallTimer = null;
  const resetStall = () => {
    if (stallTimer) clearTimeout(stallTimer);
    stallTimer = setTimeout(() => {
      reader.cancel().catch(() => {});
      onError(new Error('Anthropic stream timed out after 60s of silence'));
    }, 60000);
  };
  resetStall();

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      resetStall();
      buf += decoder.decode(value, { stream: true });

      const lines = buf.split('\n');
      buf = lines.pop();

      let lastEvent = '';
      for (const line of lines) {
        if (line.startsWith('event: ')) { lastEvent = line.slice(7).trim(); continue; }
        if (!line.startsWith('data: '))  continue;
        const data = line.slice(6).trim();
        try {
          const obj = JSON.parse(data);
          if (lastEvent === 'content_block_delta') {
            const text = obj.delta?.text;
            if (text) onChunk(text);
          } else if (lastEvent === 'message_stop') {
            clearTimeout(stallTimer); onDone(quota); return;
          }
        } catch { /* skip */ }
      }
    }
    clearTimeout(stallTimer);
    onDone(quota);
  } catch (e) {
    clearTimeout(stallTimer);
    onError(e);
  } finally {
    reader.releaseLock();
  }
}

/** Gemini SSE: data: {"candidates":[{"content":{"parts":[{"text":"..."}]}}]} */
async function consumeSSEGemini(res, onChunk, onDone, onError) {
  const reader  = res.body.getReader();
  const decoder = new TextDecoder();
  let   buf     = '';

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });

      const lines = buf.split('\n');
      buf = lines.pop();

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6).trim();
        try {
          const obj  = JSON.parse(data);
          const text = obj.candidates?.[0]?.content?.parts?.[0]?.text;
          if (text) onChunk(text);
          if (obj.candidates?.[0]?.finishReason === 'STOP') { onDone(); return; }
        } catch { /* skip */ }
      }
    }
    onDone();
  } catch (e) {
    onError(e);
  } finally {
    reader.releaseLock();
  }
}

// ── Session persistence ───────────────────────────────────────────────────────

const SESSION_DIR  = '.archon';
const SESSION_FILE = 'planning-session.json';
const SECRET_KEYS  = new Set(['ghToken', 'anthropicApiKey', 'geminiApiKey', 'openaiApiKey']);

function getSessionFilePath(projectPath) {
  return path.join(projectPath, SESSION_DIR, SESSION_FILE);
}

function savePlanSession(sessionId) {
  const sess = getSession(sessionId);
  if (!sess || !sess.config?.projectPath) return;
  try {
    const filePath = getSessionFilePath(sess.config.projectPath);
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    // Strip secrets from saved config
    const safeConfig = Object.fromEntries(
      Object.entries(sess.config).filter(([k]) => !SECRET_KEYS.has(k))
    );
    const data = {
      savedAt:        new Date().toISOString(),
      agent:          sess.agent,
      config:         safeConfig,
      messages:       sess.messages,
      currentStep:    sess.currentStep,
      completedSteps: sess.completedSteps,
    };
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
  } catch (e) { /* non-fatal */ }
}

function loadSavedSession(projectPath) {
  const filePath = getSessionFilePath(projectPath);
  if (!fs.existsSync(filePath)) return null;
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); }
  catch { return null; }
}

function deleteSavedSession(projectPath) {
  const filePath = getSessionFilePath(projectPath);
  if (fs.existsSync(filePath)) { try { fs.unlinkSync(filePath); } catch { /* ok */ } }
}

function getSavedSessionMeta(projectPath) {
  const saved = loadSavedSession(projectPath);
  if (!saved) return null;
  const stepDef = PLANNING_STEPS.find(s => s.id === saved.currentStep);
  const msgCount = (saved.messages || []).filter(m => m.role !== 'system').length;
  return {
    savedAt:      saved.savedAt,
    agent:        saved.agent,
    currentStep:  saved.currentStep,
    stepLabel:    stepDef ? stepDef.label : saved.currentStep,
    completedSteps: saved.completedSteps || [],
    messageCount: msgCount,
    taskPreview:  (saved.config?.task || '').slice(0, 80),
  };
}



/**
 * Start a planning session. If resume=true and a saved session exists for
 * config.projectPath, restores messages/step from disk (fresh tokens from config).
 * Returns { sessionId, resumed, currentStep, completedSteps }.
 */
function startPlanSession(config, resume = false) {
  const sessionId = `plan-${Date.now()}`;
  const agent     = (config.agent || 'copilot').toLowerCase();

  if (resume && config.projectPath) {
    const saved = loadSavedSession(config.projectPath);
    if (saved && saved.messages?.length) {
      createSession(sessionId, agent, config);
      const sess = getSession(sessionId);
      // Restore conversation; keep current config (with fresh tokens)
      sess.messages       = saved.messages;
      sess.currentStep    = saved.currentStep    || 'requirements';
      sess.completedSteps = saved.completedSteps || [];
      return { sessionId, resumed: true, currentStep: sess.currentStep, completedSteps: sess.completedSteps };
    }
  }

  // Fresh start — delete any stale saved session
  if (config.projectPath) deleteSavedSession(config.projectPath);

  const projectCtx   = readProjectContext(config.projectPath);
  const systemPrompt = buildSystemPrompt(config, projectCtx);
  createSession(sessionId, agent, config);
  const sess = getSession(sessionId);
  sess.messages.push({ role: 'system', content: systemPrompt });

  return { sessionId, resumed: false, currentStep: 'requirements', completedSteps: [] };
}

/**
 * Send a user message in a planning session.
 * Streams chunks via onChunk(text), calls onDone(full, quota) when complete.
 * onStep(stepId, done) is called when the agent emits <STEP:x> or <STEP_DONE:x> tags.
 * Step tags are stripped from the visible output.
 */
async function sendPlanMessage(sessionId, userText, onChunk, onDone, onError, onStep) {
  const sess = getSession(sessionId);
  if (!sess) { onError(new Error('Planning session not found')); return; }

  sess.messages.push({ role: 'user', content: userText });

  let full = '';
  let tagBuf = '';  // accumulates partial tag text between chunks

  const STEP_RE      = /<STEP:([a-z_]+)>/g;
  const STEP_DONE_RE = /<STEP_DONE:([a-z_]+)>/g;

  const accChunk = text => {
    // Accumulate for full text
    full += text;
    tagBuf += text;

    // Detect and fire step change tags — strip them from visible output
    let visible = tagBuf;

    // Handle <STEP:id> tags
    let match;
    STEP_RE.lastIndex = 0;
    while ((match = STEP_RE.exec(tagBuf)) !== null) {
      const stepId = match[1];
      if (stepId !== sess.currentStep) {
        sess.currentStep = stepId;
        if (onStep) onStep(stepId, false);
      }
    }
    // Handle <STEP_DONE:id> tags
    STEP_DONE_RE.lastIndex = 0;
    while ((match = STEP_DONE_RE.exec(tagBuf)) !== null) {
      const stepId = match[1];
      if (!sess.completedSteps.includes(stepId)) sess.completedSteps.push(stepId);
      if (onStep) onStep(stepId, true);
    }

    // Strip all step tags from visible text
    visible = visible.replace(/<STEP:[a-z_]+>/g, '').replace(/<STEP_DONE:[a-z_]+>/g, '');
    tagBuf = '';

    if (visible) onChunk(visible);
  };

  const accDone  = (quota) => {
    sess.messages.push({ role: 'assistant', content: full });
    savePlanSession(sessionId);   // persist after every agent reply
    onDone(full, quota);
  };

  const agent = sess.agent;
  if (agent === 'copilot') {
    await streamCopilot(sess.messages, sess.config, accChunk, accDone, onError);
  } else if (agent === 'claude') {
    await streamClaude(sess.messages, sess.config, accChunk, accDone, onError);
  } else if (agent === 'gemini') {
    await streamGemini(sess.messages, sess.config, accChunk, accDone, onError);
  } else {
    // aider: fall back to claude if key present, else copilot
    if (sess.config.anthropicApiKey) {
      await streamClaude(sess.messages, sess.config, accChunk, accDone, onError);
    } else {
      await streamCopilot(sess.messages, sess.config, accChunk, accDone, onError);
    }
  }
}

/**
 * Extract the finalized plan from the last assistant message (between PLAN_START / PLAN_END tags).
 * Returns the plan text, or null if not yet finalized.
 */
function extractFinalPlan(sessionId) {
  const sess = getSession(sessionId);
  if (!sess) return null;
  const last = [...sess.messages].reverse().find(m => m.role === 'assistant');
  if (!last) return null;
  const match = last.content.match(/<PLAN_START>([\s\S]*?)<PLAN_END>/);
  return match ? match[1].trim() : null;
}

module.exports = { startPlanSession, sendPlanMessage, extractFinalPlan, deleteSession, getSession, getSavedSessionMeta, deleteSavedSession, PLANNING_STEPS };
