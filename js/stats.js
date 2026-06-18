// stats.js — derive statistics purely from cards + the append-only review log.

const DAY = 24 * 60 * 60 * 1000;

function startOfDay(ms) {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function dayKey(ms) {
  const d = new Date(ms);
  // Local YYYY-MM-DD.
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

export function retentionRate(reviewLog) {
  if (!reviewLog.length) return null;
  const good = reviewLog.filter(r => r.rating >= 3).length;
  return good / reviewLog.length;
}

// Consecutive days (ending today or yesterday) with at least one review.
export function currentStreak(reviewLog, now = Date.now()) {
  if (!reviewLog.length) return 0;
  const days = new Set(reviewLog.map(r => dayKey(r.ts)));
  let streak = 0;
  let cursor = startOfDay(now);
  // Allow the streak to count even if today has no review yet, by starting from today
  // but only breaking once a day with no activity precedes the run.
  if (!days.has(dayKey(cursor))) cursor -= DAY; // grace: check from yesterday
  while (days.has(dayKey(cursor))) {
    streak++;
    cursor -= DAY;
  }
  return streak;
}

export function dueCount(cards, now = Date.now()) {
  return cards.filter(c => (c.state === 'review' || c.state === 'learning') && c.due <= now).length;
}

// Cards becoming due on each of the next `days` days (review/learning cards only).
export function forecast(cards, days = 7, now = Date.now()) {
  const out = [];
  const todayStart = startOfDay(now);
  for (let i = 0; i < days; i++) {
    const start = todayStart + i * DAY;
    const end = start + DAY;
    const count = cards.filter(c =>
      (c.state === 'review' || c.state === 'learning') &&
      // due before today counts toward day 0 (overdue), otherwise bucket by due day
      (i === 0 ? c.due < end : c.due >= start && c.due < end)
    ).length;
    out.push({ date: dayKey(start), count });
  }
  return out;
}

// new / learning / young (interval < 21d) / mature (>= 21d).
export function maturityDistribution(cards) {
  const dist = { new: 0, learning: 0, young: 0, mature: 0 };
  for (const c of cards) {
    if (c.state === 'new') dist.new++;
    else if (c.state === 'learning') dist.learning++;
    else if ((c.stability || 0) >= 21) dist.mature++;
    else dist.young++;
  }
  return dist;
}

// GitHub-style heatmap: review count per day for the last `days` days.
export function heatmap(reviewLog, days = 119, now = Date.now()) {
  const counts = new Map();
  for (const r of reviewLog) {
    const k = dayKey(r.ts);
    counts.set(k, (counts.get(k) || 0) + 1);
  }
  const out = [];
  const todayStart = startOfDay(now);
  for (let i = days; i >= 0; i--) {
    const ms = todayStart - i * DAY;
    const k = dayKey(ms);
    out.push({ date: k, count: counts.get(k) || 0, ts: ms });
  }
  return out;
}

// Build a performance-weighted sample of cards for the CEFR estimate.
// Well-retained cards with long intervals count more; brand-new cards are excluded.
export function performanceWeightedSample(cards, max = 40) {
  const eligible = cards.filter(c => c.state !== 'new' && (c.reps || 0) > 0);
  const scored = eligible.map(c => ({
    card: c,
    weight: (c.stability || 1) * (1 + (c.reps || 0)) / (1 + (c.lapses || 0)),
  }));
  scored.sort((a, b) => b.weight - a.weight);
  return scored.slice(0, max).map(s => ({
    front: s.card.front,
    back: s.card.back,
    type: s.card.type,
    notes: s.card.notes || null,
    intervalDays: Math.round(s.card.stability || 0),
    reps: s.card.reps || 0,
    lapses: s.card.lapses || 0,
  }));
}

// Token usage + estimated cost (USD), derived from the append-only usage log and
// the per-role prices in settings.
export function usageSummary(usageLog, settings, now = Date.now()) {
  const priceFor = (kind, dir) => {
    if (kind === 'feedback') return dir === 'in' ? (settings.priceFbIn || 0) : (settings.priceFbOut || 0);
    return dir === 'in' ? (settings.priceGenIn || 0) : (settings.priceGenOut || 0);
  };
  const costOf = e => (e.inTok || 0) / 1e6 * priceFor(e.modelKind, 'in')
    + (e.outTok || 0) / 1e6 * priceFor(e.modelKind, 'out');

  const monthStart = new Date(now); monthStart.setDate(1); monthStart.setHours(0, 0, 0, 0);
  const dayStart = new Date(now); dayStart.setHours(0, 0, 0, 0);

  const out = {
    calls: usageLog.length, totalIn: 0, totalOut: 0,
    totalCost: 0, monthCost: 0, todayCost: 0, byTask: {},
  };
  for (const e of usageLog) {
    const c = costOf(e);
    out.totalIn += e.inTok || 0;
    out.totalOut += e.outTok || 0;
    out.totalCost += c;
    if (e.ts >= monthStart.getTime()) out.monthCost += c;
    if (e.ts >= dayStart.getTime()) out.todayCost += c;
    const t = out.byTask[e.task] || (out.byTask[e.task] = { calls: 0, inTok: 0, outTok: 0, cost: 0 });
    t.calls++; t.inTok += e.inTok || 0; t.outTok += e.outTok || 0; t.cost += c;
  }
  return out;
}

export function summarize(cards, reviewLog, now = Date.now()) {
  return {
    retention: retentionRate(reviewLog),
    streak: currentStreak(reviewLog, now),
    due: dueCount(cards, now),
    totalCards: cards.length,
    totalReviews: reviewLog.length,
    forecast: forecast(cards, 7, now),
    maturity: maturityDistribution(cards),
    heatmap: heatmap(reviewLog, 119, now),
  };
}
