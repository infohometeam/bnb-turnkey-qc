// ═══════════════════════════════════════════════════════════════
// Ingestion — Fathom (Closers) + Aloware (Setters)
// UPDATED: Handles Aloware's actual payload structure:
//   { body: { id, duration, contact, user_email, direct_recording_url, ... }, event: "Recording-Saved" }
//   { body: { id, ..., has_transcription, parsed_transcription, ... }, event: "Transcription-Saved" }
// ═══════════════════════════════════════════════════════════════

const crypto = require('crypto');
const { getDb } = require('../../migrations/run');

const TEAM_NAMES = new Set(['sam','sam arnita','matt','matt snell','kevin','andrew','andrew niebur','andrew cluney','steven','anurag','francis']);

// ─── Unwrap Aloware's nested structure ───────────────────────
// Aloware sends: { body: { ...call data... }, event: "Recording-Saved" }
// The actual call fields (id, duration, contact, etc.) are inside data.body
function unwrapAloware(data) {
  if (!data) return { inner: null, event: '' };
  // Check if this is Aloware's wrapper format
  if (data.event && data.body && typeof data.body === 'object' && data.body.id) {
    return { inner: data.body, event: String(data.event) };
  }
  // Maybe the body was already unwrapped, or it's a different format
  if (data.body && typeof data.body === 'object') {
    // Check if body.body exists (double-wrapped)
    if (data.body.body !== undefined && data.body.event) {
      return { inner: data.body, event: String(data.body.event || data.event || '') };
    }
    return { inner: data.body, event: String(data.event || data.body.event || '') };
  }
  return { inner: data, event: String(data.event || '') };
}

// ─── Source Detection ────────────────────────────────────────
function detectSource(data, srcTag) {
  if (!data) {
    if (srcTag?.startsWith('aloware')) return 'Aloware';
    if (srcTag?.startsWith('fathom')) return 'Fathom';
    return 'Unknown';
  }

  // Aloware event-based detection
  const evt = String(data.event || '').toLowerCase();
  if (evt.includes('recording') || evt.includes('transcription')) return 'Aloware';

  // Aloware structure: has body.id + body.contact + body.duration
  if (data.body && data.body.id && data.body.contact) return 'Aloware';

  // Fathom structure: has meeting or transcript array at top level
  if (data.meeting || (data.transcript && Array.isArray(data.transcript))) return 'Fathom';

  // Fallback to srcTag
  if (srcTag?.startsWith('aloware')) return 'Aloware';
  if (srcTag?.startsWith('fathom')) return 'Fathom';

  return 'Unknown';
}

// ─── Aloware Rep Detection (Andrew vs Steven) ────────────────
function detectAlowareRep(inner, transcript) {
  // 1. Check user_email field (most reliable — from payload)
  const email = (inner?.user_email || '').toLowerCase();
  if (email.includes('anurag')) return { name: 'Anurag', srcTag: 'aloware-setters-3' };
  if (email.includes('steven')) return { name: 'Steven', srcTag: 'aloware-setters-2' };
  if (email.includes('andrew')) return { name: 'Andrew', srcTag: 'aloware-setters' };

  // 2. Check last_engagement_text for rep name
  const engagement = (inner?.contact?.last_engagement_text || '').toLowerCase();
  if (engagement.includes('anurag')) return { name: 'Anurag', srcTag: 'aloware-setters-3' };
  if (engagement.includes('steven')) return { name: 'Steven', srcTag: 'aloware-setters-2' };
  if (engagement.includes('andrew')) return { name: 'Andrew', srcTag: 'aloware-setters' };

  // 3. Scan transcript for speaker names
  const lower = (transcript || '').toLowerCase();
  const agentLines = lower.split('\n').filter(l => l.includes('agent:') || l.includes('rep:'));
  for (const line of agentLines) {
    if (line.includes('anurag')) return { name: 'Anurag', srcTag: 'aloware-setters-3' };
    if (line.includes('steven')) return { name: 'Steven', srcTag: 'aloware-setters-2' };
    if (line.includes('andrew')) return { name: 'Andrew', srcTag: 'aloware-setters' };
  }

  // 4. Mention count fallback
  const anuragCount = (lower.match(/anurag/g) || []).length;
  const stevenCount = (lower.match(/steven/g) || []).length;
  const andrewCount = (lower.match(/andrew/g) || []).length;
  const maxCount = Math.max(anuragCount, stevenCount, andrewCount);
  if (maxCount >= 2) {
    if (anuragCount === maxCount) return { name: 'Anurag', srcTag: 'aloware-setters-3' };
    if (stevenCount === maxCount) return { name: 'Steven', srcTag: 'aloware-setters-2' };
    if (andrewCount === maxCount) return { name: 'Andrew', srcTag: 'aloware-setters' };
  }

  // Default
  return { name: 'Unknown Setter', srcTag: 'aloware-setters' };
}

