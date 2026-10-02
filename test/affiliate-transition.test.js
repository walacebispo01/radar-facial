const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PGlite } = require('@electric-sql/pglite');
const { createStore } = require('../lib/postgres-store');
const { createSessionStore } = require('../lib/session-store');
const { createProgramSecurity, totp } = require('../lib/program-security');

test('afiliados permanecem administráveis com programa desativado, exigindo sessão, CSRF e TOTP', async t => {
    const db = new PGlite(); t.after(() => db.close());
    for (const file of ['schema-proposto.sql', 'migrations/001-sessoes.sql', 'migrations/002-criadores.sql', 'migrations/003-comissoes-rede.sql']) {
        await db.exec(fs.readFileSync(path.join(__dirname, '../sql', file), 'utf8'));
    }
    let tail = Promise.resolve();
    const pool = { async connect() { const prior = tail; let release; tail = new Promise(r => { release = r; }); await prior; return { query: (q,p) => db.query(q,p), release }; },
        async query(q,p) { const c = await pool.connect(); try { return await c.query(q,p); } finally { c.release(); } } };
    const savedAdmins = process.env.ADMIN_EMAILS; process.env.ADMIN_EMAILS = 'admin@example.test';
    t.after(() => { if (savedAdmins === undefined) delete process.env.ADMIN_EMAILS; else process.env.ADMIN_EMAILS = savedAdmins; });
    const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
    const security = createProgramSecurity(pool, { secrets: { 'admin@example.test': secret } });
    let bookkeepingCalls = 0;
    const store = createStore(pool);
    // No real payment or payout is created by this HTTP regression test.
    store.payAffiliate = async () => { bookkeepingCalls++; return { id: 'fixture-repasse' }; };
    const app = require('../server').createApp({ store, sessions: createSessionStore(pool), creatorStore: null,
        programSecurity: security, payment: {}, appOrigin: 'https://radarfacial.com.br',
        verifyGoogle: async credential => ({ email: credential + '@example.test', sub: credential }) });
    const server = app.listen(0, '127.0.0.1'); await new Promise(r => server.once('listening', r)); t.after(() => new Promise(r => server.close(r)));
    const base = 'http://127.0.0.1:' + server.address().port;
    async function request(route, session, body = {}, override = {}, method = 'POST') {
        const response = await fetch(base + route, { method, headers: { origin: 'https://radarfacial.com.br', 'content-type': 'application/json', 'x-radar-request': '1',
            ...(session ? { cookie: session.cookie, 'x-csrf-token': session.csrfToken } : {}), ...override }, ...(method === 'GET' ? {} : { body: JSON.stringify(body) }) });
        return { status: response.status, data: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] };
    }
    async function login(credential) { const result = await request('/api/login-google', null, { credential }); assert.equal(result.status, 200); return { ...result.data, cookie: result.cookie }; }
    const admin = await login('admin'), other = await login('other');
    assert.equal((await request('/api/admin/afiliados/criar', null)).status, 401);
    assert.equal((await request('/api/admin/afiliados/criar', other)).status, 403);
    for (const endpoint of ['criar', 'atualizar', 'pagar', 'CRIAR/']) {
        const locked = await request('/api/admin/afiliados/' + endpoint, admin);
        assert.equal(locked.status, 403); assert.equal(locked.data.code, 'STEP_UP_REQUIRED');
    }
    const verified = await request('/api/programa/admin/verificar', admin, { code: totp(secret, Math.floor(Date.now() / 30000)) });
    assert.equal(verified.status, 200);
    const input = { nome: 'Afiliado de teste', email: 'affiliate@example.test', percentual: 10 };
    assert.equal((await request('/api/admin/afiliados/criar', admin, input, { 'x-csrf-token': '' })).status, 403);
    const created = await request('/api/admin/afiliados/criar', admin, input); assert.equal(created.status, 200);
    const code = created.data.afiliado.codigo;
    const updated = await request('/api/admin/afiliados/atualizar', admin, { codigo: code, percentual: 15, status: 'ativo' });
    assert.equal(updated.status, 200);
    assert.equal((await store.findAffiliate(code)).comissao_percentual, 15);
    assert.equal((await request('/api/admin/afiliados/listar', admin)).status, 200);
    assert.equal((await request('/api/admin/afiliados/pagar', admin, { codigo: code })).status, 200);
    assert.equal(bookkeepingCalls, 1);
    assert.equal((await request('/api/programa/admin/criadores', admin, {}, {}, 'GET')).status, 503);
    const proofs = await request('/api/provas-sociais', null, {}, {}, 'GET');
    assert.equal(proofs.status, 200); assert.deepEqual(proofs.data.items, []);
    assert.equal((await request('/api/convite?token=invalid', null, {}, {}, 'GET')).status, 503);
});
