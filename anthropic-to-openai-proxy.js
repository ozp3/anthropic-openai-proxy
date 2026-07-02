#!/usr/bin/env node

/**
 * Anthropic Messages API → OpenAI Chat Completions API Proxy
 *
 * Claude Code içeriden Anthropic formatında konuşur.
 * Bu proxy, istekleri OpenAI formatına çevirip upstream LLM'e iletir,
 * cevabı tekrar Anthropic formatına dönüştürür.
 *
 * Handles model-specific response processing:
 *   - Thinking process temizliği (<think>...</think> ve "Thinking Process:" prefix)
 *   - XML/JSON formatındaki gömülü tool call'ları gerçek tool_use bloklarına çevirme
 *
 * Kullanım: node anthropic-to-openai-proxy.js [port] [upstream-url]
 */

const http = require("node:http");

// ─── Konfigürasyon ───────────────────────────────────────────────────────────

const PORT = parseInt(process.argv[2], 10) || parseInt(process.env.PROXY_PORT, 10) || 18999;
const UPSTREAM_BASE = process.argv[3] || process.env.LLM_BASE_URL || "https://api.openai.com/v1";
const UPSTREAM_API_KEY = process.env.LLM_API_KEY || "";
const UPSTREAM_MODEL = process.env.LLM_MODEL || "gpt-4o";

// Model → Upstream routing: farklı modelleri farklı upstream path'lerine yönlendir
// Format: "model_substring1=url1,model_substring2=url2"
// Example: "deep=https://api.example.com/primary/v1,fast=https://api.example.com/secondary/v1"
const MODEL_ROUTING = {};
const routingRaw = process.env.MODEL_UPSTREAM_MAP || "";
routingRaw.split(",").forEach((pair) => {
  const [key, url] = pair.split("=");
  if (key && url) MODEL_ROUTING[key.trim()] = url.trim();
});

function getUpstreamForModel(model) {
  // Model adında eşleşen substring var mı?
  for (const [pattern, url] of Object.entries(MODEL_ROUTING)) {
    if (model.includes(pattern)) return url;
  }
  return UPSTREAM_BASE;
}

const LOG_ENABLED = process.env.PROXY_LOG !== "0";

function log(level, msg, data) {
  if (!LOG_ENABLED && level === "debug") return;
  const ts = new Date().toISOString();
  const line = `[${ts}] [${level}] ${msg}`;
  if (level === "error") console.error(line, data || "");
  else console.error(line, data ? JSON.stringify(data).slice(0, 500) : "");
}

// ─── ID üretici ──────────────────────────────────────────────────────────────

let idCounter = 0;
function genId(prefix) {
  return `${prefix}_${Date.now()}_${++idCounter}`;
}

// ─── Model-specific system prompt injection ───────────

const DEFAULT_SYSTEM_INJECT =
  "You are a helpful assistant with access to tools.\n" +
  "CRITICAL: When a tool is needed, you MUST output the tool call after </think>.\n" +
  "Format: </think>\n" +
  '```json\n' +
  '{"tool_calls":[{"name":"TOOL_NAME","arguments":{"param":"value"}}]}\n' +
  '```\n' +
  "WARNING: If you just describe what tool to use without actually outputting it, the system FAILS.\n" +
  "NEVER end your response after </think> without either text or a tool call.\n" +
  "NEVER use <tool_call> XML tags.\n\n";

// ─── Anthropic → OpenAI: Sistem prompt ───────────────────────────────────────

function convertSystemToOpenAI(system) {
  if (!system) return null;
  if (typeof system === "string") return system;
  if (Array.isArray(system)) {
    return system
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("\n\n");
  }
  return null;
}

// ─── Anthropic → OpenAI: Mesaj dönüşümü ──────────────────────────────────────

