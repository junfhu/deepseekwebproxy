# DeepSeek Web Proxy (OpenAI-Compatible)

这是一个基于 `Node.js` 的 DeepSeek 网页版中转服务。  
它把第三方客户端发来的 OpenAI Chat Completions 请求，路由到 DeepSeek Web API，再按 OpenAI 风格回给第三方。

## 功能介绍

- 支持 OpenAI 兼容接口：
  - `POST /v1/chat/completions`
  - `POST /chat/completions`
  - `GET /v1/models`
  - `GET /health`
- 支持 `stream=true` 与 `stream=false`
- 自动处理 DeepSeek 登录态（Cookie/Bearer）
- 过滤思维链片段，只返回可展示回复内容
- 保留完整调试日志，便于排查丢字、超时、格式不识别问题

## 环境要求

- Node.js 18+（建议 20+）
- npm
- Windows / Linux / macOS 均可

## 安装

```powershell
npm install
```

## 配置认证

你可以用两种方式提供 DeepSeek 登录态。

### 方式 1：环境变量（推荐）

在项目根目录新建 `.env`（可参考 `.env.example`）：

```env
PORT=3000
DEEPSEEK_COOKIE=你的_cookie
DEEPSEEK_BEARER=你的_bearer
DEEPSEEK_USER_AGENT=你的_user_agent
LOG_FILE=gateway.debug.log
LOG_DEEPSEEK_RAW=true
LOG_DEEPSEEK_RAW_MAX_CHARS=4000
```

### 方式 2：交互登录抓取

```powershell
npm run login
```

凭据会保存到：

- `./.deepseekapi/credentials.json`
- `~/.deepseekapi/credentials.json`

## 启动

```powershell
npm start
```

启动成功后默认监听：

- `http://127.0.0.1:3000`

## 使用方法

### 1. 健康检查

```powershell
curl.exe -s http://127.0.0.1:3000/health
```

### 2. 非流式调用

```powershell
curl.exe -s -X POST "http://127.0.0.1:3000/v1/chat/completions" ^
  -H "Content-Type: application/json" ^
  --data-binary "{\"model\":\"deepseek-chat\",\"stream\":false,\"messages\":[{\"role\":\"user\",\"content\":\"只回复OK\"}]}"
```

### 3. 流式调用（SSE）

```powershell
curl.exe -N -X POST "http://127.0.0.1:3000/v1/chat/completions" ^
  -H "Content-Type: application/json" ^
  --data-binary "{\"model\":\"deepseek-chat\",\"stream\":true,\"messages\":[{\"role\":\"user\",\"content\":\"你好\"}]}"
```

### 4. 获取模型列表

```powershell
curl.exe -s http://127.0.0.1:3000/v1/models
```

## 与第三方系统对接建议

- 第三方若是 OpenAI 客户端，`base_url` 指向：
  - `http://127.0.0.1:3000/v1`
- 模型建议使用：
  - `deepseek-chat`
- 如果第三方有重试机制，务必正确识别成功回包，避免重复发送。

## 日志与排查

日志会同时输出到控制台和文件（默认 `gateway.debug.log`）。

重点关注：

- `[outbound][json] ... chars=xxx`
  - `chars=0` 说明本次解析到的正文为空
- `[deepseek-raw][sse-line]`
  - DeepSeek 原始 SSE 内容
- `[deepseek-raw][sse-unmapped]`
  - 未映射事件（通常是元数据，不一定是错误）

可调参数：

- `LOG_FILE`
- `LOG_DEEPSEEK_RAW`
- `LOG_DEEPSEEK_RAW_MAX_CHARS`

## 常见问题

### 1) 第三方收不到回复

- 检查 `/health` 是否 `ready=true`
- 检查 `gateway.debug.log` 是否有 `[outbound][json]` 或 `[outbound][sse][done]`
- 检查第三方是否按 OpenAI 格式读取 `choices[0].message.content`（非流式）或 SSE `delta.content`（流式）

### 2) 出现重复发送

- 多数是第三方重试策略触发
- 先确认网关回包状态码是否为 `200`
- 再确认第三方是否把网关回复识别为成功完成

### 3) 登录失效

- 更新 `DEEPSEEK_COOKIE/DEEPSEEK_BEARER`
- 或重新执行 `npm run login`

## 免责声明

本项目仅用于你自己已登录 DeepSeek Web 账号的接口中转与工程集成测试。请遵守目标平台的服务条款与当地法律法规。
