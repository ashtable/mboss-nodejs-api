#!/bin/sh
# Migrations run at container start rather than at build time: the database exists only at run
# time, and a build that needed one could not be reproduced without it.
set -e
npx prisma migrate deploy
exec npx tsx src/main.ts
