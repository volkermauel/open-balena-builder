FROM node:24-bookworm-slim

ARG DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y \
    node-typescript \
    jq \
    docker-compose \
    && rm -rf /var/lib/apt/lists/*

ARG BALENA_CLI_VERSION=25.2.3

# Native modules (e.g. @ronomon/direct-io) need a compiler toolchain at install
# time only: install it, build, then purge it in the same layer to stay slim.
RUN apt-get update && apt-get install -y --no-install-recommends \
    make \
    g++ \
  && npm install -g balena-cli@${BALENA_CLI_VERSION} \
  && apt-get purge -y make g++ \
  && apt-get autoremove -y \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /usr/src/app

COPY ./src ./src
COPY ./tsconfig.json ./
COPY ./package.json ./
COPY ./package-lock.json ./

RUN npm ci --no-fund --no-update-notifier && \
    tsc

COPY ./start.sh ./

CMD ["/bin/sh", "/usr/src/app/start.sh"]
