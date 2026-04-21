import { loadConfig, saveConfig } from "./config.js";

// ─── Provider → base URL ─────────────────────────────────────────────
export const PROVIDER_ENDPOINTS = {
  openai:    "https://api.openai.com/v1",
  deepseek:  "https://api.deepseek.com/v1",
  groq:      "https://api.groq.com/openai/v1",
  moonshot:  "https://api.moonshot.cn/v1",
  zhipu:     "https://open.bigmodel.cn/api/paas/v4",
  mistral:   "https://api.mistral.ai/v1",
  together:  "https://api.together.xyz/v1",
  xai:       "https://api.x.ai/v1",
  cursor:    "https://api.cursor.sh/v1",
};

// ─── Provider colors (for auto-generated agent entries) ──────────────
export const PROVIDER_COLORS = {
  openai:    "#74AA9C",
  deepseek:  "#4D9BF0",
  groq:      "#F55036",
  moonshot:  "#FF6B35",
  zhipu:     "#6C5CE7",
  mistral:   "#FF7000",
  together:  "#00B4D8",
  xai:       "#1DA1F2",
  cursor:    "#2E2E2E",
};

// ─── Infer provider from model ID ────────────────────────────────────
export function inferProvider(modelId) {
  // Explicit: "deepseek/deepseek-chat" → "deepseek"
  if (modelId.includes("/")) return modelId.split("/")[0].toLowerCase();
  const lower = modelId.toLowerCase();
  if (lower.startsWith("gpt-") || lower.startsWith("o1") || lower.startsWith("o3") || lower.startsWith("o4")) return "openai";
  if (lower.startsWith("deepseek")) return "deepseek";
  if (lower.startsWith("llama") || lower.startsWith("mixtral") || lower.startsWith("gemma") || lower.startsWith("qwen")) return "groq";
  if (lower.startsWith("moonshot") || lower.startsWith("kimi")) return "moonshot";
  if (lower.startsWith("glm")) return "zhipu";
  if (lower.startsWith("mistral") || lower.startsWith("codestral")) return "mistral";
  if (lower.startsWith("grok")) return "xai";
  return "openai";
}

// Resolve "provider/model-name" or bare model-name → { provider, model }
export function resolveModel(modelId) {
  if (modelId.includes("/")) {
    const idx = modelId.indexOf("/");
    return { provider: modelId.slice(0, idx), model: modelId.slice(idx + 1) };
  }
  return { provider: inferProvider(modelId), model: modelId };
}

// ─── API key management ──────────────────────────────────────────────
export function getApiKey(provider) {
  const cfg = loadConfig();
  return cfg.api_keys?.[provider] || null;
}

export function setApiKey(provider, key) {
  const cfg = loadConfig();
  cfg.api_keys = cfg.api_keys || {};
  cfg.api_keys[provider] = key;
  saveConfig(cfg);
}

export function listApiKeys() {
  const cfg = loadConfig();
  return Object.keys(cfg.api_keys || {});
}

// ─── Custom endpoint management ──────────────────────────────────────
export function getCustomEndpoint(provider) {
  const cfg = loadConfig();
  return cfg.custom_endpoints?.[provider] || null;
}

export function setCustomEndpoint(provider, endpoint) {
  const cfg = loadConfig();
  cfg.custom_endpoints = cfg.custom_endpoints || {};
  cfg.custom_endpoints[provider] = endpoint;
  saveConfig(cfg);
}

// ─── Core API call (OpenAI-compatible) ───────────────────────────────
export async function runModel(modelId, prompt) {
  const { provider, model } = resolveModel(modelId);

  const apiKey = getApiKey(provider);
  if (!apiKey) {
    throw new Error(`No API key for "${provider}". Run: /agents set-key ${provider} <your-key>`);
  }

  const base = getCustomEndpoint(provider) || PROVIDER_ENDPOINTS[provider] || PROVIDER_ENDPOINTS.openai;

  const res = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: prompt }],
      stream: false,
    }),
    signal: AbortSignal.timeout(120_000),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new Error(`API error ${res.status}: ${text.slice(0, 300)}`);
  }

  const data = await res.json();
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error("Empty response from API");
  return { text: content.trim(), usage: data.usage || null };
}
