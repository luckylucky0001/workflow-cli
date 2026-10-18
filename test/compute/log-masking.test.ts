/**
 * Spark driver logs (`compute log get`) get the same credential masking as application logs,
 * with a count in data and a coverage note; the driver failure signal quoted into job status
 * is masked too.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { invoke } from '../../src/core/engine';
import { Registry } from '../../src/core/registry';
import compute from '../../src/domains/compute';
import { driverFailureSignal } from '../../src/domains/compute/spark';
import { tempConfig } from '../offline/fake';

process.env.WORKCTL_VALIDATE_OUTPUT = '1';

describe('compute log get credential masking', () => {
  it('masks URL passwords, Authorization headers and secret parameters in driver log lines', async () => {
    const cfg = tempConfig({});
    writeFileSync(
      join(cfg.dir, 'driver-logs', 'local-777.log'),
      ['INFO start', 'INFO reading jdbc:mysql://etl:Pa55word@db:3306/w?user=etl&password=Pa55word', 'DEBUG Authorization: Basic ZXRsOlBhNTV3b3JkMTIzNDU2', 'INFO done'].join('\n') + '\n',
    );
    const r = new Registry();
    r.addDomain(compute);
    const env = await invoke(r, 'compute.log.get', { job_id: 'local-777' }, { configPath: cfg.path, timeoutMs: 10_000 });
    expect(env.status).toBe('success');
    const d = env.data as any;
    expect(d.lines.join('\n')).not.toMatch(/Pa55word|ZXRsOlBhNTV3b3Jk/);
    expect(d.lines[1]).toBe('INFO reading jdbc:mysql://etl:***@db:3306/w?user=etl&password=***');
    expect(d.credentials_masked).toBe(2);
    expect(env.meta.coverage?.notes?.join(' ')).toMatch(/2 行含凭据/);
  });

  it('driverFailureSignal masks credentials in the quoted exception line', () => {
    const sig = driverFailureSignal(['Exception in thread "main" java.sql.SQLException: cannot connect to postgresql://etl:s3cr3t@db/w']);
    expect(sig).toMatch(/etl:\*\*\*@db/);
    expect(sig).not.toMatch(/s3cr3t/);
  });
});
