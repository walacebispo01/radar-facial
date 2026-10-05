'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PGlite } = require('@electric-sql/pglite');
const { createStore } = require('../lib/postgres-store');
const { createInfinitePayOrders } = require('../lib/infinitepay-orders');
const { createSessionStore } = require('../lib/session-store');

test('InfinitePay: pedidos, confirmação, duplicação, isolamento, falhas e retorno ao checkout anterior', async t => {
    const db = new PGlite();
    t.after(() => db.close());
    for (const file of ['schema-proposto.sql', 'migrations/001-sessoes.sql', 'migrations/002-criadores.sql', 'migrations/003-comissoes-rede.sql']) {
        await db.exec(fs.readFileSync(path.join(__dirname, '../sql', file), 'utf8'));
    }
    let tail = Promise.resolve();
    const pool = {
        async connect() {
            const previous = tail; let release;
            tail = new Promise(resolve => { release = resolve; });
            await previous;
            return { async query(sql, args) {
                if (args) return db.query(sql, args);
                return (await db.exec(sql)).at(-1) || { rows: [] };
            }, release };
        },
        async query(sql, args) { const client = await pool.connect(); try { return await client.query(sql, args); } finally { client.release(); } },
    };
    const { migrateCheckout } = require('../scripts/migrate-checkout');
    assert.deepEqual((await migrateCheckout(pool)).applied, ['006-infinitepay.sql']);
    assert.deepEqual((await migrateCheckout(pool)).skipped, ['006-infinitepay.sql']);
    const { migrateAnalytics } = require('../scripts/migrate-analytics');
    assert.deepEqual((await migrateAnalytics(pool)).applied, ['007-google-analytics.sql']);
    assert.deepEqual((await migrateAnalytics(pool)).skipped, ['007-google-analytics.sql']);
    const analyticsCalls = [];
    let analyticsFail = false;
    const analytics = require('../lib/ga4').createAnalytics({ pool, measurementId: 'G-TEST123456', apiSecret: 'test-secret',
        fetchImpl: async (url, init) => { analyticsCalls.push({ url, payload: JSON.parse(init.body) }); return { ok: !analyticsFail }; } });
    const commissions = require('../lib/commission-program').createCommissionProgram(pool);
    const store = createStore(pool, { commissionProgram: commissions });
    await store.login('buyer@example.test');
    await store.login('other@example.test');
    let paid = true, fail = false, links = 0;
    const handles = [];
    const clientFactory = ({ handle }) => ({
        async createCheckout() { links++; if (fail) throw new Error('upstream'); return { url: 'https://checkout.infinitepay.com.br/test' }; },
        async checkPayment() { handles.push(handle); if (fail) throw new Error('upstream'); return { paid }; },
    });
    const orders = createInfinitePayOrders({ pool, store, handle: 'original', origin: 'https://radarfacial.com.br', clientFactory });
    const create = (key, packageId = 'avulso') => orders.create({ email: 'buyer@example.test', packageId, requestKey: key });
    const first = await create('a'.repeat(16));
    await analytics.record(first.orderId, 'other@example.test', { consent: true, clientId: '123.456', sessionId: 123 });
    assert.equal((await db.query('SELECT count(*) AS n FROM ga4_pedidos')).rows[0].n, 0);
    await analytics.record(first.orderId, 'buyer@example.test', { consent: true, clientId: '123.456', sessionId: 123, value: 9999, email: 'never-sent' });
    assert.equal((await analytics.processPending()).sent, 0);
    const repeated = await Promise.all(Array.from({ length: 5 }, () => create('a'.repeat(16))));
    assert.ok(repeated.every(order => order.orderId === first.orderId));
    assert.equal(links, 1);
    assert.equal(await store.login('buyer@example.test'), 0);
    await assert.rejects(create('a'.repeat(16), 'pro'), /outros dados/);
    await assert.rejects(create('b'.repeat(16), 'invalid'), /inválido/);
    const receipt = { orderId: first.orderId, transactionId: 'receipt-one', invoiceSlug: 'invoice-one' };
    await assert.rejects(orders.confirm({ ...receipt, email: 'other@example.test' }), /não encontrado/);
    paid = false;
    assert.equal((await orders.confirm(receipt)).pago, false);
    assert.equal(await store.login('buyer@example.test'), 0);
    assert.equal((await db.query('SELECT transaction_nsu FROM infinitepay_pedidos WHERE id=$1', [first.orderId])).rows[0].transaction_nsu, null);
    paid = true;
    const confirmed = await Promise.all(Array.from({ length: 5 }, () => orders.confirm(receipt)));
    assert.ok(confirmed.every(result => result.creditos === 1));
    assert.equal(await store.login('buyer@example.test'), 1);
    analyticsFail = true;
    assert.equal((await analytics.processPending()).failed, 1);
    assert.equal((await db.query('SELECT enviado_em FROM ga4_pedidos')).rows[0].enviado_em, null);
    await db.exec("UPDATE ga4_pedidos SET tentar_em=CURRENT_TIMESTAMP");
    analyticsFail = false;
    assert.equal((await analytics.processPending()).sent, 1);
    assert.equal((await analytics.processPending()).sent, 0);
    const event = analyticsCalls.at(-1).payload;
    assert.equal(event.events[0].name, 'purchase');
    assert.equal(event.events[0].params.value, 12.99);
    assert.equal(event.events[0].params.transaction_id, first.orderId);
    assert.equal(event.client_id, '123.456');
    assert.ok(!JSON.stringify(event).includes('@'));
    assert.ok(!JSON.stringify(event).includes('never-sent'));
    assert.equal((await create('a'.repeat(16))).alreadyPaid, true);
    const second = await create('c'.repeat(16));
    await analytics.record(second.orderId, 'buyer@example.test', { consent: true, clientId: '222.333', sessionId: 456 });
    await analytics.withdraw('buyer@example.test');
    assert.equal((await db.query('SELECT count(*) AS n FROM ga4_pedidos WHERE order_id=$1', [second.orderId])).rows[0].n, 0);
    await assert.rejects(orders.confirm({ ...receipt, orderId: second.orderId }));
    assert.equal(await store.login('buyer@example.test'), 1);
    assert.equal((await db.query('SELECT credited FROM transacoes WHERE payment_id=$1', [second.orderId])).rows[0].credited, false);
    await assert.rejects(orders.confirm({ ...receipt, transactionId: 'different' }), /outro comprovante/);
    fail = true;
    await assert.rejects(orders.confirm({ orderId: second.orderId, transactionId: 'two', invoiceSlug: 'two' }));
    assert.equal(await store.login('buyer@example.test'), 1);
    await assert.rejects(create('d'.repeat(16)));
    fail = false;
    await create('d'.repeat(16)); // Recover a link creation failure without creating another order.
    const rotated = createInfinitePayOrders({ pool, store, handle: 'new-account', origin: 'https://radarfacial.com.br', clientFactory });
    await rotated.confirm(receipt);
    assert.equal(handles.at(-1), 'original');
    paid = false;
    await orders.confirm(receipt);
    assert.equal((await db.query('SELECT status FROM transacoes WHERE payment_id=$1', [first.orderId])).rows[0].status, 'approved');
    paid = true;

    const creators = require('../lib/creator-store').createCreatorStore(pool);
    const creator = await creators.createCreator({ nome: 'Criador', email: 'creator@example.test', demo_enabled: true }, 'admin@example.test');
    const affiliate = (await db.query('SELECT codigo FROM public.afiliados WHERE email=$1', [creator.email])).rows[0];
    const networkOrder = await orders.create({ email: 'buyer@example.test', packageId: 'popular',
        requestKey: 'network-request-123', affiliateCode: affiliate.codigo });
    await orders.confirm({ orderId: networkOrder.orderId, transactionId: 'network-receipt', invoiceSlug: 'network-invoice' });
    const snapshot = (await db.query('SELECT criador_programa,criador_snapshot FROM transacoes WHERE payment_id=$1', [networkOrder.orderId])).rows[0];
    assert.equal(snapshot.criador_programa, true); assert.ok(snapshot.criador_snapshot);
    assert.equal((await commissions.processPending()).failed, 0);
    assert.equal((await db.query('SELECT count(*) AS n FROM comissoes_rede_lancamentos WHERE payment_id=$1', [networkOrder.orderId])).rows[0].n > 0, true);
    assert.equal(await store.login('buyer@example.test'), 11);

    const { createApp } = require('../server');
    const app = createApp({ store, sessions: createSessionStore(pool), payment: {},
        verifyGoogle: async credential => ({ email: `${credential}@example.test`, sub: credential }),
        appOrigin: 'https://radarfacial.com.br', checkoutOrders: orders, checkoutProvider: 'mercadopago', analytics });
    const server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    t.after(() => new Promise(resolve => server.close(resolve)));
    const base = `http://127.0.0.1:${server.address().port}`;
    const headers = { origin: 'https://radarfacial.com.br', 'content-type': 'application/json', 'x-radar-request': '1' };
    assert.equal((await fetch(base + '/api/checkout/config')).status, 401);
    const publicAnalytics = await (await fetch(base + '/api/analytics/config')).json();
    assert.deepEqual(publicAnalytics, { measurementId: 'G-TEST123456' });
    assert.equal((await fetch(base + '/api/checkout/analytics-consent', { method: 'POST', headers, body: '{}' })).status, 401);
    const login = await fetch(base + '/api/login-google', { method: 'POST', headers, body: JSON.stringify({ credential: 'buyer' }) });
    const session = await login.json();
    const authenticated = { ...headers, cookie: login.headers.get('set-cookie').split(';')[0], 'x-csrf-token': session.csrfToken };
    assert.equal((await fetch(base + '/api/checkout/create', { method: 'POST', headers: authenticated, body: '{}' })).status, 503);
    assert.equal((await fetch(base + '/api/checkout/confirm', { method: 'POST', headers: { ...authenticated, 'x-csrf-token': '' }, body: JSON.stringify({ order_nsu: first.orderId, transaction_nsu: 'receipt-one', slug: 'invoice-one' }) })).status, 403);
    const confirmation = await fetch(base + '/api/checkout/confirm', { method: 'POST', headers: authenticated,
        body: JSON.stringify({ order_nsu: first.orderId, transaction_nsu: 'receipt-one', slug: 'invoice-one' }) });
    assert.equal(confirmation.status, 200); assert.equal((await confirmation.json()).creditos, 11);
    const forged = await fetch(base + '/api/infinitepay-webhook', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ order_nsu: second.orderId, transaction_nsu: 'receipt-one', invoice_slug: 'invoice-one', paid: true }) });
    assert.equal(forged.status, 400);
    assert.equal(await store.login('buyer@example.test'), 11);
    assert.equal((await fetch(base + '/pagamento')).status, 200);
});
