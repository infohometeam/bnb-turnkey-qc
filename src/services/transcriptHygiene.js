// ═══════════════════════════════════════════════════════════════
// Transcript Hygiene — diarization-quality analyzer (NO auto-repair)
// ───────────────────────────────────────────────────────────────
// WHY THIS EXISTS
// Fathom's diarization is unreliable on phone dial-in calls. Two defects,
// both baked into the STORED transcript (not a frontend bug):
//   1. SCRAMBLED LABELS — the rep's lines get tagged as the lead and vice
//      versa. Reliable proxy: a speaker label that looks like a phone number.
//      (Measured: this is what corrupts call #1087.)
//   2. ECHO / CROSS-ATTRIBUTION — the same utterance is transcribed twice,
//      once under each speaker, a second or two apart.
//      (Measured: 16 of 32 Fathom calls carry the meaningful >=3 cluster.)
//
// DESIGN PRINCIPLE (hard-won — see Master lesson): we do NOT rewrite the
// transcript. Stripping "duplicates" produces a confidently MIS-ATTRIBUTED
// transcript, which is worse than a visibly messy one. So this module only:
//   • DETECTS the artifacts and scores transcript quality 0-100,
//   • emits a WARNING block the scorer is told to obey (attribute by content,
//     don't trust the labels, don't penalize talk-ratio),
//   • signals that the talk-ratio deduction should be SUPPRESSED on this call
//     (the per-speaker word counts are computed from the bad labels).
//
// Pure JS, dependency-free, cheap enough to run inline on every call.
// ═══════════════════════════════════════════════════════════════

// A speaker LABEL (not speech) that looks like a phone number → dial-in.
// Matches "+1 614-***-**76", "(614) 555-1234", "6145551234", masked forms.
const PHONE_LABEL = /(\*{2,})|(\+?\d[\d().\-\s]{6,}\d)/;

// Turn mis-attribution thresholds. Env-overridable so these can be retuned from
// Render without a deploy if the corpus shifts (e.g. a new call source).
const MISATTR_MAJOR = Number(process.env.HYGIENE_MISATTR_MAJOR || 8);
const MISATTR_MINOR = Number(process.env.HYGIENE_MISATTR_MINOR || 3);

// "00:16:56" or "16:56" → seconds. Null if unparseable.
function hmsToSec(s) {
  const parts = String(s || '').split(':').map(Number);
  if (parts.some(isNaN) || !parts.length) return null;
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return null;
}

// Parse "[hh:mm:ss] Speaker Name: utterance" → {speaker, utter, tsSec}.
// Timestamp optional; tsSec is null when absent. Field names are unchanged from
// the original version, so existing callers are unaffected by the added tsSec.
function parseLine(line) {
  if (!line || !line.trim()) return null;
  const withTs = line.match(/^\s*\[([0-9:]+)\]\s*([^:]{1,40}):\s*(.*)$/);
  if (withTs) {
    return { speaker: (withTs[2] || '').trim(), utter: (withTs[3] || '').trim(), tsSec: hmsToSec(withTs[1]) };
  }
  const noTs = line.match(/^\s*([^:\[\]]{1,40}):\s*(.*)$/);
  if (noTs) return { speaker: (noTs[1] || '').trim(), utter: (noTs[2] || '').trim(), tsSec: null };
  return null;
}

function wordCount(s) { return (String(s || '').trim().match(/\S+/g) || []).length; }

// Normalize an utterance for duplicate comparison: lowercase, strip non-alnum.
function norm(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, ''); }

