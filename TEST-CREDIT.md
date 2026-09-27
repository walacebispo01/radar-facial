# Crédito para a conta de teste

Abra `/teste` depois de entrar no site com a conta Google autorizada pelo proprietário. A comparação do identificador ocorre no servidor e não concede função administrativa. O endereço bruto não foi incluído no repositório público; seu SHA-256 é apenas um identificador e não é uma credencial secreta.

`POST /api/teste/credito` exige sessão, origem, cabeçalho de requisição e CSRF válidos. Destinatário e quantidade enviados pelo navegador são ignorados. Quando o saldo é zero, a transação libera exatamente um crédito. Saldo positivo não recebe acréscimo. Uma busca em andamento bloqueia a liberação; buscas abandonadas há mais de 15 minutos seguem a política existente de devolução, sem receber também um crédito de teste. O bloqueio da linha do usuário impede concessões concorrentes duplicadas.

Há intervalo adicional de 30 segundos entre tentativas autorizadas por processo. Esse intervalo não é um limite distribuído nem diário. A conta autorizada pode voltar a liberar um crédito após consumir o anterior; buscas reais continuam sendo cobradas pelo FaceCheck. Cada concessão emite o evento estruturado `test_credit_granted` nos logs do servidor. Não cria transação Mercado Pago, comissão ou registro de concessão do programa de criadores.

Não exige migração ou ativação do programa de criadores. Para desativar a rota, configure `TEST_CREDIT_ENABLED=false` no ambiente. Os testes cobrem autorização, CSRF, teto de saldo, concorrência serializada em PGlite, buscas em andamento e recuperação sem dupla devolução. A execução autenticada na conta real deve ser conferida pelo proprietário; não realizamos buscas pagas para validar essa rota.
