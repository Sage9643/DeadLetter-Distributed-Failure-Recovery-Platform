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
COPY apps/dashboard/nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80

HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -q -O- http://127.0.0.1:80/ || exit 1
