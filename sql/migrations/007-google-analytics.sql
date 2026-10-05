BEGIN;
CREATE TABLE public.ga4_pedidos (
    order_id text PRIMARY KEY REFERENCES public.infinitepay_pedidos(id),
    measurement_id text NOT NULL,
    client_id text NOT NULL CHECK (client_id ~ '^[0-9]{1,20}\.[0-9]{1,20}$'),
    session_id bigint NOT NULL CHECK (session_id > 0),
    criado_em timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    tentar_em timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    tentativas integer NOT NULL DEFAULT 0,
    enviado_em timestamptz
);
CREATE INDEX ga4_pedidos_pendentes ON public.ga4_pedidos(tentar_em) WHERE enviado_em IS NULL;
COMMIT;
