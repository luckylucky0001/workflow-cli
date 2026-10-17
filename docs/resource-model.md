# 资源模型

跨系统组合依赖稳定的关联信息。workctl 用三层对象把服务、实例、任务和数据连起来：

```text
profile ──► endpoints (kind/name: mysql/demo-mysql, airflow/demo-airflow …)   怎么连
   │
   └──► resources_file ──► resources (id, type, env, endpoint) + relations     是什么、和谁有关
                                                    │
                    capability inputs  ◄────────────┘  (--instance demo-mysql, --workflow …)
```

## 资源（resource）

| 字段 | 说明 |
| --- | --- |
| `id` | 稳定标识；与命令参数一致（如 `demo-mysql`、`demo-daily-orders`、`analytics.daily_orders`） |
| `type` | `service`、`container.workload`、`mysql.instance`、`redis.instance`、`mq.cluster`、`observability.metrics`、`offline.scheduler`、`offline.workflow`、`compute.engine`、`compute.pool`、`data.table` … |
| `env` | 环境（sandbox / staging / prod） |
| `endpoint` | 对应 profile 中的 `{kind, name}`，说明用哪个端点访问该资源 |
| `owner`、`labels`、`attributes` | 负责人、标签和类型特有属性（如容器标签、输出表） |

## 关系（relation）

| 类型 | 含义 | 示例 |
| --- | --- | --- |
| `depends_on` | 运行时依赖 | demo-order → demo-mysql |
| `runs_on` | 运行于 | demo-order → demo-order-workload；demo-daily-orders → demo-spark |
| `reads_from` / `writes_to` | 数据读写 | demo-daily-orders → ods.orders |
| `produces` / `consumes` | 数据产出 / 消费 | demo-daily-orders → analytics.daily_orders |
| `scheduled_by` | 调度归属 | demo-daily-orders → demo-airflow |
| `stores_in`、`exposed_by` | 存储位置、对外暴露 | |

**每条关系必须带 `source`**（`binding-file`、`service-config`、`scheduler-metadata`、`catalog-metadata` …），最好带 `evidence`（如“demo-order env MYSQL_HOST=mysql”）。没有依据的关系不录入；workctl 不会根据名称相似推断依赖。

## 关系来源的优先级

1. 平台元数据（调度器 DAG 依赖、数据目录血缘、服务注册信息）——`relation: explicit`
2. 服务配置（连接串、环境变量、部署描述）——`source: service-config`
3. 运行时证据（调用链、日志中的下游调用）——用于交叉验证，`relation: derived`
4. 演示环境的绑定文件——`source: binding-file`

客户环境应把 `resources_file` 替换为资产/服务目录适配器（同一 `ResourceStore` 接口），绑定文件只用于演示或补充。

## 时间与数据区间

| 概念 | 字段 | 说明 |
| --- | --- | --- |
| 观测时间 | `meta.sources[].observed_at` | 结果采集时刻 |
| 时间窗口 | `meta.coverage.window` | 指标/日志/采样的起止时间 |
| 业务数据区间 | `data_interval`（离线） | 业务日期在业务时区内的 `[start, end)`；与任务启动时间不同 |
| 计划时间 / 实际执行 | `logical_date`、`start_date`、`end_date` | 调度器语义，按版本适配 |

## 演示环境绑定

见 [demo/environment/bindings.yaml](../demo/environment/bindings.yaml)：在线服务 demo-order 依赖 MySQL 与 Redis；离线工作流 demo-ods-orders → ods.orders → demo-daily-orders → analytics.daily_orders，运行于 Spark 与 Airflow 资源池。

```bash
workctl --json resource list --service demo-order --env sandbox
workctl --json service dependency list --service demo-order --env sandbox
workctl --json resource get --id analytics.daily_orders
```
