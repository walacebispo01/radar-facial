'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { migrateCreators } = require('./migrate-creators');
async function migrateCheckout(pool) {
    const name = '006-infinitepay.sql';
    const source = fs.readFileSync(path.join(__dirname, '../sql/migrations', name), 'utf8').replace(/\r\n/g, '\n');
    const sql = source.replace(/^\s*BEGIN;\s*/, '').replace(/\s*COMMIT;\s*$/, '');
    return migrateCreators(pool, [{ name, sql, hash: crypto.createHash('sha256').update(source).digest('hex') }]);
}
async function main() {
    require('dotenv').config({ path: path.join(__dirname, '../.env'), quiet: true });
    const pool = require('../lib/database').createPool();
    try { console.log(await migrateCheckout(pool)); }
    finally { await pool.end(); }
}
if (require.main === module) main().catch(() => { console.error('Falha na migração 006; nenhuma alteração parcial foi mantida.'); process.exitCode = 1; });
module.exports = { migrateCheckout };
