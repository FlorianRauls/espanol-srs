// app.js — entry point: router, view rendering, and wiring of all modules.
// Opens directly on the review queue (spec §8): open → review → done.

import * as db from './db.js';
import { applyRating, buildQueue, freshSchedulingFields } from './scheduler.js';
import { speak, isSpeechSupported } from './speech.js';
import * as llm from './llm.js';
import * as stats from './stats.js';
import * as backup from './exportImport.js';

// ---------- tiny helpers ----------
const $ = sel => document.querySelector(sel);
const app = $('#app');

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

let _toastTimer;
function toast(msg, isErr = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'toast show' + (isErr ? ' err' : '');
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => { t.className = 'toast'; }, isErr ? 4200 : 2400);
}

function newCard(partial = {}) {
  return {
    id: crypto.randomUUID(),
    type: 'vocab',
    front: '', back: '', gender: null,
    example: null, exampleTrans: null, notes: null,
    tags: [], direction: 'es-de', clozeAnswer: null,
    createdAt: Date.now(),
    ...freshSchedulingFields(),
    ...partial,
  };
}

function parseTags(str) {
  return (str || '').split(/[,\s]+/).map(s => s.trim()).filter(Boolean);
}

// ---------- state / router ----------
const state = { view: 'review', params: {} };

function setView(view, params = {}) {
  state.view = view;
  state.params = params;
  window.scrollTo(0, 0);
  render();
}
window.__setView = setView; // convenience for inline handlers

function syncTabs() {
  document.querySelectorAll('.tab').forEach(b => {
    const v = b.dataset.view;
    const active = v === state.view ||
      (v === 'review' && state.view === 'review') ||
      (v === 'edit' && state.view === 'edit') ||
      (v === 'more' && ['more', 'settings', 'tandem', 'produce', 'cefr', 'backup'].includes(state.view));
    b.classList.toggle('active', active);
  });
}

async function render() {
  syncTabs();
  try {
    const fn = VIEWS[state.view] || VIEWS.review;
    await fn();
  } catch (e) {
    app.innerHTML = `<div class="card-surface"><p class="inline-error">Etwas ist schiefgelaufen: ${esc(e.message)}</p></div>`;
  }
}

const VIEWS = {};

// ---------- topbar meta ----------
async function updateTopbarMeta() {
  try {
    const [cards, logs, settings] = await Promise.all([db.getAllCards(), db.getAllReviewLogs(), db.getSettings()]);
    const q = buildQueue(cards, logs, settings);
    $('#topbar-meta').textContent = `${q.dueCount} fällig · ${q.newCount} neu`;
  } catch { /* ignore */ }
}

// ============================================================
// REVIEW
// ============================================================
const session = { card: null, revealed: false, shownAt: 0 };

VIEWS.review = async function reviewView() {
  const [cards, logs, settings] = await Promise.all([db.getAllCards(), db.getAllReviewLogs(), db.getSettings()]);

  if (cards.length === 0) {
    app.innerHTML = `
      <div class="empty-state fade-in">
        <div class="big">¡Hola! 👋</div>
        <p class="muted">Noch keine Karten. Leg deine erste an oder importiere ein Backup.</p>
        <div class="btn-row" style="justify-content:center;margin-top:18px">
          <button class="btn btn-primary" onclick="__setView('edit')">Karte hinzufügen</button>
          <button class="btn" onclick="__setView('tandem')">Tandem-Text einfügen</button>
        </div>
      </div>`;
    updateTopbarMeta();
    return;
  }

  const q = buildQueue(cards, logs, settings);
  // Pick next card: due (learning/review) first, then new within the daily limit.
  session.card = q.due[0] || q.new[0] || null;
  session.revealed = false;
  session.shownAt = Date.now();

  if (!session.card) {
    app.innerHTML = `
      <div class="empty-state fade-in">
        <div class="big">Alles erledigt ✦</div>
        <p class="muted">Keine fälligen Karten gerade. Komm später wieder — oder üben:</p>
        <div class="btn-row" style="justify-content:center;margin-top:18px">
          <button class="btn" onclick="__setView('produce')">Aktiv üben</button>
          <button class="btn" onclick="__setView('stats')">Statistik</button>
        </div>
      </div>`;
    updateTopbarMeta();
    return;
  }

  app.innerHTML = `
    <div class="review-counts fade-in">
      <div class="count-pill"><span class="n">${q.dueCount}</span><span class="l">Fällig</span></div>
      <div class="count-pill new"><span class="n">${q.newCount}</span><span class="l">Neu</span></div>
    </div>
    <div id="flash" class="card-surface flashcard fade-in"></div>
    <div id="rating" style="display:none"></div>`;

  renderFlash();
  $('#flash').addEventListener('click', e => {
    if (e.target.closest('.speaker') || e.target.closest('.link')) return;
    if (!session.revealed) reveal();
  });
};

