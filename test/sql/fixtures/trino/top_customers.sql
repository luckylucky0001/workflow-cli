-- 25 行结果：用于演示预览截断（preview ≤ 20 行，preview_truncated=true）
SELECT c.custkey, c.name, n.name AS nation, count(*) AS orders
FROM tpch.tiny.customer c
JOIN tpch.tiny.orders o ON o.custkey = c.custkey
JOIN tpch.tiny.nation n ON n.nationkey = c.nationkey
GROUP BY c.custkey, c.name, n.name
ORDER BY orders DESC, c.custkey
LIMIT 25
