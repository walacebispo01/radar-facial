const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const { PGlite } = require('@electric-sql/pglite');
const { createStore } = require('../lib/postgres-store');
const { createSessionStore } = require('../lib/session-store');
const { createAuth } = require('../lib/auth');
const { mountTestCredit, isTestAccount } = require('../lib/test-credit');

test('crédito próprio de teste: teto, concorrência, devolução e autorização HTTP', async t => {
    const db = new PGlite(); t.after(() => db.close());
    for (const file of ['schema-proposto.sql', 'migrations/001-sessoes.sql']) await db.exec(fs.readFileSync(path.join(__dirname, '../sql', file), 'utf8'));
    let tail = Promise.resolve();
    const pool = { async connect() { const prior = tail; let release; tail = new Promise(r => { release = r; }); await prior; return { query: (s,p) => db.query(s,p), release }; },
        async query(s,p) { const c = await pool.connect(); try { return await c.query(s,p); } finally { c.release(); } } };
    const store = createStore(pool), email = 'tester@example.test';
    await store.login(email);
    const results = await Promise.all(Array.from({ length: 8 }, () => store.grantOwnTestCredit(email)));
    assert.equal(results.filter(x => x.granted).length, 1);
    assert.equal(await store.login(email), 1);
    const reservation = await store.beginFaceSearch(email, 'test-search');
    await assert.rejects(store.grantOwnTestCredit(email), error => error.status === 409);
    assert.equal(await store.refundFaceSearch(reservation.id, email), 1);
    assert.equal((await store.grantOwnTestCredit(email)).granted, false);
    const second = await store.beginFaceSearch(email, 'stale-search');
    await db.query("UPDATE public.buscas_faciais SET criado_em=CURRENT_TIMESTAMP-INTERVAL '16 minutes' WHERE id=$1", [second.id]);
    assert.deepEqual(await store.grantOwnTestCredit(email), { granted: false, creditos: 1 });
    assert.equal(await store.refundFaceSearch(second.id, email), 1);
    await db.query('UPDATE public.usuarios SET creditos=12 WHERE email=$1', [email]);
    assert.deepEqual(await store.grantOwnTestCredit(email), { granted: false, creditos: 12 });
    assert.equal(Number((await db.query('SELECT count(*) FROM public.transacoes')).rows[0].count), 0);
    assert.equal(Number((await db.query('SELECT count(*) FROM public.comissoes_afiliados')).rows[0].count), 0);
    assert.equal(isTestAccount(null), false);
    assert.equal(isTestAccount('attacker@example.test'), false);

    const origin = 'https://radarfacial.com.br';
    const auth = createAuth({ sessions: createSessionStore(pool), origin, isAdmin: () => false,
        verifyGoogle: async credential => ({ email: credential === 'tester' ? email : 'other@example.test', sub: credential }) });
    const app = express(); app.use(express.json()); app.post('/api/login-google', auth.browserMutation, auth.login);
    mountTestCredit(app, { auth, store, accountAllowed: value => value === email });
    const server = app.listen(0, '127.0.0.1'); await new Promise(r => server.once('listening', r)); t.after(() => new Promise(r => server.close(r)));
    const base = 'http://127.0.0.1:' + server.address().port;
    async function request(route, method = 'GET', session = null, body = {}, override = {}) {
        const response = await fetch(base + route, { method, headers: { origin, 'content-type': 'application/json', 'x-radar-request': '1',
            ...(session ? { cookie: session.cookie, 'x-csrf-token': session.csrfToken } : {}), ...override }, ...(method === 'GET' ? {} : { body: JSON.stringify(body) }) });
        return { status: response.status, data: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] };
    }
    async function login(credential) { const result = await request('/api/login-google', 'POST', null, { credential }); assert.equal(result.status, 200); return { ...result.data, cookie: result.cookie }; }
    assert.equal((await request('/api/teste/credito')).status, 401);
    const other = await login('other'), authorized = await login('tester');
    assert.equal((await request('/api/teste/credito', 'POST', other, { email, quantidade: 99999 })).status, 403);
    assert.equal((await request('/api/teste/credito', 'POST', authorized, {}, { 'x-csrf-token': '' })).status, 403);
    assert.equal((await request('/api/teste/credito', 'POST', authorized, {}, { origin: 'https://evil.test' })).status, 403);
    await db.query('UPDATE public.usuarios SET creditos=0 WHERE email=$1', [email]);
    const granted = await request('/api/teste/credito', 'POST', authorized, { email: 'other@example.test', quantidade: 99999 });
    assert.equal(granted.status, 200); assert.equal(granted.data.creditos, 1);
    assert.equal(await store.login('other@example.test'), 0);
    assert.equal((await request('/api/teste/credito', 'POST', authorized)).status, 429);
});
