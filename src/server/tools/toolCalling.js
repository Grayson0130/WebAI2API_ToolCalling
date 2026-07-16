/**
 * @fileoverview OpenAI-compatible tool calling via prompt simulation.
 * Adapter-agnostic: works with generate(prompt) → { text }.
 *
 * Protocol (model output):
 *   ```tool_call
 *   {"name":"fn","arguments":{...}}
 *   ```
 *
 * Reference: foxhui/WebAI2API tool calling patch design
 * Adapted for WebAI2API_ToolCalling
 */

import { randomBytes } from 'node:crypto';

// ─── constants ───────────────────────────────────────────────

const TOOL_FENCE_RE =
  /```(?:tool_call|toolcall|function_call)\s*\n([\s\S]*?)```/gi;

// 宽松兜底：裸 JSON 行
const BARE_TOOL_JSON_RE =
  /^\s*\{\s*"name"\s*:\s*"[^"]+"\s*,\s*"arguments"\s*:\s*\{[\s\S]*\}\s*\}\s*$/m;

const DEFAULT_MAX_TOOLS_CHARS = 12_000;

// ─── public: gate ────────────────────────────────────────────

/**
 * @param {object} body - chat completions request body
 * @param {object} [cfg] - config.server.toolCalling
 */
export function shouldEnableTools(body, cfg = {}) {
  if (cfg.enabled === false) return false;
  if (!body || body.tool_choice === 'none') return false;
  const tools = body.tools;
  return Array.isArray(tools) && tools.length > 0;
}

/**
 * @param {unknown} tools
 * @returns {Array<{name:string,description:string,parameters:object}>}
 */
export function normalizeTools(tools) {
  if (!Array.isArray(tools)) return [];
  const out = [];
  for (const t of tools) {
    if (!t || typeof t !== 'object') continue;
    const fn =
      t.type === 'function' && t.function
        ? t.function
        : t.function
          ? t.function
          : t;
    const name = fn?.name || t.name;
    if (!name || typeof name !== 'string') continue;
    out.push({
      name,
      description: String(fn?.description || t.description || ''),
      parameters:
        fn?.parameters && typeof fn.parameters === 'object'
          ? fn.parameters
          : t.parameters && typeof t.parameters === 'object'
            ? t.parameters
            : { type: 'object', properties: {} },
    });
  }
  return out;
}

/**
 * @param {unknown} toolChoice
 * @param {ReturnType<typeof normalizeTools>} tools
 * @returns {{ mode: 'auto'|'none'|'required'|'force', forceName?: string }}
 */
export function resolveToolChoice(toolChoice, tools) {
  if (toolChoice == null || toolChoice === 'auto') return { mode: 'auto' };
  if (toolChoice === 'none') return { mode: 'none' };
  if (toolChoice === 'required') return { mode: 'required' };
  if (
    typeof toolChoice === 'object' &&
    toolChoice.type === 'function' &&
    toolChoice.function?.name
  ) {
    const name = toolChoice.function.name;
    const ok = tools.some((t) => t.name === name);
    return ok
      ? { mode: 'force', forceName: name }
      : { mode: 'auto' };
  }
  return { mode: 'auto' };
}

// ─── public: compile ─────────────────────────────────────────

/**
 * Flatten OpenAI messages + tools into a single web-UI prompt.
 * @returns {{ prompt: string, images: string[] }}
 */
