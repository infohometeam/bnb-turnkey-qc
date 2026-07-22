// ═══════════════════════════════════════════════════════════════
// Transcript Processing + Prompt Building
// Smart slicing for long closer calls + BNB Turnkey QC prompts
// ═══════════════════════════════════════════════════════════════

// MAX = the transcript size (chars) below which we send the WHOLE transcript to the AI.
//
// ⚠️ HISTORY: this was 50,000 — which silently truncated long calls to ~12,056 chars
// (head 3K + keyword-picked middle 4K + tail 5K). Measured Jul 2026: 66 of 219 scored
// calls were cut, the model seeing as little as 12% of the conversation. A 76-minute
// call (101,441 chars) was scored on 12% of itself. Affected EVERY rep, not just closers.
//
// Claude Haiku 4.5 has a 200,000-token context (~800K chars). Our largest transcript
// ever is 101,441 chars ≈ 25K tokens — ~175K tokens of headroom. The cap was never
// necessary. MAX now set so every realistic call goes WHOLE: 400,000 chars ≈ 100K
// tokens, still only half the context, leaving ample room for the rubric and response.
//
// Cost of sending a full transcript instead of a slice: ~$0.022 more per long call.
// A smarter model cannot read text that was never sent to it.
const HEAD = 3000, MID = 4000, TAIL = 5000, MAX = 400000;

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

// Two-pass (summarize the middle) only for transcripts genuinely too large to send
// whole. Kept ABOVE MAX so normal calls — including 60–90 minute closer calls — always
// go through in full. Previously 70,000 chars, which fired on ordinary closer calls.
function needsTwoPass(chars, durSec) { return chars > MAX || (durSec && durSec > 18000); }

function buildMiddleSummaryPrompt(fullText) {
  // No internal cap: this only runs for transcripts above MAX (400K chars), and the
  // whole point is that nothing gets silently dropped. Summarise the ENTIRE middle.
  const mid = fullText.slice(HEAD, Math.max(HEAD, fullText.length - TAIL));
  return `You are summarizing the MIDDLE section of a BNB Turnkey sales call. This was too long to include in full.
Summarize in 300-500 words, focusing on: discovery questions asked, how the three-phase process was presented, objections raised, specific markets/properties/numbers discussed, cost segregation/tax/returns discussion, tone and engagement.
Return ONLY a summary paragraph.

MIDDLE SECTION:
${mid}`;
}

