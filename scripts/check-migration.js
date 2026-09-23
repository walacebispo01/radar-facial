const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });
const { createPool } = require('../lib/database');

async function main() {
    const pool = createPool();
    try {
        const { rows } = await pool.query(`SELECT tablename FROM pg_tables
            WHERE schemaname = 'public' AND tablename IN ('sessoes', 'buscas_faciais')
            ORDER BY tablename`);
        console.log(rows.length ? rows.map(row => row.tablename).join(',') : 'NENHUMA');
    } finally {
        await pool.end();
    }
}

main().catch(() => {
    console.error('Falha ao consultar estado da migração.');
    process.exitCode = 1;
});
