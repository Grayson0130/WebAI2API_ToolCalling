/**
 * @fileoverview Tool Call Protocol Parser
 * @description Parses AI response text for tool call markers in XML or bracket format,
 * then converts them to standard OpenAI tool_calls format.
 *
 * Supported formats:
 * - XML:     <tool_use><name>fn</name><arguments>{"k":"v"}</arguments></tool_use>
 * - Bracket: [function_calls][call:fn]{"k":"v"}[/call][/function_calls]
 */

/**
 * Strip fenced code blocks (```xml ... ```) from content
 * @param {string} content
 * @returns {string}
 */
function stripFencedCodeBlocks(content) {
  return content.replace(/```[\w]*\n?([\s\S]*?)```/g, '$1').trim();
}

/**
 * Safely parse a JSON value
 * @param {string} value
 * @returns {any}
 */
function parseJsonValue(value) {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

/**
 * Build a tool call object in OpenAI format
 * @param {number} index
 * @param {string} name
 * @param {string} argumentsStr - JSON string of arguments
 * @param {string} [raw] - Raw matched text
 * @returns {object}
 */
function buildToolCall(index, name, argumentsStr, raw) {
  return {
    id: `call_${index}`,
    type: 'function',
    function: {
      name,
      arguments: argumentsStr
    },
    _raw: raw
  };
}

/**
 * Parse XML format tool calls from text
 * Format: <tool_use><name>fn</name><arguments>{"k":"v"}</arguments></tool_use>
 * @param {string} content
 * @param {Set<string>} allowedNames
 * @returns {{ toolCalls: Array, cleanContent: string, invalidNames: string[] }}
 */
function parseXmlToolCalls(content, allowedNames) {
  const toolCalls = [];
  const invalidNames = [];
  const rawMatches = [];
  let callIndex = 0;

  // Match: <tool_use>...</tool_use>
  const blockPattern = /<tool_use>([\s\S]*?)<\/tool_use>/g;
  let blockMatch;

  while ((blockMatch = blockPattern.exec(content)) !== null) {
    rawMatches.push(blockMatch[0]);
    const blockContent = blockMatch[1];

    // Extract name
    const nameMatch = blockContent.match(/<name>([\s\S]*?)<\/name>/);
    if (!nameMatch) continue;

    const name = nameMatch[1].trim();

    // Extract arguments
    const argsMatch = blockContent.match(/<arguments>([\s\S]*?)<\/arguments>/);
    if (!argsMatch) continue;

    const argsStr = argsMatch[1].trim();

    if (!allowedNames.has(name)) {
      invalidNames.push(name);
      continue;
    }

    toolCalls.push(buildToolCall(callIndex, name, argsStr, blockMatch[0]));
    callIndex++;
  }

  // Clean up: remove matched blocks from content
  let cleanContent = content;
  for (const raw of rawMatches) {
    cleanContent = cleanContent.replace(raw, '');
  }
  cleanContent = cleanContent.trim();

  return { toolCalls, cleanContent, invalidNames };
}

/**
 * Parse bracket format tool calls from text
 * Format: [function_calls][call:fn]{"k":"v"}[/call][/function_calls]
 * @param {string} content
 * @param {Set<string>} allowedNames
 * @returns {{ toolCalls: Array, cleanContent: string, invalidNames: string[] }}
 */
function parseBracketToolCalls(content, allowedNames) {
  const toolCalls = [];
  const invalidNames = [];
  const rawMatches = [];
  let callIndex = 0;

  // Match: [function_calls]...[/function_calls]
  const blockPattern = /\[function_calls\]([\s\S]*?)\[\/function_calls\]/g;
  let blockMatch;

  while ((blockMatch = blockPattern.exec(content)) !== null) {
    rawMatches.push(blockMatch[0]);
    const blockContent = blockMatch[1];

    // Match: [call:name]...[/call]
    const callPattern = /\[call:([^\]]+)\]([\s\S]*?)\[\/call\]/g;
    let callMatch;

    while ((callMatch = callPattern.exec(blockContent)) !== null) {
      const name = callMatch[1].trim();
      const argsStr = callMatch[2].trim();

      if (!allowedNames.has(name)) {
        invalidNames.push(name);
        continue;
      }

      toolCalls.push(buildToolCall(callIndex, name, argsStr, callMatch[0]));
      callIndex++;
    }
  }

  // Clean up
  let cleanContent = content;
  for (const raw of rawMatches) {
    cleanContent = cleanContent.replace(raw, '');
  }
  cleanContent = cleanContent.trim();

  return { toolCalls, cleanContent, invalidNames };
}

/**
 * Detect which protocol the AI response uses
 * @param {string} content
 * @returns {'xml'|'bracket'|null}
 */
export function detectProtocol(content) {
  if (/<tool_use>/i.test(content)) return 'xml';
  if (/\[function_calls\]/i.test(content)) return 'bracket';
  return null;
}

/**
 * Parse tool calls from AI response text
 * Supports both XML and bracket formats
 * @param {string} content - The AI response text
 * @param {Array} tools - Original OpenAI tools array (for allowed names)
 * @returns {object} { toolCalls: Array, content: string, protocol: string|null }
 *
 * toolCalls format (OpenAI):
 * [{
 *   id: "call_0",
 *   type: "function",
 *   function: { name: "get_weather", arguments: "{\"location\":\"Beijing\"}" }
 * }]
 */
export function parseToolCalls(content, tools) {
  if (!content || !tools || tools.length === 0) {
    return { toolCalls: [], content, protocol: null };
  }

  // Build set of allowed tool names
  const allowedNames = new Set(
    tools
      .filter(t => t.type === 'function' && t.function?.name)
      .map(t => t.function.name)
  );

  if (allowedNames.size === 0) {
    return { toolCalls: [], content, protocol: null };
  }

  const parseable = stripFencedCodeBlocks(content);

  // Try XML first, then bracket
  let result;

  if (detectProtocol(parseable) === 'xml') {
    result = parseXmlToolCalls(parseable, allowedNames);
  } else if (detectProtocol(parseable) === 'bracket') {
    result = parseBracketToolCalls(parseable, allowedNames);
  } else {
    return { toolCalls: [], content, protocol: null };
  }

  // Remove _raw from returned tool calls
  const cleanToolCalls = result.toolCalls.map(({ _raw, ...tc }) => tc);

  return {
    toolCalls: cleanToolCalls,
    content: result.cleanContent || content,
    protocol: detectProtocol(parseable),
    invalidNames: result.invalidNames.length > 0 ? result.invalidNames : undefined
  };
}

/**
 * Format tool results back into the conversation for follow-up requests
 * @param {string} toolCallId
 * @param {any} result
 * @returns {string}
 */
export function formatToolResultMessage(toolCallId, result) {
  const content = typeof result === 'string' ? result : JSON.stringify(result);
  return `[TOOL_RESULT for ${toolCallId}] ${content}`;
}
