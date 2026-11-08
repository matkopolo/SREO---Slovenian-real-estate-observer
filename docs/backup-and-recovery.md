# Local Docker backup and recovery

Named volumes survive `docker compose down`. They do **not** survive
`docker compose down --volumes`. Rebuilding images does not require removing data.

## Back up

These commands avoid binary shell redirection, including in Windows PowerShell:

```sh
docker compose exec db pg_dump -U real_estate -d real_estate -Fc -f /tmp/domoglasnik.dump
docker compose cp db:/tmp/domoglasnik.dump ./domoglasnik.dump
```

Copy the dump to another disk. Do not commit it: it can contain application-user
data. `pg_dump` takes a consistent database snapshot. The downloaded ZIP cache is
not included and can be downloaded again. Keep a note of the Git commit used.

## Verify by restoring separately

Use an unused test database name; never restore over the working database to test
a backup. Run once, with the application's database container already healthy:

```sh
docker compose cp ./domoglasnik.dump db:/tmp/restore-check.dump
docker compose exec db createdb -U real_estate real_estate_restore_check
docker compose exec db pg_restore -U real_estate -d real_estate_restore_check --exit-on-error /tmp/restore-check.dump
docker compose exec db psql -U real_estate -d real_estate_restore_check -c "SELECT count(*) FROM transactions;"
```

Verify counts, analytical publication state, geographic rows and model runs, not
just the command's exit code. A repeated restore should use another new database.
This is a logical backup procedure, not continuous WAL archiving or PITR.
