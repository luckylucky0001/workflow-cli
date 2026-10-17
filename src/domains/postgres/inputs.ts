import { readInputFile } from '../../core/engine';
import { WorkError } from '../../core/output';
import type { InputSpec } from '../../core/registry';

export const INSTANCE: InputSpec = { type: 'string', description: 'PostgreSQL 端点名（profile 中 endpoints.postgres 的键；缺省取 defaults.postgres）' };
export const DATABASE_OPT: InputSpec = { type: 'string', description: '要连接的库名；缺省取端点配置的 database（再缺省为 postgres）' };
export const SCHEMA: InputSpec = { type: 'string', default: 'public', description: 'schema 名（区分大小写，按实际名称给出）' };
export const TABLE: InputSpec = { type: 'string', required: true, description: '表名（区分大小写，按实际名称给出，不加双引号）' };
export const SQL_FILE: InputSpec = { type: 'file', description: '包含单条 SQL 语句的文件路径（≤256KB）；与 --sql 二选一' };
export const SQL_INLINE: InputSpec = { type: 'string', description: '直接给出单条 SQL 语句（≤256KB，适合 Agent/MCP 调用）；与 --sql-file 二选一' };

/** Max bytes of SQL text, same budget as readInputFile. */
export const SQL_MAX_BYTES = 256 * 1024;

export const COMMON_PREREQS = [
  'profile 中配置 endpoints.postgres.<name>（host/port/user/password_ref/database）',
  '只读诊断角色（如 workctl_ro）：LOGIN、CONNECT on 目标库、pg_read_all_stats、业务表 SELECT；建议 default_transaction_read_only=on',
];

/** SQL text from exactly one of --sql / --sql-file (same size budget). */
export function sqlText(i: Record<string, unknown>): string {
  const inline = typeof i.sql === 'string' && i.sql.trim() !== '' ? i.sql : undefined;
  const file = i.sql_file !== undefined && i.sql_file !== null && String(i.sql_file) !== '' ? String(i.sql_file) : undefined;
  if (inline !== undefined && file !== undefined) {
    throw new WorkError('INVALID_ARGUMENT', '--sql 与 --sql-file 只能提供一个', { hint: '内联语句用 --sql "SELECT ..."，或把语句写入文件用 --sql-file q.sql' });
  }
  if (inline === undefined && file === undefined) {
    throw new WorkError('INVALID_ARGUMENT', '缺少 SQL：需要 --sql 或 --sql-file 之一', { hint: '例如 --sql "SELECT * FROM orders WHERE id = 1" 或 --sql-file q.sql' });
  }
  if (inline !== undefined) {
    if (Buffer.byteLength(inline, 'utf8') > SQL_MAX_BYTES) throw new WorkError('INVALID_ARGUMENT', `--sql 超过 ${SQL_MAX_BYTES} 字节上限`);
    return inline;
  }
  return readInputFile(file!, SQL_MAX_BYTES);
}
