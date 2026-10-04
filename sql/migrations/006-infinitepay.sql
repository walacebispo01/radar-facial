BEGIN;
CREATE TABLE public.infinitepay_pedidos (
    id text PRIMARY KEY CHECK (id ~ '^ip_[a-f0-9]{64}$'),
    email text NOT NULL REFERENCES public.usuarios(email),
    handle text NOT NULL,
    pacote text NOT NULL,
    centavos integer NOT NULL CHECK (centavos > 0),
    creditos integer NOT NULL CHECK (creditos > 0),
    afiliado_codigo text REFERENCES public.afiliados(codigo),
    checkout_url text,
    transaction_nsu text UNIQUE,
    invoice_slug text UNIQUE,
    criado_em timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    confirmado_em timestamptz,
    CHECK ((transaction_nsu IS NULL) = (invoice_slug IS NULL))
);
CREATE INDEX infinitepay_pedidos_email_idx ON public.infinitepay_pedidos(email, criado_em DESC);
COMMIT;
