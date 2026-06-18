#!/usr/bin/env node
/**
 * IFTTT MCP Proxy Server
 * 
 * A local stdio MCP server that authenticates with IFTTT via OAuth 2.1 + PKCE
 * and proxies MCP requests to https://ifttt.com/mcp
 * 
 * Usage:
 *   1. Run `node index.js --auth` to complete the one-time OAuth flow
 *   2. Add to Amazon Quick as a stdio MCP server (command: node /path/to/index.js)
 *   3. The proxy handles all MCP communication transparently
 * 
 * Supports IFTTT's Streamable HTTP transport:
 *   - Direct JSON responses (200 OK)
 *   - SSE streaming responses (200/202 with text/event-stream)
 *   - Token auto-refresh via refresh_token grant
 */

const http = require('http');
const https = require('https');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { URL, URLSearchParams } = require('url');
const { execSync } = require('child_process');

function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\"/g, '&quot;');
}

/**
 * Transform IFTTT's tool/call responses to be compatible with standard MCP clients.
 * IFTTT puts actual data in `structuredContent` while leaving `content` empty.
 * Standard MCP clients (like Amazon Quick) expect data in the `content` array.
 */
function transformToolResponse(jsonRpcResponse) {
  if (!jsonRpcResponse || !jsonRpcResponse.result) return jsonRpcResponse;

  const result = jsonRpcResponse.result;

  // If content is empty but structuredContent has data, move it into content
  if (
    result.structuredContent &&
    (!result.content || result.content.length === 0)
  ) {
    result.content = [
      {
        type: 'text',
        text: JSON.stringify(result.structuredContent, null, 2),
      },
    ];
  }

  return jsonRpcResponse;
}

// --- Configuration ---
const keepAliveAgent = new https.Agent({ keepAlive: true });

const IFTTT_MCP_URL = 'https://ifttt.com/mcp';
const IFTTT_AUTH_URL = 'https://ifttt.com/oauth/authorize';
const IFTTT_TOKEN_URL = 'https://ifttt.com/oauth/token';
const CLIENT_ID = 'lGUl5lOSWuf5wFsKWUVLIvsz1it9z8BBmxYUHt6LuW4';
const REDIRECT_URI = 'http://localhost:3118/callback';
const CALLBACK_PORT = 3118;
const SCOPE = 'mcp';
const RESOURCE = 'https://ifttt.com/mcp';

// Token storage
const TOKEN_FILE = path.join(
  process.env.HOME || process.env.USERPROFILE,
  '.quickwork',
  'ifttt-token.json'
);

// --- PKCE Helpers ---
function generateCodeVerifier() {
  return crypto.randomBytes(32).toString('base64url');
}

function generateCodeChallenge(verifier) {
  return crypto.createHash('sha256').update(verifier).digest('base64url');
}

function generateState() {
  return crypto.randomBytes(16).toString('hex');
}

// --- Token Management ---
function loadToken() {
  try {
    if (fs.existsSync(TOKEN_FILE)) {
      const data = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
      return data;
    }
  } catch (e) {
    // Token file corrupt or unreadable
  }
  return null;
}

function saveToken(tokenData) {
  const dir = path.dirname(TOKEN_FILE);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  // Add timestamp for expiry tracking
  tokenData.obtained_at = Date.now();
  fs.writeFileSync(TOKEN_FILE, JSON.stringify(tokenData, null, 2), { mode: 0o600 });
}

function isTokenExpired(tokenData) {
  if (!tokenData || !tokenData.access_token) return true;
  if (!tokenData.expires_in) return false; // No expiry info, assume valid
  const expiresAt = tokenData.obtained_at + (tokenData.expires_in * 1000);
  return Date.now() > expiresAt - 60000; // 1 minute buffer
}

// --- HTTP Helpers ---

/**
 * Simple buffered HTTPS request (used for token exchange, non-streaming calls)
 */
function httpsRequest(url, options, body) {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const reqOptions = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || 443,
      path: parsedUrl.pathname + parsedUrl.search,
      method: options.method || 'GET',
      headers: options.headers || {},
    };

    reqOptions.agent = keepAliveAgent;

    const req = https.request(reqOptions, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body: data,
        });
      });
    });

    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

