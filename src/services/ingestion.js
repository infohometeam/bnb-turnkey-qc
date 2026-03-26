const crypto = require('crypto');
const { q } = require('../../migrations/run');

const TEAM_NAMES = new Set(['sam','sam arnita','matt','matt snell','kevin','andrew','andrew niebur','andrew cluney','steven','anurag','francis']);
const VM_PHRASES = ['leave a message','after the tone','after the beep','not available','unavailable','voicemail','mailbox','record your message','please leave','at the tone','no one is available','cannot take your call','press 1','press one'];

function unwrapAloware(data) {
  if (data?.event && data?.body?.id) return { inner: data.body, event: String(data.event) };
  if (data?.body?.event && data?.body?.id) return { inner: data.body, event: String(data.body.event) };
  return { inner: data?.body || data, event: String(data?.event || '') };
}

function detectSource(data, srcTag) {
  if (!data) return srcTag?.startsWith('aloware') ? 'Aloware' : srcTag?.startsWith('fathom') ? 'Fathom' : 'Unknown';
  const evt = String(data.event || '').toLowerCase();
  if (evt.includes('recording') || evt.includes('transcription')) return 'Aloware';
  if (data.body?.id && data.body?.contact) return 'Aloware';
  if (data.meeting || Array.isArray(data.transcript)) return 'Fathom';
  return srcTag?.startsWith('aloware') ? 'Aloware' : srcTag?.startsWith('fathom') ? 'Fathom' : 'Unknown';
}

function detectAlowareRep(inner, transcript) {
  const email = (inner?.user_email || '').toLowerCase();
  if (email.includes('anurag')) return { name: 'Anurag', srcTag: 'aloware-setters-3' };
  if (email.includes('steven')) return { name: 'Steven', srcTag: 'aloware-setters-2' };
  if (email.includes('andrew')) return { name: 'Andrew', srcTag: 'aloware-setters' };
  const eng = (inner?.contact?.last_engagement_text || '').toLowerCase();
  if (eng.includes('anurag')) return { name: 'Anurag', srcTag: 'aloware-setters-3' };
  if (eng.includes('steven')) return { name: 'Steven', srcTag: 'aloware-setters-2' };
  if (eng.includes('andrew')) return { name: 'Andrew', srcTag: 'aloware-setters' };
  const low = (transcript || '').toLowerCase();
  for (const [name, tag] of [['anurag','aloware-setters-3'],['steven','aloware-setters-2'],['andrew','aloware-setters']]) {
    if ((low.match(new RegExp(name, 'g')) || []).length >= 2) return { name: name[0].toUpperCase() + name.slice(1), srcTag: tag };
  }
  return { name: 'Unknown Setter', srcTag: 'aloware-setters' };
}

function detectClientName(data, inner) {
  function isTeam(n) { return !n || TEAM_NAMES.has(n.toLowerCase().trim()); }
  if (inner?.contact) {
    const full = `${inner.contact.first_name || ''} ${inner.contact.last_name || ''}`.trim();
    if (full && !isTeam(full)) return full;
    if (inner.contact.name && !isTeam(inner.contact.name)) return inner.contact.name.trim();
  }
  if (Array.isArray(data?.calendar_invitees)) {
    for (const inv of data.calendar_invitees) {
      const nm = inv.name?.trim();
      if (nm && !isTeam(nm) && inv.is_external !== false) return nm;
    }
  }
  return '';
}

