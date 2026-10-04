# InfinitePay — preparação da integração

Estado: fluxo implementado localmente na branch `feat/infinitepay-checkout`, com pedidos, checkout, retorno, confirmação, créditos e snapshots de comissões. Não publicado nem ativado em produção. Nenhuma cobrança real realizada.

Conta recebedora confirmada pelo usuário em 2026-10-04: Igor Alencar de Godoy; InfiniteTag público `igor-alencar-de-255`, sem `$`. No painel da InfinitePay, Checkout Integrado aparece habilitado para Cartão e Pix. A etapa de endereço também está habilitada e não foi alterada.

Fonte: https://www.infinitepay.io/checkout-documentacao (consultada em 2026-10-04).

## Confirmações pendentes

- Decisão mais recente do usuário em 2026-10-04: publicar a troca de checkout agora e deixar o controle de estornos para a próxima atualização. Devoluções serão realizadas manualmente na InfinitePay; ainda não há controle de conciliação manual no Radar, nem detecção automática. As comissões de vendas devolvidas não serão corrigidas automaticamente nesse intervalo. Não tratar esta publicação como conclusão dessa pendência.
- Confirmar aceitação do serviço e como consultar ou receber eventos confiáveis de estorno, cancelamento e chargeback. A documentação consultada descreve aprovação e `paid`, mas não estabelece os eventos reversos necessários ao livro de comissões. `paid=false` não comprova um estorno.

### Informação necessária da InfinitePay para o automático

A página oficial https://www.infinitepay.io/desenvolvedores direciona à documentação do checkout e informa `parcerias@cloudwalk.io` para dúvidas de integração. As duas páginas foram revistas em 2026-10-04; não foi localizado nelas um contrato de estorno. Não concluir que a funcionalidade inexiste: ela pode exigir orientação ou acesso específico do provedor.

Pergunta para o suporte técnico: "No Checkout Integrado, qual API ou webhook informa estorno total, parcial e chargeback? Precisamos do vínculo com order_nsu/transaction_nsu, valor devolvido e status definitivo. Como autenticar essa informação, repetir consultas/eventos perdidos e impedir duplicações? O payment_check permanece paid=true após uma devolução?"

Após obter esse contrato, implementar a consulta/evento oficial, com validação da conta/pedido, persistência idempotente e ajustes cumulativos de comissões usando o snapshot já existente. Reconciliação deve continuar mesmo se novas compras voltarem ao Mercado Pago. Uma contestação aberta não deve ser confundida com perda definitiva. Falha de consulta ou paid=false não autoriza reversão financeira.

Não criar endpoints ou interpretar campos de reembolso que o provedor não documentou. Nenhuma mensagem foi enviada ao suporte, nenhum estorno real foi iniciado e nenhum automático foi ativado. A regra para créditos já consumidos ainda precisa ser definida separadamente.

## Implementado e pendências

1. Pedidos próprios persistidos antes de criar links; catálogo e quantidade obtidos no servidor. Persistir conta recebedora e identificadores por pedido para não alterar vendas antigas ao trocar configurações.
2. Idempotência por usuário/pedido e associação única de comprovante para impedir duplicação de créditos ou uso do mesmo pagamento em pedidos diferentes.
3. Webhook e retorno do cliente consultam `payment_check` com os dados do pedido persistido. Nunca liberar crédito só com parâmetros da URL ou payload de webhook. Conferir valor em centavos e identidade do pedido/conta.
4. Atualizar crédito, pagamento e comissões em transação, usando os snapshots existentes da rede. Namespace próprio para IDs InfinitePay; manter confirmação e estorno dos pagamentos Mercado Pago antigos.
5. PENDENTE: reversões InfinitePay não estão implementadas. Precisam de status verificável ou de conciliação administrativa auditada, inclusive após desligar o novo checkout. Ativar agora poderia manter disponíveis comissões de vendas estornadas. Nenhum repasse automático habilitado.
6. Tela de compra redireciona ao checkout e retorna a uma confirmação no site. Não prometer aprovação por ter retornado ao site.
7. Testados localmente: pedidos repetidos, comprovantes reutilizados, callbacks forjados, falhas externas, pedido de outro usuário, CSRF, fila/snapshot de comissões e confirmação durante retorno ao checkout anterior. PGlite serializa transações e não comprova MVCC no Neon. A API externa é simulada. Falta validação real; pagamento ou estorno real exige autorização específica.

## Publicação autorizada com controle de estornos adiado

1. Conferir recuperação do Neon e aplicar apenas `npm run migrate:checkout` (006, transação e registro de hash; não altera migrações anteriores).
2. Publicar primeiro com `CHECKOUT_PROVIDER=mercadopago`; confirmar commit exato Live no Render.
3. Configurar `INFINITEPAY_HANDLE=igor-alencar-de-255` e então `CHECKOUT_PROVIDER=infinitepay` no serviço `radar-facial-api`.
4. Validar compra, retorno, webhook, créditos e comissões. Estornos dependem da pendência acima.
5. Para voltar novas compras ao Mercado Pago, mudar apenas `CHECKOUT_PROVIDER`. Manter código/tabela InfinitePay para confirmar pagamentos em andamento. Manter segredo e rotas Mercado Pago para vendas antigas.

## Adaptador preparado

`lib/infinitepay-client.js` chama apenas os dois endpoints documentados, com timeout e sem redirecionamentos HTTP. Não envia dados pessoais de clientes. Aceita checkout apenas em hosts InfinitePay conhecidos e exige confirmação booleana e valor exato do pedido. Não cria pagamentos ao carregar o módulo; os testes usam respostas simuladas.
