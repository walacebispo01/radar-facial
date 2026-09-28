const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

test('cards de simulação são identificados e renderizados antes dos resultados reais', () => {
    const simulationPosition = html.indexOf('simulacoes.forEach(url =>');
    const realPosition = html.indexOf('perfis.forEach((item, index) =>', simulationPosition);
    assert.ok(simulationPosition > 0);
    assert.ok(realPosition > simulationPosition);
    assert.match(html, /simulation-badge[^>]*>[\s\S]*?Simulação/);
    assert.match(html, /Nenhum resultado real visualmente semelhante foi encontrado/);
});

test('estado de autorização é revalidado no backend antes de mostrar resultados', () => {
    const searchFlow = html.slice(html.indexOf('async function desbloquearResultadosReais'));
    const refreshPosition = searchFlow.indexOf('await atualizarEstadoSimulacao({ silencioso: true })');
    const renderPosition = searchFlow.indexOf('renderizarResultadosReaisAPI(listaPerfis, linksSimulacao)');
    assert.ok(refreshPosition > 0);
    assert.ok(renderPosition > refreshPosition);
    assert.match(html, /id="simulationCreatorBtn"/);
    assert.match(html, /usuarioSimulacaoAutorizado \? 'inline-flex' : 'none'/);
});
