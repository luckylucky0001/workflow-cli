-- The query demo-order runs for GET /customers/:id/orders (orders.customer_id has no index).
SELECT id, status, amount, created_at FROM orders WHERE customer_id = 77 ORDER BY created_at DESC LIMIT 20
