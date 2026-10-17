-- daily_orders: aggregate one business date of ODS orders per order status.
-- Input view `ods_orders` = warehouse/ods/orders/dt=${business_date} (registered by sql_runner.py).
-- Output partition: warehouse/analytics/daily_orders/dt=${business_date} (overwrite_partition).
SELECT
  CAST('${business_date}' AS DATE)              AS order_date,
  status,
  COUNT(*)                                       AS order_count,
  CAST(ROUND(SUM(amount), 2) AS DECIMAL(18, 2))  AS total_amount,
  CAST(ROUND(AVG(amount), 2) AS DECIMAL(18, 2))  AS avg_amount,
  COUNT(DISTINCT customer_id)                    AS customer_count
FROM ods_orders
GROUP BY status
ORDER BY status
