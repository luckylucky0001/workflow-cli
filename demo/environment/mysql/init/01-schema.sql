-- workctl demo: synthetic, deterministic schema and data (no real personal data).
-- Run once by docker-entrypoint-initdb.d on an empty data volume.
--
-- orders.customer_id is INTENTIONALLY NOT INDEXED: the sample service (demo-order)
-- queries `WHERE customer_id = ?`, which produces full scans that show up in
-- performance_schema statement digests (SUM_NO_INDEX_USED) and in EXPLAIN.
USE demo;

-- keep the bulk load out of mysql.slow_log so the demo slow log only shows real traffic
SET SESSION long_query_time = 3600;
SET SESSION cte_max_recursion_depth = 10000;

CREATE TABLE IF NOT EXISTS customers (
  id         BIGINT       NOT NULL,
  name       VARCHAR(64)  NOT NULL,
  phone      VARCHAR(32)  NULL,
  email      VARCHAR(128) NULL,
  city       VARCHAR(32)  NULL,
  created_at DATETIME     NOT NULL,
  PRIMARY KEY (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='synthetic customers (workctl demo)';

CREATE TABLE IF NOT EXISTS orders (
  id          BIGINT        NOT NULL AUTO_INCREMENT,
  customer_id BIGINT        NOT NULL,
  status      VARCHAR(16)   NOT NULL,
  amount      DECIMAL(10,2) NOT NULL,
  item_count  INT           NOT NULL,
  created_at  DATETIME      NOT NULL,
  updated_at  DATETIME      NOT NULL,
  PRIMARY KEY (id),
  KEY idx_created_at (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='synthetic orders (workctl demo); customer_id intentionally not indexed';

-- 0..999 helper sequence (dropped at the end; a TEMPORARY table cannot be self-joined)
DROP TABLE IF EXISTS seq_1k;
CREATE TABLE seq_1k (n INT NOT NULL PRIMARY KEY);
INSERT INTO seq_1k (n)
  WITH RECURSIVE s(n) AS (SELECT 0 UNION ALL SELECT n + 1 FROM s WHERE n < 999)
  SELECT n FROM s;

-- 20,000 customers
INSERT INTO customers (id, name, phone, email, city, created_at)
SELECT t.n + 1,
       CONCAT('Demo Customer ', LPAD(t.n + 1, 5, '0')),
       CONCAT('138', LPAD(MOD((t.n + 1) * 7919, 100000000), 8, '0')),
       CONCAT('user', LPAD(t.n + 1, 5, '0'), '@example.com'),
       ELT(1 + MOD(t.n, 8), 'Shanghai', 'Beijing', 'Shenzhen', 'Hangzhou', 'Chengdu', 'Singapore', 'Guangzhou', 'Wuhan'),
       TIMESTAMP('2025-01-01 00:00:00') + INTERVAL MOD(t.n * 13, 600) DAY + INTERVAL MOD(t.n * 7, 86400) SECOND
FROM (SELECT a.n * 1000 + b.n AS n FROM seq_1k a CROSS JOIN seq_1k b WHERE a.n < 20) t
ORDER BY t.n;

-- 300,000 orders spread evenly over 2026-10-01 00:00:00 .. 2026-10-17 23:59:59 (17 days = 1,468,800 s).
-- 10% of orders go to customers 1..100 so a few customers have long order histories.
INSERT INTO orders (id, customer_id, status, amount, item_count, created_at, updated_at)
SELECT t.n + 1,
       CASE WHEN MOD(t.n, 10) = 0 THEN 1 + MOD(t.n DIV 10, 100) ELSE 1 + MOD(t.n * 7919, 20000) END,
       CASE
         WHEN MOD(t.n * 31, 20) < 8  THEN 'DELIVERED'
         WHEN MOD(t.n * 31, 20) < 12 THEN 'SHIPPED'
         WHEN MOD(t.n * 31, 20) < 16 THEN 'PAID'
         WHEN MOD(t.n * 31, 20) < 18 THEN 'PENDING'
         WHEN MOD(t.n * 31, 20) < 19 THEN 'CANCELLED'
         ELSE 'REFUNDED'
       END,
       ROUND(5 + MOD(t.n * 104729, 99500) / 100, 2),
       1 + MOD(t.n * 17, 6),
       TIMESTAMP('2026-10-01 00:00:00') + INTERVAL ((t.n * 1468800) DIV 300000) SECOND,
       TIMESTAMP('2026-10-01 00:00:00') + INTERVAL ((t.n * 1468800) DIV 300000) SECOND + INTERVAL MOD(t.n * 13, 7200) SECOND
FROM (SELECT a.n * 1000 + b.n AS n FROM seq_1k a CROSS JOIN seq_1k b WHERE a.n < 300) t
ORDER BY t.n;

DROP TABLE seq_1k;

ANALYZE TABLE customers, orders;
