const crypto = require("crypto");
const { StoreError } = require("./postgres-store");
const uid = (prefix) => `${prefix}_${crypto.randomUUID()}`;
function fail(message, status = 400) {
  throw new StoreError(message, status);
}
function text(value, max = 100) {
  if (typeof value !== "string" || !value.trim() || value.trim().length > max)
    fail("Texto inválido.");
  return value.trim();
}
function email(value) {
  const result = text(value, 160).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(result)) fail("E-mail inválido.");
  return result;
}
function percentage(value) {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < 0 ||
    value > 30 ||
    Math.abs(value * 100 - Math.round(value * 100)) > 1e-8
  )
    fail("Percentual inválido.");
  return value;
}
function pageNumber(value = 1) {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 1 || n > 10000) fail("Página inválida.");
  return n;
}
function api(row) {
  return row
    ? {
        ...row,
        percentual: Number(row.percentual),
        ...(row.creditos !== undefined
          ? { creditos: Number(row.creditos) }
          : {}),
      }
    : null;
}
function createCreatorStore(pool, { maxGrant = 1000 } = {}) {
  async function transaction(work) {
    const db = await pool.connect();
    try {
      await db.query("BEGIN");
      const result = await work(db);
      await db.query("COMMIT");
      return result;
    } catch (e) {
      await db.query("ROLLBACK");
      throw e;
    } finally {
      db.release();
    }
  }
  async function creator(db, id, lock = false) {
    const row = (
      await db.query(
        `SELECT * FROM public.criadores WHERE id=$1 ${lock ? "FOR UPDATE" : ""}`,
        [id],
      )
    ).rows[0];
    if (!row) fail("Criador não encontrado.", 404);
    return row;
  }
  async function audit(db, id, actor, action, reason, old, value) {
    await db.query(
      "INSERT INTO public.criadores_auditoria(id,criador_id,ator,acao,motivo,anterior,atual) VALUES($1,$2,$3,$4,$5,$6,$7)",
      [
        uid("aud"),
        id,
        email(actor),
        action,
        text(reason, 500),
        old ? JSON.stringify(old) : null,
        JSON.stringify(value),
      ],
    );
  }
  async function demoOwner(db, address, lock = false) {
    const row = (
      await db.query(
        "SELECT * FROM public.criadores WHERE email=$1 " +
          (lock ? "FOR UPDATE" : "FOR SHARE"),
        [email(address)],
      )
    ).rows[0];
    if (!row || row.status !== "ativo" || !row.demo_enabled)
      fail("Simulação não autorizada.", 403);
    return row;
  }
  const methods = {
    async assertLegacySimulationAccess(address) {
      const row = (await pool.query("SELECT status FROM public.criadores WHERE email=$1", [email(address)])).rows[0];
      if (row && row.status !== "ativo") fail("Criador suspenso.", 403);
      return true;
    },
    async recordLegacySimulation(address, links) {
      return transaction(async (db) => {
        const c = (await db.query("SELECT * FROM public.criadores WHERE email=$1 FOR SHARE", [email(address)])).rows[0];
        if (!c) return null;
        if (c.status !== "ativo") fail("Criador suspenso.", 403);
        const clean = (Array.isArray(links) ? links : []).slice(0, 2).map(url => ({ url: String(url), title: new URL(String(url)).hostname }));
        if (!clean.length) return null;
        let scenario = (await db.query("SELECT * FROM public.criadores_cenarios WHERE criador_id=$1 AND nome=$2 ORDER BY criado_em LIMIT 1", [c.id, "Modo Simulação atual"])).rows[0];
        if (!scenario) scenario = (await db.query("INSERT INTO public.criadores_cenarios(id,criador_id,nome,links) VALUES($1,$2,$3,$4) RETURNING *", [uid("demo"), c.id, "Modo Simulação atual", JSON.stringify(clean)])).rows[0];
        else scenario = (await db.query("UPDATE public.criadores_cenarios SET links=$2,atualizado_em=CURRENT_TIMESTAMP WHERE id=$1 RETURNING *", [scenario.id, JSON.stringify(clean)])).rows[0];
        const execution = uid("sim");
        await db.query("INSERT INTO public.criadores_simulacoes(id,criador_id,cenario_id,itens) VALUES($1,$2,$3,$4)", [execution, c.id, scenario.id, JSON.stringify(clean)]);
        return { execution_id: execution, scenario_id: scenario.id };
      });
    },
    async me(address) {
      return api(
        (
          await pool.query(
            "SELECT c.*,u.creditos FROM public.criadores c JOIN public.usuarios u USING(email) WHERE c.email=$1",
            [email(address)],
          )
        ).rows[0],
      );
    },
    async listCreators({ q = "", status = null, page = 1 } = {}) {
      if (status === "") status = null;
      page = pageNumber(page);
      if (
        typeof q !== "string" ||
        q.length > 100 ||
        (status !== null && !["ativo", "suspenso"].includes(status))
      )
        fail("Filtro inválido.");
      return transaction(async (db) => {
        const params = [`%${q}%`, status];
        const where =
          "WHERE (c.nome ILIKE $1 OR c.email ILIKE $1) AND ($2::text IS NULL OR c.status=$2)";
        const total = Number(
          (
            await db.query(
              `SELECT count(*) FROM public.criadores c ${where}`,
              params,
            )
          ).rows[0].count,
        );
        const items = (
          await db.query(
            `SELECT c.*,u.creditos FROM public.criadores c JOIN public.usuarios u USING(email) ${where} ORDER BY c.criado_em DESC,c.id LIMIT 30 OFFSET $3`,
            [...params, (page - 1) * 30],
          )
        ).rows.map(api);
        return { items, total, page };
      });
    },
    async createCreator(
      {
        nome,
        email: address,
        parent_id = null,
        percentual = 10,
        demo_enabled = false,
        motivo = "Cadastro administrativo",
      },
      actor,
    ) {
      nome = text(nome);
      address = email(address);
      percentage(percentual);
      email(actor);
      if (typeof demo_enabled !== "boolean") fail("Permissão inválida.");
      return transaction(async (db) => {
        let depth = 1;
        if (parent_id !== null) {
          const parent = await creator(db, parent_id, true);
          if (parent.status !== "ativo") fail("Indicador suspenso.");
          depth = parent.depth + 1;
          if (depth > 100) fail("Limite de 100 níveis.");
        }
        if (
          (
            await db.query("SELECT id FROM public.criadores WHERE email=$1", [
              address,
            ])
          ).rows.length
        )
          fail("E-mail já vinculado.", 409);
        await db.query(
          "INSERT INTO public.usuarios(email) VALUES($1) ON CONFLICT DO NOTHING",
          [address],
        );
        const affiliates = (
          await db.query(
            `SELECT a.codigo FROM public.afiliados a WHERE a.email=$1 AND NOT EXISTS(SELECT 1 FROM public.criadores c WHERE c.afiliado_codigo=a.codigo) ORDER BY a.criado_em,a.codigo FOR UPDATE`,
            [address],
          )
        ).rows;
        if (affiliates.length > 1)
          fail(
            "Há múltiplos afiliados para este e-mail; resolva o vínculo antes de continuar.",
            409,
          );
        let code = affiliates[0]?.codigo;
        if (code)
          await db.query(
            "UPDATE public.afiliados SET nome=$2,status='ativo',atualizado_em=CURRENT_TIMESTAMP WHERE codigo=$1",
            [code, nome],
          );
        if (!code) {
          code = `cr_${crypto.randomBytes(12).toString("hex")}`;
          await db.query(
            "INSERT INTO public.afiliados(codigo,id,nome,email,comissao_percentual) VALUES($1,$2,$3,$4,10)",
            [code, uid("af"), nome, address],
          );
        }
        const row = (
          await db.query(
            "INSERT INTO public.criadores(id,email,afiliado_codigo,nome,parent_id,depth,percentual,demo_enabled) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *",
            [
              uid("cr"),
              address,
              code,
              nome,
              parent_id,
              depth,
              percentual,
              demo_enabled,
            ],
          )
        ).rows[0];
        await audit(db, row.id, actor, "criacao", motivo, null, row);
        return api(row);
      });
    },
    async updateCreator(id, patch, actor) {
      const reason = text(patch.motivo, 500);
      email(actor);
      if (
        Object.keys(patch).some(
          (k) =>
            ![
              "percentual",
              "status",
              "demo_enabled",
              "nome",
              "motivo",
            ].includes(k),
        )
      )
        fail("Campo não permitido.");
      if (patch.percentual !== undefined) percentage(patch.percentual);
      if (
        patch.status !== undefined &&
        !["ativo", "suspenso"].includes(patch.status)
      )
        fail("Status inválido.");
      if (
        patch.demo_enabled !== undefined &&
        typeof patch.demo_enabled !== "boolean"
      )
        fail("Permissão inválida.");
      if (patch.nome !== undefined) text(patch.nome);
      return transaction(async (db) => {
        const old = await creator(db, id, true);
        const row = (
          await db.query(
            "UPDATE public.criadores SET percentual=$2,status=$3,demo_enabled=$4,nome=$5,atualizado_em=CURRENT_TIMESTAMP WHERE id=$1 RETURNING *",
            [
              id,
              patch.percentual ?? old.percentual,
              patch.status ?? old.status,
              patch.demo_enabled ?? old.demo_enabled,
              patch.nome?.trim() ?? old.nome,
            ],
          )
        ).rows[0];
        await db.query(
          "UPDATE public.afiliados SET nome=$2,status=$3,atualizado_em=CURRENT_TIMESTAMP WHERE codigo=$1",
          [
            row.afiliado_codigo,
            row.nome,
            row.status === "ativo" ? "ativo" : "inativo",
          ],
        );
        await audit(db, id, actor, "alteracao", reason, old, row);
        return api(row);
      });
    },
    async grantCredits(id, { quantidade, motivo, idempotency_key }, actor) {
      if (
        !Number.isSafeInteger(quantidade) ||
        quantidade < 1 ||
        quantidade > maxGrant
      )
        fail("Quantidade inválida.");
      motivo = text(motivo, 500);
      idempotency_key = text(idempotency_key, 160);
      actor = email(actor);
      return transaction(async (db) => {
        // Same key serializes even when requests target different creators.
        await db.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
          `grant:${idempotency_key}`,
        ]);
        const c = await creator(db, id, true);
        const prior = (
          await db.query(
            "SELECT * FROM public.criadores_creditos WHERE idempotency_key=$1",
            [idempotency_key],
          )
        ).rows[0];
        if (prior) {
          if (
            prior.criador_id !== id ||
            prior.quantidade !== quantidade ||
            prior.motivo !== motivo ||
            prior.ator !== actor
          )
            fail("Chave já usada para outra solicitação.", 409);
          const user = (
            await db.query(
              "SELECT creditos FROM public.usuarios WHERE email=$1",
              [c.email],
            )
          ).rows[0];
          return {
            id: prior.id,
            creditos: Number(user.creditos),
            saldo_depois: Number(prior.saldo_depois),
            quantidade,
            replayed: true,
          };
        }
        if (c.status !== "ativo") fail("Criador suspenso.", 409);
        const balance = (
          await db.query(
            "UPDATE public.usuarios SET creditos=creditos+$2 WHERE email=$1 AND creditos<=9007199254740991-$2 RETURNING creditos",
            [c.email, quantidade],
          )
        ).rows[0];
        if (!balance) fail("Saldo fora do limite.", 409);
        const grant = uid("grant");
        const creditos = Number(balance.creditos);
        await db.query(
          "INSERT INTO public.criadores_creditos(id,criador_id,quantidade,saldo_depois,motivo,ator,idempotency_key) VALUES($1,$2,$3,$4,$5,$6,$7)",
          [grant, id, quantidade, creditos, motivo, actor, idempotency_key],
        );
        await audit(
          db,
          id,
          actor,
          "creditos",
          motivo,
          { creditos: creditos - quantidade },
          { creditos, quantidade, grant_id: grant },
        );
        return { id: grant, creditos, quantidade, replayed: false };
      });
    },
    async creatorHistory(id) {
      return transaction(async (db) => {
        await creator(db, id);
        return {
          grants: (
            await db.query(
              "SELECT id,quantidade,saldo_depois,motivo,ator,criado_em FROM public.criadores_creditos WHERE criador_id=$1 ORDER BY criado_em DESC,id LIMIT 100",
              [id],
            )
          ).rows,
          audit: (
            await db.query(
              "SELECT * FROM public.criadores_auditoria WHERE criador_id=$1 ORDER BY criado_em DESC,id LIMIT 100",
              [id],
            )
          ).rows,
          simulations: (
            await db.query(
              "SELECT id,cenario_id,criado_em FROM public.criadores_simulacoes WHERE criador_id=$1 ORDER BY criado_em DESC,id LIMIT 100",
              [id],
            )
          ).rows,
        };
      });
    },
    async canAccessNetwork(viewerId, targetId) {
      return (
        (
          await pool.query(
            "WITH RECURSIVE p AS (SELECT id,parent_id,1 AS hops FROM public.criadores WHERE id=$1 UNION ALL SELECT c.id,c.parent_id,p.hops+1 FROM public.criadores c JOIN p ON c.id=p.parent_id WHERE p.hops<100) SELECT 1 FROM p WHERE id=$2",
            [targetId, viewerId],
          )
        ).rows.length > 0
      );
    },
    async network(id, { page = 1 } = {}) {
      page = pageNumber(page);
      return transaction(async (db) => {
        const c = await creator(db, id);
        const path = (
          await db.query(
            "WITH RECURSIVE p AS (SELECT id,nome,parent_id,depth FROM public.criadores WHERE id=$1 UNION ALL SELECT c.id,c.nome,c.parent_id,c.depth FROM public.criadores c JOIN p ON c.id=p.parent_id) SELECT * FROM p ORDER BY depth",
            [id],
          )
        ).rows;
        const items = (
          await db.query(
            "SELECT id,nome,parent_id,depth,status,criado_em FROM public.criadores WHERE parent_id=$1 ORDER BY criado_em,id LIMIT 30 OFFSET $2",
            [id, (page - 1) * 30],
          )
        ).rows;
        const total = Number(
          (
            await db.query(
              "SELECT count(*) FROM public.criadores WHERE parent_id=$1",
              [id],
            )
          ).rows[0].count,
        );
        return {
          creator: {
            id: c.id,
            nome: c.nome,
            parent_id: c.parent_id,
            depth: c.depth,
          },
          path,
          items,
          total,
          page,
        };
      });
    },
    async listScenarios(address) {
      return transaction(async (db) => {
        const c = await demoOwner(db, address);
        return (
          await db.query(
            "SELECT * FROM public.criadores_cenarios WHERE criador_id=$1 ORDER BY atualizado_em DESC,id LIMIT 100",
            [c.id],
          )
        ).rows;
      });
    },
    async saveScenario(address, { id = null, nome, links }) {
      nome = text(nome);
      if (!Array.isArray(links) || links.length < 1 || links.length > 20)
        fail("Use de 1 a 20 links.");
      const clean = links.map((link) => {
        if (!link || typeof link.url !== "string") fail("URL inválida.");
        let url;
        try {
          url = new URL(link.url);
        } catch {
          fail("URL inválida.");
        }
        if (
          !["https:", "http:"].includes(url.protocol) ||
          url.username ||
          url.password ||
          url.href.length > 2048
        )
          fail("URL inválida.");
        return {
          url: url.href,
          title: link.title ? text(link.title, 200) : url.hostname,
        };
      });
      return transaction(async (db) => {
        const c = await demoOwner(db, address, true);
        let row;
        if (id)
          row = (
            await db.query(
              "UPDATE public.criadores_cenarios SET nome=$3,links=$4,atualizado_em=CURRENT_TIMESTAMP WHERE id=$1 AND criador_id=$2 RETURNING *",
              [id, c.id, nome, JSON.stringify(clean)],
            )
          ).rows[0];
        else {
          const count = Number(
            (
              await db.query(
                "SELECT count(*) FROM public.criadores_cenarios WHERE criador_id=$1",
                [c.id],
              )
            ).rows[0].count,
          );
          if (count >= 100) fail("Limite de 100 cenários.", 409);
          row = (
            await db.query(
              "INSERT INTO public.criadores_cenarios(id,criador_id,nome,links) VALUES($1,$2,$3,$4) RETURNING *",
              [uid("demo"), c.id, nome, JSON.stringify(clean)],
            )
          ).rows[0];
        }
        if (!row) fail("Cenário não encontrado.", 404);
        return row;
      });
    },
    async runScenario(address, id) {
      return transaction(async (db) => {
        const c = await demoOwner(db, address);
        const scenario = (
          await db.query(
            "SELECT * FROM public.criadores_cenarios WHERE id=$1 AND criador_id=$2",
            [id, c.id],
          )
        ).rows[0];
        if (!scenario) fail("Cenário não encontrado.", 404);
        const execution_id = uid("sim");
        await db.query(
          "INSERT INTO public.criadores_simulacoes(id,criador_id,cenario_id,itens) VALUES($1,$2,$3,$4)",
          [execution_id, c.id, id, JSON.stringify(scenario.links)],
        );
        return { execution_id, items: scenario.links, scenario_id: id };
      });
    },
  };
  return Object.fromEntries(
    Object.entries(methods).map(([name, fn]) => [
      name,
      async (...args) => {
        try {
          return await fn(...args);
        } catch (e) {
          if (e instanceof StoreError) throw e;
          throw new StoreError();
        }
      },
    ]),
  );
}
module.exports = { createCreatorStore };
