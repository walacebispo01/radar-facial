function createRateLimiter({ windowMs, max, keyGenerator, maxEntries = 10000 }) {
    if (!Number.isSafeInteger(windowMs) || windowMs <= 0 ||
        !Number.isSafeInteger(max) || max <= 0 || typeof keyGenerator !== 'function') {
        throw new Error('Configuração de rate limiting inválida.');
    }

    const buckets = new Map();

    return function rateLimit(req, res, next) {
        const now = Date.now();
        const key = String(keyGenerator(req) || 'unknown').slice(0, 300);
        let bucket = buckets.get(key);

        if (!bucket || bucket.resetAt <= now) {
            if (!bucket && buckets.size >= maxEntries) {
                for (const [storedKey, stored] of buckets) {
                    if (stored.resetAt <= now || buckets.size >= maxEntries) buckets.delete(storedKey);
                    if (buckets.size < maxEntries) break;
                }
            }
            bucket = { count: 0, resetAt: now + windowMs };
            buckets.set(key, bucket);
        }

        bucket.count += 1;
        const remaining = Math.max(0, max - bucket.count);
        res.set('RateLimit-Limit', String(max));
        res.set('RateLimit-Remaining', String(remaining));
        res.set('RateLimit-Reset', String(Math.ceil(bucket.resetAt / 1000)));

        if (bucket.count > max) {
            res.set('Retry-After', String(Math.max(1, Math.ceil((bucket.resetAt - now) / 1000))));
            return res.status(429).json({
                success: false,
                error: 'Muitas tentativas de registrar clique. Tente novamente mais tarde.'
            });
        }

        next();
    };
}

module.exports = { createRateLimiter };
