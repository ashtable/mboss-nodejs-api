FROM node:24.18.0-slim

# Prisma's query engine links against libssl, which node:slim does not ship.
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# The nested schema has to be present before `npm ci`, because postinstall runs `prisma generate`
# against it. The other two submodules are the targets of the tsconfig path aliases tsx resolves.
COPY package.json package-lock.json prisma.config.ts ./
COPY mboss-database ./mboss-database
COPY mboss-zod ./mboss-zod
COPY mboss-core ./mboss-core
RUN npm ci

COPY . .

EXPOSE 3001
ENTRYPOINT ["./docker-entrypoint.sh"]
