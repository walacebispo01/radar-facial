const crypto = require('node:crypto');
const path = require('node:path');

// The Google-authenticated account explicitly authorized by the owner.
// The fingerprint avoids including the raw address in this public repository;
// it is an identifier, not a credential or a substitute for authentication.
const ACCOUNT = '6eabde3c35d4c82fd878b58930e986b483c763dc3e24495e3584a143b5037234';
function isTestAccount(email) {
    return typeof email === 'string' && crypto.createHash('sha256')
        .update(email.trim().toLowerCase()).digest('hex') === ACCOUNT;
}

function mountTestCredit(app, { auth, store, accountAllowed = isTestAccount }) {
    app.get('/teste', (_, res) => res.sendFile(path.join(__dirname, '../public/test-credit.html')));
    app.get('/test-credit.js', (_, res) => res.sendFile(path.join(__dirname, '../public/test-credit.js')));
    const access = (req, res, next) => {
        if (process.env.TEST_CREDIT_ENABLED === 'false' || !accountAllowed(req.auth?.email)) {
            return res.status(403).json({ success: false, error: 'Conta não autorizada para testes.' });
        }
        next();
    };
    app.get('/api/teste/credito', auth.requireSession, access, (req, res) =>
        res.json({ success: true, creditos: req.auth.creditos }));
    // This convenience limiter is local to this process. The balance ceiling and
    // exclusion of in-flight searches are enforced by the database transaction.
    let nextGrantAt = 0;
    app.post('/api/teste/credito', auth.browserMutation, auth.requireSession, auth.csrf, access, async (req, res) => {
        if (Date.now() < nextGrantAt) {
            res.set('Retry-After', '30');
            return res.status(429).json({ success: false, error: 'Aguarde 30 segundos antes de tentar novamente.' });
        }
        nextGrantAt = Date.now() + 30000;
        try {
            // No amount or destination supplied by the browser is used.
            const result = await store.grantOwnTestCredit(req.auth.email);
            if (result.granted) console.info(JSON.stringify({ event: 'test_credit_granted', account: ACCOUNT, amount: 1, at: new Date().toISOString() }));
            return res.json({ success: true, ...result });
        } catch (error) {
            return res.status(error.status === 409 ? 409 : 503).json({ success: false,
                error: error.status === 409 ? 'Existe uma pesquisa em andamento. Aguarde sua conclusão.' : 'Não foi possível liberar o crédito de teste.' });
        }
    });
}
module.exports = { mountTestCredit, isTestAccount };
