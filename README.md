# WebAI2API ToolCalling

> 基于 [WebAI2API](https://github.com/foxhui/WebAI2API) 的增强版本，新增 **Tool/Function Calling** 中间件。

通过 **提示词工程（Prompt Engineering）** 为网页版 AI 服务（DeepSeek、ChatGPT、Claude、Gemini 等）添加工具调用能力，输出标准 OpenAI `tool_calls` 格式。

## 特性

- ✅ 保留 WebAI2API 全部功能（聊天、图片生成、多适配器）
- ✅ **Tool Calling 中间件** — 将 `tools` 参数转为提示词注入，解析返回结果
- ✅ 支持 XML 和 Bracket 两种输出协议格式
- ✅ 兼容 OpenAI 标准 `tool_calls` 格式
- ✅ 流式（streaming）支持
- ✅ Docker 部署

## 工具调用原理

```
客户端请求 (含 tools 参数)
       │
       ▼
┌─────────────────────────────────────┐
│ ToolInjectMiddleware                │
│  1. 将 tool 定义渲染为 XML/括号格式 │
│  2. 注入到 system prompt 中         │
│  3. 移除 tools 参数                 │
└──────────────┬──────────────────────┘
               │
               ▼
      WebAI2API 现有流程
  (Playwright → 网页 AI → 提取文字)
               │
               ▼
┌─────────────────────────────────────┐
│ ToolParseMiddleware                 │
│  1. 解析回复中的 <tool_use> 标签    │
│  2. 转为 OpenAI tool_calls 格式     │
│  3. 设置 finish_reason="tool_calls" │
└─────────────────────────────────────┘
               │
               ▼
     客户端收到标准 OpenAI 响应
```

## 快速开始

```bash
# 克隆
git clone https://github.com/Grayson0130/WebAI2API_ToolCalling.git
cd WebAI2API_ToolCalling

# Docker 部署
docker compose up -d
```

## 使用示例

```bash
curl http://localhost:3000/v1/chat/completions \
  -H "Authorization: Bearer your-api-key" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "deepseek",
    "messages": [{"role": "user", "content": "Hello"}],
    "tools": [{
      "type": "function",
      "function": {
        "name": "get_weather",
        "description": "Get weather",
        "parameters": {
          "type": "object",
          "properties": {
            "location": {"type": "string"}
          }
        }
      }
    }],
    "tool_choice": "auto"
  }'
```

## 许可证

MIT - 基于 [WebAI2API](https://github.com/foxhui/WebAI2API) (MIT)