function convertContentBlockToOpenAI(block) {
  switch (block.type) {
    case "text":
      return { type: "text", text: block.text };
    case "image":
      return {
        type: "image_url",
        image_url: {
          url: `data:${block.source?.media_type || "image/png"};base64,${block.source?.data || ""}`,
          detail: "auto",
        },
      };
    case "tool_use":
      return {
        type: "tool_call",
        id: block.id,
        name: block.name,
        arguments: JSON.stringify(block.input),
      };
    case "tool_result":
      return {
        type: "tool_result",
        tool_use_id: block.tool_use_id,
        content: typeof block.content === "string" ? block.content : JSON.stringify(block.content),
      };
    default:
      return null;
  }
}

function convertAnthropicMessages(messages) {
  const openaiMsgs = [];

  for (const msg of messages) {
    if (typeof msg.content === "string") {
      openaiMsgs.push({
        role: msg.role,
        content: msg.content,
      });
      continue;
    }

    if (!Array.isArray(msg.content)) {
      openaiMsgs.push({ role: msg.role, content: "" });
      continue;
    }

    const textBlocks = msg.content.filter((b) => b.type === "text");
    const toolUseBlocks = msg.content.filter((b) => b.type === "tool_use");
    const toolResultBlocks = msg.content.filter((b) => b.type === "tool_result");
    const imageBlocks = msg.content.filter((b) => b.type === "image");

    // Tool result → role: "tool" mesajı
    for (const tr of toolResultBlocks) {
      const content =
        typeof tr.content === "string"
          ? tr.content
          : tr.content
          ? JSON.stringify(tr.content)
          : "";
      openaiMsgs.push({
        role: "tool",
        tool_call_id: tr.tool_use_id,
        content: content,
      });
    }

    // Assistant mesajı: text + tool_calls bir arada olabilir
    if (msg.role === "assistant") {
      const textContent = textBlocks.map((b) => b.text).join("");
      const msgObj = { role: "assistant" };
      if (textContent) msgObj.content = textContent;
      else msgObj.content = null;

      if (toolUseBlocks.length > 0) {
        msgObj.tool_calls = toolUseBlocks.map((tu) => ({
          id: tu.id,
          type: "function",
          function: {
            name: tu.name,
            arguments: JSON.stringify(tu.input),
          },
        }));
      }
      openaiMsgs.push(msgObj);
      continue;
    }

    // User mesajı: text + image olabilir
    if (msg.role === "user") {
      if (imageBlocks.length > 0 && textBlocks.length === 0) {
        const contentArr = [];
        for (const img of imageBlocks) {
          contentArr.push({
            type: "image_url",
            image_url: {
              url: `data:${img.source?.media_type || "image/png"};base64,${img.source?.data || ""}`,
            },
          });
        }
        openaiMsgs.push({ role: "user", content: contentArr });
      } else if (imageBlocks.length > 0) {
        const contentArr = textBlocks.map((b) => ({ type: "text", text: b.text }));
        for (const img of imageBlocks) {
          contentArr.push({
            type: "image_url",
            image_url: {
              url: `data:${img.source?.media_type || "image/png"};base64,${img.source?.data || ""}`,
            },
          });
        }
        openaiMsgs.push({ role: "user", content: contentArr });
      } else {
        openaiMsgs.push({
          role: "user",
          content: textBlocks.map((b) => b.text).join(""),
        });
      }
    }
  }

  return openaiMsgs;
}

// ─── Anthropic → OpenAI: Tool tanımları ──────────────────────────────────────

function convertToolsToOpenAI(tools) {
  if (!tools || !Array.isArray(tools)) return undefined;
  return tools
    .filter((t) => t.type === "custom" || !t.type || t.type === "function")
    .map((t) => ({
      type: "function",
      function: {
        name: t.name,
        description: t.description || "",
        parameters: t.input_schema || {},
      },
    }));
}

// ─── OpenAI → Anthropic: Stop reason ─────────────────────────────────────────

