-- 只读查询示例（workctl sql query submit --engine spark）：analytics.daily_orders 各分区汇总。
-- 数仓目录中的表注册为临时视图 <db>_<table>；dt 来自分区目录名 dt=YYYY-MM-DD。
SELECT dt,
       SUM(order_count)               AS orders,
       ROUND(SUM(total_amount), 2)    AS amount,
       COUNT(*)                       AS status_rows,
       MIN(order_date)                AS min_order_date,
       MAX(order_date)                AS max_order_date
FROM analytics_daily_orders
GROUP BY dt
ORDER BY dt
