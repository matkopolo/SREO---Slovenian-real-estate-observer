# postgres:16.15-bookworm (the same build as the database image), pinned to its digest.
FROM postgres:18.6-bookworm@sha256:f1ea2a1a4fb7b68d4836be1fdcb8a6466a89b072158bf9d97663600538c294c5
COPY database/migrations/ /migrations/
COPY database/roles.sql /roles.sql
COPY database/run-migrations.sh /run-migrations.sh
RUN sed -i 's/\r$//' /run-migrations.sh && chmod 644 /run-migrations.sh /roles.sql /migrations/*.sql
USER 999:999
ENTRYPOINT ["/bin/bash", "/run-migrations.sh"]
