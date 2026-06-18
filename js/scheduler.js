// scheduler.js — ISOLATED scheduling module.
//
// Deliberately a simple, correct interval scheme (spec §5). The Card carries the full
// FSRS-compatible field set (stability, difficulty, reps, lapses, state, due...) so this
// module can be swapped for a real FSRS implementation later with NO data migration.
//
// Convention used here: `stability` holds the current review interval in DAYS.
// A future FSRS upgrade reinterprets the same field — the storage shape does not change.

const MIN = 60 * 1000;
const DAY = 24 * 60 * 60 * 1000;

// Learning steps for new / relearning cards.
const LEARNING_STEPS_MS = [1 * MIN, 10 * MIN];
const GRADUATING_INTERVAL_DAYS = 1;   // good out of last learning step
const EASY_INTERVAL_DAYS = 4;         // easy on a new/learning card jumps ahead

// Review-card ease multipliers.
const EASE = { hard: 1.2, good: 2.5, easy: 3.5 };
const LAPSE_STABILITY_FACTOR = 0.5;   // on "again" in review, shrink the interval

const DIFFICULTY_DEFAULT = 5;         // 1..10, populated for future FSRS; not used to schedule yet

function clamp(n, lo, hi) { return Math.min(hi, Math.max(lo, n)); }

// Build a brand-new card's scheduling fields. The caller supplies content fields.
export function freshSchedulingFields(now = Date.now()) {
  return {
    due: now,
    stability: 0,
    difficulty: DIFFICULTY_DEFAULT,
    reps: 0,
    lapses: 0,
    lastReview: null,
    state: 'new',
    learningStep: 0, // internal to this module; harmless extra field
  };
}

function adjustDifficulty(card, rating) {
  const delta = { 1: +1, 2: +0.5, 3: 0, 4: -0.5 }[rating] || 0;
  return clamp((card.difficulty ?? DIFFICULTY_DEFAULT) + delta, 1, 10);
}

// Apply a rating (1 again / 2 hard / 3 good / 4 easy). Returns a NEW card object
// with updated scheduling fields. Pure — does not touch the DB or the review log.
export function applyRating(card, rating, now = Date.now()) {
  const next = { ...card, lastReview: now, difficulty: adjustDifficulty(card, rating) };
  const inLearning = card.state === 'new' || card.state === 'learning';

  if (inLearning) {
    const step = card.learningStep ?? 0;
    if (rating === 1) {                       // again — back to first step
      next.state = 'learning';
      next.learningStep = 0;
      next.due = now + LEARNING_STEPS_MS[0];
      next.stability = 0;
    } else if (rating === 2) {                // hard — repeat current step
      next.state = 'learning';
      next.learningStep = step;
      next.due = now + LEARNING_STEPS_MS[Math.min(step, LEARNING_STEPS_MS.length - 1)];
      next.stability = 0;
    } else if (rating === 4) {                // easy — graduate ahead
      next.state = 'review';
      next.learningStep = 0;
      next.stability = EASY_INTERVAL_DAYS;
      next.due = now + EASY_INTERVAL_DAYS * DAY;
      next.reps = (card.reps || 0) + 1;
    } else {                                  // good — advance / graduate
      const nextStep = step + 1;
      if (nextStep >= LEARNING_STEPS_MS.length) {
        next.state = 'review';
        next.learningStep = 0;
        next.stability = GRADUATING_INTERVAL_DAYS;
        next.due = now + GRADUATING_INTERVAL_DAYS * DAY;
        next.reps = (card.reps || 0) + 1;
      } else {
        next.state = 'learning';
        next.learningStep = nextStep;
        next.due = now + LEARNING_STEPS_MS[nextStep];
        next.stability = 0;
      }
    }
    return next;
  }

  // Review card.
  const prevInterval = Math.max(1, card.stability || GRADUATING_INTERVAL_DAYS);
  if (rating === 1) {                         // again — lapse, drop to relearning
    next.state = 'learning';
    next.learningStep = 0;
    next.lapses = (card.lapses || 0) + 1;
    next.stability = Math.max(1, prevInterval * LAPSE_STABILITY_FACTOR);
    next.due = now + LEARNING_STEPS_MS[0];
    return next;
  }

  const factor = rating === 2 ? EASE.hard : rating === 4 ? EASE.easy : EASE.good;
  let newInterval = prevInterval * factor;
  // Ensure forward progress of at least one day beyond the previous interval for good/easy.
  if (rating >= 3) newInterval = Math.max(newInterval, prevInterval + 1);
  newInterval = Math.round(clamp(newInterval, 1, 365 * 5));

  next.state = 'review';
  next.learningStep = 0;
  next.reps = (card.reps || 0) + 1;
  next.stability = newInterval;
  next.due = now + newInterval * DAY;
  return next;
}

// Count of cards first introduced (first-ever review) today, derived from the append-only log.
export function countNewIntroducedToday(reviewLog, now = Date.now()) {
  const startOfDay = new Date(now);
  startOfDay.setHours(0, 0, 0, 0);
  const startMs = startOfDay.getTime();
  const firstTsByCard = new Map();
  for (const entry of reviewLog) {
    const prev = firstTsByCard.get(entry.cardId);
    if (prev === undefined || entry.ts < prev) firstTsByCard.set(entry.cardId, entry.ts);
  }
  let count = 0;
  for (const ts of firstTsByCard.values()) if (ts >= startMs) count++;
  return count;
}

// Build the study session queue.
// Returns { due: [...], new: [...], dueCount, newCount } where `due` includes
// learning + review cards whose due time has arrived. `new` is capped by the daily limit.
export function buildQueue(cards, reviewLog, settings, now = Date.now()) {
  const introducedToday = countNewIntroducedToday(reviewLog, now);
  const newAllowed = Math.max(0, (settings.newCardsPerDay ?? 15) - introducedToday);

  const due = cards
    .filter(c => (c.state === 'review' || c.state === 'learning') && c.due <= now)
    .sort((a, b) => a.due - b.due);

  const newCards = cards
    .filter(c => c.state === 'new')
    .sort((a, b) => a.createdAt - b.createdAt)
    .slice(0, newAllowed);

  return { due, new: newCards, dueCount: due.length, newCount: newCards.length };
}