function extractTranscript(data, inner) {
  if (inner?.parsed_transcription?.messages && Array.isArray(inner.parsed_transcription.messages)) {
    return inner.parsed_transcription.messages.map(m => {
      const s = Math.max(0, Math.floor((Number(m.start) || 0) / 1000));
      return `[${String(Math.floor(s/60)).padStart(2,'0')}:${String(s%60).padStart(2,'0')}] ${m.speaker || 'SPEAKER'}: ${m.text || ''}`;
    }).join('\n');
  }
  if (inner?.call_transcription) return inner.call_transcription;
  if (inner?.transcription?.text) return inner.transcription.text;
  const arr = data?.transcript || data?.body?.transcript || inner?.transcript;
  if (Array.isArray(arr) && arr.length) {
    return arr.map(t => `[${t.timestamp || ''}] ${t.speaker?.display_name || t.speaker?.name || 'Speaker'}: ${t.text || ''}`).join('\n');
  }
  if (typeof data?.transcript === 'string' && data.transcript.length > 50) return data.transcript;
  return '';
}

function extractMetrics(data, inner, baseSource, repHint) {
  let dur = null, agPct = null, coPct = null;
  if (baseSource === 'Aloware' && inner) {
    if (fin(inner.duration)) dur = Number(inner.duration);
    if (!fin(dur) && fin(inner.talk_time)) dur = Number(inner.talk_time);
    const tta = inner.parsed_transcription?.talk_time_analysis;
    if (tta) { if (fin(tta.AGENT)) agPct = +tta.AGENT; if (fin(tta.CONTACT)) coPct = +tta.CONTACT; }
  }
  if (baseSource === 'Fathom') {
    const fd = data?.body || data;
    if (!fin(dur) && fd?.recording_start_time && fd?.recording_end_time) {
      const s = new Date(fd.recording_start_time), e = new Date(fd.recording_end_time);
      if (!isNaN(s.getTime()) && !isNaN(e.getTime())) dur = Math.max(0, Math.round((e - s) / 1000));
    }
    const tarr = fd?.transcript || data?.transcript;
    if (!fin(dur) && Array.isArray(tarr) && tarr.length) {
      const times = tarr.map(t => parseTsSec(t.timestamp)).filter(fin);
      if (times.length) dur = Math.max(...times);
    }
    if (Array.isArray(tarr) && tarr.length) {
      const agents = new Set();
      if (fd?.recorded_by?.name) agents.add(norm(fd.recorded_by.name));
      if (fd?.host?.name) agents.add(norm(fd.host.name));
      if (repHint) agents.add(norm(repHint));
      ['matt','kevin','matt snell'].forEach(n => agents.add(n));
      const intDom = (fd?.recorded_by?.email_domain || '').toLowerCase();
      let aw = 0, cw = 0;
      for (const t of tarr) {
        const sp = t.speaker || {};
        const spN = norm(sp.display_name || sp.name);
        const spE = (sp.matched_calendar_invitee_email || sp.email || '').toLowerCase();
        const w = (t.text || '').trim().split(/\s+/).filter(x=>x).length;
        if (!w) continue;
        let isAg = false;
        if (spN) for (const a of agents) if (nameMatch(spN, a)) { isAg = true; break; }
        if (!isAg && intDom && spE && spE.endsWith('@' + intDom)) isAg = true;
        if (!isAg && sp.is_external === false) isAg = true;
        if (isAg) aw += w; else cw += w;
      }
      const tot = aw + cw;
      if (tot > 0) { agPct = Math.round(aw / tot * 100); coPct = Math.round(cw / tot * 100); }
    }
  }
  if (fin(agPct)) agPct = Math.max(0, Math.min(100, agPct));
  if (fin(coPct)) coPct = Math.max(0, Math.min(100, coPct));
  return { durationSec: dur, agentTalkPct: agPct, contactTalkPct: coPct };
}

function isVoicemail(inner, transcript, metrics) {
  if (!inner) return false;
  if (inner.has_voicemail === true || Number(inner.voicemail_duration || 0) > 0 || inner.has_recording === false) return true;
  const dur = metrics?.durationSec || inner.duration || 0;
  if (inner.direction === 2 && dur > 0 && dur <= 90) {
    if ((!metrics?.agentTalkPct && !metrics?.contactTalkPct) || (metrics?.agentTalkPct === 0 && metrics?.contactTalkPct === 0)) return true;
  }
  if (transcript) {
    const low = transcript.toLowerCase();
    for (const p of VM_PHRASES) if (low.includes(p)) return true;
    const lines = transcript.split('\n').filter(l => l.trim());
    if (lines.length > 0 && lines.length <= 5 && dur <= 90) {
      const sp = new Set(); lines.forEach(l => { const m = l.match(/\]\s*([^:]+):/); if (m) sp.add(m[1].trim().toLowerCase()); });
      if (sp.size <= 1) return true;
    }
  }
  return false;
}

