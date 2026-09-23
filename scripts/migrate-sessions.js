const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });
const { createPool } = require('../lib/database');

async function main() {
    if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL não configurada.');
    const sql = fs.readFileSync(path.join(__dirname, '..', 'sql', 'migrations', '001-sessoes.sql'), 'utf8');
    const pool = createPool();
    const db = await pool.connect();
    let broken;
    try {
        await db.query('BEGIN');
        await db.query(sql);
        await db.query('COMMIT');
        console.log('Migração 001-sessoes.sql aplicada com sucesso.');
    } catch (error) {
        try { await db.query('ROLLBACK'); } catch (rollbackError) { broken = rollbackError; }
        throw new Error('Falha ao aplicar 001-sessoes.sql; nenhuma alteração parcial foi mantida.');
    } finally {
        db.release(broken);
        await pool.end();
    }
}

main().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
});
