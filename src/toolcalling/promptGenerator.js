/**
 * @fileoverview Tool Calling Prompt Generator
 * @description Renders OpenAI tool/function definitions into a structured text prompt
 * that instructs the AI to output tool calls in a parseable format.
 *
 * Two supported formats:
 * - xml:     <tool_use><name>tool_name</name><arguments>{"key":"val"}</arguments></tool_use>
 * - bracket: [function_calls][call:tool_name]{"key":"val"}[/call][/function_calls]
 */

/**
 * Generate tool definitions string from OpenAI tool format
 */
function generateToolDefinitions(tools) {
  if (!tools || tools.length === 0) return '';
  return tools
    .filter(t => t.type === 'function')
    .map((tool) => {
      const fn = tool.function;
      const params = fn.parameters ? JSON.stringify(fn.parameters) : '{}';
      return `- ${fn.name}: ${fn.description || 'No description'}\n  Schema: ${params}`;
    })
    .join('\n');
}

/**
 * Generate a short, forceful system prompt for tool calling
 */
function generateSystemToolPrompt(tools) {
  const defs = generateToolDefinitions(tools);
  return `[TOOL USE INSTRUCTIONS]
You MUST use the following tools when they are needed. Output tool calls in this EXACT XML format:
<tool_use><name>tool_name</name><arguments>{"key":"value"}</arguments></tool_use>

Available tools:
${defs}

Rules:
- When you need a tool, output ONLY the XML block above — NO other text or explanation
- If you need multiple tools, output multiple <tool_use> blocks
- Tool names are CASE-SENSITIVE, use them EXACTLY as listed
- Arguments must be valid JSON, keys/values matching the schema exactly`;
}

/**
 * Generate a suffix to append to user message to reinforce tool use
 */
function generateUserMessageSuffix(tools) {
  if (!tools || tools.length === 0) return '';
  const names = tools.filter(t => t.type === 'function').map(t => t.function.name).join(', ');
  return `\n\n[IMPORTANT] If you need to use a tool (${names}), respond with ONLY: <tool_use><name>tool_name</name><arguments>{...}</arguments></tool_use>`;
}

/**
 * Inject tool prompt into messages array
 * Appends to existing system message OR creates a new one
 * Also appends a forceful suffix to the last user message
 * @param {Array} messages
 * @param {Array} tools
 * @returns {Array} Modified messages
 */
export function injectToolPrompt(messages, tools) {
  if (!tools || tools.length === 0) return messages;

  const functionTools = tools.filter(t => t.type === 'function' && t.function?.name);
  if (functionTools.length === 0) return messages;

  const result = messages.map(m => ({ ...m }));
  const systemPrompt = generateSystemToolPrompt(functionTools);
  const userSuffix = generateUserMessageSuffix(functionTools);

  // 1. Inject system prompt
  let injected = false;
  for (let i = 0; i < result.length; i++) {
    if (result[i].role === 'system') {
      const content = result[i].content;
      result[i].content = typeof content === 'string' ? `${content}\n\n${systemPrompt}` : systemPrompt;
      injected = true;
      break;
    }
  }
  if (!injected) {
    result.unshift({ role: 'system', content: systemPrompt });
  }

  // 2. Append suffix to last user message
  for (let i = result.length - 1; i >= 0; i--) {
    if (result[i].role === 'user') {
      const content = result[i].content;
      if (typeof content === 'string') {
        result[i] = { ...result[i], content: content + userSuffix };
      } else if (Array.isArray(content)) {
        // Find last text part and append
        const lastTextIdx = [...content].reverse().findIndex(p => p.type === 'text');
        if (lastTextIdx !== -1) {
          const idx = content.length - 1 - lastTextIdx;
          const newContent = [...content];
          newContent[idx] = { ...newContent[idx], text: newContent[idx].text + userSuffix };
          result[i] = { ...result[i], content: newContent };
        }
      }
      break;
    }
  }

  return result;
}

/**
 * Render tool results into the format the AI expects
 */
export function formatToolResult(toolCallId, resultContent) {
  return `[TOOL_RESULT for ${toolCallId}] ${resultContent}`;
}
