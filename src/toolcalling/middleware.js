/**
 * @fileoverview Tool Calling Middleware
 * @description Integrates tool calling into WebAI2API's request/response pipeline.
 *
 * On Request:  Injects tool definitions into the system prompt, removes tools param.
 * On Response: Parses AI output for tool call markers, converts to OpenAI format.
 *
 * Usage in routes.js:
 *   import { toolMiddleware } from '../../toolcalling/middleware.js';
 *   const { data, toolState } = toolMiddleware.processRequest(originalData);
 *   // ... parseRequest(data) ...
 *   // ... generate() ...
 *   const result = toolMiddleware.processResponse(generateResult, toolState);
 */

import { generateToolPrompt, injectToolPrompt, formatToolResult } from './promptGenerator.js';
import { parseToolCalls, detectProtocol } from './protocolParser.js';

/**
 * @typedef {object} ToolState
 * @property {boolean} active - Whether tool calling is active for this request
 * @property {Array} tools - Original tools array
 * @property {string} format - Protocol format used ('xml'|'bracket')
 * @property {Array} toolNames - List of tool names for validation
 * @property {boolean} hasTools - Whether tools were provided
 */

/**
 * Process the incoming request: inject tool definitions into messages
 * @param {object} data - Parsed request body (from JSON)
 * @param {object} [options]
 * @param {string} [options.format='xml'] - 'xml' | 'bracket'
 * @returns {{ processedData: object, toolState: ToolState }}
 *
 * Example:
 *   const { processedData, toolState } = toolMiddleware.processRequest(body);
 *   // processedData.messages now has tool prompt injected
 *   // processedData.tools has been removed (web AI doesn't support it)
 */
export function processRequest(data, options = {}) {
  const format = options.format || 'xml';
  const { messages, tools } = data;

  /** @type {ToolState} */
  const toolState = {
    active: false,
    tools: [],
    format,
    toolNames: [],
    hasTools: false
  };

  // No tools provided
  if (!tools || tools.length === 0) {
    return { processedData: data, toolState };
  }

  // Extract function tools
  const functionTools = tools.filter(t => t.type === 'function' && t.function?.name);
  if (functionTools.length === 0) {
    return { processedData: data, toolState };
  }

  // Generate tool prompt
  const toolPrompt = generateToolPrompt(functionTools, { format });

  if (!toolPrompt) {
    return { processedData: data, toolState };
  }

  // Inject into messages
  const injectedMessages = injectToolPrompt(messages, toolPrompt);

  // Create modified data WITHOUT tools parameter
  const processedData = {
    ...data,
    messages: injectedMessages
  };
  delete processedData.tools;

  // Build tool state
  toolState.active = true;
  toolState.tools = functionTools;
  toolState.toolNames = functionTools.map(t => t.function.name);
  toolState.hasTools = true;

  return { processedData, toolState };
}

/**
 * Process the AI response: parse tool calls from text
 * @param {object} generateResult - Result from adapter.generate()
 * @param {ToolState} toolState - State from processRequest
 * @returns {object} Modified result with tool_calls if detected
 *
 * Returns either:
 * - { text: "...", tool_calls: [...] }  if tool calls detected
 * - original generateResult if no tool calls
 */
export function processResponse(generateResult, toolState) {
  if (!toolState.active || !toolState.hasTools) {
    return generateResult;
  }

  const text = generateResult.text || generateResult.image || '';
  if (!text) return generateResult;

  // Try to parse tool calls from the response
  const parseResult = parseToolCalls(text, toolState.tools);

  if (parseResult.toolCalls.length > 0) {
    // Tool calls detected! Return them in OpenAI format
    return {
      text: parseResult.content || '',
      tool_calls: parseResult.toolCalls,
      protocol: parseResult.protocol,
      _toolCallRaw: true
    };
  }

  return generateResult;
}

/**
 * Generate a tool call message entry for the response
 * @param {Array} toolCalls
 * @param {string} modelName
 * @returns {object} OpenAI message object with tool_calls
 */
export function buildToolCallMessage(toolCalls, modelName) {
  return {
    role: 'assistant',
    content: null,
    tool_calls: toolCalls.map(tc => ({
      id: tc.id,
      type: 'function',
      function: {
        name: tc.function.name,
        arguments: tc.function.arguments
      }
    }))
  };
}

/**
 * Build a complete chat completion with tool calls
 * @param {Array} toolCalls
 * @param {string} modelName
 * @returns {object} OpenAI completion object
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
    usage: {
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0
    }
  };
}

/**
 * Build a streaming chunk with tool call delta
 * @param {object} toolCall - Single tool call object
 * @param {string} modelName
 * @param {boolean} [isFirst=false]
 * @param {boolean} [isLast=false]
 * @returns {string} SSE data string
 */
export function buildToolCallChunk(toolCall, modelName, isFirst = false, isLast = false) {
  const delta = {};

  if (isFirst) {
    // First chunk: send the tool call header with id and type
    delta.tool_calls = [{
      index: 0,
      id: toolCall.id,
      type: 'function',
      function: { name: toolCall.function.name, arguments: '' }
    }];
  } else if (isLast) {
    // Last chunk: empty delta with finish_reason
    delta.tool_calls = [{
      index: 0,
      function: { arguments: toolCall.function.arguments }
    }];
  } else {
    // Content chunks: send arguments in pieces
    if (toolCall.function.arguments) {
      delta.tool_calls = [{
        index: 0,
        function: { arguments: toolCall.function.arguments }
      }];
    }
  }

  const choice = {
    index: 0,
    delta,
    finish_reason: isLast ? 'tool_calls' : null
  };

  const data = {
    id: `chatcmpl-${Date.now()}`,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: modelName,
    choices: [choice]
  };

  return `data: ${JSON.stringify(data)}\n\n`;
}

export const toolMiddleware = {
  processRequest,
  processResponse,
  buildToolCallMessage,
  buildToolCallCompletion,
  buildToolCallChunk
};

export default toolMiddleware;
