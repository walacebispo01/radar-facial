# Persistência PostgreSQL

O backend utiliza exclusivamente as tabelas e a view de `sql/schema-proposto.sql`,
já criadas no Neon. Não executa DDL na inicialização nem lê/grava `radar-data.json`.
Não há importação automática de dados antigos.

Configure `DATABASE_URL` apenas no `.env` local ou no ambiente do servidor.
Não copie a URL para o frontend ou para arquivos versionados. As demais variáveis
de ambiente e as rotas do site continuam sendo utilizadas.

```sh
npm start
npm run check
npm test
npm run test:db
npm run migrate:sessions
npm run migrate:affiliate-clicks
```

`npm start` verifica a conexão antes de abrir a porta HTTP. O pool possui limites
de conexões e timeouts, e é encerrado em SIGTERM/SIGINT. Erros do driver são
sanitizados antes de chegar às rotas. A configuração TLS vem da URL do provedor;
o código não desativa a verificação de certificados.

## Sessão, CSRF e ambiente

A migração `sql/migrations/001-sessoes.sql` cria as sessões e o livro de consumo
idempotente das buscas faciais. Aplique-a uma única vez no Neon antes de publicar
esta versão. `npm run migrate:sessions` usa `DATABASE_URL`, executa o arquivo
inteiro em uma transação e faz rollback em caso de erro.

A migração `sql/migrations/002-protecao-cliques-afiliados.sql` adiciona a chave
anônima de deduplicação dos cliques. Aplique-a antes de publicar a versão que usa
`recordClick(codigo, dedupeKey)`. Ela preserva os cliques antigos e não armazena IP.

Variáveis obrigatórias em produção:

- `APP_ORIGIN=https://radarfacial.com.br` (origem exata, sem caminho ou barra final);
- `GOOGLE_CLIENT_ID` correspondente ao botão Google do site;
- `ADMIN_EMAILS` como lista de e-mails normalizados, separados por vírgula;
- `DATABASE_URL`, `MERCADOPAGO_TOKEN` e `FACECHECK_API_KEY` somente no servidor.

O login cria um cookie `__Host-radar_session` com `Secure`, `HttpOnly` e
`SameSite=Lax`. Rotas autenticadas validam origem, sessão e CSRF. O frontend não
usa mais o token Google como sessão e não envia e-mail para identificar compras,
consultas ou ações administrativas.

## Operações financeiras

- Aprovação e webhook usam o mesmo fluxo. A ordem de bloqueio é afiliado (quando
  houver), pagamento, usuário e comissão. A consulta ao Mercado Pago ocorre
  depois do bloqueio do pagamento, com timeout, para evitar snapshots fora de
  ordem entre consulta e webhook.
- Créditos, `credited`, data de liberação e eventual comissão são gravados na
  mesma transação. Falha em qualquer etapa ou constraint no COMMIT reverte tudo.
- A busca facial exige `Idempotency-Key`. O servidor reserva o crédito antes de
  chamar o FaceCheck, salva a resposta concluída para retries e reembolsa exatamente
  uma vez quando o provedor falha. Operações interrompidas há mais de 15 minutos
  são compensadas na próxima tentativa do usuário.
- O repasse bloqueia o afiliado e todas as comissões disponíveis/pendentes, soma
  valores no PostgreSQL, cria o repasse e vincula as comissões na mesma transação.
  A chave padrão é derivada do lote de comissões e o histórico não é reatribuído.
- As rotas de criar PIX e registrar repasse aceitam opcionalmente o cabeçalho
  `Idempotency-Key`. Reutilize-o ao repetir a mesma operação. Para um novo PIX ou
  novo repasse, use outra chave. O frontend existente não precisa desse cabeçalho;
  continua funcionando como antes. Sem chave de PIX, cada chamada cria uma nova
  compra. Sem chave de repasse, uma repetição com nenhuma comissão aberta retorna
  o erro 400 anterior, sem duplicar o lote já pago.
- O webhook retorna 200 após o COMMIT. Falhas retornam 500 para permitir retry do
  provedor. Notificações sem ID ou de pagamento desconhecido mantêm o 200 anterior.
- `cancelled` encerra comissão como `cancelada`; `refunded`/`charged_back` como
  `estornada`. Se já paga, cria um ajuste integral único, preservando repasse e
  valores históricos. Ajustes não transferem dinheiro nem são descontados
  automaticamente do próximo repasse. Não há política de reembolso parcial.
- Reembolso não reabre `credited` nem desconta créditos já concedidos: preserva
  a política atual. Comissões encerradas não são reabertas por eventos posteriores.

Chamadas ao Mercado Pago e transações PostgreSQL não formam uma transação
distribuída. Se o provedor criar um PIX e a gravação local falhar, reutilizar a
mesma chave de idempotência permite recuperar o pagamento na nova tentativa.
A migração não adiciona fila de reconciliação nem armazena QR Codes no banco.

## Compatibilidade e testes

As respostas mantêm os campos usados pelo site, números JSON para créditos e
valores e datas ISO. A view é adaptada para `metricas` e `repasses`; campos internos
de idempotência não são expostos. Google, FaceCheck e autorização por
`ADMIN_EMAILS` continuam no backend.

Os testes aplicam o SQL existente em uma instância PGlite em memória e usam dados
sintéticos. Cobrem duplicidade, rollbacks, constraints adiadas, créditos, repasses,
estornos e contratos HTTP com Google/Mercado Pago simulados. PGlite possui uma
sessão; requisições concorrentes são serializadas no adaptador de testes. Isso
não equivale a um teste de carga/MVCC com múltiplas sessões PostgreSQL.

`npm run test:db` faz somente `SELECT 1` em transação de leitura na DATABASE_URL.
Nenhum teste automatizado importa dados nem grava fixtures no Neon.

## Checklist de publicação

1. Revogar os segredos expostos e cadastrar somente os novos valores na hospedagem.
2. Conferir `APP_ORIGIN`, `ADMIN_EMAILS`, `GOOGLE_CLIENT_ID` e `DATABASE_URL`.
3. Executar `npm run test:db`, `npm run migrate:sessions` e
   `npm run migrate:affiliate-clicks` contra o Neon correto.
4. Executar `npm run check` e `npm test`, publicar e aguardar o health check.
5. Em janela anônima, validar login/restauração/logout, criação e confirmação de
   PIX, uma busca FaceCheck com saldo, falha sem saldo e administração permitida/negada.
6. Confirmar no banco que um retry da mesma busca gerou uma linha em
   `buscas_faciais` e apenas um débito.
