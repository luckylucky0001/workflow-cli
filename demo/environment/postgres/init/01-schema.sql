-- workctl demo: synthetic, deterministic schema and data for the `pg` domain (no real personal data).
-- Run once by docker-entrypoint-initdb.d (as the `postgres` superuser, database demo_orders)
-- on an empty data directory.
--
-- orders.customer_id is INTENTIONALLY NOT INDEXED: `WHERE customer_id = ?` produces sequential
-- scans that show up in pg_stat_user_tables.seq_scan, pg_stat_statements and EXPLAIN.
-- internal_ledger is INTENTIONALLY NOT GRANTED to workctl_ro (PERMISSION_DENIED demo).

CREATE EXTENSION IF NOT EXISTS pg_stat_statements;

CREATE TABLE IF NOT EXISTS customers (
  id         bigint       PRIMARY KEY,
  name       varchar(64)  NOT NULL,
  phone      varchar(32),
  email      varchar(128),
  city       varchar(32),
  created_at timestamptz  NOT NULL
);
COMMENT ON TABLE customers IS 'synthetic customers (workctl demo)';

CREATE TABLE IF NOT EXISTS orders (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  customer_id bigint        NOT NULL,
  status      varchar(16)   NOT NULL,
  amount      numeric(10,2) NOT NULL,
  item_count  integer       NOT NULL,
  created_at  timestamptz   NOT NULL,
  updated_at  timestamptz   NOT NULL
);
COMMENT ON TABLE orders IS 'synthetic orders (workctl demo); customer_id intentionally not indexed';
CREATE INDEX IF NOT EXISTS orders_created_at_idx ON orders (created_at);

CREATE TABLE IF NOT EXISTS order_items (
  order_id bigint        NOT NULL REFERENCES orders (id),
  line_no  integer       NOT NULL,
  sku      varchar(32)   NOT NULL,
  qty      integer       NOT NULL,
  price    numeric(10,2) NOT NULL,
  PRIMARY KEY (order_id, line_no)
);
COMMENT ON TABLE order_items IS 'synthetic order lines (workctl demo)';

CREATE TABLE IF NOT EXISTS internal_ledger (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account    varchar(32)   NOT NULL,
  balance    numeric(14,2) NOT NULL,
  updated_at timestamptz   NOT NULL
);
COMMENT ON TABLE internal_ledger IS 'synthetic ledger; NOT readable by workctl_ro (permission demo)';

-- deterministic data (no random()): 2,000 customers, 50,000 orders, ~100,000 order lines
INSERT INTO customers (id, name, phone, email, city, created_at)
SELECT g,
       'customer-' || g,
       '+86-138' || lpad((g * 7919 % 100000000)::text, 8, '0'),
       'c' || g || '@example.invalid',
       (ARRAY['shanghai','beijing','shenzhen','hangzhou','chengdu'])[1 + g % 5],
       timestamptz '2026-01-01 00:00:00+00' + (g || ' minutes')::interval
  FROM generate_series(1, 2000) g
ON CONFLICT DO NOTHING;

INSERT INTO orders (customer_id, status, amount, item_count, created_at, updated_at)
SELECT 1 + (g * 7919) % 2000,
       (ARRAY['created','paid','shipped','done','cancelled'])[1 + g % 5],
       round(((g * 37) % 100000) / 100.0 + 1, 2),
       1 + g % 3,
       timestamptz '2026-09-01 00:00:00+00' + (g * 47 || ' seconds')::interval,
       timestamptz '2026-09-01 00:00:00+00' + (g * 47 + 600 || ' seconds')::interval
  FROM generate_series(1, 50000) g;

INSERT INTO order_items (order_id, line_no, sku, qty, price)
SELECT o.id, l, 'SKU-' || lpad(((o.id * 31 + l) % 500)::text, 4, '0'), 1 + (o.id + l) % 4, round(((o.id * 13 + l) % 20000) / 100.0 + 1, 2)
  FROM orders o
  CROSS JOIN LATERAL generate_series(1, o.item_count) l
ON CONFLICT DO NOTHING;

INSERT INTO internal_ledger (account, balance, updated_at)
SELECT 'acct-' || g, (g * 1013 % 1000000) / 100.0, timestamptz '2026-10-01 00:00:00+00'
  FROM generate_series(1, 100) g;

ANALYZE customers;
ANALYZE orders;
ANALYZE order_items;
ANALYZE internal_ledger;
