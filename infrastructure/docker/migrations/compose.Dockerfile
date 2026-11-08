FROM postgres:16-bookworm
COPY database/migrations/ /migrations/
COPY database/run-migrations.sh /run-migrations.sh
RUN sed -i 's/\r$//' /run-migrations.sh && chmod 644 /run-migrations.sh /migrations/*.sql
ENTRYPOINT ["/bin/bash", "/run-migrations.sh"]
