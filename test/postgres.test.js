const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { PGlite } = require('@electric-sql/pglite');
const { createStore } = require('../lib/postgres-store');

// PGlite possui uma sessão. Este adaptador serializa clientes inteiros,
// não apenas queries, para não misturar transações. Não simula MVCC multissessão.
function memoryPool(db) {
    let tail = Promise.resolve();
    const pool = {
        async connect() {
            const previous = tail;
            let unlock;
            tail = new Promise(resolve => { unlock = resolve; });
            await previous;
            return {
                async query(sql, params = []) {
                    const result = await db.query(sql, params);
                    return { ...result, rowCount: result.affectedRows ?? result.rows.length };
                },
                release: unlock,
            };
        },
        async query(sql, params) {
            const client = await pool.connect();
            try { return await client.query(sql, params); } finally { client.release(); }
        },
    };
    return pool;
}

test('Persistência PostgreSQL com o schema exato, em memória', async t => {
    const db = new PGlite();
    await db.exec(fs.readFileSync(path.join(__dirname, '../sql/schema-proposto.sql'), 'utf8'));
    const pool = memoryPool(db);
    const store = createStore(pool);
    t.after(() => db.close());
    let sequence = 0;

    async function fixture({ affiliate = true, amount = 100, quantity = 10 } = {}) {
        const paymentId = String(++sequence);
        const email = `user${paymentId}@example.test`;
        const af = affiliate ? await store.createAffiliate({ nome: 'Teste', email: '', percentual: 10 }) : null;
        const data = { payment_id: paymentId, email, buscas_restantes: quantity,
            status: 'pending', status_detail: null, idempotency_key: `pix:${paymentId}`,
            afiliado_codigo: af?.codigo || null, valor_pago: amount };
        await store.createPayment(data);
        return { data, af, remote: status => async () => ({ id: paymentId, status, transaction_amount: amount }) };
    }

    await t.test('login não sobrescreve saldo; pagamento sem login cria usuário', async () => {
        const f = await fixture({ affiliate: false });
        assert.equal(await store.login(f.data.email), 0);
        assert.equal((await store.syncPayment(f.data.payment_id, f.remote('approved'))).creditos, 10);
        assert.equal(await store.login(f.data.email), 10);
        assert.equal((await db.query('SELECT count(*) FROM public.comissoes_afiliados')).rows[0].count, 0);
    });

    await t.test('aprovações repetidas liberam créditos e comissão uma única vez', async () => {
        const f = await fixture();
        const results = await Promise.all(Array.from({ length: 8 }, () => store.syncPayment(f.data.payment_id, f.remote('approved'))));
        assert.ok(results.every(r => r.creditos === 10));
        const rows = (await db.query('SELECT * FROM public.comissoes_afiliados WHERE payment_id=$1', [f.data.payment_id])).rows;
        assert.equal(rows.length, 1);
        assert.equal(Number(rows[0].valor_comissao), 10);
    });

    await t.test('percentual é capturado na aprovação e alteração posterior preserva histórico', async () => {
        const f = await fixture();
        await store.updateAffiliate(f.af.codigo, 15, 'ativo');
        await store.syncPayment(f.data.payment_id, f.remote('approved'));
        await store.updateAffiliate(f.af.codigo, 10, 'inativo');
        const c = (await db.query('SELECT * FROM public.comissoes_afiliados WHERE payment_id=$1', [f.data.payment_id])).rows[0];
        assert.equal(c.percentual, 15);
        assert.equal(Number(c.valor_comissao), 15);
        assert.equal(await store.recordClick(f.af.codigo), false);
        await assert.rejects(db.query('UPDATE public.comissoes_afiliados SET valor_comissao=1 WHERE id=$1', [c.id]));
    });

    await t.test('afiliado inativo na aprovação não recebe comissão', async () => {
        const f = await fixture();
        await store.updateAffiliate(f.af.codigo, 10, 'inativo');
        await store.syncPayment(f.data.payment_id, f.remote('approved'));
        assert.equal((await store.affiliateSummary(f.af.codigo)).metricas.vendas, 0);
    });

    await t.test('descontos repetidos não ficam negativos e não perdem atualização', async () => {
        const f = await fixture({ affiliate: false, quantity: 3 });
        await store.syncPayment(f.data.payment_id, f.remote('approved'));
        const results = await Promise.all(Array.from({ length: 8 }, () => store.debit(f.data.email)));
        assert.deepEqual(results.filter(x => x !== null).sort(), [0, 1, 2]);
        assert.equal(results.filter(x => x === null).length, 5);
        assert.equal(await store.login(f.data.email), 0);
    });

    await t.test('falha ao criar comissão reverte saldo, status e marca de crédito', async () => {
        const f = await fixture();
        await assert.rejects(store.syncPayment(f.data.payment_id, async () => ({ id: f.data.payment_id, status: 'approved', transaction_amount: 1e12 })));
        assert.equal(await store.login(f.data.email), 0);
        const row = (await db.query('SELECT * FROM public.transacoes WHERE payment_id=$1', [f.data.payment_id])).rows[0];
        assert.equal(row.credited, false);
        assert.equal(row.status, 'pending');
    });

    await t.test('repetição da criação não sobrescreve pagamento já creditado', async () => {
        const f = await fixture();
        await store.syncPayment(f.data.payment_id, f.remote('approved'));
        await store.createPayment(f.data);
        await assert.rejects(store.createPayment({ ...f.data, buscas_restantes: 40 }), { status: 409 });
        assert.equal(await store.login(f.data.email), 10);
        assert.equal((await db.query('SELECT credited FROM public.transacoes WHERE payment_id=$1', [f.data.payment_id])).rows[0].credited, true);
    });

    await t.test('repasse agrupa disponíveis/pendentes, é idempotente e não reutiliza comissões', async () => {
        const f = await fixture();
        await store.syncPayment(f.data.payment_id, f.remote('approved'));
        await db.query("UPDATE public.comissoes_afiliados SET status='pendente' WHERE payment_id=$1", [f.data.payment_id]);
        const secondId = String(++sequence);
        await store.createPayment({ ...f.data, payment_id: secondId, idempotency_key: `pix:${secondId}`, valor_pago: 50 });
        await store.syncPayment(secondId, async () => ({ id: secondId, status: 'approved', transaction_amount: 50 }));
        const requests = await Promise.all(Array.from({ length: 5 }, () => store.payAffiliate(f.af.codigo, 'admin@example.test', 'retry-1')));
        assert.ok(requests.every(r => r.repasse.id === requests[0].repasse.id));
        assert.equal(requests[0].repasse.valor, 15);
        assert.equal(requests[0].repasse.quantidade_comissoes, 2);
        assert.equal(requests[0].afiliado.metricas.comissao_paga, 15);
        assert.ok(!('idempotency_key' in requests[0].repasse));
        await assert.rejects(store.payAffiliate(f.af.codigo, 'admin@example.test'), { status: 400 });
        await assert.rejects(db.query('UPDATE public.repasses_afiliados SET valor=0 WHERE id=$1', [requests[0].repasse.id]));
    });

    await t.test('repasse sem chave no frontend paga um lote somente uma vez', async () => {
        const f = await fixture();
        await store.syncPayment(f.data.payment_id, f.remote('approved'));
        const results = await Promise.allSettled(Array.from({ length: 4 }, () => store.payAffiliate(f.af.codigo, 'admin@example.test')));
        assert.equal(results.filter(x => x.status === 'fulfilled').length, 1);
        assert.equal((await store.affiliateSummary(f.af.codigo)).repasses.length, 1);
    });

    await t.test('cancelamento antes do repasse exclui métricas sem gerar ajuste', async () => {
        const f = await fixture();
        await store.recordClick(f.af.codigo);
        await store.syncPayment(f.data.payment_id, f.remote('approved'));
        await store.syncPayment(f.data.payment_id, f.remote('cancelled'));
        const summary = await store.affiliateSummary(f.af.codigo);
        assert.deepEqual(summary.metricas, { cliques: 1, vendas: 0, conversao: 0, faturamento: 0,
            comissao_total: 0, comissao_disponivel: 0, comissao_paga: 0 });
        assert.equal((await db.query('SELECT * FROM public.ajustes_comissoes WHERE comissao_id=$1', [`com_${f.data.payment_id}`])).rows.length, 0);
        assert.equal(await store.login(f.data.email), 10);
    });

    await t.test('estorno pago mantém repasse e cria somente um ajuste integral', async () => {
        const f = await fixture();
        await store.syncPayment(f.data.payment_id, f.remote('approved'));
        const paid = await store.payAffiliate(f.af.codigo, 'admin@example.test');
        await store.syncPayment(f.data.payment_id, f.remote('refunded'));
        await store.syncPayment(f.data.payment_id, f.remote('refunded'));
        const summary = await store.affiliateSummary(f.af.codigo);
        assert.equal(summary.metricas.vendas, 0);
        assert.equal(summary.metricas.comissao_paga, 0);
        assert.deepEqual(summary.repasses[0], paid.repasse);
        const adjustments = (await db.query('SELECT * FROM public.ajustes_comissoes WHERE comissao_id=$1', [`com_${f.data.payment_id}`])).rows;
        assert.equal(adjustments.length, 1);
        assert.equal(Number(adjustments[0].valor), 10);
        assert.equal(adjustments[0].repasse_original_id, paid.repasse.id);
        await store.syncPayment(f.data.payment_id, f.remote('approved'));
        assert.equal(await store.login(f.data.email), 10);
        assert.equal((await store.affiliateSummary(f.af.codigo)).metricas.vendas, 0);
    });

    await t.test('chargeback gera ajuste; erro em provedor faz rollback; desconhecido não chama provedor', async () => {
        const f = await fixture();
        await store.syncPayment(f.data.payment_id, f.remote('approved'));
        await store.payAffiliate(f.af.codigo, 'admin@example.test');
        await store.syncPayment(f.data.payment_id, f.remote('charged_back'));
        assert.equal((await db.query('SELECT status FROM public.comissoes_afiliados WHERE payment_id=$1', [f.data.payment_id])).rows[0].status, 'estornada');
        await assert.rejects(store.syncPayment(f.data.payment_id, async () => { throw new Error('segredo'); }), e => !e.message.includes('segredo'));
        assert.equal(await store.syncPayment('unknown', () => { throw new Error('não deveria chamar'); }), null);
    });

    await t.test('constraints adiadas rejeitam repasse inconsistente sem deixar registros', async () => {
        const f = await fixture();
        await store.syncPayment(f.data.payment_id, f.remote('approved'));
        // Injetar falha apenas no ambiente em memória para comprovar rollback no COMMIT.
        const failingPool = {
            ...pool,
            async connect() {
                const client = await pool.connect();
                const query = client.query.bind(client);
                client.query = (sql, params) => sql.startsWith('UPDATE public.comissoes_afiliados SET status = \'pago\'')
                    ? Promise.resolve({ rows: [] }) : query(sql, params);
                return client;
            },
        };
        await assert.rejects(createStore(failingPool).payAffiliate(f.af.codigo, 'admin@example.test'));
        const summary = await store.affiliateSummary(f.af.codigo);
        assert.equal(summary.repasses.length, 0);
        assert.equal(summary.metricas.comissao_disponivel, 10);
    });

    await t.test('falha no ajuste reverte encerramento e status do pagamento', async () => {
        const f = await fixture();
        await store.syncPayment(f.data.payment_id, f.remote('approved'));
        await store.payAffiliate(f.af.codigo, 'admin@example.test');
        const failingPool = {
            ...pool,
            async connect() {
                const client = await pool.connect();
                const query = client.query.bind(client);
                client.query = (sql, params) => sql.startsWith('INSERT INTO public.ajustes_comissoes')
                    ? Promise.resolve({ rows: [] }) : query(sql, params);
                return client;
            },
        };
        await assert.rejects(createStore(failingPool).syncPayment(f.data.payment_id, f.remote('refunded')));
        assert.equal((await store.affiliateSummary(f.af.codigo)).metricas.comissao_paga, 10);
        assert.equal((await db.query('SELECT status FROM public.transacoes WHERE payment_id=$1', [f.data.payment_id])).rows[0].status, 'approved');
        await store.syncPayment(f.data.payment_id, f.remote('refunded'));
        assert.equal((await store.affiliateSummary(f.af.codigo)).metricas.comissao_paga, 0);
    });

    await t.test('contratos HTTP do site e webhook, com serviços externos simulados', async () => {
        process.env.ADMIN_EMAILS = 'admin@example.test';
        process.env.MERCADOPAGO_TOKEN = 'test-only';
        const { createApp } = require('../server');
        let remoteStatus = 'pending';
        let failProvider = false;
        const payment = {
            async create() { return { id: 'http-1', status: 'pending', point_of_interaction: { transaction_data: { qr_code: 'teste', qr_code_base64: null, ticket_url: null } } }; },
            async get({ id }) { if (failProvider) throw new Error('segredo'); return { id, status: remoteStatus, transaction_amount: 50 }; },
        };
        const app = createApp({ store, payment, validateGoogle: async credential => credential === 'admin' ? 'admin@example.test' : credential === 'user' ? 'http@example.test' : null });
        const server = app.listen(0, '127.0.0.1');
        await new Promise(resolve => server.once('listening', resolve));
        const base = `http://127.0.0.1:${server.address().port}`;
        const post = async (route, body) => {
            const response = await fetch(base + route, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
            const text = await response.text();
            return { status: response.status, body: response.headers.get('content-type')?.includes('application/json') ? JSON.parse(text) : text };
        };
        try {
            assert.equal((await fetch(base + '/')).status, 200);
            assert.equal((await fetch(base + '/.env')).status, 404);
            assert.equal((await fetch(base + '/lib/postgres-store.js')).status, 404);
            assert.equal((await post('/api/admin/afiliados/listar', {})).status, 403);
            assert.deepEqual((await post('/api/login-google', { credential: 'user' })).body,
                { success: true, email: 'http@example.test', creditos: 0, isAdmin: false });
            assert.equal((await post('/api/login-google', {})).status, 400);
            assert.equal((await post('/api/login-google', { credential: 'invalid' })).status, 401);
            const af = (await post('/api/admin/afiliados/criar', { credential: 'admin', nome: 'HTTP', percentual: 15 })).body.afiliado;
            assert.equal((await fetch(base + '/api/afiliados/validar/' + af.codigo)).status, 200);
            assert.deepEqual((await post('/api/afiliados/clique', { codigo: af.codigo })).body, { success: true });
            const pix = await post('/api/criar-pix', { email: 'http@example.test', valor: 50, creditos: 2, afiliado_codigo: af.codigo });
            assert.equal(pix.status, 200);
            assert.deepEqual(Object.keys(pix.body).sort(), ['success', 'transaction_id', 'status', 'status_detail', 'qr_code', 'qr_code_base64', 'ticket_url', 'transaction_data'].sort());
            assert.equal((await post('/api/verificar-pix', { transaction_id: 'unknown' })).status, 404);
            remoteStatus = 'approved';
            assert.deepEqual((await post('/api/verificar-pix', { transaction_id: 'http-1' })).body,
                { success: true, pago: true, status: 'approved', creditos: 2, transaction_id: 'http-1' });
            assert.equal((await post('/api/mercadopago-webhook', { data: { id: 'http-1' } })).status, 200);
            assert.equal(await store.login('http@example.test'), 2);
            assert.deepEqual((await post('/api/descontar-credito', { email: 'http@example.test' })).body, { success: true, creditos: 1 });
            const paid = await post('/api/admin/afiliados/pagar', { credential: 'admin', codigo: af.codigo });
            assert.equal(paid.status, 200);
            assert.deepEqual(Object.keys(paid.body).sort(), ['success', 'repasse', 'afiliado'].sort());
            assert.equal(paid.body.repasse.valor, 7.5);
            assert.equal(typeof paid.body.repasse.pago_em, 'string');
            assert.equal((await post('/api/admin/afiliados/pagar', { credential: 'admin', codigo: af.codigo })).status, 400);
            assert.equal((await post('/api/admin/afiliados/resumo', { credential: 'admin', codigo: af.codigo })).body.afiliado.metricas.vendas, 1);
            const list = await post('/api/admin/afiliados/listar', { credential: 'admin' });
            assert.equal(list.status, 200);
            assert.ok(Array.isArray(list.body.afiliados));
            const update = await post('/api/admin/afiliados/atualizar', { credential: 'admin', codigo: af.codigo, percentual: 10, status: 'inativo' });
            assert.equal(update.body.afiliado.status, 'inativo');
            assert.equal((await fetch(base + '/api/afiliados/validar/' + af.codigo)).status, 404);
            await post('/api/descontar-credito', { email: 'http@example.test' });
            assert.deepEqual(await post('/api/descontar-credito', { email: 'http@example.test' }),
                { status: 403, body: { success: false, error: 'Créditos esgotados.', creditos: 0 } });
            assert.equal((await fetch(base + '/api/status')).status, 200);
            assert.equal((await post('/api/escanear-rosto', {})).status, 400);
            failProvider = true;
            const failed = await post('/api/mercadopago-webhook', { data: { id: 'http-1' } });
            assert.equal(failed.status, 500);
            assert.ok(!failed.body.includes('segredo'));
        } finally {
            await new Promise(resolve => server.close(resolve));
        }
    });
});
