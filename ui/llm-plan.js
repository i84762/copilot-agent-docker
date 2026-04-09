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
  sessions.set(sessionId, { agent, config, messages: [] });
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

// ── System prompt ────────────────────────────────────────────────────────────

function buildSystemPrompt(config, projectContext) {
  const task = config.task || config.copilotTask || '';
  const name = config.sessionName || 'this project';

  return `You are Archon, an expert AI software engineer and technical architect.
You are engaged in an intensive PLANNING SESSION for: "${name}".

## IMPORTANT — You are a text-only planning assistant
You do NOT have shell access, tool calls, or the ability to run commands.
All project context you need is embedded below in "Project Files".
Read it carefully and reason from it directly. Do not ask to run anything.

## Your Role
Conduct a thorough, professional planning session before any code is written:
1. ANALYZE the task and existing codebase using the files provided below
2. ASK targeted clarifying questions about anything unclear or ambiguous
3. IDENTIFY technical risks, edge cases, and dependencies
4. PROPOSE a detailed implementation plan with concrete milestones
5. VALIDATE the plan with the user before declaring it ready

## Task / Requirements
${task}

## Project Files (read from disk — your entire codebase context)
${projectContext || '(No project files found — this may be a new project)'}

## Instructions
- Ask questions proactively. Do not assume. Surface all ambiguities.
- Explain WHY you chose each architectural approach.
- List risks and how you will mitigate them.
- Break work into small, testable milestones.
- Respond in clear markdown. Be thorough but structured.
- When you and the user are satisfied with the plan, output it wrapped in:
  <PLAN_START>
  ...full detailed plan...
  <PLAN_END>
- Until that tag is used, this is still an active planning discussion.`;
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

  await consumeSSE(res, onChunk, onDone, onError);
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

  await consumeSSEAnthropic(res, onChunk, onDone, onError);
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

  await consumeSSEGemini(res, onChunk, onDone, onError);
}

// ── SSE stream consumers ─────────────────────────────────────────────────────

/** OpenAI-style SSE: data: {"choices":[{"delta":{"content":"..."}}]} */
async function consumeSSE(res, onChunk, onDone, onError) {
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
        if (data === '[DONE]') { clearTimeout(stallTimer); onDone(); return; }
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
            clearTimeout(stallTimer); onDone(); return;
          }
        } catch { /* skip malformed */ }
      }
    }
    clearTimeout(stallTimer);
    onDone();
  } catch (e) {
    clearTimeout(stallTimer);
    onError(e);
  } finally {
    reader.releaseLock();
  }
}

/** Anthropic SSE: event: content_block_delta  data: {"delta":{"text":"..."}} */
async function consumeSSEAnthropic(res, onChunk, onDone, onError) {
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
            clearTimeout(stallTimer); onDone(); return;
          }
        } catch { /* skip */ }
      }
    }
    clearTimeout(stallTimer);
    onDone();
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

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Start a new planning session. Reads project context and builds system prompt.
 * Returns sessionId.
 */
function startPlanSession(config) {
  const sessionId = `plan-${Date.now()}`;
  const agent     = (config.agent || 'copilot').toLowerCase();
  const projectCtx = readProjectContext(config.projectPath);
  const systemPrompt = buildSystemPrompt(config, projectCtx);

  createSession(sessionId, agent, config);
  const sess = getSession(sessionId);
  sess.messages.push({ role: 'system', content: systemPrompt });

  return sessionId;
}

/**
 * Send a user message in a planning session.
 * Streams chunks via onChunk(text), calls onDone() when complete, onError(err) on failure.
 */
async function sendPlanMessage(sessionId, userText, onChunk, onDone, onError) {
  const sess = getSession(sessionId);
  if (!sess) { onError(new Error('Planning session not found')); return; }

  sess.messages.push({ role: 'user', content: userText });

  let full = '';
  const accChunk = text => { full += text; onChunk(text); };
  const accDone  = () => {
    sess.messages.push({ role: 'assistant', content: full });
    onDone(full);
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

module.exports = { startPlanSession, sendPlanMessage, extractFinalPlan, deleteSession, getSession };