// ─── QC Prompt ───────────────────────────────────────────────
function buildQCPrompt({ role, repName, source, transcript, rubricItems, goldExamples, metrics, middleSummary, scenarioContext, transcriptQualityWarning }) {
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

  // When diarization is unreliable, the talk-% is derived from bad speaker labels —
  // suppress the talk-balance hints here so they don't contradict the quality warning.
  if (!transcriptQualityWarning) {
    if (isN(metrics.agentTalkPct) && metrics.agentTalkPct > 80) parts.push('- Agent >80%: reduce by 1, note talk-balance');
    if (isN(metrics.agentTalkPct) && metrics.agentTalkPct < 20) parts.push('- Agent <20%: reduce by 1, note engagement');
  }
  parts.push('- No explicit next step = clear_next_step: false');

  // Transcript-quality warning goes HIGH in the prompt so the scorer reads it before judging.
  if (transcriptQualityWarning) parts.push(transcriptQualityWarning);
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
  "list_summary": "ONE short line, max 120 chars — see LIST SUMMARY rules below",
  "strengths": ["max 3"],
  "improvements": ["max 3 — reference Sam's philosophy if relevant"],
  "next_step_text": "exact next step or empty",
  "coaching_notes": "detailed paragraph citing Sam's philosophy where relevant",
  "golden_moments": [{"timestamp":"mm:ss","speaker":"rep|lead","category":"discovery|qualification|pitch|frame_control|objections_close","quote":"short verbatim quote from the transcript","why_it_matters":"2-3 full sentences (see GOLDEN MOMENTS rules below)"}],
  "tough_moments": [{"timestamp":"mm:ss","speaker":"rep|lead","quote":"short verbatim quote from the transcript","why_it_was_tough":"what went wrong / was hard here","what_to_do_instead":"the concrete better move (see TOUGH MOMENTS rules below)"}],
  "confidence": "high|medium|low",
  "confidence_reason": "1 sentence why",
  "outcome_tag": "DISQUALIFIED|NOT_READY|LONG_TERM_NURTURE|INFO_SEEKER|SHORT_TERM_NURTURE|REDZONE_HOT|HARD_NO|SET|CLOSED_WON|NONE",
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

TAGS THAT MEAN A REAL WIN HAPPENED (role-specific — read the strict bar carefully):
- SET (Setter calls only): the lead showed genuine buying signals AND the rep booked a CONFIRMED closer call with a specific date/time. A vague "I'll think about it, maybe call me back" is NOT this — that's SHORT_TERM_NURTURE or NONE.
- CLOSED_WON (Closer calls only): payment was ACTUALLY PROCESSED OR CONFIRMED LIVE, DURING THIS CALL — card charged, payment confirmed on the line. This is NOT verbal agreement to proceed, NOT "I'll send you the agreement to sign," NOT "let's get payment sorted this week," and NOT "we're good, I'll process this tomorrow." If the lead agreed to move forward but payment or signing happens after the call ends — even later the same day — use REDZONE_HOT or SHORT_TERM_NURTURE instead. The transcript must show the payment actually happening, not just being discussed.

CRITICAL RULES:
1. A WEAK CALL IS NEVER A DISQUALIFICATION. If the lead was viable and present but the rep skipped discovery, gave a generic pitch, or folded on an objection — that is "NONE". The rep underperformed; do not let them off the hook.
2. The blocker must be CONCRETE and STATED BY THE LEAD. "Seemed lukewarm" or "wasn't feeling it" is NOT a blocker. "I just sold my company and I'm locked in for four years" IS.
3. WHEN IN DOUBT, RETURN "NONE". It is far better to score a borderline call than to let a weak call escape scoring.
4. SET and CLOSED_WON require CONCRETE evidence IN THE TRANSCRIPT ITSELF — a confirmed booking with a date/time for SET, or live payment confirmation for CLOSED_WON. A call that merely sounds positive is not enough. When in doubt, do NOT use these two tags.

═══════════════════════════════════════════════
CROSS-SELL SIGNALS (The Rise Collective ecosystem)
═══════════════════════════════════════════════

⚠️ THE GOVERNING RULE — READ THIS BEFORE TAGGING ANYTHING:
A cross-sell tag fires ONLY when the lead needs something that BNB TURNKEY DOES NOT ALREADY PROVIDE.

BNB Turnkey ALREADY delivers, as part of its core offering:
- **Tax benefits** — cost segregation, bonus depreciation, W-2/income offset for high earners. This is a HEADLINE selling point of the pitch.
- **Property sourcing** — data-driven market analysis and acquisition in their markets.
- **Financing** — via BNB Lending, in-house.
- **Explaining how STR investing works** — that is what discovery and the pitch ARE.
- **Full management** — via Home Team, included in the turnkey package.

Therefore, the following are NORMAL BNB TURNKEY CONVERSATION and are **NOT** cross-sell signals. DO NOT TAG THEM:
✗ "I want the tax write-offs / depreciation / cost seg" → that IS the pitch. NOT a Surge Tax lead.
✗ "My tax bill is huge, I need to offset income" → that is WHY they are buying an STR. NOT a Surge Tax lead.
✗ "How does this work? Walk me through it." → normal discovery. NOT an Investor Academy lead.
✗ "I want to buy in Phoenix / Florida / the Gulf Coast" → BNB Turnkey sources properties. NOT a Realty lead.
✗ "What are the financing options?" → BNB Lending is in-house. NOT a cross-sell.
✗ Any interest in returns, cash flow, or appreciation → that is the core product.

Only tag when the lead's need sits OUTSIDE the turnkey package:

- SURGE_TAX_LEAD: they need tax/accounting help BEYOND the STR itself — e.g. business or entity tax strategy, an ongoing CPA/tax-advisor relationship, a complex tax situation the STR purchase alone won't solve. NOT merely wanting STR tax benefits.
- INVESTOR_ACADEMY_LEAD: they explicitly want to LEARN AND DO IT THEMSELVES instead of buying turnkey ("I'd rather learn to do this on my own", "I want to self-manage and build this myself"). NOT merely asking how the process works.
- BNB_LENDING_LEAD: financing is a DISTINCT, STANDALONE need — e.g. they want lending for a property outside BNB Turnkey, or they need a lender relationship separate from a turnkey purchase. NOT merely discussing how they'd fund this deal.
- HOME_TEAM_MGMT_LEAD: they ALREADY OWN STR property and want MANAGEMENT ONLY — they are not buying a turnkey property. This is a genuinely different product.
- HOTEL_TURNKEY_LEAD: interested in a boutique hotel or a larger commercial property, not a single-family STR. A different asset class.
- REALTY_LEAD: they want traditional real-estate brokerage for a NON-STR purchase (a primary residence, a long-term rental, a straight buy/sell). NOT sourcing an STR — BNB Turnkey does that.

TEST BEFORE YOU TAG: "Is this something BNB Turnkey already includes?" If YES → do not tag. If the lead needs a genuinely DIFFERENT product or service from a sister brand → tag it.

When in doubt, return an empty array. A false cross-sell lead wastes another team's time and erodes trust in the whole signal.

═══════════════════════════════════════════════
LIST SUMMARY — the one-line scannable version
═══════════════════════════════════════════════
"list_summary" is a SINGLE line, **max 120 characters**, written for a dense table row where someone is scanning dozens of calls at once. It is NOT a shortened quick_summary — it answers "what happened on this call?" at a glance.
- Lead with the OUTCOME or the defining moment, not with setup. "Booked closer call for Friday; strong discovery, no financial qual." not "The rep spoke with the prospect about..."
- No preamble, no rep/client names (the row already shows them), no trailing period needed.
- Be concrete and specific to THIS call. Never generic filler like "solid call with good rapport."
- If the call went nowhere, say so plainly: "Prospect ghosted after pricing; no next step set."

═══════════════════════════════════════════════
GOLDEN MOMENTS — attribution + explanation rules
═══════════════════════════════════════════════
A golden moment is a genuinely instructive line from the call — usually something the REP did well and worth teaching, occasionally a revealing thing the LEAD said that the rep handled (or should have handled).
- "speaker": who actually said the quote — "rep" or "lead". Judge by CONTENT, not by the transcript's speaker label (labels can be wrong on dial-in calls). A pitch, discovery question, reframe, or objection-handle is the rep; a buying signal, objection, or personal disclosure is the lead.
- "quote": a short VERBATIM excerpt (a sentence or two), not a paraphrase.
- "category": which SKILL this moment demonstrates — exactly one of: discovery, qualification, pitch, frame_control, objections_close. Use the rubric category the moment best exemplifies, so reps can find "a great discovery question" or "a clean objection handle" by skill. Pick the dominant skill; don't hedge.
- "why_it_matters": 2-3 FULL sentences. Name the specific technique or Belief it demonstrates (e.g. "isolates the objection before handling", "builds the DESIRE belief", "holds expert frame"), say what made it effective, and give the coaching takeaway another rep could copy. Do NOT write a vague phrase like "good rapport" — be concrete and instructional.
Return 1-4 of the most instructive moments (fewer is fine). Skip filler.

═══════════════════════════════════════════════
TOUGH MOMENTS — the coaching counterpart to golden moments
═══════════════════════════════════════════════
A tough moment is a point in the call the rep should learn from: a missed discovery thread, a fumbled or dodged objection, a buying signal talked past, a broken expert frame, a price drop with no isolation, over-talking, or folding under pressure. It can also be a hard thing the LEAD threw at the rep that exposed a gap.
- "speaker": who said the quote — "rep" or "lead" — judged by CONTENT, not the transcript label.
- "quote": a short VERBATIM excerpt (a sentence or two).
- "why_it_was_tough": name the specific miss and the Belief/framework step it maps to (e.g. "objection not isolated before handling", "let the DOUBT belief go unaddressed", "dropped the expert frame").
- "what_to_do_instead": the concrete better move another rep could copy next time — a specific line, question, or framework step, not "be more confident".
Return 0-4 tough moments. If the call was genuinely strong with nothing to flag, return an empty array — do NOT invent problems. Be honest and specific; this is for development, never to shame.

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