export function compileMessagesWithTools(messages, tools, toolChoice, opts = {}) {
  const normalized = normalizeTools(tools);
  const choice = resolveToolChoice(toolChoice, normalized);
  const images = extractImagesFromMessages(messages);
  const parts = [];

  if (choice.mode !== 'none' && normalized.length) {
    parts.push(buildToolsSystemBlock(normalized, choice, opts));
  }

  const list = Array.isArray(messages) ? messages : [];
  for (const msg of list) {
    if (!msg || typeof msg !== 'object') continue;
    const role = msg.role || 'user';
    const text = contentToText(msg.content);

    if (role === 'system') {
      if (text) parts.push(`[System]: ${text}`);
      continue;
    }

    if (role === 'user') {
      if (text) parts.push(`[User]: ${text}`);
      continue;
    }

    if (role === 'assistant') {
      const chunks = [];
      if (text) chunks.push(text);
      if (Array.isArray(msg.tool_calls) && msg.tool_calls.length) {
        for (const tc of msg.tool_calls) {
          const fn = tc.function || {};
          const args =
            typeof fn.arguments === 'string'
              ? safeJsonParse(fn.arguments) ?? fn.arguments
              : fn.arguments ?? {};
          chunks.push(
            '```tool_call\n' +
              JSON.stringify({ name: fn.name, arguments: args }, null, 0) +
              '\n```'
          );
        }
      }
      if (chunks.length) parts.push(`[Assistant]: ${chunks.join('\n')}`);
      continue;
    }

    if (role === 'tool') {
      const id = msg.tool_call_id || '';
      const name = msg.name || '';
      parts.push(
        `[Tool result id=${id}${name ? ` name=${name}` : ''}]: ${text || ''}`
      );
      continue;
    }

    // function (legacy) / unknown
    if (text) parts.push(`[${role}]: ${text}`);
  }

  // 末尾再钉一次输出格式（提高服从率）
  if (choice.mode !== 'none' && normalized.length) {
    parts.push(buildToolsReminder(choice));
  }

  return {
    prompt: parts.filter(Boolean).join('\n\n'),
    images,
  };
}

// ─── public: parse ───────────────────────────────────────────

/**
 * @param {string} rawText
 * @returns {{ content: string|null, tool_calls: object[]|null, parseErrors: string[] }}
 */
export function parseToolCalls(rawText) {
  const text = String(rawText || '');
  const tool_calls = [];
  const parseErrors = [];
  let cleaned = text;

  // 1) fenced blocks
  cleaned = cleaned.replace(TOOL_FENCE_RE, (_, body) => {
    const parsed = parseOneToolPayload(body);
    if (parsed.ok) {
      tool_calls.push(toOpenAIToolCall(parsed.value));
    } else {
      parseErrors.push(parsed.error);
    }
    return '';
  });

  // 2) 若 fence 一个都没有，尝试整段 / 多行裸 JSON
  if (!tool_calls.length) {
    const candidates = extractBareJsonObjects(text);
    for (const c of candidates) {
      const parsed = parseOneToolPayload(c);
      if (parsed.ok && parsed.value?.name) {
        tool_calls.push(toOpenAIToolCall(parsed.value));
        cleaned = cleaned.replace(c, '');
      }
    }
  }

  cleaned = cleaned.replace(/\n{3,}/g, '\n\n').trim();
  const content = cleaned.length ? cleaned : null;

  return {
    content: tool_calls.length ? content : content ?? (text.trim() || null),
    tool_calls: tool_calls.length ? tool_calls : null,
    parseErrors,
  };
}

export function needsRequiredRetry(choice, tool_calls) {
  if (!choice) return false;
  if (choice.mode === 'required') return !tool_calls?.length;
  if (choice.mode === 'force') {
    if (!tool_calls?.length) return true;
    return !tool_calls.some(
      (tc) => tc.function?.name === choice.forceName
    );
  }
  return false;
}

export function buildRequiredRetrySuffix(choice) {
  if (choice?.mode === 'force' && choice.forceName) {
    return (
      `[System]: You MUST call the tool "${choice.forceName}" now. ` +
      `Output only one tool_call block, no plain answer.`
    );
  }
  return (
    `[System]: You MUST call at least one tool now. ` +
    `Output one or more tool_call blocks, no plain answer.`
  );
}

// ─── images ──────────────────────────────────────────────────

/**
 * Collect image data-URLs / urls from multimodal message content.
 * @returns {string[]}
 */
export function extractImagesFromMessages(messages) {
  const images = [];
  if (!Array.isArray(messages)) return images;
  for (const msg of messages) {
    const c = msg?.content;
    if (!Array.isArray(c)) continue;
    for (const part of c) {
      if (part?.type === 'image_url') {
        const url = part.image_url?.url || part.image_url;
        if (typeof url === 'string' && url) images.push(url);
      } else if (part?.type === 'image' && part.source) {
        images.push(String(part.source));
      }
    }
  }
  return images.slice(0, 10);
}

// ─── internals ───────────────────────────────────────────────

