import { describe, expect, it } from 'vitest';
import { translate } from '../src/cloudflare/db-do.js';

describe('DO dialect shim', () => {
  it('maps $n placeholders to ? in order of appearance, including out-of-order use', () => {
    const t = translate(`UPDATE mint_quotes SET state = 'PAID', deposit_ref = $2 WHERE id = $1 AND state = 'UNPAID'`, ['q1', 'tx9']);
    expect(t.sql).toBe(`UPDATE mint_quotes SET state = 'PAID', deposit_ref = ? WHERE id = ? AND state = 'UNPAID'`);
    expect(t.bindings).toEqual(['tx9', 'q1']);
  });

  it('strips Postgres-only syntax', () => {
    const t = translate('SELECT count(*)::int AS n FROM spent_secrets WHERE y IN ($1, $2) FOR UPDATE', ['a', 'b']);
    expect(t.sql).toBe('SELECT count(*) AS n FROM spent_secrets WHERE y IN (?, ?) ');
    expect(t.bindings).toEqual(['a', 'b']);
  });

  it('translates schema DDL types and defaults', () => {
    const t = translate('CREATE TABLE IF NOT EXISTS t (created_at TIMESTAMPTZ NOT NULL DEFAULT now(), amount BIGINT)');
    expect(t.sql).toBe('CREATE TABLE IF NOT EXISTS t (created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, amount BIGINT)');
    expect(translate('ALTER TABLE melt_quotes ADD COLUMN IF NOT EXISTS fee BIGINT NOT NULL DEFAULT 0').sql)
      .toBe('ALTER TABLE melt_quotes ADD COLUMN fee BIGINT NOT NULL DEFAULT 0');
  });
});
