// Reads token usage out of upstream responses as they stream past, without holding up the
// bytes going to the CLI. Both the Anthropic Messages API and the OpenAI Responses API report
// usage in-band: as SSE events when streaming, or a `usage` object on a plain JSON body.

const n = (value) => (Number.isFinite(value) ? value : 0);

/** Anthropic `usage` -> the normalised shape pricing.mjs bills. */
export function fromAnthropicUsage(usage = {}) {
  const created = n(usage.cache_creation_input_tokens);
  const split = usage.cache_creation;
  // The per-TTL split is newer than the total; with no split, everything is a 5-minute write.
  const oneHour = split ? n(split.ephemeral_1h_input_tokens) : 0;
  return {
    input: n(usage.input_tokens),
    cacheWrite5m: split ? n(split.ephemeral_5m_input_tokens) : created - oneHour,
    cacheWrite1h: oneHour,
    cacheRead: n(usage.cache_read_input_tokens),
    output: n(usage.output_tokens),
    ...(usage.speed ? { speed: usage.speed } : {}),
  };
}

/** OpenAI Responses `usage` -> the same shape. `input_tokens` there includes cached tokens. */
export function fromOpenAIUsage(usage = {}) {
  const cached = n(usage.input_tokens_details?.cached_tokens);
  return {
    input: Math.max(n(usage.input_tokens) - cached, 0),
    cacheWrite5m: 0,
    cacheWrite1h: 0,
    cacheRead: cached,
    output: n(usage.output_tokens),
  };
}

/**
 * Incremental usage reader. Feed it response chunks; `result()` returns `{model, usage}` once
 * the response has ended, or null if no usage was ever reported (an error body, a stream the
 * client abandoned). SSE is read line by line so a long stream is never buffered whole; a
 * plain JSON body is buffered, but those are bounded by `max_tokens` and are rare in practice.
 *
 * Anthropic streams split usage across events: `message_start` carries the input side and
 * `message_delta` the cumulative output (and, on newer API versions, refreshed input
 * counts), so later non-zero values win. OpenAI sends everything on `response.completed`.
 */
export function usageReader(provider) {
  let pending = "";
  let body = "";
  let sse = null;
  let model = null;
  let raw = null;

  const merge = (usage) => {
    if (!usage || typeof usage !== "object") return;
    raw ??= {};
    for (const [key, value] of Object.entries(usage)) {
      if (value == null) continue;
      if (typeof value === "number" && value === 0 && raw[key]) continue;
      raw[key] = value;
    }
  };

  const onEvent = (data) => {
    if (provider === "anthropic") {
      if (data.type === "message_start") {
        model = data.message?.model ?? model;
        merge(data.message?.usage);
      } else if (data.type === "message_delta") {
        merge(data.usage);
      }
    } else if (data.type === "response.completed" || data.type === "response.done") {
      model = data.response?.model ?? model;
      merge(data.response?.usage);
    }
  };

  const onLine = (line) => {
    if (!line.startsWith("data:")) return;
    const payload = line.slice(5).trim();
    // Cheap pre-filter: only events that can carry usage are worth parsing.
    if (!payload.includes('"usage"') && !payload.includes('"message_start"')) return;
    try {
      onEvent(JSON.parse(payload));
    } catch {
      // A malformed event never breaks the stream; it just isn't counted.
    }
  };

  return {
    write(chunk) {
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      if (sse === null) {
        const head = (pending + text).trimStart();
        if (!head) return;
        sse = !head.startsWith("{");
      }
      if (!sse) {
        body += text;
        return;
      }
      pending += text;
      let newline;
      while ((newline = pending.indexOf("\n")) >= 0) {
        onLine(pending.slice(0, newline).replace(/\r$/, ""));
        pending = pending.slice(newline + 1);
      }
    },
    result() {
      if (sse === false) {
        try {
          const json = JSON.parse(body);
          model = json.model ?? model;
          merge(json.usage);
        } catch {
          return null;
        }
      } else if (pending) {
        onLine(pending);
        pending = "";
      }
      if (!raw) return null;
      return {
        model,
        usage: provider === "anthropic" ? fromAnthropicUsage(raw) : fromOpenAIUsage(raw),
      };
    },
  };
}
