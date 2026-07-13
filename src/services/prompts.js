// ═══════════════════════════════════════════════════════════════
// Transcript Processing + Prompt Building
// Smart slicing for long closer calls + BNB Turnkey QC prompts
// ═══════════════════════════════════════════════════════════════

// MAX = the transcript size (chars) below which we send the WHOLE transcript to the AI.
// Claude Haiku's context window is ~200K tokens (~600K+ chars), so a typical call —
// even a 45-min closer call (~50K chars) — fits whole with room to spare. We only
// fall back to slicing for genuinely massive outliers, so the AI sees the full call
// and never misses mid-call details (discovery history, objections, qualification).
const HEAD = 3000, MID = 4000, TAIL = 5000, MAX = 50000;

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

// Two-pass (summarize the middle) only for genuinely huge transcripts that exceed the
// full-send threshold above. Kept well above MAX so normal long calls go through whole.
function needsTwoPass(chars, durSec) { return chars > 70000 || (durSec && durSec > 4200); }

function buildMiddleSummaryPrompt(fullText) {
  const mid = fullText.slice(HEAD, Math.min(fullText.length - TAIL, HEAD + 20000));
  return `You are summarizing the MIDDLE section of a BNB Turnkey sales call. This was too long to include in full.
Summarize in 300-500 words, focusing on: discovery questions asked, how the three-phase process was presented, objections raised, specific markets/properties/numbers discussed, cost segregation/tax/returns discussion, tone and engagement.
Return ONLY a summary paragraph.

MIDDLE SECTION:
${mid}`;
}