/**
 * Streaming HTTPS request for MCP calls.
 * Returns a promise that resolves with parsed JSON-RPC response(s).
 * Handles both direct JSON and SSE streaming responses.
 */
function httpsStreamingRequest(url, options, body, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const reqOptions = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || 443,
      path: parsedUrl.pathname + parsedUrl.search,
      method: options.method || 'POST',
      headers: options.headers || {},
    };

    reqOptions.agent = keepAliveAgent;

    const req = https.request(reqOptions, (res) => {
      const contentType = res.headers['content-type'] || '';
      const isSSE = contentType.includes('text/event-stream');
      const status = res.statusCode;

      // Capture session ID
      const sessionId = res.headers['mcp-session-id'] || null;

      if (isSSE) {
        // --- SSE Streaming Mode ---
        let sseBuffer = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { sseBuffer += chunk; });

        res.on('end', () => {
          resolve({
            status,
            headers: res.headers,
            sessionId,
            isSSE: true,
            events: parseSSEBody(sseBuffer),
          });
        });

        res.on('error', (err) => {
          reject(new Error(`SSE stream error: ${err.message}`));
        });

      } else {
        // --- Buffered JSON Mode ---
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          resolve({
            status,
            headers: res.headers,
            sessionId,
            isSSE: false,
            body: data,
            events: null,
          });
        });
        res.on('error', (err) => {
          reject(new Error(`Response error: ${err.message}`));
        });
      }
    });

    req.on('error', reject);

    // Timeout to prevent hanging
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`Request timed out after ${timeoutMs}ms`));
    });

    if (body) req.write(body);
    req.end();
  });
}

// --- OAuth Flow ---
async function refreshToken(tokenData) {
  if (!tokenData.refresh_token) {
    throw new Error('No refresh token available. Please re-authenticate with --auth');
  }

  const params = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: tokenData.refresh_token,
    client_id: CLIENT_ID,
  });

  const response = await httpsRequest(IFTTT_TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
  }, params.toString());

  if (response.status !== 200) {
    throw new Error(`Token refresh failed (${response.status}): ${response.body}`);
  }

  const newToken = JSON.parse(response.body);
  // Preserve refresh token if not returned in response
  if (!newToken.refresh_token && tokenData.refresh_token) {
    newToken.refresh_token = tokenData.refresh_token;
  }
  saveToken(newToken);
  return newToken;
}

