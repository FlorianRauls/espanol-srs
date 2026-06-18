// llm.js — the ONLY module that knows about Azure AI Foundry.
// Everything else calls these functions; nothing else builds Foundry requests.
//
// Uses the OpenAI v1-compatible route: POST {azureEndpoint}chat/completions
// where azureEndpoint ends in /openai/v1/. The `model` field is the Foundry DEPLOYMENT
// name (settings.modelGenerate for cheap tasks, settings.modelFeedback for stronger tasks).

import { getSettings } from './db.js';

export class LLMNotConfiguredError extends Error {
  constructor() {
    super('Azure is not set up. Open Settings and fill in the endpoint, API key, and deployment names.');
    this.name = 'LLMNotConfiguredError';
  }
}

export async function isConfigured() {
  const s = await getSettings();
  return Boolean(s.azureEndpoint && s.azureApiKey && (s.modelGenerate || s.modelFeedback));
}

function normalizeEndpoint(endpoint) {
  // Tolerate a missing trailing slash; the route is appended after /openai/v1/.
  return endpoint.endsWith('/') ? endpoint : endpoint + '/';
}

// Low-level call. messages: [{role, content}]. modelKind: 'generate' | 'feedback'.
// Returns the assistant message text.
async function chat(messages, modelKind = 'generate') {
  const s = await getSettings();
  const deployment = modelKind === 'feedback'
    ? (s.modelFeedback || s.modelGenerate)
    : (s.modelGenerate || s.modelFeedback);

  if (!s.azureEndpoint || !s.azureApiKey || !deployment) {
    throw new LLMNotConfiguredError();
  }

  const url = normalizeEndpoint(s.azureEndpoint) + 'chat/completions';

  // SECURITY NOTE: the API key is read from in-browser IndexedDB and sent directly to
  // Foundry. This is acceptable ONLY because this app is run locally by a single user and
  // is never publicly hosted with the key embedded. If this page were ever deployed with a
  // baked-in key, a small server-side proxy would be required to hold the key instead.
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${s.azureApiKey}`,
      'Content-Type': 'application/json',
    },
    // Note: temperature is intentionally omitted. Some Foundry models (e.g. the newer
    // reasoning models) reject any non-default temperature with a 400, so we send none
    // and let the deployment use its default.
    body: JSON.stringify({
      model: deployment,
      messages,
    }),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Azure error ${res.status}: ${detail.slice(0, 300) || res.statusText}`);
  }
  const data = await res.json();
  const text = data?.choices?.[0]?.message?.content;
  if (typeof text !== 'string') throw new Error('Azure returned an unexpected response shape.');
  return text;
}

// Defensive JSON parse: strip markdown fences / stray prose, then parse the first JSON value.
function parseJSON(text) {
  let t = text.trim();
  // Strip ```json ... ``` or ``` ... ``` fences.
  t = t.replace(/^```(?:json)?\s*/i, '').replace(/```$/i, '').trim();
  try {
    return JSON.parse(t);
  } catch (_) {
    // Fall back to the first {...} or [...] block.
    const match = t.match(/[[{][\s\S]*[\]}]/);
    if (match) {
      try { return JSON.parse(match[0]); } catch (_) { /* fall through */ }
    }
    throw new Error('Could not parse the model output as JSON.');
  }
}

const JSON_RULE = 'Return STRICT JSON only. No markdown, no code fences, no commentary.';

// ---- Task 8: auto-fill a card from a Spanish word/sentence on the front ----
export async function autofillCard(front, { nativeLang = 'de', targetLang = 'es' } = {}) {
  const messages = [
    {
      role: 'system',
      content:
        `You help build Spanish (${targetLang}) flashcards for a native ${nativeLang} speaker. ` +
        `Given a Spanish word or sentence, produce its German translation and helpful fields. ` +
        `${JSON_RULE} Use this exact schema: ` +
        `{"back": string (German translation), "gender": "el"|"la"|null (only for nouns), ` +
        `"example": string|null (a short natural Spanish example sentence), ` +
        `"exampleTrans": string|null (German translation of the example), ` +
        `"notes": string|null (a brief grammar hint if useful), ` +
        `"type": "vocab"|"sentence"}.`,
    },
    { role: 'user', content: String(front) },
  ];
  return parseJSON(await chat(messages, 'generate'));
}

