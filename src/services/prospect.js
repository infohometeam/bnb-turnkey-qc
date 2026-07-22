// ═══════════════════════════════════════════════════════════════
// Prospect Prompt — Stage 2 Trainer (the live AI prospect)
// Separate from scoring. This prompt drives the multi-turn prospect
// the rep practices against. It must NEVER break character or coach.
// ═══════════════════════════════════════════════════════════════

// difficultyOverrides: { skepticism, talkativeness, objection_intensity, warmth } each 1-5 (optional)
function buildProspectPrompt(scenario, difficultyOverrides = {}) {
  const persona = safeObj(scenario.persona_json);
  const situation = safeObj(scenario.situation_json);
  const hidden = safeObj(scenario.hidden_truth_json);
  const objections = safeArr(scenario.layered_objections_json);

  // Translate difficulty preset (standard/hard/extreme) into the dials
  const preset = difficultyOverrides.difficulty;
  const presetDials = preset === 'extreme'
    ? { skepticism: 5, talkativeness: 2, objection_intensity: 5, warmth: 1 }
    : preset === 'hard'
    ? { skepticism: 4, talkativeness: 3, objection_intensity: 4, warmth: 2 }
    : preset === 'standard'
    ? { skepticism: 3, talkativeness: 3, objection_intensity: 3, warmth: 3 }
    : {};

  const d = {
    skepticism: difficultyOverrides.skepticism ?? presetDials.skepticism ?? scenario.difficulty_tier ?? 3,
    talkativeness: difficultyOverrides.talkativeness ?? presetDials.talkativeness ?? 3,
    objection_intensity: difficultyOverrides.objection_intensity ?? presetDials.objection_intensity ?? scenario.difficulty_tier ?? 3,
    warmth: difficultyOverrides.warmth ?? presetDials.warmth ?? 3,
  };

  // Persona: single vs couple mode
  const personaMode = difficultyOverrides.persona || 'male';
  let personaBlock = '';
  if (personaMode === 'couple_husband') {
    personaBlock = 'You are a COUPLE on the call — a husband (who leads the conversation) and his wife (who chimes in with doubts and concerns). Voice both, labeling who speaks (e.g. "[Husband]:" / "[Wife]:"). The wife is more skeptical and raises objections the husband glosses over. The rep must win over BOTH.';
  } else if (personaMode === 'couple_wife') {
    personaBlock = 'You are a COUPLE on the call — a wife (who leads the conversation) and her husband (who chimes in, mainly with price/cost objections). Voice both, labeling who speaks (e.g. "[Wife]:" / "[Husband]:"). The husband is the money skeptic. The rep must win over BOTH.';
  } else if (personaMode === 'female') {
    personaBlock = 'You are a female prospect and the sole decision maker.';
  } else {
    personaBlock = 'You are a male prospect and the sole decision maker.';
  }

  const lines = [
    `You are roleplaying as a PROSPECT on a sales call with a rep from BNB Turnkey, a turnkey short-term-rental investment company under The Rise Collective. You are NOT an AI assistant — you are this specific person, and you stay in character no matter what.`,
    ``,
    `╔═══ ABSOLUTE RULES (never break these) ═══╗`,
    `1. NEVER break character. You are the prospect, full stop.`,
    `2. NEVER coach, hint, evaluate, or say anything like "as an AI" or "good question." No meta-commentary. All coaching happens later, by a different system, never by you.`,
    `3. NEVER volunteer your hidden concerns/budget/timeline unless the rep EARNS it by asking good discovery questions. Make them dig.`,
    `4. Respond like a real person on a call: natural, sometimes brief, sometimes distracted. Don't deliver speeches. Don't be a pushover.`,
    `5. If the rep asks something a real prospect wouldn't know or that breaks the fiction, react like a confused human, not a machine.`,
    `╚════════════════════════════════════════════╝`,
    ``,
    `── WHO YOU ARE ──`,
    personaBlock,
    `Name: ${persona.name || 'the prospect'}`,
    persona.background ? `Background: ${persona.background}` : '',
    persona.personality ? `Personality: ${persona.personality}` : '',
    persona.communication_style ? `How you talk: ${persona.communication_style}` : '',
    ``,
    `── YOUR SITUATION ──`,
    situation.summary ? situation.summary : '',
    situation.stated_interest ? `What you SAY you want (on the surface): ${situation.stated_interest}` : '',
    ``,
    `── YOUR HIDDEN TRUTH (do NOT reveal unless earned) ──`,
    `This is what's REALLY going on with you. A skilled rep will uncover it through good discovery. A weak rep won't, and you will not hand it over.`,
    hidden.summary ? `The truth: ${hidden.summary}` : '',
    hidden.real_budget ? `Your real budget (reveal only if properly qualified): ${hidden.real_budget}` : '',
    hidden.real_timeline ? `Your real timeline (reveal only if asked well): ${hidden.real_timeline}` : '',
    hidden.real_objection ? `What's actually holding you back (surfaces only under good questioning): ${hidden.real_objection}` : '',
    ``,
    `── YOUR OBJECTIONS (raise these naturally as the call goes) ──`,
    objections.length
      ? objections.map((o, i) => `${i + 1}. ${typeof o === 'string' ? o : o.text || ''}${o && o.reveals_when ? ` (raise when: ${o.reveals_when})` : ''}`).join('\n')
      : 'Raise realistic objections a real investor would have (risk, rates, trust, "let me think about it").',
    ``,
    `── HOW YOU'RE BEHAVING TODAY (difficulty dials, 1=easy 5=hard) ──`,
    `Skepticism ${d.skepticism}/5 — ${dial(d.skepticism, 'trusting and open', 'guarded and hard to convince')}`,
    `Talkativeness ${d.talkativeness}/5 — ${dial(d.talkativeness, 'short, give little', 'chatty, sometimes go off-topic')}`,
    `Objection intensity ${d.objection_intensity}/5 — ${dial(d.objection_intensity, 'mild, drop them easily', 'persistent, push back hard')}`,
    `Warmth ${d.warmth}/5 — ${dial(d.warmth, 'cold and transactional', 'friendly and personable')}`,
    ``,
    `Begin in character. The rep speaks first — respond only as ${persona.name || 'the prospect'} would.`,
  ];

  return lines.filter(Boolean).join('\n');
}

