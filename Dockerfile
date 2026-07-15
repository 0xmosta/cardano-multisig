FROM node:24-alpine AS development-dependencies-env
COPY . /app
WORKDIR /app
RUN npm ci

FROM node:24-alpine AS production-dependencies-env
COPY ./package.json package-lock.json /app/
WORKDIR /app
RUN npm ci --omit=dev

FROM node:24-alpine AS build-env
COPY . /app/
COPY --from=development-dependencies-env /app/node_modules /app/node_modules
WORKDIR /app
ARG CARDANO_NETWORK=preprod
ARG VITE_CARDANO_NETWORK=preprod
ENV CARDANO_NETWORK=$CARDANO_NETWORK
ENV VITE_CARDANO_NETWORK=$VITE_CARDANO_NETWORK
RUN npm run build

FROM node:24-alpine
ARG CARDANO_NETWORK=preprod
ARG VITE_CARDANO_NETWORK=preprod
ENV HOST=0.0.0.0
ENV PORT=3000
ENV CARDANO_NETWORK=$CARDANO_NETWORK
ENV VITE_CARDANO_NETWORK=$VITE_CARDANO_NETWORK
EXPOSE 3000
COPY ./package.json package-lock.json /app/
COPY ./db /app/db
COPY ./scripts/postgres-migrate.mjs ./scripts/harden-sensitive-state.mjs ./scripts/healthcheck.mjs /app/scripts/
COPY --from=production-dependencies-env /app/node_modules /app/node_modules
COPY --from=build-env /app/build /app/build
WORKDIR /app
HEALTHCHECK --interval=30s --timeout=6s --start-period=30s --retries=3 CMD ["node", "scripts/healthcheck.mjs"]
CMD ["npm", "run", "start"]
