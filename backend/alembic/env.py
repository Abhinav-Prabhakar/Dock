"""Alembic environment — hand-written revisions only, no autogenerate, so
there's no ORM metadata to import here. DATABASE_URL comes from the
environment (server/db.py's default), same as the running app."""

from __future__ import annotations

from logging.config import fileConfig

from alembic import context

from server.db import DATABASE_URL, engine

config = context.config
if config.config_file_name is not None:
    fileConfig(config.config_file_name)
config.set_main_option("sqlalchemy.url", DATABASE_URL)


def run_migrations_offline() -> None:
    context.configure(url=DATABASE_URL, literal_binds=True)
    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    with engine.connect() as connection:
        context.configure(connection=connection)
        with context.begin_transaction():
            context.run_migrations()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
