-- 透传类表函数会在连接器背后的数据库执行任意语句：提交前被 workctl 拒绝
SELECT * FROM TABLE(system.query(query => 'DELETE FROM accounts'))
