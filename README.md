# DeepSeek Web Proxy (OpenAI-Compatible)
This is a `Node.js`-based proxy service for DeepSeek Web. It is a temporary solution I came up with while debugging tools like OpenClaw or Nanobot when free tokens were not enough. I still strongly recommend purchasing official APIs. For example, I am currently using a discounted monthly package from Alibaba Bailian.

This project routes OpenAI Chat Completions requests from third-party clients to the DeepSeek Web API, then returns responses in an OpenAI-style format.

## Features

- OpenAI-compatible endpoints:
  - `POST /v1/chat/completions`
  - `POST /chat/completions`
  - `GET /v1/models`
  - `GET /health`
- Automatic DeepSeek auth state handling (Cookie/Bearer)
- Filters out chain-of-thought fragments and returns displayable reply content only
- Keeps full debug logs for troubleshooting missing text, timeout, and format-parsing issues

## Requirements

- Node.js 22
- npm
- Windows

## Installation

```bash
npm install
```

## Configure Authentication

Run the command below. It will open the DeepSeek login page. After logging in, send one message. The required auth information will be captured automatically and saved locally, then the page will close automatically.

```bash
npm run login
```

## Start

```bash
npm start
```

After startup, the default listening address is:

- `http://127.0.0.1:3000`

## Usage

### 1. Health Check

```powershell
curl.exe -s http://127.0.0.1:3000/health
```

### 2. Non-Streaming Request

```powershell
curl.exe -s -X POST "http://127.0.0.1:3000/v1/chat/completions" ^
  -H "Content-Type: application/json" ^
  --data-binary "{\"model\":\"deepseek-chat\",\"stream\":false,\"messages\":[{\"role\":\"user\",\"content\":\"Reply with OK only\"}]}"
```

### 3. Streaming Request (SSE)

```powershell
curl.exe -N -X POST "http://127.0.0.1:3000/v1/chat/completions" ^
  -H "Content-Type: application/json" ^
  --data-binary "{\"model\":\"deepseek-chat\",\"stream\":true,\"messages\":[{\"role\":\"user\",\"content\":\"Hello\"}]}"
```

### 4. Get Model List

```powershell
curl.exe -s http://127.0.0.1:3000/v1/models
```

## Integration Suggestions for Third-Party Systems

- If the third-party client is OpenAI-compatible, set `base_url` to:
  - `http://127.0.0.1:3000/v1`
- Recommended model:
  - `deepseek-chat`
- If the third-party client has retry logic, make sure successful responses are recognized correctly to avoid duplicate requests.

## Logging and Troubleshooting

Logs are output to both the console and a file (default: `gateway.debug.log`).

Focus on:

- `[outbound][json] ... chars=xxx`
  - `chars=0` means the parsed main text is empty
- `[deepseek-raw][sse-line]`
  - Raw SSE lines from DeepSeek
- `[deepseek-raw][sse-unmapped]`
  - Unmapped events (usually metadata, not necessarily errors)

Tunable parameters:

- `LOG_FILE`
- `LOG_DEEPSEEK_RAW`
- `LOG_DEEPSEEK_RAW_MAX_CHARS`

## FAQ

### 1) No reply received by third-party client

- Check whether `/health` returns `ready=true`
- Check whether `gateway.debug.log` contains `[outbound][json]` or `[outbound][sse][done]`
- Check whether the third-party client reads OpenAI-style fields correctly:
  - Non-streaming: `choices[0].message.content`
  - Streaming: SSE `delta.content`

### 2) Duplicate requests are sent

- Most likely caused by the third-party retry strategy
- First confirm the gateway response status code is `200`
- Then confirm the third-party client recognizes the gateway response as a successful completion

### 3) Login expired

- Run `npm run login` again

## Disclaimer

This project is only for API proxying and integration testing with your own logged-in DeepSeek Web account. Please comply with the target platform's terms of service and local laws/regulations.