async function authenticate() {
  const codeVerifier = generateCodeVerifier();
  const codeChallenge = generateCodeChallenge(codeVerifier);
  const state = generateState();
  const nonce = crypto.randomBytes(24).toString('base64url');

  const authParams = new URLSearchParams({
    client_id: CLIENT_ID,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    consent_nonce: nonce,
    redirect_uri: REDIRECT_URI,
    resource: RESOURCE,
    response_type: 'code',
    scope: SCOPE,
    state: state,
  });

  const authUrl = `${IFTTT_AUTH_URL}?${authParams.toString()}`;

  console.error('\n🔐 IFTTT OAuth Authentication');
  console.error('━'.repeat(50));
  console.error('\nOpening browser for authentication...');
  console.error(`\nIf the browser doesn't open automatically, visit:\n${authUrl}\n`);

  // Open browser
  try {
    const platform = process.platform;
    if (platform === 'darwin') {
      execSync(`open "${authUrl}"`);
    } else if (platform === 'linux') {
      execSync(`xdg-open "${authUrl}"`);
    } else if (platform === 'win32') {
      execSync(`start "" "${authUrl}"`);
    }
  } catch (e) {
    console.error('Could not open browser automatically. Please open the URL above manually.');
  }

  // Start local callback server
  return new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      const reqUrl = new URL(req.url, `http://localhost:${CALLBACK_PORT}`);

      if (reqUrl.pathname !== '/callback') {
        res.writeHead(404);
        res.end('Not found');
        return;
      }

      const code = reqUrl.searchParams.get('code');
      const returnedState = reqUrl.searchParams.get('state');
      const error = reqUrl.searchParams.get('error');

      if (error) {
        res.writeHead(400);
        res.end(`<html><body><h2>❌ Authentication Failed</h2><p>${escapeHtml(error)}</p></body></html>`);
        server.close();
        reject(new Error(`OAuth error: ${error}`));
        return;
      }

      if (returnedState !== state) {
        res.writeHead(400);
        res.end('<html><body><h2>❌ State Mismatch</h2><p>Security check failed.</p></body></html>');
        server.close();
        reject(new Error('State mismatch'));
        return;
      }

      // Exchange code for token
      try {
        const tokenParams = new URLSearchParams({
          grant_type: 'authorization_code',
          code: code,
          redirect_uri: REDIRECT_URI,
          client_id: CLIENT_ID,
          code_verifier: codeVerifier,
        });

        const tokenResponse = await httpsRequest(IFTTT_TOKEN_URL, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
          },
        }, tokenParams.toString());

        if (tokenResponse.status !== 200) {
          throw new Error(`Token exchange failed (${tokenResponse.status}): ${tokenResponse.body}`);
        }

        const tokenData = JSON.parse(tokenResponse.body);
        saveToken(tokenData);

        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`
          <html><body style="font-family: system-ui; text-align: center; padding: 60px;">
            <h2>✅ IFTTT Connected!</h2>
            <p>You can close this window and return to your MCP client.</p>
            <p style="color: #666; margin-top: 20px;">Token saved to: ${TOKEN_FILE}</p>
          </body></html>
        `);

        console.error('\n✅ Authentication successful! Token saved.');
        console.error(`   Token file: ${TOKEN_FILE}`);
        server.close();
        resolve(tokenData);
      } catch (e) {
        res.writeHead(500);
        res.end(`<html><body><h2>❌ Token Exchange Failed</h2><p>${e.message}</p></body></html>`);
        server.close();
        reject(e);
      }
    });

    server.listen(CALLBACK_PORT, () => {
      console.error(`\n⏳ Waiting for OAuth callback on port ${CALLBACK_PORT}...`);
    });

    // Timeout after 5 minutes
    setTimeout(() => {
      server.close();
      reject(new Error('Authentication timed out after 5 minutes'));
    }, 5 * 60 * 1000);
  });
}

// --- MCP Proxy (stdio ↔ HTTP) ---

// Session tracking for Streamable HTTP MCP
let mcpSessionId = null;
let cachedToken = null;

async function getValidToken() {
  if (!cachedToken) {
    cachedToken = loadToken();
  }

  if (!cachedToken || !cachedToken.access_token) {
    console.error('❌ No token found. Run with --auth first to authenticate.');
    process.exit(1);
  }

  if (isTokenExpired(cachedToken)) {
    console.error('🔄 Token expired, refreshing...');
    try {
      cachedToken = await refreshToken(cachedToken);
      console.error('✅ Token refreshed successfully.');
    } catch (e) {
      console.error(`❌ Token refresh failed: ${e.message}`);
      console.error('   Please re-authenticate with: node index.js --auth');
      process.exit(1);
    }
  }

  return cachedToken.access_token;
}

/**
 * Send a JSON-RPC message to IFTTT's MCP endpoint and return the response(s).
 * Handles:
 *   - Direct JSON 200 responses
 *   - SSE streaming 200 responses  
 *   - 202 Accepted with SSE body
 *   - 401 with automatic token refresh + retry
 */
