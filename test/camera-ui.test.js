const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

test('oferece upload e captura de foto como fontes separadas', () => {
    assert.match(html, /Carregar foto/);
    assert.match(html, /Tirar foto agora/);
    assert.match(html, /id="imageInput"[^>]+accept="image\/\*"/);
    assert.match(html, /id="cameraPreview"[^>]+autoplay[^>]+playsinline/);
});

test('a câmera só é solicitada no fluxo explícito e é encerrada', () => {
    assert.match(html, /async function abrirCamera\(\)/);
    assert.match(html, /navigator\.mediaDevices\.getUserMedia/);
    assert.match(html, /audio:\s*false/);
    assert.match(html, /cameraStream\.getTracks\(\)\.forEach\(track => track\.stop\(\)\)/);
    assert.match(html, /addEventListener\('pagehide', pararCamera\)/);
});

test('captura da câmera reutiliza o mesmo fluxo de prévia da imagem carregada', () => {
    assert.match(html, /canvas\.toDataURL\('image\/jpeg', 0\.9\)/);
    assert.match(html, /aplicarImagemSelecionada\(foto\)/);
    assert.match(html, /reader\.onload = function\(e\)[\s\S]*aplicarImagemSelecionada\(e\.target\.result\)/);
});
