/**
 * Date columns as ISO strings.
 *
 * Drizzle hands back a `Date` for `timestamptz`, but the driver returns a string
 * on some paths (a raw `sql` projection, a `RETURNING` through a different
 * executor). A DTO whose field is sometimes a `Date` and sometimes a string is a
 * bug waiting on the client, which will call `.slice()` on it and get a different
 * answer depending on which path produced it.
 *
 * So every service converts at the boundary, through here. The three copies this
 * replaces were identical apart from one nullable variant — which is exactly the
 * kind of drift that ends with two endpoints formatting the same column
 * differently.
 */

export function isoDateTime(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

export function isoDateTimeOrNull(value: Date | string | null): string | null {
  return value === null ? null : isoDateTime(value);
}
