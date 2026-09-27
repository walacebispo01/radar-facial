const crypto = require("crypto");
const SCALE = 1000000n;
function units(value) {
  const s = String(value);
  if (!/^\d+(\.\d{1,6})?$/.test(s)) throw new Error("Valor monetário inválido");
  const [a, b = ""] = s.split(".");
  return BigInt(a) * SCALE + BigInt(b.padEnd(6, "0"));
}
function decimal(value) {
  return `${value / SCALE}.${String(value % SCALE).padStart(6, "0")}`;
}
function buildSnapshot(amount, chain) {
  if (
    !chain.length ||
    chain.length > 100 ||
    new Set(chain.map((x) => x.id)).size !== chain.length
  )
    throw new Error("Rede inválida");
  const rate = units(chain[0].percentual);
  if (rate > 30n * SCALE) throw new Error("Percentual inválido");
  const sale = units(amount),
    pool = (sale * rate) / (100n * SCALE);
  const allocations = [];
  const put = (role, person, value) =>
    allocations.push({
      parcela: role,
      criador_id: person?.status === "ativo" ? person.id : null,
      beneficiario_original: person?.id || null,
      valor: decimal(value),
      retida: person?.status !== "ativo",
    });
  const seller = (pool * 70n) / 100n,
    direct = (pool * 15n) / 100n,
    root = (pool * 5n) / 100n;
  put("vendedor", chain[0], seller);
  put("indicador", chain[1], direct);
  put("inicial", chain.length > 1 ? chain.at(-1) : null, root);
  const others = chain.slice(2, -1),
    rest = pool - seller - direct - root;
  if (!others.length) put("demais", null, rest);
  else
    others.forEach((person, i) =>
      put(
        `nivel_${i + 3}`,
        person,
        rest / BigInt(others.length) +
          (BigInt(i) < rest % BigInt(others.length) ? 1n : 0n),
      ),
    );
  return {
    version: 1,
    moeda: "BRL",
    valor_venda: decimal(sale),
    percentual: String(chain[0].percentual),
    comissao_base: decimal(pool),
    chain: chain.map((x) => ({
      id: x.id,
      parent_id: x.parent_id,
      status: x.status,
    })),
    allocations,
  };
}
function cumulativeReversals(snapshot, refunded) {
  const amount = units(snapshot.valor_venda),
    refund = units(refunded);
  if (refund > amount) throw new Error("Reembolso superior à venda");
  return snapshot.allocations.map((a) => ({
    ...a,
    valor: decimal(amount ? (units(a.valor) * refund) / amount : 0n),
  }));
}
function reportFilters(filters) {
  const fail = () => {
    const error = new Error("Filtros de comissão inválidos.");
    error.status = 400;
    throw error;
  };
  const scalar = (key) => {
    const value = filters[key];
    if (value == null || value === "") return null;
    if (!["string", "number"].includes(typeof value)) fail();
    return String(value);
  };
  const integer = (key, fallback, max) => {
    const value = scalar(key);
    if (value === null) return fallback;
    if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > max)
      fail();
    return Number(value);
  };
  const choice = (key, choices) => {
    const value = scalar(key);
    if (value && !choices.includes(value)) fail();
    return value;
  };
  const identifier = (key) => {
    const value = scalar(key);
    if (value && !/^[\w-]{1,100}$/.test(value)) fail();
    return value;
  };
  const date = (key, end = false) => {
    const value = scalar(key);
    if (!value) return null;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) fail();
    const parsed = new Date(`${value}T00:00:00Z`);
    if (
      !Number.isFinite(parsed.getTime()) ||
      parsed.toISOString().slice(0, 10) !== value
    )
      fail();
    return `${value}T${end ? "23:59:59.999999" : "00:00:00"}-03:00`;
  };
  const percentual = scalar("percentual");
  if (
    percentual &&
    (!/^\d{1,2}(\.\d{1,2})?$/.test(percentual) || Number(percentual) > 30)
  )
    fail();
  const from = date("from"),
    to = date("to", true);
  if (from && to && from.slice(0, 10) > to.slice(0, 10)) fail();
  return {
    page: integer("page", 1, 1000000),
    limit: integer("limit", 20, 100),
    creator_id: identifier("creator_id"),
    payment_id: identifier("payment_id"),
    from,
    to,
    percentual,
    status: choice("status", [
      "pending",
      "approved",
      "authorized",
      "in_process",
      "in_mediation",
      "rejected",
      "cancelled",
      "refunded",
      "charged_back",
    ]),
    origin: choice("origin", ["direct", "network"]),
    refund: choice("refund", ["partial", "full"]),
    level: integer("level", null, 100),
  };
}
function createCommissionProgram(pool) {
  async function snapshotPayment(db, payment) {
    if (!payment.afiliado_codigo) return;
    const { rows: chain } = await db.query(
      `WITH RECURSIVE rede AS (
            SELECT c.*, 1 AS nivel, ARRAY[c.id] AS caminho FROM public.criadores c WHERE afiliado_codigo=$1
            UNION ALL SELECT c.*,r.nivel+1,r.caminho||c.id FROM public.criadores c JOIN rede r ON c.id=r.parent_id
            WHERE r.nivel<100 AND NOT c.id=ANY(r.caminho)) SELECT * FROM rede ORDER BY nivel`,
      [payment.afiliado_codigo],
    );
    if (!chain.length) return;
    if (chain.at(-1).parent_id) throw new Error("Rede incompleta ou cíclica");
    const snapshot = buildSnapshot(payment.valor_pago, chain);
    await db.query(
      "UPDATE public.transacoes SET criador_programa=true,criador_snapshot=$2 WHERE payment_id=$1 AND criador_snapshot IS NULL",
      [payment.payment_id, snapshot],
    );
    payment.criador_programa = true;
    payment.criador_snapshot = snapshot;
  }
  async function enqueuePayment(db, payment, remote) {
    if (!payment.criador_programa) return;
    const payload = {
      status: remote.status,
      credited: payment.credited || remote.status === "approved",
      refunded: remote.transaction_amount_refunded ?? 0,
      refunds: Array.isArray(remote.refunds)
        ? remote.refunds.map((r) => ({
            id: String(r?.id),
            amount: r?.amount,
            status: r?.status,
          }))
        : [],
      invalidRefunds: remote.refunds != null && !Array.isArray(remote.refunds),
    };
    const key = crypto
      .createHash("sha256")
      .update(JSON.stringify([payment.payment_id, payload]))
      .digest("hex");
    await db.query(
      `INSERT INTO public.comissoes_rede_eventos(payment_id,evento_chave,payload) VALUES($1,$2,$3) ON CONFLICT DO NOTHING`,
      [payment.payment_id, key, payload],
    );
  }
  async function processPending(limit = 20) {
    const result = { processed: 0, failed: 0 };
    const pending = await pool.query(
      `SELECT id FROM public.comissoes_rede_eventos WHERE status='pendente' ORDER BY tentativas,id LIMIT $1`,
      [Math.max(1, Math.min(100, Number(limit) || 20))],
    );
    for (const item of pending.rows) {
      const db = await pool.connect();
      try {
        await db.query("BEGIN");
        const event = (
          await db.query(
            `SELECT * FROM public.comissoes_rede_eventos WHERE id=$1 AND status='pendente' FOR UPDATE SKIP LOCKED`,
            [item.id],
          )
        ).rows[0];
        if (!event) {
          await db.query("COMMIT");
          continue;
        }
        const payment = (
          await db.query(
            "SELECT * FROM public.transacoes WHERE payment_id=$1 FOR UPDATE",
            [event.payment_id],
          )
        ).rows[0];
        const s = payment.criador_snapshot,
          p = event.payload;
        if (!s || s.version !== 1)
          throw new Error("Snapshot ausente ou versão desconhecida");
        if (p.invalidRefunds) throw new Error("Lista de reembolsos inválida");
        if (p.credited) {
          for (const a of s.allocations)
            await db.query(
              `INSERT INTO public.comissoes_rede_lancamentos(payment_id,criador_id,parcela,tipo,valor,evento_chave)
                        VALUES($1,$2,$3,'comissao',$4,'original') ON CONFLICT DO NOTHING`,
              [payment.payment_id, a.criador_id, a.parcela, a.valor],
            );
        }
        // A retry may process an older approval after a refund event. Always apply
        // the greatest cumulative refund already observed, including pending events.
        const refundAmount = (payload) => {
          const amount = ["refunded", "charged_back", "cancelled"].includes(
            payload.status,
          )
            ? units(s.valor_venda)
            : units(payload.refunded);
          if (amount > units(s.valor_venda))
            throw new Error("Reembolso superior à venda");
          return amount;
        };
        // Invalid events remain pending for review, but cannot poison later valid events.
        let refund = refundAmount(p);
        const observed = (
          await db.query(
            "SELECT payload FROM public.comissoes_rede_eventos WHERE payment_id=$1",
            [payment.payment_id],
          )
        ).rows;
        for (const { payload } of observed) {
          try {
            const amount = refundAmount(payload);
            if (amount > refund) refund = amount;
          } catch (_) {
            /* The event's own processing records its issue. */
          }
        }
        for (const r of p.refunds) {
          if (!r.id || r.id === "undefined")
            throw new Error("Reembolso sem identificador");
          await db.query(
            `INSERT INTO public.comissoes_rede_reembolsos(payment_id,refund_id,valor,status) VALUES($1,$2,$3,$4)
                        ON CONFLICT(payment_id,refund_id) DO UPDATE SET status=EXCLUDED.status`,
            [
              payment.payment_id,
              r.id,
              decimal(units(r.amount)),
              r.status || null,
            ],
          );
        }
        const granted = (
          await db.query(
            `SELECT parcela FROM public.comissoes_rede_lancamentos WHERE payment_id=$1 AND tipo='comissao'`,
            [payment.payment_id],
          )
        ).rows;
        if (granted.length)
          for (const a of cumulativeReversals(s, decimal(refund))) {
            const previous = (
              await db.query(
                `SELECT COALESCE(sum(valor),0) AS valor FROM public.comissoes_rede_lancamentos WHERE payment_id=$1 AND parcela=$2 AND tipo='estorno'`,
                [payment.payment_id, a.parcela],
              )
            ).rows[0];
            const delta = units(a.valor) - units(previous.valor);
            if (delta > 0n)
              await db.query(
                `INSERT INTO public.comissoes_rede_lancamentos(payment_id,criador_id,parcela,tipo,valor,evento_chave)
                        VALUES($1,$2,$3,'estorno',$4,$5) ON CONFLICT DO NOTHING`,
                [
                  payment.payment_id,
                  a.criador_id,
                  a.parcela,
                  decimal(delta),
                  event.evento_chave,
                ],
              );
          }
        await db.query(
          `UPDATE public.comissoes_rede_eventos SET status='concluido',tentativas=tentativas+1,ultimo_erro=NULL WHERE id=$1`,
          [event.id],
        );
        await db.query("COMMIT");
        result.processed++;
      } catch (error) {
        await db.query("ROLLBACK");
        await db.query(
          `UPDATE public.comissoes_rede_eventos SET tentativas=tentativas+1,ultimo_erro=$2 WHERE id=$1`,
          [item.id, String(error.message).slice(0, 500)],
        );
        result.failed++;
      } finally {
        db.release();
      }
    }
    return result;
  }
  async function listCommissions(filters = {}, viewerCreatorId = null) {
    filters = reportFilters(filters);
    const { page, limit } = filters;
    const args = [
      viewerCreatorId || filters.creator_id || null,
      filters.payment_id || null,
      filters.from,
      filters.to,
      filters.status || null,
      filters.origin || null,
      filters.level || null,
      filters.percentual || null,
      filters.refund || null,
    ];
    const level = `CASE WHEN l.parcela='vendedor' THEN 1 WHEN l.parcela='indicador' THEN 2 WHEN l.parcela='inicial' THEN jsonb_array_length(t.criador_snapshot->'chain') WHEN l.parcela LIKE 'nivel_%' THEN split_part(l.parcela,'_',2)::integer ELSE NULL END`;
    const join = `FROM public.comissoes_rede_lancamentos l JOIN public.transacoes t ON t.payment_id=l.payment_id`;
    const where = `WHERE ($1::text IS NULL OR l.criador_id=$1) AND ($2::text IS NULL OR l.payment_id=$2)
            AND ($3::timestamptz IS NULL OR l.criado_em >= $3) AND ($4::timestamptz IS NULL OR l.criado_em <= $4)
            AND ($5::text IS NULL OR t.status=$5) AND ($6::text IS NULL OR ($6='direct' AND l.parcela='vendedor') OR ($6='network' AND l.parcela<>'vendedor'))
            AND ($7::integer IS NULL OR (${level})=$7) AND ($8::numeric IS NULL OR (t.criador_snapshot->>'percentual')::numeric=$8)
            AND ($9::text IS NULL OR EXISTS(SELECT 1 FROM public.comissoes_rede_lancamentos r WHERE r.payment_id=l.payment_id
                GROUP BY r.payment_id HAVING sum(r.valor) FILTER(WHERE r.tipo='estorno')>0 AND
                (($9='full' AND sum(r.valor) FILTER(WHERE r.tipo='estorno')=sum(r.valor) FILTER(WHERE r.tipo='comissao')) OR
                 ($9='partial' AND sum(r.valor) FILTER(WHERE r.tipo='estorno')<sum(r.valor) FILTER(WHERE r.tipo='comissao')))))`;
    const totals = (
      await pool.query(
        `SELECT count(*)::integer AS total,
            COALESCE(sum(valor) FILTER(WHERE tipo='comissao'),0)::text AS comissao,
            COALESCE(sum(valor) FILTER(WHERE tipo='estorno'),0)::text AS estorno,
            COALESCE(sum(CASE WHEN tipo='comissao' THEN valor ELSE -valor END),0)::text AS saldo
            ${join} ${where}`,
        args,
      )
    ).rows[0];
    const items = (
      await pool.query(
        `SELECT l.*,c.nome AS criador_nome,t.status,t.criador_snapshot->>'percentual' AS percentual,
            ${level} AS nivel,CASE WHEN l.parcela='vendedor' THEN 'direct' ELSE 'network' END AS origem ${join}
            LEFT JOIN public.criadores c ON c.id=l.criador_id ${where} ORDER BY l.id DESC LIMIT $10 OFFSET $11`,
        [...args, limit, (page - 1) * limit],
      )
    ).rows;
    return { items, total: totals.total, page, totals };
  }
  async function paymentDetail(paymentId, viewerCreatorId = null) {
    const payment = (
      await pool.query(
        `SELECT payment_id,status,valor_pago,criado_em,criador_snapshot FROM public.transacoes
            WHERE payment_id=$1 AND criador_programa=true AND ($2::text IS NULL OR EXISTS(SELECT 1 FROM public.comissoes_rede_lancamentos WHERE payment_id=$1 AND criador_id=$2))`,
        [paymentId, viewerCreatorId],
      )
    ).rows[0];
    if (!payment) return null;
    const allocations = (
      await pool.query(
        `SELECT * FROM public.comissoes_rede_lancamentos WHERE payment_id=$1 AND ($2::text IS NULL OR criador_id=$2) ORDER BY id`,
        [paymentId, viewerCreatorId],
      )
    ).rows;
    const refunds = (
      await pool.query(
        "SELECT * FROM public.comissoes_rede_reembolsos WHERE payment_id=$1 ORDER BY criado_em",
        [paymentId],
      )
    ).rows;
    if (viewerCreatorId) delete payment.criador_snapshot;
    return { payment, allocations, refunds };
  }
  async function listIssues() {
    return (
      await pool.query(
        `SELECT id,payment_id,tentativas,ultimo_erro,criado_em FROM public.comissoes_rede_eventos WHERE status='pendente' ORDER BY id LIMIT 100`,
      )
    ).rows;
  }
  return {
    snapshotPayment,
    enqueuePayment,
    processPending,
    listCommissions,
    paymentDetail,
    listIssues,
  };
}
module.exports = {
  createCommissionProgram,
  buildSnapshot,
  cumulativeReversals,
  units,
  decimal,
};
