'use strict';
const path = require('node:path');
function mountCheckout(app, { auth, orders, provider = 'mercadopago', security }) {
    app.get('/checkout.js', (req, res) => res.sendFile(path.join(__dirname, '../public/checkout.js')));
    app.get('/pagamento', (req, res) => {
        res.set('Referrer-Policy', 'no-referrer');
        res.set('Cache-Control', 'no-store');
        res.sendFile(path.join(__dirname, '../public/payment-return.html'));
    });
    app.get('/payment-return.js', (req, res) => res.sendFile(path.join(__dirname, '../public/payment-return.js')));
    app.get('/api/checkout/config', auth.requireSession, (req, res) => res.json({ provider }));
    const protectedMutation = [auth.browserMutation, auth.requireSession, auth.csrf];
    if (security) protectedMutation.push(security.limiter('checkout', 30));
    app.post('/api/checkout/create', ...protectedMutation, async (req, res) => {
        if (provider !== 'infinitepay' || !orders) return res.status(503).json({ error: 'Checkout indisponível.' });
        try {
            const result = await orders.create({ email: req.auth.email, packageId: req.body?.pacote,
                affiliateCode: req.body?.afiliado_codigo, requestKey: req.get('Idempotency-Key') });
            res.json({ success: true, ...result });
        } catch (error) { res.status(error.status || 502).json({ error: error.status ? error.message : 'Não foi possível abrir o checkout. Tente novamente.' }); }
    });
    app.post('/api/checkout/confirm', ...protectedMutation, async (req, res) => {
        if (!orders) return res.status(503).json({ error: 'Confirmação indisponível.' });
        try {
            const result = await orders.confirm({ email: req.auth.email, orderId: req.body?.order_nsu,
                transactionId: req.body?.transaction_nsu, invoiceSlug: req.body?.slug });
            res.json({ success: true, ...result });
        } catch (error) { res.status(error.status || 502).json({ error: error.status ? error.message : 'Não foi possível confirmar. Tente novamente.' }); }
    });
    app.post('/api/infinitepay-webhook', async (req, res) => {
        if (!orders) return res.sendStatus(503);
        if (security && !await security.consume('infinitepay-webhook', req.ip, 60, 60)) return res.sendStatus(429);
        try {
            const result = await orders.confirm({ orderId: req.body?.order_nsu,
                transactionId: req.body?.transaction_nsu, invoiceSlug: req.body?.invoice_slug });
            return res.sendStatus(result.pago ? 200 : 400);
        } catch (error) { return res.sendStatus(error.status === 404 ? 200 : 400); }
    });
}
module.exports = { mountCheckout };
