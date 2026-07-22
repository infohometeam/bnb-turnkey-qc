// ═══════════════════════════════════════════════════════════════
// Database layer — Postgres (Supabase) via node-postgres (pg)
// Converted from Turso/libSQL. Public interface unchanged:
//   q(sql, args) -> { rows, lastInsertRowid }
//   migrate()    -> ensures schema exists (safe no-op if already built)
//   getClient()  -> the pg Pool
//
// KEY COMPAT SHIMS (so callers don't change):
//  1. `?` placeholders are auto-translated to `$1,$2,...`
//  2. INSERT statements auto-get `RETURNING id`, and the new id is
//     exposed as `res.lastInsertRowid` (matches old libSQL behavior)
//  3. pg already returns { rows: [...] }, matching libSQL result shape
// ═══════════════════════════════════════════════════════════════

const { Pool } = require('pg');
let _pool = null;

function getClient() {
  if (_pool) return _pool;
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('MISSING_DATABASE_URL — set your Supabase Postgres connection string in env');
  }
  console.log('[DB] Connecting to Supabase (Postgres)');
  _pool = new Pool({
    connectionString,
    ssl: { rejectUnauthorized: false },
    max: 5,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 15000,
  });
  _pool.on('error', (err) => console.error('[DB] idle client error:', err.message));
  return _pool;
}

// ─── Placeholder translator: `?` → `$1, $2, ...` ────────────────
function translatePlaceholders(sql) {
  let out = '';
  let n = 0;
  let inString = false;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (ch === "'") {
      if (inString && sql[i + 1] === "'") { out += "''"; i++; continue; }
      inString = !inString;
      out += ch;
    } else if (ch === '?' && !inString) {
      out += '$' + (++n);
    } else {
      out += ch;
    }
  }
  return out;
}

function isInsert(sql) { return /^\s*insert\s/i.test(sql); }
function alreadyReturning(sql) { return /returning\s/i.test(sql); }
// Upserts (ON CONFLICT) may take the UPDATE path and shouldn't force RETURNING id.
function hasOnConflict(sql) { return /on\s+conflict/i.test(sql); }
// Tables without an `id` column (PK is something else). daily_counters PK = date_key.
function insertsIntoIdlessTable(sql) { return /^\s*insert\s+into\s+daily_counters\b/i.test(sql); }

// ─── The universal query function (unchanged signature) ─────────
async function q(sql, args = []) {
  const pool = getClient();
  let text = translatePlaceholders(sql);

  let wantsId = false;
  if (isInsert(text) && !alreadyReturning(text) && !hasOnConflict(text) && !insertsIntoIdlessTable(text)) {
    text = text + ' RETURNING id';
    wantsId = true;
  }

  const res = await pool.query(text, args);
  let lastInsertRowid;
  if (wantsId && res.rows && res.rows.length) {
    lastInsertRowid = res.rows[0].id;
  }
  return { rows: res.rows || [], rowCount: res.rowCount, lastInsertRowid };
}

