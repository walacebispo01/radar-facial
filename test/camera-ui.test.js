const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

test('usa o seletor nativo do aparelho para câmera ou galeria', () => {
    assert.match(html, /id="imageInput"[^>]+accept="image\/\*"/);
    assert.match(html, /id="cameraInput"[^>]+accept="image\/\*"[^>]+capture="user"/);
    assert.match(html, /function abrirCameraNativa\(\)[\s\S]*cameraInput\.click\(\)/);
    assert.match(html, /function abrirGaleriaNativa\(\)[\s\S]*fileInput\.click\(\)/);
    assert.doesNotMatch(html, /navigator\.mediaDevices\.getUserMedia/);
    assert.doesNotMatch(html, /id="cameraPreview"/);
});

test('mantém a autenticação antes de abrir o seletor de foto', () => {
    assert.match(html, /function abrirOpcoesFoto\(event\)[\s\S]*if \(!usuarioEmail\)[\s\S]*abrirModalLogin\(\)/);
});

test('imagem escolhida continua usando o fluxo de prévia e ajuste', () => {
    assert.match(html, /reader\.onload = function\(e\)[\s\S]*aplicarImagemSelecionada\(e\.target\.result\)/);
    assert.match(html, /addEventListener\('touchmove'[\s\S]*pinchStartScale \* \(d \/ pinchStartDistance\)/);
    assert.match(html, /function ajustarZoomFoto\(direcao, event\)/);
    assert.match(html, /function centralizarFoto\(event\)/);
    assert.match(html, /event\?\.target\?\.closest\('#interactiveContainer, #photoEditControls'\)/);
});

test('recorte final preserva zoom e posição escolhidos pelo usuário', () => {
    assert.match(html, /const drawWidth = thumb\.naturalWidth \* currentScale \* outputRatio/);
    assert.match(html, /const drawX = 200 \+ \(imgX \* outputRatio\) - \(drawWidth \/ 2\)/);
    assert.match(html, /ctx\.drawImage\(thumb, drawX, drawY, drawWidth, drawHeight\)/);
});

test('menu da conta esconde o email no celular e expõe ações reais', () => {
    assert.match(html, /id="userDrawer"/);
    assert.match(html, /\.user-email-label \{ display: none; \}/);
    assert.match(html, /function abrirPlanosPeloMenu\(\)/);
    assert.match(html, /function abrirAfiliadosPeloMenu\(\)/);
});

test('links do FaceCheck aceitam MaskedUrl e são criados sem onclick inline', () => {
    assert.match(html, /typeof valor\.value === 'string'/);
    assert.match(html, /function resolverUrlResultado\(item\)/);
    assert.match(html, /avatarLink\.rel = 'noopener noreferrer'/);
    assert.match(html, /botaoAcesso\.rel = 'noopener noreferrer'/);
    assert.doesNotMatch(html, /window\.open\('\$\{urlJsSeguro\}/);
});
