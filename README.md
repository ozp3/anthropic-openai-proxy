# Anthropic ↔ OpenAI API Format Proxy

[![Node.js](https://img.shields.io/badge/Node.js-18%2B-green)](https://nodejs.org)
[![License](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

[🇬🇧 English](#english) &nbsp;|&nbsp; [🇹🇷 Türkçe](#turkce)

<a id="english"></a>

A local proxy that performs bidirectional protocol translation between the **Anthropic Messages API** used by Claude Code and the **OpenAI Chat Completions API** used by OpenAI-compatible LLM backends.

> Claude Code → (Anthropic) → Proxy → (OpenAI) → vLLM / SGLang / Any OpenAI-compatible backend

## Features

- **Bidirectional format conversion** — Anthropic Messages API ↔ OpenAI Chat Completions API
- **Thinking (reasoning) support** — Converts `<think>` blocks into Anthropic native `type: "thinking"` content blocks
- **Tool calling** — Parses both native OpenAI tool calls and XML/JSON tool calls embedded in text
- **Streaming** — SSE event synthesis from non-streaming upstream responses, identical format to DeepSeek
- **Multi-model** — Use different models simultaneously via separate wrapper commands
- **SSL repair** — Complements missing intermediate CA certificates via `NODE_EXTRA_CA_CERTS`

## Quick Start

### 1. Download the proxy script

```bash
mkdir -p ~/.claude/proxy
# Place anthropic-to-openai-proxy.js in this directory
```

### 2. Create a wrapper script

```bash
sudo cat > /usr/local/bin/my-llm << 'EOF'
#!/bin/bash
set -e

# Upstream configuration
export LLM_BASE_URL="${LLM_BASE_URL:-https://your-llm-api.example.com/v1}"
export LLM_API_KEY="${LLM_API_KEY:-your-api-key}"
export LLM_MODEL="${LLM_MODEL:-your-model-name}"

# SSL (if needed)
export NODE_EXTRA_CA_CERTS="${NODE_EXTRA_CA_CERTS:-$HOME/.claude/proxy/ca-bundle.pem}"

# Proxy
PROXY_PORT="${PROXY_PORT:-18999}"
PROXY_URL="http://127.0.0.1:${PROXY_PORT}"
PROXY_SCRIPT="$HOME/.claude/proxy/anthropic-to-openai-proxy.js"

start_proxy_if_needed() {
    if lsof -i ":${PROXY_PORT}" -sTCP:LISTEN -t >/dev/null 2>&1; then
        return 0
    fi
    echo "[my-llm] Starting proxy (port ${PROXY_PORT})..." >&2
    PROXY_PORT="$PROXY_PORT" \
    LLM_BASE_URL="$LLM_BASE_URL" \
    LLM_API_KEY="$LLM_API_KEY" \
    LLM_MODEL="$LLM_MODEL" \
    NODE_EXTRA_CA_CERTS="$NODE_EXTRA_CA_CERTS" \
    nohup node "$PROXY_SCRIPT" > "$HOME/.claude/proxy/proxy.log" 2>&1 &

    for i in $(seq 1 25); do
        sleep 0.2
        curl -s "${PROXY_URL}/health" >/dev/null 2>&1 && break
    done
}

export ANTHROPIC_BASE_URL="$PROXY_URL"
export ANTHROPIC_AUTH_TOKEN="${LLM_API_KEY}"
export ANTHROPIC_MODEL="${LLM_MODEL}"
export ANTHROPIC_DEFAULT_OPUS_MODEL="${LLM_MODEL}"
export ANTHROPIC_DEFAULT_SONNET_MODEL="${LLM_MODEL}"
export ANTHROPIC_DEFAULT_HAIKU_MODEL="${LLM_MODEL}"
export CLAUDE_CODE_SUBAGENT_MODEL="${LLM_MODEL}"
export CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1
export DISABLE_GROWTHBOOK=1

start_proxy_if_needed || exit 1
exec claude "$@"
EOF

sudo chmod +x /usr/local/bin/my-llm
```

### 3. Usage

```bash
# Interactive
my-llm

# One-shot
my-llm -p "What is 1+1?"

# Simultaneously with DeepSeek (completely independent)
deepseek
```

## Architecture

```
┌──────────────┐     Anthropic API      ┌──────────────────┐     OpenAI API       ┌───────────────────┐
│              │ ──────────────────────▶ │                  │ ──────────────────▶  │                   │
│  Claude Code │                        │  Format Proxy    │                      │  OpenAI-compatible│
│  (client)    │ ◀────────────────────── │  localhost:18999  │ ◀──────────────────  │  LLM Backend      │
│              │     Anthropic API       │                  │     OpenAI API       │  (vLLM/SGLang)    │
└──────────────┘                        └──────────────────┘                      └───────────────────┘
```

## Format Conversion Details

### Request: Anthropic → OpenAI

| Anthropic | OpenAI |
|---|---|
| `system` (top-level field) | `messages[0]` → `role: "system"` |
| `messages[].content[{type: "tool_use", ...}]` | `tool_calls[{function: {arguments: "json_string"}}]` |
| `messages[].content[{type: "tool_result", ...}]` | Separate message: `role: "tool"` |
| `tools[].input_schema` | `tools[].function.parameters` |
| `tool_choice: {type: "auto"}` | `tool_choice: "auto"` |
| `stop_sequences` | `stop` |

### Response: OpenAI → Anthropic

| OpenAI | Anthropic |
|---|---|
| `finish_reason: "stop"` | `stop_reason: "end_turn"` |
| `finish_reason: "length"` | `stop_reason: "max_tokens"` |
| `finish_reason: "tool_calls"` | `stop_reason: "tool_use"` |
| `<think>...</think>` (in text) | `{type: "thinking", thinking: "...", signature: ""}` |
| `<tool_call>...</tool_call>` (in text) | `{type: "tool_use", id, name, input}` |
| ` ```json {"tool_calls":[...]} ``` ` (in text) | `{type: "tool_use", id, name, input}` |

### Thinking (Reasoning)

`<think>` blocks in the model output are converted to Anthropic API's native `type: "thinking"` content blocks. Claude Code renders these with a "Thought for Xs" indicator; Ctrl+O expands/collapses the thinking content.

```
Model output:   <think>Reasoning steps...</think> Final answer
                        ↓
Anthropic:      [
                  {type: "thinking", thinking: "Reasoning steps...", signature: ""},
                  {type: "text", text: "Final answer"}
                ]
```

### Streaming SSE

The proxy sends non-streaming requests upstream (more consistent model behavior), then synthesizes SSE events from the response for Claude Code:

```
message_start
  └→ content_block_start (thinking)
       └→ content_block_delta (thinking_delta) × N
       └→ content_block_stop
  └→ content_block_start (text)
       └→ content_block_delta (text_delta)
       └→ content_block_stop
  └→ content_block_start (tool_use)
       └→ content_block_delta (input_json_delta)
       └→ content_block_stop
  └→ message_delta (stop_reason + usage)
  └→ message_stop
```

## Configuration

| Environment Variable | Default | Description |
|---|---|---|
| `LLM_BASE_URL` | — | Upstream OpenAI API base URL |
| `LLM_API_KEY` | `""` | API key |
| `LLM_MODEL` | — | Model name |
| `PROXY_PORT` | `18999` | Proxy port |
| `NODE_EXTRA_CA_CERTS` | — | Additional CA certificate (for SSL chain repair) |
| `PROXY_LOG` | `"1"` | `"0"` = errors only |

## Edge Cases

- **Duplicate system messages** — Claude Code may send the system prompt in both the top-level `system` field and the `messages` array. The proxy detects and merges them.
- **Incomplete SSL chain** — When the upstream server doesn't send the intermediate CA certificate, Node.js `fetch` fails. Use `NODE_EXTRA_CA_CERTS` to supply the missing CA.
- **Streaming vs non-streaming divergence** — Some models behave differently in streaming mode (e.g., omit tool calls). The proxy always uses non-streaming upstream requests and synthesizes SSE.
- **Orphan `</think>`** — Models may use `</think>` without an opening `<think>` tag. All text before `</think>` is treated as thinking.
- **Embedded XML/JSON tool calls** — When the model doesn't support native tool calling, it may embed `<tool_call>` XML or ` ```json ``` ` blocks. Both formats are parsed.

## Comparison with Other Solutions

| | This proxy | [local-openai2anthropic](https://github.com/dongfangzan/local-openai2anthropic) |
|---|---|---|
| **Language** | Node.js (single file, 0 dependencies) | Python 3.12+ (pip package) |
| **Setup** | `node script.js` | `pip install` + daemon config |
| **Tool calling** | Native + embedded XML/JSON parsing | Native only |
| **Thinking** | `<think>` → native `type: "thinking"` | Native `reasoning_effort` parameter |
| **Daemon** | Manual (nohup) | `oa2a start/stop/restart` |
| **Dashboard** | None | Web interface |
| **Streaming** | Non-streaming → SSE synthesis | Native streaming |

## File Structure

```
~/.claude/proxy/
├── anthropic-to-openai-proxy.js   # Main proxy script
├── ca-bundle.pem                  # Additional SSL CA certificates (optional)
├── proxy.log                      # Log file
└── proxy.pid                      # PID file

/usr/local/bin/
└── my-llm                         # Wrapper script (Claude Code launcher)
```

## License

MIT

---

<a id="turkce"></a>

# Anthropic ↔ OpenAI API Format Proxy (Türkçe)

[![Node.js](https://img.shields.io/badge/Node.js-18%2B-green)](https://nodejs.org)
[![License](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

Claude Code'un kullandığı **Anthropic Messages API** ile OpenAI-uyumlu LLM backend'lerin kullandığı **OpenAI Chat Completions API** arasında çift yönlü protokol çevirisi yapan yerel proxy.

> Claude Code → (Anthropic) → Proxy → (OpenAI) → vLLM / SGLang / Herhangi OpenAI-uyumlu backend

## Özellikler

- **Çift yönlü format dönüşümü** — Anthropic Messages API ↔ OpenAI Chat Completions API
- **Thinking (reasoning) desteği** — `<think>` bloklarını Anthropic native `type: "thinking"` content block'larına dönüştürür
- **Tool calling** — Hem native OpenAI tool call'ları hem de text içine gömülü XML/JSON tool call'ları parse eder
- **Streaming** — Non-streaming upstream cevabından SSE event sentezi, DeepSeek ile birebir aynı format
- **Çoklu model** — Farklı modelleri farklı wrapper komutlarla aynı anda kullanabilme
- **SSL tamiri** — Eksik intermediate CA sertifikalarını `NODE_EXTRA_CA_CERTS` ile tamamlama

## Hızlı Başlangıç

### 1. Proxy script'ini indirin

```bash
mkdir -p ~/.claude/proxy
# anthropic-to-openai-proxy.js dosyasını bu dizine koyun
```

### 2. Wrapper script oluşturun

```bash
sudo cat > /usr/local/bin/my-llm << 'EOF'
#!/bin/bash
set -e

# Upstream yapılandırması
export LLM_BASE_URL="${LLM_BASE_URL:-https://your-llm-api.example.com/v1}"
export LLM_API_KEY="${LLM_API_KEY:-your-api-key}"
export LLM_MODEL="${LLM_MODEL:-your-model-name}"

# SSL (gerekirse)
export NODE_EXTRA_CA_CERTS="${NODE_EXTRA_CA_CERTS:-$HOME/.claude/proxy/ca-bundle.pem}"

# Proxy
PROXY_PORT="${PROXY_PORT:-18999}"
PROXY_URL="http://127.0.0.1:${PROXY_PORT}"
PROXY_SCRIPT="$HOME/.claude/proxy/anthropic-to-openai-proxy.js"

start_proxy_if_needed() {
    if lsof -i ":${PROXY_PORT}" -sTCP:LISTEN -t >/dev/null 2>&1; then
        return 0
    fi
    echo "[my-llm] Proxy başlatılıyor (port ${PROXY_PORT})..." >&2
    PROXY_PORT="$PROXY_PORT" \
    LLM_BASE_URL="$LLM_BASE_URL" \
    LLM_API_KEY="$LLM_API_KEY" \
    LLM_MODEL="$LLM_MODEL" \
    NODE_EXTRA_CA_CERTS="$NODE_EXTRA_CA_CERTS" \
    nohup node "$PROXY_SCRIPT" > "$HOME/.claude/proxy/proxy.log" 2>&1 &

    for i in $(seq 1 25); do
        sleep 0.2
        curl -s "${PROXY_URL}/health" >/dev/null 2>&1 && break
    done
}

export ANTHROPIC_BASE_URL="$PROXY_URL"
export ANTHROPIC_AUTH_TOKEN="${LLM_API_KEY}"
export ANTHROPIC_MODEL="${LLM_MODEL}"
export ANTHROPIC_DEFAULT_OPUS_MODEL="${LLM_MODEL}"
export ANTHROPIC_DEFAULT_SONNET_MODEL="${LLM_MODEL}"
export ANTHROPIC_DEFAULT_HAIKU_MODEL="${LLM_MODEL}"
export CLAUDE_CODE_SUBAGENT_MODEL="${LLM_MODEL}"
export CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1
export DISABLE_GROWTHBOOK=1

start_proxy_if_needed || exit 1
exec claude "$@"
EOF

sudo chmod +x /usr/local/bin/my-llm
```

### 3. Kullanım

```bash
# İnteraktif
my-llm

# One-shot
my-llm -p "1+1 kaçtır?"

# DeepSeek ile aynı anda (tamamen bağımsız)
deepseek
```

## Mimari

```
┌──────────────┐     Anthropic API      ┌──────────────────┐     OpenAI API       ┌───────────────────┐
│              │ ──────────────────────▶ │                  │ ──────────────────▶  │                   │
│  Claude Code │                        │  Format Proxy    │                      │  OpenAI-uyumlu    │
│  (istemci)   │ ◀────────────────────── │  localhost:18999  │ ◀──────────────────  │  LLM Backend      │
│              │     Anthropic API       │                  │     OpenAI API       │  (vLLM/SGLang)    │
└──────────────┘                        └──────────────────┘                      └───────────────────┘
```

## Format Dönüşüm Detayları

### İstek: Anthropic → OpenAI

| Anthropic | OpenAI |
|---|---|
| `system` (üst düzey alan) | `messages[0]` → `role: "system"` |
| `messages[].content[{type: "tool_use", ...}]` | `tool_calls[{function: {arguments: "json_string"}}]` |
| `messages[].content[{type: "tool_result", ...}]` | Ayrı mesaj: `role: "tool"` |
| `tools[].input_schema` | `tools[].function.parameters` |
| `tool_choice: {type: "auto"}` | `tool_choice: "auto"` |
| `stop_sequences` | `stop` |

### Cevap: OpenAI → Anthropic

| OpenAI | Anthropic |
|---|---|
| `finish_reason: "stop"` | `stop_reason: "end_turn"` |
| `finish_reason: "length"` | `stop_reason: "max_tokens"` |
| `finish_reason: "tool_calls"` | `stop_reason: "tool_use"` |
| `<think>...</think>` (text içinde) | `{type: "thinking", thinking: "...", signature: ""}` |
| `<tool_call>...</tool_call>` (text içinde) | `{type: "tool_use", id, name, input}` |
| ` ```json {"tool_calls":[...]} ``` ` (text içinde) | `{type: "tool_use", id, name, input}` |

### Thinking (Reasoning)

Model çıktısındaki `<think>` blokları, Anthropic API'nin native `type: "thinking"` content block'larına dönüştürülür. Claude Code bunları "Thought for Xs" göstergesiyle render eder, Ctrl+O ile expand/collapse yapılabilir.

```
Model çıktısı:  <think>Reasoning adımları...</think> Final cevap
                        ↓
Anthropic:      [
                  {type: "thinking", thinking: "Reasoning adımları...", signature: ""},
                  {type: "text", text: "Final cevap"}
                ]
```

### Streaming SSE

Upstream'e non-streaming istek atılır (model davranışı daha tutarlı), cevap SSE event'lerine bölünerek Claude Code'a stream edilir:

```
message_start
  └→ content_block_start (thinking)
       └→ content_block_delta (thinking_delta) × N
       └→ content_block_stop
  └→ content_block_start (text)
       └→ content_block_delta (text_delta)
       └→ content_block_stop
  └→ content_block_start (tool_use)
       └→ content_block_delta (input_json_delta)
       └→ content_block_stop
  └→ message_delta (stop_reason + usage)
  └→ message_stop
```

## Konfigürasyon

| Ortam Değişkeni | Varsayılan | Açıklama |
|---|---|---|
| `LLM_BASE_URL` | — | Upstream OpenAI API base URL'i |
| `LLM_API_KEY` | `""` | API anahtarı |
| `LLM_MODEL` | — | Model adı |
| `PROXY_PORT` | `18999` | Proxy portu |
| `NODE_EXTRA_CA_CERTS` | — | Ek CA sertifikası (SSL zincir tamiri için) |
| `PROXY_LOG` | `"1"` | `"0"` = sadece hatalar |

## Edge Case'ler

- **Çift system mesajı** — Claude Code hem `system` alanında hem `messages` içinde system gönderebilir. Proxy tespit edip birleştirir.
- **SSL eksik zincir** — Upstream sunucu ara sertifika göndermediğinde Node.js `fetch`'i hata verir. `NODE_EXTRA_CA_CERTS` ile eksik CA eklenir.
- **Streaming vs non-streaming farkı** — Bazı modeller streaming modda tool call yazmaz. Proxy her zaman non-streaming istek atar, cevabı SSE'ye çevirir.
- **Yetim `</think>`** — Model `<think>` açılış tag'i olmadan sadece `</think>` kullanabilir. `</think>` öncesindeki tüm text thinking olarak alınır.
- **Gömülü XML/JSON tool call** — Model native tool calling desteklemediğinde `<tool_call>` XML'i veya ` ```json ``` ` bloğu içinde tool call gömebilir. Her iki format da parse edilir.

## Diğer Çözümlerle Karşılaştırma

| | Bu proxy | [local-openai2anthropic](https://github.com/dongfangzan/local-openai2anthropic) |
|---|---|---|
| **Dil** | Node.js (tek dosya, 0 bağımlılık) | Python 3.12+ (pip paketi) |
| **Kurulum** | `node script.js` | `pip install` + daemon konfigürasyonu |
| **Tool call** | Native + gömülü XML/JSON parse | Yalnızca native |
| **Thinking** | `<think>` → native `type: "thinking"` | Native `reasoning_effort` parametresi |
| **Daemon** | Manuel (nohup) | `oa2a start/stop/restart` |
| **Dashboard** | Yok | Web arayüzü |
| **Streaming** | Non-streaming → SSE sentezi | Gerçek streaming |

## Dosya Yapısı

```
~/.claude/proxy/
├── anthropic-to-openai-proxy.js   # Ana proxy script'i
├── ca-bundle.pem                  # Ek SSL CA sertifikaları (opsiyonel)
├── proxy.log                      # Log dosyası
└── proxy.pid                      # PID dosyası

/usr/local/bin/
└── my-llm                         # Wrapper script (Claude Code başlatıcı)
```

## Lisans

MIT
