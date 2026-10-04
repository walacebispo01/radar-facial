'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createInfinitePayClient } = require('../lib/infinitepay-client');
const receipt = { orderId: 'order_123', transactionId: 'transaction_456', invoiceSlug: 'invoice_789', expectedAmountCents: 1299 };
const paid = { success: true, paid: true, amount: 1299, paid_amount: 1320, capture_method: 'credit_card' };
function client(body) {
    return createInfinitePayClient({ handle: 'merchant-test', fetchImpl: async () => ({ ok: true, json: async () => body }) });
}

test('checkout sends cents and server order without customer personal data', async () => {
    let sent;
    const api = createInfinitePayClient({ handle: 'merchant-test', fetchImpl: async (url, options) => {
        sent = { url, options, body: JSON.parse(options.body) };
        return { ok: true, json: async () => ({ url: 'https://checkout.infinitepay.com.br/pay/order' }) };
    } });
    assert.deepEqual(await api.createCheckout({ orderId: receipt.orderId, amountCents: 1299, description: 'Radar Facial - Avulso',
        redirectUrl: 'https://radarfacial.com.br/pagamento', webhookUrl: 'https://radarfacial.com.br/api/infinitepay-webhook' }),
    { url: 'https://checkout.infinitepay.com.br/pay/order' });
    assert.equal(sent.url, 'https://api.checkout.infinitepay.io/links');
    assert.equal(sent.options.redirect, 'error');
    assert.equal(sent.body.items[0].price, 1299);
    assert.equal(sent.body.order_nsu, receipt.orderId);
    assert.equal(sent.body.customer, undefined);
});

test('receipt is checked against provider using merchant and stored order identifiers', async () => {
    let sent;
    const api = createInfinitePayClient({ handle: 'merchant-test', fetchImpl: async (url, options) => {
        sent = { url, body: JSON.parse(options.body) };
        return { ok: true, json: async () => paid };
    } });
    assert.deepEqual(await api.checkPayment(receipt), { paid: true, amountCents: 1299, paidAmountCents: 1320, method: 'credit_card' });
    assert.equal(sent.url, 'https://api.checkout.infinitepay.io/payment_check');
    assert.deepEqual(sent.body, { handle: 'merchant-test', order_nsu: receipt.orderId, transaction_nsu: receipt.transactionId, slug: receipt.invoiceSlug });
});

test('paid false is pending verification, not inferred refund or approval', async () => {
    assert.deepEqual(await client({ success: true, paid: false }).checkPayment(receipt), { paid: false });
});

test('provider errors, mismatching amount and malformed confirmations cannot approve', async () => {
    for (const body of [{ ...paid, amount: 1 }, { ...paid, amount: '1299' }, { ...paid, paid: 'true' },
        { ...paid, paid_amount: 1 }, { ...paid, success: false }, { ...paid, capture_method: 'unknown' }]) {
        await assert.rejects(client(body).checkPayment(receipt));
    }
    const api = createInfinitePayClient({ handle: 'merchant-test', fetchImpl: async () => ({ ok: false }) });
    await assert.rejects(api.checkPayment(receipt), /consultar a InfinitePay/);
});

test('unsafe checkout destinations cannot redirect customers', async () => {
    for (const url of ['http://checkout.infinitepay.com.br/order', 'https://checkout.infinitepay.com.br.evil.test/order',
        'https://user:secret@checkout.infinitepay.com.br/order', 'https://checkout.infinitepay.com.br:8443/order']) {
        await assert.rejects(client({ url }).createCheckout({ orderId: 'order_123', amountCents: 1299, description: 'Avulso',
            redirectUrl: 'https://radarfacial.com.br/pagamento', webhookUrl: 'https://radarfacial.com.br/api/infinitepay-webhook' }));
    }
});