// ─── Fathom Rep Detection ────────────────────────────────────
function detectRepName(data) {
  if (!data) return '';
  // Fathom fields
  return data.recorded_by?.name || data.host?.name || data.rep_name || data.agent_name || '';
}

// ─── Client Name ─────────────────────────────────────────────
function detectClientName(data, inner, baseSource) {
  const repName = (inner?.user_email || detectRepName(data) || '').toLowerCase().trim();
  function isTeam(n) { const x = n?.toLowerCase()?.trim(); return !x || TEAM_NAMES.has(x); }

  // Aloware: contact is at inner.contact
  if (inner?.contact) {
    const fn = inner.contact.first_name || '';
    const ln = inner.contact.last_name || '';
    const full = `${fn} ${ln}`.trim();
    if (full && !isTeam(full)) return full;
    if (inner.contact.name && !isTeam(inner.contact.name)) return inner.contact.name.trim();
  }

  // Fathom: calendar_invitees
  if (Array.isArray(data.calendar_invitees)) {
    const intDomain = data.recorded_by?.email_domain?.toLowerCase() || '';
    for (const inv of data.calendar_invitees) {
      const nm = inv.name?.trim();
      if (!nm || isTeam(nm)) continue;
      if (inv.is_external === true) return nm;
      if (intDomain && (inv.email || '').toLowerCase().endsWith('@' + intDomain)) continue;
      return nm;
    }
  }

  return '';
}

// ─── Call URL ────────────────────────────────────────────────
function detectCallUrl(data, inner, baseSource) {
  if (baseSource === 'Aloware') {
    if (inner?.id) return `aloware:call:${inner.id}`;
  }
  // Fathom
  if (data?.share_url) return data.share_url;
  if (data?.url) return data.url;
  return '';
}

// ─── Audio/Recording URL ─────────────────────────────────────
function detectAudioUrl(data, inner, baseSource) {
  if (baseSource === 'Aloware') {
    return inner?.direct_recording_url || inner?.recording_url || '';
  }
  // Fathom share_url doubles as playback
  return data?.share_url || '';
}

// ─── Transcript Extraction ───────────────────────────────────
function extractTranscript(data, inner, baseSource) {
  // Aloware: parsed_transcription at inner level
  if (inner?.parsed_transcription?.messages && Array.isArray(inner.parsed_transcription.messages)) {
    return inner.parsed_transcription.messages.map(m => {
      const s = Math.max(0, Math.floor((Number(m.start) || 0) / 1000));
      const ts = `${String(Math.floor(s/60)).padStart(2,'0')}:${String(s%60).padStart(2,'0')}`;
      return `[${ts}] ${m.speaker || 'SPEAKER'}: ${m.text || ''}`;
    }).join('\n');
  }

  // Aloware: call_transcription (plain text) at inner level
  if (inner?.call_transcription && typeof inner.call_transcription === 'string') {
    return inner.call_transcription;
  }

  // Aloware: transcription object
  if (inner?.transcription?.text) {
    return inner.transcription.text;
  }

  // Fathom: transcript array at top level
  if (Array.isArray(data?.transcript)) {
    return data.transcript.map(t => {
      const ts = t.timestamp || '';
      const sp = t.speaker?.display_name || t.speaker?.name || 'Speaker';
      return `[${ts}] ${sp}: ${t.text || ''}`;
    }).join('\n');
  }

  return '';
}

