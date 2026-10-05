'use strict';

const ORIGIN = 'https://radarfacial.com.br';
const PUBLIC_PAGES = ['/', '/provas-sociais'];
const PRIVATE_PAGES = ['/painel', '/teste', '/convite', '/pagamento'];

function mountSeo(app) {
    app.use((req, res, next) => {
        const route = req.path.toLowerCase().replace(/\/+$/, '') || '/';
        if (PRIVATE_PAGES.includes(route) || route === '/api' || route.startsWith('/api/')) {
            res.set('X-Robots-Tag', 'noindex, nofollow');
        }
        next();
    });
    app.get('/robots.txt', (_, res) => {
        // Crawling must remain allowed for Google to read private pages' noindex headers.
        res.type('text/plain').send(`User-agent: *\nAllow: /\n\nSitemap: ${ORIGIN}/sitemap.xml\n`);
    });
    app.get('/sitemap.xml', (_, res) => {
        res.type('application/xml').send('<?xml version="1.0" encoding="UTF-8"?>\n' +
            '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
            PUBLIC_PAGES.map(route => `  <url><loc>${ORIGIN}${route}</loc></url>`).join('\n') +
            '\n</urlset>\n');
    });
}

module.exports = { mountSeo };