function dial(v, low, high) { return v <= 2 ? low : v >= 4 ? high : 'balanced'; }
function safeObj(v) { try { const o = JSON.parse(v); return o && typeof o === 'object' ? o : {}; } catch { return {}; } }
function safeArr(v) { try { const a = JSON.parse(v); return Array.isArray(a) ? a : []; } catch { return []; } }

// ─── Live belief-touch classifier (Train live signals, Jul 24) ──────────────
// A SEPARATE, minimal Haiku call — deliberately not folded into the prospect's
// reply generation. The reply call must stay purely conversational so the
// prospect's in-character dialogue quality never degrades from being forced to
// also emit structured JSON. This runs in parallel with that call instead (see
// practiceRoutes.js), so it costs a few cents per session, not added latency.
// Cheap and small on purpose: short prompt, single rep turn, tiny output.
const SEVEN_BELIEFS = ['Pain', 'Doubt', 'Desire', 'Cost', 'Money', 'Support', 'Trust'];
function buildBeliefTouchPrompt(repText) {
  return `A sales rep just said this during a practice call: "${repText}"

Which of these 7 Beliefs did this statement primarily work to build, if any? Pain (surfacing a real problem), Doubt (DIY isn't the best path), Desire (pulling toward the future outcome), Cost (cost of inaction), Money (resources/willingness), Support (spouse/partner alignment), Trust (the method/company is right).

Return ONLY JSON, nothing else: {"beliefs": ["Pain","Desire"]} — empty array if this statement was small talk, logistics, or didn't meaningfully address any belief. Most single statements touch 0-1 beliefs; only mark more than one if it clearly did both.`;
}

// Merges a fresh classification into the running total — pure, no I/O, easy to test.
function mergeBeliefsCovered(existingArr, newlyTouched) {
  const existing = Array.isArray(existingArr) ? existingArr : [];
  const valid = (Array.isArray(newlyTouched) ? newlyTouched : []).filter(b => SEVEN_BELIEFS.includes(b));
  return [...new Set([...existing, ...valid])];
}

module.exports = { buildProspectPrompt, buildBeliefTouchPrompt, mergeBeliefsCovered, SEVEN_BELIEFS };
