const crypto = require('crypto');

class StoreError extends Error {
    constructor(message = 'Falha na persistência PostgreSQL.', status = 500) {
        super(message);
        this.name = 'StoreError';
        this.status = status;
    }
}

function inteiro(value) {
    const result = Number(value);
    if (!Number.isSafeInteger(result)) throw new StoreError('Quantidade fora do limite seguro.');
    return result;
}

function moeda(value) {
    const result = Number(value);
    if (!Number.isFinite(result) || result < 0 || result > 9999999999.99) {
        throw new StoreError('Valor monetário fora do limite permitido.');
    }
    return result.toFixed(2);
}

function id(prefix) { return `${prefix}_${crypto.randomUUID()}`; }
function hash(value) { return crypto.createHash('sha256').update(value).digest('hex'); }

function repasseApi(row) {
    const { idempotency_key, ...result } = row;
    return { ...result, valor: Number(row.valor), quantidade_comissoes: inteiro(row.quantidade_comissoes) };
}

function createStore(pool) {
    async function transaction(work, readOnly = false) {
        const db = await pool.connect();
        let broken;
        try {
            await db.query(readOnly ? 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY' : 'BEGIN');
            const result = await work(db);
            await db.query('COMMIT');
            return result;
        } catch (error) {
            try { await db.query('ROLLBACK'); } catch (rollbackError) { broken = rollbackError; }
            throw error;
        } finally {
            db.release(broken);
        }
    }

    async function summaries(db, codigo = null) {
        const { rows } = await db.query(
            'SELECT * FROM public.resumo_afiliados WHERE ($1::text IS NULL OR codigo = $1) ORDER BY criado_em DESC', [codigo]);
        const repasses = await db.query(
            'SELECT * FROM public.repasses_afiliados WHERE ($1::text IS NULL OR afiliado_codigo = $1) ORDER BY pago_em DESC', [codigo]);
        return rows.map(row => {
            const { cliques, vendas, conversao, faturamento, comissao_total,
                comissao_disponivel, comissao_paga, total_repassado_historico,
                total_ajustes_registrados, ...afiliado } = row;
            return {
                ...afiliado,
                metricas: { cliques: inteiro(cliques), vendas: inteiro(vendas), conversao: Number(conversao),
                    faturamento: Number(faturamento), comissao_total: Number(comissao_total),
                    comissao_disponivel: Number(comissao_disponivel), comissao_paga: Number(comissao_paga) },
                repasses: repasses.rows.filter(r => r.afiliado_codigo === row.codigo).map(repasseApi),
            };
        });
    }

    async function ensureUser(db, email) {
        await db.query('INSERT INTO public.usuarios (email) VALUES ($1) ON CONFLICT (email) DO NOTHING', [email]);
    }

    const methods = {
        async beginFaceSearch(email, idempotencyKey) {
            return transaction(async db => {
                await ensureUser(db, email);
                const user = (await db.query(
                    'SELECT creditos FROM public.usuarios WHERE email = $1 FOR UPDATE', [email])).rows[0];

                // Recupera créditos de operações abandonadas por queda do processo.
                const stale = await db.query(`UPDATE public.buscas_faciais
                    SET status = 'reembolsada', atualizado_em = CURRENT_TIMESTAMP
                    WHERE usuario_email = $1 AND status = 'processando'
                    AND criado_em < CURRENT_TIMESTAMP - INTERVAL '15 minutes' RETURNING id`, [email]);
                if (stale.rows.length) {
                    await db.query('UPDATE public.usuarios SET creditos = creditos + $2 WHERE email = $1',
                        [email, stale.rows.length]);
                }

                const existing = (await db.query(`SELECT id, status, resposta
                    FROM public.buscas_faciais WHERE usuario_email = $1 AND idempotency_key = $2`,
                [email, idempotencyKey])).rows[0];
                const currentBalance = Number(user.creditos) + stale.rows.length;
                if (existing) return { ...existing, creditos: currentBalance, reused: true };

                const debited = await db.query(`UPDATE public.usuarios SET creditos = creditos - 1
                    WHERE email = $1 AND creditos > 0 RETURNING creditos`, [email]);
                if (!debited.rows.length) return { status: 'sem_credito', creditos: 0 };
                const inserted = (await db.query(`INSERT INTO public.buscas_faciais
                    (usuario_email, idempotency_key, status) VALUES ($1, $2, 'processando') RETURNING id, status`,
                [email, idempotencyKey])).rows[0];
                return { ...inserted, creditos: inteiro(debited.rows[0].creditos), reused: false };
            });
        },

        async completeFaceSearch(id, email, response) {
            return transaction(async db => {
                const updated = await db.query(`UPDATE public.buscas_faciais
                    SET status = 'concluida', resposta = $3::jsonb, atualizado_em = CURRENT_TIMESTAMP
                    WHERE id = $1 AND usuario_email = $2 AND status = 'processando' RETURNING id`,
                [id, email, JSON.stringify(response)]);
                if (!updated.rows.length) throw new StoreError('A busca não pôde ser concluída.', 409);
                return inteiro((await db.query(
                    'SELECT creditos FROM public.usuarios WHERE email = $1', [email])).rows[0].creditos);
            });
        },

        async refundFaceSearch(id, email) {
            return transaction(async db => {
                const search = (await db.query(`SELECT status FROM public.buscas_faciais
                    WHERE id = $1 AND usuario_email = $2 FOR UPDATE`, [id, email])).rows[0];
                if (!search) throw new StoreError('Busca não encontrada.', 404);
                if (search.status === 'processando') {
                    await db.query(`UPDATE public.buscas_faciais SET status = 'reembolsada',
                        atualizado_em = CURRENT_TIMESTAMP WHERE id = $1`, [id]);
                    await db.query('UPDATE public.usuarios SET creditos = creditos + 1 WHERE email = $1', [email]);
                }
                return inteiro((await db.query(
                    'SELECT creditos FROM public.usuarios WHERE email = $1', [email])).rows[0].creditos);
            });
        },

        async paymentBelongsToUser(paymentId, email) {
            const result = await pool.query(
                'SELECT 1 FROM public.transacoes WHERE payment_id = $1 AND email = $2', [paymentId, email]);
            return result.rows.length > 0;
        },

        async login(email) {
            return transaction(async db => {
                await ensureUser(db, email);
                return inteiro((await db.query('SELECT creditos FROM public.usuarios WHERE email = $1', [email])).rows[0].creditos);
            });
        },

        async debit(email) {
            // Verificação e desconto na mesma instrução: nunca perde atualizações nem fica negativo.
            const { rows } = await pool.query(`UPDATE public.usuarios SET creditos = creditos - 1
                WHERE email = $1 AND creditos > 0 AND creditos <= 9007199254740991 RETURNING creditos`, [email]);
            return rows.length ? inteiro(rows[0].creditos) : null;
        },

        async findAffiliate(codigo) {
            return (await pool.query('SELECT * FROM public.afiliados WHERE codigo = $1', [codigo])).rows[0] || null;
        },

        async createAffiliate({ nome, email, percentual }) {
            // UNIQUE resolve colisões sem depender de um cache em memória.
            for (let attempt = 0; attempt < 3; attempt++) {
                const { rows } = await pool.query(`INSERT INTO public.afiliados
                    (codigo, id, nome, email, comissao_percentual) VALUES ($1,$2,$3,$4,$5)
                    ON CONFLICT (codigo) DO NOTHING RETURNING *`,
                [`af_${crypto.randomBytes(6).toString('hex')}`, id('af'), nome, email, percentual]);
                if (rows.length) return rows[0];
            }
            throw new StoreError();
        },

        async updateAffiliate(codigo, percentual, status) {
            return (await pool.query(`UPDATE public.afiliados SET comissao_percentual = $2,
                status = $3, atualizado_em = CURRENT_TIMESTAMP WHERE codigo = $1 RETURNING *`,
            [codigo, percentual, status])).rows[0] || null;
        },

        async listAffiliates() { return transaction(db => summaries(db), true); },
        async affiliateSummary(codigo) {
            return transaction(async db => (await summaries(db, codigo))[0] || null, true);
        },

        async recordClick(codigo, dedupeKey) {
            return transaction(async db => {
                const { rows } = await db.query('SELECT status FROM public.afiliados WHERE codigo = $1 FOR SHARE', [codigo]);
                if (rows[0]?.status !== 'ativo') return null;
                if (!/^[a-f0-9]{64}$/.test(String(dedupeKey))) {
                    throw new StoreError('Identificador de clique inválido.', 400);
                }
                const inserted = await db.query(`INSERT INTO public.cliques_afiliados
                    (id, afiliado_codigo, dedupe_key) VALUES ($1,$2,$3)
                    ON CONFLICT (dedupe_key) DO NOTHING RETURNING id`, [id('clk'), codigo, dedupeKey]);
                return inserted.rows.length === 1;
            });
        },

        async createPayment(data) {
            return transaction(async db => {
                // Mesma ordem dos demais fluxos: afiliado -> pagamento/usuário.
                if (data.afiliado_codigo) {
                    await db.query('SELECT codigo FROM public.afiliados WHERE codigo = $1 FOR UPDATE', [data.afiliado_codigo]);
                }
                await ensureUser(db, data.email);
                const quantity = inteiro(data.buscas_restantes);
                if (quantity <= 0) throw new StoreError('Quantidade de créditos inválida.', 400);
                const amount = moeda(data.valor_pago);
                await db.query(`INSERT INTO public.transacoes
                    (payment_id, status, status_detail, email, buscas_restantes, idempotency_key, afiliado_codigo, valor_pago)
                    VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (payment_id) DO NOTHING`,
                [String(data.payment_id), data.status, data.status_detail, data.email, quantity,
                    data.idempotency_key, data.afiliado_codigo, amount]);
                const saved = (await db.query('SELECT * FROM public.transacoes WHERE payment_id = $1', [String(data.payment_id)])).rows[0];
                if (saved.email !== data.email || inteiro(saved.buscas_restantes) !== quantity ||
                    Number(saved.valor_pago) !== Number(amount) || saved.afiliado_codigo !== data.afiliado_codigo) {
                    throw new StoreError('Pagamento já registrado com dados diferentes.', 409);
                }
                return saved;
            });
        },

        async syncPayment(paymentId, fetchPayment) {
            return transaction(async db => {
                const initial = (await db.query('SELECT afiliado_codigo FROM public.transacoes WHERE payment_id = $1', [paymentId])).rows[0];
                if (!initial) return null; // Preserva o comportamento para webhook desconhecido.
                let affiliate;
                if (initial.afiliado_codigo) {
                    affiliate = (await db.query('SELECT * FROM public.afiliados WHERE codigo = $1 FOR UPDATE', [initial.afiliado_codigo])).rows[0];
                }
                const payment = (await db.query('SELECT * FROM public.transacoes WHERE payment_id = $1 FOR UPDATE', [paymentId])).rows[0];
                // Consultar o provedor após adquirir o bloqueio evita aplicar snapshots fora de ordem.
                // O cliente HTTP deve ter timeout menor que idle_in_transaction_session_timeout.
                const remote = await fetchPayment(paymentId);
                if (String(remote.id) !== paymentId || !remote.status) throw new StoreError('Resposta de pagamento inválida.');
                await db.query('UPDATE public.transacoes SET status = $2, status_detail = $3 WHERE payment_id = $1',
                    [paymentId, remote.status, remote.status_detail || null]);

                if (remote.status === 'approved' && !payment.credited && payment.email) {
                    const quantity = inteiro(payment.buscas_restantes);
                    const credited = await db.query(`UPDATE public.usuarios SET creditos = creditos + $2::bigint
                        WHERE email = $1 AND creditos <= 9007199254740991 - $2::bigint RETURNING creditos`, [payment.email, quantity]);
                    if (!credited.rows.length) throw new StoreError('Saldo fora do limite seguro.');
                    await db.query(`UPDATE public.transacoes SET credited = true, credited_em = CURRENT_TIMESTAMP
                        WHERE payment_id = $1`, [paymentId]);

                    const sale = Number(remote.transaction_amount ?? payment.valor_pago);
                    if (affiliate?.status === 'ativo' && [10, 15].includes(affiliate.comissao_percentual) && Number.isFinite(sale) && sale > 0) {
                        const commissionId = `com_${paymentId}`;
                        await db.query(`INSERT INTO public.comissoes_afiliados
                            (id, payment_id, afiliado_codigo, afiliado_id, percentual, valor_venda, valor_comissao)
                            VALUES ($1,$2,$3,$4,$5,$6,$7)`, [commissionId, paymentId, affiliate.codigo,
                            affiliate.id, affiliate.comissao_percentual, moeda(sale), moeda(sale * affiliate.comissao_percentual / 100)]);
                        await db.query('UPDATE public.transacoes SET comissao_afiliado_id = $2 WHERE payment_id = $1', [paymentId, commissionId]);
                    }
                }

                const terminal = { cancelled: 'cancelada', refunded: 'estornada', charged_back: 'estornada' }[remote.status];
                if (terminal) {
                    const commission = (await db.query('SELECT * FROM public.comissoes_afiliados WHERE payment_id = $1 FOR UPDATE', [paymentId])).rows[0];
                    if (commission && !['cancelada', 'estornada'].includes(commission.status)) {
                        const reason = `Mercado Pago: ${remote.status}`;
                        await db.query(`UPDATE public.comissoes_afiliados SET status = $2,
                            encerrado_em = CURRENT_TIMESTAMP, motivo_encerramento = $3 WHERE id = $1`,
                        [commission.id, terminal, reason]);
                        if (commission.repasse_id) {
                            await db.query(`INSERT INTO public.ajustes_comissoes
                                (id, comissao_id, repasse_original_id, afiliado_codigo, valor, motivo, registrado_por, idempotency_key)
                                VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [id('ajs'), commission.id, commission.repasse_id,
                                commission.afiliado_codigo, commission.valor_comissao, reason, 'sistema:mercadopago', `estorno:${commission.id}`]);
                        }
                    }
                }
                const balance = (await db.query('SELECT creditos FROM public.usuarios WHERE email = $1', [payment.email])).rows[0];
                return { status: remote.status, creditos: inteiro(balance?.creditos || 0), pago: remote.status === 'approved' };
            });
        },

        async payAffiliate(codigo, adminEmail, requestKey = null) {
            return transaction(async db => {
                const affiliate = (await db.query('SELECT * FROM public.afiliados WHERE codigo = $1 FOR UPDATE', [codigo])).rows[0];
                if (!affiliate) throw new StoreError('Afiliado não encontrado.', 404);
                const explicitKey = requestKey ? `rep:req:${hash(JSON.stringify([codigo, adminEmail, requestKey]))}` : null;
                if (explicitKey) {
                    const existing = (await db.query('SELECT * FROM public.repasses_afiliados WHERE idempotency_key = $1', [explicitKey])).rows[0];
                    if (existing) return { repasse: repasseApi(existing), afiliado: (await summaries(db, codigo))[0] };
                }
                const { rows } = await db.query(`SELECT id FROM public.comissoes_afiliados
                    WHERE afiliado_codigo = $1 AND status IN ('disponivel','pendente') ORDER BY id FOR UPDATE`, [codigo]);
                if (!rows.length) throw new StoreError('Não há comissão disponível para marcar como paga.', 400);
                const ids = rows.map(c => c.id);
                const batchKey = explicitKey || `rep:lote:${hash(JSON.stringify(ids))}`;
                const amount = (await db.query('SELECT sum(valor_comissao) AS valor FROM public.comissoes_afiliados WHERE id = ANY($1::text[])', [ids])).rows[0].valor;
                moeda(amount); // Conferir numeric(12,2) antes de inserir; a soma é feita pelo PostgreSQL.
                const transfer = (await db.query(`INSERT INTO public.repasses_afiliados
                    (id, afiliado_codigo, afiliado_id, valor, quantidade_comissoes, registrado_por, idempotency_key)
                    VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
                [id('rep'), codigo, affiliate.id, amount, ids.length, adminEmail, batchKey])).rows[0];
                await db.query(`UPDATE public.comissoes_afiliados SET status = 'pago', pago_em = $2, repasse_id = $3
                    WHERE id = ANY($1::text[])`, [ids, transfer.pago_em, transfer.id]);
                return { repasse: repasseApi(transfer), afiliado: (await summaries(db, codigo))[0] };
            });
        },
    };

    // Erros do driver podem conter detalhes de conexão/SQL/dados: nunca atravessam a API.
    return Object.fromEntries(Object.entries(methods).map(([name, method]) => [name, async (...args) => {
        try { return await method(...args); }
        catch (error) {
            if (error instanceof StoreError) throw error;
            const safe = new StoreError();
            safe.code = /^[A-Z0-9_]{1,40}$/.test(String(error.code)) ? error.code : 'DATABASE_ERROR';
            throw safe;
        }
    }]));
}

module.exports = { createStore, StoreError };
