'use strict';
const crypto = require('node:crypto');
const { StoreError } = require('./postgres-store');
const { getPurchasePlan } = require('./purchase-plans');
const { createInfinitePayClient } = require('./infinitepay-client');
const validIdentifier = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,160}$/.test(value);

function createInfinitePayOrders({ pool, store, handle, origin, clientFactory = createInfinitePayClient }) {
    const callbackOrigin = new URL(origin).origin;
    async function get(id, email) {
        if (typeof id !== 'string' || !/^ip_[a-f0-9]{64}$/.test(id)) throw new StoreError('Pedido inválido.', 400);
        const order = (await pool.query('SELECT * FROM public.infinitepay_pedidos WHERE id=$1', [id])).rows[0];
        if (!order || (email && order.email !== email)) throw new StoreError('Pedido não encontrado.', 404);
        return order;
    }
    return {
        async create({ email, packageId, requestKey, affiliateCode }) {
            const plan = getPurchasePlan(packageId);
            if (!plan || typeof requestKey !== 'string' || !/^[A-Za-z0-9_-]{16,100}$/.test(requestKey)) {
                throw new StoreError('Pacote ou identificação do pedido inválido.', 400);
            }
            const id = 'ip_' + crypto.createHash('sha256').update(JSON.stringify([email, requestKey])).digest('hex');
            const code = String(affiliateCode || '').toLowerCase().trim();
            const affiliate = /^[a-z0-9_-]{1,40}$/.test(code) ? await store.findAffiliate(code) : null;
            const validCode = affiliate?.status === 'ativo' ? affiliate.codigo : null;
            await pool.query(`INSERT INTO public.infinitepay_pedidos(id,email,handle,pacote,centavos,creditos,afiliado_codigo)
                VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(id) DO NOTHING`,
            [id, email, handle, plan.id, plan.centavos, plan.creditos, validCode]);
            const order = await get(id, email);
            if (order.pacote !== plan.id || order.afiliado_codigo !== validCode) throw new StoreError('Pedido já registrado com outros dados.', 409);
            // Snapshot the existing commission network before exposing a payable link.
            await store.createPayment({ payment_id: id, status: 'pending', status_detail: null, email,
                buscas_restantes: order.creditos, idempotency_key: id, afiliado_codigo: order.afiliado_codigo,
                valor_pago: order.centavos / 100 });
            const savedPayment = (await pool.query('SELECT credited FROM public.transacoes WHERE payment_id=$1', [id])).rows[0];
            if (savedPayment.credited) return { orderId: id, alreadyPaid: true };
            const db = await pool.connect();
            try {
                await db.query('BEGIN');
                const locked = (await db.query('SELECT * FROM public.infinitepay_pedidos WHERE id=$1 FOR UPDATE', [id])).rows[0];
                let url = locked.checkout_url;
                if (!url) {
                    const result = await clientFactory({ handle: locked.handle }).createCheckout({ orderId: id,
                        amountCents: locked.centavos, description: `Radar Facial - ${plan.nome}`,
                        redirectUrl: callbackOrigin + '/pagamento', webhookUrl: callbackOrigin + '/api/infinitepay-webhook' });
                    url = result.url;
                    await db.query('UPDATE public.infinitepay_pedidos SET checkout_url=$2 WHERE id=$1', [id, url]);
                }
                await db.query('COMMIT');
                return { orderId: id, url };
            } catch (error) { await db.query('ROLLBACK'); throw error; }
            finally { db.release(); }
        },
        async confirm({ orderId, transactionId, invoiceSlug, email }) {
            if (![transactionId, invoiceSlug].every(validIdentifier)) throw new StoreError('Comprovante inválido.', 400);
            const order = await get(orderId, email);
            try {
                return await store.syncPayment(order.id, async (id, db) => {
                    const verified = await clientFactory({ handle: order.handle }).checkPayment({ orderId: id,
                        transactionId, invoiceSlug, expectedAmountCents: order.centavos });
                    if (!verified.paid) {
                        const pending = new StoreError('Pagamento pendente.', 202);
                        pending.code = 'IP_PENDING';
                        throw pending;
                    }
                    // Binding and credit issuance commit together. A receipt cannot fund two orders.
                    const bound = await db.query(`UPDATE public.infinitepay_pedidos
                        SET transaction_nsu=$2,invoice_slug=$3,confirmado_em=COALESCE(confirmado_em,CURRENT_TIMESTAMP)
                        WHERE id=$1 AND (transaction_nsu IS NULL OR (transaction_nsu=$2 AND invoice_slug=$3)) RETURNING id`,
                    [id, transactionId, invoiceSlug]);
                    if (!bound.rows.length) throw new StoreError('Pedido associado a outro comprovante.', 409);
                    return { id, status: 'approved', currency_id: 'BRL', transaction_amount: order.centavos / 100 };
                });
            } catch (error) {
                // Store sanitizes exceptions; preserve pending without downgrading an approved payment.
                if (error.code === 'IP_PENDING') return { pago: false, status: 'pending' };
                throw error;
            }
        },
    };
}
module.exports = { createInfinitePayOrders };
