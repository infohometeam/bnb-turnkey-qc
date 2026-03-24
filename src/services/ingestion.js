// ═══════════════════════════════════════════════════════════════
// Ingestion — Fathom (Closers) + Aloware (Setters)
// Includes rep detection for shared Aloware account (Andrew/Steven)
// ═══════════════════════════════════════════════════════════════

const crypto = require('crypto');
const { getDb } = require('../../migrations/run');

const TEAM_NAMES = new Set(['sam','sam arnita','matt','matt snell','kevin','andrew','andrew niebur','andrew cluney','steven','francis']);

// ─── Aloware Rep Detection (Andrew vs Steven) ────────────────
// Since Andrew and Steven share one Aloware account, we detect
// who made the call by checking the transcript for agent name
// and fall back to payload fields.
function detectAlowareRep(data, transcript) {
  const d = data?.body || data;

  // 1. Check agent_name / rep_name in payload
  const payloadName = (d.rep_name || d.agent_name || '').toLowerCase().trim();
  if (payloadName.includes('steven')) return { name: 'Steven', srcTag: 'aloware-setters-2' };
  if (payloadName.includes('andrew')) return { name: 'Andrew', srcTag: 'aloware-setters' };

  // 2. Check user/agent fields in communication
  const commAgent = (d.communication?.user_name || d.communication?.agent_name || '').toLowerCase();
  if (commAgent.includes('steven')) return { name: 'Steven', srcTag: 'aloware-setters-2' };
  if (commAgent.includes('andrew')) return { name: 'Andrew', srcTag: 'aloware-setters' };

  // 3. Scan transcript for speaker names
  const lower = (transcript || '').toLowerCase();
  const stevenMentions = (lower.match(/steven/g) || []).length;
  const andrewMentions = (lower.match(/andrew/g) || []).length;

  // Check who appears as the AGENT speaker
  const agentLines = lower.split('\n').filter(l => l.includes('agent:') || l.includes('rep:'));
  for (const line of agentLines) {
    if (line.includes('steven')) return { name: 'Steven', srcTag: 'aloware-setters-2' };
    if (line.includes('andrew')) return { name: 'Andrew', srcTag: 'aloware-setters' };
  }

  // Fallback to mention count
  if (stevenMentions > andrewMentions && stevenMentions >= 2) return { name: 'Steven', srcTag: 'aloware-setters-2' };
  if (andrewMentions > stevenMentions && andrewMentions >= 2) return { name: 'Andrew', srcTag: 'aloware-setters' };

  // Default to Andrew (original setter)
  return { name: 'Andrew', srcTag: 'aloware-setters' };
}

function detectSource(data, srcTag) {
  if (!data) {
    if (srcTag?.startsWith('aloware')) return 'Aloware';
    if (srcTag?.startsWith('fathom')) return 'Fathom';
    return 'Unknown';
  }
  if (data.meeting || (data.transcript && Array.isArray(data.transcript))) return 'Fathom';
  if (typeof data.event === 'string' && data.event.startsWith('transcription.')) return 'Aloware';
  const d = data.body || data;
  if (d.parsed_transcription || d.transcription) return 'Aloware';
  return data.source || 'Unknown';
}

function detectRepName(data) {
  if (!data) return '';
  const d = data.body || data;
  return d.rep_name || d.agent_name || d.recorded_by?.name || d.host?.name || '';
}

function detectClientName(data) {
  if (!data) return '';
  const d = data.body || data;
  const repName = detectRepName(data)?.toLowerCase()?.trim();
  function isTeam(n) { const x = n?.toLowerCase()?.trim(); return !x || TEAM_NAMES.has(x) || x === repName; }
  if (d.contact) {
    const full = `${d.contact.first_name || ''} ${d.contact.last_name || ''}`.trim();
    if (full && !isTeam(full)) return full;
    if (d.contact.name && !isTeam(d.contact.name)) return d.contact.name.trim();
  }
  if (Array.isArray(d.calendar_invitees)) {
    const intDomain = d.recorded_by?.email_domain?.toLowerCase() || '';
    for (const inv of d.calendar_invitees) {
      const nm = inv.name?.trim();
      if (!nm || isTeam(nm)) continue;
      if (inv.is_external === true) return nm;
      if (intDomain && (inv.email || '').toLowerCase().endsWith('@' + intDomain)) continue;
      return nm;
    }
  }
  return '';
}

function detectCallUrl(data) {
  if (!data) return '';
  const d = data.body || data;
  return d.share_url || d.url || d.contact?.integration_data?.hubspot?.link
    || (d.communication?.id ? `aloware:comm:${d.communication.id}` : '')
    || (d.transcription?.transcription_id ? `aloware:tx:${d.transcription.transcription_id}` : '') || '';
}

