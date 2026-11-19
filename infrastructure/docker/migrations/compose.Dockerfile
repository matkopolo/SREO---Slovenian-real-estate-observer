# postgres:16.15-bookworm (the same build as the database image), pinned to its digest.
FROM postgres:16.15-bookworm@sha256:5264710be20f409750ac6dc4e5706dcef929c87e241605463f0f9aefa932a8d9
COPY database/migrations/ /migrations/
COPY database/roles.sql /roles.sql
COPY database/run-migrations.sh /run-migrations.sh
RUN sed -i 's/\r$//' /run-migrations.sh && chmod 644 /run-migrations.sh /roles.sql /migrations/*.sql
USER 999:999
ENTRYPOINT ["/bin/bash", "/run-migrations.sh"]