// ─── Metrics Extraction ──────────────────────────────────────
function extractMetrics(data, inner, baseSource, repHint) {
  let dur = null, agPct = null, coPct = null;

  // Aloware: duration is a direct field on inner
  if (baseSource === 'Aloware' && inner) {
    if (fin(inner.duration)) dur = Number(inner.duration);
    if (!fin(dur) && fin(inner.talk_time)) dur = Number(inner.talk_time);

    // Talk % from parsed_transcription
    const tta = inner.parsed_transcription?.talk_time_analysis;
    if (tta && typeof tta === 'object') {
      if (fin(tta.AGENT)) agPct = Number(tta.AGENT);
      if (fin(tta.CONTACT)) coPct = Number(tta.CONTACT);
    }
  }

  // Fathom
  if (baseSource === 'Fathom' && data) {
    if (!fin(dur) && data.recording_start_time && data.recording_end_time) {
      const s = new Date(data.recording_start_time), e = new Date(data.recording_end_time);
      if (!isNaN(s) && !isNaN(e)) dur = Math.max(0, Math.round((e - s) / 1000));
    }
    if (!fin(dur) && Array.isArray(data.transcript) && data.transcript.length > 0) {
      const times = data.transcript.map(t => parseTsToSec(t.timestamp)).filter(fin);
      if (times.length) dur = Math.max(...times);
    }

    // Talk % from Fathom word count
    if ((!fin(agPct) || !fin(coPct)) && Array.isArray(data.transcript)) {
      const intDom = data.recorded_by?.email_domain?.toLowerCase() || '';
      const recEmail = data.recorded_by?.email?.toLowerCase() || '';
      const recName = norm(data.recorded_by?.name);
      const rep = norm(repHint || detectRepName(data));
      let aw = 0, cw = 0;
      for (const t of data.transcript) {
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
  }

  if (fin(agPct)) agPct = Math.max(0, Math.min(100, agPct));
  if (fin(coPct)) coPct = Math.max(0, Math.min(100, coPct));
  return { durationSec: dur, agentTalkPct: agPct, contactTalkPct: coPct };
}

// ─── Voicemail Detection (Enhanced) ──────────────────────────
// Catches both explicit Aloware flags AND behavioral patterns
// like short outbound calls where only the agent spoke
const VOICEMAIL_PHRASES = [
  'leave a message', 'leave your message', 'after the tone', 'after the beep',
  'not available', 'unavailable', 'voicemail', 'mailbox', 'record your message',
  'please leave', 'at the tone', 'no one is available', 'cannot take your call',
  'is not available', 'press 1', 'press one',
];

function isVoicemail(inner, transcript, metrics) {
  if (!inner) return false;

  // 1. Explicit Aloware flags
  if (inner.has_voicemail === true) return true;
  if (Number(inner.voicemail_duration || 0) > 0) return true;
  if (inner.has_recording === false) return true;

  // 2. Outbound call + short duration + no real conversation
  const dur = metrics?.durationSec || inner.duration || 0;
  const isOutbound = inner.direction === 2; // Aloware: 2 = outbound
  const isShort = dur > 0 && dur <= 90;

  // If outbound, short, and talk percentages are both 0 or missing — likely voicemail
  if (isOutbound && isShort) {
    const agPct = metrics?.agentTalkPct;
    const coPct = metrics?.contactTalkPct;
    if ((!agPct && !coPct) || (agPct === 0 && coPct === 0)) return true;
  }

  // 3. Transcript content check — voicemail indicator phrases
  if (transcript) {
    const lower = transcript.toLowerCase();
    for (const phrase of VOICEMAIL_PHRASES) {
      if (lower.includes(phrase)) return true;
    }

    // 4. Only one speaker in transcript (rep talking to voicemail, no client response)
    const lines = transcript.split('\n').filter(l => l.trim());
    if (lines.length > 0 && lines.length <= 5 && isShort) {
      const speakers = new Set();
      for (const line of lines) {
        const match = line.match(/\]\s*([^:]+):/);
        if (match) speakers.add(match[1].trim().toLowerCase());
      }
      if (speakers.size <= 1) return true;
    }
  }

  return false;
}

// ─── Dedup Key ───────────────────────────────────────────────
function buildDedupeKey(baseSource, srcTag, inner, data, callUrl, transcript) {
  let sid = '';
  if (baseSource === 'Aloware') sid = inner?.id || '';
  else if (baseSource === 'Fathom') sid = data?.meeting?.id || data?.id || '';

  const raw = [baseSource, srcTag, String(sid), normUrl(callUrl), (transcript||'').slice(0,500)].join('|');
  if (!raw.replace(/\|/g,'').trim()) return '';
  return crypto.createHash('sha256').update(raw,'utf8').digest('hex');
}

// ─── PII Redaction ───────────────────────────────────────────
function redact(text) {
  if (!text) return '';
  return text.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi,'[EMAIL]').replace(/\+?\d[\d\s().-]{7,}\d/g,'[PHONE]');
}

