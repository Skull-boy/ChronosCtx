import type { InStatement, ResultSet } from "@libsql/client";

/**
 * The subset of the database surface a repository needs. Both `Database` and an
 * open `Transaction` satisfy it, so the same function can run standalone or
 * inside a caller-owned transaction without a second implementation.
 */
export interface Sql {
  execute(statement: InStatement): Promise<ResultSet>;
}
