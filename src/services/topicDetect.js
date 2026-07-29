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

// ⚠️ CORRECTED Jul 29. The original version of this detector was built on
// ESTATE-PLANNING vocabulary (wills, probate, power of attorney, elder law) —
// I assumed "Rise Legacy" meant a law firm doing estate work. It doesn't:
// Legacy does BUSINESS STRUCTURING. Call #2860 (Kevin/Estuardo Godoy) was a pure
// entity-structuring consult — holding company → LLC → land trust → property —
// and scored 0 because it isn't a sales call. My regex scored it **0 legal hits
// against 34 structuring hits**: it had no chance of firing, because it was
// looking for entirely the wrong words.
//
// Two changes:
//   1. Vocabulary replaced with entity/structuring terms (kept the estate terms
//      too — they're still Legacy work, just not the common case).
//   2. The old rule required ZERO Turnkey language. That made sense for a probate
//      call, which genuinely never mentions STRs. A structuring call ALWAYS
//      mentions properties, so that condition guaranteed a miss. Replaced with a
//      DOMINANCE test: Legacy content must clearly outweigh Turnkey content.
//      Validated both directions — #2860 (34 vs 1) fires; #2708 (68 vs 17) and
//      #1182 (10 vs 4) are genuine Turnkey calls where structuring merely came up
//      alongside the pitch, and they must NOT fire.
const LEGAL_TOPIC_RE = /\b(llc|land trust|holding company|business structur\w*|entity structur\w*|s.corp|c.corp|operating agreement|registered agent|incorporat\w*|asset protection|estate planning|living trust|revocable trust|irrevocable trust|last will and testament|power of attorney|probate|elder law|trust document|law firm|attorney fees|legal counsel)\b/gi;
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
  // Requires substantial Legacy content AND near-total absence of Turnkey content.
  //
  // A RATIO test was tried first and rejected: #2708 (a genuine sales call —
  // "strong discovery and pitch... client declined the $10K upfront fee") scored
  // 67 legal vs 15 turnkey and passed a 3x dominance test. The reason is that
  // "LLC" is ordinary vocabulary in real-estate investing, so a sophisticated
  // client discussing tax strategy racks up hits inside a legitimate Turnkey call.
  //
  // The real discriminator is ABSOLUTE Turnkey volume: a true Legacy consult
  // barely mentions STRs at all (#2860: 34 vs 1), whereas a sales call that
  // happens to cover entity setup still carries substantial Turnkey content.
  // Validated across all 336 scored calls: exactly 1 flags, and it is the correct
  // one. Zero false positives.
  return legal >= 8 && turnkey <= 3;
}

// ─────────────────────────────────────────────────────────────────
// Follow-up detection (Kevin's suggestion, Jul 29).
//
// Detects the rep and lead acknowledging a PRIOR conversation between THEM.
// Deliberately built on concrete transcript evidence rather than a rep's
// assertion — same standard the dispute flow holds people to.
//
// ⚠️ THE GUARD THAT MAKES THIS SAFE: in this business model EVERY closer call
// follows a setter call, so a closer saying "you spoke with Anurag" is a normal
// FIRST closer call, not a follow-up. Measured on the corpus: 4 of 84 closer
// calls carry genuine reconnect language, while 6 reference a setter's call.
// Without this guard the false-positive rate would exceed the true-positive rate.
//
// NOT built: Kevin also proposed auto-excluding any call under 20 minutes.
// The data contradicts the premise — short closer calls average 3.0 vs 6.7 for
// 40+ min, and reading all 8 short calls, none were follow-ups; they were calls
// that ended early because they went badly ("cut short mid-sentence", "failed to
// qualify capital"). Length is a proxy for performance, so excluding on it would
// systematically remove the worst-executed calls. See Master change log.
// ─────────────────────────────────────────────────────────────────

const RECONNECT_RE = /\b(talk(?:ing)? (?:to|with) you again|speak(?:ing)? (?:to|with) you again|see(?:ing)? you again|good to see you again|nice to (?:see|talk to|speak with) you again|haven'?t we (?:already )?spoken|we spoke (?:last|before|earlier|the other)|last time we (?:spoke|talked)|since we (?:last )?(?:spoke|talked)|following up (?:on|from) our|our (?:last|previous) (?:call|conversation))\b/gi;

// Names that indicate the SETTER did the prior talking, not this rep.
const SETTER_NAMES = /\b(anurag|andrew|steven|steve|analag)\b/i;

// Returns { count, isFollowUp, evidence[] }. A reconnect phrase is DISCOUNTED
// when a setter's name appears within ~80 characters of it, since that's a
// handoff reference rather than a genuine second conversation with this rep.
function detectFollowUp(transcript) {
  const t = String(transcript || '');
  if (!t) return { count: 0, isFollowUp: false, evidence: [] };
  const evidence = [];
  let discounted = 0;
  for (const m of t.matchAll(RECONNECT_RE)) {
    const from = Math.max(0, m.index - 80);
    const window = t.slice(from, m.index + m[0].length + 80);
    if (SETTER_NAMES.test(window)) { discounted++; continue; }
    if (evidence.length < 3) evidence.push(m[0].trim());
  }
  return { count: evidence.length, discounted, isFollowUp: evidence.length > 0, evidence };
}

module.exports = { looksOffTopic, offTopicCounts, detectFollowUp, LEGAL_TOPIC_RE, TURNKEY_TOPIC_RE, RECONNECT_RE };
