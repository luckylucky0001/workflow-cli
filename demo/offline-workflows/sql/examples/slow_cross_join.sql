-- 用于演示取消：故意构造的长查询（自连接放大），只读。
SELECT COUNT(*) AS n
FROM ods_orders a CROSS JOIN ods_orders b CROSS JOIN ods_orders c
WHERE a.amount + b.amount + c.amount > 0