function detectAudioUrl(data) {
  if (!data) return '';
  const d = data.body || data;
  return d.share_url || d.communication?.recording_url || d.recording_url || '';
}

function extractTranscript(data) {
  if (!data) return '';
  const d = data.body || data;
  if (d.parsed_transcription?.messages && Array.isArray(d.parsed_transcription.messages)) {
    return d.parsed_transcription.messages.map(m => {
      const s = Math.max(0, Math.floor((Number(m.start) || 0) / 1000));
      const ts = `${String(Math.floor(s/60)).padStart(2,'0')}:${String(s%60).padStart(2,'0')}`;
      return `[${ts}] ${m.speaker || 'SPEAKER'}: ${m.text || ''}`;
    }).join('\n');
  }
  if (Array.isArray(d.transcript)) {
    return d.transcript.map(t => `[${t.timestamp || ''}] ${t.speaker?.display_name || t.speaker?.name || 'Speaker'}: ${t.text || ''}`).join('\n');
  }
  return '';
}

function extractMetrics(data, repHint) {
  if (!data) return { durationSec: null, agentTalkPct: null, contactTalkPct: null };
  const d = data.body || data;
  let dur = null, agPct = null, coPct = null;

  // Duration
  if (fin(d.communication?.duration)) dur = Number(d.communication.duration);
  if (!fin(dur) && d.recording_start_time && d.recording_end_time) {
    const s = new Date(d.recording_start_time), e = new Date(d.recording_end_time);
    if (!isNaN(s) && !isNaN(e)) dur = Math.max(0, Math.round((e - s) / 1000));
  }
  if (!fin(dur) && Array.isArray(d.transcript)) {
    const times = d.transcript.map(t => parseTsToSec(t.timestamp)).filter(fin);
    if (times.length) dur = Math.max(...times);
  }

  // Talk % (Aloware)
  const tta = d.parsed_transcription?.talk_time_analysis;
  if (tta) { if (fin(tta.AGENT)) agPct = +tta.AGENT; if (fin(tta.CONTACT)) coPct = +tta.CONTACT; }

  // Talk % (Fathom word count)
  if ((!fin(agPct) || !fin(coPct)) && Array.isArray(d.transcript)) {
    const intDom = d.recorded_by?.email_domain?.toLowerCase() || '';
    const recEmail = d.recorded_by?.email?.toLowerCase() || '';
    const recName = norm(d.recorded_by?.name);
    const rep = norm(repHint || detectRepName(data));
    let aw = 0, cw = 0;
    for (const t of d.transcript) {
      const sp = t.speaker || {};
      const spE = (sp.matched_calendar_invitee_email || '').toLowerCase();
      const spN = norm(sp.display_name || sp.name);
      const w = (t.text || '').trim().split(/\s+/).length;
      const isAg = (recEmail && spE === recEmail) || (intDom && spE?.endsWith('@'+intDom)) || (recName && spN && nameMatch(spN,recName)) || (rep && spN && nameMatch(spN,rep));
      if (isAg) aw += w; else cw += w;
    }
    const tot = aw + cw;
    if (tot > 0) { agPct = Math.round(aw/tot*100); coPct = Math.round(cw/tot*100); }
  }

  if (fin(agPct)) agPct = Math.max(0, Math.min(100, agPct));
  if (fin(coPct)) coPct = Math.max(0, Math.min(100, coPct));
  return { durationSec: dur, agentTalkPct: agPct, contactTalkPct: coPct };
}

function isVoicemail(data) {
  const d = data?.body || data;
  const c = d?.communication || {};
  return c.has_voicemail === true || Number(c.voicemail_duration || 0) > 0 || c.has_recording === false;
}

function buildDedupeKey(base, srcTag, data, url, transcript) {
  const d = data?.body || data;
  let sid = '';
  if (base === 'Aloware') sid = d?.communication?.id || d?.transcription?.transcription_id || '';
  else if (base === 'Fathom') sid = d?.meeting?.id || d?.id || '';
  const raw = [base, srcTag, sid, normUrl(url), (transcript||'').slice(0,500)].join('|');
  if (!raw.replace(/\|/g,'').trim()) return '';
  return crypto.createHash('sha256').update(raw,'utf8').digest('hex');
}

function redact(text) {
  if (!text) return '';
  return text.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi,'[EMAIL]').replace(/\+?\d[\d\s().-]{7,}\d/g,'[PHONE]');
}

