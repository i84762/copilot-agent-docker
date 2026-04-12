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

const SKIP_DIRS  = new Set(['node_modules', '.git', '.dart_tool', 'build', 'dist', '.gradle', '.idea', '__pycache__']);
const SKIP_EXTS  = new Set(['.png','.jpg','.jpeg','.gif','.svg','.ico','.woff','.woff2','.ttf','.eot',
                             '.pdf','.zip','.tar','.gz','.jar','.class','.pyc','.lock','.log',
                             '.mp4','.mp3','.mov','.avi','.webm','.apk','.aab','.ipa']);
const PRIO_FILES = ['README.md','pubspec.yaml','package.json','requirements.txt',
                    'Cargo.toml','go.mod','pom.xml','build.gradle','build.gradle.kts',
                    'settings.gradle','settings.gradle.kts','analysis_options.yaml',
                    'melos.yaml','copilot-instructions.md','TASK.md','REQUIREMENTS.md'];
const ALLOW_HIDDEN_DIRS = new Set(['.github']);
const STOP_WORDS = new Set([
  'about','after','again','agent','allow','already','also','always','among','app','because','before','being',
  'between','build','changes','clarify','could','current','details','during','each','from','have','into','just',
  'make','more','most','need','only','other','over','project','should','still','step','steps','task','than',
  'that','them','then','there','these','they','this','those','through','under','user','using','want','what',
  'when','where','which','while','with','would','your'
]);

function normalizeRel(filePath) {
  return filePath.split(path.sep).join('/');
}

function shouldSkipDir(name) {
  return SKIP_DIRS.has(name) || (name.startsWith('.') && !ALLOW_HIDDEN_DIRS.has(name));
}

function shouldSkipFile(name) {
  return SKIP_EXTS.has(path.extname(name).toLowerCase());
}

function buildProjectIndex(projectPath, maxFiles = 4000) {
  if (!projectPath || !fs.existsSync(projectPath)) {
    return { files: [], totalFiles: 0, totalDirs: 0, truncated: false };
  }

  const files = [];
  let totalFiles = 0;
  let totalDirs  = 0;
  let truncated  = false;
  const queue = [projectPath];

  while (queue.length && !truncated) {
    const dir = queue.shift();
    totalDirs += 1;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch { continue; }

    entries.sort((a, b) => {
      if (a.isDirectory() && !b.isDirectory()) return -1;
      if (!a.isDirectory() && b.isDirectory()) return 1;
      return a.name.localeCompare(b.name);
    });

    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!shouldSkipDir(entry.name)) queue.push(full);
        continue;
      }
      if (!entry.isFile() || shouldSkipFile(entry.name)) continue;

      totalFiles += 1;
      if (files.length >= maxFiles) {
        truncated = true;
        break;
      }

      const relPath = normalizeRel(path.relative(projectPath, full));
      const parts   = relPath.split('/');
      const topLevel = parts.length > 1 ? `${parts[0]}/` : '(root)';
      let size = 0;
      try { size = fs.statSync(full).size; } catch { /* ignore */ }

      files.push({
        path: relPath,
        name: entry.name,
        ext: path.extname(entry.name).toLowerCase(),
        dir: parts.slice(0, -1).join('/') || '.',
        topLevel,
        depth: parts.length - 1,
        size,
      });
    }
  }

  return { files, totalFiles, totalDirs, truncated };
}

function renderProjectMap(projectIndex) {
  if (!projectIndex?.files?.length) return '(No readable project files found — this may be a new project)';

  const byArea = new Map();
  projectIndex.files.forEach(file => {
    const area = byArea.get(file.topLevel) || { count: 0, samples: [] };
    area.count += 1;
    if (area.samples.length < 5) area.samples.push(file.path);
    byArea.set(file.topLevel, area);
  });

  const rootFiles = projectIndex.files
    .filter(f => f.topLevel === '(root)')
    .map(f => f.path)
    .slice(0, 12);

  const topAreas = [...byArea.entries()]
    .filter(([name]) => name !== '(root)')
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, 14)
    .map(([name, meta]) => `- ${name} (${meta.count} files): ${meta.samples.join(', ')}`);

  return [
    `Indexed readable files: ${projectIndex.totalFiles}${projectIndex.truncated ? '+' : ''}`,
    `Indexed directories: ${Math.max(projectIndex.totalDirs - 1, 0)}`,
    projectIndex.truncated ? `Index capped to the first ${projectIndex.files.length} readable files for performance.` : '',
    `Root files: ${rootFiles.length ? rootFiles.join(', ') : '(none)'}`,
    'Major areas:',
    ...(topAreas.length ? topAreas : ['- (no subdirectories indexed)']),
  ].filter(Boolean).join('\n');
}