function mapFinishReason(reason) {
  switch (reason) {
    case "stop":
      return "end_turn";
    case "length":
      return "max_tokens";
    case "tool_calls":
      return "tool_use";
    case "content_filter":
      return "end_turn";
    default:
      return "end_turn";
  }
}

// ─── Response processing: thinking → Anthropic thinking block, tool call parse ──

/**
 * Processes model text output:
 * - <think>...</think> → ayrı thinking block'ları olarak çıkarır
 * - XML/JSON gömülü tool call'ları parse eder
 *
 * Dönüş: { cleanText, thinkingBlocks: string[], toolCalls: Array<{id, name, input}> }
 */
function cleanResponse(rawText) {
  let text = rawText || "";
  const thinkingBlocks = [];
  const toolCalls = [];

  // ── Adım 0: <think>...</think> → thinking block'ları olarak ayır ──
  const thinkRegex = /<think>([\s\S]*?)<\/think>/gi;
  let thinkMatch;
  while ((thinkMatch = thinkRegex.exec(text)) !== null) {
    const thinkingContent = thinkMatch[1].trim();
    if (thinkingContent) {
      thinkingBlocks.push(thinkingContent);
    }
  }
  // <think> bloklarını text'ten kaldır
  text = text.replace(/<think>[\s\S]*?<\/think>/gi, "");

  // Model bazen <think> açılış tag'i olmadan </think> kullanabiliyor
  // </think> öncesindeki text'i thinking olarak al
  const orphanThinkClose = text.indexOf("</think>");
  if (orphanThinkClose !== -1) {
    const orphanThinking = text.slice(0, orphanThinkClose).trim();
    if (orphanThinking) {
      thinkingBlocks.push(orphanThinking);
    }
    text = text.slice(orphanThinkClose + 8); // "</think>" sonrası
  }

  // ── Adım 1: XML <tool_call> / <tool_call> parse ──
  const xmlToolCallRegex =
    /<tool_?call>\s*<function=(\w+)>([\s\S]*?)<\/function>\s*<\/tool_?call>/g;
  let xmlMatch;
  while ((xmlMatch = xmlToolCallRegex.exec(text)) !== null) {
    const funcName = xmlMatch[1];
    const paramsBlock = xmlMatch[2];
    const input = {};

    const paramRegex = /<parameter=(\w+)>\s*([\s\S]*?)\s*<\/parameter>/g;
    let paramMatch;
    while ((paramMatch = paramRegex.exec(paramsBlock)) !== null) {
      const pName = paramMatch[1];
      let pValue = paramMatch[2].trim();
      try { pValue = JSON.parse(pValue); } catch {}
      input[pName] = pValue;
    }

    toolCalls.push({
      id: genId("toolu"),
      name: funcName,
      input: input,
    });
  }

  // XML tool call'ları text'ten kaldır
  text = text.replace(
    /<tool_?call>\s*<function=\w+>[\s\S]*?<\/function>\s*<\/tool_?call>/g,
    ""
  );

  // ── Adım 2: JSON ```json tool_calls parse ──
  const jsonBlockRegex = /```json\s*(\{[\s\S]*?\})\s*```/g;
  let jsonMatch;
  while ((jsonMatch = jsonBlockRegex.exec(text)) !== null) {
    try {
      const parsed = JSON.parse(jsonMatch[1]);
      if (parsed.tool_calls && Array.isArray(parsed.tool_calls)) {
        for (const tc of parsed.tool_calls) {
          toolCalls.push({
            id: genId("toolu"),
            name: tc.name,
            input: tc.arguments || {},
          });
        }
      }
    } catch {
      // Parse edilemezse boşver
    }
  }

  // JSON bloklarını text'ten kaldır
  text = text.replace(/```json\s*\{[\s\S]*?\}\s*```/g, "");

  // ── Adım 3: Boşlukları temizle ──
  text = text.trim();

  return { cleanText: text, thinkingBlocks, toolCalls };
}

// ─── OpenAI → Anthropic: Non-streaming cevap ─────────────────────────────────

