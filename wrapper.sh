#!/bin/bash
# ─── Claude Code wrapper for OpenAI-compatible LLMs ─────────────────────────
# Starts the Anthropic→OpenAI format proxy (if not already running) and
# launches Claude Code connected to the upstream LLM.
# Can coexist with any other Claude Code wrappers (e.g. DeepSeek).

set -e

# ─── Upstream LLM configuration ────────────────────────────────────────────
export LLM_BASE_URL="${LLM_BASE_URL:-https://api.openai.com/v1}"
export LLM_API_KEY="${LLM_API_KEY:-}"
export LLM_MODEL="${LLM_MODEL:-gpt-4o}"

# ─── SSL certificate chain (if upstream has incomplete chain) ──────────────
export NODE_EXTRA_CA_CERTS="${NODE_EXTRA_CA_CERTS:-}"

# ─── Proxy configuration ────────────────────────────────────────────────────
PROXY_HOST="127.0.0.1"
PROXY_PORT="${PROXY_PORT:-18999}"
PROXY_URL="http://${PROXY_HOST}:${PROXY_PORT}"
PROXY_SCRIPT="$HOME/.claude/proxy/anthropic-to-openai-proxy.js"
PROXY_LOG="$HOME/.claude/proxy/proxy.log"
PROXY_PID_FILE="$HOME/.claude/proxy/proxy.pid"

# ─── Start proxy if not running ─────────────────────────────────────────────
start_proxy_if_needed() {
    if lsof -i ":${PROXY_PORT}" -sTCP:LISTEN -t >/dev/null 2>&1; then
        return 0
    fi

    echo "[wrapper] Starting proxy (port ${PROXY_PORT})..." >&2
    rm -f "$PROXY_PID_FILE"

    PROXY_PORT="$PROXY_PORT" \
    PROXY_LOG_FILE="$PROXY_LOG" \
    PROXY_PID_FILE="$PROXY_PID_FILE" \
    LLM_BASE_URL="$LLM_BASE_URL" \
    LLM_API_KEY="$LLM_API_KEY" \
    LLM_MODEL="$LLM_MODEL" \
    NODE_EXTRA_CA_CERTS="$NODE_EXTRA_CA_CERTS" \
    nohup node "$PROXY_SCRIPT" > "$PROXY_LOG" 2>&1 &

    # Wait up to 5 seconds for proxy to be ready
    for i in $(seq 1 25); do
        sleep 0.2
        if curl -s "${PROXY_URL}/health" >/dev/null 2>&1; then
            echo "[wrapper] Proxy ready (PID: $(cat "$PROXY_PID_FILE" 2>/dev/null || echo '?'))" >&2
            return 0
        fi
    done

    echo "[wrapper] ⚠ Proxy failed to start! Log: $PROXY_LOG" >&2
    return 1
}

# ─── Anthropic environment variables for Claude Code ────────────────────────
export ANTHROPIC_BASE_URL="$PROXY_URL"
export ANTHROPIC_AUTH_TOKEN="${LLM_API_KEY}"
export ANTHROPIC_MODEL="${LLM_MODEL}"
export ANTHROPIC_DEFAULT_OPUS_MODEL="${LLM_MODEL}"
export ANTHROPIC_DEFAULT_SONNET_MODEL="${LLM_MODEL}"
export ANTHROPIC_DEFAULT_HAIKU_MODEL="${LLM_MODEL}"
export CLAUDE_CODE_SUBAGENT_MODEL="${LLM_MODEL}"
export CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1
export DISABLE_GROWTHBOOK=1

# ─── Launch ──────────────────────────────────────────────────────────────────
start_proxy_if_needed || exit 1

exec claude "$@"
