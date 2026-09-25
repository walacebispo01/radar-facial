const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });
const { createPool } = require('../lib/database');

async function main() {
    const pool = createPool();
    try {
        const sql = fs.readFileSync(path.join(__dirname, '..', 'sql', 'migrations',
            '002-protecao-cliques-afiliados.sql'), 'utf8');
        await pool.query(sql);
        console.log('Migração de proteção dos cliques aplicada.');
    } finally {
        await pool.end();
    }
}

main().catch(() => {
    console.error('Falha ao aplicar a migração de proteção dos cliques.');
    process.exitCode = 1;
});
