# Publicação: convites e provas sociais

## Comportamento preparado

Login Google obrigatório; convites separados de venda; candidatura vinculada ao indicador; aprovação apenas por osasukedoinsta@gmail.com e walacegab1998@gmail.com com TOTP. Aprovação transacional libera criador e simulação, sem conceder créditos reais. A árvore permite navegar apenas no próprio ramo.

Cada criador ativo mantém até cinco vídeos. Envios e edições voltam para aprovação. Os dois responsáveis aprovam, ocultam, destacam e ordenam vídeos. Criador suspenso perde simulação e convites e tem vídeos ocultados, sem apagar histórico. Página inicial mantém a abertura atual e acrescenta somente destaques aprovados; /provas-sociais mostra todos os aprovados.

Carteiras digitais e pagamentos automáticos a criadores não fazem parte desta publicação. Pix, preços e regras de distribuição financeira não foram alterados.

## Antes de produção

1. Conferir main e versão Live do serviço radar-facial-api. Confirmar que não há mudanças de outro desenvolvedor pendentes de integração.
2. Confirmar recuperação do Neon e o estado real das migrações. O runner migrate:creators verifica hashes e aplica 002/003/004/005 em uma transação. **A migração 003 já existente habilita o processamento financeiro mesmo com CREATOR_PROGRAM_ENABLED=false**; não executar esse runner em produção sem revisar esse efeito e os dados existentes.
3. Configurar ADMIN_EMAILS com os dois responsáveis e ADMIN_TOTP_SECRETS com suas entradas existentes, sem expor, substituir ou registrar segredos no repositório. Confirmar webhook Mercado Pago configurado.
4. Aplicar migrações autorizadas. Não alterar migrações históricas nem executar novamente a 002-modo-simulacao se suas tabelas já existem.
5. Publicar código com CREATOR_PROGRAM_ENABLED=false. Nesse estado, candidaturas/convites e aprovação de novos criadores permanecem bloqueados; moderação de vídeos de criadores existentes pode funcionar se a infraestrutura estiver pronta. Sem migração 005, a galeria pública retorna vazia e a página inicial permanece funcional.
6. Conferir versão publicada e smoke test de Google, sessão, Pix, pesquisa e créditos de teste, sem pagamento real não autorizado.
7. Ativar CREATOR_PROGRAM_ENABLED=true somente após validação do programa e comissões. Não ativar a flag apenas para exibir provas sociais.

## Conferência final

- Administradores conseguem confirmar TOTP, aprovar uma candidatura e obter árvore, links e simulação.
- Usuário comum não aprova; e-mail digitado ou indicador enviado pelo navegador não substituem a identidade/vínculo validados.
- Vídeo pendente não aparece em público. Troca de link retira o vídeo da exibição até nova decisão. Suspensão retira os vídeos públicos e bloqueia convites.
- Destaques podem ser reordenados e a ordem persiste ao recarregar.
- Busca paga e confirmação de pagamento mantêm idempotência; mesmas regras de créditos e comissão.
- Vídeos externos não carregam no início; YouTube embutido apenas após clique, outras URLs abrem a publicação original. Sem busca remota no servidor.

## Reversão

Desativar convites pelo feature flag e reverter somente o código se necessário. Preservar tabelas novas e auditoria. Não remover histórico financeiro; manter processamento de reembolsos dos snapshots já existentes. Confirmar recuperação do banco antes de qualquer intervenção em dados.

## Validação local

Testes usam PostgreSQL em memória e serviços externos simulados. Incluem aprovação atômica e repetida, rollback da criação, limite concorrente de cinco, propriedade dos vídeos, edição e aprovação com versão, ordenação, suspensão e sessão/CSRF/TOTP. Não confirmam configuração real de Render/Neon, elegibilidade de vídeos para embed, nem um pagamento real em produção.
