/**
 * JWT decode + cached-token validation. Pure, no I/O, no sql.js, no
 * Cursor-specific schemas. Lives in its own module so both
 * {@link "./cursor"} and {@link "./diagnostics"} can import it without
 * creating a cycle between them.
 */

export interface AccessToken {
  token: string;
  sub: string;
  expiresAt: number; // unix seconds
}

/**
 * Decode a JWT we cached previously, return it only if still valid.
 * Centralized so the extension layer doesn't reimplement the expiry logic.
 *
 * 60-second skew window: we treat tokens that expire in under a minute as
 * already-expired so a slow network round-trip doesn't strand the user.
 */
export function validateCachedToken(
  token: AccessToken | undefined,
): AccessToken | null {
  if (!token) return null;
  if (!token.token || !token.sub) return null;
  if (token.expiresAt < Date.now() / 1000 + 60) return null;
  return token;
}

/**
 * Decode a JWT string into an AccessToken; null if shape/payload is wrong.
 */
export function parseJwtToToken(raw: string): AccessToken | null {
  if (raw.split(".").length !== 3) return null;
  const payload = decodeJwtPayload(raw);
  if (!payload) return null;
  const sub = typeof payload.sub === "string" ? payload.sub : "";
  const exp = Number(payload.exp);
  if (!sub || !Number.isFinite(exp)) return null;
  return { token: raw, sub, expiresAt: exp };
}

/** Decode the middle segment of a JWT to an object. Null on any error. */
export function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const parts = token.split(".");
  if (parts.length !== 3) {
    return null;
  }
  try {
    const json = Buffer.from(parts[1], "base64url").toString("utf8");
    const obj = JSON.parse(json);
    return typeof obj === "object" && obj !== null ? obj : null;
  } catch {
    return null;
  }
}