function convertOpenAIResponse(openaiResp, originalModel) {
  const choice = openaiResp.choices?.[0];
  if (!choice) {
    return {
      id: genId("msg"),
      type: "message",
      role: "assistant",
      model: originalModel,
      content: [{ type: "text", text: "" }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: {
        input_tokens: openaiResp.usage?.prompt_tokens || 0,
        output_tokens: openaiResp.usage?.completion_tokens || 0,
      },
    };
  }

  const msg = choice.message;
  const content = [];

  // ── Önce native tool_calls kontrol et (destekleyen modeller için) ──
  if (msg.tool_calls && msg.tool_calls.length > 0) {
    // Text varsa ekle
    if (msg.content) {
      content.push({ type: "text", text: msg.content });
    }
    for (const tc of msg.tool_calls) {
      let input;
      try {
        input = JSON.parse(tc.function.arguments);
      } catch {
        input = {};
      }
      content.push({
        type: "tool_use",
        id: tc.id,
        name: tc.function.name,
        input: input,
      });
    }
  } else if (msg.content) {
    // Text: extract thinking ve tool call'ları ayıkla
    const { cleanText, thinkingBlocks, toolCalls } = cleanResponse(msg.content);

    // Thinking bloklarını Anthropic formatında ekle (DeepSeek: signature="" boş)
    for (const thinking of thinkingBlocks) {
      content.push({
        type: "thinking",
        thinking: thinking,
        signature: "",
      });
    }

    if (cleanText) {
      content.push({ type: "text", text: cleanText });
    }

    for (const tc of toolCalls) {
      content.push({
        type: "tool_use",
        id: tc.id,
        name: tc.name,
        input: tc.input,
      });
    }
  }

  if (content.length === 0) {
    content.push({ type: "text", text: "" });
  }

  const stopReason = content.some((b) => b.type === "tool_use")
    ? "tool_use"
    : mapFinishReason(choice.finish_reason);

  return {
    id: openaiResp.id || genId("msg"),
    type: "message",
    role: "assistant",
    model: originalModel,
    content: content,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: {
      input_tokens: openaiResp.usage?.prompt_tokens || 0,
      output_tokens: openaiResp.usage?.completion_tokens || 0,
    },
  };
}

// ─── OpenAI → Anthropic: Streaming cevap (SSE) ───────────────────────────────

class StreamingConverter {
  constructor(messageId, model, res) {
    this.msgId = messageId;
    this.model = model;
    this.res = res;

    this.phase = "init"; // init | started | in_text | in_tool | done
    this.blockIndex = 0;

    // Text buffer: tüm text deltalarını biriktir, stream sonunda işle
    this.textBuffer = "";

    // Token sayıları
    this.inputTokens = 0;
    this.outputTokens = 0;

    // Finish reason
    this.finishReason = null;
  }

  emitSSE(event, data) {
    try {
      this.res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    } catch (e) {
      log("error", "SSE write failed", e.message);
    }
  }

  processChunk(chunk) {
    try {
      if (!chunk.choices || chunk.choices.length === 0) return;

      if (chunk.usage) {
        this.inputTokens = chunk.usage.prompt_tokens || this.inputTokens;
        this.outputTokens = chunk.usage.completion_tokens || this.outputTokens;
      }

      const delta = chunk.choices[0].delta;
      if (!delta) return;

      // Text delta → buffer'a ekle
      if (delta.content) {
        this.textBuffer += delta.content;
      }

      // Native tool_call delta (destekleyen modeller için)
      if (delta.tool_calls && delta.tool_calls.length > 0) {
        // Bu model native tool call kullanmıyor, ama destekleyen bir model
        // gelirse diye burayı işlevsel tutalım
        this._handleNativeToolCallDelta(delta.tool_calls);
      }

      // Finish
      if (delta.finish_reason !== undefined && delta.finish_reason !== null) {
        this.finishReason = delta.finish_reason;
      }
    } catch (e) {
      log("error", "Chunk processing error", e.message);
    }
  }

  _handleNativeToolCallDelta(_toolCalls) {
    // Native tool call delta işleme — şimdilik gerekmiyor
    // Reserved for models with native tool call delta support
  }

  /**
   * Stream bittiğinde çağrılır.
   * Buffer'daki text'i temizler ve tüm Anthropic SSE event'lerini basar.
   */
  finalize() {
    // Text'i temizle, thinking ve tool call'ları ayıkla
    const { cleanText, thinkingBlocks, toolCalls } = cleanResponse(this.textBuffer);

    // message_start
    if (this.phase === "init") {
      this.phase = "started";
      this.emitSSE("message_start", {
        type: "message_start",
        message: {
          id: this.msgId,
          type: "message",
          role: "assistant",
          model: this.model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: this.inputTokens, output_tokens: 0 },
        },
      });
    }

    // Thinking blokları (DeepSeek formatıyla birebir aynı)
    for (const thinking of thinkingBlocks) {
      // DeepSeek: content_block_start.thinking="" ve signature=""
      this.emitSSE("content_block_start", {
        type: "content_block_start",
        index: this.blockIndex,
        content_block: { type: "thinking", thinking: "", signature: "" },
      });

      // DeepSeek gibi küçük chunk'lar halinde gönder
      let pos = 0;
      while (pos < thinking.length) {
        // DeepSeek benzeri: chunk boyutu 3-12 karakter arası
        const chunkLen = Math.min(3 + (thinking.length - pos) % 10, thinking.length - pos);
        const chunk = thinking.slice(pos, pos + chunkLen);
        pos += chunkLen;
        this.emitSSE("content_block_delta", {
          type: "content_block_delta",
          index: this.blockIndex,
          delta: { type: "thinking_delta", thinking: chunk },
        });
      }

      this.emitSSE("content_block_stop", {
        type: "content_block_stop",
        index: this.blockIndex,
      });
      this.blockIndex++;
    }

    // Text bloğu
    if (cleanText) {
      this.emitSSE("content_block_start", {
        type: "content_block_start",
        index: this.blockIndex,
        content_block: { type: "text", text: "" },
      });

      this.emitSSE("content_block_delta", {
        type: "content_block_delta",
        index: this.blockIndex,
        delta: { type: "text_delta", text: cleanText },
      });

      this.emitSSE("content_block_stop", {
        type: "content_block_stop",
        index: this.blockIndex,
      });
      this.blockIndex++;
    }

    // Tool use blokları
    for (const tc of toolCalls) {
      const blockIdx = this.blockIndex;
      this.blockIndex++;

      this.emitSSE("content_block_start", {
        type: "content_block_start",
        index: blockIdx,
        content_block: {
          type: "tool_use",
          id: tc.id,
          name: tc.name,
          input: {},
        },
      });

      this.emitSSE("content_block_delta", {
        type: "content_block_delta",
        index: blockIdx,
        delta: {
          type: "input_json_delta",
          partial_json: JSON.stringify(tc.input),
        },
      });

      this.emitSSE("content_block_stop", {
        type: "content_block_stop",
        index: blockIdx,
      });
    }

    // Stop reason belirle
    const stopReason = toolCalls.length > 0
      ? "tool_use"
      : mapFinishReason(this.finishReason || "stop");

    this.emitSSE("message_delta", {
      type: "message_delta",
      delta: {
        stop_reason: stopReason,
        stop_sequence: null,
      },
      usage: { output_tokens: this.outputTokens || 0 },
    });

    this.emitSSE("message_stop", {
      type: "message_stop",
    });

    this.phase = "done";
  }
}

