-- PROPOSTA PARA REVISÃO. NÃO EXECUTADA.
-- Base: server.js atual; substitui as seis coleções de radar-data.json.
-- Destino: schema public de um banco novo. Não inclui dados nem migração.
-- Sem extensões, credenciais ou exclusões em cascata.
-- Triggers abaixo apenas protegem histórico; não movimentam saldos.
-- Sem IF NOT EXISTS: uma estrutura preexistente incompatível deve causar erro.

BEGIN;

-- usuariosCreditos[email] -> usuarios(email, creditos).
-- A autenticação continua no Google e ADMIN_EMAILS continua no ambiente.
-- Não armazenar tokens Google, chaves de API ou credenciais do banco.
CREATE TABLE public.usuarios (
    email text PRIMARY KEY,
    creditos bigint NOT NULL DEFAULT 0,
    CONSTRAINT usuarios_creditos_nao_negativos CHECK (creditos >= 0),
    CONSTRAINT usuarios_email_normalizado CHECK (email = lower(btrim(email)))
);

-- afiliados[codigo]. E-mail opcional no código atual: aceita string vazia,
-- não é único e não exige que o afiliado tenha feito login como usuário.
CREATE TABLE public.afiliados (
    codigo varchar(40) PRIMARY KEY,
    id text NOT NULL UNIQUE,
    nome varchar(100) NOT NULL,
    email varchar(160) NOT NULL DEFAULT '',
    comissao_percentual smallint NOT NULL,
    status text NOT NULL DEFAULT 'ativo',
    criado_em timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    atualizado_em timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT afiliados_codigo_formato CHECK (codigo ~ '^[a-z0-9_-]+$'),
    CONSTRAINT afiliados_nome_preenchido CHECK (length(btrim(nome)) > 0),
    CONSTRAINT afiliados_percentual_valido CHECK (comissao_percentual IN (10, 15)),
    CONSTRAINT afiliados_status_valido CHECK (status IN ('ativo', 'inativo')),
    CONSTRAINT afiliados_codigo_id_unicos UNIQUE (codigo, id)
);

-- transacoes[String(result.id)]. Payment ID é texto, como no backend.
-- Status do Mercado Pago fica aberto a novos valores, sem ENUM fechado.
-- Não obrigar credited=true a ter status='approved': o status pode mudar
-- posteriormente e o código atual não estorna os créditos automaticamente.
CREATE TABLE public.transacoes (
    payment_id text PRIMARY KEY,
    status text NOT NULL DEFAULT 'pending',
    status_detail text,
    email text NOT NULL REFERENCES public.usuarios(email),
    buscas_restantes bigint NOT NULL,
    criado_em timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    credited boolean NOT NULL DEFAULT false,
    credited_em timestamptz,
    idempotency_key text UNIQUE,
    afiliado_codigo varchar(40) REFERENCES public.afiliados(codigo),
    valor_pago numeric(12,2) NOT NULL,
    comissao_afiliado_id text,
    CONSTRAINT transacoes_creditos_positivos CHECK (buscas_restantes > 0),
    -- O código arredonda para centavos depois de validar valor > 0;
    -- por isso 0.00 é representável (por exemplo, entrada 0.001).
    CONSTRAINT transacoes_valor_valido CHECK (
        valor_pago >= 0 AND valor_pago < 'Infinity'::numeric
        AND valor_pago = round(valor_pago, 2)
    ),
    CONSTRAINT transacoes_creditamento_consistente CHECK (
        (credited AND credited_em IS NOT NULL)
        OR (NOT credited AND credited_em IS NULL)
    ),
    CONSTRAINT transacoes_pagamento_afiliado_unicos UNIQUE (payment_id, afiliado_codigo)
);

