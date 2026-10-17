-- 用于演示取消：tpch.sf1 lineitem(6M) × orders(1.5M) 笛卡尔积，不会在合理时间内结束
SELECT count(*) AS n FROM tpch.sf1.lineitem a CROSS JOIN tpch.sf1.orders b
