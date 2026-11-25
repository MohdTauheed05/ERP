"""
SQLite -> PostgreSQL Data & Sequence Migration Utility for PetroBlend Enterprise ERP.

Usage:
  python scripts/migrate_sqlite_to_postgres.py \
      --sqlite ./data/lubricants_erp.db \
      --postgres postgresql://erp_user:erp_pass@localhost:5432/lubricants_erp
"""
import argparse
import sqlite3
import sys

try:
    import psycopg
except ImportError:
    print("Install psycopg first: pip install psycopg[binary]", file=sys.stderr)
    sys.exit(1)


def migrate(sqlite_path: str, pg_dsn: str) -> None:
    sq = sqlite3.connect(sqlite_path)
    sq.row_factory = sqlite3.Row
    tables = [
        r["name"]
        for r in sq.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY rowid ASC"
        ).fetchall()
    ]

    with psycopg.connect(pg_dsn) as pg:
        with pg.cursor() as cur:
            cur.execute("SET session_replication_role = 'replica';")
            for table in tables:
                rows = sq.execute(f'SELECT * FROM "{table}"').fetchall()
                if not rows:
                    continue
                cols = list(rows[0].keys())
                col_list = ", ".join(f'"{c}"' for c in cols)
                placeholders = ", ".join(["%s"] * len(cols))
                cur.execute(f'TRUNCATE TABLE "{table}" RESTART IDENTITY CASCADE;')
                for r in rows:
                    cur.execute(
                        f'INSERT INTO "{table}" ({col_list}) VALUES ({placeholders})',
                        tuple(r[c] for c in cols),
                    )
                if "id" in cols:
                    cur.execute(
                        f"SELECT setval(pg_get_serial_sequence('{table}', 'id'), COALESCE((SELECT MAX(id) FROM \"{table}\"), 1), true);"
                    )
                print(f"Migrated {len(rows)} rows -> {table}")
            cur.execute("SET session_replication_role = 'origin';")
        pg.commit()
    sq.close()
    print("SQLite to PostgreSQL migration completed successfully.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Migrate Lubricants ERP SQLite database to PostgreSQL")
    parser.add_argument("--sqlite", default="./data/lubricants_erp.db", help="Path to SQLite .db file")
    parser.add_argument("--postgres", required=True, help="PostgreSQL connection URI")
    args = parser.parse_args()
    migrate(args.sqlite, args.postgres)
