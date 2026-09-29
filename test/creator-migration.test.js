const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PGlite } = require('@electric-sql/pglite');
const { loadMigrations, migrateCreators } = require('../scripts/migrate-creators');

async function fixture(t, baseline = true) {
    const db = new PGlite();
    t.after(() => db.close());
    if (baseline) for (const file of ['schema-proposto.sql', 'migrations/001-sessoes.sql']) {
        await db.exec(fs.readFileSync(path.join(__dirname, '../sql', file), 'utf8'));
    }
    // pg uses the simple-query protocol for parameterless migration batches.
    const client = {
        async query(sql, params) {
            if (params) return db.query(sql, params);
            const results = await db.exec(sql);
            return results.at(-1) || { rows: [] };
        },
        release() {},
    };
    return { db, pool: { async connect() { return client; } } };
}

test('runner aplica 002/003/004, registra hash e repete sem executar DDL', async t => {
    const { db, pool } = await fixture(t);
    const first = await migrateCreators(pool);
    assert.deepEqual(first.applied, ['002-criadores.sql', '003-comissoes-rede.sql', '004-simulacao-historico.sql']);
    const second = await migrateCreators(pool);
    assert.deepEqual(second.skipped, first.applied);
    assert.equal((await db.query('SELECT count(*) FROM public.programa_migracoes')).rows[0].count, 3);
    const changed = loadMigrations();
    changed[0].hash = 'f'.repeat(64);
    await assert.rejects(migrateCreators(pool, changed), /já aplicada foi alterada/);
    assert.equal((await db.query('SELECT count(*) FROM public.programa_migracoes')).rows[0].count, 3);
});

test('erro em 003 reverte também 002 e registro das migrações', async t => {
    const { db, pool } = await fixture(t);
    const migrations = loadMigrations();
    migrations[1].sql += '\nSELECT missing_migration_function();';
    await assert.rejects(migrateCreators(pool, migrations), /transação foi revertida/);
    const row = (await db.query("SELECT to_regclass('public.criadores') AS creator, to_regclass('public.programa_migracoes') AS ledger")).rows[0];
    assert.equal(row.creator, null);
    assert.equal(row.ledger, null);
    assert.equal((await migrateCreators(pool)).applied.length, 3);
});

test('baseline ausente é recusado antes de criar tabelas', async t => {
    const { db, pool } = await fixture(t, false);
    await assert.rejects(migrateCreators(pool), /schema base e a migração 001/);
    assert.equal((await db.query("SELECT to_regclass('public.programa_migracoes') AS ledger")).rows[0].ledger, null);
});
