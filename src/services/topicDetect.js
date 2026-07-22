// ─────────────────────────────────────────────────────────────────
// Wrong-business-unit detection — deterministic, no AI cost.
//
// Detects a call that reads as fundamentally NOT about BNB Turnkey (e.g. a Rise
// Legacy legal matter that landed on a Turnkey rep). Single source of truth,
// used in two places that must never drift apart:
//   1. src/routes/api.js  — soft-filters digest/report Best-Toughest candidacy
//   2. src/workers/qcWorker.js — auto-suggests the BNB_LEGACY tag at score time
//      (SUGGESTED only; a human still confirms before it touches any average)
//
// Deliberately conservative: needs 3+ distinct legal-topic phrases AND ZERO
// Turnkey-topic language to trigger. Validated Jul 23 against real transcripts —
// the highest legal-hit count on any genuine Turnkey call in a 14-day sample was 2
// (need 3+), and every one had 11-41 Turnkey hits (need 0). Zero false positives.
// Same "ambiguous -> leave it alone" bias as the call-tagging spec's DQ test.
// ─────────────────────────────────────────────────────────────────

const LEGAL_TOPIC_RE = /\b(estate planning|living trust|revocable trust|irrevocable trust|last will and testament|power of attorney|probate|elder law|asset protection trust|legacy planning|trust document|law firm|attorney fees|legal services|legal counsel)\b/gi;
const TURNKEY_TOPIC_RE = /\b(short-?term rental|\bstr\b|airbnb|turnkey|cash ?flow|rental income|occupancy|investment property|property management|vacation rental|booking)\b/gi;

function offTopicCounts(transcript) {
  const t = transcript || '';
  const legal = (t.match(LEGAL_TOPIC_RE) || []).length;
  const turnkey = (t.match(TURNKEY_TOPIC_RE) || []).length;
  return { legal, turnkey };
}

function looksOffTopic(transcript) {
  if (!transcript) return false;
  const { legal, turnkey } = offTopicCounts(transcript);
  return legal >= 3 && turnkey === 0;
}

module.exports = { looksOffTopic, offTopicCounts, LEGAL_TOPIC_RE, TURNKEY_TOPIC_RE };
