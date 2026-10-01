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

test('painel do programa incorpora os controles da autorização de simulação existente', () => {
    const panel = fs.readFileSync(path.join(__dirname, '..', 'public', 'creator-panel.html'), 'utf8');
    const script = fs.readFileSync(path.join(__dirname, '..', 'public', 'creator-panel.js'), 'utf8');
    assert.match(panel, /id="simulation-access-form"/);
    assert.match(panel, /id="simulation-access-list"/);
    assert.match(script, /\/api\/admin\/simulacao/);
    assert.match(script, /legacyApi\('\/autorizar'/);
    assert.match(script, /legacyApi\('\/remover'/);
});

test('administrador vê acesso ao painel durante transição mesmo com programa desativado', () => {
    const source = fs.readFileSync(path.join(__dirname, '../public/creator-demo.js'), 'utf8');
    assert.match(source, /state\?\.isAdmin \|\| \(state\?\.enabled && state\.creator\?\.status === 'ativo'\)/);
});

test('administração legada exige confirmação TOTP antes de revelar os controles', () => {
    assert.match(html, /id="affiliateAdminStepUp"/);
    assert.match(html, /id="affiliateAdminTotp"[^>]*pattern="\[0-9\]\{6\}"/);
    assert.match(html, /id="affiliateAdminProtectedContent" hidden/);
    assert.match(html, /authClient\.request\('\/api\/programa\/admin\/verificar'/);
    assert.match(html, /if \(res\.ok && data\.success && data\.isAdmin && data\.adminStepUp\)/);
});

test('clique administrativo revalida o programa no backend antes de abrir o painel legado', () => {
    const start = html.indexOf('async function abrirPainelAfiliados()');
    const end = html.indexOf('async function confirmarTotpAdmin', start);
    const handler = html.slice(start, end);
    const freshState = handler.indexOf("authClient.request('/api/programa/me')");
    const legacyModal = handler.indexOf("document.getElementById('modalAfiliadosAdmin')");

    assert.ok(start > 0 && end > start);
    assert.ok(freshState > 0 && freshState < legacyModal);
    assert.match(handler, /data\.isAdmin && data\.enabled/);
    assert.doesNotMatch(handler, /RadarCreatorDemo\.enabled\(\)/);
    assert.match(handler, /location\.assign\('\/painel'\)/);
});

test('painel novo interrompe navegação administrativa até o step-up', () => {
    const script = fs.readFileSync(path.join(__dirname, '..', 'public', 'creator-panel.js'), 'utf8');
    assert.match(script, /state\.me\.isAdmin && !state\.me\.adminStepUp/);
    assert.match(script, /state\.me\.adminStepUp = true/);
    assert.match(script, /await activate\(state\.pendingTab \|\| state\.activeTab\)/);
});
