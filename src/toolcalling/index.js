/**
 * @fileoverview Tool Calling Module Entry Point
 * @description Provides tool/function calling for WebAI2API via prompt engineering.
 *
 * Usage:
 *   import { toolMiddleware } from '../toolcalling/index.js';
 *
 *   // On request:
 *   const { processedData, toolState } = toolMiddleware.processRequest(data);
 *
 *   // On response:
 *   const result = toolMiddleware.processResponse(generateResult, toolState);
 */

export { toolMiddleware as default, processRequest, processResponse, buildToolCallCompletion } from './middleware.js';
export { generateToolPrompt, injectToolPrompt, formatToolResult } from './promptGenerator.js';
export { parseToolCalls, detectProtocol, formatToolResultMessage } from './protocolParser.js';

// Re-export the middleware singleton
export { toolMiddleware } from './middleware.js';
