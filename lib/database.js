const { Pool } = require('pg');

function createPool() {
    if (!process.env.DATABASE_URL?.trim()) {
        throw new Error('DATABASE_URL não configurada no .env.');
    }
    const pool = new Pool({
        connectionString: process.env.DATABASE_URL,
        max: 10,
        connectionTimeoutMillis: 15000,
        idleTimeoutMillis: 30000,
        statement_timeout: 20000,
        idle_in_transaction_session_timeout: 30000,
        application_name: 'radar-facial',
    });
    // Nunca registrar o objeto de erro, connectionString ou credenciais.
    pool.on('error', () => console.error('[PostgreSQL] Conexão ociosa interrompida.'));
    return pool;
}

module.exports = { createPool };
