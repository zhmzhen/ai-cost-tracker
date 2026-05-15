import { describe, expect, it } from "vitest";

import {
  decodeJwtPayload,
  parseJwtToToken,
  validateCachedToken,
} from "../../src/cursor";

/** Build a JWT-shaped string from a payload object. */
function jwt(
  payload: Record<string, unknown>,
  opts: { header?: object; signature?: string } = {},
): string {
  const header = Buffer.from(
    JSON.stringify(opts.header ?? { alg: "none", typ: "JWT" }),
  ).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = (opts.signature ?? "sig").toString();
  return `${header}.${body}.${sig}`;
}

const NOW = Math.floor(Date.now() / 1000);

describe("parseJwtToToken", () => {
  it("accepts a well-formed JWT with sub and exp", () => {
    const tok = parseJwtToToken(jwt({ sub: "auth0|alice", exp: NOW + 3600 }));
    expect(tok).not.toBeNull();
    expect(tok!.sub).toBe("auth0|alice");
    expect(tok!.expiresAt).toBe(NOW + 3600);
  });

  it("rejects strings that are not three dot-separated parts", () => {
    expect(parseJwtToToken("")).toBeNull();
    expect(parseJwtToToken("only.one")).toBeNull();
    expect(parseJwtToToken("a.b.c.d")).toBeNull();
  });

  it("rejects a payload that is not valid base64url JSON", () => {
    // Middle segment "%%%" is not valid base64url; decode either fails
    // or yields garbage that does not JSON-parse.
    expect(parseJwtToToken("eyJhbGciOiJub25lIn0.%%%.sig")).toBeNull();
  });

  it("rejects a payload missing `sub`", () => {
    expect(parseJwtToToken(jwt({ exp: NOW + 3600 }))).toBeNull();
  });

  it("rejects a payload whose `sub` is not a string", () => {
    expect(
      parseJwtToToken(jwt({ sub: 123 as unknown as string, exp: NOW + 3600 })),
    ).toBeNull();
  });

  it("rejects a payload missing `exp`", () => {
    expect(parseJwtToToken(jwt({ sub: "auth0|alice" }))).toBeNull();
  });

  it("rejects a payload whose `exp` is non-numeric", () => {
    expect(
      parseJwtToToken(
        jwt({ sub: "auth0|alice", exp: "soon" as unknown as number }),
      ),
    ).toBeNull();
  });

  it("retains the original token string in the result", () => {
    const raw = jwt({ sub: "auth0|alice", exp: NOW + 3600 });
    expect(parseJwtToToken(raw)?.token).toBe(raw);
  });
});

describe("decodeJwtPayload", () => {
  it("decodes a normal payload", () => {
    const raw = jwt({ sub: "x", exp: NOW, claim: 42 });
    expect(decodeJwtPayload(raw)).toEqual({ sub: "x", exp: NOW, claim: 42 });
  });

  it("returns null when there are not exactly two dots", () => {
    expect(decodeJwtPayload("a.b")).toBeNull();
    expect(decodeJwtPayload("a.b.c.d")).toBeNull();
  });

  it("returns null when the payload base64url is corrupt", () => {
    expect(decodeJwtPayload("eyJhbGciOiJub25lIn0...sig")).toBeNull();
  });

  it("returns null when the payload decodes to a non-object", () => {
    const numericPayload = Buffer.from("42").toString("base64url");
    expect(decodeJwtPayload(`eyJhbGciOiJub25lIn0.${numericPayload}.sig`)).toBeNull();
  });
});

describe("validateCachedToken", () => {
  it("returns the token when it is shaped correctly and not yet expiring", () => {
    const tok = { token: "j.w.t", sub: "auth0|alice", expiresAt: NOW + 3600 };
    expect(validateCachedToken(tok)).toBe(tok);
  });

  it("returns null when the cached entry is undefined", () => {
    expect(validateCachedToken(undefined)).toBeNull();
  });

  it("returns null when the token string is empty", () => {
    expect(
      validateCachedToken({ token: "", sub: "x", expiresAt: NOW + 3600 }),
    ).toBeNull();
  });

  it("returns null when sub is empty", () => {
    expect(
      validateCachedToken({ token: "j.w.t", sub: "", expiresAt: NOW + 3600 }),
    ).toBeNull();
  });

  it("returns null when the token expires within the 60-second skew window", () => {
    expect(
      validateCachedToken({ token: "j.w.t", sub: "x", expiresAt: NOW + 30 }),
    ).toBeNull();
  });

  it("returns null when the token has already expired", () => {
    expect(
      validateCachedToken({ token: "j.w.t", sub: "x", expiresAt: NOW - 1 }),
    ).toBeNull();
  });
});