// ─── Anthropik istek → OpenAI isteği ─────────────────────────────────────────

function convertRequest(anthropicBody) {
  const systemText = convertSystemToOpenAI(anthropicBody.system);
  const messages = convertAnthropicMessages(anthropicBody.messages);
  const tools = convertToolsToOpenAI(anthropicBody.tools);

  // Claude Code thinking modu → sistem prompt'u buna göre ayarla
  const thinkingEnabled = anthropicBody.thinking?.type === "enabled";
  const thinkingBudget = anthropicBody.thinking?.budget_tokens || 4000;

  let finalSystemText;
  if (thinkingEnabled) {
    // Thinking ZORUNLU mod — Claude Code reasoning bekliyor
    finalSystemText =
      "THINKING MODE IS ACTIVE. You MUST enclose ALL your reasoning inside <think>...</think> tags.\n" +
      `Spend up to ${Math.round(thinkingBudget / 1000)}k tokens on thinking before answering.\n` +
      "Format: <think>\nyour detailed step-by-step reasoning here\n</think>\n\n" +
      "After </think>, provide ONLY the final answer — no analysis, no explanation, no commentary.\n" +
      "CRITICAL: If you skip the <think> tags, the system will FAIL.\n" +
      "When you need to use tools, after </think> output ONLY:\n" +
      '```json\n{"tool_calls":[{"name":"TOOL_NAME","arguments":{"param":"value"}}]}\n```\n' +
      "Never use <tool_call> XML — it will break the system.\n\n";
  } else {
    finalSystemText = DEFAULT_SYSTEM_INJECT;
  }

  if (systemText) {
    finalSystemText += systemText;
  }

  messages.unshift({ role: "system", content: finalSystemText });

  // Birden fazla system mesajı varsa birleştir (vLLM requires single system message at position 0)
  const systemMessages = messages.filter((m) => m.role === "system");
  if (systemMessages.length > 1) {
    const combinedContent = systemMessages.map((m) => m.content).join("\n\n");
    // System olmayan mesajları tut, başa birleştirilmiş system mesajını koy
    const nonSystem = messages.filter((m) => m.role !== "system");
    messages.length = 0;
    messages.push({ role: "system", content: combinedContent });
    messages.push(...nonSystem);
  }

  // Debug: mesaj rollerini logla
  log("debug", "→ Message roles:", messages.map((m, i) => `${i}:${m.role}`));

  const openaiReq = {
    model: anthropicBody.model || UPSTREAM_MODEL,
    messages: messages,
    max_tokens: anthropicBody.max_tokens,
    temperature: anthropicBody.temperature,
    top_p: anthropicBody.top_p,
    stream: anthropicBody.stream || false,
  };

  if (tools && tools.length > 0) {
    openaiReq.tools = tools;
    if (anthropicBody.tool_choice) {
      const tc = anthropicBody.tool_choice;
      if (tc.type === "auto") {
        openaiReq.tool_choice = "auto";
      } else if (tc.type === "any") {
        openaiReq.tool_choice = "required";
      } else if (tc.type === "tool" && tc.name) {
        openaiReq.tool_choice = { type: "function", function: { name: tc.name } };
      }
    }
  }

  if (anthropicBody.stop_sequences && anthropicBody.stop_sequences.length > 0) {
    openaiReq.stop = anthropicBody.stop_sequences;
  }

  // stream_options sadece streaming=true iken geçerli
  if (openaiReq.stream) {
    openaiReq.stream_options = { include_usage: true };
  } else {
    delete openaiReq.stream_options;
  }

  return openaiReq;
}

