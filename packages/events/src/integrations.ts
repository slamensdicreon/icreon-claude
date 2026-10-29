import type { SqlClient } from './postgres';

/**
 * App-wide integration settings, such as the Launchworks GitHub App, keyed by name. Values hold
 * vault references in place of secrets.
 */
export interface IntegrationStore {
  get<T>(name: string): Promise<T | null>;
  put(name: string, config: unknown): Promise<void>;
  delete(name: string): Promise<void>;
  /** Every entry whose name starts with `prefix`, by name. */
  list<T>(prefix: string): Promise<{ name: string; config: T }[]>;
}

export class PostgresIntegrationStore implements IntegrationStore {
  constructor(private readonly sql: SqlClient) {}

  async get<T>(name: string): Promise<T | null> {
    const { rows } = await this.sql.query<{ config: T }>(
      'SELECT config FROM lw_integrations WHERE name = $1',
      [name],
    );
    return rows[0]?.config ?? null;
  }

  async put(name: string, config: unknown): Promise<void> {
    await this.sql.query(
      `INSERT INTO lw_integrations (name, config) VALUES ($1, $2::jsonb)
       ON CONFLICT (name) DO UPDATE SET config = EXCLUDED.config, updated_at = now()`,
      [name, JSON.stringify(config)],
    );
  }

  async delete(name: string): Promise<void> {
    await this.sql.query('DELETE FROM lw_integrations WHERE name = $1', [name]);
  }

  async list<T>(prefix: string): Promise<{ name: string; config: T }[]> {
    const { rows } = await this.sql.query<{ name: string; config: T }>(
      'SELECT name, config FROM lw_integrations WHERE starts_with(name, $1) ORDER BY name',
      [prefix],
    );
    return rows;
  }
}

/** In memory: tests and local runs on the memory store. */
export class MemoryIntegrationStore implements IntegrationStore {
  private readonly rows = new Map<string, string>();

  async get<T>(name: string): Promise<T | null> {
    const v = this.rows.get(name);
    return v === undefined ? null : (JSON.parse(v) as T);
  }

  async put(name: string, config: unknown): Promise<void> {
    this.rows.set(name, JSON.stringify(config));
  }

  async delete(name: string): Promise<void> {
    this.rows.delete(name);
  }

  async list<T>(prefix: string): Promise<{ name: string; config: T }[]> {
    return [...this.rows]
      .filter(([name]) => name.startsWith(prefix))
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, v]) => ({ name, config: JSON.parse(v) as T }));
  }
}
