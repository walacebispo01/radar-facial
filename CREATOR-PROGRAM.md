# Programa de criadores — operação e arquitetura

Este documento descreve o código preparado localmente. Não comprova execução de migrações, configuração de segredos ou publicação em produção.

## Configuração

- `CREATOR_PROGRAM_ENABLED=false`: desativa interface, administração, novos cadastros e simulação do programa. Não desativa o motor financeiro quando a migração 003 está presente. Use `true` somente na implantação aprovada.
- `ADMIN_EMAILS`: lista administrativa existente, separada do cadastro de criadores.
- `ADMIN_TOTP_SECRETS={}`: objeto JSON que associa cada e-mail administrativo normalizado ao seu segredo TOTP Base32 individual (mínimo de 32 caracteres). Provisione pelo gerenciador de segredos e no aplicativo autenticador. Não coloque segredos reais no repositório. Administrador sem segredo configurado não pode obter a confirmação adicional.
- `MAX_ADMIN_GRANT=1000`: máximo de créditos por concessão administrativa; a quantidade deve ser inteira e positiva.
- `MERCADOPAGO_WEBHOOK_SECRET`: segredo de assinatura do webhook, diferente de `MERCADOPAGO_TOKEN`.

Login Google, sessão e CSRF continuam necessários. Operações administrativas sensíveis exigem confirmação TOTP adicional vinculada à sessão, válida por cinco minutos. O código TOTP usado não pode ser reutilizado. Limites de requisições são persistidos no PostgreSQL.

## Identidade, rede e créditos

O administrador cadastra explicitamente o e-mail do criador. Login isolado não concede essa função. O cadastro cria o usuário quando necessário e vincula um único afiliado existente do mesmo e-mail, ou cria um novo. Mais de um afiliado elegível exige resolver a ambiguidade antes do cadastro. O cadastro explícito ativa o afiliado legado selecionado. O percentual legado de novos afiliados permanece 10% por compatibilidade com o schema anterior; o programa usa `criadores.percentual`.

A raiz tem profundidade 1, limitada a 100. Identidade, e-mail, código do afiliado e ascendência ficam imutáveis no banco. Um pai precisa existir antes do filho. Suspensão impede acesso de criador, simulação e novas concessões; alterações administrativas mantêm uma auditoria com motivo e estado anterior/atual.

Cada concessão de crédito atualiza saldo e auditoria na mesma transação. A chave de idempotência é única: repetir a mesma solicitação não concede novamente; mudar criador, quantidade, motivo ou administrador usando a mesma chave retorna conflito. A resposta de repetição informa o saldo atual, com `saldo_depois` histórico disponível separadamente. Não há transferência bancária automática.

## Regra de comissão

O percentual do vendedor, de 0% a 30%, define a comissão-base sobre o valor da venda. A distribuição confirmada aplica-se a essa base:

| Parcela | Fração da comissão-base | Exemplo com base de R$10 |
| --- | ---: | ---: |
| Criador vendedor | 70% | R$7,00 |
| Indicador direto | 15% | R$1,50 |
| Criador inicial da rede | 5% | R$0,50 |
| Demais níveis, somados | 10% | R$1,00 |

Os demais níveis dividem sua parcela igualmente. O cálculo usa inteiros de milionésimos de real para preservar precisão em redes longas; o resíduo é distribuído em ordem determinística. A apresentação monetária pode arredondar centavos, sem mudar os lançamentos armazenados.

Quando o indicador direto também é a raiz, ele recebe as duas parcelas. Em uma rede com apenas o vendedor, parcelas sem beneficiário ficam retidas. Criador suspenso no snapshot também tem sua parcela retida, com referência ao beneficiário original. Parcelas retidas não aumentam o percentual de outros criadores. Essas regras para redes curtas devem fazer parte da validação comercial antes da ativação.

A transação conserva um snapshot da rede, percentual e distribuição. Alterações futuras do cadastro não recalculam a venda. O registro de eventos permite reprocessar notificações sem duplicar lançamentos. Reembolso parcial gera estorno proporcional cumulativo; reembolso total e chargeback estornam integralmente as parcelas. O cálculo utiliza o snapshot original e desconta estornos anteriores, evitando duplicação. Os identificadores de pagamento e reembolso permitem rastreamento.

