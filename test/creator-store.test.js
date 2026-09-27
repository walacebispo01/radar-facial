const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { PGlite } = require("@electric-sql/pglite");
const { createCreatorStore } = require("../lib/creator-store");
function poolFor(db) {
  let tail = Promise.resolve();
  const pool = {
    async connect() {
      const old = tail;
      let release;
      tail = new Promise((r) => (release = r));
      await old;
      return { query: (q, p) => db.query(q, p), release };
    },
    async query(q, p) {
      const c = await pool.connect();
      try {
        return await c.query(q, p);
      } finally {
        c.release();
      }
    },
  };
  return pool;
}
test("Criadores: árvore, auditoria, créditos e simulação isolada", async (t) => {
  const db = new PGlite();
  t.after(() => db.close());
  for (const file of ["schema-proposto.sql", "migrations/002-criadores.sql"])
    await db.exec(
      fs.readFileSync(path.join(__dirname, "../sql", file), "utf8"),
    );
  const store = createCreatorStore(poolFor(db));
  const actor = "admin@example.test";
  const root = await store.createCreator(
    {
      nome: "Raiz",
      email: "root@example.test",
      percentual: 30,
      demo_enabled: true,
    },
    actor,
  );
  const child = await store.createCreator(
    {
      nome: "Filho",
      email: "child@example.test",
      parent_id: root.id,
      demo_enabled: true,
    },
    actor,
  );
  await t.test("vínculo explícito e árvore imutável", async () => {
    assert.equal((await store.me(root.email)).id, root.id);
    assert.equal(await store.me("unknown@example.test"), null);
    assert.equal(child.depth, 2);
    assert.equal(await store.canAccessNetwork(root.id, child.id), true);
    assert.equal(await store.canAccessNetwork(child.id, root.id), false);
    assert.equal((await store.network(root.id)).items[0].id, child.id);
    await assert.rejects(
      db.query("UPDATE public.criadores SET parent_id=$2 WHERE id=$1", [
        root.id,
        child.id,
      ]),
    );
    await assert.rejects(
      store.createCreator({ nome: "Duplicado", email: root.email }, actor),
      { status: 409 },
    );
    await assert.rejects(
      store.updateCreator(
        child.id,
        { parent_id: null, motivo: "troca" },
        actor,
      ),
      { status: 400 },
    );
  });
  await t.test(
    "limite de percentual, alteração e histórico preservado",
    async () => {
      await assert.rejects(
        store.updateCreator(
          root.id,
          { percentual: 31, motivo: "teste" },
          actor,
        ),
        { status: 400 },
      );
      await store.updateCreator(
        root.id,
        { percentual: 15, motivo: "Nova política" },
        actor,
      );
      const history = await store.creatorHistory(root.id);
      const change = history.audit.find((x) => x.acao === "alteracao");
      assert.equal(Number(change.anterior.percentual), 30);
      assert.equal(Number(change.atual.percentual), 15);
      await assert.rejects(
        db.query("DELETE FROM public.criadores_auditoria WHERE id=$1", [
          change.id,
        ]),
      );
    },
  );
  await t.test(
    "créditos idempotentes com conflito de payload e saldo atômico",
    async () => {
      const payload = {
        quantidade: 10,
        motivo: "Cortesia",
        idempotency_key: "same-key",
      };
      const results = await Promise.all(
        Array.from({ length: 5 }, () =>
          store.grantCredits(root.id, payload, actor),
        ),
      );
      assert.equal(results.filter((x) => !x.replayed).length, 1);
      assert.equal((await store.me(root.email)).creditos, 10);
      await assert.rejects(
        store.grantCredits(root.id, { ...payload, quantidade: 11 }, actor),
        { status: 409 },
      );
      await assert.rejects(store.grantCredits(child.id, payload, actor), {
        status: 409,
      });
      await assert.rejects(
        store.grantCredits(root.id, { ...payload, quantidade: 1001 }, actor),
        { status: 400 },
      );
      await assert.rejects(
        store.grantCredits(root.id, { ...payload, quantidade: 1.5 }, actor),
        { status: 400 },
      );
      assert.equal((await store.creatorHistory(root.id)).grants.length, 1);
    },
  );
  await t.test(
    "simulação exige dono autorizado e não movimenta saldo",
    async () => {
      const scenario = await store.saveScenario(root.email, {
        nome: "Exemplo",
        links: [{ url: "https://example.test/prova", title: "Resultado" }],
      });
      await assert.rejects(
        store.saveScenario(root.email, {
          nome: "Ruim",
          links: [{ url: "javascript:alert(1)" }],
        }),
        { status: 400 },
      );
      await assert.rejects(
        store.saveScenario(root.email, {
          nome: "Ruim",
          links: [{ url: "https://a:b@example.test/" }],
        }),
        { status: 400 },
      );
      await assert.rejects(store.runScenario(child.email, scenario.id), {
        status: 404,
      });
      await assert.rejects(
        store.saveScenario(child.email, {
          id: scenario.id,
          nome: "Outro",
          links: [{ url: "https://example.test" }],
        }),
        { status: 404 },
      );
      const run = await store.runScenario(root.email, scenario.id);
      assert.equal(run.items.length, 1);
      assert.equal((await store.me(root.email)).creditos, 10);
      assert.equal((await store.creatorHistory(root.id)).simulations.length, 1);
      await store.updateCreator(
        root.id,
        { demo_enabled: false, motivo: "Desabilitar" },
        actor,
      );
      await assert.rejects(store.runScenario(root.email, scenario.id), {
        status: 403,
      });
    },
  );
  await t.test(
    "limite de 100 níveis é validado no banco e no serviço",
    async () => {
      let parent = child;
      for (let level = 3; level <= 100; level++)
        parent = await store.createCreator(
          {
            nome: `Nível ${level}`,
            email: `level${level}@example.test`,
            parent_id: parent.id,
          },
          actor,
        );
      assert.equal(parent.depth, 100);
      await assert.rejects(
        store.createCreator(
          {
            nome: "Excesso",
            email: "excess@example.test",
            parent_id: parent.id,
          },
          actor,
        ),
        { status: 400 },
      );
      assert.equal(await store.canAccessNetwork(root.id, parent.id), true);
      await assert.rejects(store.listCreators({ page: 0 }), { status: 400 });
      const list = await store.listCreators();
      assert.equal(list.items.length, 30);
      assert.equal(list.total, 100);
    },
  );
  await t.test(
    "validação negativa e precisão, filtro vazio e histórico imutável",
    async () => {
      for (const percentual of [-1, 30.001, Infinity, NaN, "10"])
        await assert.rejects(
          store.updateCreator(
            root.id,
            { percentual, motivo: "Inválido" },
            actor,
          ),
          { status: 400 },
        );
      for (const quantidade of [-1, 0, 0.5, 1001, Number.MAX_SAFE_INTEGER, "1"])
        await assert.rejects(
          store.grantCredits(
            root.id,
            { quantidade, motivo: "Inválido", idempotency_key: "invalid" },
            actor,
          ),
          { status: 400 },
        );
      for (const url of [
        "data:text/html,hi",
        "file:///tmp/foo",
        "ftp://example.test/a",
      ])
        await assert.rejects(
          store.saveScenario(root.email, {
            nome: "URL insegura",
            links: [{ url }],
          }),
          { status: 400 },
        );
      assert.equal((await store.listCreators({ status: "" })).total, 100);
      const grant = (await store.creatorHistory(root.id)).grants[0];
      await assert.rejects(
        db.query(
          "UPDATE public.criadores_creditos SET quantidade=99 WHERE id=$1",
          [grant.id],
        ),
      );
      await assert.rejects(db.query("DELETE FROM public.criadores_simulacoes"));
      await store.grantCredits(
        root.id,
        { quantidade: 2, motivo: "Adicional", idempotency_key: "additional" },
        actor,
      );
      const replay = await store.grantCredits(
        root.id,
        { quantidade: 10, motivo: "Cortesia", idempotency_key: "same-key" },
        actor,
      );
      assert.equal(replay.creditos, 12);
      assert.equal(replay.saldo_depois, 10);
      const results = await Promise.allSettled(
        [1, 2].map((quantidade) =>
          store.grantCredits(
            root.id,
            { quantidade, motivo: "Corrida", idempotency_key: "race" },
            actor,
          ),
        ),
      );
      assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
      assert.equal(
        results.find((r) => r.status === "rejected").reason.status,
        409,
      );
    },
  );
  await t.test(
    "afiliado legado inativo é ativado pelo cadastro explícito auditado",
    async () => {
      await db.query(
        "INSERT INTO public.afiliados(codigo,id,nome,email,comissao_percentual,status) VALUES('legacy','legacy-id','Antigo','legacy@example.test',10,'inativo')",
      );
      const c = await store.createCreator(
        {
          nome: "Novo",
          email: "legacy@example.test",
          motivo: "Migração aprovada",
        },
        actor,
      );
      assert.equal(c.afiliado_codigo, "legacy");
      assert.equal(
        (
          await db.query(
            "SELECT status FROM public.afiliados WHERE codigo='legacy'",
          )
        ).rows[0].status,
        "ativo",
      );
      assert.equal(
        (await store.creatorHistory(c.id)).audit[0].motivo,
        "Migração aprovada",
      );
    },
  );
  await t.test("suspensão bloqueia créditos e simulação", async () => {
    await store.updateCreator(
      child.id,
      { status: "suspenso", motivo: "Pausa" },
      actor,
    );
    await assert.rejects(
      store.grantCredits(
        child.id,
        { quantidade: 1, motivo: "teste", idempotency_key: "blocked" },
        actor,
      ),
      { status: 409 },
    );
    await assert.rejects(store.listScenarios(child.email), { status: 403 });
  });
});