function hydrateSessionContext(sess) {
  const projectPath = sess?.config?.projectPath;
  sess.projectIndex = buildProjectIndex(projectPath);
  sess.projectMap   = renderProjectMap(sess.projectIndex);
}

function extractKeywords(text, maxKeywords = 14) {
  const tokens = (text || '').toLowerCase().match(/[a-z0-9][a-z0-9._/-]{2,}/g) || [];
  const out = [];
  const seen = new Set();

  for (const token of tokens) {
    const parts = token.split(/[\/._-]+/);
    for (const part of parts) {
      if (part.length < 3) continue;
      if (/^\d+$/.test(part)) continue;
      if (STOP_WORDS.has(part)) continue;
      if (seen.has(part)) continue;
      seen.add(part);
      out.push(part);
      if (out.length >= maxKeywords) return out;
    }
  }
  return out;
}

function scoreFileForStep(file, stepId, keywords) {
  const rel  = file.path.toLowerCase();
  const base = file.name.toLowerCase();
  let score = 0;

  if (PRIO_FILES.includes(file.name)) score += 28;
  if (file.depth === 0) score += 6;
  if (file.size > 0 && file.size < 120000) score += 4;
  if (file.size > 350000) score -= 4;
  if (file.ext === '.dart') score += 4;

  for (const keyword of keywords) {
    if (base.includes(keyword)) score += 18;
    else if (rel.includes(keyword)) score += 10;
  }

  if (stepId === 'requirements') {
    if (['readme.md', 'task.md', 'requirements.md', 'pubspec.yaml', 'package.json'].includes(base)) score += 30;
    if (rel.startsWith('docs/')) score += 10;
  } else if (stepId === 'codebase') {
    if (rel.startsWith('lib/') || rel.startsWith('src/')) score += 18;
    if (/main|app|bootstrap|router|route|navigation/.test(base)) score += 14;
    if (/service|provider|bloc|store|controller|screen|page|view|widget/.test(rel)) score += 10;
    if (rel.startsWith('android/') || rel.startsWith('ios/') || rel.startsWith('web/') || rel.startsWith('windows/') || rel.startsWith('macos/')) score += 7;
  } else if (stepId === 'gaps') {
    if (rel.startsWith('lib/') || rel.startsWith('src/')) score += 14;
    if (/config|settings|env|auth|api|client|service|provider|repository/.test(rel)) score += 10;
  } else if (stepId === 'approach') {
    if (rel.startsWith('lib/') || rel.startsWith('src/')) score += 16;
    if (/architecture|router|route|service|provider|bloc|store|model|repository/.test(rel)) score += 12;
    if (PRIO_FILES.includes(file.name)) score += 8;
  } else if (stepId === 'testing') {
    if (rel.startsWith('test/') || rel.startsWith('integration_test/') || rel.startsWith('e2e/')) score += 30;
    if (/test|spec|mock|fixture/.test(rel)) score += 18;
    if (rel.startsWith('.github/workflows/')) score += 20;
    if (['pubspec.yaml', 'package.json', 'analysis_options.yaml'].includes(file.name)) score += 18;
    if (rel.startsWith('lib/') || rel.startsWith('src/')) score += 8;
  } else if (stepId === 'plan') {
    if (rel.startsWith('lib/') || rel.startsWith('src/')) score += 14;
    if (rel.startsWith('test/') || rel.startsWith('integration_test/') || rel.startsWith('e2e/')) score += 14;
    if (PRIO_FILES.includes(file.name)) score += 10;
  }

  return score;
}

