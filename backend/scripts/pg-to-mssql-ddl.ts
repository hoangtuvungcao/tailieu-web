/**
 * PostgreSQL → SQL Server DDL converter.
 *
 * A MIGRATION AID, NOT A MIGRATION. It reads the PostgreSQL catalog and emits
 * T-SQL that is close enough to apply and inspect, so the remaining work can be
 * measured rather than guessed at. It is deliberately not clever: where a
 * construct has no mechanical equivalent it emits a `-- TODO` line naming the
 * decision rather than inventing one.
 *
 * Why a converter at all, rather than 53 hand-written tables: the schema keeps
 * changing. A hand-written second schema is a second thing to keep in step, and
 * the drift would be silent — the SQL Server copy would simply be missing a
 * column somebody added in March.
 *
 * What it reads, and what it refuses to guess:
 *
 *   read       columns, types, nullability, defaults, primary keys,
 *              foreign keys, unique indexes (partial → filtered), CHECK
 *              constraints, enum types
 *   refuse     full-text indexes, trigram indexes, expressions in index
 *              definitions, generated columns, triggers, custom functions
 *
 * The refusals are the point. Each one is emitted as a comment so a human sees
 * exactly what did not carry over, in the file, at the place it belongs.
 *
 * Run:  npx tsx scripts/pg-to-mssql-ddl.ts > migrations/mssql/001_schema.sql
 */
import pg from 'pg';

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://tailieu:devpassword@localhost:5432/tailieu';

/**
 * Type mapping.
 *
 * The collation is on every text column rather than set on the database,
 * because a database-level collation would also govern identifier comparison
 * and sorting, and the point here is narrowly the diacritic folding that
 * `immutable_unaccent` used to do. `Latin1_General_100_CI_AI` and NOT
 * `Vietnamese_*` — verified on a real instance: under the Vietnamese collation,
 * `ô` and `đ` are distinct letters and `_AI` does not fold them, so
 * `N'Ôn thi' <> N'On thi'` and every diacritic-free search returns nothing.
 */
const TEXT_COLLATION = 'Latin1_General_100_CI_AI';

interface ColumnRow {
  table_name: string;
  column_name: string;
  data_type: string;
  udt_name: string;
  is_nullable: string;
  column_default: string | null;
  character_maximum_length: number | null;
  numeric_precision: number | null;
  numeric_scale: number | null;
  is_generated: string;
}

/**
 * Indexed text needs a bounded length.
 *
 * `nvarchar(max)` cannot be a key column in any SQL Server index — the error is
 * `Msg 1919: Column 'code' ... is of a type that is invalid for use as a key
 * column in an index`. Postgres has no such restriction on `text`, so this is
 * the one place where the type mapping depends on something other than the
 * type: whether the column is indexed.
 *
 * 450 wide characters is 900 bytes, the classic nonclustered key limit. A value
 * longer than that will now fail on insert where Postgres accepted it — which
 * is why every column this applies to is named in a comment rather than
 * changed quietly.
 */
const INDEXED_TEXT_LENGTH = 450;

function mapType(row: ColumnRow, indexed: boolean): string {
  const text = indexed
    ? `nvarchar(${INDEXED_TEXT_LENGTH})`
    : 'nvarchar(max)';
  switch (row.udt_name) {
    case 'uuid':
      return 'uniqueidentifier';
    case 'text':
      return `${text} COLLATE ${TEXT_COLLATION}`;
    case 'citext':
      // A citext column is case-insensitive by collation, which is what the
      // TEXT_COLLATION above already gives. Nothing extra is needed, but the
      // mapping is called out because it looks like something was dropped.
      return `nvarchar(${indexed ? INDEXED_TEXT_LENGTH : 320}) COLLATE ${TEXT_COLLATION}`;
    case 'varchar':
      return `nvarchar(${row.character_maximum_length ?? 200}) COLLATE ${TEXT_COLLATION}`;
    case 'bpchar':
      return `nchar(${row.character_maximum_length ?? 1}) COLLATE ${TEXT_COLLATION}`;
    case 'timestamptz':
      return 'datetimeoffset(6)';
    case 'timestamp':
      return 'datetime2(6)';
    case 'date':
      return 'date';
    case 'bool':
      return 'bit';
    case 'int4':
      return 'int';
    case 'int2':
      return 'smallint';
    case 'int8':
      return 'bigint';
    case 'float8':
      return 'float';
    case 'float4':
      return 'real';
    case 'numeric':
      return `decimal(${row.numeric_precision ?? 12},${row.numeric_scale ?? 2})`;
    case 'jsonb':
    case 'json':
      return 'nvarchar(max)';
    case 'inet':
      return 'nvarchar(45)';
    default:
      // Enums arrive as their own type name. They become nvarchar plus a CHECK
      // constraint, emitted separately once the labels are known.
      return `nvarchar(60) COLLATE ${TEXT_COLLATION}`;
  }
}