// ── The analyzer ────────────────────────────────────────────────
// Returns a plain object safe to JSON.stringify and store on the call row.
function analyzeTranscriptHygiene(transcript, opts = {}) {
  const raw = String(transcript || '');
  const source = String(opts.source || '');

  const rawLines = raw.split('\n');
  const parsed = [];
  for (const ln of rawLines) { const p = parseLine(ln); if (p) parsed.push(p); }

  const labeledLines = parsed.length;
  const flags = [];

  // Empty / unparseable transcript — not our problem to flag as "dirty", just report.
  if (labeledLines < 4) {
    return {
      score: 100, grade: 'clean', isDialIn: false, suppressTalkRatio: false,
      flags: [], warning: null,
      metrics: { labeledLines, distinctSpeakers: 0, crossAttributed: 0, echoAdjacent: 0, phoneLabels: 0 },
    };
  }

  // Distinct speakers + phone-number-looking labels
  const speakerSet = new Set();
  let phoneLabels = 0;
  const phoneSpeakers = new Set();
  for (const p of parsed) {
    if (!p.speaker) continue;
    speakerSet.add(p.speaker);
    if (PHONE_LABEL.test(p.speaker)) { phoneLabels++; phoneSpeakers.add(p.speaker); }
  }
  const distinctSpeakers = speakerSet.size;

  // Cross-attribution: an utterance (>=6 normalized chars) spoken under >=2 labels.
  const bySpeaker = new Map(); // normUtter -> Set(speakers)
  let echoAdjacent = 0;
  let prevNorm = null;
  for (const p of parsed) {
    const n = norm(p.utter);
    if (n.length >= 6) {
      if (!bySpeaker.has(n)) bySpeaker.set(n, new Set());
      bySpeaker.get(n).add(p.speaker);
    }
    // Near-adjacent identical utterance (the classic echo, ~1-2 lines apart)
    if (n.length >= 6 && n === prevNorm) echoAdjacent++;
    prevNorm = n;
  }
  let crossAttributed = 0;
  for (const set of bySpeaker.values()) if (set.size >= 2) crossAttributed++;

  // ── TURN MIS-ATTRIBUTION (defect #3, added Jul 25, BROADENED Jul 27) ──────
  // A DIFFERENT failure mode from echo, and the echo detector above is blind to
  // it: in rapid back-and-forth, diarization collapses an A/B/A/B exchange onto
  // ONE speaker. Nothing is duplicated, so nothing trips the echo check — the
  // transcript just quietly attributes the lead's replies to the rep.
  //
  // TWO independent signatures. The first was built from call #2448 alone and
  // proved TOO NARROW — it missed call #2580 entirely (found 2 events where the
  // real count was 33), because #2580's mis-attribution contains no questions at
  // all. Lesson: validating only against false positives is half a validation.
  //
  // SIGNAL A — self-answered question: same speaker, a SHORT question immediately
  // followed by that same speaker giving a SHORT answer, within a couple seconds.
  // Length + gap filters separate this from a rep's legitimate RHETORICAL question
  // ("And how many people pay that off in 12 months? Very, very few.").
  //
  // SIGNAL B — orphaned backchannel: a bare acknowledgement ("Okay.", "Yeah.",
  // "Got it.") sandwiched BETWEEN two turns by the SAME speaker. A backchannel is
  // inherently a response to the OTHER party — finding one buried mid-monologue
  // means the surrounding turns were mis-assigned. This is the stronger signal by
  // far. Validated across the full corpus: Aloware 221 calls, avg 0.0, MAX 0 —
  // literally never fires on a clean source. Fathom 73 calls, avg 38.1, max 158.
  const BACKCHANNEL = /^(okay|ok|yeah|yep|yes|right|sure|got it|gotcha|mhm|exactly|absolutely|perfect|awesome|cool|nice|great|understood|correct|makes sense|sounds good|definitely|totally)[.!,]?$/i;
  let selfAnsweredQuestions = 0, orphanBackchannels = 0;
  const misattrExamples = [];
  for (let i = 0; i < parsed.length - 1; i++) {
    const a = parsed[i], b = parsed[i + 1];
    if (!a.speaker || a.speaker !== b.speaker) continue;
    if (!/\?\s*$/.test(a.utter)) continue;
    if (/\?\s*$/.test(b.utter)) continue;
    if (wordCount(a.utter) > 8 || wordCount(b.utter) > 6) continue;
    if (a.tsSec != null && b.tsSec != null && (b.tsSec - a.tsSec) > 3) continue;
    selfAnsweredQuestions++;
    if (misattrExamples.length < 2) misattrExamples.push(`"${a.utter}" → "${b.utter}"`);
  }
  for (let i = 1; i < parsed.length - 1; i++) {
    const prev = parsed[i - 1], cur = parsed[i], next = parsed[i + 1];
    if (!cur.speaker || cur.speaker !== prev.speaker || cur.speaker !== next.speaker) continue;
    if (!BACKCHANNEL.test((cur.utter || '').trim())) continue;
    orphanBackchannels++;
    if (misattrExamples.length < 3) misattrExamples.push(`"${cur.utter}" stranded inside ${cur.speaker}'s own run`);
  }
  const misattributedTurns = selfAnsweredQuestions + orphanBackchannels;

  // ── Scoring (100 = clean). Calibrated to the live Fathom corpus. ──
  let score = 100;
  const isDialIn = phoneLabels > 0;

  if (isDialIn) {
    score -= 45;
    flags.push({
      code: 'DIAL_IN',
      label: 'Phone dial-in — speaker labels unreliable',
      detail: `A speaker is labeled as a phone number (${[...phoneSpeakers][0]}). On Fathom dial-in calls the rep/lead labels are frequently SWAPPED.`,
      severity: 'high',
    });
  }

  // Echo: >=3 cross-attributed utterances is the meaningful cluster (16/32 calls).
  if (crossAttributed >= 3) {
    const pen = Math.min(45, crossAttributed * 6);
    score -= pen;
    flags.push({
      code: 'ECHO',
      label: `Echoed audio — ${crossAttributed} utterances duplicated across both speakers`,
      detail: 'Fathom transcribed the same speech twice (once per audio channel), attributing each copy to a different speaker.',
      severity: crossAttributed >= 8 ? 'high' : 'medium',
    });
  } else if (crossAttributed >= 1) {
    // Present but minor — note it, don't degrade or suppress.
    flags.push({
      code: 'ECHO_MINOR',
      label: `Minor echo — ${crossAttributed} duplicated utterance(s)`,
      detail: 'A small number of utterances appear under both speakers; unlikely to affect scoring.',
      severity: 'low',
    });
  }

  // Turn mis-attribution. Thresholds calibrated against the live corpus (see the
  // calibration run in the Jul 25 session) — set so genuinely conversational
  // calls don't trip it, but a systematically mis-attributed one does.
  if (misattributedTurns >= MISATTR_MAJOR) {
    // Penalty capped at 20 DELIBERATELY. Uncapped (35) this pushed a typical
    // Fathom call to "degraded" — and since computeCallMechanics() returns null
    // on degraded transcripts, that would have silently killed the Call Mechanics
    // panel on ~every closer call. Verified on #2448 and #2580: the mis-attribution
    // concentrates in rapid SMALL TALK, while the substantive sections (discovery,
    // objection handling, the pitch) are attributed correctly. So the transcript is
    // unreliable for WORD COUNTS but still sound for judging content — "minor" is
    // the honest grade. We still flag it loudly, still warn the model, and still
    // suppress talk-ratio; we just don't throw away a working feature over it.
    const pen = Math.min(20, misattributedTurns * 2);
    score -= pen;
    flags.push({
      code: 'MISATTRIBUTION',
      label: `Turn mis-attribution — ${misattributedTurns} exchange(s) collapsed onto one speaker`,
      detail: `Rapid back-and-forth was attributed to a single speaker (e.g. ${misattrExamples[0] || 'a reply credited to the wrong party'}). Unlike echo, nothing is duplicated — the other party's replies are silently credited to this speaker, so per-speaker word counts and "who said what" are unreliable. Substantive passages are usually still attributed correctly.`,
      severity: misattributedTurns >= MISATTR_MAJOR * 3 ? 'high' : 'medium',
    });
  } else if (misattributedTurns >= MISATTR_MINOR) {
    flags.push({
      code: 'MISATTRIBUTION_MINOR',
      label: `Minor turn mis-attribution — ${misattributedTurns} exchange(s)`,
      detail: 'A few rapid exchanges appear collapsed onto one speaker, typically in small talk. Unlikely to affect scoring of substance.',
      severity: 'low',
    });
  }

  // ── INCOMPLETE RECORDING START (defect #4, added Jul 29) ─────────
  // Fathom sometimes begins recording AFTER the call has already started. The
  // transcript still timestamps from [00:00:00], so nothing in the data reveals
  // that the opening is missing — it looks like a complete call.
  //
  // Found via a real dispute: Kevin flagged call #2835 as a follow-up. The bot
  // re-read the transcript, found no reference to a prior conversation, and
  // rejected the dispute — but the transcript's first line is the fragment
  // "Responses to that.", mid-answer. The opening, which is exactly where a
  // follow-up would be referenced, was never recorded. The bot was confidently
  // wrong about evidence it didn't know it was missing.
  //
  // DELIBERATELY SENSITIVE. Measured across the corpus: 31 of 332 calls (~9%)
  // lack any opening marker, and most are genuine mid-conversation starts,
  // though some are real openings this misses ("Yeah, I can hear you"). That
  // trade is intentional — the costs are asymmetric. Over-flagging means the bot
  // is slightly more cautious on a dispute; under-flagging means it confidently
  // rejects a rep's valid claim using evidence that was never captured.
  const OPENING_MARKER = /(hello|\bhi\b|\bhey\b|good morning|good afternoon|good evening|how are you|how's it going|thanks for|appreciate you|can you hear|this is |it's \w+ (with|from)|nice to meet|nice to see|doing well|how have you been|joining|jump(ing)? on)/i;
  const head = String(transcript || '').slice(0, 250);
  const looksIncompleteStart = parsed.length >= 4 && !OPENING_MARKER.test(head);
  if (looksIncompleteStart) {
    flags.push({
      code: 'INCOMPLETE_START',
      label: 'Recording may have started mid-conversation',
      detail: `The transcript opens without any greeting or introduction (first words: "${(parsed[0]?.utter || '').slice(0, 60)}"), which usually means recording began after the call was already underway. Anything said in the opening — including references to a previous conversation — is missing and CANNOT be inferred from this transcript.`,
      severity: 'medium',
    });
    score -= 10;
  }

  // A 1:1 call should have exactly 2 speakers. More than that on a 2-party call
  // is a diarization split (one person heard as several).
  if (distinctSpeakers > 3) {
    score -= 10;
    flags.push({
      code: 'SPEAKER_SPRAWL',
      label: `${distinctSpeakers} distinct speaker labels`,
      detail: 'More labels than participants — diarization likely split one speaker into several.',
      severity: 'low',
    });
  }

  score = Math.max(0, Math.min(100, Math.round(score)));
  const grade = score >= 90 ? 'clean' : score >= 70 ? 'minor' : 'degraded';

  // Suppress the talk-ratio deduction whenever the per-speaker split can't be trusted.
  // Mis-attribution corrupts per-speaker word counts the same way echo does —
  // the words are real, they're just credited to the wrong person.
  const suppressTalkRatio = isDialIn || crossAttributed >= 3 || misattributedTurns >= MISATTR_MAJOR;

  const warning = grade === 'clean' ? null : buildWarning({ flags, isDialIn, crossAttributed, misattributedTurns, suppressTalkRatio });

  return {
    score, grade, isDialIn, suppressTalkRatio, flags, warning,
    metrics: { labeledLines, distinctSpeakers, crossAttributed, echoAdjacent, phoneLabels, misattributedTurns, selfAnsweredQuestions, orphanBackchannels, looksIncompleteStart, source },
  };
}

