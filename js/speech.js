// speech.js — pronunciation via the browser's built-in Web Speech API. Free, no network.
// iOS Safari quirk: voices load asynchronously and may be empty on first call, so we
// listen for `voiceschanged` and pick a Spanish voice lazily.

let _voices = [];

function refreshVoices() {
  if (!('speechSynthesis' in window)) return;
  _voices = window.speechSynthesis.getVoices() || [];
}

if ('speechSynthesis' in window) {
  refreshVoices();
  window.speechSynthesis.onvoiceschanged = refreshVoices;
}

export function isSpeechSupported() {
  return 'speechSynthesis' in window && 'SpeechSynthesisUtterance' in window;
}

function pickSpanishVoice() {
  if (!_voices.length) refreshVoices();
  // Prefer es-ES, then any Spanish, then null (let the OS choose by lang).
  return (
    _voices.find(v => /^es[-_]ES/i.test(v.lang)) ||
    _voices.find(v => /^es/i.test(v.lang)) ||
    null
  );
}

// Speak Spanish text. Must be triggered by a user gesture on iOS (a tap), which the
// speaker button satisfies.
export function speak(text, lang = 'es-ES') {
  if (!isSpeechSupported() || !text) return;
  try {
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = lang;
    const voice = pickSpanishVoice();
    if (voice) u.voice = voice;
    u.rate = 0.95;
    window.speechSynthesis.speak(u);
  } catch (_) {
    // Speech is non-essential; never let it break the review loop.
  }
}
