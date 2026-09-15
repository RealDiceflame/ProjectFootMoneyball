"""Prepare or import saved NFL stats. Default plan mode never opens a database."""
import argparse
import getpass
import json
import os
from pathlib import Path
import warnings
from urllib.parse import quote, urlsplit

from app.stats_import import import_plan, load_saved_stats

ROOT = Path(__file__).resolve().parent
PASSWORD_PLACEHOLDER = "[YOUR-PASSWORD]"


def prompt_connection_url():
    """Expand a public template in memory only; never fall back to visible input."""
    from app.stats_database import connection_options

    template = os.environ.get("OUTLIER_DATABASE_URL", "")
    marker = "outlier-password-placeholder"
    candidate = template.replace(PASSWORD_PLACEHOLDER, marker)
    if template.count(PASSWORD_PLACEHOLDER) != 1 or urlsplit(candidate).password != marker:
        raise ValueError("The URI must contain the password placeholder in its password field")
    connection_options(candidate)
    with warnings.catch_warnings():
        warnings.simplefilter("error", getpass.GetPassWarning)
        password = getpass.getpass("Supabase database password (hidden): ")
    if not password:
        raise ValueError("A database password is required")
    return template.replace(PASSWORD_PLACEHOLDER, quote(password, safe=""))


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", nargs="?", choices=["plan", "check", "migrate", "import", "status"], default="plan")
    parser.add_argument("--prompt-password", action="store_true",
                        help="Privately enter the password for an OUTLIER_DATABASE_URL containing [YOUR-PASSWORD]")
    args = parser.parse_args(argv)
    if args.command == "plan" and args.prompt_password:
        parser.error("plan is offline and does not need a password")
    try:
        snapshots = load_saved_stats(ROOT) if args.command in {"plan", "import"} else None
        if args.command == "plan":
            print(json.dumps({"mode": "read-only plan", **import_plan(snapshots)}, indent=2))
            return 0
        from app.stats_database import check_connection, connect_database, database_counts, import_snapshots, migrate
        url = prompt_connection_url() if args.prompt_password else None
        with connect_database(url) as conn:
            if args.command == "check":
                check_connection(conn)
                print("Connection successful. No tables or statistics were changed.")
            elif args.command == "migrate":
                print(json.dumps({"migrations_applied": migrate(conn)}))
            elif args.command == "import":
                print(json.dumps(import_snapshots(conn, snapshots)))
                print(json.dumps(database_counts(conn)))
            else:
                print(json.dumps(database_counts(conn), indent=2))
        return 0
    except ImportError:
        print("Database tools are optional. Install requirements-database.txt before connecting.")
    except (getpass.GetPassWarning, EOFError):
        print("Hidden password entry is unavailable. Open a normal local terminal; do not paste your password into chat.")
    except KeyboardInterrupt:
        print("Cancelled. No further database operations were started.")
    except (ValueError, KeyError, TypeError, OSError):
        print("No import completed. Check saved source files, connection settings, and the setup guide.")
    except Exception:
        # Database exception strings may echo connection credentials or source rows.
        print("Database operation failed. No partial import was committed. Check connectivity, permissions, and migrations.")
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
