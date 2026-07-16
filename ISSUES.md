# 开发问题记录

## 已解决问题

### Q1: `toolMiddleware` 导出错误

**时间**: 2026-07-16

**问题**: 服务启动时报错：
```
SyntaxError: The requested module '../toolcalling/middleware.js' does not provide an export named 'toolMiddleware'
```

**原因**: `middleware.js` 使用 `export default { ... }`（默认导出），但 `queue.js` 使用 `import { toolMiddleware } from '...'`（命名导入）。

**解决方案**: 在 `middleware.js` 中添加命名导出：
```js
export const toolMiddleware = { processRequest, processResponse, ... };
export default toolMiddleware;
```

---

## 已知限制

### K1: 工具调用依赖 AI 模型配合

**状态**: 🟡 待优化

**描述**: 工具调用通过提示词工程实现，AI 模型不一定每次都输出 XML 格式的工具调用。

**测试结果**:
- ✅ **单工具 + 明确指示**: AI 输出 `<tool_use><name>test_tool</name>...` 格式 → 中间件正确解析为 `tool_calls`
- ❌ **多工具场景**: AI 倾向于直接回复文本而非输出 XML

**根本原因**:
- 网页版 AI（DeepSeek、ChatGPT 等）被训练为对话助手，而非工具调用 Agent
- Chat2API 通过直接调用模型内部 API（非网页界面）实现更高的一致性
- WebAI2API 走浏览器自动化，AI 行为受网页前端影响

**可能的优化方向**:
1. 优化注入提示词，使其更强力地要求 AI 输出 XML
2. 在用户消息末尾自动追加格式指示
3. 添加 retry 机制：如果没检测到 tool call，重新发送带更强指示的请求
4. 更换为对工具调用更友好的模型（如 GLM/Z.AI，Chat2API 推荐）

### K2: 仅支持非流式响应

**状态**: 🟡 待实现

**描述**: 当前 Tool Calling Middleware 仅支持非流式（`stream: false`）响应。流式响应的 tool_calls 解析尚未实现。

### K3: 不支持 tool_choice 参数

**状态**: 🟢 无需实现（当前设计）

**描述**: 由于是提示词工程方案，`tool_choice: 'none'` 等参数无法精确控制。建议客户端通过修改用户 prompt 来控制 AI 行为。

### K4: 注入提示词可能影响对话质量

**状态**: 🟢 已知

**描述**: 注入的工具定义提示词会占用上下文窗口，可能影响对话质量。建议控制工具数量（≤10个）。
