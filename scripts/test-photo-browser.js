const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const express = require('express');
const app = express();
const root = path.join(__dirname, '..');
const fixture = process.env.PHOTO_TEST_IMAGE;
if (!fixture || !fs.existsSync(fixture)) throw new Error('Defina PHOTO_TEST_IMAGE com uma foto frontal de teste.');
const output = process.env.BROWSER_TEST_OUTPUT || path.join(root, 'test-results');
fs.mkdirSync(output, { recursive: true });
require('../lib/photo-assets')(app);
app.get('/', (req, res) => res.sendFile(path.join(root, 'index.html')));
app.get('/auth.js', (req, res) => res.sendFile(path.join(root, 'public/auth.js')));
app.get('/creator-demo.js', (req, res) => res.sendFile(path.join(root, 'public/creator-demo.js')));
app.get('/api/programa/me', (req, res) => res.json({ success: true, enabled: false }));
app.get('/api/session', (req, res) => res.json({ success: true, email: 'teste@example.test', creditos: 5, isAdmin: false, csrfToken: 'test' }));
app.get('/fixture.jpg', (req, res) => res.sendFile(fixture));

(async () => {
    const server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    const base = 'http://127.0.0.1:' + server.address().port;
    const browser = await chromium.launch({ channel: 'chrome', headless: true });
    const findings = [];
    try {
        for (const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 844 }]) {
            const context = await browser.newContext({ viewport });
            const searchKeys = [];
            // No third-party requests: real local model, fake session and fake paid search only.
            await context.route('**/*', async route => {
                if (!route.request().url().startsWith(base)) return route.abort();
                if (route.request().url().endsWith('/api/escanear-rosto')) {
                    searchKeys.push(route.request().headers()['idempotency-key']);
                    if (searchKeys.length === 1) return route.abort('failed');
                    return route.fulfill({ json: { success: true, items: [], creditos: 4 } });
                }
                return route.continue();
            });
            const page = await context.newPage();
            const errors = [];
            page.on('pageerror', error => errors.push(error.message));
            page.on('dialog', dialog => dialog.dismiss());
            await page.goto(base);
            await page.waitForFunction(() => usuarioEmail === 'teste@example.test');
            await page.locator('#imageInput').setInputFiles(fixture);
            await page.waitForFunction(() => !photoLoading && document.getElementById('draggableThumb').naturalWidth > 0);
            // Centre the public fixture's face, as a user would with drag + zoom.
            await page.evaluate(async () => {
                const mesh = await RadarFaceLandmarks.detect(capturarImagemFinalCirculo());
                const xs = mesh.points.map(p => p.x), ys = mesh.points.map(p => p.y);
                const left = Math.min(...xs), right = Math.max(...xs), top = Math.min(...ys), bottom = Math.max(...ys);
                const zoom = Math.min(3, 0.65 / Math.max(right - left, bottom - top));
                imgX = zoom * (imgX - ((left + right) / 2 - 0.5) * photoViewport) + 7;
                imgY = zoom * (imgY - ((top + bottom) / 2 - 0.5) * photoViewport) + 6;
                currentScale *= zoom;
                atualizarTransformacaoImagem();
            });
            const before = await page.evaluate(() => capturarImagemFinalCirculo());
            await page.setViewportSize({ width: viewport.width === 390 ? 430 : 1000, height: viewport.height });
            await page.waitForTimeout(500);
            const after = await page.evaluate(() => capturarImagemFinalCirculo());
            // Pixel compare allows fractional rasterization differences at subpixel boundaries.
            const resizeError = await page.evaluate(async ({ before, after }) => {
                const load = async src => { const img = new Image(); img.src = src; await img.decode(); const c = document.createElement('canvas'); c.width = c.height = 400; const ctx = c.getContext('2d'); ctx.drawImage(img, 0, 0); return ctx.getImageData(0, 0, 400, 400).data; };
                const a = await load(before), b = await load(after);
                return a.reduce((sum, v, i) => sum + Math.abs(v - b[i]), 0) / a.length;
            }, { before, after });
            assert.ok(resizeError < 1, 'Resize changed crop: ' + resizeError);
            await page.locator('#scanBtn').click();
            await page.waitForFunction(() => document.getElementById('faceMeshOverlay').style.display === 'block' || (!photoBusy && document.getElementById('photoFeedback').textContent), { timeout: 45000 });
            const scanState = await page.evaluate(() => ({ busy: photoBusy, points: detectedMesh?.points.length,
                message: document.getElementById('photoFeedback').textContent, frozen: preparedPhoto }));
            assert.ok(scanState.busy, 'Real model failed: ' + scanState.message);
            assert.ok(scanState.points > 50);
            await page.waitForFunction(() => parseFloat(document.getElementById('progressFill').style.width) >= 65);
            await page.screenshot({ path: path.join(output, 'escaneamento-' + viewport.width + '.png'), fullPage: true });
            await page.waitForFunction(() => document.getElementById('resultsSection').style.display === 'block');
            assert.equal(await page.locator('.result-avatar-img').getAttribute('src'), scanState.frozen);
            assert.equal(await page.evaluate(() => capturarImagemFinalCirculo()), scanState.frozen, 'Hidden viewport must use frozen image');
            assert.equal(await page.getByText('Foto pronta para pesquisa', { exact: false }).count(), 1);
            assert.equal(await page.getByText('98.5%', { exact: true }).count(), 0);
            assert.equal(await page.locator('.result-avatar-img').evaluate(el => getComputedStyle(el).filter), 'none');
            await page.waitForTimeout(450);
            await page.screenshot({ path: path.join(output, 'previa-' + viewport.width + '.png'), fullPage: true });
            const requestPromise = page.waitForRequest('**/api/escanear-rosto');
            await page.locator('#btnDesbloquearPrevia').click();
            const request = await requestPromise;
            const uploaded = request.postDataBuffer();
            const jpeg = Buffer.from(scanState.frozen.split(',')[1], 'base64');
            assert.ok(uploaded.includes(jpeg), 'Uploaded JPEG differs from preview/detection');
            await page.waitForFunction(() => !document.getElementById('btnDesbloquearPrevia').disabled);
            await page.locator('#btnDesbloquearPrevia').click();
            await page.waitForFunction(() => document.getElementById('resultsGridContainer').textContent.includes('Nenhum perfil'));
            assert.equal(searchKeys.length, 2);
            assert.equal(searchKeys[0], searchKeys[1], 'Network retry must preserve the idempotency key');
            await page.screenshot({ path: path.join(output, 'resultado-' + viewport.width + '.png'), fullPage: true });

            // Actual model rejects a non-face; must recover editable controls and not charge.
            await page.evaluate(() => {
                voltarParaInicio();
                const canvas = document.createElement('canvas'); canvas.width = canvas.height = 400;
                const ctx = canvas.getContext('2d'); ctx.fillStyle = 'white'; ctx.fillRect(0, 0, 400, 400);
                aplicarImagemSelecionada(canvas.toDataURL());
            });
            await page.waitForFunction(() => !photoLoading);
            await page.locator('#scanBtn').click();
            await page.waitForFunction(() => !photoBusy);
            assert.match(await page.locator('#photoFeedback').innerText(), /Não encontramos um rosto/);
            assert.equal(await page.locator('#scanBtn').isEnabled(), true);
            assert.equal(await page.evaluate(() => preparedPhoto), null);
            // Error loading the model must not show invented landmarks or leave the button locked.
            await page.locator('#imageInput').setInputFiles(fixture);
            await page.waitForFunction(() => !photoLoading);
            await page.evaluate(async () => {
                const original = RadarFaceLandmarks.detect;
                RadarFaceLandmarks.detect = async () => { throw new Error('MODEL_TIMEOUT'); };
                await clicarProcurar();
                RadarFaceLandmarks.detect = original;
            });
            assert.match(await page.locator('#photoFeedback').innerText(), /Não foi possível carregar/);
            assert.equal(await page.locator('#scanBtn').isEnabled(), true);
            // Cancel pending async detection: a stale result must never reopen results.
            await page.locator('#imageInput').setInputFiles(fixture);
            await page.waitForFunction(() => !photoLoading);
            await page.evaluate(() => {
                const original = RadarFaceLandmarks.detect;
                RadarFaceLandmarks.detect = data => new Promise(resolve => setTimeout(() => resolve(original(data)), 300));
                clicarProcurar(); voltarParaInicio();
            });
            await page.waitForTimeout(800);
            assert.equal(await page.evaluate(() => photoBusy), false);
            assert.equal(await page.locator('#resultsSection').isVisible(), false);
            assert.deepEqual(errors, []);
            findings.push({ viewport, resizeError, points: scanState.points,
                frozenPreviewEqualsUpload: true, idempotentRetry: true, noFaceRecovery: true, modelFailureRecovery: true, cancellation: true });
            await context.close();
        }
        fs.writeFileSync(path.join(output, 'photo-browser-results.json'), JSON.stringify(findings, null, 2));
        console.log(JSON.stringify(findings, null, 2));
    } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
