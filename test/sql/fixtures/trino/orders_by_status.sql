-- tpch.tiny.orders: 订单数与金额按状态汇总（Trino 内置 tpch catalog，确定性生成数据）
SELECT orderstatus, count(*) AS orders, round(sum(totalprice), 2) AS total_price
FROM tpch.tiny.orders
GROUP BY orderstatus
ORDER BY orderstatus;
