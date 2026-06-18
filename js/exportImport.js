// exportImport.js — JSON backup (the safety net, since there is no sync) and Anki CSV export.

import { getAllCards, getAllReviewLogs, getSettings, replaceAll } from './db.js';

function triggerDownload(filename, mimeType, content) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  // iOS Safari may open the blob in a new tab rather than downloading; the user can then
  // use the Share sheet to save it. The download attribute is set for browsers that honor it.
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

function dateStamp() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
}

// ---- Full JSON backup (cards + review log + settings WITHOUT the API key) ----

export async function exportJSON() {
  const [cards, reviewLog, settings] = await Promise.all([
    getAllCards(), getAllReviewLogs(), getSettings(),
  ]);
  const { azureApiKey, ...settingsSansKey } = settings; // never export the key
  const payload = {
    app: 'spanish-srs',
    version: 1,
    exportedAt: Date.now(),
    cards,
    reviewLog,
    settings: settingsSansKey,
  };
  triggerDownload(`spanish-srs-backup-${dateStamp()}.json`, 'application/json',
    JSON.stringify(payload, null, 2));
}

export async function importJSONFromText(text) {
  const data = JSON.parse(text);
  if (!data || !Array.isArray(data.cards)) {
    throw new Error('This file does not look like a Spanish-SRS backup.');
  }
  await replaceAll({
    cards: data.cards,
    reviewLog: Array.isArray(data.reviewLog) ? data.reviewLog : [],
    settings: data.settings || null,
  });
  return { cards: data.cards.length, reviewLog: (data.reviewLog || []).length };
}

// ---- Anki CSV export (content only, clean separate columns; NOT scheduling state) ----

function csvEscape(value) {
  const s = value == null ? '' : String(value);
  if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

export async function exportCSV() {
  const cards = await getAllCards();
  const header = ['front', 'back', 'gender', 'example', 'exampleTrans', 'notes', 'tags', 'type'];
  const rows = [header.join(',')];
  for (const c of cards) {
    rows.push([
      c.front, c.back, c.gender, c.example, c.exampleTrans, c.notes,
      (c.tags || []).join(' '), c.type,
    ].map(csvEscape).join(','));
  }
  triggerDownload(`spanish-srs-cards-${dateStamp()}.csv`, 'text/csv', rows.join('\r\n'));
}