// ─── Ana proxy handler ───────────────────────────────────────────────────────

function buildUpstreamUrl(path, model) {
  const base = getUpstreamForModel(model || UPSTREAM_MODEL).replace(/\/+$/, "");
  return `${base}${path}`;
}

async function handleMessages(req, res, body) {
  const anthropicReq = body;

  if (anthropicReq.stream) {
    await handleStreamingRequest(req, res, anthropicReq);
  } else {
    await handleNonStreamingRequest(req, res, anthropicReq);
  }
}

async function handleNonStreamingRequest(_req, res, anthropicReq) {
  const openaiReq = convertRequest(anthropicReq);
  openaiReq.stream = false;

  log("debug", "→ OpenAI non-streaming request", {
    model: openaiReq.model,
    msgCount: openaiReq.messages.length,
    hasTools: !!openaiReq.tools,
  });

  try {
    const upstreamUrl = buildUpstreamUrl("/chat/completions", anthropicReq.model);
    const upstreamResp = await fetch(upstreamUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(UPSTREAM_API_KEY
          ? { Authorization: `Bearer ${UPSTREAM_API_KEY}` }
          : {}),
      },
      body: JSON.stringify(openaiReq),
    });

    if (!upstreamResp.ok) {
      const errText = await upstreamResp.text();
      log("error", `Upstream error ${upstreamResp.status}`, errText);
      res.writeHead(upstreamResp.status, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          type: "error",
          error: {
            type: "api_error",
            message: `Upstream returned ${upstreamResp.status}: ${errText.slice(0, 500)}`,
          },
        })
      );
      return;
    }

    const openaiResp = await upstreamResp.json();
    const anthropicResp = convertOpenAIResponse(openaiResp, anthropicReq.model);

    log("debug", "← Anthropic non-streaming response", {
      blocks: anthropicResp.content.length,
      blockTypes: anthropicResp.content.map((b) => b.type),
      stopReason: anthropicResp.stop_reason,
    });

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(anthropicResp));
  } catch (e) {
    log("error", "Non-streaming request failed", e.message);
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        type: "error",
        error: { type: "api_error", message: e.message },
      })
    );
  }
}