// The block injected into the QC prompt so the scorer compensates for bad labels.
function buildWarning({ flags, isDialIn, crossAttributed, misattributedTurns, suppressTalkRatio }) {
  const bullets = [];
  if (isDialIn) bullets.push('- Speaker labels are partially SCRAMBLED: lines attributed to the rep may belong to the lead and vice-versa. This was a phone dial-in.');
  if (crossAttributed >= 3) bullets.push('- Some utterances are ECHOED (duplicated under BOTH speakers). Treat a repeated line as ONE utterance, not two.');
  if (misattributedTurns >= MISATTR_MAJOR) bullets.push('- Rapid back-and-forth has been COLLAPSED ONTO ONE SPEAKER: where you see the same person ask a question and immediately answer it in a short line, the answer almost certainly belongs to the OTHER party. Read those exchanges as a dialogue, not a monologue.');
  if (!bullets.length) bullets.push('- Diarization on this transcript is imperfect; speaker labels may be unreliable.');

  const lines = [
    '',
    '⚠️ TRANSCRIPT QUALITY WARNING — DIARIZATION ARTIFACTS DETECTED',
    'This transcript came from an automated system whose speaker attribution is unreliable on this call:',
    ...bullets,
    '',
    'HOW TO SCORE ANYWAY (do this — do NOT lower the score for the artifacts themselves):',
    '- Attribute each line to the rep or the lead by CONTENT and conversational logic, NOT by the printed label. (A structured sales pitch, discovery question, or price drop is the REP. A personal financial situation, an objection, or "let me think about it" is the LEAD.)',
  ];
  if (suppressTalkRatio) lines.push('- IGNORE talk-ratio / talk-balance entirely on this call — the per-speaker word counts are derived from the bad labels and are meaningless here. Do not reward or penalize talk balance.');
  lines.push('- Score the SUBSTANCE (discovery depth, qualification, objection handling, close) which is still readable despite the labels. If a stretch is genuinely unintelligible due to the artifacts, say so in coaching_notes and score conservatively on what IS clear.');
  lines.push('');
  return lines.join('\n');
}

module.exports = { analyzeTranscriptHygiene, parseLine, PHONE_LABEL };
