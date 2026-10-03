# Phase 16: production Docker image for the dashboard. Multi-stage:
# build the static Vite bundle, then serve it from nginx -- no Vite
# dev server, no Node runtime at all in the final image.
#
# nginx also reverse-proxies /api and /ws to the api service (by
# Docker Compose service name -- see infra/docker-compose.prod.yml),
# so in that deployment this container is the SINGLE public entry
# point for the whole application: the API and its Postgres/RabbitMQ
# dependencies are never directly exposed. If the dashboard is instead
# served from a separate static host/CDN in production (the
# "prefer frontend static/CDN" architecture note), point that host's
# own edge config at the API's real public origin instead of relying
# on this nginx proxy -- see docs/deployment.md.

FROM node:22-alpine AS build
WORKDIR /repo

COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY apps/dashboard/package.json apps/dashboard/package.json

RUN npm ci

COPY apps/dashboard ./apps/dashboard
RUN npm run build -w apps/dashboard

FROM nginx:1.27-alpine AS production
COPY --from=build /repo/apps/dashboard/dist /usr/share/nginx/html

# Templated instead of a static conf.d file: nginx's own built-in
# docker-entrypoint scripts (20-envsubst-on-templates.sh, included in
# this base image) run envsubst over every file in
# /etc/nginx/templates/*.template at container start and write the
# result into /etc/nginx/conf.d/ with the .template suffix stripped --
# no custom entrypoint script needed. NGINX_ENVSUBST_FILTER scopes
# substitution to ONLY $API_ORIGIN/$DNS_RESOLVER, so nginx's own
# request-time variables in nginx.conf.template are left untouched --
# without this filter, envsubst would blank those out too, since they
# are not actually set as container environment variables. The
# defaults below reproduce today's hardcoded values exactly, so this
# is a no-op unless API_ORIGIN/DNS_RESOLVER are explicitly overridden
# at deploy time.
#
# DNS_RESOLVER feeds nginx's `resolver` directive (see
# nginx.conf.template), which -- together with that template's `set
# $api_upstream ...` -- makes nginx re-resolve API_ORIGIN's hostname on
# a TTL instead of caching it once at startup for the life of the
# worker process. Defaults to Docker's own embedded DNS (127.0.0.11),
# so infra/docker-compose.prod.yml's local behavior is unchanged;
# override to a real DNS server (set in the deployment platform's own
# environment config, not here) when API_ORIGIN points at a public
# hostname whose backing IP(s) can change over time.
COPY apps/dashboard/nginx.conf.template /etc/nginx/templates/default.conf.template
ENV API_ORIGIN=http://api:3000
ENV DNS_RESOLVER=127.0.0.11
ENV NGINX_ENVSUBST_FILTER=API_ORIGIN|DNS_RESOLVER

EXPOSE 80

HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -q -O- http://127.0.0.1:80/ || exit 1
