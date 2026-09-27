const crypto = require('node:crypto');

function decodeBase32(value) {
    if (typeof value !== 'string' || !/^[A-Z2-7]{32,104}={0,6}$/i.test(value)) throw new Error('INVALID_TOTP_SECRET');
    let bits = 0, accumulator = 0;
    const output = [];
    for (const char of value.toUpperCase().replace(/=+$/, '')) {
        accumulator = (accumulator << 5) | 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'.indexOf(char);
        bits += 5;
        if (bits >= 8) { bits -= 8; output.push((accumulator >>> bits) & 255); }
    }
    return Buffer.from(output);
}

function totp(secret, step, digits = 6) {
    const counter = Buffer.alloc(8);
    counter.writeBigUInt64BE(BigInt(step));
    const digest = crypto.createHmac('sha1', decodeBase32(secret)).update(counter).digest();
    const offset = digest[digest.length - 1] & 15;
    return String((digest.readUInt32BE(offset) & 0x7fffffff) % (10 ** digits)).padStart(digits, '0');
}

function matchingStep(secret, code, now = Date.now()) {
    if (typeof code !== 'string' || !/^\d{6}$/.test(code)) return null;
    const step = Math.floor(now / 30000);
    for (const candidate of [step, step - 1, step + 1]) {
        if (crypto.timingSafeEqual(Buffer.from(totp(secret, candidate)), Buffer.from(code))) return candidate;
    }
    return null;
}

function secretsFromEnv(raw = process.env.ADMIN_TOTP_SECRETS || '{}') {
    let parsed;
    try { parsed = JSON.parse(raw); } catch { throw new Error('ADMIN_TOTP_SECRETS deve conter um objeto JSON.'); }
    if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') throw new Error('ADMIN_TOTP_SECRETS inválido.');
    const result = Object.create(null);
    for (const [email, secret] of Object.entries(parsed)) {
        decodeBase32(secret);
        result[email.trim().toLowerCase()] = secret;
    }
    return result;
}

function createProgramSecurity(pool, { secrets = secretsFromEnv(), now = () => Date.now() } = {}) {
    async function consume(scope, identity, limit = 60, seconds = 60) {
        const key = crypto.createHash('sha256').update(scope + ':' + identity).digest('hex');
        const { rows } = await pool.query(`INSERT INTO public.programa_rate_limits(key,hits,expires_at)
            VALUES ($1,1,CURRENT_TIMESTAMP + $2 * INTERVAL '1 second')
            ON CONFLICT (key) DO UPDATE SET
              hits = CASE WHEN programa_rate_limits.expires_at <= CURRENT_TIMESTAMP THEN 1
                     ELSE LEAST(programa_rate_limits.hits + 1,$3 + 1) END,
              expires_at = CASE WHEN programa_rate_limits.expires_at <= CURRENT_TIMESTAMP
                     THEN CURRENT_TIMESTAMP + $2 * INTERVAL '1 second' ELSE programa_rate_limits.expires_at END
            RETURNING hits`, [key, seconds, limit]);
        return Number(rows[0].hits) <= limit;
    }
    async function active(auth) {
        const { rows } = await pool.query(`SELECT 1 FROM public.admin_stepup
            WHERE session_hash=$1 AND email=$2 AND expires_at>CURRENT_TIMESTAMP`, [auth.tokenHash, auth.email]);
        return rows.length > 0;
    }
    async function verify(auth, code) {
        const secret = secrets[auth.email];
        if (!secret) return { ok: false, code: 'ADMIN_2FA_NOT_CONFIGURED' };
        const step = matchingStep(secret, code, now());
        if (step === null) return { ok: false, code: 'INVALID_OTP' };
        const db = await pool.connect();
        try {
            await db.query('BEGIN');
            const { rows } = await db.query(`INSERT INTO public.admin_totp_usos(email,step) VALUES ($1,$2)
                ON CONFLICT (email) DO UPDATE SET step=EXCLUDED.step
                WHERE admin_totp_usos.step < EXCLUDED.step RETURNING step`, [auth.email, step]);
            if (!rows.length) { await db.query('ROLLBACK'); return { ok: false, code: 'OTP_REUSED' }; }
            await db.query(`INSERT INTO public.admin_stepup(session_hash,email,expires_at)
                VALUES ($1,$2,CURRENT_TIMESTAMP + INTERVAL '5 minutes')
                ON CONFLICT (session_hash) DO UPDATE SET expires_at=EXCLUDED.expires_at`, [auth.tokenHash, auth.email]);
            await db.query('COMMIT');
            return { ok: true };
        } catch (error) { await db.query('ROLLBACK'); throw error; }
        finally { db.release(); }
    }
    function limiter(scope, limit, seconds = 60) {
        return async (req, res, next) => {
            try {
                if (!await consume(scope, req.auth?.email || req.ip, limit, seconds)) {
                    res.set('Retry-After', String(seconds));
                    return res.status(429).json({ success: false, error: 'Muitas tentativas. Aguarde e tente novamente.' });
                }
                next();
            } catch (_) { res.status(503).json({ success: false, error: 'Proteção temporariamente indisponível.' }); }
        };
    }
    async function requireStepUp(req, res, next) {
        try {
            if (!await active(req.auth)) return res.status(403).json({ success: false, code: 'STEP_UP_REQUIRED', error: 'Confirme o código do autenticador para continuar.' });
            next();
        } catch (_) { res.status(503).json({ success: false, error: 'Verificação administrativa indisponível.' }); }
    }
    return { consume, active, verify, limiter, requireStepUp };
}

// Verified signed notification IDs are used for provider re-fetching, never the body as payment truth.
function verifyMercadoPagoSignature(req, secret) {
    if (!secret) return false;
    const signature = req.get('x-signature'), requestId = req.get('x-request-id');
    const dataId = req.query?.['data.id'];
    if (typeof dataId !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(dataId) ||
        typeof requestId !== 'string' || !/^[a-zA-Z0-9_-]{1,200}$/.test(requestId) || typeof signature !== 'string') return false;
    const parts = signature.split(',').map(part => part.trim().split('='));
    const timestamps = parts.filter(([key]) => key === 'ts');
    const signatures = parts.filter(([key]) => key === 'v1');
    if (timestamps.length !== 1 || signatures.length !== 1) return false;
    const ts = timestamps[0][1], v1 = signatures[0][1];
    if (!/^\d{10,16}$/.test(ts || '') || !/^[a-f\d]{64}$/i.test(v1 || '')) return false;
    if (req.body?.data?.id != null && String(req.body.data.id).toLowerCase() !== dataId.toLowerCase()) return false;
    const manifest = `id:${dataId.toLowerCase()};request-id:${requestId};ts:${ts};`;
    const expected = crypto.createHmac('sha256', secret).update(manifest).digest();
    return crypto.timingSafeEqual(expected, Buffer.from(v1, 'hex'));
}

module.exports = { createProgramSecurity, verifyMercadoPagoSignature, totp, matchingStep, secretsFromEnv };