function selectContextFiles(projectIndex, stepId, userText, historyText, maxFiles = 10) {
  if (!projectIndex?.files?.length) return [];

  const keywords = extractKeywords(`${userText || ''}\n${historyText || ''}`);
  const selected = [];
  const seen = new Set();
  const topCounts = new Map();

  const addIfPresent = relPath => {
    const file = projectIndex.files.find(f => f.path.toLowerCase() === relPath.toLowerCase());
    if (file && !seen.has(file.path)) {
      seen.add(file.path);
      selected.push(file);
      topCounts.set(file.topLevel, (topCounts.get(file.topLevel) || 0) + 1);
    }
  };

  const pinnedByStep = {
    requirements: ['README.md', 'TASK.md', 'REQUIREMENTS.md', 'pubspec.yaml', 'package.json'],
    codebase:     ['pubspec.yaml', 'package.json', 'lib/main.dart', 'lib/app.dart', 'src/main.ts', 'src/index.ts', 'src/App.tsx'],
    gaps:         ['pubspec.yaml', 'package.json', 'analysis_options.yaml'],
    approach:     ['pubspec.yaml', 'package.json', 'analysis_options.yaml'],
    testing:      ['pubspec.yaml', 'package.json', 'analysis_options.yaml'],
    plan:         ['pubspec.yaml', 'package.json', 'analysis_options.yaml'],
  };

  (pinnedByStep[stepId] || []).forEach(addIfPresent);

  const scored = projectIndex.files
    .map(file => ({ file, score: scoreFileForStep(file, stepId, keywords) }))
    .filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score || a.file.path.localeCompare(b.file.path));

  const softAreaLimit = stepId === 'testing' ? 5 : 4;
  for (const { file } of scored) {
    if (selected.length >= maxFiles) break;
    if (seen.has(file.path)) continue;
    const areaCount = topCounts.get(file.topLevel) || 0;
    if (areaCount >= softAreaLimit && selected.length < Math.floor(maxFiles * 0.7)) continue;
    seen.add(file.path);
    selected.push(file);
    topCounts.set(file.topLevel, areaCount + 1);
  }

  return selected.slice(0, maxFiles);
}

function readFileExcerpt(projectPath, relPath, maxChars) {
  const fullPath = path.join(projectPath, ...relPath.split('/'));
  try {
    const content = fs.readFileSync(fullPath, 'utf8');
    return {
      text: content.slice(0, maxChars),
      truncated: content.length > maxChars,
    };
  } catch {
    return null;
  }
}

function buildTurnContextPack(sess, latestUserText, maxChars) {
  const projectPath = sess?.config?.projectPath;
  if (!projectPath || !sess?.projectIndex?.files?.length || maxChars <= 0) return '';

  const recentHistory = sess.messages
    .filter(m => m.role !== 'system')
    .slice(-6)
    .map(m => m.content)
    .join('\n');

  const stepId = sess.currentStep || 'requirements';
  const maxFiles = stepId === 'testing' ? 10 : 8;
  const selected = selectContextFiles(sess.projectIndex, stepId, latestUserText, recentHistory, maxFiles);
  if (!selected.length) return '';

  const keywords = extractKeywords(`${latestUserText || ''}\n${recentHistory || ''}`);
  const headerLines = [
    'Planning Context Refresh (live repo excerpts for this turn only)',
    `Current step: ${stepId}`,
    `Indexed repo snapshot: ${sess.projectIndex.totalFiles}${sess.projectIndex.truncated ? '+' : ''} readable files`,
    keywords.length ? `Focus keywords: ${keywords.join(', ')}` : '',
    'Selected files:',
  ].filter(Boolean);

  const parts = [headerLines.join('\n')];
  let used = parts[0].length + 4;
  const remainingForFiles = Math.max(2000, maxChars - used);
  const perFileBudget = Math.max(1200, Math.min(3200, Math.floor(remainingForFiles / Math.max(selected.length, 1))));

  for (const file of selected) {
    if (used >= maxChars) break;
    const excerpt = readFileExcerpt(projectPath, file.path, perFileBudget);
    if (!excerpt?.text) continue;
    const body =
      `### ${file.path}\n\`\`\`\n${excerpt.text}${excerpt.truncated ? '\n... [truncated]' : ''}\n\`\`\``;
    if (used + body.length > maxChars && parts.length > 1) break;
    parts.push(body);
    used += body.length + 2;
  }

  return parts.join('\n\n');
}

// ── Planning steps definition ────────────────────────────────────────────────

