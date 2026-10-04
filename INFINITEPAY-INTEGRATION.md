# InfinitePay — preparação da integração

Estado: fluxo implementado localmente na branch `feat/infinitepay-checkout`, com pedidos, checkout, retorno, confirmação, créditos e snapshots de comissões. Não publicado nem ativado em produção. Nenhuma cobrança real realizada.

Conta recebedora confirmada pelo usuário em 2026-10-04: Igor Alencar de Godoy; InfiniteTag público `igor-alencar-de-255`, sem `$`. No painel da InfinitePay, Checkout Integrado aparece habilitado para Cartão e Pix. A etapa de endereço também está habilitada e não foi alterada.

Fonte: https://www.infinitepay.io/checkout-documentacao (consultada em 2026-10-04).

## Confirmações pendentes

- Confirmar aceitação do serviço e como consultar ou receber eventos confiáveis de estorno, cancelamento e chargeback. A documentação consultada descreve aprovação e `paid`, mas não estabelece os eventos reversos necessários ao livro de comissões. `paid=false` não comprova um estorno.

## Implementado e pendências

1. Pedidos próprios persistidos antes de criar links; catálogo e quantidade obtidos no servidor. Persistir conta recebedora e identificadores por pedido para não alterar vendas antigas ao trocar configurações.
2. Idempotência por usuário/pedido e associação única de comprovante para impedir duplicação de créditos ou uso do mesmo pagamento em pedidos diferentes.
3. Webhook e retorno do cliente consultam `payment_check` com os dados do pedido persistido. Nunca liberar crédito só com parâmetros da URL ou payload de webhook. Conferir valor em centavos e identidade do pedido/conta.
4. Atualizar crédito, pagamento e comissões em transação, usando os snapshots existentes da rede. Namespace próprio para IDs InfinitePay; manter confirmação e estorno dos pagamentos Mercado Pago antigos.
5. PENDENTE: reversões InfinitePay não estão implementadas. Precisam de status verificável ou de conciliação administrativa auditada, inclusive após desligar o novo checkout. Ativar agora poderia manter disponíveis comissões de vendas estornadas. Nenhum repasse automático habilitado.
6. Tela de compra redireciona ao checkout e retorna a uma confirmação no site. Não prometer aprovação por ter retornado ao site.
7. Testados localmente: pedidos repetidos, comprovantes reutilizados, callbacks forjados, falhas externas, pedido de outro usuário, CSRF, fila/snapshot de comissões e confirmação durante retorno ao checkout anterior. PGlite serializa transações e não comprova MVCC no Neon. A API externa é simulada. Falta validação real; pagamento ou estorno real exige autorização específica.

## Publicação depois de resolver as pendências

1. Conferir recuperação do Neon e aplicar apenas `npm run migrate:checkout` (006, transação e registro de hash; não altera migrações anteriores).
2. Publicar primeiro com `CHECKOUT_PROVIDER=mercadopago`; confirmar commit exato Live no Render.
3. Configurar `INFINITEPAY_HANDLE=igor-alencar-de-255` e então `CHECKOUT_PROVIDER=infinitepay` no serviço `radar-facial-api`.
4. Validar compra, retorno, webhook, créditos e comissões. Estornos dependem da pendência acima.
5. Para voltar novas compras ao Mercado Pago, mudar apenas `CHECKOUT_PROVIDER`. Manter código/tabela InfinitePay para confirmar pagamentos em andamento. Manter segredo e rotas Mercado Pago para vendas antigas.

## Adaptador preparado

`lib/infinitepay-client.js` chama apenas os dois endpoints documentados, com timeout e sem redirecionamentos HTTP. Não envia dados pessoais de clientes. Aceita checkout apenas em hosts InfinitePay conhecidos e exige confirmação booleana e valor exato do pedido. Não cria pagamentos ao carregar o módulo; os testes usam respostas simuladas.
