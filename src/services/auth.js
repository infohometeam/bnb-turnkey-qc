// ─────────────────────────────────────────────────────────────────
// Single-credential admin gate — NOT the full multi-user auth system.
//
// Design (Francis, Jul 24): no login wall on browsing at all. Everything
// read-only, Train, and Reports stay completely open. ONE shared admin
// credential exists purely to unlock mutating actions — editing/deleting
// calls, confirming tags, roster changes, queue actions, calibration.
// No `users` table, no per-person roles — that's the full USERS_ROLES_spec.md
// build, deliberately not this. This is the fast, safe interim step.
//
// Zero new dependencies — HMAC-SHA256 via Node's built-in `crypto`, matching
// the project's lean-dependency discipline (no jsonwebtoken, no express-session).
// Bearer-token header, not a cookie — avoids CORS/SameSite complexity for no
// real benefit at this scale, and fits the existing fetch()-based frontend.
// ─────────────────────────────────────────────────────────────────

const crypto = require('crypto');

const TTL_MS = 24 * 60 * 60 * 1000; // 24h — re-login once a day, simple and sufficient

function getSecret() {
  const s = process.env.AUTH_SECRET;
  if (!s) throw new Error('AUTH_SECRET is not set — required for admin auth. Set it in Render → Environment.');
  return s;
}

// Sign a payload into a compact, tamper-evident token: base64url(payload).hmacSignature
function sign(payloadObj) {
  const payload = Buffer.from(JSON.stringify(payloadObj)).toString('base64url');
  const sig = crypto.createHmac('sha256', getSecret()).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

// Verify signature (timing-safe) + expiry. Returns the payload or null — never throws
// on a malformed/tampered token, so callers can always just check truthiness.
function verify(token) {
  if (!token || typeof token !== 'string' || !token.includes('.')) return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [payload, sig] = parts;
  let expectedSig;
  try { expectedSig = crypto.createHmac('sha256', getSecret()).update(payload).digest('base64url'); }
  catch { return null; }
  const a = Buffer.from(sig || '');
  const b = Buffer.from(expectedSig);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  let data;
  try { data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')); } catch { return null; }
  if (!data || data.role !== 'admin' || !data.exp || Date.now() > data.exp) return null;
  return data;
}

function tokenFromReq(req) {
  const auth = req.headers.authorization || '';
  return auth.startsWith('Bearer ') ? auth.slice(7) : null;
}

// Middleware: fails closed. No token, expired token, or tampered token → 401.
// This is the ONLY thing that stands between an anonymous visitor and every
// mutating endpoint — deliberately simple so it's easy to verify correct.
function requireAdmin(req, res, next) {
  const data = verify(tokenFromReq(req));
  if (!data) return res.status(401).json({ error: 'Admin login required for this action.' });
  req.admin = data;
  next();
}

module.exports = { sign, verify, requireAdmin, tokenFromReq, TTL_MS };
