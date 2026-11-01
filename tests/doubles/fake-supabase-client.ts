/**
 * FAKE test double: a lightweight, in-memory implementation of the subset of the
 * Supabase client used by server-side services.
 *
 * Unlike a stub (canned answers) or a mock (pre-programmed expectations), a fake
 * has real working behaviour: rows are stored in memory, `eq()` filters, `order()`
 * sorts, `insert()`/`update()`/`upsert()`/`delete()` mutate state, and `single()` /
 * `maybeSingle()` follow PostgREST semantics (PGRST116 when a single row is
 * requested but zero or many rows match). Tests can therefore assert on resulting
 * state instead of on the exact sequence of calls.
 *
 * Simplifications: column projections in `select()` are ignored (whole rows are
 * returned), and joins such as `tasks!inner(*)` are modelled by seeding nested
 * objects directly on the row.
 */

export type Row = Record<string, unknown>;

export interface FakeDbError {
  message: string;
  code?: string;
}

export interface FakeResult<T = unknown> {
  data: T;
  error: FakeDbError | null;
}

export interface FakeUser {
  id: string;
  email?: string;
}

export type RpcHandler = (params: Record<string, unknown>) => FakeResult | Promise<FakeResult>;

const NO_ROWS_ERROR: FakeDbError = {
  code: 'PGRST116',
  message: 'JSON object requested, multiple (or no) rows returned',
};

type Operation = 'select' | 'insert' | 'update' | 'upsert' | 'delete';

class FakeQueryBuilder implements PromiseLike<FakeResult> {
  private operation: Operation = 'select';
  private payload: Row = {};
  private returnRows = false;
  private readonly filters: Array<[string, unknown]> = [];
  private readonly orderings: Array<{ column: string; ascending: boolean }> = [];
  private rowLimit: number | null = null;

  constructor(
    private readonly db: FakeSupabaseClient,
    private readonly table: string
  ) {}

  select(_columns = '*'): this {
    if (this.operation === 'select') return this;
    this.returnRows = true; // `.insert(...).select()` returns the written rows
    return this;
  }

  insert(row: Row): this {
    this.operation = 'insert';
    this.payload = row;
    return this;
  }

  update(patch: Row): this {
    this.operation = 'update';
    this.payload = patch;
    return this;
  }

  upsert(row: Row): this {
    this.operation = 'upsert';
    this.payload = row;
    return this;
  }

  delete(): this {
    this.operation = 'delete';
    return this;
  }

  eq(column: string, value: unknown): this {
    this.filters.push([column, value]);
    return this;
  }

  order(column: string, options: { ascending?: boolean } = {}): this {
    this.orderings.push({ column, ascending: options.ascending ?? true });
    return this;
  }

  limit(count: number): this {
    this.rowLimit = count;
    return this;
  }

  async single(): Promise<FakeResult<Row | null>> {
    const { data, error } = await this.execute();
    if (error) return { data: null, error };
    const rows = data ?? [];
    if (rows.length !== 1) return { data: null, error: NO_ROWS_ERROR };
    return { data: rows[0], error: null };
  }

  async maybeSingle(): Promise<FakeResult<Row | null>> {
    const { data, error } = await this.execute();
    if (error) return { data: null, error };
    const rows = data ?? [];
    if (rows.length > 1) return { data: null, error: NO_ROWS_ERROR };
    return { data: rows[0] ?? null, error: null };
  }