const PLANNING_STEPS = [
  { id: 'requirements',  label: 'Requirements',    icon: '📋' },
  { id: 'codebase',      label: 'Codebase Review', icon: '🔍' },
  { id: 'gaps',          label: 'Gaps & Unknowns', icon: '❓' },
  { id: 'approach',      label: 'Technical Approach', icon: '🏗️' },
  { id: 'testing',       label: 'Testing Strategy', icon: '🧪' },
  { id: 'plan',          label: 'Final Plan',       icon: '✅' },
];

// ── System prompt ────────────────────────────────────────────────────────────

function buildSystemPrompt(config, projectMap) {
  const task = config.task || config.copilotTask || '';
  const name = config.sessionName || 'this project';

  return `You are Archon, an expert AI software engineer and technical architect driving a GUIDED PLANNING WIZARD for: "${name}".

## How your output is rendered
You are NOT writing chat messages. You are driving a structured UI with four zones:
  1. A top progress rail showing the 6 planning steps.
  2. An "Analysis" side drawer that collects your narrative observations (what you found, risks, architecture notes).
  3. A focused "Question Card" in the center that presents ONE decision at a time with clickable options.
  4. A "Decisions" sidebar that lists the answers the user already gave you.

The user interacts with the Question Card — they click an option (often your recommendation) and move on. Long prose, bullet walls, and multi-question messages do NOT work in this UI. Free text outside the tags below is hidden.

## IMPORTANT — You are a text-only planning assistant
You do NOT have shell access, tool calls, or the ability to run commands.
You receive project context in two forms:
  1. A repository map below (broad orientation).
  2. "Planning Context Refresh" messages during the conversation with targeted file excerpts for the current turn (authoritative for detail).
Do NOT assume unseen files exist, and do NOT pretend you inspected files that were not provided.

## Strict output protocol
Every reply MUST follow this protocol. The first non-empty line is always a step tag. All content lives inside tagged blocks — free text outside tags is dropped by the UI.

### Step tag (required first line)
<STEP:requirements>     (or: codebase, gaps, approach, testing, plan)

### Analysis block (zero or more per reply)
<ANALYSIS title="What I Found">
Short markdown narrative — observations, summary, risks, architecture notes.
Use bullets and short paragraphs. This goes into the Analysis drawer, NOT a question.
Do not put decisions or questions here.
</ANALYSIS>

### Question block (AT MOST ONE per reply — this is critical)
<QUESTION>
{
  "id": "unique-slug-for-this-decision",
  "type": "choice",
  "title": "Short question, max 80 chars, ending in '?'",
  "context": "One or two sentences explaining why this decision matters.",
  "options": [
    { "id": "opt-a", "label": "Short clickable label", "rationale": "Why this option", "recommended": true },
    { "id": "opt-b", "label": "Short clickable label", "rationale": "Why this option" }
  ]
}
</QUESTION>

### Step done marker (when you have no more blocking questions for this step)
<STEP_DONE:requirements>

### Final plan markers (STEP 6 only)
<PLAN_START>
...full detailed markdown plan...
<PLAN_END>

## Question types
You may set "type" to one of:

- "choice"  — N options, user picks one. Always provide at least 2 options.
- "confirm" — yes/no. Options MUST be [{"id":"yes","label":"Yes","rationale":"..."},{"id":"no","label":"No","rationale":"..."}] with one marked recommended.
- "multi"   — user picks zero or more. Mark recommended=true on every option you would pre-select.
- "text"    — freeform short text. Omit "options"; instead include "placeholder" and "default" (your recommended answer).
- "number"  — numeric input. Omit "options"; include "min", "max", and "default".

## Hard rules
1. Emit <STEP:x> as the FIRST non-empty line of every reply.
2. Emit AT MOST ONE <QUESTION> per reply. The UI shows one decision at a time — never stack multiple questions in a reply. If you have 3 decisions, ask them across 3 replies.
3. If the current step has no blocking decisions, skip the question and emit <STEP_DONE:x> so the UI can advance. Do not invent filler questions.
4. For choice/confirm/multi questions, exactly ONE option must have "recommended": true (or for "multi", all pre-selected options). Pick your recommendation carefully — the user can accept it with a single click.
5. Every option needs "id", "label", and a short "rationale" (one line, ≤ 120 chars).
6. "title" must be a complete question ending with "?". "context" must be ONE or TWO sentences of "why this decision matters" — no bullets, no headings.
7. Put observations, summaries, code findings, architecture notes, and risks in <ANALYSIS> blocks. NEVER cram narrative into a question's context field.
8. When the user answers, you will see a user message that tells you what they chose. Do NOT repeat the question back. Either ask the next decision for this step (another <QUESTION>) or close the step with <STEP_DONE:x>.
9. Never output anything outside a tagged block. No greetings, no "Sure!", no "Here's my analysis:". The UI hides it.
10. Use valid JSON inside <QUESTION> blocks — double-quoted strings, no trailing commas, no comments.

## What each step covers
STEP 1 — requirements:
  Restate the task, list required outcomes in an <ANALYSIS>, then ask clarifying decisions that materially change direction (architecture, scope, libraries). If none are blocking, <STEP_DONE:requirements>.

STEP 2 — codebase:
  Review the repository map and any Planning Context Refresh excerpts. Summarize existing architecture, patterns, stack, and relevant files in one or two <ANALYSIS> blocks. Usually NO questions — emit <STEP_DONE:codebase>.

STEP 3 — gaps:
  List real gaps/blockers in an <ANALYSIS>. Ask only REAL blockers, one per reply. If none, <STEP_DONE:gaps>.

STEP 4 — approach:
  Present the technical approach in <ANALYSIS> (architecture, libraries, milestones, risks, mitigations). Ask decisions one at a time: library picks, architecture branches, scope tradeoffs.

STEP 5 — testing:
  Propose a testing strategy in <ANALYSIS>. Confirm coverage tradeoffs with at most one or two <QUESTION>s if needed.

STEP 6 — plan:
  Emit one <ANALYSIS title="Plan Summary"> and the full plan wrapped in <PLAN_START>...<PLAN_END>. Include file-by-file changes, milestone sequence, and the agreed testing strategy. No <QUESTION> on this step.

## Task / Requirements
${task}

## Repository Map (live snapshot captured when this session started/resumed)
${projectMap || '(No readable project files found — this may be a new project)'}`;
}

