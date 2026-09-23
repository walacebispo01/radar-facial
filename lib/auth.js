const crypto = require('crypto');

const COOKIE = '__Host-radar_session';
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const cookieOptions = { httpOnly: true, secure: true, sameSite: 'lax', path: '/' };
const hash = token => crypto.createHash('sha256').update(token).digest();

function validToken(token) {
    return typeof token === 'string' && /^[A-Za-z0-9_-]{43}$/.test(token) &&
        Buffer.from(token, 'base64url').toString('base64url') === token;
}

function readCookie(req) {
    const matches = (req.headers.cookie || '').split(';').map(v => v.trim())
        .filter(v => v.startsWith(COOKIE + '='));
    if (matches.length !== 1) return null;
    const token = matches[0].slice(COOKIE.length + 1);
    return validToken(token) ? token : null;
}

function isAuthPath(path) {
    return ['/api/login-google', '/api/session', '/api/logout', '/api/descontar-credito',
        '/api/criar-pix', '/api/verificar-pix', '/api/escanear-rosto'].includes(path) ||
        path === '/api/admin/afiliados' || path.startsWith('/api/admin/afiliados/');
}

function createAuth({ sessions, verifyGoogle, origin, isAdmin }) {
    let allowedOrigin;
    try {
        const url = new URL(origin);
        if (url.protocol !== 'https:' || url.username || url.password ||
            url.pathname !== '/' || url.search || url.hash) throw new Error();
        allowedOrigin = url.origin;
    } catch (_) { throw new Error('APP_ORIGIN deve ser a origem HTTPS exata do site, sem caminho.'); }
    if (!sessions || !verifyGoogle) throw new Error('Configuração de autenticação obrigatória.');

    const noStore = (req, res, next) => { res.set('Cache-Control', 'no-store'); next(); };
    const unavailable = res => res.status(503).json({ success: false, error: 'Autenticação temporariamente indisponível.' });
    const unauthorized = res => res.status(401).json({ success: false, error: 'Sessão inválida ou expirada.' });
    const response = session => ({ success: true, email: session.email, creditos: session.creditos,
        isAdmin: isAdmin(session.email), csrfToken: session.csrfToken });

    function validOrigin(req) {
        return req.get('Origin') === allowedOrigin &&
            (!req.get('Sec-Fetch-Site') || req.get('Sec-Fetch-Site') === 'same-origin');
    }

    function browserMutation(req, res, next) {
        const supportedContentType = req.is('application/json') || req.is('multipart/form-data');
        if (!validOrigin(req) || !supportedContentType || req.get('X-Radar-Request') !== '1') {
            return res.status(403).json({ success: false, error: 'Origem da requisição não autorizada.' });
        }
        next();
    }

    async function requireSession(req, res, next) {
        res.set('Cache-Control', 'no-store');
        // GET same-origin normalmente não envia Origin. CORS não é habilitado nestas rotas.
        if ((req.get('Origin') && req.get('Origin') !== allowedOrigin) ||
            (req.get('Sec-Fetch-Site') && req.get('Sec-Fetch-Site') !== 'same-origin' && req.get('Sec-Fetch-Site') !== 'none')) {
            return res.status(403).json({ success: false, error: 'Origem da requisição não autorizada.' });
        }
        const token = readCookie(req);
        if (!token) return unauthorized(res);
        try {
            const tokenHash = hash(token);
            const session = await sessions.find(tokenHash);
            if (!session) return unauthorized(res);
            req.auth = { ...session, tokenHash };
            next();
        } catch (_) { return unavailable(res); }
    }

    function csrf(req, res, next) {
        const supplied = req.get('X-CSRF-Token');
        if (!validToken(supplied) || !req.auth || !crypto.timingSafeEqual(
            Buffer.from(supplied, 'base64url'), Buffer.from(req.auth.csrfToken, 'base64url'))) {
            return res.status(403).json({ success: false, error: 'Token CSRF inválido.', code: 'CSRF_INVALID' });
        }
        next();
    }

    async function login(req, res) {
        if (!req.body?.credential) return res.status(400).json({ success: false, error: 'Token Google não informado.' });
        try {
            const user = await verifyGoogle(req.body.credential);
            if (!user?.email || !user.sub) return res.status(401).json({ success: false, error: 'Autenticação Google inválida.' });
            const token = crypto.randomBytes(32).toString('base64url');
            const session = await sessions.create({ email: user.email, sub: user.sub,
                tokenHash: hash(token), csrfToken: crypto.randomBytes(32) });
            const expires = new Date(session.expiresAt);
            res.cookie(COOKIE, token, { ...cookieOptions, expires,
                maxAge: Math.max(0, Math.min(WEEK_MS, expires.getTime() - Date.now())) });
            return res.json(response(session));
        } catch (_) { return unavailable(res); }
    }

    async function logout(req, res) {
        try {
            await sessions.remove(req.auth.tokenHash);
            res.clearCookie(COOKIE, cookieOptions);
            return res.json({ success: true });
        } catch (_) { return unavailable(res); }
    }

    return { noStore, browserMutation, requireSession, csrf, login, logout,
        session: (req, res) => res.json(response(req.auth)) };
}

module.exports = { createAuth, isAuthPath, COOKIE, hash };
