# Dock

Dynamic revenue management for a container-shipping fleet: a live FastAPI
simulator/backend (`backend/`), a customer booking site (`customers/`), and
a port-operator console (`drafts/cargo-ship/`). See `README.md` for the
quick start and `docs/INTEGRATION_PLAN.md` for the current integration work.

The customer-facing site (`customers/`) is a Next.js project (App Router,
static export — `npm run build` in `customers/` produces `customers/out/`,
which is what nginx and the backend's `/customers` mount actually serve;
there is no Node server in production). The port-operator console
(`drafts/cargo-ship/`) is still the hand-built static site it always was,
served by the same nginx at `/`.
