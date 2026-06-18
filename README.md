# IFTTT MCP Proxy

A local **stdio MCP server** that bridges [IFTTT's remote MCP endpoint](https://ifttt.com/mcp) to any MCP client that only supports the stdio transport (e.g., [Amazon Quick](https://amazon.com/quick), Claude Desktop, Cursor, etc.).

## The Problem

IFTTT exposes a remote MCP server at `https://ifttt.com/mcp` using:
- **OAuth 2.1 with PKCE** for authentication
- **Streamable HTTP** transport with **SSE (Server-Sent Events)** for streaming responses

Many MCP clients (including Amazon Quick and Claude Desktop) only support **stdio** transport — they launch a local process and communicate via stdin/stdout. They cannot directly connect to remote HTTP MCP servers that require OAuth redirect flows.

## The Solution

This proxy runs as a local Node.js process that:

1. **Handles OAuth 2.1 + PKCE** — one-time browser-based authentication flow with automatic token refresh
2. **Bridges stdio ↔ HTTP** — reads JSON-RPC messages from stdin, forwards them to IFTTT's remote endpoint, and writes responses to stdout
3. **Handles SSE streaming** — IFTTT responds to tool calls with HTTP 202 + SSE streams; the proxy keeps the connection open and collects the full response before writing it to stdout
4. **Transforms responses** — IFTTT returns data in `structuredContent` while standard MCP clients expect it in `content[]`; the proxy normalizes this automatically
5. **Auto-refreshes tokens** — detects expired tokens and uses the refresh token to obtain new access tokens transparently

## Architecture

```
┌─────────────┐     stdio      ┌──────────────────┐    HTTPS/SSE    ┌─────────────┐
│  MCP Client │ ──stdin/stdout──│  ifttt-mcp-proxy │ ───────────────│ ifttt.com/  │
│  (e.g.      │                 │                  │                │    mcp      │
│  Amazon     │                 │  • OAuth token   │                │             │
│  Quick)     │                 │  • SSE handling  │                │  (Remote    │
│             │                 │  • Response      │                │   MCP       │
│             │                 │    transform     │                │   Server)   │
└─────────────┘                 └──────────────────┘                └─────────────┘
```

## Installation

```bash
git clone https://github.com/maishsk/ifttt-mcp-proxy.git
cd ifttt-mcp-proxy
```

No dependencies required — uses only Node.js built-in modules (`http`, `https`, `crypto`, `fs`, `path`, `url`, `child_process`).

**Requirements:** Node.js 18+

## Usage

### 1. Authenticate (one-time)

```bash
node index.js --auth
```

This opens your browser for the IFTTT OAuth flow. After authorizing, the token is saved to `~/.quickwork/ifttt-token.json` (with `0600` permissions).

### 2. Check Token Status

```bash
node index.js --status
```

Shows whether your token is valid, when it was obtained, and when it expires.

### 3. Run as MCP Proxy

```bash
node index.js
```

Starts in stdio mode — reads JSON-RPC from stdin, proxies to IFTTT, writes responses to stdout. Diagnostic logs go to stderr.

### 4. Configure in Your MCP Client

Add to your MCP client configuration:

```json
{
  "mcpServers": {
    "ifttt": {
      "command": "node",
      "args": ["/path/to/ifttt-mcp-proxy/index.js"]
    }
  }
}
```

Or use the included wrapper script that handles first-run auth automatically:

```json
{
  "mcpServers": {
    "ifttt": {
      "command": "bash",
      "args": ["/path/to/ifttt-mcp-proxy/start.sh"]
    }
  }
}
```

## How It Works

### OAuth 2.1 + PKCE Flow

1. Generates a PKCE code verifier/challenge pair
2. Opens browser to `https://ifttt.com/oauth/authorize` with the challenge
3. Spins up a temporary HTTP server on `localhost:3118` to receive the callback
4. Exchanges the authorization code for an access token + refresh token
5. Saves tokens to `~/.quickwork/ifttt-token.json`

### Streamable HTTP + SSE Handling

IFTTT's MCP server uses the **Streamable HTTP** MCP transport:
- Simple requests (like `initialize`, `tools/list`) return direct JSON responses
- Tool calls (`tools/call`) may return HTTP 200/202 with `Content-Type: text/event-stream`
- The SSE stream contains `data:` lines with the actual JSON-RPC response

The proxy handles all three response types:
- **Direct JSON** (200 + `application/json`) → parsed and forwarded
- **SSE stream** (200/202 + `text/event-stream`) → collected until stream ends, events parsed and forwarded
- **Error responses** (4xx/5xx) → converted to JSON-RPC error objects

### Response Transformation

IFTTT puts tool results in a non-standard `structuredContent` field while leaving the standard `content` array empty. The proxy detects this and moves the data into `content[{type: "text", text: ...}]` for compatibility.

### Token Auto-Refresh

On every request, the proxy checks token expiry (with a 60-second buffer). If expired, it uses the refresh token to obtain a new access token before proceeding. If a request returns HTTP 401, it attempts a refresh and retries once.

## Files

| File | Description |
|------|-------------|
| `index.js` | Main proxy server (OAuth + stdio proxy) |
| `package.json` | Package metadata |
| `start.sh` | Wrapper script with auto-auth on first run |

## Token Storage

Tokens are stored at `~/.quickwork/ifttt-token.json` with file permissions `0600` (owner read/write only). The file contains:
- `access_token` — Bearer token for IFTTT API
- `refresh_token` — Used to obtain new access tokens
- `expires_in` — Token lifetime in seconds
- `obtained_at` — Timestamp when the token was obtained

## Troubleshooting

### "No token found"
Run `node index.js --auth` to complete the OAuth flow.

### "Token refresh failed"
Your refresh token may have been revoked. Re-run `node index.js --auth`.

### Empty responses from tool calls
This usually means the SSE stream wasn't properly consumed. Check stderr logs for details. The proxy handles the common IFTTT pattern of 202 + SSE.

### Port 3118 in use
The OAuth callback uses port 3118. If it's occupied, kill the process using it or wait for it to release.

## License

MIT