// ---- Task 9: split a pasted chunk of Spanish into candidate cards ----
export async function splitToCards(chunk, { nativeLang = 'de', targetLang = 'es' } = {}) {
  const messages = [
    {
      role: 'system',
      content:
        `You extract Spanish (${targetLang}) vocabulary and useful phrases worth learning from a ` +
        `pasted chat/text, for a native ${nativeLang} speaker. Skip trivial filler words. ` +
        `${JSON_RULE} Return an array of objects with schema: ` +
        `[{"front": string (Spanish), "back": string (German), "gender": "el"|"la"|null, ` +
        `"example": string|null, "exampleTrans": string|null, "type": "vocab"|"sentence"}]. ` +
        `Return at most 25 items.`,
    },
    { role: 'user', content: String(chunk) },
  ];
  const out = parseJSON(await chat(messages, 'generate'));
  return Array.isArray(out) ? out : (out.cards || []);
}

// ---- Task 10: assess the user's typed Spanish production ----
export async function assessProduction(prompt, userAnswer, { reference = '' } = {}) {
  const messages = [
    {
      role: 'system',
      content:
        `You are a friendly Spanish tutor for a native German speaker. The student was asked to ` +
        `say something in Spanish. Judge their answer, correct it, and explain errors briefly in German. ` +
        `${JSON_RULE} Schema: {"correct": boolean, "corrected": string (best natural Spanish), ` +
        `"feedback": string (brief German explanation of any errors, or praise if correct)}.`,
    },
    {
      role: 'user',
      content:
        `Prompt (German): ${prompt}\n` +
        (reference ? `Reference Spanish answer: ${reference}\n` : '') +
        `Student's Spanish answer: ${userAnswer}`,
    },
  ];
  return parseJSON(await chat(messages, 'feedback'));
}

// ---- Task 11: generate cloze and/or reverse-direction variants from a card ----
export async function generateVariants(card) {
  const messages = [
    {
      role: 'system',
      content:
        `You create study variants from a Spanish/German flashcard. ${JSON_RULE} ` +
        `Schema: {"cloze": {"front": string (a Spanish sentence with the target replaced by ___), ` +
        `"clozeAnswer": string (the hidden token), "back": string (full Spanish sentence)} | null, ` +
        `"reverse": {"front": string (German prompt), "back": string (Spanish answer)} | null}. ` +
        `Only include a cloze if a sensible fill-in-the-blank exists.`,
    },
    {
      role: 'user',
      content: `front (es): ${card.front}\nback (de): ${card.back}\nexample: ${card.example || ''}`,
    },
  ];
  return parseJSON(await chat(messages, 'generate'));
}

// ---- Task 13: rough CEFR orientation from a performance-weighted card sample ----
export async function estimateCEFR(sample) {
  const messages = [
    {
      role: 'system',
      content:
        `You give a DELIBERATELY ROUGH Spanish CEFR orientation (a range like "A2–B1"), not a precise ` +
        `score, from a sample of the learner's flashcards and their retention stats. Identify under- ` +
        `represented grammar areas (e.g. past tenses, subjunctive) to focus on. Answer in German. ` +
        `${JSON_RULE} Schema: {"range": string (e.g. "A2–B1"), "summary": string (2-3 sentences, German), ` +
        `"gaps": string[] (grammar/topic areas to focus on, German)}.`,
    },
    { role: 'user', content: JSON.stringify(sample) },
  ];
  return parseJSON(await chat(messages, 'feedback'));
}

// ---- Task 14: per-card grammar explanation ----
export async function explainGrammar(card) {
  const messages = [
    {
      role: 'system',
      content:
        `You are a concise Spanish grammar tutor for a native German speaker. Explain the grammar of ` +
        `the given card in 2-4 short sentences, in German (e.g. why subjunctive, ser vs estar, gender). ` +
        `Plain text, no JSON.`,
    },
    {
      role: 'user',
      content: `front (es): ${card.front}\nback (de): ${card.back}\nexample: ${card.example || ''}\nnotes: ${card.notes || ''}`,
    },
  ];
  return (await chat(messages, 'feedback')).trim();
}
