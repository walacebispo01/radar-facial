'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { mountSeo } = require('../lib/seo');

test('SEO: sitemap público e noindex privado, incluindo URLs com parâmetros', async t => {
    const app = express();
    mountSeo(app);
    app.use((req, res) => res.send('test'));
    const server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    t.after(() => new Promise(resolve => server.close(resolve)));
    const base = `http://127.0.0.1:${server.address().port}`;
    const sitemap = await fetch(base + '/sitemap.xml');
    assert.match(sitemap.headers.get('content-type'), /application\/xml/);
    const xml = await sitemap.text();
    assert.deepEqual([...xml.matchAll(/<loc>(.*?)<\/loc>/g)].map(match => match[1]),
        ['https://radarfacial.com.br/', 'https://radarfacial.com.br/provas-sociais']);
    const robots = await (await fetch(base + '/robots.txt')).text();
    assert.match(robots, /Sitemap: https:\/\/radarfacial.com.br\/sitemap.xml/);
    assert.doesNotMatch(robots, /Disallow:/);
    for (const route of ['/painel', '/PAINEL/', '/teste/', '/convite?token=private', '/pagamento?receipt=private', '/api/session', '/API/session', '/api/criadores']) {
        assert.equal((await fetch(base + route)).headers.get('x-robots-tag'), 'noindex, nofollow', route);
    }
    for (const route of ['/', '/?ref=creator', '/provas-sociais', '/checkout.js']) {
        assert.equal((await fetch(base + route)).headers.get('x-robots-tag'), null, route);
    }
});
