"""Additive ASGI router. Legacy staff app retains its own middleware/lifespan."""
import asyncio
import os
from contextlib import asynccontextmanager, suppress

from fastapi import FastAPI
from service.app import app as staff_app
from customer_identity.app import create_app
from customer_identity.analyzer import Analyzer


def create_runtime(staff=staff_app):
    customer = create_app()

    @asynccontextmanager
    async def lifespan(app):
        async with staff.router.lifespan_context(staff):
            app.router.routes[0].app = create_app()
            store = None
            # A misconfigured Customer addon must not make HR unavailable.
            if os.environ.get("CUSTOMER_IDENTITY_ENABLED") == "true" and staff.state.ready:
                try:
                    enabled = create_app(Analyzer(staff.state.engine), os.environ.get("CUSTOMER_IDENTITY_API_KEY"),
                        os.environ.get("CUSTOMER_IDENTITY_ORIGIN"),
                        os.environ.get("CUSTOMER_IDENTITY_DB", "/tmp/red-customer-evaluation.sqlite3"))
                    if enabled.state.ready:
                        # Middleware closes over enabled, so replace mounted app.
                        app.router.routes[0].app = enabled
                        store = enabled.state.store
                except Exception:
                    pass
            async def cleanup():
                while True:
                    await asyncio.sleep(30)
                    if store:
                        with suppress(Exception):
                            await asyncio.to_thread(store.purge)
            task = asyncio.create_task(cleanup())
            try:
                yield
            finally:
                task.cancel()
                with suppress(asyncio.CancelledError):
                    await task
                if store:
                    store.close()

    app = FastAPI(lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)
    app.mount("/customer-identity", customer)
    app.mount("/", staff)
    return app


app = create_runtime()
