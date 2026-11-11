// Bearer token check. Both sides are hashed first so the constant-time compare always sees
// equal-length buffers and the token length does not leak through timing.
import { createHash, timingSafeEqual } from 'node:crypto';

const digest = (s) => createHash('sha256').update(s, 'utf8').digest();

/** True only when the request carries `Authorization: Bearer <expected>`. No token configured: always false. */
export function requireToken(req, expected) {
  if (typeof expected !== 'string' || expected === '') return false;
  const header = req.headers?.authorization;
  if (typeof header !== 'string') return false;
  const m = /^Bearer (.+)$/.exec(header);
  if (!m) return false;
  return timingSafeEqual(digest(m[1]), digest(expected));
}