// ─── QC Prompt ───────────────────────────────────────────────
function buildQCPrompt({ role, repName, source, transcript, rubricItems, goldExamples, metrics, middleSummary, scenarioContext }) {
  const dur = isN(metrics.durationSec) ? `${metrics.durationSec}s (${Math.floor(metrics.durationSec/60)}m${metrics.durationSec%60}s)` : 'unknown';
  const parts = [
    `You are a strict sales-call QA evaluator for BNB Turnkey, a turnkey short-term rental investment service under The Rise Collective. You evaluate calls according to Sam Arnita's (CRO) sales philosophy.

COMPANY: Rise Collective is a vertically integrated real estate group managing 300+ luxury vacation rentals across 20+ states. BNB Turnkey provides end-to-end STR launch: property sourcing, design/renovation (BNB Construction), and full management (Home Team Luxury Rentals). Target clients: high-income/accredited investors. Properties: $300K-$800K+. Minimum investment: $250-300K liquid capital.

ROLES:
- SETTERS (Aloware): Qualify leads, confirm investor fit, book closer call. Calls: 5-15 min. Setters do NOT provide specific return data — that is closer territory.
- CLOSERS (Fathom/Zoom): Deep discovery, full pitch, handle objections, close. Calls: 20-60+ min. Push for one-call close — handle 2-3 objections before retreating to follow-up.

═══════════════════════════════════════════════
SAM'S SALES PHILOSOPHY (evaluate against this)
═══════════════════════════════════════════════

THE 7 SALES BELIEFS (all must be uncovered in a 10/10 call):
1. PAIN — What are their individual problems? (deep dive: 3 major pain points, 3-5 logical questions each + 2-3 emotional questions)
2. DOUBT — What has held them back from doing this themselves?
3. DESIRE — What goals are they hoping to accomplish? (deep dive: 3 major desires, 3-5 logical questions each + 2-3 emotional questions)
4. COST — How much has this cost them in time, money, or resources?
5. MONEY — How much are they looking to invest and how? (must confirm $250-300K+ liquid capital)
6. SUPPORT — Are spouses, partners, or investors involved?
7. TRUST — Why us compared to other companies?

FRAME CONTROL (target: 80% expert frame / 20% equal frame):
- EXPERT FRAME: Rep leads like a doctor with a patient. Proactive, asks structured questions, doesn't get derailed. THIS IS WHAT WE WANT.
- EQUAL FRAME: Friendly/buddy frame. Builds connection but weaker authority. Use sparingly for rapport.
- INFERIOR FRAME: Rep edifies prospect above themselves. WORST — prospect won't trust rep to invest.

OBJECTION HANDLING FRAMEWORK (must use all steps):
1. ISOLATE — "Is that the only thing holding you back?"
2. HYPOTHETICAL REMOVE — "If we could solve that, would you move forward?"
3. CLARIFY — Ask questions to understand root cause
4. HANDLE — Provide specific solution
5. LOOP — If more objections, repeat the framework

SAM'S HARD RULES (automatic failures):
- Discovery under 5 minutes = auto-fail (has_discovery: false)
- No financial qualification ($250-300K capital check) = auto-fail (financial_qualification: false)
- No objection handling after price drop = auto-fail (handled_objections: false)

SAM'S MAJOR PENALTIES:
- Discovery under 8 minutes = -1 point
- Pitch not tailored to specific pain points/desires uncovered = -1 (tailored_pitch: false)
- Skipping steps in objection framework = -1

WHAT SAM VALUES MOST:
- STRONG DISCOVERY: "Whatever the rep tolerates in discovery becomes an objection at the end." Discovery is the most important phase.
- ONE-CALL CLOSE: Push for close, handle 2-3 objections before accepting a follow-up
- EXPERT FRAME: 80% expert / 20% equal. Rep leads the call.
- TEMPERATURE CHECK: 10/10 before price drop with all 7 Beliefs covered = excellent call. 7-8 with client confusion on next steps = decent. 5-6 with heavy pitch and light discovery = weak.

RULES: Score 0-10 strictly. Do not inflate. Missing evidence = score conservatively. Partial transcript = note in coaching_notes.`,
    '',
    `Evaluate this ${role} call for rep: ${repName}. Source: ${source}.`,
    `\nCALL METRICS:\n- Duration: ${dur}\n- Agent talk: ${isN(metrics.agentTalkPct) ? metrics.agentTalkPct + '%' : 'unknown'}\n- Contact talk: ${isN(metrics.contactTalkPct) ? metrics.contactTalkPct + '%' : 'unknown'}`,
    `\nSCORING ADJUSTMENTS:`,
  ];

  if (isN(metrics.agentTalkPct) && metrics.agentTalkPct > 80) parts.push('- Agent >80%: reduce by 1, note talk-balance');
  if (isN(metrics.agentTalkPct) && metrics.agentTalkPct < 20) parts.push('- Agent <20%: reduce by 1, note engagement');
  parts.push('- No explicit next step = clear_next_step: false');
  parts.push('- Duration does NOT cap the score. If this is a real sales call, score the content on its merits.');

  parts.push('\nRUBRIC:');
  (rubricItems || []).forEach(r => {
    parts.push(`[${r.category}] Weight:${r.weight}/100 GOOD:${r.good} BAD:${r.bad}`);
    if (r.score_10) parts.push(`  9-10: ${r.score_10}`);
    if (r.score_5) parts.push(`  5-6: ${r.score_5}`);
    if (r.score_1) parts.push(`  1-3: ${r.score_1}`);
  });

  if (middleSummary) parts.push(`\nMIDDLE SECTION SUMMARY (long call — AI summary of middle portion):\n${middleSummary}`);
  if (scenarioContext) parts.push(scenarioContext);

  parts.push(`
Return ONLY valid JSON (no markdown). Schema:
{
  "overall_score": 0-10,
  "category_scores": {
    "discovery": 0-10,
    "qualification": 0-10,
    "pitch": 0-10,
    "frame_control": 0-10,
    "objections_close": 0-10
  },
  "pass_fail": {
    "has_discovery": true/false,
    "financial_qualification": true/false,
    "handled_objections": true/false,
    "tailored_pitch": true/false,
    "covered_7_beliefs": true/false,
    "expert_frame": true/false,
    "clear_next_step": true/false,
    "explained_offer": true/false,
    "qualified_investor_fit": true/false
  },
  "beliefs_covered": {
    "pain": true/false,
    "doubt": true/false,
    "desire": true/false,
    "cost": true/false,
    "money": true/false,
    "support": true/false,
    "trust": true/false
  },
  "frame_assessment": "expert|equal|inferior|mixed",
  "temperature_check": "10/10 | 7-8/10 | 5-6/10 | not-taken",
  "quick_summary": "2-3 sentences",
  "strengths": ["max 3"],
  "improvements": ["max 3 — reference Sam's philosophy if relevant"],
  "next_step_text": "exact next step or empty",
  "coaching_notes": "detailed paragraph citing Sam's philosophy where relevant",
  "golden_moments": [{"timestamp":"mm:ss","quote":"short","why_it_matters":"coaching relevance"}],
  "confidence": "high|medium|low",
  "confidence_reason": "1 sentence why",
  "outcome_tag": "DISQUALIFIED|NOT_READY|LONG_TERM_NURTURE|INFO_SEEKER|SHORT_TERM_NURTURE|REDZONE_HOT|HARD_NO|NONE",
  "outcome_tag_reason": "1 sentence citing the SPECIFIC stated blocker or signal from the transcript",
  "cross_sell_tags": ["HOTEL_TURNKEY_LEAD|BNB_LENDING_LEAD|INVESTOR_ACADEMY_LEAD|SURGE_TAX_LEAD|HOME_TEAM_MGMT_LEAD|REALTY_LEAD"],
  "cross_sell_reason": "1 sentence per tag, or empty if none"
}

═══════════════════════════════════════════════
OUTCOME TAG — read this carefully, it is important
═══════════════════════════════════════════════
Separately from the SCORE, identify WHY this call ended the way it did. The score judges the REP's execution. The outcome tag describes the LEAD's state. Do not conflate them.

THE TEST: "Could a great rep have advanced this lead TODAY?"
- NO — the lead had a real, stated blocker → tag it (the rep exercised correct judgment).
- YES, but this rep didn't → "NONE" (that is a performance issue; the score already reflects it).

TAGS THAT MEAN THE LEAD COULDN'T BE CLOSED (rep judged correctly):
- DISQUALIFIED: hard blocker — insufficient capital, wrong profile, cannot proceed, not a real investor. Rep correctly disqualified instead of pitching on.
- NOT_READY: real, interested, plausible fit — but CANNOT act now for a CONCRETE STATED reason (capital tied up, mid-transaction, awaiting a liquidity event). Rep parked them near-term.
- LONG_TERM_NURTURE: same, but the horizon is LONG or indefinite (locked in for years, needs a major life/financial change). Rep appropriately parked long-term.
- INFO_SEEKER: caller only wanted INFORMATION. Never a buyer, no investment intent, no capital discussion. Rep answered helpfully and correctly did not force a pitch on a non-buyer.

TAGS THAT MEAN A REAL SALES ATTEMPT HAPPENED (still the rep's performance):
- SHORT_TERM_NURTURE: real pitch, lead is close, needs a bit more time/info, near-term follow-up booked.
- REDZONE_HOT: lead is HOT, close is imminent, strong buying signals. This is an EXCELLENT call.
- HARD_NO: rep pitched a viable, present lead and the client firmly declined.

CRITICAL RULES:
1. A WEAK CALL IS NEVER A DISQUALIFICATION. If the lead was viable and present but the rep skipped discovery, gave a generic pitch, or folded on an objection — that is "NONE". The rep underperformed; do not let them off the hook.
2. The blocker must be CONCRETE and STATED BY THE LEAD. "Seemed lukewarm" or "wasn't feeling it" is NOT a blocker. "I just sold my company and I'm locked in for four years" IS.
3. WHEN IN DOUBT, RETURN "NONE". It is far better to score a borderline call than to let a weak call escape scoring.

═══════════════════════════════════════════════
CROSS-SELL SIGNALS (The Rise Collective ecosystem)
═══════════════════════════════════════════════
A lead who is wrong for BNB Turnkey may be RIGHT for a sister brand. This is additive and independent of the outcome tag — a call can be DISQUALIFIED for BNB Turnkey AND a great BNB Lending lead. Flag any that clearly apply:
- BNB_LENDING_LEAD: financing/rates/lending is the real blocker ("I'd do it but financing is brutal").
- INVESTOR_ACADEMY_LEAD: wants to learn or do it themselves ("I want to understand this myself first").
- SURGE_TAX_LEAD: tax burden is the driving pain (heavy write-off / cost-seg motivation, big tax bill).
- HOME_TEAM_MGMT_LEAD: already owns STR(s) but self-manages or has a bad manager.
- HOTEL_TURNKEY_LEAD: interested in a larger/commercial property or a boutique hotel.
- REALTY_LEAD: wants to buy in a Home Team Realty market (Phoenix AZ, Pinellas County FL, Texas Gulf Coast).
Only flag a cross-sell tag when the lead ACTUALLY SAID something that supports it. Return an empty array if none apply.

PASS/FAIL GUIDANCE:
- has_discovery: true if discovery was substantive (5+ min for closer, 2+ min for setter)
- financial_qualification: true if rep confirmed $250K+ liquid capital (specifically or implicitly)
- handled_objections: true if rep handled 2+ objections using the framework after price drop (closer only; setters: true if N/A)
- tailored_pitch: true if pitch referenced specific pain/desires client mentioned
- covered_7_beliefs: true if 6 or 7 of the 7 Beliefs were addressed (closer only; setters: true if at least pain + desire + money)
- expert_frame: true if rep held expert frame 70%+ of the call

TRANSCRIPT:
${transcript}`);

  return parts.join('\n');
}

function isN(v) { return typeof v === 'number' && isFinite(v); }

module.exports = { buildSmartSlice, needsTwoPass, buildMiddleSummaryPrompt, buildQCPrompt };
