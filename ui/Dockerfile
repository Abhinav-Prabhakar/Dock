# Static file server for both frontends + a reverse proxy to the API.
# Build context is the repo root (see docker-compose.yml) so it can copy
# both site folders.
FROM nginx:1.27-alpine

COPY ui/nginx.conf /etc/nginx/conf.d/default.conf
COPY drafts/cargo-ship/ /usr/share/nginx/html/cargo-ship/
COPY customers/ /usr/share/nginx/html/customers/

EXPOSE 8080
