# Static file server for both frontends + a reverse proxy to the API.
# Build context is the repo root (see docker-compose.yml) so it can copy
# both site folders.

# ---- stage 1: build the customer portal (Next.js static export) --------
# Node only ever runs at build time — the shipped `ui` image is nginx only,
# serving the exported `out/` files (see customers/AGENTS.md / README.md:
# there is no Node service in production).
FROM node:22-alpine AS customers-build
WORKDIR /src/customers
COPY customers/package.json customers/package-lock.json ./
RUN npm ci
COPY customers/ ./
RUN npm run build

# ---- stage 2: nginx, serving both static sites + proxying /api ---------
FROM nginx:1.27-alpine

COPY ui/nginx.conf /etc/nginx/conf.d/default.conf
COPY drafts/cargo-ship/ /usr/share/nginx/html/cargo-ship/
COPY --from=customers-build /src/customers/out/ /usr/share/nginx/html/customers/

EXPOSE 8080
