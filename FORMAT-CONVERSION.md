# Anthropic ↔ OpenAI API Format Dönüşümü

Claude Code'un kullandığı **Anthropic Messages API** formatı ile OpenAI-uyumlu LLM'lerin kullandığı **OpenAI Chat Completions API** formatı arasında çift yönlü protokol çevirisi yapan yerel proxy'nin teknik dokümantasyonu.

## Mimari

```
┌──────────────┐     Anthropic API      ┌──────────────────┐     OpenAI API       ┌───────────────────┐
│              │ ──────────────────────▶ │                  │ ──────────────────▶  │                   │
│  Claude Code │                        │  Format Proxy    │                      │  OpenAI-uyumlu    │
│  (istemci)   │ ◀────────────────────── │  localhost:18999  │ ◀──────────────────  │  LLM Backend      │
│              │     Anthropic API       │                  │     OpenAI API       │  (vLLM/SGLang)    │
└──────────────┘                        └──────────────────┘                      └───────────────────┘
```

Proxy, Claude Code'a karşı bir Anthropic API sunucusu gibi davranırken, upstream LLM'e karşı bir OpenAI istemcisi gibi davranır.

---

## 1. İstek Dönüşümü: Anthropic → OpenAI

### 1.1 Sistem Prompt

Anthropic API'de `system` üst düzey, mesajlardan bağımsız bir alandır. OpenAI'da ise `messages` dizisinin ilk elemanı olarak `role: "system"` mesajıdır.

```json
// Anthropic
{
  "system": "You are a helpful assistant.",
  "messages": [...]
}

// → OpenAI
{
  "messages": [
    {"role": "system", "content": "You are a helpful assistant."},
    ...
  ]
}
```

Anthropic `system` parametresi string olabileceği gibi content block dizisi de olabilir:

```json
// Anthropic (array form)
{ "system": [{"type": "text", "text": "You are helpful."}] }

// → OpenAI
{ "messages": [{"role": "system", "content": "You are helpful."}] }
```

Tüm text blokları `\n\n` ile birleştirilerek tek system mesajına dönüştürülür.

**Çoklu system mesajı:** vLLM gibi bazı OpenAI-uyumlu backend'ler yalnızca tek bir system mesajını kabul eder ve bu mesajın `messages` dizisinin ilk elemanı olmasını zorunlu tutar. Claude Code bazı durumlarda system prompt'u hem top-level `system` alanında hem de `messages` içinde gönderebilir. Proxy tüm system mesajlarını tespit edip **birleştirerek** en başa tek bir system mesajı olarak yerleştirir.

### 1.2 Mesaj Dönüşümü

#### User Mesajı

| Anthropic Content Block | OpenAI Format |
|---|---|
| `{type: "text", text: "..."}` | `"..."` (string) veya `{type: "text", text: "..."}` |
| `{type: "image", source: {media_type, data}}` | `{type: "image_url", image_url: {url: "data:...;base64,..."}}` |
| `{type: "tool_result", tool_use_id, content}` | Ayrı mesaj: `{role: "tool", tool_call_id, content: "..."}` |

Birden fazla content block varsa OpenAI `content` array formatı kullanılır. Sadece text varsa string olarak sadeleştirilir.

#### Assistant Mesajı

```json
// Anthropic
{
  "role": "assistant",
  "content": [
    {"type": "text", "text": "Let me check the weather."},
    {"type": "tool_use", "id": "toolu_01", "name": "get_weather", "input": {"city": "Paris"}}
  ]
}

// → OpenAI
{
  "role": "assistant",
  "content": "Let me check the weather.",
  "tool_calls": [{
    "id": "toolu_01",
    "type": "function",
    "function": {
      "name": "get_weather",
      "arguments": "{\"city\":\"Paris\"}"
    }
  }]
}
```

**Kritik:** Anthropic'te `tool_use.input` bir JSON objesidir. OpenAI'da `tool_calls[].function.arguments` bir **JSON string'idir**. `JSON.stringify()` / `JSON.parse()` dönüşümü yapılır.

#### Tool Result (User mesajı içinde)

Anthropic'te tool sonucu, bir **user mesajının içinde** content block olarak bulunur:

