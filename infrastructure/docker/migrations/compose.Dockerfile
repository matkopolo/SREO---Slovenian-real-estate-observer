FROM postgres:16-bookworm
COPY database/migrations/ /migrations/
COPY database/roles.sql /roles.sql
COPY database/run-migrations.sh /run-migrations.sh
RUN sed -i 's/\r$//' /run-migrations.sh && chmod 644 /run-migrations.sh /roles.sql /migrations/*.sql
USER 999:999
ENTRYPOINT ["/bin/bash", "/run-migrations.sh"]
