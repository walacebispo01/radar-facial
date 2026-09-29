const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { PGlite } = require("@electric-sql/pglite");
const { createStore } = require("../lib/postgres-store");
const { createSessionStore } = require("../lib/session-store");
const { createProgramSecurity, totp } = require("../lib/program-security");
const express = require("express");
const { mountProgram } = require("../lib/program-routes");

test("TOTP administrativo permanece acessível durante transição com programa desativado", async (t) => {
  const app = express();
  app.use(express.json());
  const auth = {
    requireSession(req, _res, next) { req.auth = { email: "admin@example.test" }; next(); },
    browserMutation(_req, _res, next) { next(); },
    csrf(_req, _res, next) { next(); },
  };
  const security = {
    active: async () => false,
    limiter: () => (_req, _res, next) => next(),
    verify: async (_auth, code) => ({ ok: code === "123456" }),
  };
  mountProgram(app, { auth, creators: null, commissions: null, security,
    isAdmin: email => email === "admin@example.test" });
  const server = app.listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}/api/programa`;
  const me = await fetch(base + "/me");
  assert.deepEqual(await me.json(), { success: true, enabled: false, isAdmin: true, creator: null, adminStepUp: false });
  const verified = await fetch(base + "/admin/verificar", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: "123456" }) });
  assert.equal(verified.status, 200);
  assert.equal((await verified.json()).success, true);
  assert.equal((await fetch(base + "/admin/criadores")).status, 503);
});

test("rotas exigem sessão, CSRF, administrador e 2FA; criador não troca identidade", async (t) => {
  const db = new PGlite();
  t.after(() => db.close());
  for (const file of [
    "schema-proposto.sql",
    "migrations/001-sessoes.sql",
    "migrations/002-criadores.sql",
    "migrations/003-comissoes-rede.sql",
  ])
    await db.exec(
      fs.readFileSync(path.join(__dirname, "../sql", file), "utf8"),
    );
  let tail = Promise.resolve();
  const pool = {
    async connect() {
      const previous = tail;
      let release;
      tail = new Promise((r) => (release = r));
      await previous;
      return { query: (s, p = []) => db.query(s, p), release };
    },
    async query(s, p) {
      const c = await pool.connect();
      try {
        return await c.query(s, p);
      } finally {
        c.release();
      }
    },
  };
  const old = process.env.ADMIN_EMAILS;
  process.env.ADMIN_EMAILS = "admin@example.test";
  t.after(() => {
    if (old === undefined) delete process.env.ADMIN_EMAILS;
    else process.env.ADMIN_EMAILS = old;
  });
  const secret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ",
    now = 1750000000000;
  const security = createProgramSecurity(pool, {
    secrets: { "admin@example.test": secret },
    now: () => now,
  });
  const calls = [];
  const creators = {
    me: async (email) =>
      email === "user@example.test"
        ? { id: "self", status: "ativo" }
        : email === "suspended@example.test"
          ? { id: "suspended", status: "suspenso" }
          : null,
    createCreator: async (data, actor) => {
      calls.push({ op: "create", data, actor });
      return { id: "created", ...data };
    },
    listCreators: async () => ({ items: [], total: 0 }),
    grantCredits: async (id, data, actor) => {
      calls.push({ op: "grant", id, data, actor });
      return { creditos: 5 };
    },
    canAccessNetwork: async (viewer, id) => viewer === "self" && id === "self",
    network: async () => ({
      items: [
        {
          id: "child",
          nome: "Child",
          email: "secret@test.com",
          percentual: 30,
          creditos: 500,
        },
      ],
      creator: { id: "self", email: "secret@test.com" },
      path: [],
    }),
    saveScenario: async (email, data) => {
      calls.push({ op: "scenario", email, data });
      return data;
    },
    runScenario: async (email, id) => {
      calls.push({ op: "run", email, id });
      return { id };
    },
  };
  const commissions = {
    listCommissions: async (filters, viewer) => {
      calls.push({ op: "commissions", filters, viewer });
      return { items: [], total: 0 };
    },
    paymentDetail: async (id, viewer) =>
      viewer === "self" && id === "own"
        ? { payment: { payment_id: id }, allocations: [], refunds: [] }
        : null,
    listIssues: async () => [],
    processPending: async () => {
      calls.push({ op: "retry" });
    },
  };
  const { createApp } = require("../server");
  const app = createApp({
    store: createStore(pool),
    sessions: createSessionStore(pool),
    payment: {},
    verifyGoogle: async (credential) => ({
      email: `${credential}@example.test`,
      sub: credential,
    }),
    creatorStore: creators,
    commissionProgram: commissions,
    programSecurity: security,
    appOrigin: "https://radarfacial.com.br",
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  t.after(() => new Promise((r) => server.close(r)));
  const base = `http://127.0.0.1:${server.address().port}`;
  async function request(
    route,
    method = "GET",
    session = null,
    body = {},
    extra = {},
  ) {
    const headers = {
      "content-type": "application/json",
      origin: "https://radarfacial.com.br",
      "x-radar-request": "1",
      ...(session
        ? { cookie: session.cookie, "x-csrf-token": session.csrfToken }
        : {}),
      ...extra,
    };
    const response = await fetch(base + route, {
      method,
      headers,
      ...(method !== "GET" ? { body: JSON.stringify(body) } : {}),
    });
    return {
      status: response.status,
      body: await response.json(),
      cookie: response.headers.get("set-cookie")?.split(";")[0],
    };
  }
  async function login(user) {
    const r = await request("/api/login-google", "POST", null, {
      credential: user,
    });
    assert.equal(r.status, 200);
    return { ...r.body, cookie: r.cookie };
  }
  const prefix = "/api/programa";
  assert.equal((await request(prefix + "/me")).status, 401);
  const user = await login("user"),
    admin = await login("admin"),
    suspended = await login("suspended");
  assert.equal(
    (await request(prefix + "/admin/criadores", "GET", user)).status,
    403,
  );
  assert.equal(
    (await request(prefix + "/admin/criadores", "POST", user, {})).status,
    403,
  );
  assert.equal(
    (
      await request(
        prefix + "/admin/criadores",
        "POST",
        admin,
        {},
        { "x-csrf-token": "A".repeat(43) },
      )
    ).body.code,
    "CSRF_INVALID",
  );
  assert.equal(
    (
      await request(
        prefix + "/admin/criadores",
        "POST",
        admin,
        {},
        { origin: "https://evil.test" },
      )
    ).status,
    403,
  );
  assert.equal(
    (await request(prefix + "/admin/criadores", "POST", admin, {})).body.code,
    "STEP_UP_REQUIRED",
  );
  assert.equal(
    (await request(prefix + "/admin/criadores", "GET", admin)).body.code,
    "STEP_UP_REQUIRED",
  );
  assert.equal(
    (
      await request("/api/admin/afiliados/criar", "POST", admin, {
        nome: "Legacy",
        percentual: 10,
      })
    ).body.code,
    "STEP_UP_REQUIRED",
  );
  assert.equal(
    (await request("/api/admin/simulacao/autorizar", "POST", admin, { email: "creator@example.test" })).body.code,
    "STEP_UP_REQUIRED",
  );
  assert.equal(
    (await request("/api/admin/simulacao/listar", "POST", admin, {})).body.code,
    "STEP_UP_REQUIRED",
  );
  const code = totp(secret, Math.floor(now / 30000));
  for (const route of [
    "/api/admin/afiliados/criar/",
    "/api/admin/afiliados/CRIAR",
    "/API/ADMIN/AFILIADOS/CRIAR/",
  ]) {
    assert.equal(
      (await request(route, "POST", admin, { nome: "Bypass", percentual: 10 }))
        .body.code,
      "STEP_UP_REQUIRED",
    );
  }
  assert.equal(
    (await request(prefix + "/admin/verificar", "POST", admin, { code }))
      .status,
    200,
  );
  assert.equal((await request(prefix + "/admin/criadores", "GET", admin)).status, 200);
  assert.equal((await request("/api/admin/simulacao/listar", "POST", admin, {})).status, 200);
  assert.equal(
    (
      await request(prefix + "/admin/criadores", "POST", admin, {
        nome: "New",
        email: "new@test.com",
        percentual: 10,
        motivo: "request",
        ator: "forged",
      })
    ).status,
    201,
  );
  assert.equal(calls.at(-1).actor, "admin@example.test");
  assert.equal(calls.at(-1).data.ator, undefined);
  assert.equal(
    (
      await request(prefix + "/admin/criadores/new/creditos", "POST", admin, {
        quantidade: 5,
        motivo: "request",
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await request(
        prefix + "/admin/criadores/new/creditos",
        "POST",
        admin,
        { quantidade: 5, motivo: "request" },
        { "idempotency-key": "request-123" },
      )
    ).status,
    200,
  );
  assert.equal(calls.at(-1).data.idempotency_key, "request-123");
  assert.equal(
    (
      await request(
        prefix + "/comissoes?creator_id=other&payment_id=123",
        "GET",
        user,
      )
    ).status,
    200,
  );
  assert.equal(calls.at(-1).viewer, "self");
  assert.equal(calls.at(-1).filters.creator_id, undefined);
  assert.equal(
    (await request(prefix + "/comissoes", "GET", suspended)).status,
    403,
  );
  assert.equal(
    (await request(prefix + "/comissoes/other", "GET", user)).status,
    404,
  );
  assert.equal(
    (await request(prefix + "/comissoes/own", "GET", user)).status,
    200,
  );
  assert.equal(
    (await request(prefix + "/rede/other", "GET", user)).status,
    403,
  );
  const network = await request(prefix + "/rede/self", "GET", user);
  assert.equal(network.body.items[0].email, undefined);
  assert.equal(network.body.items[0].percentual, undefined);
  assert.equal(network.body.creator.email, undefined);
  assert.equal(
    (
      await request(prefix + "/cenarios", "POST", user, {
        id: "scenario",
        nome: "Demo",
        links: ["https://example.test"],
        email: "other@example.test",
        criador_id: "other",
      })
    ).status,
    200,
  );
  assert.equal(calls.at(-1).email, "user@example.test");
  assert.equal(calls.at(-1).data.criador_id, undefined);
  assert.equal(
    (await request(prefix + "/cenarios/scenario/executar", "POST", user, {}))
      .status,
    200,
  );
  assert.deepEqual(calls.at(-1), {
    op: "run",
    email: "user@example.test",
    id: "scenario",
  });
  const noJson = await fetch(base + prefix + "/cenarios/scenario/executar", {
    method: "POST",
    headers: {
      origin: "https://radarfacial.com.br",
      "x-radar-request": "1",
      cookie: user.cookie,
      "x-csrf-token": user.csrfToken,
    },
  });
  assert.equal(noJson.status, 403);
  // A fresh login rotates the session: the same admin must step up again and cannot reuse the OTP.
  const second = await login("admin");
  assert.equal(
    (await request(prefix + "/admin/reprocessar", "POST", second)).body.code,
    "STEP_UP_REQUIRED",
  );
  assert.equal(
    (await request(prefix + "/admin/verificar", "POST", second, { code })).body
      .code,
    "OTP_REUSED",
  );
});
