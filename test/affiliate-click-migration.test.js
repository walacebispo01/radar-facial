const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { PGlite } = require('@electric-sql/pglite');

test('migração de cliques preserva registros antigos e deduplica os novos', async t => {
    const db = new PGlite();
    t.after(() => db.close());

    await db.exec(`
        CREATE TABLE public.afiliados (codigo varchar(40) PRIMARY KEY);
        INSERT INTO public.afiliados (codigo) VALUES ('teste');
        CREATE TABLE public.cliques_afiliados (
            id text PRIMARY KEY,
            afiliado_codigo varchar(40) NOT NULL REFERENCES public.afiliados(codigo),
            criado_em timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        INSERT INTO public.cliques_afiliados (id, afiliado_codigo)
        VALUES ('antigo-1', 'teste'), ('antigo-2', 'teste');
    `);

    const migration = fs.readFileSync(path.join(__dirname, '..', 'sql', 'migrations',
        '002-protecao-cliques-afiliados.sql'), 'utf8');
    await db.exec(migration);

    assert.equal((await db.query('SELECT count(*) FROM public.cliques_afiliados')).rows[0].count, 2);
    const key = 'd'.repeat(64);
    const first = await db.query(`INSERT INTO public.cliques_afiliados (id, afiliado_codigo, dedupe_key)
        VALUES ('novo-1','teste',$1) ON CONFLICT (dedupe_key) DO NOTHING RETURNING id`, [key]);
    const duplicate = await db.query(`INSERT INTO public.cliques_afiliados (id, afiliado_codigo, dedupe_key)
        VALUES ('novo-2','teste',$1) ON CONFLICT (dedupe_key) DO NOTHING RETURNING id`, [key]);
    assert.equal(first.rows.length, 1);
    assert.equal(duplicate.rows.length, 0);
    assert.equal((await db.query('SELECT count(*) FROM public.cliques_afiliados')).rows[0].count, 3);
});
