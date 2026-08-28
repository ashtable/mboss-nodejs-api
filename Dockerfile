FROM node:24.18.0-slim

# openssl because Prisma's query engine links
# against libssl, which node:slim does not ship;
# git to clone the three nested repos below.
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates git \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# The nested repos are submodules here, and they
# are cloned rather than copied from the build
# context. Railway initialises no submodules and
# ships no .git, so there all three paths arrive
# as empty directories — and nothing says so.
# `npm ci`'s postinstall runs `prisma generate`
# against a schema file that is not there, and the
# tsconfig path aliases tsx resolves at run time
# point at nothing.
#
# .dockerignore excludes all three so that a local
# build takes this same path. One image, built the
# same way everywhere, is worth more than picking
# up uncommitted edits to a nested repo — which
# the deployed image could never have seen anyway.
#
# Pinned to the exact commits the gitlinks name,
# so the image is as reproducible as the
# submodules are; a branch would move underneath
# it. Move each REF in the same commit that moves
# its submodule.
ARG MBOSS_DATABASE_REF=7ecda18c591324ef878fbb5079395b9612584131
ARG MBOSS_ZOD_REF=7db0ce3b266b5b51351d2731d0f79cfea6510f10
ARG MBOSS_CORE_REF=022111faf91dc45f4904a845585481d3b9ae370b
RUN git clone https://github.com/ashtable/mboss-database.git mboss-database \
  && git -C mboss-database checkout --quiet "${MBOSS_DATABASE_REF}" \
  && rm -rf mboss-database/.git \
  && git clone https://github.com/ashtable/mboss-zod.git mboss-zod \
  && git -C mboss-zod checkout --quiet "${MBOSS_ZOD_REF}" \
  && rm -rf mboss-zod/.git \
  && git clone https://github.com/ashtable/mboss-core.git mboss-core \
  && git -C mboss-core checkout --quiet "${MBOSS_CORE_REF}" \
  && rm -rf mboss-core/.git

COPY package.json package-lock.json prisma.config.ts ./
RUN npm ci

COPY . .

EXPOSE 3001
ENTRYPOINT ["./docker-entrypoint.sh"]