function promptView(card) {
  if (card.type === 'cloze') {
    return {
      prompt: card.front, sub: 'Lücke füllen',
      answer: card.clozeAnswer || card.back, gender: null,
      speakText: card.back || card.front, extra: card.back && card.back !== card.front ? card.back : '',
    };
  }
  let dir = card.direction || 'es-de';
  if (dir === 'both') dir = Math.random() < 0.5 ? 'es-de' : 'de-es';
  if (dir === 'de-es') {
    return { prompt: card.back, sub: 'auf Spanisch', answer: card.front, gender: card.gender, speakText: card.front, extra: '' };
  }
  return { prompt: card.front, sub: 'auf Deutsch', answer: card.back, gender: card.gender, speakText: card.front, extra: '' };
}

function renderFlash() {
  const c = session.card;
  const pv = promptView(c);
  const speakBtn = isSpeechSupported()
    ? `<button class="icon-btn speaker" id="speakBtn" aria-label="Vorlesen">🔊</button>` : '';
  const tags = (c.tags && c.tags.length)
    ? `<div class="card-tags">${c.tags.map(t => `<span class="tag-chip">${esc(t)}</span>`).join('')}</div>` : '';

  let body;
  if (!session.revealed) {
    body = `
      <span class="type-tag">${esc(c.type)}</span>${speakBtn}
      <div class="face-prompt">${esc(pv.prompt)}</div>
      <div class="face-sub">${esc(pv.sub)}</div>
      <div class="tap-hint">Tippen zum Aufdecken</div>`;
  } else {
    body = `
      <span class="type-tag">${esc(c.type)}</span>${speakBtn}
      <div class="face-prompt">${esc(pv.prompt)}</div>
      <div class="divider"></div>
      <div class="face-answer">${esc(pv.answer)}${pv.gender ? ` <span class="face-gender">(${esc(pv.gender)})</span>` : ''}</div>
      ${pv.extra ? `<div class="face-sub">${esc(pv.extra)}</div>` : ''}
      ${c.example ? `<div class="face-example">„${esc(c.example)}"${c.exampleTrans ? `<br><span class="tr">${esc(c.exampleTrans)}</span>` : ''}</div>` : ''}
      ${c.notes ? `<div class="face-notes">${esc(c.notes)}</div>` : ''}
      ${tags}
      <div id="grammarOut" class="face-notes"></div>
      <span class="link" id="explainBtn">Grammatik erklären</span>`;
  }
  $('#flash').innerHTML = body;

  const sb = $('#speakBtn');
  if (sb) sb.addEventListener('click', () => speak(pv.speakText));

  const eb = $('#explainBtn');
  if (eb) eb.addEventListener('click', () => explainGrammar(c));

  const rating = $('#rating');
  if (session.revealed) {
    rating.style.display = '';
    rating.className = 'rating-row fade-in';
    rating.innerHTML = `
      <button class="rate again" data-r="1">Nochmal<small>&lt;1 min</small></button>
      <button class="rate hard" data-r="2">Schwer<small></small></button>
      <button class="rate good" data-r="3">Gut<small></small></button>
      <button class="rate easy" data-r="4">Leicht<small></small></button>`;
    rating.querySelectorAll('.rate').forEach(b =>
      b.addEventListener('click', () => rate(parseInt(b.dataset.r, 10))));
  } else {
    rating.style.display = 'none';
  }
}

function reveal() {
  session.revealed = true;
  renderFlash();
}

async function explainGrammar(card) {
  if (!(await llm.isConfigured())) { toast('Azure in den Einstellungen einrichten', true); return; }
  const out = $('#grammarOut');
  out.innerHTML = '<span class="spinner"></span>';
  try {
    out.textContent = await llm.explainGrammar(card);
  } catch (e) {
    out.innerHTML = `<span class="inline-error">${esc(e.message)}</span>`;
  }
}

async function rate(rating) {
  const c = session.card;
  const now = Date.now();
  const updated = applyRating(c, rating, now);
  try {
    await db.putCard(updated);
    await db.addReviewLog({
      id: crypto.randomUUID(),
      cardId: c.id,
      ts: now,
      rating,
      elapsedMs: Math.max(0, now - session.shownAt),
    });
  } catch (e) {
    toast('Speichern fehlgeschlagen: ' + e.message, true);
    return;
  }
  render(); // re-fetch and show the next card
}

// ============================================================
// EDIT / CREATE
// ============================================================
VIEWS.edit = async function editView() {
  const editing = Boolean(state.params.id);
  const card = editing ? await db.getCard(state.params.id) : newCard();
  if (editing && !card) { toast('Karte nicht gefunden', true); setView('cards'); return; }

  const configured = await llm.isConfigured();
  const g = card.gender || '';

  app.innerHTML = `
    <h1 class="view-title">${editing ? 'Karte bearbeiten' : 'Neue Karte'}</h1>
    ${!configured ? '' : ''}
    <div class="card-surface stack">
      <div class="field">
        <label>Typ</label>
        <select class="input" id="f-type">
          <option value="vocab"${card.type === 'vocab' ? ' selected' : ''}>Vokabel</option>
          <option value="sentence"${card.type === 'sentence' ? ' selected' : ''}>Satz</option>
          <option value="cloze"${card.type === 'cloze' ? ' selected' : ''}>Lückentext (Cloze)</option>
        </select>
      </div>
      <div class="field">
        <label>Vorderseite${card.type === 'cloze' ? ' (Satz mit ___)' : ' (Spanisch)'}</label>
        <textarea class="textarea" id="f-front" placeholder="z. B. la cuenta">${esc(card.front)}</textarea>
        ${!editing ? `<button class="btn btn-sm" id="autofillBtn" style="margin-top:8px">✨ Mit KI ausfüllen</button>
          ${!configured ? '<span class="help">KI braucht Azure-Einrichtung (Einstellungen).</span>' : ''}` : ''}
      </div>
      <div class="field cloze-only" style="${card.type === 'cloze' ? '' : 'display:none'}">
        <label>Versteckte Lösung (Cloze)</label>
        <input class="input" id="f-cloze" value="${esc(card.clozeAnswer)}" placeholder="das verdeckte Wort" />
      </div>
      <div class="field">
        <label>Rückseite (Deutsch / Antwort)</label>
        <textarea class="textarea" id="f-back" placeholder="z. B. die Rechnung">${esc(card.back)}</textarea>
      </div>
      <div class="row-2">
        <div class="field">
          <label>Artikel</label>
          <select class="input" id="f-gender">
            <option value=""${g === '' ? ' selected' : ''}>—</option>
            <option value="el"${g === 'el' ? ' selected' : ''}>el</option>
            <option value="la"${g === 'la' ? ' selected' : ''}>la</option>
          </select>
        </div>
        <div class="field">
          <label>Richtung</label>
          <select class="input" id="f-dir">
            <option value="es-de"${card.direction === 'es-de' ? ' selected' : ''}>ES → DE</option>
            <option value="de-es"${card.direction === 'de-es' ? ' selected' : ''}>DE → ES</option>
            <option value="both"${card.direction === 'both' ? ' selected' : ''}>Beide</option>
          </select>
        </div>
      </div>
      <div class="field">
        <label>Beispielsatz (Spanisch)</label>
        <input class="input" id="f-example" value="${esc(card.example)}" />
      </div>
      <div class="field">
        <label>Beispiel-Übersetzung</label>
        <input class="input" id="f-exampleTrans" value="${esc(card.exampleTrans)}" />
      </div>
      <div class="field">
        <label>Notizen / Grammatik-Hinweis</label>
        <textarea class="textarea" id="f-notes">${esc(card.notes)}</textarea>
      </div>
      <div class="field">
        <label>Tags (mit Komma/Leerzeichen getrennt)</label>
        <input class="input" id="f-tags" value="${esc((card.tags || []).join(' '))}" placeholder="tandem-maria reise" />
      </div>
      <div id="editMsg"></div>
      <button class="btn btn-primary btn-block" id="saveBtn">${editing ? 'Speichern' : 'Karte anlegen'}</button>
      ${editing ? `
        <div class="btn-row" style="margin-top:6px">
          <button class="btn btn-sm" id="variantsBtn">✨ Varianten erzeugen</button>
          <button class="btn btn-sm btn-ghost" id="deleteBtn" style="color:var(--again)">Löschen</button>
        </div>` : ''}
    </div>`;

  const typeSel = $('#f-type');
  typeSel.addEventListener('change', () => {
    document.querySelector('.cloze-only').style.display = typeSel.value === 'cloze' ? '' : 'none';
  });

  $('#saveBtn').addEventListener('click', () => saveCard(card, editing));

  const af = $('#autofillBtn');
  if (af) af.addEventListener('click', () => autofill());

  const vb = $('#variantsBtn');
  if (vb) vb.addEventListener('click', () => makeVariants(card));

  const dbn = $('#deleteBtn');
  if (dbn) dbn.addEventListener('click', async () => {
    if (!confirm('Diese Karte wirklich löschen?')) return;
    await db.deleteCard(card.id);
    toast('Karte gelöscht');
    setView('cards');
  });
};

function readForm() {
  return {
    type: $('#f-type').value,
    front: $('#f-front').value.trim(),
    back: $('#f-back').value.trim(),
    gender: $('#f-gender').value || null,
    direction: $('#f-dir').value,
    example: $('#f-example').value.trim() || null,
    exampleTrans: $('#f-exampleTrans').value.trim() || null,
    notes: $('#f-notes').value.trim() || null,
    tags: parseTags($('#f-tags').value),
    clozeAnswer: ($('#f-cloze')?.value.trim()) || null,
  };
}

async function saveCard(card, editing) {
  const data = readForm();
  if (!data.front) { $('#editMsg').innerHTML = '<p class="inline-error">Vorderseite darf nicht leer sein.</p>'; return; }
  const merged = { ...card, ...data };
  await db.putCard(merged);
  toast(editing ? 'Gespeichert ✓' : 'Karte angelegt ✓');
  if (editing) setView('cards'); else setView('edit'); // fresh blank form for rapid entry
}

async function autofill() {
  const front = $('#f-front').value.trim();
  if (!front) { toast('Erst die Vorderseite eingeben', true); return; }
  const btn = $('#autofillBtn');
  const old = btn.innerHTML;
  btn.innerHTML = '<span class="spinner"></span> KI denkt …';
  btn.disabled = true;
  try {
    const settings = await db.getSettings();
    const r = await llm.autofillCard(front, { nativeLang: settings.nativeLang, targetLang: settings.targetLang });
    if (r.back != null) $('#f-back').value = r.back;
    if (r.gender) { $('#f-gender').value = ['el', 'la'].includes(r.gender) ? r.gender : ''; }
    if (r.example != null) $('#f-example').value = r.example || '';
    if (r.exampleTrans != null) $('#f-exampleTrans').value = r.exampleTrans || '';
    if (r.notes != null && r.notes) $('#f-notes').value = r.notes;
    if (r.type && ['vocab', 'sentence'].includes(r.type)) {
      $('#f-type').value = r.type;
    }
    $('#editMsg').innerHTML = '<p class="inline-ok">KI-Vorschlag eingefügt — bitte prüfen & korrigieren.</p>';
  } catch (e) {
    $('#editMsg').innerHTML = `<p class="inline-error">${esc(e.message)}</p>`;
  } finally {
    btn.innerHTML = old;
    btn.disabled = false;
  }
}

async function makeVariants(card) {
  if (!(await llm.isConfigured())) { toast('Azure in den Einstellungen einrichten', true); return; }
  const data = readForm();
  const base = { ...card, ...data };
  const btn = $('#variantsBtn');
  const old = btn.innerHTML;
  btn.innerHTML = '<span class="spinner"></span>';
  btn.disabled = true;
  try {
    const v = await llm.generateVariants(base);
    const created = [];
    if (v.cloze && v.cloze.front) {
      created.push(newCard({
        type: 'cloze', front: v.cloze.front, back: v.cloze.back || base.front,
        clozeAnswer: v.cloze.clozeAnswer || null, tags: base.tags, direction: 'es-de',
      }));
    }
    if (v.reverse && v.reverse.front) {
      created.push(newCard({
        type: base.type === 'cloze' ? 'vocab' : base.type,
        front: v.reverse.back || base.front, back: v.reverse.front || base.back,
        gender: base.gender, tags: base.tags, direction: 'de-es',
      }));
    }
    if (!created.length) { toast('Keine sinnvollen Varianten gefunden'); return; }
    await db.putCards(created);
    toast(`${created.length} Variante(n) angelegt ✓`);
  } catch (e) {
    $('#editMsg').innerHTML = `<p class="inline-error">${esc(e.message)}</p>`;
  } finally {
    btn.innerHTML = old;
    btn.disabled = false;
  }
}

// ============================================================
// CARDS (browse / filter by tag)
// ============================================================
VIEWS.cards = async function cardsView() {
  const cards = await db.getAllCards();
  const allTags = [...new Set(cards.flatMap(c => c.tags || []))].sort();
  const activeTag = state.params.tag || null;
  const filtered = activeTag ? cards.filter(c => (c.tags || []).includes(activeTag)) : cards;
  filtered.sort((a, b) => b.createdAt - a.createdAt);

  const chips = `
    <div class="chip-row">
      <button class="chip ${!activeTag ? 'active' : ''}" data-tag="">Alle (${cards.length})</button>
      ${allTags.map(t => `<button class="chip ${activeTag === t ? 'active' : ''}" data-tag="${esc(t)}">${esc(t)}</button>`).join('')}
    </div>`;

  app.innerHTML = `
    <h1 class="view-title">Karten</h1>
    ${allTags.length ? chips : ''}
    ${filtered.length === 0
      ? '<p class="muted">Keine Karten in dieser Ansicht.</p>'
      : `<div class="list">${filtered.map(c => `
        <div class="list-item" data-id="${c.id}">
          <div class="li-main">
            <div class="li-front">${esc(c.type === 'cloze' ? c.front : (c.front || '—'))}</div>
            <div class="li-back">${esc(c.back || '')}</div>
          </div>
          <div class="li-state">${esc(c.state)}</div>
        </div>`).join('')}</div>`}`;

  document.querySelectorAll('.chip').forEach(ch =>
    ch.addEventListener('click', () => setView('cards', ch.dataset.tag ? { tag: ch.dataset.tag } : {})));
  document.querySelectorAll('.list-item').forEach(li =>
    li.addEventListener('click', () => setView('edit', { id: li.dataset.id })));
};

// ============================================================
// TANDEM paste → card candidates
// ============================================================
VIEWS.tandem = async function tandemView() {
  const configured = await llm.isConfigured();
  app.innerHTML = `
    <h1 class="view-title">Tandem-Import</h1>
    ${!configured ? `<div class="banner">Diese Funktion braucht KI. <span class="link" onclick="__setView('settings')">Azure einrichten →</span></div>` : ''}
    <div class="card-surface stack">
      <p class="muted">Füge spanischen Text (z. B. aus dem Tandem-Chat) ein. Die KI schlägt lernenswerte Karten vor.</p>
      <textarea class="textarea" id="tandem-in" style="min-height:140px" placeholder="Pega aquí tu texto en español…"></textarea>
      <button class="btn btn-primary btn-block" id="splitBtn"${configured ? '' : ' disabled'}>Karten vorschlagen</button>
      <div id="tandem-msg"></div>
    </div>
    <div id="candidates"></div>`;

  $('#splitBtn').addEventListener('click', async () => {
    const chunk = $('#tandem-in').value.trim();
    if (!chunk) { toast('Erst Text einfügen', true); return; }
    const btn = $('#splitBtn');
    btn.innerHTML = '<span class="spinner"></span> Analysiere …';
    btn.disabled = true;
    try {
      const settings = await db.getSettings();
      const cands = await llm.splitToCards(chunk, { nativeLang: settings.nativeLang, targetLang: settings.targetLang });
      renderCandidates(cands);
    } catch (e) {
      $('#tandem-msg').innerHTML = `<p class="inline-error">${esc(e.message)}</p>`;
    } finally {
      btn.innerHTML = 'Karten vorschlagen';
      btn.disabled = false;
    }
  });
};

function renderCandidates(cands) {
  if (!cands || !cands.length) { $('#candidates').innerHTML = '<p class="muted">Keine Vorschläge gefunden.</p>'; return; }
  window.__cands = cands;
  $('#candidates').innerHTML = `
    <h2 class="section-title">Vorschläge — auswählen & speichern</h2>
    <div class="field"><input class="input" id="cand-tags" placeholder="Tags für alle (z. B. tandem)" value="tandem" /></div>
    <div class="list">
      ${cands.map((c, i) => `
        <label class="list-item checkbox-item">
          <input type="checkbox" data-i="${i}" checked />
          <div class="li-main">
            <div class="li-front">${esc(c.front || '')}${c.gender ? ` <span class="face-gender">(${esc(c.gender)})</span>` : ''}</div>
            <div class="li-back">${esc(c.back || '')}</div>
            ${c.example ? `<div class="li-back">„${esc(c.example)}"</div>` : ''}
          </div>
        </label>`).join('')}
    </div>
    <button class="btn btn-primary btn-block" id="addCandBtn" style="margin-top:14px">Ausgewählte hinzufügen</button>`;

  $('#addCandBtn').addEventListener('click', async () => {
    const tags = parseTags($('#cand-tags').value);
    const chosen = [...document.querySelectorAll('#candidates input[type=checkbox]:checked')]
      .map(cb => window.__cands[parseInt(cb.dataset.i, 10)]);
    if (!chosen.length) { toast('Nichts ausgewählt', true); return; }
    const cards = chosen.map(c => newCard({
      type: ['vocab', 'sentence'].includes(c.type) ? c.type : 'vocab',
      front: c.front || '', back: c.back || '',
      gender: ['el', 'la'].includes(c.gender) ? c.gender : null,
      example: c.example || null, exampleTrans: c.exampleTrans || null,
      tags,
    })).filter(c => c.front);
    await db.putCards(cards);
    toast(`${cards.length} Karten hinzugefügt ✓`);
    setView('cards');
  });
}

// ============================================================
// ACTIVE PRODUCTION (type the Spanish; LLM corrects)
// ============================================================
const produce = { card: null };

VIEWS.produce = async function produceView() {
  const configured = await llm.isConfigured();
  const cards = await db.getAllCards();
  const usable = cards.filter(c => c.back && c.front && c.type !== 'cloze');

  if (!usable.length) {
    app.innerHTML = `<h1 class="view-title">Aktiv üben</h1><p class="muted">Noch keine geeigneten Karten.</p>`;
    return;
  }
  // Prefer due/seen cards, else random.
  const now = Date.now();
  const pool = usable.filter(c => c.due <= now);
  const from = pool.length ? pool : usable;
  produce.card = from[Math.floor(Math.random() * from.length)];
  const c = produce.card;

  app.innerHTML = `
    <h1 class="view-title">Aktiv üben</h1>
    ${!configured ? `<div class="banner">Braucht KI zur Korrektur. <span class="link" onclick="__setView('settings')">Azure einrichten →</span></div>` : ''}
    <div class="card-surface stack fade-in">
      <div class="muted">Sag das auf Spanisch:</div>
      <div class="face-prompt" style="font-size:26px">${esc(c.back)}</div>
      <textarea class="textarea" id="prod-in" placeholder="Tu respuesta en español…"${configured ? '' : ' disabled'}></textarea>
      <button class="btn btn-primary btn-block" id="prodCheck"${configured ? '' : ' disabled'}>Prüfen</button>
      <div id="prod-out"></div>
    </div>`;

  $('#prodCheck').addEventListener('click', async () => {
    const ans = $('#prod-in').value.trim();
    if (!ans) { toast('Erst antworten', true); return; }
    const out = $('#prod-out');
    out.innerHTML = '<span class="spinner"></span>';
    try {
      const r = await llm.assessProduction(c.back, ans, { reference: c.front });
      out.innerHTML = `
        <hr class="sep">
        <p class="${r.correct ? 'inline-ok' : 'inline-error'}">${r.correct ? '✓ Richtig!' : '✗ Nicht ganz'}</p>
        <p><strong>Korrekt:</strong> ${esc(r.corrected || c.front)}</p>
        <p class="muted">${esc(r.feedback || '')}</p>
        <button class="btn btn-block" id="prodNext" style="margin-top:10px">Nächste →</button>`;
      $('#prodNext').addEventListener('click', () => setView('produce'));
    } catch (e) {
      out.innerHTML = `<p class="inline-error">${esc(e.message)}</p>`;
    }
  });
};

// ============================================================
// STATS
// ============================================================
const TASK_LABELS = {
  autofill: 'Auto-Fill', tandem: 'Tandem-Import', variants: 'Varianten',
  produce: 'Aktiv üben', grammar: 'Grammatik', cefr: 'CEFR', misc: 'Sonstiges',
};
const fmtUSD = n => '$' + (n < 1 ? n.toFixed(4) : n.toFixed(2));
const fmtNum = n => Math.round(n).toLocaleString('de-DE');

VIEWS.stats = async function statsView() {
  const [cards, logs, usageLog, settings] = await Promise.all([
    db.getAllCards(), db.getAllReviewLogs(), db.getAllUsageLogs(), db.getSettings(),
  ]);
  const s = stats.summarize(cards, logs);
  const u = stats.usageSummary(usageLog, settings);
  const ret = s.retention == null ? '—' : Math.round(s.retention * 100) + '%';

  const fcMax = Math.max(1, ...s.forecast.map(f => f.count));
  const forecastBars = s.forecast.map((f, i) => `
    <div class="bar-col">
      <span class="bar-cap">${f.count}</span>
      <div class="bar" style="height:${(f.count / fcMax) * 100}%"></div>
      <span class="bar-lbl">${i === 0 ? 'Heute' : f.date.slice(5)}</span>
    </div>`).join('');

  const mat = s.maturity;
  const matTotal = Math.max(1, mat.new + mat.learning + mat.young + mat.mature);
  const pct = n => (n / matTotal) * 100;

  const hm = s.heatmap;
  const hmMax = Math.max(1, ...hm.map(d => d.count));
  const level = c => c === 0 ? '' : c >= hmMax * 0.75 ? 'l4' : c >= hmMax * 0.5 ? 'l3' : c >= hmMax * 0.25 ? 'l2' : 'l1';
  const heatCells = hm.map(d => `<div class="hcell ${level(d.count)}" title="${d.date}: ${d.count}"></div>`).join('');

  app.innerHTML = `
    <h1 class="view-title">Statistik</h1>
    <div class="stat-grid">
      <div class="stat-box"><div class="v">${ret}</div><div class="k">Retention</div></div>
      <div class="stat-box"><div class="v">${s.streak} 🔥</div><div class="k">Streak (Tage)</div></div>
      <div class="stat-box"><div class="v">${s.due}</div><div class="k">Jetzt fällig</div></div>
      <div class="stat-box"><div class="v">${s.totalCards}</div><div class="k">Karten gesamt</div></div>
    </div>

    <h2 class="section-title">Prognose (7 Tage)</h2>
    <div class="card-surface"><div class="bars">${forecastBars}</div></div>

    <h2 class="section-title">Reife der Karten</h2>
    <div class="card-surface">
      <div class="maturity-bar">
        <span style="width:${pct(mat.new)}%;background:var(--muted)"></span>
        <span style="width:${pct(mat.learning)}%;background:var(--hard)"></span>
        <span style="width:${pct(mat.young)}%;background:var(--accent-soft)"></span>
        <span style="width:${pct(mat.mature)}%;background:var(--good)"></span>
      </div>
      <div class="legend">
        <span><i style="background:var(--muted)"></i>Neu ${mat.new}</span>
        <span><i style="background:var(--hard)"></i>Lernen ${mat.learning}</span>
        <span><i style="background:var(--accent-soft)"></i>Jung ${mat.young}</span>
        <span><i style="background:var(--good)"></i>Reif ${mat.mature}</span>
      </div>
    </div>

    <h2 class="section-title">Aktivität</h2>
    <div class="card-surface"><div class="heatmap">${heatCells}</div></div>

    <h2 class="section-title">KI-Verbrauch & Kosten (geschätzt)</h2>
    ${u.calls === 0
      ? '<div class="card-surface"><p class="muted">Noch keine KI-Aufrufe. Sobald du Auto-Fill, Tandem-Import, Aktiv üben usw. nutzt, erscheint hier dein geschätzter Verbrauch.</p></div>'
      : `<div class="stat-grid">
          <div class="stat-box"><div class="v">${fmtUSD(u.totalCost)}</div><div class="k">Gesamt (USD)</div></div>
          <div class="stat-box"><div class="v">${fmtUSD(u.monthCost)}</div><div class="k">Diesen Monat</div></div>
          <div class="stat-box"><div class="v">${fmtUSD(u.todayCost)}</div><div class="k">Heute</div></div>
          <div class="stat-box"><div class="v">${u.calls}</div><div class="k">KI-Aufrufe</div></div>
        </div>
        <div class="card-surface" style="margin-top:11px">
          <p class="muted" style="margin:0 0 10px">Tokens gesamt: <strong>${fmtNum(u.totalIn)}</strong> rein · <strong>${fmtNum(u.totalOut)}</strong> raus</p>
          <div class="list">
            ${Object.entries(u.byTask).sort((a, b) => b[1].cost - a[1].cost).map(([task, t]) => `
              <div class="list-item">
                <div class="li-main">
                  <div class="li-front" style="font-size:16px">${esc(TASK_LABELS[task] || task)}</div>
                  <div class="li-back">${t.calls}× · ${fmtNum(t.inTok)}/${fmtNum(t.outTok)} Tok</div>
                </div>
                <div class="li-state">${fmtUSD(t.cost)}</div>
              </div>`).join('')}
          </div>
          <p class="caveat">Schätzung auf Basis der Preise in den Einstellungen (${fmtUSD(settings.priceGenIn)}/${fmtUSD(settings.priceGenOut)} Generierung, ${fmtUSD(settings.priceFbIn)}/${fmtUSD(settings.priceFbOut)} Feedback je 1M Tokens). Maßgeblich ist die echte Azure-Abrechnung.</p>
        </div>`}

    <h2 class="section-title">CEFR-Orientierung</h2>
    <div class="card-surface" id="cefr-box">
      <p class="muted">Grobe Richtungsweisung deines Niveaus (kein exakter Score).</p>
      <button class="btn" id="cefrBtn">Niveau einschätzen</button>
      <div id="cefr-out"></div>
    </div>`;

  $('#cefrBtn').addEventListener('click', () => runCEFR(cards));
};

async function runCEFR(cards) {
  if (!(await llm.isConfigured())) { toast('Azure in den Einstellungen einrichten', true); return; }
  const out = $('#cefr-out');
  const sample = stats.performanceWeightedSample(cards);
  if (sample.length < 3) { out.innerHTML = '<p class="muted">Zu wenig gelernte Karten für eine Einschätzung.</p>'; return; }
  out.innerHTML = '<p><span class="spinner"></span> Analysiere …</p>';
  try {
    const r = await llm.estimateCEFR(sample);
    out.innerHTML = `
      <div class="cefr-box" style="margin-top:12px">
        <div class="range">${esc(r.range || '—')}</div>
        <p>${esc(r.summary || '')}</p>
        ${(r.gaps && r.gaps.length) ? `<p><strong>Fokus:</strong></p><ul>${r.gaps.map(g => `<li>${esc(g)}</li>`).join('')}</ul>` : ''}
        <p class="caveat">Hinweis: Dies misst passives Wiedererkennen (was Karteikarten trainieren). Die aktive Sprachfähigkeit liegt meist darunter. Nur grobe Orientierung, kein definitives Niveau.</p>
      </div>`;
  } catch (e) {
    out.innerHTML = `<p class="inline-error">${esc(e.message)}</p>`;
  }
}

// ============================================================
// MORE (menu)
// ============================================================
VIEWS.more = async function moreView() {
  app.innerHTML = `
    <h1 class="view-title">Mehr</h1>
    <div class="menu">
      <button class="menu-item" onclick="__setView('produce')"><span class="mi-ico">✎</span><span class="mi-text">Aktiv üben<span class="mi-sub">Spanisch selbst formulieren, KI korrigiert</span></span></button>
      <button class="menu-item" onclick="__setView('tandem')"><span class="mi-ico">⇪</span><span class="mi-text">Tandem-Import<span class="mi-sub">Text einfügen → Karten vorschlagen</span></span></button>
      <button class="menu-item" onclick="__setView('backup')"><span class="mi-ico">⛁</span><span class="mi-text">Backup & Export<span class="mi-sub">JSON-Sicherung · Anki-CSV</span></span></button>
      <button class="menu-item" onclick="__setView('settings')"><span class="mi-ico">⚙</span><span class="mi-text">Einstellungen<span class="mi-sub">Azure · neue Karten pro Tag</span></span></button>
    </div>`;
};

// ============================================================
// BACKUP (export / import)
// ============================================================
VIEWS.backup = async function backupView() {
  app.innerHTML = `
    <h1 class="view-title">Backup & Export</h1>
    <div class="banner">⚠️ Daten leben nur in diesem Browser — ohne Sync. Exportiere regelmäßig als JSON, sonst sind sie beim Löschen der Browserdaten weg.</div>
    <div class="card-surface stack">
      <h2 class="section-title" style="margin-top:0">Sicherung (JSON)</h2>
      <button class="btn btn-primary btn-block" id="expJson">JSON exportieren (Backup)</button>
      <label class="btn btn-block" style="margin-top:6px">Backup importieren …
        <input type="file" id="impFile" accept="application/json,.json" hidden />
      </label>
      <div id="backup-msg"></div>
    </div>
    <div class="card-surface stack" style="margin-top:16px">
      <h2 class="section-title" style="margin-top:0">Anki-Export (CSV)</h2>
      <p class="muted">Karteninhalte als CSV mit sauber getrennten Spalten — importierbar in Anki o. Ä. (ohne Lernstand).</p>
      <button class="btn btn-block" id="expCsv">CSV exportieren</button>
    </div>`;

  $('#expJson').addEventListener('click', async () => {
    try { await backup.exportJSON(); toast('Backup heruntergeladen ✓'); }
    catch (e) { toast(e.message, true); }
  });
  $('#expCsv').addEventListener('click', async () => {
    try { await backup.exportCSV(); toast('CSV heruntergeladen ✓'); }
    catch (e) { toast(e.message, true); }
  });
  $('#impFile').addEventListener('change', async ev => {
    const file = ev.target.files[0];
    if (!file) return;
    if (!confirm('Import ERSETZT alle aktuellen Daten in diesem Browser. Fortfahren?')) { ev.target.value = ''; return; }
    try {
      const text = await file.text();
      const r = await backup.importJSONFromText(text);
      $('#backup-msg').innerHTML = `<p class="inline-ok">Importiert: ${r.cards} Karten, ${r.reviewLog} Log-Einträge.</p>`;
      toast('Import erfolgreich ✓');
      updateTopbarMeta();
    } catch (e) {
      $('#backup-msg').innerHTML = `<p class="inline-error">${esc(e.message)}</p>`;
    }
  });
};

// ============================================================
// SETTINGS
// ============================================================
VIEWS.settings = async function settingsView() {
  const s = await db.getSettings();
  app.innerHTML = `
    <h1 class="view-title">Einstellungen</h1>
    <div class="card-surface stack">
      <h2 class="section-title" style="margin-top:0">Azure AI Foundry</h2>
      <p class="help">Wird nur in diesem Browser gespeichert. Der Schlüssel wird nie exportiert. (Direkter Browser-Aufruf ist ok, weil die App nur lokal von dir genutzt wird.)</p>
      <div class="field">
        <label>Endpoint</label>
        <input class="input" id="s-endpoint" value="${esc(s.azureEndpoint)}" placeholder="https://DEINE-RESSOURCE.openai.azure.com/openai/v1/" />
        <div class="help">Muss auf <code>/openai/v1/</code> enden.</div>
      </div>
      <div class="field">
        <label>API-Schlüssel</label>
        <input class="input" id="s-key" type="password" value="${esc(s.azureApiKey)}" placeholder="••••••••" />
      </div>
      <div class="field">
        <label>Deployment — Generierung (günstig/schnell)</label>
        <input class="input" id="s-gen" value="${esc(s.modelGenerate)}" placeholder="[Deployment-Name eintragen]" />
      </div>
      <div class="field">
        <label>Deployment — Feedback (stärker)</label>
        <input class="input" id="s-fb" value="${esc(s.modelFeedback)}" placeholder="[Deployment-Name eintragen]" />
      </div>
      <hr class="sep">
      <div class="field">
        <label>Neue Karten pro Tag</label>
        <input class="input" id="s-new" type="number" min="0" max="200" value="${esc(s.newCardsPerDay)}" />
      </div>
      <div id="set-msg"></div>
      <button class="btn btn-primary btn-block" id="saveSettings">Speichern</button>
    </div>

    <div class="card-surface stack" style="margin-top:16px">
      <h2 class="section-title" style="margin-top:0">Kosten-Schätzung</h2>
      <p class="help">Nur für die Verbrauchsanzeige im Stats-Tab. Preise in USD pro 1M Tokens (Standard: gpt-5-mini).</p>
      <div class="row-2">
        <div class="field"><label>Generierung — Input</label><input class="input" id="s-pgi" type="number" step="0.01" min="0" value="${esc(s.priceGenIn)}" /></div>
        <div class="field"><label>Generierung — Output</label><input class="input" id="s-pgo" type="number" step="0.01" min="0" value="${esc(s.priceGenOut)}" /></div>
      </div>
      <div class="row-2">
        <div class="field"><label>Feedback — Input</label><input class="input" id="s-pfi" type="number" step="0.01" min="0" value="${esc(s.priceFbIn)}" /></div>
        <div class="field"><label>Feedback — Output</label><input class="input" id="s-pfo" type="number" step="0.01" min="0" value="${esc(s.priceFbOut)}" /></div>
      </div>
    </div>`;

  $('#saveSettings').addEventListener('click', async () => {
    const num = (id, fb) => { const v = parseFloat($(id).value); return Number.isFinite(v) && v >= 0 ? v : fb; };
    const next = {
      azureEndpoint: $('#s-endpoint').value.trim(),
      azureApiKey: $('#s-key').value.trim(),
      modelGenerate: $('#s-gen').value.trim(),
      modelFeedback: $('#s-fb').value.trim(),
      newCardsPerDay: Math.max(0, parseInt($('#s-new').value, 10) || 0),
      priceGenIn: num('#s-pgi', 0.25), priceGenOut: num('#s-pgo', 2.00),
      priceFbIn: num('#s-pfi', 0.25), priceFbOut: num('#s-pfo', 2.00),
      targetLang: 'es', nativeLang: 'de',
    };
    await db.saveSettings(next);
    $('#set-msg').innerHTML = '<p class="inline-ok">Gespeichert ✓</p>';
    toast('Einstellungen gespeichert ✓');
    updateTopbarMeta();
  });
};

// ---------- boot ----------
document.querySelectorAll('.tab').forEach(b =>
  b.addEventListener('click', () => setView(b.dataset.view, b.dataset.view === 'edit' ? {} : {})));

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => { /* offline shell is optional */ });
  });
}

setView('review');
