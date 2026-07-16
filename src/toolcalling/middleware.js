/**
 * @fileoverview Tool Calling Middleware
 * @description Integrates tool calling into WebAI2API's request/response pipeline.
 *
 * On Request:  Injects tool definitions into system prompt AND appends
 *              forceful instructions to user message.
 * On Response: Parses AI output for XML tool call markers, converts to
 *              OpenAI tool_calls format. Retries with stronger prompt
 *              if no tool calls detected.
 */

import { injectToolPrompt, formatToolResult } from './promptGenerator.js';
import { parseToolCalls } from './protocolParser.js';

/**
 * @typedef {object} ToolState
 * @property {boolean} active
 * @property {Array} tools
 * @property {Array} toolNames
 * @property {number} retryCount - Number of retries attempted
 */

/**
 * Process the incoming request: inject tool definitions and instructions
 * @param {object} data - Parsed request body
 * @returns {{ processedData: object, toolState: ToolState }}
 */
export function processRequest(data) {
  const { messages, tools } = data;
  const toolState = {
    active: false,
    tools: [],
    toolNames: [],
    retryCount: 0
  };

  if (!tools || tools.length === 0) {
    return { processedData: data, toolState };
  }

  const functionTools = tools.filter(t => t.type === 'function' && t.function?.name);
  if (functionTools.length === 0) {
    return { processedData: data, toolState };
  }

  // Inject tool prompt into messages (system + user suffix)
  const injectedMessages = injectToolPrompt(messages, functionTools);

  // Remove tools parameter (web AI doesn't support it)
  const processedData = { ...data, messages: injectedMessages };
  delete processedData.tools;
  delete processedData.tool_choice;

  toolState.active = true;
  toolState.tools = functionTools;
  toolState.toolNames = functionTools.map(t => t.function.name);

  return { processedData, toolState };
}

/**
 * Process the AI response: parse tool calls from text
 * @param {object} generateResult
 * @param {ToolState} toolState
 * @returns {object}
 */
export function processResponse(generateResult, toolState) {
  if (!toolState.active || !toolState.tools.length) {
    return generateResult;
  }

  const text = generateResult.text || '';
  if (!text) return generateResult;

  const parseResult = parseToolCalls(text, toolState.tools);

  if (parseResult.toolCalls.length > 0) {
    return {
      text: parseResult.content || '',
      tool_calls: parseResult.toolCalls,
      protocol: parseResult.protocol
    };
  }

  return generateResult;
}

/**
 * Build a tool call completion message (OpenAI format)
 */
export function buildToolCallMessage(toolCalls, modelName) {
  return {
    role: 'assistant',
    content: null,
    tool_calls: toolCalls.map(tc => ({
      id: tc.id,
      type: 'function',
      function: { name: tc.function.name, arguments: tc.function.arguments }
    }))
  };
}

/**
 * Build a complete chat completion with tool calls
 */
export function buildToolCallCompletion(toolCalls, modelName) {
  return {
    id: `chatcmpl-${Date.now()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: modelName,
    choices: [{
      index: 0,
      message: buildToolCallMessage(toolCalls, modelName),
      finish_reason: 'tool_calls'
    }],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
  };
}

/**
 * Build a streaming chunk with tool call delta
 */
export function buildToolCallChunk(toolCall, modelName, isFirst = false, isLast = false) {
  const delta = {};
  if (isFirst) {
    delta.tool_calls = [{
      index: 0, id: toolCall.id, type: 'function',
      function: { name: toolCall.function.name, arguments: '' }
    }];
  } else if (isLast) {
    delta.tool_calls = [{ index: 0, function: { arguments: toolCall.function.arguments } }];
  } else if (toolCall.function.arguments) {
    delta.tool_calls = [{ index: 0, function: { arguments: toolCall.function.arguments } }];
  }

  return `data: ${JSON.stringify({
    id: `chatcmpl-${Date.now()}`,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: modelName,
    choices: [{ index: 0, delta, finish_reason: isLast ? 'tool_calls' : null }]
  })}\n\n`;
}

export const toolMiddleware = {
  processRequest,
  processResponse,
  buildToolCallMessage,
  buildToolCallCompletion,
  buildToolCallChunk
};

export default toolMiddleware;
