const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { PGlite } = require("@electric-sql/pglite");
const {
  totp,
  matchingStep,
  secretsFromEnv,
  createProgramSecurity,
  verifyMercadoPagoSignature,
} = require("../lib/program-security");
const secret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
test("TOTP RFC6238 SHA1: vetores oficiais e janela limitada", () => {
  for (const [time, code] of [
    [59, "94287082"],
    [1111111109, "07081804"],
    [1111111111, "14050471"],
    [1234567890, "89005924"],
    [2000000000, "69279037"],
    [20000000000, "65353130"],
  ]) {
    const step = Math.floor(time / 30);
    assert.equal(totp(secret, step, 8), code);
    assert.equal(matchingStep(secret, totp(secret, step), time * 1000), step);
    assert.equal(
      matchingStep(secret, totp(secret, step + 2), time * 1000),
      null,
    );
  }
  for (const invalid of [null, 123456, "12345", "1234567", "１２３４５６"])
    assert.equal(matchingStep(secret, invalid), null);
  assert.throws(() => secretsFromEnv("[]"));
  assert.throws(() => secretsFromEnv('{"a":"weak"}'));
  assert.equal(
    secretsFromEnv(JSON.stringify({ " ADMIN@TEST.COM ": secret }))[
      "admin@test.com"
    ],
    secret,
  );
});
test("assinatura Mercado Pago prende ID, request-id e timestamp; rejeita malformed e corpo cruzado", () => {
  const signature = crypto
    .createHmac("sha256", "webhook-secret")
    .update("id:abc123;request-id:req-123;ts:1750000000;")
    .digest("hex");
  const make = (extra = {}) => ({
    query: { "data.id": "ABC123" },
    body: { data: { id: "abc123" } },
    get: (name) =>
      ({
        "x-signature": `ts=1750000000,v1=${signature}`,
        "x-request-id": "req-123",
      })[name],
    ...extra,
  });
  assert.equal(verifyMercadoPagoSignature(make(), "webhook-secret"), true);
  assert.equal(verifyMercadoPagoSignature(make(), "wrong"), false);
  assert.equal(verifyMercadoPagoSignature(make(), ""), false);
  assert.equal(
    verifyMercadoPagoSignature(
      make({ body: { data: { id: "other" } } }),
      "webhook-secret",
    ),
    false,
  );
  assert.equal(
    verifyMercadoPagoSignature(
      make({ query: { "data.id": ["ABC123", "other"] } }),
      "webhook-secret",
    ),
    false,
  );
  for (const malformed of [
    "",
    `ts=1750000000,ts=1750000000,v1=${signature}`,
    `ts=1750000000,v1=${signature},v1=${signature}`,
    "ts=1750000000,v1=abcd",
    `ts=no,v1=${signature}`,
  ]) {
    const req = make();
    req.get = (name) => (name === "x-signature" ? malformed : "req-123");
    assert.equal(verifyMercadoPagoSignature(req, "webhook-secret"), false);
  }
});
test("2FA persistente: replay, vínculo de sessão, expiração e limite durável", async (t) => {
  const db = new PGlite();
  t.after(() => db.close());
  await db.exec(`CREATE TABLE admin_totp_usos(email text PRIMARY KEY,step bigint NOT NULL);
        CREATE TABLE admin_stepup(session_hash bytea PRIMARY KEY,email text NOT NULL,expires_at timestamptz NOT NULL);
        CREATE TABLE programa_rate_limits(key text PRIMARY KEY,hits integer NOT NULL,expires_at timestamptz NOT NULL);`);
  const pool = {
    query: (s, p) => db.query(s, p),
    connect: async () => ({ query: (s, p) => db.query(s, p), release() {} }),
  };
  const now = 1750000000000,
    security = createProgramSecurity(pool, {
      secrets: { "admin@test.com": secret },
      now: () => now,
    });
  const a = { email: "admin@test.com", tokenHash: Buffer.alloc(32, 1) },
    b = { ...a, tokenHash: Buffer.alloc(32, 2) };
  assert.equal(await security.active(a), false);
  assert.deepEqual(await security.verify(a, "bad"), {
    ok: false,
    code: "INVALID_OTP",
  });
  assert.deepEqual(
    await security.verify({ ...a, email: "unknown@test.com" }, "123456"),
    { ok: false, code: "ADMIN_2FA_NOT_CONFIGURED" },
  );
  const code = totp(secret, Math.floor(now / 30000));
  assert.deepEqual(await security.verify(a, code), { ok: true });
  assert.equal(await security.active(a), true);
  assert.equal(await security.active(b), false);
  assert.deepEqual(await security.verify(b, code), {
    ok: false,
    code: "OTP_REUSED",
  });
  assert.equal(await security.active({ ...a, email: "other@test.com" }), false);
  await db.exec(
    "UPDATE admin_stepup SET expires_at=CURRENT_TIMESTAMP-interval '1 second'",
  );
  assert.equal(await security.active(a), false);
  assert.equal(await security.consume("otp", "admin", 2, 300), true);
  assert.equal(await security.consume("otp", "admin", 2, 300), true);
  const securityRestart = createProgramSecurity(pool, { secrets: {} });
  assert.equal(await securityRestart.consume("otp", "admin", 2, 300), false);
  assert.equal(await securityRestart.consume("otp", "other", 2, 300), true);
  await db.exec(
    "UPDATE programa_rate_limits SET expires_at=CURRENT_TIMESTAMP-interval '1 second'",
  );
  assert.equal(await securityRestart.consume("otp", "admin", 2, 300), true);
});
