'use strict';
const path = require('node:path');
function mountCheckout(app, { auth, orders, provider = 'mercadopago', security, analytics }) {
    app.get('/analytics.js', (req, res) => res.sendFile(path.join(__dirname, '../public/analytics.js')));
    app.get('/api/analytics/config', (req, res) => {
        res.set('Cache-Control', 'no-store');
        res.json({ measurementId: analytics?.enabled ? analytics.measurementId : null });
    });
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
    app.post('/api/checkout/analytics-consent', ...protectedMutation, async (req, res) => {
        try { if (analytics?.enabled) await analytics.withdraw(req.auth.email); res.sendStatus(204); }
        catch { res.sendStatus(503); }
    });
    app.post('/api/checkout/create', ...protectedMutation, async (req, res) => {
        if (provider !== 'infinitepay' || !orders) return res.status(503).json({ error: 'Checkout indisponível.' });
        try {
            const result = await orders.create({ email: req.auth.email, packageId: req.body?.pacote,
                affiliateCode: req.body?.afiliado_codigo, requestKey: req.get('Idempotency-Key') });
            if (!result.alreadyPaid && analytics?.enabled) {
                try { await analytics.record(result.orderId, req.auth.email, req.body?.analytics); }
                catch { console.error('Métricas da compra indisponíveis; checkout preservado.'); }
            }
            const plan = require('./purchase-plans').getPurchasePlan(req.body?.pacote);
            res.json({ success: true, ...result, item: plan ? { item_id: plan.id, item_name: `Radar Facial - ${plan.nome}`, price: plan.centavos / 100, quantity: 1 } : undefined });
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
