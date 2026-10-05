'use strict';
const { getPurchasePlan } = require('./purchase-plans');

function validContext(value) {
    if (!value || value.consent !== true || !/^\d{1,20}\.\d{1,20}$/.test(value.clientId || '') ||
        !/^\d{1,16}$/.test(String(value.sessionId || '')) || !Number.isSafeInteger(Number(value.sessionId)) || Number(value.sessionId) < 1) return null;
    return { clientId: value.clientId, sessionId: Number(value.sessionId) };
}
function createAnalytics({ pool, measurementId, apiSecret, fetchImpl = fetch }) {
    const enabled = /^G-[A-Z0-9]{6,20}$/.test(measurementId || '') && Boolean(apiSecret);
    return {
        enabled, measurementId: enabled ? measurementId : null,
        async record(orderId, email, input) {
            if (!enabled) return;
            const context = validContext(input);
            if (!context) {
                await pool.query(`DELETE FROM public.ga4_pedidos g USING public.infinitepay_pedidos o
                    WHERE g.order_id=o.id AND o.id=$1 AND o.email=$2 AND g.enviado_em IS NULL`, [orderId, email]);
                return;
            }
            await pool.query(`INSERT INTO public.ga4_pedidos(order_id,measurement_id,client_id,session_id)
                SELECT id,$3,$4,$5 FROM public.infinitepay_pedidos WHERE id=$1 AND email=$2
                ON CONFLICT(order_id) DO NOTHING`, [orderId, email, measurementId, context.clientId, context.sessionId]);
        },
        async withdraw(email) {
            await pool.query(`DELETE FROM public.ga4_pedidos g USING public.infinitepay_pedidos o
                WHERE g.order_id=o.id AND o.email=$1 AND g.enviado_em IS NULL`, [email]);
        },
        async processPending(limit = 5) {
            if (!enabled) return { sent: 0, failed: 0 };
            const result = { sent: 0, failed: 0 };
            for (let n = 0; n < limit; n++) {
                const db = await pool.connect();
                try {
                    await db.query('BEGIN');
                    const row = (await db.query(`SELECT g.*,o.pacote,o.centavos,o.confirmado_em
                        FROM public.ga4_pedidos g JOIN public.infinitepay_pedidos o ON o.id=g.order_id
                        JOIN public.transacoes t ON t.payment_id=o.id
                        WHERE g.enviado_em IS NULL AND g.measurement_id=$1 AND g.tentar_em<=CURRENT_TIMESTAMP
                        AND t.credited=true AND t.status='approved' AND o.confirmado_em>CURRENT_TIMESTAMP-INTERVAL '72 hours'
                        ORDER BY g.criado_em LIMIT 1 FOR UPDATE OF g SKIP LOCKED`, [measurementId])).rows[0];
                    if (!row) { await db.query('COMMIT'); break; }
                    const plan = getPurchasePlan(row.pacote);
                    if (!plan) throw new Error('INVALID_PLAN');
                    const url = new URL('https://www.google-analytics.com/mp/collect');
                    url.searchParams.set('measurement_id', measurementId);
                    url.searchParams.set('api_secret', apiSecret);
                    // Only anonymous visit identifiers and the server's verified order are sent.
                    // Purchase is sent here exclusively, never from the return page.
                    const payload = { client_id: row.client_id,
                        timestamp_micros: new Date(row.confirmado_em).getTime() * 1000,
                        consent: { ad_user_data: 'DENIED', ad_personalization: 'DENIED' },
                        events: [{ name: 'purchase', params: { transaction_id: row.order_id,
                            currency: 'BRL', value: row.centavos / 100, session_id: Number(row.session_id),
                            items: [{ item_id: row.pacote, item_name: `Radar Facial - ${plan.nome}`, price: row.centavos / 100, quantity: 1 }] } }] };
                    let accepted = false;
                    try {
                        const response = await fetchImpl(url.href, { method: 'POST', headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify(payload), signal: AbortSignal.timeout(4000) });
                        accepted = response.ok;
                    } catch { /* Never log URLs containing the API secret. */ }
                    await db.query(`UPDATE public.ga4_pedidos SET tentativas=tentativas+1,
                        enviado_em=CASE WHEN $2 THEN CURRENT_TIMESTAMP ELSE NULL END,
                        tentar_em=CURRENT_TIMESTAMP+INTERVAL '5 minutes' WHERE order_id=$1`, [row.order_id, accepted]);
                    await db.query('COMMIT');
                    result[accepted ? 'sent' : 'failed']++;
                } catch {
                    await db.query('ROLLBACK').catch(() => {});
                    result.failed++;
                    break;
                } finally { db.release(); }
            }
            return result;
        },
    };
}
module.exports = { createAnalytics, validContext };