```json
// Anthropic
{
  "role": "user",
  "content": [
    {"type": "tool_result", "tool_use_id": "toolu_01", "content": "Güneşli, 25°C"},
    {"type": "text", "text": "Teşekkürler"}
  ]
}

// → OpenAI (iki ayrı mesaj)
{"role": "tool", "tool_call_id": "toolu_01", "content": "Güneşli, 25°C"},
{"role": "user", "content": "Teşekkürler"}
```

`tool_result.content` string veya obje olabilir — obje ise `JSON.stringify` ile string'e çevrilir.

### 1.3 Tool Tanımları

```json
// Anthropic
{
  "tools": [{
    "name": "get_weather",
    "description": "Get current weather for a city",
    "input_schema": {
      "type": "object",
      "properties": {
        "city": {"type": "string", "description": "City name"}
      },
      "required": ["city"]
    }
  }]
}

// → OpenAI
{
  "tools": [{
    "type": "function",
    "function": {
      "name": "get_weather",
      "description": "Get current weather for a city",
      "parameters": {
        "type": "object",
        "properties": {
          "city": {"type": "string", "description": "City name"}
        },
        "required": ["city"]
      }
    }
  }]
}
```

`tool_choice` dönüşümü:

| Anthropic | OpenAI |
|---|---|
| `{type: "auto"}` | `"auto"` |
| `{type: "any"}` | `"required"` |
| `{type: "tool", name: "x"}` | `{type: "function", function: {name: "x"}}` |

### 1.4 Diğer Parametreler

| Parametre | Dönüşüm |
|---|---|
| `model` | Aynen geçer (model mapping yapılandırılabilir) |
| `max_tokens` | Aynen geçer |
| `temperature` | Aynen geçer |
| `top_p` | Aynen geçer |
| `top_k` | OpenAI desteklemez → drop edilir |
| `stop_sequences` | `stop` (string array) olarak geçer |
| `stream` | Bkz. Bölüm 3 |

---

## 2. Cevap Dönüşümü: OpenAI → Anthropic

### 2.1 Stop Reason Mapping

| OpenAI `finish_reason` | Anthropic `stop_reason` |
|---|---|
| `"stop"` | `"end_turn"` |
| `"length"` | `"max_tokens"` |
| `"tool_calls"` | `"tool_use"` |
| `"content_filter"` | `"end_turn"` |
| Diğer / null | `"end_turn"` |

Cevapta `tool_use` content block'u varsa, `stop_reason` otomatik olarak `"tool_use"` yapılır.

### 2.2 Usage (Token Sayımı)

```json
// OpenAI
{"usage": {"prompt_tokens": 100, "completion_tokens": 50, "total_tokens": 150}}

// → Anthropic
{"usage": {"input_tokens": 100, "output_tokens": 50}}
```

### 2.3 Content Block Dönüşümü

#### Native Tool Call (backend native destekliyorsa)

Eğer upstream OpenAI-uyumlu backend native function calling destekliyorsa (vLLM `--enable-auto-tool-choice`, SGLang vb.):

```json
// OpenAI response
{
  "choices": [{
    "message": {
      "content": "Let me check.",
      "tool_calls": [{
        "id": "call_abc123",
        "type": "function",
        "function": {"name": "get_weather", "arguments": "{\"city\":\"Paris\"}"}
      }]
    },
    "finish_reason": "tool_calls"
  }]
}

// → Anthropic response
{
  "content": [
    {"type": "text", "text": "Let me check."},
    {"type": "tool_use", "id": "call_abc123", "name": "get_weather", "input": {"city": "Paris"}}
  ],
  "stop_reason": "tool_use"
}
```

#### Gömülü Tool Call (backend native desteklemiyorsa)

Bazı modeller (özellikle reasoning modelleri) native OpenAI tool calling kullanmaz; tool call'ları text içinde özel formatlarda gömer. Proxy bu formatları regex ile parse edip gerçek Anthropic `tool_use` bloklarına dönüştürür.

**Desteklenen gömülü formatlar:**

**XML formatı:**
```xml
<tool_call>
<function=get_weather>
<parameter=city>
Paris
</parameter>
</function>
</tool_call>
```

`<tool_call>` ve `<tool_call>` (underscore'lu/underscore'suz) iki varyant da desteklenir.

