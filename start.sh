#!/bin/bash
# IFTTT MCP Proxy Wrapper
# Checks for a valid token before launching the proxy.
# If no token exists, runs the OAuth flow first.

TOKEN_FILE="$HOME/.quickwork/ifttt-token.json"
PROXY_SCRIPT="$(dirname "$0")/index.js"

if [ ! -f "$TOKEN_FILE" ]; then
  echo "⚠️  No IFTTT token found. Starting OAuth flow..." >&2
  node "$PROXY_SCRIPT" --auth
  if [ $? -ne 0 ]; then
    echo "❌ Authentication failed. Cannot start proxy." >&2
    exit 1
  fi
  echo "✅ Token obtained. Starting proxy..." >&2
fi

# Launch the proxy (stdio mode)
exec node "$PROXY_SCRIPT"
