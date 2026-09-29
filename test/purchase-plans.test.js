const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PURCHASE_PLANS, getPurchasePlan } = require('../lib/purchase-plans');

test('catálogo do backend contém somente os quatro pacotes oficiais em centavos', () => {
    assert.deepEqual(Object.keys(PURCHASE_PLANS), ['avulso', 'basico', 'popular', 'pro']);
    assert.deepEqual(
        Object.values(PURCHASE_PLANS).map(({ centavos, creditos }) => [centavos, creditos]),
        [[1299, 1], [5495, 5], [9900, 10], [15900, 20]]
    );
    assert.equal(getPurchasePlan('POPULAR'), PURCHASE_PLANS.popular);
    assert.equal(getPurchasePlan('inexistente'), null);
});

test('frontend exibe valores unitários e envia somente o identificador do pacote', () => {
    const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
    for (const text of ['R$ 12,99 / consulta', 'R$ 10,99 / consulta', 'R$ 9,90 / consulta', 'R$ 7,95 / consulta']) {
        assert.match(html, new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    }
    assert.match(html, /JSON\.stringify\(\{ pacote: idPacote \}\)/);
    assert.doesNotMatch(html, /JSON\.stringify\(\{ valor: valor, plano: nomePacote, creditos: qtdCreditos \}\)/);
    assert.match(html, /scroll-snap-type:x mandatory/);
});