// ── Agent API implementations ────────────────────────────────────────────────

/**
 * GitHub Models API (OpenAI-compatible).
 * Fine-grained PAT with Models:read permission.
 */
async function streamCopilot(messages, config, onChunk, onDone, onError) {
  const token = config.ghToken;
  if (!token) { onError(new Error('GH_TOKEN not configured')); return; }

  // Normalize: strip Azure ML registry URI → short model name
  // "azureml://registries/azure-openai/models/gpt-4o/versions/2" → "gpt-4o"
  const rawModel = config.model || 'gpt-4o';
  const uriMatch = rawModel.match(/\/models\/([^/]+)/);
  const model = uriMatch ? uriMatch[1] : rawModel;

  // o1 models don't support streaming or system messages
  const isO1 = model.startsWith('o1');
  const msgsToSend = isO1 ? messages.filter(m => m.role !== 'system') : messages;

  const body = JSON.stringify({
    model,
    messages: msgsToSend,
    stream:   !isO1,
    max_tokens: isO1 ? 4096 : 2048,
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

  // Log all rate-limit headers for debugging
  const rlHeaders = {};
  for (const [k, v] of res.headers.entries()) {
    if (k.includes('ratelimit') || k.includes('quota') || k.includes('x-ms')) rlHeaders[k] = v;
  }
  console.log('[quota] GitHub Models headers:', JSON.stringify(rlHeaders));

  // Extract quota from response headers (GitHub Models returns these)
  const quota = {
    provider:  'GitHub Models',
    remaining: res.headers.get('x-ratelimit-remaining-requests') || res.headers.get('x-ms-quota-remaining-requests'),
    limit:     res.headers.get('x-ratelimit-limit-requests')     || res.headers.get('x-ms-quota-limit-requests'),
    reset:     res.headers.get('x-ratelimit-reset'),
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
    model:      config.model || 'claude-opus-4-5',
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

  const rlHeaders = {};
  for (const [k, v] of res.headers.entries()) {
    if (k.includes('ratelimit') || k.includes('quota')) rlHeaders[k] = v;
  }
  console.log('[quota] Anthropic headers:', JSON.stringify(rlHeaders));

  const quota = {
    provider:  'Anthropic',
    remaining: res.headers.get('anthropic-ratelimit-requests-remaining'),
    limit:     res.headers.get('anthropic-ratelimit-requests-limit'),
    reset:     res.headers.get('anthropic-ratelimit-requests-reset'),
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

  const geminiModel = config.model || 'gemini-2.0-flash';
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${geminiModel}:streamGenerateContent?key=${apiKey}&alt=sse`;
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
      hydrateSessionContext(sess);
      const systemPrompt = buildSystemPrompt(config, sess.projectMap);
      // Restore conversation with a fresh live repo map
      sess.messages       = [
        { role: 'system', content: systemPrompt },
        ...(saved.messages || []).filter(m => m.role !== 'system'),
      ];
      sess.currentStep    = saved.currentStep    || 'requirements';
      sess.completedSteps = saved.completedSteps || [];
      return { sessionId, resumed: true, currentStep: sess.currentStep, completedSteps: sess.completedSteps };
    }
  }

  // Fresh start — delete any stale saved session
  if (config.projectPath) deleteSavedSession(config.projectPath);

  createSession(sessionId, agent, config);
  const sess = getSession(sessionId);
  hydrateSessionContext(sess);
  const systemPrompt = buildSystemPrompt(config, sess.projectMap);
  sess.messages.push({ role: 'system', content: systemPrompt });

  return { sessionId, resumed: false, currentStep: 'requirements', completedSteps: [] };
}

/**
 * Send a user message in a planning session.
 * Streams chunks via onChunk(text), calls onDone(full, quota) when complete.
 * onStep(stepId, done) is called when the agent emits <STEP:x> or <STEP_DONE:x> tags.
 * Step tags are stripped from the visible output.
 */
async function sendPlanMessage(sessionId, userText, onChunk, onDone, onError, onStep, internal = false) {
  const sess = getSession(sessionId);
  if (!sess) { onError(new Error('Planning session not found')); return; }

  sess.messages.push({ role: 'user', content: userText, ...(internal ? { _internal: true } : {}) });

  let full = '';
  let tagBuf = '';  // holds text that may contain an incomplete STEP tag

  const STEP_RE      = /<STEP:([a-z_]+)>/g;
  const STEP_DONE_RE = /<STEP_DONE:([a-z_]+)>/g;

  // Flush safe text: process complete tags, strip them, send visible output.
  // Any text from the last '<' that hasn't closed yet is held back in tagBuf.
  const flushBuf = (final = false) => {
    let toProcess;
    if (final) {
      toProcess = tagBuf;
      tagBuf = '';
    } else {
      // Find the last '<' that could start a STEP tag still in progress
      const ltIdx = tagBuf.lastIndexOf('<');
      if (ltIdx !== -1 && tagBuf.indexOf('>', ltIdx) === -1) {
        // Incomplete potential tag — hold back from '<' onwards
        toProcess = tagBuf.slice(0, ltIdx);
        tagBuf    = tagBuf.slice(ltIdx);
      } else {
        toProcess = tagBuf;
        tagBuf    = '';
      }
    }

    if (!toProcess) return;

    // Fire step events for complete tags
    let match;
    STEP_RE.lastIndex = 0;
    while ((match = STEP_RE.exec(toProcess)) !== null) {
      const stepId = match[1];
      if (stepId !== sess.currentStep) {
        sess.currentStep = stepId;
        if (onStep) onStep(stepId, false);
      }
    }
    STEP_DONE_RE.lastIndex = 0;
    while ((match = STEP_DONE_RE.exec(toProcess)) !== null) {
      const stepId = match[1];
      if (!sess.completedSteps.includes(stepId)) sess.completedSteps.push(stepId);
      if (onStep) onStep(stepId, true);
    }

    // Strip tags from visible output
    const visible = toProcess
      .replace(/<STEP:[a-z_]+>/g, '')
      .replace(/<STEP_DONE:[a-z_]+>/g, '');
    if (visible) onChunk(visible);
  };

  const accChunk = text => {
    full   += text;
    tagBuf += text;
    flushBuf(false);
  };

  const accDone  = (quota) => {
    flushBuf(true);   // flush any held partial-tag text
    sess.messages.push({ role: 'assistant', content: full });
    savePlanSession(sessionId);   // persist after every agent reply
    onDone(full, quota);
  };

  // Trim conversation to fit within model context limits.
  // Always keeps system messages; drops oldest non-system messages first.
  // Rough estimate: 4 chars ≈ 1 token.
  const agent = sess.agent;
  // Token budgets by model (rough input budget; 4 chars ≈ 1 token)
  const model = sess.config.model || '';
  const MODEL_BUDGETS = {
    'gpt-4o': 5500, 'gpt-4o-mini': 5500, 'o1-mini': 20000, 'o1': 80000,
    'Meta-Llama-3.1-405B-Instruct': 20000, 'Mistral-Large-2411': 20000,
  };
  const AGENT_BUDGETS = { copilot: 5500, aider: 5500, claude: 80000, gemini: 80000 };
  const TOKEN_BUDGETS = MODEL_BUDGETS[model] || AGENT_BUDGETS[agent] || 5500;
  const charBudget = TOKEN_BUDGETS * 4;
  const contextBudget = sess.currentStep === 'requirements'
    ? Math.min(5000, Math.floor(charBudget * 0.12))
    : Math.min(18000, Math.max(6000, Math.floor(charBudget * 0.32)));
  const turnContext = buildTurnContextPack(sess, userText, contextBudget);

  function trimmedMessages(contextText = '') {
    const system = sess.messages.filter(m => m.role === 'system');
    const chat   = sess.messages.filter(m => m.role !== 'system');
    const systemChars = system.reduce((n, m) => n + m.content.length, 0);
    const reservedForContext = contextText ? contextText.length + 800 : 0;
    let budget = charBudget - systemChars - reservedForContext;
    const kept = [];
    for (let i = chat.length - 1; i >= 0; i--) {
      const len = chat[i].content.length;
      if (budget - len < 500 && kept.length > 0) break;  // keep at least 500 chars headroom
      kept.unshift(chat[i]);
      budget -= len;
    }
    if (kept.length < chat.length) {
      kept.unshift({ role: 'user', _internal: true,
        content: '[Note: earlier conversation was trimmed to fit the context window. Continue from the current state of the planning session.]' });
    }
    return [...system, ...kept];
  }

  function withTurnContext(messages, contextText) {
    if (!contextText) return messages;
    const injected = {
      role: 'user',
      _internal: true,
      content:
        `${contextText}\n\nUse this context to answer the user's latest message. ` +
        `Treat it as current-turn supporting material, not as a user request.`,
    };
    const out = [...messages];
    let insertAt = out.length;
    for (let i = out.length - 1; i >= 0; i--) {
      if (out[i].role !== 'system') {
        insertAt = i;
        break;
      }
    }
    out.splice(insertAt, 0, injected);
    return out;
  }

  const messagesToSend = withTurnContext(trimmedMessages(turnContext), turnContext);

  if (agent === 'copilot') {
    await streamCopilot(messagesToSend, sess.config, accChunk, accDone, onError);
  } else if (agent === 'claude') {
    await streamClaude(messagesToSend, sess.config, accChunk, accDone, onError);
  } else if (agent === 'gemini') {
    await streamGemini(messagesToSend, sess.config, accChunk, accDone, onError);
  } else {
    // aider: fall back to claude if key present, else copilot
    if (sess.config.anthropicApiKey) {
      await streamClaude(messagesToSend, sess.config, accChunk, accDone, onError);
    } else {
      await streamCopilot(messagesToSend, sess.config, accChunk, accDone, onError);
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

/**
 * Returns the raw conversation history for the planning wizard.
 * The client re-parses each assistant message through the tag parser
 * to rebuild the analysis drawer, decisions, and current question.
 * Filters out system prompt and internal kickoff messages.
 */
function getSessionHistory(sessionId) {
  const sess = getSession(sessionId);
  if (!sess) return [];
  return sess.messages
    .filter(m => m.role !== 'system' && !m._internal)
    .map(m => ({ role: m.role, content: m.content }));
}

module.exports = { startPlanSession, sendPlanMessage, extractFinalPlan, getSessionHistory, deleteSession, getSession, getSavedSessionMeta, deleteSavedSession, PLANNING_STEPS, buildProjectIndex };