-- Cliques de afiliados. dedupe_key representa visitante + afiliado + dia UTC;
-- não armazena IP nem o identificador anônimo do navegador em formato reversível.
CREATE TABLE public.cliques_afiliados (
    id text PRIMARY KEY,
    afiliado_codigo varchar(40) NOT NULL REFERENCES public.afiliados(codigo),
    dedupe_key text NOT NULL UNIQUE CHECK (dedupe_key ~ '^[a-f0-9]{64}$'),
    criado_em timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- repassesAfiliados[]. Representa registro administrativo de pagamento;
-- não representa transferência bancária automática.
-- registrado_por não tem FK para usuarios: um administrador pode registrar
-- um repasse sem existir previamente em usuariosCreditos.
CREATE TABLE public.repasses_afiliados (
    id text PRIMARY KEY,
    afiliado_codigo varchar(40) NOT NULL,
    afiliado_id text NOT NULL,
    valor numeric(12,2) NOT NULL,
    quantidade_comissoes bigint NOT NULL,
    pago_em timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    registrado_por text NOT NULL,
    idempotency_key text NOT NULL UNIQUE,
    CONSTRAINT repasses_idempotencia_preenchida CHECK (length(btrim(idempotency_key)) > 0),
    CONSTRAINT repasses_afiliado_fk FOREIGN KEY (afiliado_codigo, afiliado_id)
        REFERENCES public.afiliados(codigo, id),
    CONSTRAINT repasses_valor_valido CHECK (
        valor >= 0 AND valor < 'Infinity'::numeric AND valor = round(valor, 2)
    ),
    CONSTRAINT repasses_quantidade_positiva CHECK (quantidade_comissoes > 0),
    CONSTRAINT repasses_id_afiliado_unicos UNIQUE (id, afiliado_codigo)
);

-- comissoesAfiliados[id]. Uma comissão por pagamento.
-- percentual/valor_venda/valor_comissao são snapshots históricos, não
-- colunas geradas: editar o afiliado não recalcula comissões antigas.
-- valor_venda vem de mpCheck.transaction_amount, com fallback para valor_pago.
CREATE TABLE public.comissoes_afiliados (
    id text PRIMARY KEY,
    payment_id text NOT NULL UNIQUE,
    afiliado_codigo varchar(40) NOT NULL,
    afiliado_id text NOT NULL,
    percentual smallint NOT NULL,
    valor_venda numeric(12,2) NOT NULL,
    valor_comissao numeric(12,2) NOT NULL,
    status text NOT NULL DEFAULT 'disponivel',
    criado_em timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    pago_em timestamptz,
    repasse_id text,
    encerrado_em timestamptz,
    motivo_encerramento text,
    CONSTRAINT comissoes_id_formato CHECK (id = 'com_' || payment_id),
    CONSTRAINT comissoes_percentual_valido CHECK (percentual IN (10, 15)),
    CONSTRAINT comissoes_status_valido CHECK (
        status IN ('disponivel', 'pendente', 'pago', 'cancelada', 'estornada')
    ),
    CONSTRAINT comissoes_venda_valida CHECK (
        valor_venda >= 0 AND valor_venda < 'Infinity'::numeric
        AND valor_venda = round(valor_venda, 2)
    ),
    CONSTRAINT comissoes_valor_valido CHECK (
        valor_comissao >= 0 AND valor_comissao < 'Infinity'::numeric
        AND valor_comissao = round(valor_comissao, 2)
    ),
    CONSTRAINT comissoes_pagamento_afiliado_fk FOREIGN KEY (payment_id, afiliado_codigo)
        REFERENCES public.transacoes(payment_id, afiliado_codigo),
    CONSTRAINT comissoes_afiliado_fk FOREIGN KEY (afiliado_codigo, afiliado_id)
        REFERENCES public.afiliados(codigo, id),
    CONSTRAINT comissoes_repasse_mesmo_afiliado_fk FOREIGN KEY (repasse_id, afiliado_codigo)
        REFERENCES public.repasses_afiliados(id, afiliado_codigo),
    CONSTRAINT comissoes_pagamento_consistente CHECK (
        (status = 'pago' AND pago_em IS NOT NULL AND repasse_id IS NOT NULL)
        OR (status IN ('disponivel', 'pendente') AND pago_em IS NULL AND repasse_id IS NULL)
        OR (status IN ('cancelada', 'estornada') AND (
            (pago_em IS NULL AND repasse_id IS NULL)
            OR (pago_em IS NOT NULL AND repasse_id IS NOT NULL)
        ))
    ),
    CONSTRAINT comissoes_encerramento_consistente CHECK (
        (status IN ('cancelada', 'estornada') AND encerrado_em IS NOT NULL
            AND motivo_encerramento IS NOT NULL AND length(btrim(motivo_encerramento)) > 0)
        OR (status IN ('disponivel', 'pendente', 'pago')
            AND encerrado_em IS NULL AND motivo_encerramento IS NULL)
    ),
    CONSTRAINT comissoes_id_pagamento_unicos UNIQUE (id, payment_id),
    CONSTRAINT comissoes_origem_ajuste_unica
        UNIQUE (id, repasse_id, afiliado_codigo, valor_comissao)
);

-- Débito compensatório de uma comissão integral já repassada.
-- Valor positivo representa montante a recuperar, não um novo pagamento.
-- Uma reversão integral por comissão; não modela reembolsos parciais.
-- Não descontar automaticamente de futuros repasses: a política de
-- recuperação/liquidação ainda deverá ser definida no backend.
CREATE TABLE public.ajustes_comissoes (
    id text PRIMARY KEY,
    comissao_id text NOT NULL UNIQUE,
    repasse_original_id text NOT NULL,
    afiliado_codigo varchar(40) NOT NULL,
    valor numeric(12,2) NOT NULL,
    motivo text NOT NULL CHECK (length(btrim(motivo)) > 0),
    criado_em timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    registrado_por text NOT NULL,
    idempotency_key text NOT NULL UNIQUE CHECK (length(btrim(idempotency_key)) > 0),
    CONSTRAINT ajustes_valor_valido CHECK (valor >= 0 AND valor < 'Infinity'::numeric),
    -- Obriga o ajuste a apontar para a comissão, repasse, afiliado e valor
    -- originais. Comissão nunca paga não pode originar este ajuste.
    CONSTRAINT ajustes_comissao_paga_fk
        FOREIGN KEY (comissao_id, repasse_original_id, afiliado_codigo, valor)
        REFERENCES public.comissoes_afiliados(id, repasse_id, afiliado_codigo, valor_comissao)
);

-- Registros históricos são imutáveis depois de inseridos.
CREATE FUNCTION public.impedir_mutacao_historico() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'Registro histórico não pode ser alterado ou excluído: %', TG_TABLE_NAME;
END;
$$;

CREATE TRIGGER repasses_preservar_historico
BEFORE UPDATE OR DELETE ON public.repasses_afiliados
FOR EACH ROW EXECUTE FUNCTION public.impedir_mutacao_historico();

CREATE TRIGGER ajustes_preservar_historico
BEFORE UPDATE OR DELETE ON public.ajustes_comissoes
FOR EACH ROW EXECUTE FUNCTION public.impedir_mutacao_historico();

-- Impede reatribuir uma comissão paga a outro repasse ou apagar sua origem.
CREATE FUNCTION public.proteger_comissao() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'Comissões devem ser canceladas/estornadas, não excluídas';
    END IF;
    IF ROW(NEW.id, NEW.payment_id, NEW.afiliado_codigo, NEW.afiliado_id,
           NEW.percentual, NEW.valor_venda, NEW.valor_comissao, NEW.criado_em)
       IS DISTINCT FROM
       ROW(OLD.id, OLD.payment_id, OLD.afiliado_codigo, OLD.afiliado_id,
           OLD.percentual, OLD.valor_venda, OLD.valor_comissao, OLD.criado_em) THEN
        RAISE EXCEPTION 'Identidade e valores históricos da comissão são imutáveis';
    END IF;
    IF OLD.repasse_id IS NOT NULL AND
       ROW(NEW.repasse_id, NEW.pago_em) IS DISTINCT FROM ROW(OLD.repasse_id, OLD.pago_em) THEN
        RAISE EXCEPTION 'Vínculo com o repasse original é imutável';
    END IF;
    IF OLD.status IN ('cancelada', 'estornada') AND NEW IS DISTINCT FROM OLD THEN
        RAISE EXCEPTION 'Comissão encerrada não pode ser reaberta ou modificada';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER comissoes_preservar_historico
BEFORE UPDATE OR DELETE ON public.comissoes_afiliados
FOR EACH ROW EXECUTE FUNCTION public.proteger_comissao();

-- Validação adiada: a comissão e seu ajuste podem ser gravados em qualquer
-- ordem na mesma transação, mas precisam estar consistentes no COMMIT.
CREATE FUNCTION public.validar_ajuste_comissao() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    alvo_id text;
    comissao public.comissoes_afiliados%ROWTYPE;
    tem_ajuste boolean;
BEGIN
    IF TG_TABLE_NAME = 'ajustes_comissoes' THEN
        alvo_id := NEW.comissao_id;
    ELSE
        alvo_id := NEW.id;
    END IF;
    SELECT * INTO comissao FROM public.comissoes_afiliados WHERE id = alvo_id;
    SELECT EXISTS (SELECT 1 FROM public.ajustes_comissoes WHERE comissao_id = alvo_id)
        INTO tem_ajuste;
    IF tem_ajuste IS DISTINCT FROM
       (comissao.status IN ('cancelada', 'estornada') AND comissao.repasse_id IS NOT NULL) THEN
        RAISE EXCEPTION 'Comissão encerrada já paga exige exatamente um ajuste; comissão ativa não admite ajuste';
    END IF;
    RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER comissoes_validar_ajuste
AFTER INSERT OR UPDATE ON public.comissoes_afiliados
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION public.validar_ajuste_comissao();

CREATE CONSTRAINT TRIGGER ajustes_validar_comissao
AFTER INSERT ON public.ajustes_comissoes
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION public.validar_ajuste_comissao();

-- Impede repasse vazio, soma divergente ou nova linha de repasse sem seu
-- conjunto próprio de comissões. Inclui encerradas já pagas: o total
-- histórico original não muda quando se registra um ajuste posterior.
CREATE FUNCTION public.validar_total_repasse() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    alvo_id text;
    repasse public.repasses_afiliados%ROWTYPE;
    quantidade bigint;
    total numeric;
BEGIN
    IF TG_TABLE_NAME = 'repasses_afiliados' THEN
        alvo_id := NEW.id;
    ELSE
        alvo_id := NEW.repasse_id;
    END IF;
    IF alvo_id IS NULL THEN
        RETURN NULL;
    END IF;
    SELECT * INTO repasse FROM public.repasses_afiliados WHERE id = alvo_id FOR UPDATE;
    SELECT count(*), coalesce(sum(valor_comissao), 0)
        INTO quantidade, total
        FROM public.comissoes_afiliados WHERE repasse_id = alvo_id;
    IF quantidade IS DISTINCT FROM repasse.quantidade_comissoes
       OR total IS DISTINCT FROM repasse.valor THEN
        RAISE EXCEPTION 'Repasse deve corresponder à quantidade e soma de suas comissões';
    END IF;
    RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER repasses_validar_total
AFTER INSERT ON public.repasses_afiliados
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION public.validar_total_repasse();

CREATE CONSTRAINT TRIGGER comissoes_validar_total_repasse
AFTER INSERT OR UPDATE ON public.comissoes_afiliados
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION public.validar_total_repasse();

-- credited nunca volta a false: reembolso não autoriza nova liberação.
-- Isso não substitui o bloqueio e a soma atômica de saldo no backend.
CREATE FUNCTION public.proteger_creditamento() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'Histórico de pagamentos não pode ser excluído';
    END IF;
    IF NEW.payment_id IS DISTINCT FROM OLD.payment_id THEN
        RAISE EXCEPTION 'Identidade do pagamento é imutável';
    END IF;
    IF OLD.credited AND ROW(NEW.credited, NEW.credited_em, NEW.email, NEW.buscas_restantes)
        IS DISTINCT FROM ROW(OLD.credited, OLD.credited_em, OLD.email, OLD.buscas_restantes) THEN
        RAISE EXCEPTION 'Liberação de créditos já registrada é imutável';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER transacoes_preservar_creditamento
BEFORE UPDATE OR DELETE ON public.transacoes
FOR EACH ROW EXECUTE FUNCTION public.proteger_creditamento();

-- Preserva transaction.comissao_afiliado_id e impede apontar para comissão
-- de outro pagamento. FK adiada permite gravar o par na mesma transação.
ALTER TABLE public.transacoes
    ADD CONSTRAINT transacoes_comissao_do_pagamento_fk
    FOREIGN KEY (comissao_afiliado_id, payment_id)
    REFERENCES public.comissoes_afiliados(id, payment_id)
    DEFERRABLE INITIALLY DEFERRED;

CREATE INDEX transacoes_email_idx ON public.transacoes(email);
CREATE INDEX transacoes_afiliado_idx ON public.transacoes(afiliado_codigo);
CREATE INDEX cliques_afiliados_codigo_data_idx
    ON public.cliques_afiliados(afiliado_codigo, criado_em);
CREATE INDEX comissoes_afiliados_codigo_status_idx
    ON public.comissoes_afiliados(afiliado_codigo, status);
CREATE INDEX comissoes_afiliados_repasse_idx
    ON public.comissoes_afiliados(repasse_id, afiliado_codigo);
CREATE INDEX repasses_afiliados_codigo_data_idx
    ON public.repasses_afiliados(afiliado_codigo, pago_em DESC);
CREATE INDEX ajustes_comissoes_afiliado_idx ON public.ajustes_comissoes(afiliado_codigo);
CREATE INDEX ajustes_comissoes_repasse_idx ON public.ajustes_comissoes(repasse_original_id);

-- Equivalente às métricas de obterResumoAfiliado; agregar separadamente
-- evita multiplicar vendas ao juntar com múltiplos cliques ou repasses.
CREATE VIEW public.resumo_afiliados AS
WITH cliques AS (
    SELECT afiliado_codigo, count(*) AS cliques
    FROM public.cliques_afiliados
    GROUP BY afiliado_codigo
), comissoes AS (
    SELECT afiliado_codigo,
           count(*) AS vendas,
           sum(valor_venda) AS faturamento,
           sum(valor_comissao) AS comissao_total,
           sum(valor_comissao) FILTER (WHERE status = 'pago') AS comissao_paga,
           sum(valor_comissao) FILTER (
               WHERE status IN ('disponivel', 'pendente')
           ) AS comissao_disponivel
    FROM public.comissoes_afiliados
    WHERE status IN ('disponivel', 'pendente', 'pago')
    GROUP BY afiliado_codigo
), repasses AS (
    SELECT afiliado_codigo, sum(valor) AS total_repassado_historico
    FROM public.repasses_afiliados GROUP BY afiliado_codigo
), ajustes AS (
    SELECT afiliado_codigo, sum(valor) AS total_ajustes_registrados
    FROM public.ajustes_comissoes GROUP BY afiliado_codigo
)
SELECT a.*,
       coalesce(cl.cliques, 0) AS cliques,
       coalesce(co.vendas, 0) AS vendas,
       CASE WHEN coalesce(cl.cliques, 0) > 0
            THEN round(coalesce(co.vendas, 0)::numeric * 100 / cl.cliques, 2)
            ELSE 0::numeric END AS conversao,
       round(coalesce(co.faturamento, 0), 2) AS faturamento,
       round(coalesce(co.comissao_total, 0), 2) AS comissao_total,
       round(coalesce(co.comissao_disponivel, 0), 2) AS comissao_disponivel,
       round(coalesce(co.comissao_paga, 0), 2) AS comissao_paga,
       round(coalesce(r.total_repassado_historico, 0), 2) AS total_repassado_historico,
       round(coalesce(aj.total_ajustes_registrados, 0), 2) AS total_ajustes_registrados
FROM public.afiliados a
LEFT JOIN cliques cl ON cl.afiliado_codigo = a.codigo
LEFT JOIN comissoes co ON co.afiliado_codigo = a.codigo
LEFT JOIN repasses r ON r.afiliado_codigo = a.codigo
LEFT JOIN ajustes aj ON aj.afiliado_codigo = a.codigo;

COMMENT ON COLUMN public.transacoes.buscas_restantes IS
    'Quantidade de créditos comprados. Não é decrementada no consumo; saldo em usuarios.creditos.';
COMMENT ON COLUMN public.transacoes.credited IS
    'Marca liberação única dos créditos; exige transação atômica com saldo e comissão no backend.';
COMMENT ON COLUMN public.comissoes_afiliados.percentual IS
    'Percentual do afiliado quando a comissão foi registrada, não quando o PIX foi criado.';
COMMENT ON COLUMN public.afiliados.atualizado_em IS
    'Atualizar explicitamente ao editar, como no server.js. DEFAULT não atualiza sozinho.';
COMMENT ON TABLE public.repasses_afiliados IS
    'Registro administrativo. Valor e quantidade devem corresponder às comissões vinculadas na mesma transação.';
COMMENT ON TABLE public.ajustes_comissoes IS
    'Débitos compensatórios integrais de comissões já pagas. Preserva o repasse original; não executa recuperação de dinheiro.';
COMMENT ON VIEW public.resumo_afiliados IS
    'Métricas excluem canceladas/estornadas. Totais históricos de repasses e ajustes são separados; ajustes não indicam valores já recuperados.';

COMMIT;

-- CONTRATO PARA A FUTURA ADAPTAÇÃO DO BACKEND (NÃO IMPLEMENTADA AQUI):
-- 1. Login: inserir usuario com saldo 0 se ausente; nunca sobrescrever saldo.
--    Criar usuário também ao persistir PIX de e-mail ainda ausente, pois
--    criar-pix atualmente não exige login prévio. Isso satisfaz a nova FK.
-- 2. Aprovação via consulta/webhook: bloquear a transação com FOR UPDATE,
--    revalidar credited, somar créditos atomicamente, marcar credited e
--    credited_em e registrar eventual comissão na MESMA transação SQL.
--    Uma UNIQUE sozinha não impede creditar o saldo duas vezes.
--    O trigger impede reabrir credited, mas não impede um UPDATE arbitrário
--    do saldo: a garantia completa depende do protocolo atômico do backend.
-- 3. Registrar comissão apenas se afiliado estiver ativo naquele momento,
--    com percentual atual 10/15 e valor positivo antes do arredondamento.
--    Manter Math/toFixed do backend para compatibilidade de arredondamento;
--    não recalcular snapshots históricos com outra regra.
-- 4. Consumo: UPDATE usuarios SET creditos = creditos - 1
--    WHERE email = $1 AND creditos > 0 RETURNING creditos.
--    Nenhuma linha retornada equivale a créditos esgotados.
-- 5. Repasse: serializar por afiliado, bloquear comissões abertas, somar
--    disponível/pendente, inserir repasse e marcar as mesmas comissões como
--    pagas com repasse_id/pago_em na MESMA transação. Não criar transferência.
--    Constraint triggers conferem soma/contagem no COMMIT e rejeitam
--    repasses sem suas comissões. Todos os vínculos precisam estar completos.
--    A idempotency_key deve ser estável entre retries da mesma solicitação;
--    gerar nova chave a cada retry anula essa proteção. Repetição deve retornar
--    o repasse existente. Comissão já paga não pode mudar de repasse.
--    Selecionar, registrar e vincular devem ocorrer juntos, sob bloqueio.
-- 6. Manter validação Google, ADMIN_EMAILS, normalização, planos de fallback
--    (1/10/40), status externos e respostas HTTP no código da aplicação.
-- 7. Consultar repasses por afiliado ORDER BY pago_em DESC. A view retorna
--    métricas planas; adaptar para o objeto metricas na resposta atual.
-- 8. pg retorna bigint/numeric como string: converter explicitamente para
--    o formato numérico da API, verificando limites seguros do JavaScript.
-- 9. Na futura importação, criar usuários para a união de chaves de
--    usuariosCreditos e e-mails de transações, preservando saldos existentes.
--    Campos opcionais ausentes viram NULL; não recalcular créditos/comissões.
--    Validar dados legados contra constraints antes de qualquer importação.
--    Para repasses antigos, derivar idempotency_key estável do id original.
--    numeric(12,2) limita cada valor a 9.999.999.999,99; validar também somas
--    de repasses antes de inserir. Agregações da view usam numeric sem limite
--    de precisão para não estourar ao somar vários registros históricos.
-- 10. Não persistir QR Code, plano, imagens ou resultados de busca como se
--     existissem no JSON: o server.js atual não os salva nesse armazenamento.
-- 11. Cancelamento/reembolso integral: bloquear afiliado e comissão na mesma
--     ordem usada pelo repasse, atualizar status/encerrado_em/motivo. Se já
--     paga, manter repasse_id/pago_em e inserir ajuste integral na mesma
--     transação. Constraints adiadas exigem esse par no COMMIT. Se não paga,
--     apenas encerrar; sem ajuste financeiro de um valor ainda não repassado.
--     Reentrega do evento deve ser no-op após conferir o encerramento existente.
--     Não reabrir credited nem descontar créditos do usuário automaticamente;
--     a política para créditos já consumidos continua fora desta proposta.
-- 12. Os triggers protegem INSERT/UPDATE/DELETE usuais. O usuário de runtime
--     deve ter apenas permissões necessárias de DML, sem TRUNCATE/DDL nem
--     capacidade de desabilitar triggers. Provisionamento de roles não incluso.