function redact(t) { return (t||'').replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi,'[EMAIL]').replace(/\+?\d[\d\s().-]{7,}\d/g,'[PHONE]'); }

function now() { return new Date().toISOString().replace('T',' ').slice(0,19); }

async function ingestCall(rawPayload, srcTag) {
  const data = safeParse(rawPayload);
  const baseSource = detectSource(data, srcTag);
  const { inner, event } = baseSource === 'Aloware' ? unwrapAloware(data) : { inner: data, event: '' };

  await q('INSERT INTO webhook_debug (received_at,src_tag,base_source,raw_payload) VALUES (?,?,?,?)', [now(), srcTag, baseSource, rawPayload]);

  let repName = '', role = baseSource === 'Aloware' ? 'Setter' : baseSource === 'Fathom' ? 'Closer' : 'Unknown';
  let repId = null, resolvedSrcTag = srcTag;
  let transcript = redact(extractTranscript(data, inner));

  if (baseSource === 'Aloware') {
    const det = detectAlowareRep(inner, transcript);
    repName = det.name; resolvedSrcTag = det.srcTag;
    const r = await q('SELECT id,name,role FROM rep_roster WHERE src_tag=? AND active=1', [resolvedSrcTag]);
    if (r.rows.length) { repId = r.rows[0].id; repName = r.rows[0].name; role = r.rows[0].role; }
  } else if (baseSource === 'Fathom') {
    repName = data?.recorded_by?.name || data?.host?.name || '';
    if (srcTag) { const r = await q('SELECT id,name,role FROM rep_roster WHERE src_tag=? AND active=1', [srcTag]); if (r.rows.length) { repId = r.rows[0].id; repName = r.rows[0].name; role = r.rows[0].role; } }
  }

  const source = resolvedSrcTag ? `${baseSource} (${resolvedSrcTag})` : baseSource;
  const clientName = detectClientName(data, inner);
  const callUrl = baseSource === 'Aloware' && inner?.id ? `aloware:call:${inner.id}` : (data?.share_url || data?.url || '');
  const audioUrl = baseSource === 'Aloware' ? (inner?.direct_recording_url || '') : (data?.share_url || '');
  const metrics = extractMetrics(data, inner, baseSource, repName);

  // Aloware two-event linking
  if (baseSource === 'Aloware' && inner?.id) {
    const existing = await q("SELECT id, status, transcript_chars FROM calls WHERE base_source='Aloware' AND call_url=?", [`aloware:call:${inner.id}`]);
    if (existing.rows.length) {
      const ex = existing.rows[0];
      if (event.toLowerCase().includes('transcription') && transcript && transcript.length > (ex.transcript_chars || 0)) {
        if (isVoicemail(inner, transcript, metrics)) {
          await q("UPDATE calls SET transcript=?, transcript_chars=?, status='SKIP_VOICEMAIL', error='Voicemail detected.' WHERE id=?", [transcript, transcript.length, ex.id]);
          return { ok: true, duplicate: false, callId: ex.id, status: 'SKIP_VOICEMAIL', message: 'OK' };
        }
        const newStatus = transcript.length > 120 ? 'NEW' : 'SKIP_SHORT';
        await q('UPDATE calls SET transcript=?, transcript_chars=?, call_duration_sec=COALESCE(?,call_duration_sec), agent_talk_pct=COALESCE(?,agent_talk_pct), contact_talk_pct=COALESCE(?,contact_talk_pct), status=?, error=? WHERE id=?',
          [transcript, transcript.length, metrics.durationSec, metrics.agentTalkPct, metrics.contactTalkPct, newStatus, '', ex.id]);
        return { ok: true, duplicate: false, callId: ex.id, status: 'UPDATED', message: 'OK' };
      }
      return { ok: true, duplicate: true, callId: ex.id, message: 'DUPLICATE_SKIPPED' };
    }
  }

  // Standard dedup
  const sid = baseSource === 'Aloware' ? (inner?.id || '') : (data?.meeting?.id || data?.id || '');
  const rawKey = [baseSource, resolvedSrcTag, String(sid), normUrl(callUrl), (transcript || '').slice(0, 500)].join('|');
  const extKey = rawKey.replace(/\|/g, '').trim() ? crypto.createHash('sha256').update(rawKey, 'utf8').digest('hex') : '';
  if (extKey) {
    const dup = await q('SELECT id FROM calls WHERE external_call_key=?', [extKey]);
    if (dup.rows.length) return { ok: true, duplicate: true, callId: dup.rows[0].id, message: 'DUPLICATE_SKIPPED' };
  }

  let status = 'NEW', error = '';
  if (!data) { status = 'ERROR'; error = 'PARSE_ERROR'; }
  else if (isVoicemail(inner, transcript, metrics)) { status = 'SKIP_VOICEMAIL'; error = 'Voicemail detected.'; }
  else if (!transcript || transcript.trim().length < 1) { status = 'WAIT_TRANSCRIPT'; error = 'Transcript not in payload.'; }
  else if (transcript.trim().length < 120) { status = 'SKIP_SHORT'; error = 'Too short.'; }

  const team = role === 'Setter' ? 'Turnkey - Setters' : role === 'Closer' ? 'Turnkey - Closers' : 'Turnkey';
  const dt = new Date(); const ws = getWeekStart(dt); const ts = now();

  const res = await q('INSERT INTO calls (received_at,source,base_source,src_tag,rep_name,rep_id,role,team,client_name,call_url,audio_url,external_call_key,transcript,transcript_chars,call_duration_sec,agent_talk_pct,contact_talk_pct,status,error,weekstart,queued_at,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
    [ts,source,baseSource,resolvedSrcTag,repName,repId,role,team,clientName,callUrl,audioUrl,extKey,transcript,transcript.length,metrics.durationSec,metrics.agentTalkPct,metrics.contactTalkPct,status,error,ws,ts,ts]);

  return { ok: true, duplicate: false, callId: Number(res.lastInsertRowid), status, message: 'OK' };
}

