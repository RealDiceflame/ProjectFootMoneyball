"""Prepare or import saved NFL stats. Default plan mode never opens a database."""
import argparse
import getpass
import json
import os
from pathlib import Path
import warnings
from urllib.parse import quote, unquote, urlsplit

from app.stats_import import import_plan, load_saved_stats
from app.stats_access import DatabaseSafetyError

ROOT = Path(__file__).resolve().parent
PASSWORD_PLACEHOLDER = "[YOUR-PASSWORD]"


def expand_connection_template(template, password):
    """Keep real credentials in process memory, not command arguments or files."""
    from app.stats_database import connection_options

    marker = "outlier-password-placeholder"
    candidate = template.replace(PASSWORD_PLACEHOLDER, marker)
    if template.count(PASSWORD_PLACEHOLDER) != 1 or urlsplit(candidate).password != marker:
        raise ValueError("The URI must contain the password placeholder in its password field")
    connection_options(candidate)
    if not password:
        raise ValueError("A database password is required")
    return template.replace(PASSWORD_PLACEHOLDER, quote(password, safe=""))


def hidden_password(message):
    with warnings.catch_warnings():
        warnings.simplefilter("error", getpass.GetPassWarning)
        return getpass.getpass(message)


def prompt_connection_url():
    """Validate the public template before asking for a hidden password."""
    template = os.environ.get("OUTLIER_DATABASE_URL", "")
    expand_connection_template(template, "validation-only")
    return expand_connection_template(template, hidden_password("Supabase database password (hidden): "))


def sync_connection_url(prompt_password=False):
    """Automatic jobs must use verified TLS and the fixed restricted role."""
    certificate = os.environ.get("OUTLIER_DATABASE_SSLROOTCERT", "")
    if not certificate or not Path(certificate).is_file():
        raise DatabaseSafetyError("Sync requires the database CA certificate for verified TLS.")
    template = os.environ.get("OUTLIER_DATABASE_URL", "")
    candidate = expand_connection_template(template, "validation-only")
    username = urlsplit(candidate).username or ""
    if username != "ob_stats_ingest" and not username.startswith("ob_stats_ingest."):
        raise DatabaseSafetyError("Use the restricted updater connection template, not the administrator template.")
    if prompt_password:
        return prompt_connection_url()
    return expand_connection_template(template, os.environ.get("OUTLIER_DATABASE_PASSWORD", ""))


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", nargs="?", choices=["plan", "check", "migrate", "import", "status", "verify", "prepare-sync", "sync"], default="plan")
    parser.add_argument("--prompt-password", action="store_true",
                        help="Privately enter the password for an OUTLIER_DATABASE_URL containing [YOUR-PASSWORD]")
    args = parser.parse_args(argv)
    if args.command == "plan" and args.prompt_password:
        parser.error("plan is offline and does not need a password")
    if args.command == "prepare-sync" and not args.prompt_password:
        parser.error("prepare-sync requires interactive --prompt-password")
    try:
        if args.command == "prepare-sync":
            certificate = os.environ.get("OUTLIER_DATABASE_SSLROOTCERT", "")
            if not certificate or not Path(certificate).is_file():
                raise DatabaseSafetyError("Updater setup requires the database CA certificate for verified TLS.")
        snapshots = load_saved_stats(ROOT) if args.command in {"plan", "import", "verify", "prepare-sync", "sync"} else None
        if args.command == "plan":
            print(json.dumps({"mode": "read-only plan", **import_plan(snapshots)}, indent=2))
            return 0
        from app.stats_database import check_connection, connect_database, database_counts, import_snapshots, migrate
        url = (sync_connection_url(args.prompt_password) if args.command == "sync"
               else prompt_connection_url() if args.prompt_password else None)
        with connect_database(url) as conn:
            if args.command == "check":
                check_connection(conn)
                print("Connection successful. No tables or statistics were changed.")
            elif args.command == "migrate":
                print(json.dumps({"migrations_applied": migrate(conn)}))
            elif args.command == "import":
                print(json.dumps(import_snapshots(conn, snapshots)))
                print(json.dumps(database_counts(conn)))
            elif args.command == "verify":
                from app.stats_verification import verify_database
                print(json.dumps(verify_database(conn, snapshots), indent=2))
            elif args.command == "prepare-sync":
                from app.stats_access import configure_ingest_login
                from app.stats_verification import verify_database
                print(json.dumps({"migrations_applied": migrate(conn)}))
                print(json.dumps(import_snapshots(conn, snapshots)))
                print(json.dumps(verify_database(conn, snapshots), indent=2))
                print("Save a NEW updater password of at least 24 characters in your password manager.")
                password = hidden_password("New updater password (hidden): ")
                confirmation = hidden_password("Confirm updater password (hidden): ")
                if password != confirmation:
                    raise DatabaseSafetyError("The updater passwords did not match. The login was not enabled.")
                if password == unquote(urlsplit(url).password or ""):
                    raise DatabaseSafetyError("The updater needs a different password from the administrator account.")
                configure_ingest_login(conn, password)
                print("Restricted updater login enabled. Automatic sync remains off until you configure GitHub.")
            elif args.command == "sync":
                from app.stats_access import sync_database
                print(json.dumps(sync_database(conn, snapshots), indent=2))
            else:
                print(json.dumps(database_counts(conn), indent=2))
        return 0
    except ImportError:
        print("Database tools are optional. Install requirements-database.txt before connecting.")
    except (getpass.GetPassWarning, EOFError):
        print("Hidden password entry is unavailable. Open a normal local terminal; do not paste your password into chat.")
    except KeyboardInterrupt:
        print("Cancelled. No further database operations were started.")
    except DatabaseSafetyError as error:
        print(str(error))
    except (ValueError, KeyError, TypeError, OSError):
        print("Operation did not finish. Check source files, connection settings, and the setup guide. Earlier completed steps may remain saved.")
    except Exception:
        # Database exception strings may echo connection credentials or source rows.
        print("Database operation failed. Imports are atomic, but earlier completed steps may remain saved. Check connectivity, permissions, and migrations.")
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
