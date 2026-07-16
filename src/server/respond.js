/**
 * @fileoverview 统一响应写出模块
 * @description 封装 JSON、SSE 响应和错误响应的统一处理函数
 */

import { getErrorDetails } from './errors.js';

/**
 * 发送 JSON 响应
 * @param {import('http').ServerResponse} res - HTTP 响应对象
 * @param {number} status - HTTP 状态码
 * @param {object} payload - 响应数据
 */
export function sendJson(res, status, payload) {
    if (res.writableEnded) return;
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(payload));
}

/**
 * 发送 SSE 事件
 * @param {import('http').ServerResponse} res - HTTP 响应对象
 * @param {object} payload - 事件数据
 */
export function sendSse(res, payload) {
    if (res.writableEnded) return;
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

/**
 * 发送 SSE 结束标记
 * @param {import('http').ServerResponse} res - HTTP 响应对象
 */
export function sendSseDone(res) {
    if (res.writableEnded) return;
    res.write(`data: [DONE]\n\n`);
    res.end();
}

/**
 * 发送 SSE 心跳包
 * @param {import('http').ServerResponse} res - HTTP 响应对象
 * @param {string} mode - 心跳模式 ('comment' | 'content')
 * @param {string} [modelName] - 模型名称（content 模式需要）
 */
export function sendHeartbeat(res, mode, modelName) {
    if (res.writableEnded) return;

    if (mode === 'comment') {
        res.write(`:keepalive\n\n`);
    } else {
        // content 模式：发送空 delta
        const chunk = {
            id: 'chatcmpl-' + Date.now(),
            object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000),
            model: modelName || 'default-model',
            choices: [{
                index: 0,
                delta: { content: '' },
                finish_reason: null
            }]
        };
        res.write(`data: ${JSON.stringify(chunk)}\n\n`);
    }
}

/**
 * 发送统一 API 错误响应 (OpenAI 标准格式)
 * @param {import('http').ServerResponse} res - HTTP 响应对象
 * @param {object} options - 错误选项
 * @param {string} [options.code] - 错误码（使用 ERROR_CODES 枚举）
 * @param {string} [options.message] - 自定义错误消息（如提供则覆盖 code 对应的消息）
 * @param {number} [options.status] - 自定义 HTTP 状态码
 * @param {boolean} [options.isStreaming=false] - 是否为流式响应
 */
export function sendApiError(res, options) {
    const { code, message, status, isStreaming = false } = options;

    // 获取错误详情
    const details = code ? getErrorDetails(code) : null;
    const errorMessage = message || (details ? details.message : '未知错误');
    const errorType = details?.type || 'server_error';
    const httpStatus = status || (details ? details.status : 500);

    // 构造 OpenAI 标准错误响应体
    const payload = {
        error: {
            message: errorMessage,
            type: errorType,
            code: code || 'INTERNAL_ERROR'
        }
    };

    if (isStreaming) {
        // 流式响应：发送错误事件然后结束
        sendSse(res, payload);
        sendSseDone(res);
    } else {
        // 非流式响应
        sendJson(res, httpStatus, payload);
    }
}

/**
 * 构造 OpenAI 格式的聊天完成响应（非流式）
 * 支持 tool_calls
 * @param {object|string} opts - 选项对象或 content 字符串
 * @param {string} [opts.content] - 响应内容
 * @param {string} [opts.model] - 模型名称
 * @param {string} [opts.reasoning] - 思考/推理过程
 * @param {Array} [opts.tool_calls] - 工具调用列表
 * @param {string} [opts.finish_reason='stop'] - 完成原因
 * @param {object} [opts.usage] - token 用量
 * @returns {object} OpenAI 格式的响应对象
 */
export function buildChatCompletion(opts, modelName, reasoningContent) {
    // 兼容旧签名: buildChatCompletion(content, modelName, reasoningContent)
    let content, reasoning, tool_calls, finish_reason, usage;
    if (typeof opts === 'string') {
        content = opts;
        reasoning = reasoningContent;
        finish_reason = 'stop';
    } else {
        content = opts.content;
        modelName = opts.model || modelName;
        reasoning = opts.reasoning;
        tool_calls = opts.tool_calls;
        finish_reason = opts.finish_reason || 'stop';
        usage = opts.usage;
    }

    const message = {
        role: 'assistant',
        content: tool_calls?.length ? (content ?? null) : (content ?? ''),
    };
    if (reasoning) message.reasoning_content = reasoning;
    if (tool_calls?.length) message.tool_calls = tool_calls;

    return {
        id: 'chatcmpl-' + Date.now(),
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: modelName || 'default-model',
        choices: [{
            index: 0,
            message,
            finish_reason: tool_calls?.length ? 'tool_calls' : finish_reason,
        }],
        usage: usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    };
}

/**
 * 构造 tool_calls 的流式 SSE chunks（单包模拟流）
 * @param {object} opts - { id, model, content, tool_calls, reasoning }
 * @returns {Array} SSE data chunks
 */
export function buildToolCallStreamChunks(opts) {
    const { id, model, content, tool_calls, reasoning } = opts;
    const cid = id || `chatcmpl_${Date.now()}`;
    const created = Math.floor(Date.now() / 1000);
    const base = { id: cid, object: 'chat.completion.chunk', created, model };
    const chunks = [];

    // role chunk
    chunks.push({
        ...base,
        choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
    });

    if (reasoning) {
        chunks.push({
            ...base,
            choices: [{ index: 0, delta: { reasoning_content: reasoning }, finish_reason: null }],
        });
    }

    if (content) {
        chunks.push({
            ...base,
            choices: [{ index: 0, delta: { content }, finish_reason: null }],
        });
    }

    if (tool_calls?.length) {
        for (let i = 0; i < tool_calls.length; i++) {
            const tc = tool_calls[i];
            // name chunk
            chunks.push({
                ...base,
                choices: [{
                    index: 0,
                    delta: { tool_calls: [{ index: i, id: tc.id, type: 'function', function: { name: tc.function.name, arguments: '' } }] },
                    finish_reason: null,
                }],
            });
            // arguments chunk
            chunks.push({
                ...base,
                choices: [{
                    index: 0,
                    delta: { tool_calls: [{ index: i, function: { arguments: tc.function.arguments } }] },
                    finish_reason: null,
                }],
            });
        }
    }

    // finish chunk
    chunks.push({
        ...base,
        choices: [{ index: 0, delta: {}, finish_reason: tool_calls?.length ? 'tool_calls' : 'stop' }],
    });

    return chunks;
}

/**
 * 构造 OpenAI 格式的流式聊天完成响应块
 * @param {string} content - 响应内容
 * @param {string} [modelName] - 模型名称
 * @param {string|null} [finishReason='stop'] - 完成原因
 * @param {string} [reasoningContent] - 思考/推理过程内容 (OpenAI o1 格式)
 * @returns {object} OpenAI 格式的流式响应块
 */
export function buildChatCompletionChunk(content, modelName, finishReason = 'stop', reasoningContent) {
    const delta = { content };
    if (reasoningContent) {
        delta.reasoning_content = reasoningContent;
    }

    return {
        id: 'chatcmpl-' + Date.now(),
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: modelName || 'default-model',
        choices: [{
            index: 0,
            delta,
            finish_reason: finishReason
        }]
    };
}