function safeParse(s) { if(!s)return null; try{return JSON.parse(s)}catch(e){} try{return JSON.parse(String(s).trim())}catch(e){} return null; }
function parseTsSec(ts) { const p=String(ts||'').trim().split(':').map(Number); if(p.some(n=>!isFinite(n)))return null; return p.length===2?p[0]*60+p[1]:p.length===3?p[0]*3600+p[1]*60+p[2]:null; }
function fin(v) { return typeof Number(v)==='number' && isFinite(Number(v)); }
function norm(s) { return (s||'').toLowerCase().replace(/[^\w\s]/g,' ').replace(/\s+/g,' ').trim(); }
function nameMatch(a,b) { const x=norm(a),y=norm(b); if(!x||!y)return false; if(x===y)return true; for(const xi of x.split(' '))for(const yi of y.split(' '))if(xi.length>=3&&xi===yi)return true; return false; }
function normUrl(u) { return String(u||'').trim().replace(/#.*$/,'').replace(/\?.*$/,'').replace(/\/+$/,'').toLowerCase(); }
function getWeekStart(d) { const dt=new Date(d); dt.setDate(dt.getDate()-(dt.getDay()+6)%7); dt.setHours(0,0,0,0); return dt.toISOString().slice(0,10); }

module.exports = { ingestCall };
