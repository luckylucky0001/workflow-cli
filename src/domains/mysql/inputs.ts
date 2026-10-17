import type { InputSpec } from '../../core/registry';

export const INSTANCE: InputSpec = { type: 'string', description: 'MySQL 端点名（profile 中 endpoints.mysql 的键；缺省取 defaults.mysql）' };
export const DATABASE: InputSpec = { type: 'string', required: true, description: '库名（schema）' };
export const TABLE: InputSpec = { type: 'string', required: true, description: '表名' };
export const SQL_FILE: InputSpec = { type: 'file', required: true, description: '包含单条 SQL 语句的文件路径（≤256KB）' };

export const COMMON_PREREQS = [
  'profile 中配置 endpoints.mysql.<name>（host/port/user/password_ref）',
  '只读诊断账号（如 workctl_ro）：SELECT on 业务库与 performance_schema.*、SELECT on mysql.slow_log、PROCESS',
];
