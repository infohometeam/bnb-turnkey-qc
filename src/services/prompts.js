// ═══════════════════════════════════════════════════════════════
// Transcript Processing + Prompt Building
// Smart slicing for long closer calls + BNB Turnkey QC prompts
// ═══════════════════════════════════════════════════════════════

const HEAD = 3000, MID = 4000, TAIL = 5000, MAX = 12000;

const KEYWORDS = [
  'portfolio','investment','investor','goals','timeline','budget','accredited',
  'cash flow','cash-on-cash','financing','pre-approved','lending','bnb lending',
  'down payment','closing costs','management fee','turnkey','three phase',
  'home team','bnb construction','cost segregation','depreciation','tax benefit',
  'property management','guest experience','airbnb','str','short-term rental',
  'vacation rental','design','furnish','concern','worried','risk','market',
  'interest rate','competition','expensive','guarantee','next step','agreement',
  'sign','deposit','calendar','schedule','ready','move forward','commit',
];

function buildSmartSlice(text) {
  const t = String(text || '');
  if (t.length <= MAX) return t;
  const head = t.slice(0, HEAD);
  const tail = t.slice(-TAIL);
  const midStart = HEAD, midEnd = t.length - TAIL;
  if (midEnd <= midStart) return head + '\n...[MIDDLE_OMITTED]...\n' + tail;
  const midText = t.slice(midStart, midEnd);
  const best = findDensest(midText, MID);
  return head + '\n...[SKIPPED_TO_KEY_SECTION]...\n' + best + '\n...[SKIPPED_TO_END]...\n' + tail;
}

function findDensest(text, size) {
  if (text.length <= size) return text;
  const lower = text.toLowerCase();
  const step = Math.max(500, size >> 2);
  let bestStart = 0, bestScore = -1;
  for (let i = 0; i <= text.length - size; i += step) {
    const win = lower.slice(i, i + size);
    let score = 0;
    for (const kw of KEYWORDS) { let idx = 0; while ((idx = win.indexOf(kw, idx)) !== -1) { score++; idx += kw.length; } }
    score += (win.match(/\n\[/g) || []).length * 0.5;
    if (score > bestScore) { bestScore = score; bestStart = i; }
  }
  return text.slice(bestStart, bestStart + size);
}

function needsTwoPass(chars, durSec) { return chars > 40000 || (durSec && durSec > 2700); }

function buildMiddleSummaryPrompt(fullText) {
  const mid = fullText.slice(HEAD, Math.min(fullText.length - TAIL, HEAD + 20000));
  return `You are summarizing the MIDDLE section of a BNB Turnkey sales call. This was too long to include in full.
Summarize in 300-500 words, focusing on: discovery questions asked, how the three-phase process was presented, objections raised, specific markets/properties/numbers discussed, cost segregation/tax/returns discussion, tone and engagement.
Return ONLY a summary paragraph.

MIDDLE SECTION:
${mid}`;
}

// ─── QC Prompt ───────────────────────────────────────────────
function buildQCPrompt({ role, repName, source, transcript, rubricItems, goldExamples, metrics, middleSummary }) {
  const dur = isN(metrics.durationSec) ? `${metrics.durationSec}s (${Math.floor(metrics.durationSec/60)}m${metrics.durationSec%60}s)` : 'unknown';
  const parts = [
    `You are a strict sales-call QA evaluator for BNB Turnkey, a turnkey short-term rental investment service under The Rise Collective.

COMPANY: Rise Collective is a vertically integrated real estate group managing 300+ luxury vacation rentals across 20+ states. BNB Turnkey provides end-to-end STR launch: property sourcing, design/renovation (BNB Construction), and full management (Home Team Luxury Rentals). Target clients: high-income/accredited investors. Properties: $300K-$800K+.

ROLES:
- SETTERS (Aloware): Qualify leads, confirm investor fit, book closer call. Calls: 5-15 min.
- CLOSERS (Fathom/Zoom): Deep discovery, full pitch, handle objections, close. Calls: 20-60+ min.

RULES: Score 0-10 strictly. Do not inflate. Missing evidence = score conservatively. Partial transcript = note in coaching_notes.`,
    '',
    `Evaluate this ${role} call for rep: ${repName}. Source: ${source}.`,
    `\nCALL METRICS:\n- Duration: ${dur}\n- Agent talk: ${isN(metrics.agentTalkPct) ? metrics.agentTalkPct + '%' : 'unknown'}\n- Contact talk: ${isN(metrics.contactTalkPct) ? metrics.contactTalkPct + '%' : 'unknown'}`,
    `\nSCORING ADJUSTMENTS:`,
  ];

  if (isN(metrics.durationSec) && metrics.durationSec < 60) parts.push('- Duration <60s: cap overall at 4');
  else if (isN(metrics.durationSec) && metrics.durationSec < 180) parts.push('- Duration <3min: cap at 6 unless reschedule/confirmation');
  if (isN(metrics.agentTalkPct) && metrics.agentTalkPct > 80) parts.push('- Agent >80%: reduce by 1, note talk-balance');
  if (isN(metrics.agentTalkPct) && metrics.agentTalkPct < 20) parts.push('- Agent <20%: reduce by 1, note engagement');
  parts.push('- No explicit next step = clear_next_step: false');

  parts.push('\nRUBRIC:');
  (rubricItems || []).forEach(r => {
    parts.push(`[${r.category}] Weight:${r.weight}/100 GOOD:${r.good} BAD:${r.bad}`);
    if (r.score_10) parts.push(`  9-10: ${r.score_10}`);
    if (r.score_1) parts.push(`  1-3: ${r.score_1}`);
  });

  if (middleSummary) parts.push(`\nMIDDLE SECTION SUMMARY (long call — AI summary of middle portion):\n${middleSummary}`);

  parts.push(`
Return ONLY valid JSON (no markdown). Schema:
{"overall_score":0-10,"category_scores":{"discovery":0-10,"qualification":0-10,"pitch":0-10,"objections":0-10,"close_next_step":0-10},"pass_fail":{"clear_next_step":true/false,"explained_offer":true/false,"qualified_investor_fit":true/false},"quick_summary":"2-3 sentences","strengths":["max 3"],"improvements":["max 3"],"next_step_text":"exact next step or empty","coaching_notes":"detailed paragraph","golden_moments":[{"timestamp":"mm:ss","quote":"short","why_it_matters":"coaching relevance"}]}

TRANSCRIPT:
${transcript}`);

  return parts.join('\n');
}

function isN(v) { return typeof v === 'number' && isFinite(v); }

module.exports = { buildSmartSlice, needsTwoPass, buildMiddleSummaryPrompt, buildQCPrompt };
