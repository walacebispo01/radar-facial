const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const MIGRATIONS = ['002-criadores.sql', '003-comissoes-rede.sql', '004-simulacao-historico.sql'];

function loadMigrations(directory = path.join(__dirname, '../sql/migrations')) {
    return MIGRATIONS.map(name => {
        const source = fs.readFileSync(path.join(directory, name), 'utf8').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
        // These checked-in migrations have exactly one outer transaction wrapper.
        if (!/^\s*BEGIN;[\s\S]*COMMIT;\s*$/.test(source)) {
            throw new Error(`Formato de transação inesperado em ${name}.`);
        }
        const sql = source.replace(/^\s*BEGIN;\s*/, '').replace(/\s*COMMIT;\s*$/, '');
        return { name, sql, hash: crypto.createHash('sha256').update(source).digest('hex') };
    });
}

async function migrateCreators(pool, migrations = loadMigrations()) {
    const db = await pool.connect();
    let broken;
    try {
        await db.query('BEGIN');
        await db.query("SELECT pg_advisory_xact_lock(hashtext('radar-facial:creator-migrations'))");
        const baseline = await db.query(`SELECT to_regclass('public.usuarios') AS usuarios,
            to_regclass('public.afiliados') AS afiliados, to_regclass('public.transacoes') AS transacoes,
            to_regclass('public.sessoes') AS sessoes, to_regclass('public.buscas_faciais') AS buscas_faciais`);
        if (Object.values(baseline.rows[0]).some(value => value === null)) {
            throw new Error('BASELINE_REQUIRED');
        }
        await db.query(`CREATE TABLE IF NOT EXISTS public.programa_migracoes (
            nome text PRIMARY KEY, sha256 text NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
            aplicada_em timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
        )`);
        const applied = [], skipped = [];
        for (const migration of migrations) {
            const prior = (await db.query('SELECT sha256 FROM public.programa_migracoes WHERE nome=$1', [migration.name])).rows[0];
            if (prior) {
                if (prior.sha256 !== migration.hash) throw new Error('MIGRATION_HASH_MISMATCH');
                skipped.push(migration.name);
                continue;
            }
            await db.query(migration.sql);
            await db.query('INSERT INTO public.programa_migracoes(nome,sha256) VALUES($1,$2)', [migration.name, migration.hash]);
            applied.push(migration.name);
        }
        await db.query('COMMIT');
        return { applied, skipped };
    } catch (error) {
        try { await db.query('ROLLBACK'); } catch (rollbackError) { broken = rollbackError; }
        const messages = {
            BASELINE_REQUIRED: 'Aplique e confira o schema base e a migração 001 antes do programa de criadores.',
            MIGRATION_HASH_MISMATCH: 'Uma migração já aplicada foi alterada. Restaure o arquivo original e use uma nova migração.',
        };
        throw new Error(messages[error.message] || 'Falha nas migrações do programa; a transação foi revertida. Confira o baseline e possíveis objetos preexistentes.');
    } finally {
        db.release(broken);
    }
}

async function main() {
    require('dotenv').config({ path: path.join(__dirname, '../.env'), quiet: true });
    const { createPool } = require('../lib/database');
    const pool = createPool();
    try {
        const result = await migrateCreators(pool);
        console.log(`Migrações aplicadas: ${result.applied.join(', ') || 'nenhuma'}. Já verificadas: ${result.skipped.join(', ') || 'nenhuma'}.`);
    } finally {
        await pool.end();
    }
}

if (require.main === module) main().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
});

module.exports = { loadMigrations, migrateCreators };