/** `'public'::document_visibility` → `'public'`. Postgres casts have no T-SQL form. */
function stripCasts(expression: string): string {
  return expression.replace(/'([^']*)'::[a-zA-Z_][a-zA-Z0-9_]*/g, "'$1'");
}

/**
 * `WHERE (is_current AND ...)` → `WHERE (is_current = 1 AND ...)`.
 *
 * A filtered index predicate in SQL Server must be a comparison; a bare bit
 * column is a syntax error (`Msg 156: Incorrect syntax near the keyword
 * 'AND'`). Postgres accepts the bare column, so this only breaks on the move.
 */
function fixBooleanPredicate(expression: string, booleanColumns: Set<string>): string {
  let out = expression;
  for (const column of booleanColumns) {
    // Only a bare reference is rewritten. `is_current` already followed by a
    // comparison operator is left alone.
    out = out.replace(new RegExp(`\\b${column}\\b(?![\\s]*[=<>!])`, 'g'), `${column} = 1`);
  }
  return out;
}

function mapDefault(row: ColumnRow): string | null {
  const value = row.column_default;
  if (value === null) return null;

  if (value === 'gen_random_uuid()') return 'NEWID()';
  if (value === 'now()') return 'SYSDATETIMEOFFSET()';
  if (value === 'true') return '1';
  if (value === 'false') return '0';
  // `'(.*)'::type` → `N'...'`. Written as one anchored regex rather than
  // `slice(1, indexOf('::'))`, which produced `DEFAULT general',` — an
  // off-by-one that leaves a stray quote and a syntax error.
  const castString = /^'(.*)'::[a-zA-Z_][a-zA-Z0-9_]*$/.exec(value);
  if (castString) return `N'${castString[1]}'`;

  const plainString = /^'(.*)'$/.exec(value);
  if (plainString) return `N'${plainString[1]}'`;

  if (/^-?\d+(\.\d+)?$/.test(value)) return value;
  return null; // Anything else is emitted as a TODO at the call site.
}

