const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });
const { Client } = require('pg');

async function main() {
    if (!process.env.DATABASE_URL?.trim()) {
        console.error('DATABASE_URL ausente ou vazia no .env.');
        process.exitCode = 1;
        return;
    }

    const client = new Client({
        connectionString: process.env.DATABASE_URL,
        connectionTimeoutMillis: 15000,
        query_timeout: 15000,
        statement_timeout: 10000,
        options: '-c default_transaction_read_only=on',
    });

    try {
        await client.connect();
        await client.query('BEGIN READ ONLY');
        const result = await client.query('SELECT 1 AS ok');
        await client.query('ROLLBACK');
        if (result.rows[0]?.ok !== 1) throw new Error('Unexpected result');
        console.log('CONEXÃO OK');
    } catch (error) {
        // Não imprimir mensagens/objetos que possam conter a URL ou credenciais.
        const code = String(error.code || 'CONNECTION_FAILED');
        console.error('Falha na conexão PostgreSQL. Código:',
            /^[A-Z0-9_]+$/.test(code) ? code : 'CONNECTION_FAILED');
        process.exitCode = 1;
    } finally {
        await client.end();
    }
}

main().catch(() => {
    console.error('Falha ao configurar o cliente PostgreSQL. Verifique o formato da DATABASE_URL.');
    process.exitCode = 1;
});