// ─── Main Ingest ─────────────────────────────────────────────
function ingestCall(rawPayload, srcTag) {
  const db = getDb();
  const data = safeParse(rawPayload);
  const baseSource = detectSource(data, srcTag);

  // Unwrap Aloware's nested structure
  const { inner, event } = baseSource === 'Aloware' ? unwrapAloware(data) : { inner: data, event: '' };

  // Debug log
  db.prepare('INSERT INTO webhook_debug (src_tag,base_source,raw_payload) VALUES (?,?,?)').run(srcTag, baseSource, rawPayload);

  let repName = '';
  let role = baseSource === 'Aloware' ? 'Setter' : baseSource === 'Fathom' ? 'Closer' : 'Unknown';
  let repId = null;
  let resolvedSrcTag = srcTag;

  // Extract transcript early (needed for rep detection)
  let transcript = redact(extractTranscript(data, inner, baseSource));

  // Resolve rep
  if (baseSource === 'Aloware') {
    const detected = detectAlowareRep(inner, transcript);
    repName = detected.name;
    resolvedSrcTag = detected.srcTag;
    const row = db.prepare('SELECT id,name,role FROM rep_roster WHERE src_tag=? AND active=1').get(resolvedSrcTag);
    if (row) { repId = row.id; repName = row.name; role = row.role; }
  } else if (baseSource === 'Fathom') {
    repName = detectRepName(data);
    if (srcTag) {
      const row = db.prepare('SELECT id,name,role FROM rep_roster WHERE src_tag=? AND active=1').get(srcTag);
      if (row) { repId = row.id; repName = row.name; role = row.role; }
    }
  }

  const source = resolvedSrcTag ? `${baseSource} (${resolvedSrcTag})` : baseSource;
  const clientName = detectClientName(data, inner, baseSource);
  const callUrl = detectCallUrl(data, inner, baseSource);
  const audioUrl = detectAudioUrl(data, inner, baseSource);

  // For Aloware: use the call ID as the core dedup key
  // This way Recording-Saved and Transcription-Saved for the same call
  // can be linked together
  const alowareCallId = baseSource === 'Aloware' ? inner?.id : null;

  // Check if this Aloware call already exists (from Recording-Saved event)
  // If so, UPDATE it with transcript data instead of creating a duplicate
  if (alowareCallId) {
    const existingByAlowareId = db.prepare("SELECT id, status, transcript_chars FROM calls WHERE base_source='Aloware' AND call_url=?").get(`aloware:call:${alowareCallId}`);

    if (existingByAlowareId) {
      // Call already exists — update with new data if this event has more info
      const isTranscriptionEvent = event.toLowerCase().includes('transcription');

      if (isTranscriptionEvent && transcript && transcript.length > (existingByAlowareId.transcript_chars || 0)) {
        // Update existing row with transcript and metrics
        const metrics = extractMetrics(data, inner, baseSource, repName);

        // Check if this is actually a voicemail now that we have the transcript
        if (isVoicemail(inner, transcript, metrics)) {
          db.prepare("UPDATE calls SET transcript=?, transcript_chars=?, status='SKIP_VOICEMAIL', error='Voicemail detected from transcript.' WHERE id=?")
            .run(transcript, transcript.length, existingByAlowareId.id);
          db.close();
          return { ok: true, duplicate: false, callId: existingByAlowareId.id, status: 'SKIP_VOICEMAIL', message: 'OK' };
        }

        db.prepare(`UPDATE calls SET
          transcript=?, transcript_chars=?,
          call_duration_sec=COALESCE(?,call_duration_sec),
          agent_talk_pct=COALESCE(?,agent_talk_pct),
          contact_talk_pct=COALESCE(?,contact_talk_pct),
          audio_url=COALESCE(NULLIF(?,''  ),audio_url),
          status=CASE WHEN ? > 120 THEN 'NEW' ELSE 'SKIP_SHORT' END,
          error=''
          WHERE id=?`).run(
          transcript, transcript.length,
          metrics.durationSec, metrics.agentTalkPct, metrics.contactTalkPct,
          audioUrl,
          transcript.length,
          existingByAlowareId.id
        );
        db.close();
        return { ok: true, duplicate: false, callId: existingByAlowareId.id, status: 'UPDATED_WITH_TRANSCRIPT', message: 'OK' };
      }

      // Same call, no new transcript data — skip
      db.close();
      return { ok: true, duplicate: true, callId: existingByAlowareId.id, message: 'DUPLICATE_SKIPPED' };
    }
  }

  // Standard dedup check (for non-Aloware or first time)
  const extKey = buildDedupeKey(baseSource, resolvedSrcTag, inner, data, callUrl, transcript);
  if (extKey) {
    const exists = db.prepare('SELECT id FROM calls WHERE external_call_key=?').get(extKey);
    if (exists) { db.close(); return { ok: true, duplicate: true, callId: exists.id, message: 'DUPLICATE_SKIPPED' }; }
  }

  const metrics = extractMetrics(data, inner, baseSource, repName);
  const team = role === 'Setter' ? 'Turnkey - Setters' : role === 'Closer' ? 'Turnkey - Closers' : 'Turnkey';
  const ws = getWeekStart(new Date());

  // Determine status — voicemail check now uses transcript + metrics
  let status = 'NEW', error = '';
  if (!data) { status = 'ERROR'; error = 'PARSE_ERROR'; }
  else if (isVoicemail(inner, transcript, metrics)) { status = 'SKIP_VOICEMAIL'; error = 'Voicemail detected.'; }
  else if (!transcript || transcript.trim().length < 1) { status = 'WAIT_TRANSCRIPT'; error = 'Transcript not in payload. Will update when Transcription-Saved fires.'; }
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
