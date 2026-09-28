const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

test('cards de simulação são identificados em um renderizador separado', () => {
    const simulationPosition = html.indexOf('function renderizarResultadosSimulados');
    const normalPosition = html.indexOf('function renderizarResultadosReaisAPI');
    assert.ok(simulationPosition > 0);
    assert.ok(normalPosition > 0);
    assert.match(html, /simulation-badge[^>]*>[\s\S]*?Simulação/);
    assert.match(html, /Simulação · Resultados de demonstração/);
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
