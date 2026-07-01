// ═══════════════════════════════════════════════════════════════
// Dual AI Engine — Gemini (free) + Claude (optional paid)
// Switching between engines is a single env var: AI_ENGINE
// ═══════════════════════════════════════════════════════════════

const RETRY_DELAYS = [2000, 5000, 15000];

// ─── Unified Interface ───────────────────────────────────────
async function callAI(prompt, opts = {}) {
  const engine = opts.engine || process.env.AI_ENGINE || 'gemini';
  if (engine === 'claude') return callClaude(prompt, opts);
  return callGemini(prompt, opts);
}

async function callAIJson(prompt, opts = {}) {
  const { text, usage } = await callAI(prompt, opts);
  const parsed = parseJsonSafe(text);
  return { result: parsed, usage };
}

// ─── Gemini (Free Tier) ──────────────────────────────────────
async function callGemini(prompt, opts = {}) {
  const apiKey = process.env.GEMINI_API_KEY;
  const model = opts.model || process.env.GEMINI_MODEL || 'gemini-2.5-flash';
  if (!apiKey) throw new Error('MISSING_GEMINI_API_KEY');

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

  for (let attempt = 0; attempt <= 3; attempt++) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.2 },
      }),
    });

    const status = res.status;
    const body = await res.text();

    if (status === 429 || status === 503) {
      const delay = RETRY_DELAYS[attempt] || 15000;
      console.warn(`[Gemini] ${status} — retry in ${delay}ms`);
      await sleep(delay);
      continue;
    }

    if (status < 200 || status >= 300) throw new Error(`GEMINI_HTTP_${status}: ${body.slice(0, 400)}`);

    const data = JSON.parse(body);
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
    if (!text) throw new Error('GEMINI_EMPTY_RESPONSE');

    return { text, usage: { inputTokens: 0, outputTokens: 0, model, engine: 'gemini' } };
  }
  throw new Error('GEMINI_MAX_RETRIES');
}

// ─── Claude (Paid / Free Credits) ────────────────────────────
async function callClaude(prompt, opts = {}) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  const model = opts.model || process.env.CLAUDE_MODEL || 'claude-sonnet-4-5-20241022';
  if (!apiKey) throw new Error('MISSING_ANTHROPIC_API_KEY — set AI_ENGINE=gemini for free tier');

  for (let attempt = 0; attempt <= 3; attempt++) {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model,
        max_tokens: opts.maxTokens || 2000,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.2,
      }),
    });

    const status = res.status;
    const body = await res.text();

    if (status === 429 || status === 503 || status === 529) {
      const delay = RETRY_DELAYS[attempt] || 15000;
      console.warn(`[Claude] ${status} — retry in ${delay}ms`);
      await sleep(delay);
      continue;
    }

    if (status < 200 || status >= 300) throw new Error(`CLAUDE_HTTP_${status}: ${body.slice(0, 400)}`);

    const data = JSON.parse(body);
    const text = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n');
    if (!text) throw new Error('CLAUDE_EMPTY_RESPONSE');

    const usage = data.usage || {};
    return {
      text,
      usage: {
        inputTokens: usage.input_tokens || 0,
        outputTokens: usage.output_tokens || 0,
        model, engine: 'claude',
      },
    };
  }
  throw new Error('CLAUDE_MAX_RETRIES');
}

// ─── JSON Parser with Recovery ───────────────────────────────
function parseJsonSafe(text) {
  const raw = String(text || '').replace(/```json|```/g, '').trim();
  try { return JSON.parse(raw); } catch (e) {}
  const s = raw.indexOf('{'), e = raw.lastIndexOf('}');
  if (s >= 0 && e > s) { try { return JSON.parse(raw.slice(s, e + 1)); } catch (e2) {} }
  throw new Error('JSON_PARSE_ERROR: ' + raw.slice(0, 300));
}

function estimateCost(usage) {
  if (usage.engine === 'gemini') return 0;
  const input = (usage.inputTokens / 1e6) * 3;
  const output = (usage.outputTokens / 1e6) * 15;
  return Math.round((input + output) * 10000) / 10000;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }


// ─── Conversation mode (multi-turn) — for the live Trainer prospect ──
// systemPrompt: the prospect persona (static, cached). messages: [{role:'user'|'assistant', content}]
async function callConversation(systemPrompt, messages, opts = {}) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  const model = opts.model || process.env.CLAUDE_MODEL || 'claude-sonnet-4-5-20241022';
  if (!apiKey) throw new Error('MISSING_ANTHROPIC_API_KEY');

  for (let attempt = 0; attempt <= 3; attempt++) {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model,
        max_tokens: opts.maxTokens || 400,
        // Prompt caching on the system prompt — ~90% savings on the static portion
        system: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
        messages,
        temperature: opts.temperature ?? 0.8,  // higher temp = more natural, varied prospect
      }),
    });
    const status = res.status;
    const body = await res.text();
    if (status === 429 || status === 503 || status === 529) {
      const delay = RETRY_DELAYS[attempt] || 15000;
      console.warn(`[Prospect] ${status} — retry in ${delay}ms`);
      await sleep(delay);
      continue;
    }
    if (status < 200 || status >= 300) throw new Error(`CLAUDE_HTTP_${status}: ${body.slice(0, 400)}`);
    const data = JSON.parse(body);
    const text = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n');
    const usage = data.usage || {};
    return { text, usage: { inputTokens: usage.input_tokens || 0, outputTokens: usage.output_tokens || 0, model, engine: 'claude' } };
  }
  throw new Error('CLAUDE_MAX_RETRIES');
}

module.exports = { callAI, callAIJson, callConversation, estimateCost, parseJsonSafe };
