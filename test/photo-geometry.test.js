const { test } = require('node:test');
const assert = require('node:assert/strict');
const geometry = require('../public/photo-geometry');

test('recorte preserva proporção e centraliza foto horizontal', () => {
    assert.deepEqual(geometry.crop({ width: 800, height: 400, viewport: 200 }),
        { x: -200, y: 0, width: 800, height: 400 });
});

test('zoom e deslocamento determinam a região exata enviada', () => {
    assert.deepEqual(geometry.crop({ width: 800, height: 400, viewport: 200, scale: 1, x: 75, y: -40 }),
        { x: -450, y: -280, width: 1600, height: 800 });
});

test('não permite arrastar o rosto para fora deixando área vazia', () => {
    const frame = geometry.frame({ width: 400, height: 800, viewport: 200, scale: 0.5, x: 900, y: -900 });
    assert.equal(frame.x, 0);
    assert.equal(frame.y, -100);
});

test('mudança de orientação/tamanho mantém a região pesquisada', () => {
    const original = { width: 1600, height: 900, viewport: 216, scale: 0.4, x: 48, y: -20 };
    const resized = { ...original, ...geometry.resize(original, 180) };
    const before = geometry.crop(original), after = geometry.crop(resized);
    for (const key of Object.keys(before)) assert.ok(Math.abs(before[key] - after[key]) < 1e-9, key);
});

test('rejeita imagem ainda não carregada e limita zoom', () => {
    assert.throws(() => geometry.crop({ width: 0, height: 0, viewport: 200 }));
    assert.throws(() => geometry.crop({ width: 400, height: 400, viewport: 0 }));
    const frame = geometry.frame({ width: 400, height: 400, viewport: 200, scale: 200 });
    assert.equal(frame.scale, 3);
});
