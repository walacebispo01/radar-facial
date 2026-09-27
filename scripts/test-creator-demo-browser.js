const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const { chromium } = require('playwright');
const root = path.join(__dirname, '..');
const output = process.env.BROWSER_TEST_OUTPUT || path.join(root, 'test-results');
fs.mkdirSync(output, { recursive: true });
const app = express();
app.get('/', (_, res) => res.sendFile(path.join(root, 'index.html')));
for (const file of ['auth.js', 'creator-demo.js', 'photo-geometry.js', 'face-landmarks.js']) {
    app.get('/' + file, (_, res) => res.sendFile(path.join(root, 'public', file)));
}
(async () => {
    const server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    const base = 'http://127.0.0.1:' + server.address().port;
    const browser = await chromium.launch({ channel: 'chrome', headless: true });
    const results = [];
    try {
        for (const width of [390, 1280]) {
            const context = await browser.newContext({ viewport: { width, height: 900 } });
            let authorized = true, executed = 0, paid = 0, delay = false;
            let release;
            const requests = [];
            await context.route('**/*', async route => {
                const url = new URL(route.request().url());
                if (!url.href.startsWith(base)) return route.abort();
                requests.push(url.pathname);
                if (url.pathname === '/api/session') return route.fulfill({ json: { email: 'criador@example.test', creditos: 0, csrfToken: 'test' } });
                if (url.pathname === '/api/programa/me') return route.fulfill({ json: { success: true, enabled: true,
                    creator: authorized ? { id: 'creator-1', status: 'ativo', demo_enabled: true } : null } });
                if (url.pathname.endsWith('/executar')) {
                    executed++;
                    assert.equal(route.request().headers()['x-csrf-token'], 'test');
                    assert.equal(route.request().headers()['content-type'], 'application/json');
                    assert.equal(route.request().postData(), '{}');
                    if (delay) await new Promise(resolve => { release = resolve; });
                    return route.fulfill({ json: { success: true, execution_id: 'sim-1', items: [{ title: '<script>unsafe</script>', url: 'https://instagram.com/example' }] } });
                }
                if (url.pathname === '/api/escanear-rosto') { paid++; return route.fulfill({ status: 500 }); }
                return route.continue();
            });
            const page = await context.newPage();
            const errors = [];
            page.on('pageerror', error => errors.push(error.message));
            async function prepare() {
                await page.goto(base + '/?cenario=private-scenario');
                await page.waitForFunction(() => usuarioEmail && RadarCreatorDemo.enabled());
                await page.evaluate(() => {
                    // This integration test stubs only detection; the photo test exercises the real model.
                    RadarFaceLandmarks.detect = async () => ({ points: [{ id: 1, x: .5, y: .5 }], connections: [] });
                    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 400;
                    canvas.getContext('2d').fillRect(0, 0, 400, 400);
                    aplicarImagemSelecionada(canvas.toDataURL());
                });
                await page.waitForFunction(() => !photoLoading);
            }
            await prepare();
            assert.equal(await page.locator('#creatorPanelBtn').count(), 1);
            await page.locator('#scanBtn').click();
            await page.waitForFunction(() => document.querySelector('.social-access-btn'));
            assert.equal(executed, 1);
            assert.equal(paid, 0);
            assert.equal(await page.locator('.social-access-btn').getAttribute('href'), 'https://instagram.com/example');
            assert.equal(await page.locator('.username-blur-text').innerText(), '<script>unsafe</script>');
            assert.equal(await page.locator('#btnDesbloquearPrevia').count(), 0);
            assert.equal(await page.evaluate(() => saldoCreditos), 0);
            assert.equal(await page.locator('.match-badge-tag').count(), 0);
            await page.screenshot({ path: path.join(output, 'cenario-' + width + '.png'), fullPage: true });

            // A scenario URL on an ordinary account must never fall back to a paid search.
            authorized = false;
            await prepare();
            await page.locator('#scanBtn').click();
            await page.waitForFunction(() => !photoBusy);
            assert.match(await page.locator('#photoFeedback').innerText(), /não está disponível/);
            assert.equal(executed, 1);
            assert.equal(await page.locator('#creatorPanelBtn').isVisible(), false);
            // Navigation cancels rendering a response already in flight.
            authorized = true; delay = true;
            await prepare();
            await page.locator('#scanBtn').click();
            await page.waitForFunction(() => !document.body.classList.contains('focus-mode'));
            while (!release) await new Promise(resolve => setTimeout(resolve, 20));
            await page.evaluate(() => voltarParaInicio());
            release();
            await page.waitForTimeout(150);
            assert.equal(await page.locator('#resultsSection').isVisible(), false);
            assert.equal(paid, 0);
            assert.deepEqual(errors, []);
            results.push({ width, zeroPaidCalls: true, permissionFailureClosed: true, escapedTitles: true, staleResponseIgnored: true });
            await context.close();
        }
        fs.writeFileSync(path.join(output, 'creator-demo-results.json'), JSON.stringify(results, null, 2));
        console.log(JSON.stringify(results, null, 2));
    } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
