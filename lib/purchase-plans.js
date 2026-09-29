const PURCHASE_PLANS = Object.freeze({
    avulso: Object.freeze({ id: 'avulso', nome: 'Avulso', centavos: 1299, creditos: 1 }),
    basico: Object.freeze({ id: 'basico', nome: 'Básico', centavos: 5495, creditos: 5 }),
    popular: Object.freeze({ id: 'popular', nome: 'Popular', centavos: 9900, creditos: 10 }),
    pro: Object.freeze({ id: 'pro', nome: 'Pro', centavos: 15900, creditos: 20 }),
});

function getPurchasePlan(id) {
    return PURCHASE_PLANS[String(id || '').toLowerCase().trim()] || null;
}

module.exports = { PURCHASE_PLANS, getPurchasePlan };
