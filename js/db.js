// db.js — thin IndexedDB wrapper + data access layer.
// No external dependencies (zero-build). All app data lives here; there is no sync.
// Stores: cards (keyPath id), reviewLog (append-only, keyPath id), settings (keyPath key).

const DB_NAME = 'spanish-srs';
const DB_VERSION = 2;

let _dbPromise = null;

function openDB() {
  if (_dbPromise) return _dbPromise;
  _dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('cards')) {
        const cards = db.createObjectStore('cards', { keyPath: 'id' });
        cards.createIndex('due', 'due');
        cards.createIndex('state', 'state');
        cards.createIndex('createdAt', 'createdAt');
      }
      if (!db.objectStoreNames.contains('reviewLog')) {
        const log = db.createObjectStore('reviewLog', { keyPath: 'id' });
        log.createIndex('cardId', 'cardId');
        log.createIndex('ts', 'ts');
      }
      if (!db.objectStoreNames.contains('settings')) {
        db.createObjectStore('settings', { keyPath: 'key' });
      }
      // v2: append-only log of LLM token usage (for the cost estimate).
      if (!db.objectStoreNames.contains('usageLog')) {
        const u = db.createObjectStore('usageLog', { keyPath: 'id' });
        u.createIndex('ts', 'ts');
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return _dbPromise;
}

function tx(storeNames, mode, fn) {
  return openDB().then(db => new Promise((resolve, reject) => {
    const t = db.transaction(storeNames, mode);
    let result;
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
    result = fn(t);
  }));
}

function reqToPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

// ---- Cards ----

export async function getAllCards() {
  const db = await openDB();
  return reqToPromise(db.transaction('cards').objectStore('cards').getAll());
}

export async function getCard(id) {
  const db = await openDB();
  return reqToPromise(db.transaction('cards').objectStore('cards').get(id));
}

export async function putCard(card) {
  return tx('cards', 'readwrite', t => t.objectStore('cards').put(card));
}

export async function putCards(cards) {
  return tx('cards', 'readwrite', t => {
    const store = t.objectStore('cards');
    cards.forEach(c => store.put(c));
  });
}

export async function deleteCard(id) {
  return tx('cards', 'readwrite', t => t.objectStore('cards').delete(id));
}

// ---- Review log (append-only — never mutate or delete) ----

export async function addReviewLog(entry) {
  return tx('reviewLog', 'readwrite', t => t.objectStore('reviewLog').add(entry));
}

export async function getAllReviewLogs() {
  const db = await openDB();
  return reqToPromise(db.transaction('reviewLog').objectStore('reviewLog').getAll());
}

// ---- Usage log (append-only — token usage per LLM call, for cost estimate) ----

export async function addUsageLog(entry) {
  return tx('usageLog', 'readwrite', t => t.objectStore('usageLog').add(entry));
}

export async function getAllUsageLogs() {
  const db = await openDB();
  return reqToPromise(db.transaction('usageLog').objectStore('usageLog').getAll());
}

// ---- Settings (single logical object, stored under one key) ----

const SETTINGS_KEY = 'app';

const DEFAULT_SETTINGS = {
  azureEndpoint: '',
  azureApiKey: '',
  modelGenerate: '',
  modelFeedback: '',
  newCardsPerDay: 15,
  targetLang: 'es',
  nativeLang: 'de',
  // Prices in USD per 1M tokens, used only for the local cost estimate.
  // Defaults reflect gpt-5-mini (Global Standard) for both roles.
  priceGenIn: 0.25,
  priceGenOut: 2.00,
  priceFbIn: 0.25,
  priceFbOut: 2.00,
};

export async function getSettings() {
  const db = await openDB();
  const row = await reqToPromise(db.transaction('settings').objectStore('settings').get(SETTINGS_KEY));
  return { ...DEFAULT_SETTINGS, ...(row ? row.value : {}) };
}

export async function saveSettings(settings) {
  const value = { ...DEFAULT_SETTINGS, ...settings };
  return tx('settings', 'readwrite', t => t.objectStore('settings').put({ key: SETTINGS_KEY, value }));
}

// ---- Bulk replace (used by JSON import) ----

export async function replaceAll({ cards, reviewLog, usageLog, settings }) {
  // Wipe and restore in one transaction so a failed import can't leave a half state.
  return tx(['cards', 'reviewLog', 'usageLog', 'settings'], 'readwrite', t => {
    const cs = t.objectStore('cards');
    const ls = t.objectStore('reviewLog');
    const us = t.objectStore('usageLog');
    const ss = t.objectStore('settings');
    cs.clear();
    ls.clear();
    us.clear();
    (cards || []).forEach(c => cs.put(c));
    (reviewLog || []).forEach(l => ls.put(l));
    (usageLog || []).forEach(u => us.put(u));
    if (settings) {
      // Keep any existing API key if the import (which omits it) doesn't carry one.
      ss.put({ key: SETTINGS_KEY, value: { ...DEFAULT_SETTINGS, ...settings } });
    }
  });
}

export { DEFAULT_SETTINGS };