async function handleStreamingRequest(_req, res, anthropicReq) {
  // Upstream model behaves differently in streaming mode (may omit tool calls)).
  // Bu yüzden upstream'e HER ZAMAN non-streaming istek atıp,
  // cevabı Claude Code için streaming SSE'ye çeviriyoruz.
  const openaiReq = convertRequest(anthropicReq);
  openaiReq.stream = false;
  delete openaiReq.stream_options; // non-streaming'de geçersiz

  log("debug", "→ OpenAI (non-streaming → SSE synthesize)", {
    model: openaiReq.model,
    msgCount: openaiReq.messages.length,
    hasTools: !!openaiReq.tools,
  });

  const upstreamUrl = buildUpstreamUrl("/chat/completions", anthropicReq.model);

  try {
    const upstreamResp = await fetch(upstreamUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(UPSTREAM_API_KEY
          ? { Authorization: `Bearer ${UPSTREAM_API_KEY}` }
          : {}),
      },
      body: JSON.stringify(openaiReq),
    });

    if (!upstreamResp.ok) {
      const errText = await upstreamResp.text();
      log("error", `Upstream error ${upstreamResp.status}`, errText);
      res.writeHead(upstreamResp.status, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        type: "error",
        error: { type: "api_error", message: `Upstream returned ${upstreamResp.status}: ${errText.slice(0, 500)}` },
      }));
      return;
    }

    const openaiResp = await upstreamResp.json();
    const choice = openaiResp.choices?.[0];
    const rawText = choice?.message?.content || "";

    log("debug", `← Non-streaming response (${rawText.length} chars), synthesizing SSE`);

    // Non-streaming cevabı StreamingConverter'a besle
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });

    const msgId = genId("msg");
    const converter = new StreamingConverter(msgId, anthropicReq.model, res);

    // Mock delta chunk'ları oluştur (non-streaming cevabı simüle et)
    if (rawText) {
      const fakeUsage = openaiResp.usage || {};
      converter.inputTokens = fakeUsage.prompt_tokens || 0;
      converter.outputTokens = fakeUsage.completion_tokens || 0;
      converter.finishReason = choice.finish_reason || "stop";

      // Text'i kelime kelime simüle edilmiş delta'lara böl
      converter.textBuffer = rawText;
    }

    converter.finalize();
    res.end();

    log("debug", `← SSE synthesis done (${converter.textBuffer.length} chars)`);
  } catch (e) {
    log("error", "Streaming synthesis failed", e.message);
    if (!res.headersSent) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        type: "error",
        error: { type: "api_error", message: e.message },
      }));
    }
  }
}

