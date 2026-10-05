'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { migrateCreators } = require('./migrate-creators');
async function migrateAnalytics(pool) {
    const name = '007-google-analytics.sql';
    const source = fs.readFileSync(path.join(__dirname, '../sql/migrations', name), 'utf8').replace(/\r\n/g, '\n');
    return migrateCreators(pool, [{ name, sql: source.replace(/^\s*BEGIN;\s*/, '').replace(/\s*COMMIT;\s*$/, ''),
        hash: crypto.createHash('sha256').update(source).digest('hex') }]);
}
if (require.main === module) {
    require('dotenv').config({ path: path.join(__dirname, '../.env'), quiet: true });
    const pool = require('../lib/database').createPool();
    migrateAnalytics(pool).then(console.log).catch(() => { console.error('Falha na migração do Analytics.'); process.exitCode = 1; }).finally(() => pool.end());
}
module.exports = { migrateAnalytics };
