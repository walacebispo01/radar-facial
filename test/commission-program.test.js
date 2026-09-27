const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { PGlite } = require("@electric-sql/pglite");
const {
  buildSnapshot,
  cumulativeReversals,
  units,
  createCommissionProgram,
} = require("../lib/commission-program");
const { createStore } = require("../lib/postgres-store");
const chain = (n) =>
  Array.from({ length: n }, (_, i) => ({
    id: `c${n - i}`,
    parent_id: i < n - 1 ? `c${n - i - 1}` : null,
    status: "ativo",
    percentual: "10.00",
  }));
test("divisão exata de 1, 2, 3 e 100 níveis, com resíduos determinísticos", () => {
  for (const n of [1, 2, 3, 100]) {
    const s = buildSnapshot("100.01", chain(n));
    assert.equal(
      s.allocations.reduce((a, x) => a + units(x.valor), 0n),
      units(s.comissao_base),
    );
    assert.deepEqual(buildSnapshot("100.01", chain(n)), s);
    if (n === 1)
      assert.equal(s.allocations.filter((x) => x.criador_id).length, 1);
    if (n === 2)
      assert.equal(
        s.allocations.filter((x) => x.criador_id === "c1").length,
        2,
      );
    if (n === 3) assert.equal(s.allocations.at(-1).criador_id, null);
    if (n === 100) assert.equal(s.allocations.length, 100);
  }
  const s = buildSnapshot("100", chain(4));
  assert.deepEqual(
    s.allocations.map((x) => x.valor),
    ["7.000000", "1.500000", "0.500000", "1.000000"],
  );
  const c = chain(4);
  c[1].status = "suspenso";
  assert.equal(buildSnapshot("100", c).allocations[1].criador_id, null);
  assert.equal(buildSnapshot("100", c).allocations[3].valor, "1.000000");
});
test("estorno proporcional cumulativo exato no reembolso total", () => {
  const s = buildSnapshot("100.01", chain(100));
  assert.deepEqual(cumulativeReversals(s, "100.01"), s.allocations);
  assert.throws(() => cumulativeReversals(s, "101"));
  for (const a of cumulativeReversals(s, "33.33"))
    assert.ok(units(a.valor) >= 0n);
});
function memoryPool(db) {
  let tail = Promise.resolve();
  const pool = {
    async connect() {
      const prev = tail;
      let release;
      tail = new Promise((r) => (release = r));
      await prev;
      return { query: (s, p = []) => db.query(s, p), release };
    },
    async query(s, p) {
      const client = await pool.connect();
      try {
        return await client.query(s, p);
      } finally {
        client.release();
      }
    },
  };
  return pool;
}
test("snapshot, outbox durável, legado, filtros, reembolsos e isolamento", async (t) => {
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
  const pool = memoryPool(db),
    program = createCommissionProgram(pool),
    store = createStore(pool, { commissionProgram: program });
  for (let i = 1; i <= 4; i++) {
    await pool.query("INSERT INTO usuarios(email) VALUES($1)", [
      `c${i}@test.com`,
    ]);
    await pool.query(
      `INSERT INTO afiliados(codigo,id,nome,comissao_percentual) VALUES($1::text,$1::text,$1::text,10)`,
      [`a${i}`],
    );
    await pool.query(
      `INSERT INTO criadores(id,email,afiliado_codigo,nome,parent_id,depth,percentual) VALUES($1,$2,$3,$1,$4,$5,10)`,
      [`c${i}`, `c${i}@test.com`, `a${i}`, i > 1 ? `c${i - 1}` : null, i],
    );
  }
  let sequence = 0;
  async function payment(af = "a4", legacy = false) {
    const id = String(++sequence);
    const data = {
      payment_id: id,
      email: `buyer${id}@test.com`,
      buscas_restantes: 10,
      status: "pending",
      idempotency_key: id,
      afiliado_codigo: af,
      valor_pago: 100,
    };
    await (legacy ? createStore(pool) : store).createPayment(data);
    return data;
  }
  const remote =
    (p, status = "approved", refund = 0) =>
    async () => ({
      id: p.payment_id,
      status,
      currency_id: "BRL",
      transaction_amount: 100,
      transaction_amount_refunded: refund,
      refunds: refund
        ? [{ id: `r${refund}`, amount: refund, status: "approved" }]
        : [],
    });
  const p = await payment();
  await pool.query(
    "UPDATE criadores SET percentual=30,status='suspenso' WHERE id='c4'",
  );
  await store.createPayment(p); // must never resnapshot an existing payment
  assert.equal(
    (
      await pool.query(
        "SELECT criador_snapshot FROM transacoes WHERE payment_id=$1",
        [p.payment_id],
      )
    ).rows[0].criador_snapshot.percentual,
    "10.00",
  );
  await assert.rejects(
    store.syncPayment(p.payment_id, async () => ({
      id: p.payment_id,
      status: "approved",
      currency_id: "USD",
      transaction_amount: 100,
    })),
    /moeda/,
  );
  await assert.rejects(
    store.syncPayment(p.payment_id, async () => ({
      id: p.payment_id,
      status: "approved",
      currency_id: "BRL",
      transaction_amount: 100.001,
    })),
    /Valor/,
  );
  for (let i = 0; i < 3; i++) await store.syncPayment(p.payment_id, remote(p));
  assert.equal(await store.login(p.email), 10);
  assert.equal(
    (await pool.query("SELECT count(*) AS n FROM comissoes_afiliados")).rows[0]
      .n,
    0,
  );
  await program.processPending();
  let list = await program.listCommissions({}, "c4");
  assert.equal(list.items.length, 1);
  assert.equal(list.totals.saldo, "7.000000");
  assert.equal(
    (await program.paymentDetail(p.payment_id, "c4")).payment.criador_snapshot,
    undefined,
  );
  assert.equal(await program.paymentDetail(p.payment_id, "not-owner"), null);
  await store.syncPayment(p.payment_id, remote(p, "approved", 25));
  await program.processPending();
  assert.equal(
    (await program.listCommissions({}, "c4")).totals.saldo,
    "5.250000",
  );
  await store.syncPayment(p.payment_id, remote(p, "approved", 25));
  await store.syncPayment(p.payment_id, remote(p, "approved", 10)); // lower cumulative snapshot cannot undo reversals
  await program.processPending();
  assert.equal(
    (await program.listCommissions({}, "c4")).totals.saldo,
    "5.250000",
  );
  assert.ok(
    (await program.listCommissions({ refund: "partial" }, "c4")).items.length,
  );
  await store.syncPayment(p.payment_id, remote(p, "refunded", 100));
  await program.processPending();
  await program.processPending();
  list = await program.listCommissions({
    creator_id: "c4",
    level: 1,
    origin: "direct",
    percentual: 10,
    refund: "full",
    status: "refunded",
  });
  assert.equal(list.totals.saldo, "0.000000");
  assert.equal(list.total, 3);
  await assert.rejects(
    pool.query("UPDATE comissoes_rede_lancamentos SET valor=0"),
    /imutáveis/,
  );
  await assert.rejects(
    pool.query(
      "UPDATE transacoes SET criador_snapshot='{}' WHERE payment_id=$1",
      [p.payment_id],
    ),
    /imutável/,
  );
  const old = await payment("a4", true);
  await store.createPayment(old);
  assert.equal(
    (
      await pool.query(
        "SELECT criador_programa FROM transacoes WHERE payment_id=$1",
        [old.payment_id],
      )
    ).rows[0].criador_programa,
    false,
  );
  await store.syncPayment(old.payment_id, remote(old));
  assert.equal(
    (await pool.query("SELECT count(*) AS n FROM comissoes_afiliados")).rows[0]
      .n,
    1,
  );
  const bad = await payment("a1");
  await store.syncPayment(bad.payment_id, remote(bad, "approved", 101));
  assert.equal(await store.login(bad.email), 10);
  assert.equal((await program.processPending()).failed, 1);
  assert.equal((await program.listIssues()).length, 1);
  assert.equal(
    (
      await pool.query(
        "SELECT count(*) AS n FROM comissoes_rede_lancamentos WHERE payment_id=$1",
        [bad.payment_id],
      )
    ).rows[0].n,
    0,
  );
  assert.equal(await store.login(bad.email), 10);
  const retry = await payment("a2");
  await db.exec(`CREATE FUNCTION falhar_comissao_teste() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Falha temporária'; END $$;
        CREATE TRIGGER falhar_comissao_teste BEFORE INSERT ON comissoes_rede_lancamentos FOR EACH ROW EXECUTE FUNCTION falhar_comissao_teste();`);
  await Promise.all(
    Array.from({ length: 3 }, () =>
      store.syncPayment(retry.payment_id, remote(retry)),
    ),
  );
  assert.equal(await store.login(retry.email), 10);
  assert.equal((await program.processPending()).failed, 2);
  await db.exec(
    "DROP TRIGGER falhar_comissao_teste ON comissoes_rede_lancamentos; DROP FUNCTION falhar_comissao_teste();",
  );
  assert.equal((await program.processPending()).processed, 1);
  assert.equal(
    (await program.listCommissions({ payment_id: retry.payment_id }, "c2"))
      .totals.saldo,
    "7.000000",
  );
  assert.equal(await store.login(retry.email), 10);
  const reordered = await payment("a3");
  await store.syncPayment(
    reordered.payment_id,
    remote(reordered, "refunded", 100),
  );
  await program.processPending();
  await store.syncPayment(
    reordered.payment_id,
    remote(reordered, "approved", 0),
  );
  assert.equal(await store.login(reordered.email), 0);
  // An approval queued before a terminal event may retry later independently of syncPayment.
  const stored = (
    await pool.query("SELECT * FROM transacoes WHERE payment_id=$1", [
      reordered.payment_id,
    ])
  ).rows[0];
  await program.enqueuePayment(
    pool,
    stored,
    await remote(reordered, "approved", 0)(),
  );
  await program.processPending();
  assert.equal(
    (await program.listCommissions({ payment_id: reordered.payment_id }, "c3"))
      .totals.saldo,
    "0.000000",
  );
  for (const filters of [
    { page: "1 OR 1=1" },
    { level: 101 },
    { percentual: 31 },
    { from: "2026-02-30" },
    { to: "2026-01-01", from: "2026-02-01" },
    { creator_id: ["a", "b"] },
    { status: "oops" },
    { origin: "oops" },
    { refund: "oops" },
  ]) {
    await assert.rejects(
      program.listCommissions(filters),
      (error) => error.status === 400,
    );
  }
  await store.syncPayment(bad.payment_id, remote(bad, "approved", 0));
  await program.processPending();
  assert.equal(
    (await program.listCommissions({ payment_id: bad.payment_id }, "c1")).totals
      .saldo,
    "7.000000",
  );
  await store.syncPayment(bad.payment_id, remote(bad, "refunded", 100));
  await program.processPending();
  assert.equal(
    (await program.listCommissions({ payment_id: bad.payment_id }, "c1")).totals
      .saldo,
    "0.000000",
  );
  assert.equal((await program.listIssues()).length, 1);
});
