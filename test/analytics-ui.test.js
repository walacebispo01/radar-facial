'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { validContext } = require('../lib/ga4');
test('GA4: consentimento, URLs sem dados privados e ausência de pixel antes da autorização', async () => {
    assert.equal(validContext({ consent: false, clientId: '123.456', sessionId: 123 }), null);
    assert.equal(validContext({ consent: true, clientId: 'buyer@example.com', sessionId: 123 }), null);
    assert.equal(validContext({ consent: true, clientId: '123.456', sessionId: -1 }), null);
    for (const consent of ['denied', 'granted']) {
        const scripts = [], events = [];
        const element = () => ({ style: {}, append() {}, setAttribute() {}, addEventListener() {} });
        const dataLayer = [];
        dataLayer.push = (...args) => {
            for (const item of args) {
                events.push(Array.from(item));
                if (item[0] === 'get') item[3](item[2] === 'client_id' ? '123.456' : 456);
                if (item[0] === 'event' && item[2]?.event_callback) item[2].event_callback();
            }
        };
        const context = { URL, URLSearchParams, AbortSignal, Event, setTimeout, clearTimeout, Date,
            location: { origin: 'https://radarfacial.com.br', search: '?email=private@example.com&slug=secret&ref=private&utm_source=tiktok' },
            navigator: {}, localStorage: { getItem: () => consent },
            fetch: async () => ({ json: async () => ({ measurementId: 'G-TEST123456' }) }),
            document: { referrer: 'https://example.test/private?email=private@example.com', createElement: element,
                body: { append() {} }, head: { append: script => scripts.push(script) } }, dataLayer };
        context.window = context;
        vm.runInNewContext(fs.readFileSync(require.resolve('../public/analytics.js'), 'utf8'), context);
        const visit = await context.RadarAnalytics.context();
        if (consent === 'denied') { assert.equal(visit, null); assert.equal(scripts.length, 0); assert.equal(events.length, 0); }
        else {
            assert.equal(visit.clientId, '123.456'); assert.equal(visit.sessionId, 456);
            assert.equal(scripts.length, 1);
            assert.ok(!JSON.stringify(events).includes('private'));
            assert.ok(!JSON.stringify(events).includes('secret'));
            await context.RadarAnalytics.beginCheckout({ item_id: 'avulso', price: 12.99, quantity: 1 });
            assert.equal(events.filter(event => event[0] === 'event' && event[1] === 'begin_checkout').length, 1);
            assert.equal(events.filter(event => event[0] === 'event' && event[1] === 'purchase').length, 0);
        }
    }
});
