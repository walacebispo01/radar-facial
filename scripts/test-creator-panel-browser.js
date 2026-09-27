const { chromium } = require('playwright');
const express = require('express');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

(async () => {
    const app = express();
    app.use(express.json());
    app.use(express.static(path.join(__dirname, '../public')));
    const output = process.env.BROWSER_TEST_OUTPUT || path.join(__dirname, '../test-results/panel');
    fs.mkdirSync(output, { recursive: true });
    let unlocked = false;
    let tries = 0;
    const keys = [];
    const creator = { id: '1', nome: 'Criador <img src=x onerror=alert(1)>', email: 'teste@example.test', afiliado_codigo: 'CODE', status: 'ativo', demo_enabled: true, percentual: 10, depth: 0 };
    app.get('/api/session', (req, res) => res.json({ email: creator.email, csrfToken: 't' }));
    app.get('/api/programa/me', (req, res) => res.json({ success: true, isAdmin: true, creator }));
    app.get('/api/programa/comissoes', (req, res) => res.json({ success: true, items: [{ payment_id: '123456789', criador_id: '1', criador_nome: creator.nome, parcela: 'vendedor', tipo: 'comissao', valor: '7.000000', criado_em: '2026-09-27T01:00:00Z', status: 'approved', nivel: 0 }], total: 1, page: 1, totals: { comissao: '7', estorno: '0', saldo: '7' } }));
    app.get('/api/programa/admin/criadores', (req, res) => res.json({ success: true, items: [creator], page: 1, total: 1 }));
    app.get('/api/programa/rede/:id', (req, res) => res.json({ success: true, items: [creator], page: 1, total: 1 }));
    app.get('/api/programa/cenarios', (req, res) => res.json({ success: true, items: [] }));
    app.post('/api/programa/admin/verificar', (req, res) => { unlocked = true; res.json({ success: true }); });
    app.post('/api/programa/admin/criadores/:id/creditos', (req, res) => {
        keys.push(req.headers['idempotency-key']);
        if (!unlocked) return res.status(403).json({ code: 'STEP_UP_REQUIRED' });
        if (tries++ === 0) return res.status(503).json({ error: 'Falha temporária' });
        res.json({ success: true, creditos: 3 });
    });
    const server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    const browser = await chromium.launch({ channel: 'chrome', headless: true });
    try {
        for (const width of [1280, 390]) {
            const page = await browser.newPage({ viewport: { width, height: 900 } });
            const errors = [];
            page.on('pageerror', error => errors.push(error.message));
            await page.goto('http://127.0.0.1:' + server.address().port + '/creator-panel.html');
            await page.locator('#commission-list tbody').waitFor();
            assert.match(await page.locator('#metrics').innerText(), /7,00/);
            assert.equal(await page.locator('img').count(), 0, 'Remote names must remain plain text.');
            assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Panel must fit viewport.');
            await page.screenshot({ path: path.join(output, 'panel-commissions-' + width + '.png'), fullPage: true });
            await page.locator('[data-tab=creators]').click();
            await page.getByRole('button', { name: 'Gerenciar', exact: true }).click();
            const form = page.locator('#detail form').nth(1);
            await form.locator('[name=quantidade]').fill('3');
            await form.locator('[name=motivo]').fill('Teste de repetição');
            await page.screenshot({ path: path.join(output, 'panel-admin-' + width + '.png'), fullPage: true });
            if (width === 1280) {
                await form.getByRole('button', { name: 'Liberar créditos', exact: true }).click();
                await page.locator('#stepup').waitFor({ state: 'visible' });
                await page.locator('#totp').fill('123456');
                await page.getByRole('button', { name: 'Confirmar acesso', exact: true }).click();
                await page.locator('#detail').waitFor({ state: 'visible' });
                assert.equal(await form.locator('[name=quantidade]').inputValue(), '3', 'Step-up must preserve draft.');
                await form.getByRole('button', { name: 'Liberar créditos', exact: true }).click();
                await page.getByText('Falha temporária', { exact: true }).waitFor();
                await form.getByRole('button', { name: 'Liberar créditos', exact: true }).click();
                await page.getByText('Créditos liberados. Saldo: 3.', { exact: true }).waitFor();
                assert.equal(new Set(keys).size, 1, 'Retries must reuse one idempotency key.');
            }
            assert.equal(errors.length, 0);
            await page.locator('#close-detail').click();
            await page.locator('[data-tab=scenarios]').click();
            await page.getByText('Salve seu primeiro cenário para preparar uma gravação.').waitFor();
            assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
            await page.close();
        }
        console.log('PASS panel desktop/mobile: BRL metrics, safe text, responsive layout, TOTP preserves draft, idempotent credit retry, scenarios.');
    } finally {
        await browser.close();
        server.close();
    }
})().catch(error => { console.error(error); process.exit(1); });
