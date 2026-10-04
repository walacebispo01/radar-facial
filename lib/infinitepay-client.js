'use strict';

// Provider adapter only. It does not issue credits or make financial transactions.
const API_ORIGIN = 'https://api.checkout.infinitepay.io';
const CHECKOUT_HOSTS = new Set(['checkout.infinitepay.com.br', 'checkout.infinitepay.io']);

function identifier(value) {
    return typeof value === 'string' && /^[A-Za-z0-9_-]{1,160}$/.test(value);
}

function checkoutUrl(value) {
    try {
        const url = new URL(value);
        if (url.protocol !== 'https:' || !CHECKOUT_HOSTS.has(url.hostname) || url.port || url.username || url.password) throw new Error();
        return url.href;
    } catch { throw new Error('Endereço de checkout InfinitePay inválido.'); }
}

function callbackUrl(value) {
    try {
        const url = new URL(value);
        if (url.protocol !== 'https:' || url.username || url.password || url.hash) throw new Error();
        return url.href;
    } catch { throw new Error('URL de retorno deve usar HTTPS.'); }
}

function createInfinitePayClient({ handle, fetchImpl = globalThis.fetch, timeoutMs = 8000 } = {}) {
    if (!identifier(handle) || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10000) {
        throw new Error('Configuração InfinitePay inválida.');
    }

    async function post(endpoint, payload) {
        let response;
        try {
            response = await fetchImpl(API_ORIGIN + endpoint, {
                method: 'POST', redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
                headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
                body: JSON.stringify({ handle, ...payload }),
            });
            if (!response.ok) throw new Error();
            return await response.json();
        } catch { throw new Error('Não foi possível consultar a InfinitePay. Tente novamente.'); }
    }

    return {
        async createCheckout({ orderId, amountCents, description, redirectUrl, webhookUrl }) {
            if (!identifier(orderId) || !Number.isSafeInteger(amountCents) || amountCents <= 0 ||
                typeof description !== 'string' || !description.trim() || description.length > 200) {
                throw new Error('Pedido InfinitePay inválido.');
            }
            const result = await post('/links', {
                order_nsu: orderId,
                items: [{ quantity: 1, price: amountCents, description }],
                redirect_url: callbackUrl(redirectUrl), webhook_url: callbackUrl(webhookUrl),
            });
            return { url: checkoutUrl(result?.url) };
        },

        async checkPayment({ orderId, transactionId, invoiceSlug, expectedAmountCents }) {
            if (![orderId, transactionId, invoiceSlug].every(identifier) ||
                !Number.isSafeInteger(expectedAmountCents) || expectedAmountCents <= 0) {
                throw new Error('Identificação do pagamento inválida.');
            }
            const result = await post('/payment_check', {
                order_nsu: orderId, transaction_nsu: transactionId, slug: invoiceSlug,
            });
            if (result?.success !== true || typeof result.paid !== 'boolean') throw new Error('Resposta de pagamento inválida.');
            if (!result.paid) return { paid: false };
            if (!Number.isSafeInteger(result.amount) || result.amount !== expectedAmountCents ||
                !Number.isSafeInteger(result.paid_amount) || result.paid_amount < result.amount ||
                !['pix', 'credit_card'].includes(result.capture_method)) {
                throw new Error('Valor ou método do pagamento diverge do pedido.');
            }
            // paid=false does not identify a refund. Never infer a refund or cancellation from it.
            return { paid: true, amountCents: result.amount, paidAmountCents: result.paid_amount,
                method: result.capture_method };
        },
    };
}

module.exports = { createInfinitePayClient, checkoutUrl };