async function proxyMcpRequest(jsonRpcMessage) {
  const token = await getValidToken();

  const body = JSON.stringify(jsonRpcMessage);
  const headers = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${token}`,
    'Accept': 'application/json, text/event-stream',
  };

  // Include session ID if we have one from a previous response
  if (mcpSessionId) {
    headers['Mcp-Session-Id'] = mcpSessionId;
  }

  let response = await httpsStreamingRequest(IFTTT_MCP_URL, { method: 'POST', headers }, body);

  // Capture session ID
  if (response.sessionId) {
    mcpSessionId = response.sessionId;
    console.error(`   📋 Session ID: ${mcpSessionId}`);
  }

  // Handle 401 — try token refresh
  if (response.status === 401) {
    console.error('🔄 Got 401, attempting token refresh...');
    try {
      cachedToken = await refreshToken(cachedToken);
      headers['Authorization'] = `Bearer ${cachedToken.access_token}`;
      response = await httpsStreamingRequest(IFTTT_MCP_URL, { method: 'POST', headers }, body);
      if (response.sessionId) {
        mcpSessionId = response.sessionId;
      }
    } catch (e) {
      console.error(`❌ Re-auth failed: ${e.message}`);
    }
  }

  return response;
}

async function runStdioProxy() {
  // Verify we have a valid token before starting
  await getValidToken();
  console.error('🔌 IFTTT MCP Proxy started (stdio mode, SSE-aware)');

  let buffer = '';
  let pendingRequests = 0;

  process.stdin.setEncoding('utf8');
  process.stdin.on('data', async (chunk) => {
    buffer += chunk;

    // Process complete JSON-RPC messages (newline-delimited)
    const lines = buffer.split('\n');
    buffer = lines.pop(); // Keep incomplete line in buffer

    for (const line of lines) {
      if (!line.trim()) continue;

      try {
        const message = JSON.parse(line);
        const method = message.method || 'response';
        const id = message.id;
        console.error(`→ ${method} (id: ${id})`);

        // Notifications (no id) — fire and forget
        if (id === undefined || id === null) {
          pendingRequests++;
          try {
            await proxyMcpRequest(message);
          } catch (e) {
            console.error(`   ⚠️  Notification send error: ${e.message}`);
          }
          pendingRequests--;
          continue;
        }

        // Request with id — expect a response
        pendingRequests++;
        let response;
        try {
          response = await proxyMcpRequest(message);
        } catch (reqErr) {
          pendingRequests--;
          // Network/timeout error — return JSON-RPC error
          const errorResponse = {
            jsonrpc: '2.0',
            id: id,
            error: {
              code: -32603,
              message: `Proxy network error: ${reqErr.message}`,
            },
          };
          process.stdout.write(JSON.stringify(errorResponse) + '\n');
          console.error(`← error (network: ${reqErr.message})`);
          continue;
        }
        pendingRequests--;

        // --- Process the response ---

        if (response.isSSE && response.events && response.events.length > 0) {
          // SSE streaming response — write each event to stdout
          for (const event of response.events) {
            process.stdout.write(JSON.stringify(transformToolResponse(event)) + '\n');
          }
          console.error(`← response (SSE, ${response.events.length} event(s), status: ${response.status})`);

        } else if (response.isSSE && (!response.events || response.events.length === 0)) {
          // SSE content type but no parseable events
          console.error(`← warning (SSE with 0 events, status: ${response.status})`);
          const errorResponse = {
            jsonrpc: '2.0',
            id: id,
            error: {
              code: -32603,
              message: `IFTTT returned SSE stream with no parseable events (HTTP ${response.status})`,
            },
          };
          process.stdout.write(JSON.stringify(errorResponse) + '\n');

        } else if (response.status >= 200 && response.status < 300 && response.body) {
          // Buffered JSON response
          const bodyTrimmed = response.body.trim();
          if (!bodyTrimmed) {
            // Empty body on 2xx — possible 202 accepted with no content
            console.error(`← accepted (${response.status}, empty body)`);
            const emptyResponse = {
              jsonrpc: '2.0',
              id: id,
              result: null,
            };
            process.stdout.write(JSON.stringify(emptyResponse) + '\n');
          } else {
            // Try to parse as JSON
            try {
              const jsonResponse = JSON.parse(bodyTrimmed);
              process.stdout.write(JSON.stringify(transformToolResponse(jsonResponse)) + '\n');
              console.error(`← response (JSON, status: ${response.status})`);
            } catch (e) {
              // Maybe it's SSE content that wasn't detected by content-type
              if (bodyTrimmed.includes('data: ')) {
                const events = parseSSEBody(bodyTrimmed);
                if (events.length > 0) {
                  for (const event of events) {
                    process.stdout.write(JSON.stringify(transformToolResponse(event)) + '\n');
                  }
                  console.error(`← response (SSE-in-body, ${events.length} event(s))`);
                } else {
                  const errorResponse = {
                    jsonrpc: '2.0',
                    id: id,
                    error: {
                      code: -32603,
                      message: `IFTTT returned unparseable SSE body (HTTP ${response.status})`,
                    },
                  };
                  process.stdout.write(JSON.stringify(errorResponse) + '\n');
                  console.error(`← error (unparseable SSE body)`);
                }
              } else {
                const errorResponse = {
                  jsonrpc: '2.0',
                  id: id,
                  error: {
                    code: -32603,
                    message: `IFTTT returned non-JSON (HTTP ${response.status}): ${bodyTrimmed.substring(0, 200)}`,
                  },
                };
                process.stdout.write(JSON.stringify(errorResponse) + '\n');
                console.error(`← error (non-JSON, status: ${response.status})`);
              }
            }
          }

        } else if (response.status >= 400) {
          // Error response
          let errorMsg = `IFTTT returned HTTP ${response.status}`;
          if (response.body) {
            try {
              const parsed = JSON.parse(response.body);
              if (parsed.error) errorMsg += `: ${JSON.stringify(parsed.error)}`;
              else errorMsg += `: ${response.body.substring(0, 200)}`;
            } catch (e) {
              errorMsg += `: ${response.body.substring(0, 200)}`;
            }
          }
          const errorResponse = {
            jsonrpc: '2.0',
            id: id,
            error: {
              code: -32603,
              message: errorMsg,
            },
          };
          process.stdout.write(JSON.stringify(errorResponse) + '\n');
          console.error(`← error (status: ${response.status})`);

        } else {
          // Unexpected state — 2xx with no body and not SSE
          console.error(`← empty (status: ${response.status}, no body, not SSE)`);
          const emptyResponse = {
            jsonrpc: '2.0',
            id: id,
            result: null,
          };
          process.stdout.write(JSON.stringify(emptyResponse) + '\n');
        }

      } catch (e) {
        console.error(`❌ Error processing message: ${e.message}`);
        try {
          const parsed = JSON.parse(line);
          if (parsed.id !== undefined && parsed.id !== null) {
            const errorResponse = {
              jsonrpc: '2.0',
              id: parsed.id,
              error: {
                code: -32603,
                message: `Proxy error: ${e.message}`,
              },
            };
            process.stdout.write(JSON.stringify(errorResponse) + '\n');
          }
        } catch (e2) {
          // Can't even parse the original message
        }
      }
    }
  });

  process.stdin.on('end', () => {
    console.error('📴 stdin closed, waiting for pending requests...');
    const checkAndExit = () => {
      if (pendingRequests <= 0) {
        console.error('✅ All requests complete, shutting down.');
        process.exit(0);
      } else {
        console.error(`   ⏳ ${pendingRequests} request(s) still pending...`);
        setTimeout(checkAndExit, 100);
      }
    };
    checkAndExit();
  });
}

function parseSSEBody(body) {
  const events = [];
  const blocks = body.split('\n\n');

  for (const block of blocks) {
    let eventData = '';
    for (const line of block.split('\n')) {
      if (line.startsWith('data: ')) {
        eventData += line.substring(6);
      } else if (line.startsWith('data:')) {
        eventData += line.substring(5);
      }
    }
    if (eventData) {
      try {
        events.push(JSON.parse(eventData));
      } catch (e) {
        // Skip unparseable
      }
    }
  }

  return events;
}

// --- Main ---
async function main() {
  const args = process.argv.slice(2);

  if (args.includes('--auth') || args.includes('-a')) {
    // Authentication mode
    try {
      await authenticate();
      process.exit(0);
    } catch (e) {
      console.error(`\n❌ Authentication failed: ${e.message}`);
      process.exit(1);
    }
  } else if (args.includes('--status') || args.includes('-s')) {
    // Check token status
    const token = loadToken();
    if (!token) {
      console.error('❌ No token found. Run with --auth to authenticate.');
      process.exit(1);
    }
    const expired = isTokenExpired(token);
    console.error(`Token file: ${TOKEN_FILE}`);
    console.error(`Status: ${expired ? '❌ Expired' : '✅ Valid'}`);
    if (token.obtained_at) {
      console.error(`Obtained: ${new Date(token.obtained_at).toISOString()}`);
    }
    if (token.expires_in) {
      const expiresAt = new Date(token.obtained_at + token.expires_in * 1000);
      console.error(`Expires: ${expiresAt.toISOString()}`);
    }
    console.error(`Has refresh token: ${!!token.refresh_token}`);
    process.exit(0);
  } else {
    // Proxy mode (default) — used as stdio MCP server
    await runStdioProxy();
  }
}

main().catch((e) => {
  console.error(`Fatal error: ${e.message}`);
  process.exit(1);
});