// ─── Schema (Postgres). Safe to run repeatedly. ────────────────
async function migrate() {
  const stmts = [
    `CREATE TABLE IF NOT EXISTS rep_roster (
      id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      name text NOT NULL, role text NOT NULL, team text NOT NULL,
      src_tag text, aloware_user_id text,
      color text DEFAULT '#6366f1', active integer DEFAULT 1)`,
    `CREATE TABLE IF NOT EXISTS rubric_items (
      id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      version integer DEFAULT 1, role text NOT NULL, category text NOT NULL,
      weight integer DEFAULT 20, good text NOT NULL, bad text NOT NULL,
      score_10 text, score_5 text, score_1 text)`,
    `CREATE TABLE IF NOT EXISTS calls (
      id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      received_at text, source text, base_source text, src_tag text,
      rep_name text, rep_id integer, role text, team text, client_name text,
      call_url text, audio_url text, external_call_key text UNIQUE,
      transcript text, transcript_chars integer DEFAULT 0, transcript_slice text,
      call_duration_sec integer, agent_talk_pct real, contact_talk_pct real,
      overall_score real, overall_score_adj real, score_adjust_notes text,
      category_scores text, pass_fail text, coaching_notes text, quick_summary text,
      strengths text, improvements text, next_step_text text, golden_moments text,
      status text DEFAULT 'NEW', flagged integer DEFAULT 0, error text DEFAULT '',
      retry_count integer DEFAULT 0, queued_at text, last_tried_at text,
      processed_at text, model_used text, rubric_version integer DEFAULT 1,
      weekstart text, created_at text)`,
    `CREATE TABLE IF NOT EXISTS webhook_debug (
      id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      received_at text, src_tag text, base_source text, raw_payload text)`,
    `CREATE TABLE IF NOT EXISTS usage_events (
      id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      ts text, page text, visitor_id text)`,
    `CREATE INDEX IF NOT EXISTS idx_usage_events_ts ON usage_events(ts)`,
    `CREATE TABLE IF NOT EXISTS daily_counters (
      date_key text PRIMARY KEY, full_qc_used integer DEFAULT 0,
      est_cost_usd real DEFAULT 0, updated_at text)`,
    `CREATE TABLE IF NOT EXISTS score_overrides (
      id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      call_id integer, override_by text DEFAULT 'Sam',
      original_score real, override_score real, reason text, created_at text)`,
    `CREATE TABLE IF NOT EXISTS score_history (
      id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      call_id integer NOT NULL, snapshot_at text NOT NULL, rubric_version integer NOT NULL,
      overall_score real, overall_score_adj real, category_scores text, pass_fail text,
      score_adjust_notes text, quick_summary text, coaching_notes text,
      strengths text, improvements text, model_used text,
      CONSTRAINT fk_score_history_call_id_calls_id_fk
        FOREIGN KEY (call_id) REFERENCES calls(id) ON DELETE CASCADE)`,
    `CREATE INDEX IF NOT EXISTS idx_calls_status ON calls(status)`,
    `CREATE INDEX IF NOT EXISTS idx_calls_rep ON calls(rep_name)`,
    `CREATE INDEX IF NOT EXISTS idx_calls_received ON calls(received_at)`,
    `CREATE INDEX IF NOT EXISTS idx_calls_extkey ON calls(external_call_key)`,
    `CREATE INDEX IF NOT EXISTS idx_score_history_version ON score_history(rubric_version)`,
    `CREATE INDEX IF NOT EXISTS idx_score_history_call ON score_history(call_id)`,
    // Call stitching: link cut-off calls that were merged into one.
    `ALTER TABLE calls ADD COLUMN IF NOT EXISTS stitched_into_id integer`,
    `ALTER TABLE calls ADD COLUMN IF NOT EXISTS stitched_from_ids text`,
    `ALTER TABLE calls ADD COLUMN IF NOT EXISTS stitch_status text`,
    `CREATE INDEX IF NOT EXISTS idx_calls_stitch ON calls(stitch_status)`,

    // ── Call Outcome Tagging ───────────────────────────────────────────
    // Tag registry. Extensible: adding a tag = inserting a row, not a deploy.
    // excludes_from_average is the CONSEQUENCE flag — the tag is the "what",
    // this is the "so what". Never conflate them (Redzone-Hot is a GREAT call
    // and must stay scored; excluding it would delete a rep's best work).
    `CREATE TABLE IF NOT EXISTS call_tags (
      key text PRIMARY KEY,
      label text NOT NULL,
      tag_group text NOT NULL,
      excludes_from_average boolean DEFAULT false,
      description text,
      color text DEFAULT '#64748b',
      sort_order integer DEFAULT 100,
      active boolean DEFAULT true)`,
    // A tag marked TRUE here describes "what kind of call was this, primarily" —
    // mutually exclusive with every other primary-outcome tag (can't be both
    // Disqualified and Hard No). Group C (routing/cross-sell) and E (missed-
    // opportunity coaching flags) are deliberately NOT primary — they're additive
    // signals that coexist with whatever the primary outcome is. Data-driven so a
    // future custom tag (created via the admin UI) can opt into this without a
    // code change — see /tags POST/PATCH.
    `ALTER TABLE call_tags ADD COLUMN IF NOT EXISTS is_primary_outcome boolean DEFAULT false`,
    // A call can carry one Group A/B tag + any number of Group C (routing) tags.
    // Only status='CONFIRMED' has any effect on averages — SUGGESTED changes nothing.
    `CREATE TABLE IF NOT EXISTS call_tag_assignments (
      id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      call_id integer NOT NULL,
      tag_key text NOT NULL,
      status text DEFAULT 'SUGGESTED',
      reason text,
      suggested_by text,
      confirmed_by text,
      created_at text,
      confirmed_at text,
      CONSTRAINT uq_call_tag UNIQUE (call_id, tag_key),
      CONSTRAINT fk_cta_call FOREIGN KEY (call_id) REFERENCES calls(id) ON DELETE CASCADE)`,
    `CREATE INDEX IF NOT EXISTS idx_cta_call ON call_tag_assignments(call_id)`,
    `CREATE INDEX IF NOT EXISTS idx_cta_status ON call_tag_assignments(status)`,
    // Aloware deep links need both ids: talk.aloware.io/contacts/{contactId}/communications/{callId}
    `ALTER TABLE calls ADD COLUMN IF NOT EXISTS aloware_contact_id text`,
    `ALTER TABLE calls ADD COLUMN IF NOT EXISTS aloware_call_id text`,
    // Golden Moments library: Sam pins the canonical exemplars.
    // A moment is (call_id, index-in-the-json-array) — expanded at read time,
    // so a re-score can never orphan a pin.
    `CREATE TABLE IF NOT EXISTS golden_moment_pins (
      id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      call_id integer NOT NULL, moment_index integer NOT NULL,
      category text, note text, pinned_by text, created_at text,
      CONSTRAINT uq_gm_pin UNIQUE (call_id, moment_index),
      CONSTRAINT fk_gm_call FOREIGN KEY (call_id) REFERENCES calls(id) ON DELETE CASCADE)`,
    `CREATE INDEX IF NOT EXISTS idx_gm_call ON golden_moment_pins(call_id)`,
    // Calibration: Sam can override per-category, not just the overall score.
    `ALTER TABLE score_overrides ADD COLUMN IF NOT EXISTS category_scores text`,
    `ALTER TABLE score_overrides ADD COLUMN IF NOT EXISTS original_categories text`,

    // ── Transcript hygiene ─────────────────────────────────────────────
    // Diarization-quality grade recorded per call (echo / scrambled dial-in labels).
    // We never repair the transcript — this only records the grade so the UI can
    // warn and the scorer can compensate. Backfilled by the diagnostics scan.
    `ALTER TABLE calls ADD COLUMN IF NOT EXISTS transcript_quality text`,
    `ALTER TABLE calls ADD COLUMN IF NOT EXISTS transcript_quality_score integer`,
    `ALTER TABLE calls ADD COLUMN IF NOT EXISTS transcript_quality_flags text`,

    // Tough moments — coaching counterpart to golden_moments (quote + why + fix).
    // Populated at score time and by the "re-look at moments" re-extract pass.
    `ALTER TABLE calls ADD COLUMN IF NOT EXISTS tough_moments text`,

    // One-line scannable summary (max ~120 chars) for dense table rows in the
    // Calls list. Distinct from quick_summary (2-3 sentences, shown on detail).
    `ALTER TABLE calls ADD COLUMN IF NOT EXISTS list_summary text`,

    // ── Configurable deduction weights (Calibration tab) ───────────────
    // Sam's non-negotiable penalties, made editable. Weights are cached in the
    // worker and refreshed on write. Every change is audited, and because each
    // call stores its raw score + which rules fired, historical adjusted scores
    // can be recomputed deterministically (no AI) and reversed.
    `CREATE TABLE IF NOT EXISTS deduction_weights (
      rule text PRIMARY KEY, points real, label text,
      updated_at text, updated_by text)`,
    `CREATE TABLE IF NOT EXISTS deduction_weight_history (
      id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      rule text, old_points real, new_points real,
      changed_by text, changed_at text, note text,
      recomputed_calls integer DEFAULT 0)`,

    // ── Rep lifecycle ──────────────────────────────────────────────────
    // Soft-delete audit stamp. History is retained automatically because calls
    // reference rep_name (not a FK), so deactivating never orphans past calls.
    `ALTER TABLE rep_roster ADD COLUMN IF NOT EXISTS deactivated_at text`,

    // ── Coaching 1-on-1 log ────────────────────────────────────────────
    // HUMAN-authored coaching notes for the Coach Console. Deliberately isolated
    // from scoring: these never feed the habit engine or a rep's average. If they
    // did, a rep's own notes could move their numbers — breaking the
    // "bot suggests, human confirms" invariant and making the system gameable.
    `CREATE TABLE IF NOT EXISTS one_on_ones (
      id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      rep_id integer, rep_name text, date text, author text,
      focus_tag text, note text, next_checkin text, created_at text)`,
    `CREATE INDEX IF NOT EXISTS idx_one_on_ones_rep ON one_on_ones(rep_id)`,
  ];
  for (const sql of stmts) await q(sql);

  const rr = await q('SELECT COUNT(*)::int AS c FROM rep_roster');
  if (rr.rows[0].c === 0) {
    const reps = [
      ['Matt','Closer','Turnkey - Closers','fathom-closers-1',null,'#6366f1'],
      ['Kevin','Closer','Turnkey - Closers','fathom-closers-2',null,'#8b5cf6'],
      ['Andrew Cluney','Setter','Turnkey - Setters','aloware-setters','95724','#10b981'],
      ['Steven Arnita','Setter','Turnkey - Setters','aloware-setters','111657','#f59e0b'],
      ['Anurag Shriv','Setter','Turnkey - Setters','aloware-setters','112769','#0ea5e9'],
    ];
    for (const [n,r,t,s,aid,cl] of reps) {
      await q('INSERT INTO rep_roster (name,role,team,src_tag,aloware_user_id,color) VALUES (?,?,?,?,?,?)', [n,r,t,s,aid,cl]);
    }
  }

  const rc = await q('SELECT COUNT(*)::int AS c FROM rubric_items');
  if (rc.rows[0].c === 0) {
    const items = [
      [1,'Setter','discovery',20,'Client speaks 35%+ and rep asks about investment goals, timeline, markets, STR experience, budget before pitching','Rep talks 70%+, monologues, pitches within first 2 minutes','Rep opens with curiosity about portfolio, STR interest, timeline, cost seg experience, target returns. Client speaks 40%+.','Asks budget/timeline but skips goals or experience. Client 25-35%.','Pitches within 90 seconds. No investor questions. Client barely speaks.'],
      [1,'Setter','qualification',30,'Confirms investor fit: income, timeline, budget $300K-$800K+, understands passive model','No fit checks; assumes budget/fit','Confirms income, timeline, budget, hands-off model via Home Team. Disqualifies poor fits.','Confirms budget but not timeline. Assumes fit.','No qualification. Books closer for anyone.'],
      [1,'Setter','pitch',15,'Sets expectations for closer call: three-phase process, Home Team management','Overpromises, vague, tries to close','Overview of 3 phases. Sets realistic expectations. Mentions 300+ properties.','Mentions BNB Turnkey but vague about closer agenda.','Says nothing about expectations OR overpromises.'],
      [1,'Setter','objections',15,'Handles pushback calmly with proof points','Dismisses, argues, panics','Acknowledges, normalizes, provides evidence re: rates/cost seg.','Generic responses. Flustered by hard questions.','Ignores or dismisses. Gets defensive.'],
      [1,'Setter','close_next_step',20,'Books closer call: date/time, prep instructions, calendar invite','No firm next step','Specific date/time, who theyll speak with, what to prepare, invite in 5 min.','Books but no prep instructions or vague timing.','Ends with well be in touch. No date or action.'],
      [1,'Closer','discovery',20,'Deep discovery referencing setter notes: goals, pain, finances, timeline, markets','Surface-level, no setter reference, jumps to pitch','References setter call then goes deeper. Client speaks 40-60%.','Some discovery but doesnt build on setter call. Checklist feel.','Skips discovery. 20-min pitch. Client <20% talk.'],
      [1,'Closer','qualification',20,'Validates budget, financing, timeline, full scope including fees','Assumes fit from setter notes','Reconfirms budget, financing method, total investment scope, fee structure.','Confirms budget but not total scope or fees.','No qualification. Wrong property size. Surprise costs.'],
      [1,'Closer','pitch',25,'Full three-phase walkthrough tailored to goals, social proof','Confusing/incomplete','All 3 phases customized. Market data, timeline, projections. 300+ properties. Relevant proof.','Generic process explanation. Missing details. Scripted.','Fumbles. Conflicting info. Investor confused.'],
      [1,'Closer','objections',15,'Addresses concerns with clarity, empathy, data','Avoids, dismissive, crumbles','Acknowledges, validates, data response. Handles 2-3 objections composedly.','Handles easy ones. Vague on hard questions.','Ignores. Says trust me. Gets defensive.'],
      [1,'Closer','close_next_step',20,'Clear commitment with date, assumptive close','No commitment, vague follow-up','Asks for commitment with specific date. Creates urgency.','Suggests steps but no commitment ask.','Let me know what you think. No date. No urgency.'],
    ];
    for (const [v,r,cat,w,g,b,s10,s5,s1] of items) {
      await q('INSERT INTO rubric_items (version,role,category,weight,good,bad,score_10,score_5,score_1) VALUES (?,?,?,?,?,?,?,?,?)', [v,r,cat,w,g,b,s10,s5,s1]);
    }
  }
  // ── Seed the call-tag taxonomy (idempotent; safe to re-run) ──────────
  // Group A = lead couldn't be closed (rep judged correctly) -> EXCLUDED from average
  // Group B = a real sales attempt happened -> STAYS SCORED (performance counts)
  // Group C = routing / cross-sell to another Rise brand -> no scoring effect, additive
  const tagSeed = [
    ['DISQUALIFIED',       'Disqualified',        'A_NOT_CLOSEABLE', true,  'Genuine non-fit — no capital, wrong profile, cannot proceed. Rep correctly disqualified.', '#ef4444', 10],
    ['NOT_READY',          'Not Ready',           'A_NOT_CLOSEABLE', true,  'Real lead but cannot act now for a concrete stated reason (capital tied up, mid-transaction, timing).', '#f59e0b', 20],
    ['LONG_TERM_NURTURE',  'Long-Term Nurture',   'A_NOT_CLOSEABLE', true,  'Real lead, not actionable on a long horizon (locked in years, major change needed). Correctly parked.', '#a855f7', 30],
    ['INFO_SEEKER',        'Info Seeker',         'A_NOT_CLOSEABLE', true,  'Caller only wanted information — never a buyer. Rep correctly did not force a pitch.', '#64748b', 40],
    ['SHORT_TERM_NURTURE', 'Short-Term Nurture',  'B_REAL_ATTEMPT',  false, 'Real attempt; lead is close but needs a bit more time/info. Execution is fair to judge.', '#06b6d4', 50],
    ['REDZONE_HOT',        'Red Zone — Hot',      'B_REAL_ATTEMPT',  false, 'Lead is hot, close imminent. A GREAT call — must stay scored.', '#22c55e', 60],
    ['HARD_NO',            'Hard No',             'B_REAL_ATTEMPT',  false, 'Rep pitched a viable lead; client firmly declined. A real attempt that did not land.', '#f87171', 70],
    ['HOTEL_TURNKEY_LEAD',   'Hotel Turnkey Lead',    'C_ROUTING', false, 'Fits Hotel Turnkey — larger/commercial property or boutique hotel interest.', '#8b5cf6', 80],
    ['BNB_LENDING_LEAD',     'BNB Lending Lead',      'C_ROUTING', false, 'Financing is the blocker — route to BNB Lending.', '#0ea5e9', 81],
    ['INVESTOR_ACADEMY_LEAD','Investor Academy Lead', 'C_ROUTING', false, 'Wants to learn / DIY — route to BNB Investor Academy.', '#14b8a6', 82],
    ['SURGE_TAX_LEAD',       'Surge Tax Lead',        'C_ROUTING', false, 'Tax burden is the driver — route to Surge Tax.', '#eab308', 83],
    ['HOME_TEAM_MGMT_LEAD',  'Home Team Mgmt Lead',   'C_ROUTING', false, 'Already owns STRs but self-manages or has a bad manager — route to Home Team management.', '#ec4899', 84],
    ['REALTY_LEAD',          'Realty Lead',           'C_ROUTING', false, 'Wants to buy in a Home Team Realty market (Phoenix AZ, Pinellas FL, Gulf Coast).', '#f97316', 85],

    // ── D: Positive outcome tags (Francis, Jul 23) — a real "win" state, self-
    // contained from the transcript (no HubSpot dependency, matching the pivot in
    // CALL_TAGGING_spec.md). Never excludes from average — these are the calls we
    // WANT counted; the exclusion flag exists for non-performance outcomes, not wins.
    ['SET',        'Setter — Booked Closer Call', 'D_OUTCOME_POSITIVE', false,
      'Setter successfully booked a qualified closer call with a confirmed date/time. A strong outcome.', '#22c55e', 90],
    ['CLOSED_WON', 'Closer — Closed Won',          'D_OUTCOME_POSITIVE', false,
      'Payment was actually processed or confirmed LIVE, during this call — card charged, payment confirmed on the line. Not just agreement to proceed, not a promise to pay later, not paperwork sent for a future signature. A "yes let\'s do this, I\'ll send payment tomorrow" is NOT this tag. If payment clears later the same day but after the call ends, apply this tag manually with that context — automated detection only sees what happened on the call itself.', '#16a34a', 91],

    // ── E: Missed-opportunity judgment tags (Francis, Jul 23) — NOT yet AI-suggested;
    // these keys exist so the schema/UI is ready, but the prompt work that populates
    // them is deliberately held until Sam confirms the behavioral definitions (see
    // the spec). Never excludes from average — the call stays scored on execution;
    // this is a coaching flag layered on top, same principle as nurture-aware scoring.
    ['COULD_HAVE_BEEN_SET',          'Could Have Been a Set',           'E_MISSED_OPPORTUNITY', false,
      'Setter call: the lead showed real buying signals but no closer call was booked. A likely missed set.', '#fb923c', 100],
    ['COULD_HAVE_BEEN_ONE_CALL_CLOSE','Could Have Been a One-Call Close','E_MISSED_OPPORTUNITY', false,
      'Closer call: the lead was ready to commit but the call ended without securing it. A likely missed close.', '#fb923c', 101],

    // ── F: Wrong business unit (Francis, Jul 23) — the ENTIRE call was not a BNB
    // Turnkey conversation at all (e.g. a Rise Legacy legal matter that landed on a
    // Turnkey rep). Reused tag_group 'A_NOT_CLOSEABLE' deliberately: it's the most
    // "not closeable as a Turnkey deal" state there is, and it inherits the existing
    // mutual-exclusivity behavior in /calls/:id/tag (line ~964) — a call can't be
    // BOTH "not a Turnkey call at all" and "Disqualified as a Turnkey lead", since
    // the latter presupposes it was a Turnkey conversation. excludes_from_average=true
    // is the whole point: the call stays attributed to the rep, just leaves their
    // Turnkey scoring — same mechanism DISQUALIFIED etc. already use.
    ['BNB_LEGACY', 'BNB Legacy (Not a Turnkey Call)', 'A_NOT_CLOSEABLE', true,
      'The entire call was about Rise Legacy (the internal law/legal-services company), not BNB Turnkey. Not a Turnkey conversation at all — excluded from Turnkey scoring for this rep.', '#78716c', 15],

    // ── Partnership Call (Francis/Steven, Jul 24) — same category as BNB_LEGACY:
    // the entire call wasn't a Turnkey sales conversation at all, this time because
    // the lead was proposing a business partnership between companies rather than
    // investing as a client. Anchor case: call #2228 (Steven -> Brandon Roper),
    // scored 0 under the sales rubric despite Steven doing nothing wrong -- it was
    // never a sales call to begin with.
    ['PARTNERSHIP_CALL', 'Partnership Call (Not a Sales Call)', 'A_NOT_CLOSEABLE', true,
      'The lead was proposing a business partnership or collaboration between companies, not seeking to invest as a Turnkey client. Not a standard sales conversation — excluded from Turnkey scoring for this rep.', '#6b7280', 16],

    // ── F: Generic manual exclusion (Francis, Jul 23) — the escape hatch. Not every
    // reason a call shouldn't count fits a predefined category (wrong number that
    // slipped through, internal test call, a compliance flag, a duplicate, etc.).
    // This tag exists specifically so a human never has to force-fit an edge case
    // into DISQUALIFIED or BNB_LEGACY just to get a call out of an average. The
    // reason field is REQUIRED for this one — enforced in /calls/:id/tag — because
    // unlike DISQUALIFIED etc., this tag has no inherent meaning without it.
    ['EXCLUDED_OTHER', 'Excluded — Other Reason', 'F_MANUAL_EXCLUSION', true,
      'Manually excluded from this rep\'s average for a reason not covered by another tag. A written reason is required.', '#57534e', 999],
  ];
  for (const [key,label,grp,excl,desc,color,ord] of tagSeed) {
    await q(`INSERT INTO call_tags (key,label,tag_group,excludes_from_average,description,color,sort_order,active)
             VALUES (?,?,?,?,?,?,?,true)
             ON CONFLICT (key) DO UPDATE SET label=EXCLUDED.label, tag_group=EXCLUDED.tag_group,
               excludes_from_average=EXCLUDED.excludes_from_average, description=EXCLUDED.description,
               color=EXCLUDED.color, sort_order=EXCLUDED.sort_order`,
      [key,label,grp,excl,desc,color,ord]);
  }

  // Runs AFTER seeding (not before) so it correctly catches every tag just
  // inserted above, including ones added to tagSeed after this line was written —
  // ordering this before the seed loop would silently leave a fresh-DB deploy's
  // new A_NOT_CLOSEABLE/etc. tags at is_primary_outcome=false. Idempotent and safe
  // to re-run: only touches rows that don't already have the correct value.
  await q(`UPDATE call_tags SET is_primary_outcome=true
             WHERE tag_group IN ('A_NOT_CLOSEABLE','B_REAL_ATTEMPT','D_OUTCOME_POSITIVE','F_MANUAL_EXCLUSION')
               AND is_primary_outcome IS DISTINCT FROM true`);

  console.log('[DB] Migration complete ✓ (Postgres)');
}

module.exports = { q, migrate, getClient };
if (require.main === module) migrate().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