async function handleCountTokens(_req, res, body) {
  let totalChars = 0;

  if (body.system) {
    const sysText = convertSystemToOpenAI(body.system);
    totalChars += sysText ? sysText.length : 0;
  }

  totalChars += DEFAULT_SYSTEM_INJECT.length;

  if (body.messages) {
    for (const msg of body.messages) {
      if (typeof msg.content === "string") {
        totalChars += msg.content.length;
      } else if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block.type === "text") totalChars += (block.text || "").length;
          else if (block.type === "tool_use") totalChars += JSON.stringify(block.input || {}).length;
          else if (block.type === "tool_result") {
            const c = typeof block.content === "string" ? block.content : JSON.stringify(block.content || "");
            totalChars += c.length;
          }
        }
      }
    }
  }

  if (body.tools) {
    totalChars += JSON.stringify(body.tools).length;
  }

  const estimatedTokens = Math.ceil(totalChars / 4);

  log("debug", `count_tokens: ~${estimatedTokens} tokens (${totalChars} chars)`);

  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ input_tokens: estimatedTokens }));
}

// ─── HTTP Sunucu ─────────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const path = url.pathname;

  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "*");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.method === "GET" && (path === "/" || path === "/health")) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", upstream: BASE, model: UPSTREAM_MODEL }));
    return;
  }

  if (req.method !== "POST") {
    res.writeHead(405, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Method not allowed" }));
    return;
  }

  let body = "";
  try {
    body = await new Promise((resolve, reject) => {
      let data = "";
      req.on("data", (chunk) => (data += chunk));
      req.on("end", () => resolve(data));
      req.on("error", reject);
    });
  } catch (e) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Failed to read body" }));
    return;
  }

  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Invalid JSON" }));
    return;
  }

  log("debug", `${req.method} ${path}`);

  try {
    if (path === "/v1/messages" || path === "/v1/messages/") {
      await handleMessages(req, res, parsed);
    } else if (path === "/v1/messages/count_tokens") {
      await handleCountTokens(req, res, parsed);
    } else if (path === "/v1/models" || path === "/v1/models/") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          data: [
            {
              id: UPSTREAM_MODEL,
              object: "model",
              created: 1700000000,
              owned_by: "upstream",
            },
          ],
        })
      );
    } else {
      log("debug", `Unknown endpoint: ${path}`);
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: `Unsupported endpoint: ${path}` }));
    }
  } catch (e) {
    log("error", `Handler error for ${path}`, e.message);
    if (!res.headersSent) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          type: "error",
          error: { type: "api_error", message: e.message },
        })
      );
    }
  }
});

// ─── Başlat ──────────────────────────────────────────────────────────────────

server.listen(PORT, "127.0.0.1", () => {
  const logFile = process.env.PROXY_LOG_FILE || "";
  if (logFile) {
    const fs = require("node:fs");
    fs.writeFileSync(logFile, `${Date.now()}\n${process.pid}\n`);
  }

  const pidFile = process.env.PROXY_PID_FILE;
  if (pidFile) {
    const fs = require("node:fs");
    fs.writeFileSync(pidFile, String(process.pid));
  }

  log("info", `Proxy listening on http://127.0.0.1:${PORT}`);
  log("info", `Upstream: ${BASE}`);
  log("info", `Model: ${UPSTREAM_MODEL}`);
});

process.on("SIGTERM", () => {
  log("info", "SIGTERM received, shutting down");
  server.close(() => process.exit(0));
});
process.on("SIGINT", () => {
  log("info", "SIGINT received, shutting down");
  server.close(() => process.exit(0));
});
