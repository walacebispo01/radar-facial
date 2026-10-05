# SEO do Radar Facial

## Implementação

- Página inicial com título, descrição, canonical, Open Graph e dados estruturados de Organization/WebSite, sem avaliações ou estatísticas inventadas.
- Conteúdo em HTML, disponível sem executar JavaScript: funcionamento, qualidade da foto, limites da cobertura, créditos e perguntas frequentes.
- Página de vídeos com descrição e canonical próprios.
- `/robots.txt` permite rastreamento e informa `/sitemap.xml`.
- Sitemap contém somente a página inicial e `/provas-sociais`, sem parâmetros de indicação, recibos, fotos ou informações de usuários.
- `X-Robots-Tag: noindex, nofollow` em painel, teste, convite, retorno de pagamento e APIs. As páginas privadas não são bloqueadas no robots.txt, para permitir a leitura do noindex. Autenticação continua sendo a proteção de acesso.
- Não altera créditos, pacotes, pagamentos, comissões ou consentimento de métricas.

## Publicação e acompanhamento

Após o deploy, conferir os metadados da página inicial, o sitemap e os headers das páginas privadas. Confirmar no Render o commit exato, além da resposta HTTP.

Cadastrar a propriedade de prefixo `https://radarfacial.com.br/` no Search Console com autorização do proprietário. Verificar a propriedade; o Analytics com consentimento pode impedir a verificação automática, então pode ser necessário o método de tag HTML fornecido pelo Google.

Enviar `https://radarfacial.com.br/sitemap.xml` e inspecionar a página inicial. Solicitar indexação quando a inspeção permitir. O envio não garante indexação nem posição nas buscas.

Usar o Search Console para identificar consultas, impressões, cliques e problemas de indexação. Priorizar novos conteúdos conforme buscas reais. Esta etapa não inclui pesquisa de volume de palavras-chave nem auditoria completa de Core Web Vitals.

Referências: https://developers.google.com/search/docs/fundamentals/seo-starter-guide e https://developers.google.com/search/docs/crawling-indexing/block-indexing.