O programa não inclui exportação nem pagamento automático. Não confundir saldo de comissão registrado com transferência financeira realizada.

## Simulação

Somente criadores ativos com `demo_enabled=true` podem salvar e executar cenários próprios. Cada cenário aceita de 1 a 20 links HTTP/HTTPS sem credenciais; há até 100 cenários por criador. Títulos devem ser exibidos como texto e links devem continuar sujeitos à validação no cliente.

A execução registra identificador, cenário, criador, instante e itens retornados. Não consulta o provedor de busca facial, não consome crédito e não cria pagamento ou comissão. O painel identifica os cenários de gravação; a página de resultados usa o visual comum, conforme solicitado, e a identificação da simulação será feita na edição do vídeo. Não há reconhecimento para escolher o cenário: o criador seleciona explicitamente um cenário próprio. O histórico administrativo retorna os últimos 100 registros de cada categoria.

## Migrações e implantação

1. Confirme backup restaurável e execute primeiro em banco de homologação. O banco deve ter o schema base existente e `001-sessoes.sql` já aplicados. O novo runner não instala nem presume compatibilidade de um baseline ausente.
2. Mantenha a feature flag desativada. Confira variáveis e segredos no ambiente de destino sem copiá-los para logs ou arquivos de entrega.
3. Execute `npm test` e `npm run check` na versão que será implantada.
4. Execute `npm run migrate:creators` usando a conexão do ambiente pretendido. O runner aplica `002-criadores.sql` e `003-comissoes-rede.sql` sob uma única transação e um bloqueio de migração. Falhar em qualquer uma reverte ambas.
5. O runner registra nome e SHA-256 em `public.programa_migracoes`. Reexecutar com os mesmos arquivos apenas verifica e ignora migrações já aplicadas. Alterar conteúdo de arquivo aplicado é recusado. O hash normaliza CRLF e BOM para não gerar diferença apenas por formato de arquivo no Windows. Não edite migrações publicadas; crie outra migração.
6. Se tabelas já tiverem sido criadas manualmente sem registro, o runner falha e reverte. Revise o estado com cuidado; não insira hashes para mascarar divergências nem exclua tabelas automaticamente.
7. Em homologação, confirme cadastro, TOTP e CSRF, limite da concessão, repetição de chave, isolamento de acesso entre criadores, simulação sem débito, distribuição das redes curta/longa, reembolso parcial/total repetido e navegação no celular.
8. Após validação, publique a versão compatível e ative `CREATOR_PROGRAM_ENABLED=true`. Observe eventos pendentes, falhas de processamento e respostas do webhook. Não reenvie pagamentos reais para fazer testes.

## Reversão operacional

Desative `CREATOR_PROGRAM_ENABLED` para interromper a exposição do programa quando necessário. Preserve banco, snapshots, auditoria e lançamentos; não faça rollback destrutivo das migrações. Uma versão antiga do servidor pode não compreender vendas marcadas como pertencentes ao novo programa.

Na versão integrada, desligar a flag impede acesso à interface, administração, novos cadastros e cenários. Quando a migração 003 está presente, o motor financeiro continua ativo: cria snapshots de novas vendas de criadores já cadastrados, processa a fila e trata reembolsos. Isso preserva a regra dos links já divulgados e evita que novas vendas caiam no percentual legado de compatibilidade. O financeiro intencionalmente não é revertido pela flag. Mantenha `MERCADOPAGO_WEBHOOK_SECRET` configurado mesmo com a flag desativada. A flag não substitui reconciliação financeira nem interrompe o tratamento de obrigações existentes. Corrija a causa e reative somente após verificar eventos pendentes. Registros de auditoria e estorno devem continuar disponíveis para investigação.

## Verificação local

`test/creator-store.test.js` cobre identidade, árvore até 100 níveis, permissões, concessões idempotentes, conflitos, valores inválidos, histórico imutável e simulação isolada. `test/creator-migration.test.js` cobre aplicação, repetição, alteração de hash, ausência do baseline e rollback integral em falha da segunda migração. PGlite verifica SQL PostgreSQL em memória; não substitui testes de concorrência entre sessões de um PostgreSQL real nem validação em aparelhos físicos.
