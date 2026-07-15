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

// Parse "[hh:mm:ss] Speaker Name: utterance" → {speaker, utter}. Timestamp optional.
function parseLine(line) {
  if (!line || !line.trim()) return null;
  const withTs = line.match(/^\s*\[[0-9:]+\]\s*([^:]{1,40}):\s*(.*)$/);
  const noTs = withTs ? null : line.match(/^\s*([^:\[\]]{1,40}):\s*(.*)$/);
  const m = withTs || noTs;
  if (!m) return null;
  return { speaker: (m[1] || '').trim(), utter: (m[2] || '').trim() };
}

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
  const suppressTalkRatio = isDialIn || crossAttributed >= 3;

  const warning = grade === 'clean' ? null : buildWarning({ flags, isDialIn, crossAttributed, suppressTalkRatio });

  return {
    score, grade, isDialIn, suppressTalkRatio, flags, warning,
    metrics: { labeledLines, distinctSpeakers, crossAttributed, echoAdjacent, phoneLabels, source },
  };
}

// The block injected into the QC prompt so the scorer compensates for bad labels.
function buildWarning({ flags, isDialIn, crossAttributed, suppressTalkRatio }) {
  const bullets = [];
  if (isDialIn) bullets.push('- Speaker labels are partially SCRAMBLED: lines attributed to the rep may belong to the lead and vice-versa. This was a phone dial-in.');
  if (crossAttributed >= 3) bullets.push('- Some utterances are ECHOED (duplicated under BOTH speakers). Treat a repeated line as ONE utterance, not two.');
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
