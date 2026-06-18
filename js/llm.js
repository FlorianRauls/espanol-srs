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

const JSON_RULE = 'Gib AUSSCHLIESSLICH valides JSON zurück. Kein Markdown, keine Code-Fences, keine Kommentare.';

// Gemeinsame Sprach-Anweisung: europäisches Spanisch aus Spanien (Kastilisch),
// korrekt, aber sehr umgangssprachlich und alltagstauglich.
const SPAIN =
  'Es geht ausschließlich um europäisches Spanisch aus Spanien (Kastilisch). ' +
  'Nutze die in Spanien übliche Wortwahl und Grammatik (z. B. die vosotros-Form, ' +
  '„coche", „móvil", „ordenador", „vale", „guay", „tío/tía", „flipar"), niemals ' +
  'lateinamerikanisches Spanisch (kein „carro", „celular", „ustedes" für Freunde). ' +
  'Das Spanisch soll grammatikalisch korrekt sein, aber gleichzeitig sehr ' +
  'umgangssprachlich und alltagstauglich, genau so, wie junge Leute in Spanien ' +
  'im echten Alltag wirklich sprechen. Steife Lehrbuchsätze vermeiden.';

// ---- Task 8: auto-fill a card from a Spanish word/sentence on the front ----
export async function autofillCard(front, { nativeLang = 'de', targetLang = 'es' } = {}) {
  const messages = [
    {
      role: 'system',
      content:
        `Du hilfst beim Erstellen von Spanisch-Lernkarten für einen deutschen Muttersprachler. ` +
        `${SPAIN} ` +
        `Zu einem spanischen Wort oder Satz lieferst du die deutsche Übersetzung und hilfreiche Felder. ` +
        `${JSON_RULE} Nutze exakt dieses Schema: ` +
        `{"back": string (deutsche Übersetzung), "gender": "el"|"la"|null (nur bei Substantiven), ` +
        `"example": string|null (kurzer, natürlicher spanischer Beispielsatz, wie man ihn in Spanien im Alltag wirklich sagt), ` +
        `"exampleTrans": string|null (deutsche Übersetzung des Beispiels), ` +
        `"notes": string|null (kurzer Hinweis, z. B. zur Grammatik, zum Register/umgangssprachlich oder zur typisch spanischen Verwendung), ` +
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
        `Du extrahierst aus einem eingefügten spanischen Text (z. B. einem Tandem-Chat) die ` +
        `lernenswerten Vokabeln und nützlichen Wendungen für einen deutschen Muttersprachler. ` +
        `${SPAIN} Lass triviale Füllwörter weg und bevorzuge alltagstaugliche, umgangssprachliche ` +
        `Ausdrücke, die man in Spanien wirklich braucht. ` +
        `${JSON_RULE} Gib ein Array von Objekten mit diesem Schema zurück: ` +
        `[{"front": string (Spanisch), "back": string (Deutsch), "gender": "el"|"la"|null, ` +
        `"example": string|null, "exampleTrans": string|null, "type": "vocab"|"sentence"}]. ` +
        `Höchstens 25 Einträge.`,
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
        `Du bist ein freundlicher, lockerer Spanisch-Tutor für einen deutschen Muttersprachler. ` +
        `${SPAIN} Der Lernende sollte etwas auf Spanisch sagen. Bewerte die Antwort, korrigiere sie ` +
        `zu natürlichem, alltagstauglichem Spanisch aus Spanien und erkläre etwaige Fehler kurz auf Deutsch. ` +
        `Wenn die Antwort zwar korrekt, aber sehr lehrbuchhaft ist, weise freundlich darauf hin, wie man es ` +
        `in Spanien lockerer sagen würde. ` +
        `${JSON_RULE} Schema: {"correct": boolean, "corrected": string (bestes natürliches Spanisch aus ` +
        `Spanien, so wie man es dort wirklich sagt), "feedback": string (kurze deutsche Erklärung der ` +
        `Fehler, oder Lob wenn korrekt)}.`,
    },
    {
      role: 'user',
      content:
        `Aufgabe (Deutsch): ${prompt}\n` +
        (reference ? `Referenz-Antwort (Spanisch): ${reference}\n` : '') +
        `Antwort des Lernenden (Spanisch): ${userAnswer}`,
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
        `Du erstellst Lernvarianten aus einer spanisch/deutschen Lernkarte. ${SPAIN} ` +
        `Die Beispiel-/Cloze-Sätze sollen alltagstauglich und umgangssprachlich sein. ${JSON_RULE} ` +
        `Schema: {"cloze": {"front": string (ein spanischer Satz, in dem das Zielwort durch ___ ersetzt ist), ` +
        `"clozeAnswer": string (das verdeckte Wort), "back": string (vollständiger spanischer Satz)} | null, ` +
        `"reverse": {"front": string (deutscher Prompt), "back": string (spanische Antwort)} | null}. ` +
        `Nimm eine Cloze nur auf, wenn ein sinnvoller Lückentext möglich ist.`,
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
        `Du gibst eine BEWUSST GROBE Einschätzung des Spanisch-Niveaus nach GER (eine Spanne wie "A2-B1"), ` +
        `keinen exakten Wert, basierend auf einer Stichprobe der Lernkarten und ihren Retention-Statistiken. ` +
        `${SPAIN} Berücksichtige dabei auch typisch spanische Alltagssprache. Benenne unterrepräsentierte ` +
        `Grammatikbereiche (z. B. Vergangenheitszeiten, Subjuntivo), auf die man sich konzentrieren sollte. ` +
        `Antworte auf Deutsch. ${JSON_RULE} Schema: {"range": string (z. B. "A2-B1"), ` +
        `"summary": string (2-3 Sätze, Deutsch), "gaps": string[] (Grammatik-/Themenbereiche zum Fokussieren, Deutsch)}.`,
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
        `Du bist ein knapper Spanisch-Grammatik-Tutor für einen deutschen Muttersprachler. ${SPAIN} ` +
        `Erkläre die Grammatik der Karte in 2-4 kurzen Sätzen auf Deutsch (z. B. warum Subjuntivo, ` +
        `ser vs. estar, Genus). Weise bei Bedarf kurz auf die umgangssprachliche oder typisch spanische ` +
        `Verwendung hin. Reiner Text, kein JSON.`,
    },
    {
      role: 'user',
      content: `front (es): ${card.front}\nback (de): ${card.back}\nexample: ${card.example || ''}\nnotes: ${card.notes || ''}`,
    },
  ];
  return (await chat(messages, 'feedback')).trim();
}
