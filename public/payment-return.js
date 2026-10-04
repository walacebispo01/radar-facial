(async function () {
    'use strict';
    const status = document.getElementById('status');
    const retry = document.getElementById('retry');
    const params = new URLSearchParams(location.search);
    const receipt = Object.fromEntries(['order_nsu', 'transaction_nsu', 'slug'].map(key => [key, params.get(key)]));
    const auth = RadarAuth.createClient({ onSession() {} });
    async function verify() {
        retry.disabled = true;
        try {
            if (!Object.values(receipt).every(Boolean)) throw new Error('Retorno incompleto. Aguarde a confirmação automática do pagamento e confira seu saldo na página inicial.');
            const session = await auth.restore();
            if (!session) {
                throw new Error('Entre na página inicial com a mesma conta Google da compra. O pagamento também será confirmado automaticamente quando a InfinitePay enviar a confirmação.');
            }
            const response = await auth.request('/api/checkout/confirm', { method: 'POST',
                headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(receipt) });
            const data = await response.json();
            if (!response.ok) throw new Error(data.error || 'Não foi possível conferir agora.');
            if (data.pago) {
                status.textContent = `Pagamento confirmado. Seu saldo é de ${data.creditos} créditos.`;
                sessionStorage.removeItem('radar_checkout_request');
                retry.hidden = true;
                history.replaceState(null, '', '/pagamento');
            } else {
                status.textContent = 'Seu pagamento ainda está pendente. Após concluir a compra, verifique novamente.';
                retry.hidden = false;
            }
        } catch (error) { status.textContent = error.message; retry.hidden = false; }
        finally { retry.disabled = false; }
    }
    retry.addEventListener('click', verify);
    await verify();
})();