  then<TResult1 = FakeResult, TResult2 = never>(
    onfulfilled?: ((value: FakeResult) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null
  ): PromiseLike<TResult1 | TResult2> {
    return this.execute().then(onfulfilled, onrejected);
  }

  private matches(row: Row): boolean {
    return this.filters.every(([column, value]) => row[column] === value);
  }

  private async execute(): Promise<FakeResult<Row[] | null>> {
    const injected = this.db.takeInjectedError(this.table);
    if (injected) return { data: null, error: injected };

    const rows = this.db.rows(this.table);
    // Like a real database, values are copied on the way in and out, never shared by reference
    const payload = structuredClone(this.payload);
    const copy = (written: Row[]) => (this.returnRows ? structuredClone(written) : null);

    switch (this.operation) {
      case 'select': {
        const selected = rows.filter((row) => this.matches(row)).sort((a, b) => this.compare(a, b));
        return { data: structuredClone(this.rowLimit === null ? selected : selected.slice(0, this.rowLimit)), error: null };
      }
      case 'insert': {
        const now = this.db.now();
        const inserted: Row = { id: this.db.nextId(), created_at: now, updated_at: now, ...payload };
        rows.push(inserted);
        return { data: copy([inserted]), error: null };
      }
      case 'update': {
        const updated = rows.filter((row) => this.matches(row));
        updated.forEach((row) => Object.assign(row, payload));
        return { data: copy(updated), error: null };
      }
      case 'upsert': {
        const key = this.db.primaryKeyOf(this.table);
        const existing = rows.find((row) => row[key] !== undefined && row[key] === payload[key]);
        let written: Row;
        if (existing) {
          written = Object.assign(existing, payload);
        } else {
          const now = this.db.now();
          written = { [key]: this.db.nextId(), created_at: now, updated_at: now, ...payload };
          rows.push(written);
        }
        return { data: copy([written]), error: null };
      }
      case 'delete': {
        const removed = rows.filter((row) => this.matches(row));
        this.db.replaceRows(this.table, rows.filter((row) => !this.matches(row)));
        return { data: copy(removed), error: null };
      }
    }
  }

  private compare(a: Row, b: Row): number {
    for (const { column, ascending } of this.orderings) {
      const left = a[column] as string | number;
      const right = b[column] as string | number;
      if (left === right) continue;
      const direction = left < right ? -1 : 1;
      return ascending ? direction : -direction;
    }
    return 0;
  }
}

export interface FakeSupabaseOptions {
  /** Signed-in user returned by `auth.getUser()`; `null` simulates an anonymous request. */
  user?: FakeUser | null;
  /** Initial table contents. Rows are copied, so fixtures can be reused between tests. */
  tables?: Record<string, object[]>;
  /** Conflict target used by `upsert()`, per table. Defaults to `id`. */
  primaryKeys?: Record<string, string>;
}

export class FakeSupabaseClient {
  private user: FakeUser | null;
  private readonly tables = new Map<string, Row[]>();
  private readonly primaryKeys: Record<string, string>;
  private readonly rpcHandlers = new Map<string, RpcHandler>();
  private readonly injectedErrors = new Map<string, FakeDbError>();
  private idSequence = 0;

  readonly auth = {
    getUser: async (): Promise<FakeResult<{ user: FakeUser | null }>> => ({
      data: { user: this.user },
      error: null,
    }),
  };

  constructor(options: FakeSupabaseOptions = {}) {
    this.user = options.user ?? null;
    this.primaryKeys = options.primaryKeys ?? {};
    for (const [table, rows] of Object.entries(options.tables ?? {})) {
      this.seed(table, ...rows);
    }
  }

  from(table: string): FakeQueryBuilder {
    return new FakeQueryBuilder(this, table);
  }

  async rpc(fn: string, params: Record<string, unknown> = {}): Promise<FakeResult> {
    const handler = this.rpcHandlers.get(fn);
    if (!handler) {
      return { data: null, error: { code: 'PGRST202', message: `Could not find the function public.${fn}` } };
    }
    return handler(params);
  }

  // ---- test configuration helpers -------------------------------------------------

  signInAs(user: FakeUser | null): void {
    this.user = user;
  }

  onRpc(fn: string, handler: RpcHandler): void {
    this.rpcHandlers.set(fn, handler);
  }

  /** The next query against `table` resolves with `error` instead of touching the data. */
  failNextQuery(table: string, error: FakeDbError): void {
    this.injectedErrors.set(table, error);
  }

  seed(table: string, ...rows: object[]): void {
    this.rows(table).push(...rows.map((row) => structuredClone(row) as Row));
  }

  /** Live view of a table's rows (mutations are visible to the service under test). */
  rows(table: string): Row[] {
    if (!this.tables.has(table)) this.tables.set(table, []);
    return this.tables.get(table)!;
  }

  // ---- internals used by the query builder ----------------------------------------

  replaceRows(table: string, rows: Row[]): void {
    this.tables.set(table, rows);
  }

  takeInjectedError(table: string): FakeDbError | undefined {
    const error = this.injectedErrors.get(table);
    this.injectedErrors.delete(table);
    return error;
  }

  primaryKeyOf(table: string): string {
    return this.primaryKeys[table] ?? 'id';
  }

  nextId(): string {
    this.idSequence += 1;
    return `00000000-0000-4000-8000-${String(this.idSequence).padStart(12, '0')}`;
  }

  now(): string {
    return new Date().toISOString();
  }
}
