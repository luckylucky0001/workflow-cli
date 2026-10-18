// Nacos YAML/JSON/properties documents: duplicate keys and keys colliding once flattened are reported
// (key names only), not silently resolved to one value.
import { describe, expect, it } from 'vitest';
import { parseDoc } from '../../src/domains/config/nacos';

describe('nacos document parse warnings', () => {
  it('reports duplicate YAML keys (Spring Boot refuses such files) without leaking values', () => {
    const d = parseDoc('db:\n  password: first-secret\n  pool: 4\n  password: second-secret\nother: 1\n', 'yaml', 'a.yaml');
    expect(d.parsed).toBe(true);
    expect(d.parse_warnings).toHaveLength(1);
    expect(d.parse_warnings[0]).toMatch(/重复键.*db\.password/);
    expect(d.parse_warnings.join(' ')).not.toMatch(/secret/);
  });

  it('reports dotted keys colliding with nested maps on flattening', () => {
    const d = parseDoc('a.b: 1\na:\n  b: 2\n  c: 3\n', 'yaml', 'a.yaml');
    expect(d.parse_warnings.join(' ')).toMatch(/展开后键名冲突.*a\.b/);
    expect(d.parse_warnings.join(' ')).not.toMatch(/a\.c/);
  });

  it('merge keys and clean documents produce no warnings; JSON and properties duplicates are reported', () => {
    expect(parseDoc('base: &b\n  pool: 4\nother:\n  <<: *b\n  pool: 8\n', 'yaml', 'a.yaml').parse_warnings).toEqual([]);
    expect(parseDoc('db:\n  pool: 4\n', 'yaml', 'a.yaml').parse_warnings).toEqual([]);
    expect(parseDoc('{"a":{"b":1,"b":2}}', 'json', 'a.json').parse_warnings.join(' ')).toMatch(/a\.b/);
    expect(parseDoc('x=1\ny=2\nx=3\n', 'properties', 'a.properties').parse_warnings.join(' ')).toMatch(/重复键.*x/);
  });
});
