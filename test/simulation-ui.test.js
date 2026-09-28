const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

test('cards do fluxo interno mantêm a aparência normal e a identificação fica fora dos resultados', () => {
    const simulationPosition = html.indexOf('function renderizarResultadosSimulados');
    const normalPosition = html.indexOf('function renderizarResultadosReaisAPI');
    assert.ok(simulationPosition > 0);
    assert.ok(normalPosition > 0);
    const simulationRenderer = html.slice(simulationPosition, html.indexOf('async function carregarCriadoresSimulacaoAdmin', simulationPosition));
    assert.doesNotMatch(simulationRenderer, /Simulação|Resultado simulado|Demonstração/i);
    assert.match(html, /Modo demonstração/);
    assert.equal((html.match(/Modo demonstração/g) || []).length, 1);
});

test('fluxo simulado é separado antes do endpoint de pesquisa real', () => {
    const searchFlow = html.slice(html.indexOf('async function desbloquearResultadosReais'));
    const simulationGuard = searchFlow.indexOf('if (modoSimulacaoAtivo)');
    const faceCheckRequest = searchFlow.indexOf("authClient.request('/api/escanear-rosto'");
    assert.ok(simulationGuard > 0);
    assert.ok(faceCheckRequest > simulationGuard);
    assert.match(html, /authClient\.request\('\/api\/simulacao\/executar'/);
    assert.match(html, /renderizarResultadosReaisAPI\(listaPerfis\)/);
    assert.match(html, /id="simulationCreatorBtn"/);
    assert.match(html, /usuarioSimulacaoAutorizado \? 'inline-flex' : 'none'/);
});

test('botão do modo simulação não é ocultado pela regra mobile dos botões administrativos', () => {
    assert.match(html, /\.admin-affiliate-btn:not\(\.simulation-creator-btn\)\s*\{\s*display:\s*none\s*!important/);
});