function buildToolsSystemBlock(tools, choice, opts) {
  let schema = tools.map((t) => ({
    name: t.name,
    description: t.description,
    parameters: t.parameters,
  }));

  if (opts.compactSchema) {
    schema = schema.map((t) => ({
      name: t.name,
      description: (t.description || '').slice(0, 200),
      parameters: compactParams(t.parameters),
    }));
  }

  let json = JSON.stringify(schema, null, 2);
  if (json.length > (opts.maxToolsChars || DEFAULT_MAX_TOOLS_CHARS)) {
    json = json.slice(0, opts.maxToolsChars || DEFAULT_MAX_TOOLS_CHARS) + '\n/* truncated */';
  }

  const forceLine =
    choice.mode === 'force'
      ? `\nYou should prefer calling tool "${choice.forceName}".`
      : choice.mode === 'required'
        ? `\nYou must call at least one tool before answering.`
        : `\nOnly call a tool when needed.`;

  return (
    `[System instruction]: You have access to tools. To call a tool, respond with one or more blocks in EXACTLY this format:\n` +
    '```tool_call\n' +
    '{"name":"function_name","arguments":{...}}\n' +
    '```\n' +
    `Rules:\n` +
    `- "arguments" must be a JSON object (not a string)\n` +
    `- Do not invent tool names\n` +
    `- If you call tools, put tool_call blocks first; optional short text after is ok\n` +
    `- If no tool is needed, answer normally without tool_call blocks` +
    forceLine +
    `\n\nAvailable tools:\n${json}`
  );
}

function buildToolsReminder(choice) {
  if (choice.mode === 'force') {
    return `[System]: If you need external data/actions, call "${choice.forceName}" via a tool_call block.`;
  }
  if (choice.mode === 'required') {
    return `[System]: Remember: emit tool_call block(s) now.`;
  }
  return `[System]: Use tool_call blocks only when invoking a tool.`;
}

function contentToText(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((p) => {
        if (typeof p === 'string') return p;
        if (p?.type === 'text') return p.text || '';
        if (p?.type === 'image_url') return '[image]';
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }
  if (typeof content === 'object' && content.text) return String(content.text);
  return String(content);
}

function parseOneToolPayload(body) {
  const raw = String(body || '').trim();
  if (!raw) return { ok: false, error: 'empty tool payload' };

  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    const m = raw.match(/\{[\s\S]*\}/);
    if (!m) return { ok: false, error: `json parse failed: ${raw.slice(0, 80)}` };
    try {
      data = JSON.parse(m[0]);
    } catch (e) {
      return { ok: false, error: String(e.message || e) };
    }
  }

  const name = data.name || data.function?.name;
  if (!name) return { ok: false, error: 'missing name' };

  let args = data.arguments ?? data.parameters ?? data.function?.arguments ?? {};
  if (typeof args === 'string') {
    try {
      args = JSON.parse(args);
    } catch {
      args = args;
    }
  }

  return { ok: true, value: { name, arguments: args } };
}

function toOpenAIToolCall({ name, arguments: args }) {
  const argStr =
    typeof args === 'string' ? args : JSON.stringify(args ?? {}, null, 0);
  return {
    id: `call_${randomBytes(6).toString('hex')}`,
    type: 'function',
    function: {
      name,
      arguments: argStr,
    },
  };
}

function extractBareJsonObjects(text) {
  const out = [];
  let i = 0;
  while (i < text.length) {
    if (text[i] !== '{') {
      i++;
      continue;
    }
    let depth = 0;
    let j = i;
    let inStr = false;
    let esc = false;
    for (; j < text.length; j++) {
      const ch = text[j];
      if (inStr) {
        if (esc) esc = false;
        else if (ch === '\\') esc = true;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') inStr = true;
      else if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) {
          const slice = text.slice(i, j + 1);
          if (/"name"\s*:/.test(slice) && /"arguments"\s*:/.test(slice)) {
            out.push(slice);
          }
          break;
        }
      }
    }
    i = Math.max(j, i + 1);
  }
  return out;
}

function safeJsonParse(s) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function compactParams(parameters) {
  if (!parameters || typeof parameters !== 'object') return {};
  const props = parameters.properties || {};
  const slim = {};
  for (const [k, v] of Object.entries(props)) {
    slim[k] = {
      type: v?.type,
      description: (v?.description || '').slice(0, 80),
      enum: v?.enum,
    };
  }
  return {
    type: 'object',
    required: parameters.required || [],
    properties: slim,
  };
}
