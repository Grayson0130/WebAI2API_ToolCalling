/**
 * @fileoverview Tool Calling Prompt Generator
 * @description Renders OpenAI tool/function definitions into a structured text prompt
 * that instructs the AI to output tool calls in a parseable format.
 *
 * Two supported formats:
 * - xml:   <tool_use><name>tool_name</name><arguments>{"key":"val"}</arguments></tool_use>
 * - bracket: [function_calls][call:tool_name]{"key":"val"}[/call][/function_calls]
 */

/**
 * Generate tool definitions string from OpenAI tool format
 * @param {Array} tools - OpenAI tools array
 * @returns {string}
 */
function generateToolDefinitions(tools) {
  if (!tools || tools.length === 0) return '';

  return tools
    .map((tool) => {
      if (tool.type === 'function') {
        const fn = tool.function;
        const params = fn.parameters
          ? JSON.stringify(fn.parameters)
          : '{}';
        return `Tool \`${fn.name}\`: ${fn.description || 'No description'}\n  Arguments JSON schema: ${params}`;
      }
      return '';
    })
    .join('\n\n');
}

/**
 * Generate tool names list
 * @param {Array} tools
 * @returns {string}
 */
function generateToolNames(tools) {
  if (!tools || tools.length === 0) return '';
  return tools
    .filter(t => t.type === 'function')
    .map(t => t.function.name)
    .join(', ');
}

/**
 * Generate XML format example prompt
 * @returns {string}
 */
function generateXmlFormatExample() {
  return `## Tool Call Protocol
When you decide to call a tool, you MUST respond with NOTHING except a single <tool_use> block exactly like the template below:

<tool_use>
  <name>exact_tool_name_from_list</name>
  <arguments>{"argument": "value"}</arguments>
</tool_use>

CRITICAL RULES:
1. You MUST use the EXACT tool name as defined in the Available Tools list
2. The content inside <arguments> MUST be a raw JSON object
3. Do NOT wrap JSON in \`\`\`json blocks
4. Do NOT output any other text, explanation, or reasoning before or after the <tool_use> block
5. If you need to call multiple tools, output multiple <tool_use> blocks sequentially
6. JSON arguments MUST be valid JSON format`;
}

/**
 * Generate bracket format example prompt
 * @returns {string}
 */
function generateBracketFormatExample() {
  return `## Tool Call Protocol
When you decide to call a tool, you MUST respond with NOTHING except a single [function_calls] block exactly like the template below:

[function_calls]
[call:exact_tool_name_from_list]{"argument": "value"}[/call]
[/function_calls]

CRITICAL RULES:
1. EVERY tool call MUST start with [call:exact_tool_name] and end with [/call]
2. You MUST use the EXACT tool name as defined in the Available Tools list
3. The content between [call:...] and [/call] MUST be a raw JSON object on ONE LINE - NO LINE BREAKS inside the JSON
4. Do NOT wrap JSON in \`\`\`json blocks
5. Do NOT output any other text, explanation, or reasoning before or after the [function_calls] block
6. If you need to call multiple tools, put them all inside the same [function_calls] block, each with its own [call:...]...[/call] wrapper
7. JSON arguments MUST be compact, all on one line, NO pretty printing, NO newlines`;
}

/**
 * Generate complete XML prompt with tool definitions
 * @param {Array} tools
 * @returns {string}
 */
function generateXmlPrompt(tools) {
  const toolDefinitions = generateToolDefinitions(tools);

  return `## Available Tools
You can invoke the following developer tools. Call a tool only when it is required and follow the JSON schema exactly when providing arguments.

CRITICAL: Tool names are CASE-SENSITIVE. You MUST use the exact tool name as defined below.

${toolDefinitions}

${generateXmlFormatExample()}

EXAMPLE with multiple tools:
<tool_use>
  <name>get_weather</name>
  <arguments>{"location":"Beijing"}</arguments>
</tool_use>
<tool_use>
  <name>get_time</name>
  <arguments>{"timezone":"UTC"}</arguments>
</tool_use>

When you receive a tool result, it will be in the format:
[TOOL_RESULT for call_id] result_content`;
}

/**
 * Generate complete bracket prompt with tool definitions
 * @param {Array} tools
 * @returns {string}
 */
function generateBracketPrompt(tools) {
  const toolDefinitions = generateToolDefinitions(tools);

  return `## Available Tools
You can invoke the following developer tools. Call a tool only when it is required and follow the JSON schema exactly when providing arguments.

CRITICAL: Tool names are CASE-SENSITIVE. You MUST use the exact tool name as defined below.

${toolDefinitions}

${generateBracketFormatExample()}

EXAMPLE with multiple tools - NOTE THE JSON IS ALL ON ONE LINE:
[function_calls]
[call:get_weather]{"location":"Beijing"}[/call]
[call:get_time]{"timezone":"UTC"}[/call]
[/function_calls]

When you receive a tool result, it will be in the format:
[TOOL_RESULT for call_id] result_content`;
}

/**
 * Generate the full tool prompt to inject into system message
 * @param {Array} tools - OpenAI tools array
 * @param {object} [options]
 * @param {string} [options.format='xml'] - 'xml' | 'bracket'
 * @returns {string}
 */
export function generateToolPrompt(tools, options = {}) {
  const format = options.format || 'xml';

  if (!tools || tools.length === 0) return '';

  switch (format) {
    case 'xml':
      return generateXmlPrompt(tools);
    case 'bracket':
      return generateBracketPrompt(tools);
    default:
      return generateXmlPrompt(tools);
  }
}

/**
 * Inject tool prompt into messages array
 * Appends to existing system message or creates a new one
 * @param {Array} messages - OpenAI messages array
 * @param {string} toolPrompt - The generated tool prompt
 * @returns {Array} Modified messages
 */
export function injectToolPrompt(messages, toolPrompt) {
  if (!toolPrompt) return messages;

  const result = [...messages];
  let injected = false;

  // Try to find existing system message and append to it
  for (let i = 0; i < result.length; i++) {
    if (result[i].role === 'system') {
      const content = result[i].content;
      if (typeof content === 'string') {
        result[i] = { ...result[i], content: `${content}\n\n${toolPrompt}` };
      } else {
        result[i] = { ...result[i], content: `${toolPrompt}` };
      }
      injected = true;
      break;
    }
  }

  // No system message found, prepend one
  if (!injected) {
    result.unshift({ role: 'system', content: toolPrompt });
  }

  return result;
}

/**
 * Render tool results into the format the AI expects
 * @param {string} toolCallId
 * @param {string} resultContent
 * @returns {string}
 */
export function formatToolResult(toolCallId, resultContent) {
  return `[TOOL_RESULT for ${toolCallId}] ${resultContent}`;
}