// ─── Main Ingest ─────────────────────────────────────────────
function ingestCall(rawPayload, srcTag) {
  const db = getDb();
  const data = safeParse(rawPayload);
  const baseSource = detectSource(data, srcTag);

  // Debug log
  db.prepare('INSERT INTO webhook_debug (src_tag,base_source,raw_payload) VALUES (?,?,?)').run(srcTag, baseSource, rawPayload);

  let repName = detectRepName(data);
  let role = baseSource === 'Aloware' ? 'Setter' : baseSource === 'Fathom' ? 'Closer' : 'Unknown';
  let repId = null;
  let resolvedSrcTag = srcTag;

  // Extract transcript early (needed for Aloware rep detection)
  let transcript = redact(extractTranscript(data));

  // Resolve rep from roster OR detect from shared Aloware account
  if (baseSource === 'Aloware') {
    const detected = detectAlowareRep(data, transcript);
    repName = detected.name;
    resolvedSrcTag = detected.srcTag;
    const row = db.prepare('SELECT id,name,role FROM rep_roster WHERE src_tag=? AND active=1').get(resolvedSrcTag);
    if (row) { repId = row.id; repName = row.name; role = row.role; }
  } else if (srcTag) {
    const row = db.prepare('SELECT id,name,role FROM rep_roster WHERE src_tag=? AND active=1').get(srcTag);
    if (row) { repId = row.id; repName = row.name; role = row.role; }
  }

  const source = resolvedSrcTag ? `${baseSource} (${resolvedSrcTag})` : baseSource;
  const clientName = detectClientName(data);
  const callUrl = detectCallUrl(data);
  const audioUrl = detectAudioUrl(data);
  const extKey = buildDedupeKey(baseSource, resolvedSrcTag, data, callUrl, transcript);

  // Dedup check
  if (extKey) {
    const exists = db.prepare('SELECT id FROM calls WHERE external_call_key=?').get(extKey);
    if (exists) { db.close(); return { ok: true, duplicate: true, callId: exists.id, message: 'DUPLICATE_SKIPPED' }; }
  }

  const metrics = extractMetrics(data, repName);
  const team = role === 'Setter' ? 'Turnkey - Setters' : role === 'Closer' ? 'Turnkey - Closers' : 'Turnkey';
  const ws = getWeekStart(new Date());

  let status = 'NEW', error = '';
  if (!data) { status = 'ERROR'; error = 'PARSE_ERROR'; }
  else if (!transcript || transcript.trim().length < 1) { status = 'WAIT_TRANSCRIPT'; error = 'Transcript not in payload.'; }
  else if (isVoicemail(data)) { status = 'SKIP_VOICEMAIL'; error = 'Voicemail detected.'; }
  else if (transcript.trim().length < 120) { status = 'SKIP_SHORT'; error = 'Too short to QC.'; }

  const stmt = db.prepare(`INSERT INTO calls (received_at,source,base_source,src_tag,rep_name,rep_id,role,team,
    client_name,call_url,audio_url,external_call_key,transcript,transcript_chars,
    call_duration_sec,agent_talk_pct,contact_talk_pct,status,error,weekstart,queued_at)
    VALUES (datetime('now'),?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,datetime('now'))`);

  const info = stmt.run(source,baseSource,resolvedSrcTag,repName,repId,role,team,
    clientName,callUrl,audioUrl,extKey,transcript,transcript.length,
    metrics.durationSec,metrics.agentTalkPct,metrics.contactTalkPct,status,error,ws);

  db.close();
  return { ok: true, duplicate: false, callId: info.lastInsertRowid, status, message: 'OK' };
}

// ─── Helpers ─────────────────────────────────────────────────
function safeParse(s) { if(!s)return null; try{return JSON.parse(s)}catch(e){} try{return JSON.parse(String(s).trim())}catch(e){} return null; }
function parseTsToSec(ts) { const p=String(ts||'').trim().split(':').map(Number); if(p.some(n=>!isFinite(n)))return null; if(p.length===2)return p[0]*60+p[1]; if(p.length===3)return p[0]*3600+p[1]*60+p[2]; return null; }
function fin(v) { return typeof Number(v)==='number' && isFinite(Number(v)); }
function norm(s) { return (s||'').toLowerCase().replace(/[^\w\s]/g,' ').replace(/\s+/g,' ').trim(); }
function nameMatch(a,b) { const x=norm(a),y=norm(b); if(!x||!y)return false; if(x===y)return true; for(const xi of x.split(' '))for(const yi of y.split(' '))if(xi.length>=3&&xi===yi)return true; return false; }
function normUrl(u) { return String(u||'').trim().replace(/#.*$/,'').replace(/\?.*$/,'').replace(/\/+$/,'').toLowerCase(); }
function getWeekStart(d) { const dt=new Date(d); dt.setDate(dt.getDate()-(dt.getDay()+6)%7); dt.setHours(0,0,0,0); return dt.toISOString().slice(0,10); }

module.exports = { ingestCall, detectSource, detectAlowareRep };