**JSON formatı:**
````json
```json
{"tool_calls":[{"name":"get_weather","arguments":{"city":"Paris"}}]}
```
````

Her iki format da text'ten çıkarılır, parse edilir ve şuna dönüştürülür:

```json
{"type": "tool_use", "id": "toolu_xxx", "name": "get_weather", "input": {"city": "Paris"}}
```

### 2.4 Thinking (Reasoning) Dönüşümü

Bazı upstream modeller (örn. DeepSeek-R1, vb.) cevaplarında reasoning/thinking sürecini de döndürür. Anthropic API'de bu `type: "thinking"` content block'u ile temsil edilir.

Model çıktısındaki `<think>...</think>` tag'leri parse edilir:

```
Model ham çıktısı:
<think>Kullanıcı hava durumunu soruyor. WebFetch kullanmalıyım.</think>
Hava durumunu getiriyorum...

                        ↓

Anthropic content blokları:
[
  {
    "type": "thinking",
    "thinking": "Kullanıcı hava durumunu soruyor. WebFetch kullanmalıyım.",
    "signature": ""
  },
  {
    "type": "text",
    "text": "Hava durumunu getiriyorum..."
  }
]
```

**Varyasyonlar ve edge case'ler:**

| Model davranışı | İşleme |
|---|---|
| `<think>...</think>` tam tag çifti | Regex ile yakalanır, thinking block'a dönüştürülür |
| Sadece `</think>` (açılış tag'i yok) | `</think>` öncesindeki tüm text thinking olarak alınır |
| "Thinking Process:" prefix'i (hiç tag yok) | Thinking block oluşturulmaz, text olarak geçer |

**Signature alanı:** Anthropic API'sinde `type: "thinking"` bloğu için `signature` alanı zorunludur. Bu alan, Anthropic'in kendi modellerinde thinking içeriğinin kriptografik doğrulaması için kullanılır. Üçüncü parti modeller için boş string (`""`) kullanılması yeterlidir — Claude Code boş signature'ı kabul eder ve thinking'i render eder.

---

## 3. Streaming (SSE) Dönüşümü

### 3.1 Neden Non-Streaming Tercih Edilebilir?

Bazı upstream modeller `stream: true` ve `stream: false` modlarında **farklı çıktı formatları** üretir. Özellikle reasoning modelleri streaming modunda tool call yazmayabilir veya thinking tag'lerini atlayabilir.

Bu durumda proxy, Claude Code'dan gelen streaming isteğini upstream'e **non-streaming** olarak iletir, tam cevabı alır, ardından Claude Code'a **synthesize edilmiş SSE event'leri** olarak geri döner.

```
Claude Code → proxy (stream: true isteği)
                → proxy upstream'e stream: false isteği atar
                → upstream tam cevabı döner
                → proxy cevabı SSE event'lerine böler
                → Claude Code'a stream eder
```

Bu sayede upstream modelin non-streaming'deki daha tutarlı davranışından faydalanılırken Claude Code streaming deneyimini korur.

### 3.2 SSE Event Sırası ve Formatı

Aşağıdaki sıra, Anthropic Messages API streaming spesifikasyonuyla birebir uyumludur:

```
event: message_start
  data: {
    "type": "message_start",
    "message": {
      "id": "msg_xxx",
      "type": "message",
      "role": "assistant",
      "model": "...",
      "content": [],
      "stop_reason": null,
      "stop_sequence": null,
      "usage": {"input_tokens": 100, "output_tokens": 0}
    }
  }

┌─ Thinking bloğu (opsiyonel)
│ event: content_block_start
│   data: {
│     "type": "content_block_start",
│     "index": 0,
│     "content_block": {
│       "type": "thinking",
│       "thinking": "",         ← DeepSeek ile aynı: içerik boş başlar
│       "signature": ""         ← 3. parti modeller için boş
│     }
│   }
│
│ event: content_block_delta
│   data: {
│     "type": "content_block_delta",
│     "index": 0,
│     "delta": {
│       "type": "thinking_delta",
│       "thinking": "...küçük chunk..."
│     }
│   }
│   ... (birden fazla delta, her biri 3-12 karakter)
│
│ event: content_block_stop
│   data: {"type": "content_block_stop", "index": 0}
└─

┌─ Text bloğu (opsiyonel)
│ event: content_block_start
│   data: {
│     "type": "content_block_start",
│     "index": 1,
│     "content_block": {"type": "text", "text": ""}
│   }
│
│ event: content_block_delta
│   data: {
│     "type": "content_block_delta",
│     "index": 1,
│     "delta": {"type": "text_delta", "text": "..."}
│   }
│
│ event: content_block_stop
│   data: {"type": "content_block_stop", "index": 1}
└─

┌─ Tool Use bloğu (opsiyonel, her tool call için bir blok)
│ event: content_block_start
│   data: {
│     "type": "content_block_start",
│     "index": 2,
│     "content_block": {
│       "type": "tool_use",
│       "id": "toolu_xxx",
│       "name": "get_weather",
│       "input": {}
│     }
│   }
│
│ event: content_block_delta
│   data: {
│     "type": "content_block_delta",
│     "index": 2,
│     "delta": {
│       "type": "input_json_delta",
│       "partial_json": "{\"city\":\"Paris\"}"
│     }
│   }
│
│ event: content_block_stop
│   data: {"type": "content_block_stop", "index": 2}
└─

event: message_delta
  data: {
    "type": "message_delta",
    "delta": {
      "stop_reason": "tool_use",
      "stop_sequence": null
    },
    "usage": {"output_tokens": 80}
  }

event: message_stop
  data: {"type": "message_stop"}
```

**Content block sıralaması:** Thinking → Text → Tool Use. Her block tipi sıfır veya daha fazla kez bulunabilir.

**Thinking chunk boyutu:** Her bir `thinking_delta` 3-12 karakter arası küçük parçalar halinde gönderilir. Bu, Claude Code'un "Thought for Xs" sayacının doğru çalışması için önemlidir.

### 3.3 Non-Streaming Cevap Formatı

Claude Code non-streaming istek yaptığında (veya `-p` flag'i ile kullanıldığında) standart JSON cevap döner:

```json
{
  "id": "msg_xxx",
  "type": "message",
  "role": "assistant",
  "model": "upstream-model-name",
  "content": [
    {"type": "thinking", "thinking": "reasoning...", "signature": ""},
    {"type": "text", "text": "final answer"},
    {"type": "tool_use", "id": "toolu_xxx", "name": "get_weather", "input": {"city": "Paris"}}
  ],
  "stop_reason": "tool_use",
  "stop_sequence": null,
  "usage": {"input_tokens": 100, "output_tokens": 80}
}
```

---

## 4. Yardımcı Endpoint'ler

### 4.1 Token Sayımı

```
POST /v1/messages/count_tokens
```

Anthropic formatındaki mesajları alır, karakter sayımı üzerinden yaklaşık token tahmini yapar (`ceil(totalChars / 4)`). Sistem prompt, mesaj içerikleri ve tool tanımları dahil edilir.

### 4.2 Model Listesi

```
GET /v1/models
```

Claude Code bazen model listesini sorgular. Proxy upstream modele karşılık gelen tek bir model döner.

### 4.3 Health Check

```
GET /health
```

Proxy'nin çalışır durumda olduğunu, upstream URL'i ve model adını döner.

---

## 5. Edge Case'ler

### 5.1 SSL Sertifika Zinciri

Bazı upstream sunucular eksik intermediate TLS sertifikası gönderebilir. Node.js `fetch` API'si (`curl`'ün aksine) AIA (Authority Information Access) fetching yapmaz ve eksik zincir durumunda `UNABLE_TO_VERIFY_LEAF_SIGNATURE` hatası verir.

**Çözüm:** Eksik ara CA sertifikası indirilir, PEM formatında kaydedilir ve `NODE_EXTRA_CA_CERTS` ortam değişkeni ile Node.js'in TLS trust store'una eklenir.

### 5.2 Çift Sistem Mesajı

Claude Code bazı durumlarda hem top-level `system` alanında hem de `messages` dizisi içinde `role: "system"` mesajı gönderebilir. OpenAI-uyumlu backend'ler genellikle yalnızca başta tek bir system mesajı kabul eder.

**Çözüm:** Dönüşüm sonrası tüm `role: "system"` mesajları tespit edilir, içerikleri birleştirilir ve `messages[0]` pozisyonuna tek bir system mesajı olarak yerleştirilir.

### 5.3 `stream_options` Çakışması

`stream_options` parametresi OpenAI API'sinde yalnızca `stream: true` ile birlikte geçerlidir. Proxy upstream'e non-streaming istek attığında bu parametrenin kaldırılması gerekir, aksi takdirde vLLM `400 Bad Request` döner.

### 5.4 Thinking Tag Varyasyonları

Farklı upstream modeller reasoning'lerini farklı şekillerde ifade eder:

| Format | Örnek | Yakalama |
|---|---|---|
| Tam tag çifti | `<think>...</think>` | Regex: `/<think>([\s\S]*?)<\/think>/gi` |
| Sadece kapatma | `...reasoning...</think>` | `indexOf("</think>")` ile tespit |
| Text prefix | `Thinking Process:\n1. **...` | Regex ile prefix eşleştirme |
| Hiç formatlama yok | Düz reasoning text'i | Thinking block oluşturulmaz |

---

## 6. Konfigürasyon

Proxy ortam değişkenleri ile yapılandırılır:

| Değişken | Varsayılan | Açıklama |
|---|---|---|
| `PROXY_PORT` | `18999` | Proxy'nin dinleyeceği port |
| `LLM_BASE_URL` | — | Upstream OpenAI-uyumlu API base URL'i |
| `LLM_API_KEY` | `""` | Upstream API anahtarı (gerekmiyorsa boş geçilir) |
| `LLM_MODEL` | — | Kullanılacak model adı |
| `NODE_EXTRA_CA_CERTS` | — | Ek SSL CA sertifika dosyası yolu |
| `PROXY_LOG` | `"1"` | Log seviyesi (`"0"` = sadece hatalar) |

Claude Code tarafında `ANTHROPIC_BASE_URL` proxy'ye (`http://127.0.0.1:18999`) point edilir:

```bash
export ANTHROPIC_BASE_URL="http://127.0.0.1:18999"
export ANTHROPIC_AUTH_TOKEN=""
export ANTHROPIC_MODEL="..."
export ANTHROPIC_DEFAULT_OPUS_MODEL="..."
export ANTHROPIC_DEFAULT_SONNET_MODEL="..."
export ANTHROPIC_DEFAULT_HAIKU_MODEL="..."
export CLAUDE_CODE_SUBAGENT_MODEL="..."
```

---

## 7. Akış Diyagramı

```
┌─────────────────────────────────────────────────────────────────────┐
│                        Claude Code İsteği                           │
│  POST /v1/messages {"model":"...", "messages":[...], "stream":true} │
└──────────────────────────────┬──────────────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────────────┐
│  DÖNÜŞÜM (Anthropic → OpenAI)                                       │
│                                                                     │
│  1. system → messages[0] (role: "system")                            │
│  2. tool_result → ayrı role: "tool" mesajları                        │
│  3. tool_use.input (JSON) → function.arguments (string)              │
│  4. input_schema → parameters                                       │
│  5. Çoklu system mesajı → birleştir                                  │
│  6. stream: true → false (non-streaming istek)                       │
└──────────────────────────────┬──────────────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────────────┐
│  OpenAI-uyumlu Backend                                               │
│  POST /v1/chat/completions {"model":"...", "messages":[...]}        │
│                                                                     │
│  ← {"choices":[{"message":{"content":"...","tool_calls":[...]}}]}   │
└──────────────────────────────┬──────────────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────────────┐
│  DÖNÜŞÜM (OpenAI → Anthropic)                                       │
│                                                                     │
│  1. finish_reason → stop_reason mapping                              │
│  2. usage: prompt_tokens → input_tokens                             │
│  3. <think>...</think> → type: "thinking" content block             │
│  4. <tool_call> XML / JSON → type: "tool_use" content block         │
│  5. function.arguments (string) → tool_use.input (JSON object)       │
│  6. Tüm content block'lar SSE event'lerine bölünür                   │
└──────────────────────────────┬──────────────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────────────┐
│                         Claude Code Cevabı                          │
│  SSE: message_start → content_block_start/delta/stop → message_stop │
└─────────────────────────────────────────────────────────────────────┘
```