async function main(): Promise<void> {
  const client = new pg.Client({ connectionString: DATABASE_URL });
  await client.connect();

  const out: string[] = [];
  const say = (line = '') => out.push(line);
  /** Emitted after every table, for the reason given at the call site. */
  const deferredForeignKeys: {
    table: string;
    constraint_name: string;
    column_name: string;
    foreign_table: string;
    foreign_column: string;
    delete_rule: string;
  }[] = [];

  say('-- =============================================================================');
  say('-- SQL Server 2017 schema — GENERATED, then hand-finished.');
  say('-- =============================================================================');
  say('-- Produced by scripts/pg-to-mssql-ddl.ts from the PostgreSQL catalog.');
  say('-- Every "-- TODO" below marks a construct with no mechanical equivalent.');
  say(`-- Text collation: ${TEXT_COLLATION} — see the header of the converter for why`);
  say('-- this and not Vietnamese_*, which does not fold ô or đ.');
  say('-- =============================================================================');
  say();
  say('-- Required for filtered indexes and computed columns. sqlcmd does not');
  say('-- always default it on, and the failure is a confusing `Msg 1934`.');
  say('SET QUOTED_IDENTIFIER ON;');
  say('GO');
  say('SET ANSI_NULLS ON;');
  say('GO');
  say('SET ANSI_PADDING ON;');
  say('GO');
  say('IF SCHEMA_ID(N\'dbo\') IS NULL EXEC(N\'CREATE SCHEMA dbo\');');
  say('GO');
  say();

  const tables = await client.query<{ table_name: string }>(`
    SELECT table_name FROM information_schema.tables
     WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
     ORDER BY table_name
  `);

  say(`-- ${tables.rows.length} tables`);
  say();

  // Which columns appear in any index. Needed before the columns are emitted,
  // because it is what decides `nvarchar(max)` versus a bounded length.
  const constraintIndexes = (
    await client.query<{ table_name: string; index_name: string }>(`
      SELECT c.relname AS table_name, i.relname AS index_name
        FROM pg_constraint con
        JOIN pg_class c ON c.oid = con.conrelid
        JOIN pg_class i ON i.oid = con.conindid
       WHERE con.contype IN ('p', 'u')
    `)
  ).rows;

  const booleanColumns = new Set<string>();
  const indexed = await client.query<{ table_name: string; column_name: string }>(`
    SELECT c.relname AS table_name, a.attname AS column_name
      FROM pg_index i
      JOIN pg_class c ON c.oid = i.indrelid
      JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = ANY(i.indkey)
     WHERE c.relkind = 'r' AND a.attnum > 0
     GROUP BY c.relname, a.attname
  `);
  const indexedColumns = new Set(
    indexed.rows.map((row) => `${row.table_name}.${row.column_name}`),
  );
  say(`-- ${indexedColumns.size} indexed columns given a bounded length`);

  for (const { table_name } of tables.rows) {
    const columns = await client.query<ColumnRow>(
      `SELECT table_name, column_name, data_type, udt_name, is_nullable,
              column_default, character_maximum_length, numeric_precision,
              numeric_scale, is_generated
         FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = $1
        ORDER BY ordinal_position`,
      [table_name],
    );

    say(`-- ----------------------------------------------------------------------------`);
    say(`-- ${table_name}`);
    say(`-- ----------------------------------------------------------------------------`);
    say(`CREATE TABLE dbo.[${table_name}] (`);

    const definitions: string[] = [];
    for (const column of columns.rows) {
      if (column.is_generated === 'ALWAYS') {
        say(`  -- TODO generated column: ${column.column_name} (Postgres computes it; SQL Server needs a computed column or a trigger)`);
        continue;
      }

      if (column.udt_name === 'bool') booleanColumns.add(`${table_name}.${column.column_name}`);
      const isSequence = column.column_default?.startsWith('nextval(') ?? false;
      const type = isSequence
        ? // A Postgres `bigserial` becomes an IDENTITY column. It cannot be
          // given a DEFAULT as well, so the default is dropped rather than
          // mapped.
          `${column.udt_name === 'int4' ? 'int' : 'bigint'} IDENTITY(1,1)`
        : mapType(column, indexedColumns.has(`${table_name}.${column.column_name}`));
      const nullable = column.is_nullable === 'YES' ? 'NULL' : 'NOT NULL';
      const fallback = isSequence ? null : mapDefault(column);
      const defaultClause =
        fallback !== null
          ? ` DEFAULT ${fallback}`
          : !isSequence && column.column_default
            ? ` /* TODO default: ${column.column_default} */`
            : '';

      definitions.push(`  [${column.column_name}] ${type} ${nullable}${defaultClause}`);
    }

    // Primary keys.
    const pk = await client.query<{ column_name: string }>(
      `SELECT kcu.column_name
         FROM information_schema.table_constraints tc
         JOIN information_schema.key_column_usage kcu
           ON kcu.constraint_name = tc.constraint_name AND kcu.table_schema = tc.table_schema
        WHERE tc.table_schema = 'public' AND tc.table_name = $1 AND tc.constraint_type = 'PRIMARY KEY'
        ORDER BY kcu.ordinal_position`,
      [table_name],
    );
    if (pk.rows.length > 0) {
      definitions.push(
        `  CONSTRAINT [${table_name}_pk] PRIMARY KEY (${pk.rows.map((r) => `[${r.column_name}]`).join(', ')})`,
      );
    }

    say(definitions.join(',\n'));
    say(');');
    say('GO');
    say();

    // Foreign keys.
    const fks = await client.query<{
      constraint_name: string;
      column_name: string;
      foreign_table: string;
      foreign_column: string;
      delete_rule: string;
    }>(
      `SELECT tc.constraint_name, kcu.column_name,
              ccu.table_name AS foreign_table, ccu.column_name AS foreign_column,
              rc.delete_rule
         FROM information_schema.table_constraints tc
         JOIN information_schema.key_column_usage kcu
           ON kcu.constraint_name = tc.constraint_name AND kcu.table_schema = tc.table_schema
         JOIN information_schema.constraint_column_usage ccu
           ON ccu.constraint_name = tc.constraint_name AND ccu.table_schema = tc.table_schema
         JOIN information_schema.referential_constraints rc
           ON rc.constraint_name = tc.constraint_name AND rc.constraint_schema = tc.table_schema
        WHERE tc.table_schema = 'public' AND tc.table_name = $1 AND tc.constraint_type = 'FOREIGN KEY'`,
      [table_name],
    );
    // Collected, not emitted here. Tables are walked alphabetically, so
    // `audit_logs` comes before `users` and its FK fails with `Msg 1767:
    // references invalid table`. Every foreign key is written at the end,
    // once all 53 tables exist.
    for (const fk of fks.rows) {
      deferredForeignKeys.push({ table: table_name, ...fk });
    }

    // Indexes.
    const indexes = await client.query<{ indexname: string; indexdef: string }>(
      `SELECT indexname, indexdef FROM pg_indexes
        WHERE schemaname = 'public' AND tablename = $1 ORDER BY indexname`,
      [table_name],
    );
    // Indexes that merely back a constraint are skipped. `pg_indexes` renders a
    // primary key as a plain `CREATE UNIQUE INDEX`, so checking the definition
    // text misses it and every table ends up with a redundant second unique
    // index on its id column.
    const backingIndexes = new Set(
      constraintIndexes.filter((row) => row.table_name === table_name).map((row) => row.index_name),
    );

    for (const index of indexes.rows) {
      if (backingIndexes.has(index.indexname)) continue;

      const unique = index.indexdef.includes('CREATE UNIQUE INDEX');
      const using = /USING (\w+)/.exec(index.indexdef)?.[1] ?? 'btree';
      const columnsPart = /\(([^)]*)\)/.exec(index.indexdef.replace(/ USING \w+/, ''))?.[1] ?? '';
      const where = /WHERE (.+)$/.exec(index.indexdef)?.[1];

      if (using === 'gin' || index.indexdef.includes('gin_trgm_ops') || index.indexdef.includes('tsvector') || index.indexdef.includes('tsv')) {
        say(`-- TODO full-text or trigram index: ${index.indexname}`);
        say(`--      ${index.indexdef}`);
        say('--      SQL Server has no trigram equivalent, and Full-Text Search is a separate component.');
        say();
        continue;
      }

      if (/lower\(|immutable_unaccent\(|\(.*\)/.test(columnsPart)) {
        say(`-- TODO expression index: ${index.indexname}`);
        say(`--      ${index.indexdef}`);
        say('--      SQL Server indexes a persisted computed column, not an expression.');
        say();
        continue;
      }

      // Direction is per column, not per index — `(a DESC, b)` is a different
      // index from `(a, b DESC)`, and appending DESC to the whole list would
      // silently produce a third thing.
      const cols = columnsPart
        .split(',')
        .map((c) => c.trim())
        .filter(Boolean)
        .map((c) => {
          // `created_at DESC NULLS LAST` — Postgres's null ordering has no
          // T-SQL form, and leaving it in made the column name
          // `[created_at DESC NULLS LAST]`, a syntax error.
          const name = c.replace(/\s+NULLS\s+(FIRST|LAST)$/i, '').replace(/\s+(DESC|ASC)$/i, '').trim();
          const direction = /\s+DESC(\s+NULLS|$)/i.test(c) ? ' DESC' : '';
          return `[${name}]${direction}`;
        });

      say(`CREATE ${unique ? 'UNIQUE ' : ''}INDEX [${index.indexname}] ON dbo.[${table_name}] (${cols.join(', ')})`);
      if (where) {
        // Partial index → filtered index. SQL Server rejects OR and IN here,
        // and rejects non-deterministic predicates. The predicate text comes
        // straight from `pg_indexes`, so Postgres casts have to be stripped.
        const cleaned = stripCasts(where);
        const booleans = new Set(
          [...booleanColumns]
            .filter((entry) => entry.startsWith(`${table_name}.`))
            .map((entry) => entry.slice(table_name.length + 1)),
        );
        say(`  WHERE ${fixBooleanPredicate(cleaned, booleans)};`);
      } else {
        say(';');
      }
      say('GO');
      say();
    }
  }

  say('-- =============================================================================');
  say(`-- ${deferredForeignKeys.length} foreign keys, after every table exists`);
  say('-- =============================================================================');
  say();
  for (const fk of deferredForeignKeys) {
    const action = fk.delete_rule === 'CASCADE' ? ' ON DELETE CASCADE' : '';
    say(`ALTER TABLE dbo.[${fk.table}] ADD CONSTRAINT [${fk.constraint_name}]`);
    say(`  FOREIGN KEY ([${fk.column_name}]) REFERENCES dbo.[${fk.foreign_table}]([${fk.foreign_column}])${action};`);
    say('GO');
  }
  say();

  // Enums → CHECK constraints.
  // `string_agg`, not `array_agg`: node-postgres has no parser for an array of
  // a user-defined enum type, so `array_agg` comes back as the literal string
  // `{a,b,c}` and `.map` on it throws. Enum labels are identifiers, so a comma
  // separator is unambiguous.
  const enums = await client.query<{ typname: string; labels: string }>(`
    SELECT t.typname, string_agg(e.enumlabel, ',' ORDER BY e.enumsortorder) AS labels
      FROM pg_type t JOIN pg_enum e ON e.enumtypid = t.oid
     GROUP BY t.typname ORDER BY t.typname
  `);

  say('-- =============================================================================');
  say(`-- ${enums.rows.length} enum types → CHECK constraints`);
  say('-- =============================================================================');
  say('-- PostgreSQL enforces the label set at the type level. SQL Server has no enum,');
  say('-- so the constraint has to be re-stated on every column that used one.');
  say();

  const enumColumns = await client.query<{ table_name: string; column_name: string; udt_name: string }>(`
    SELECT c.table_name, c.column_name, c.udt_name
      FROM information_schema.columns c
      JOIN pg_type t ON t.typname = c.udt_name
     WHERE c.table_schema = 'public' AND t.typtype = 'e'
     ORDER BY c.table_name, c.column_name
  `);

  for (const column of enumColumns.rows) {
    const labels = (enums.rows.find((e) => e.typname === column.udt_name)?.labels ?? '').split(',').filter(Boolean);
    const list = labels.map((l) => `'${l}'`).join(', ');
    say(`ALTER TABLE dbo.[${column.table_name}] ADD CONSTRAINT [${column.table_name}_${column.column_name}_chk]`);
    say(`  CHECK ([${column.column_name}] IN (${list}));`);
    say('GO');
  }
  say();

  say('-- =============================================================================');
  say('-- NOT CONVERTED — each needs a decision, not a translation');
  say('-- =============================================================================');
  say('-- · Triggers and functions in src/db/sql/post.sql (392 lines of PL/pgSQL).');
  say('-- · The 19 CHECK constraints in post.sql that are not enum checks.');
  say('-- · immutable_unaccent() — replaced by the collation above, which is not');
  say('--   identical; the folding tests must be re-run after the move.');
  say('-- · Full-text search: the tsvector column, its GIN index, and ts_rank_cd.');

  process.stdout.write(out.join('\n') + '\n');
  await client.end();
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
