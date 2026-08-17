import 'dotenv/config';
import { defineConfig } from 'prisma/config';

export default defineConfig({
  schema: 'mboss-database/prisma/schema.prisma',
  migrations: {
    path: 'mboss-database/prisma/migrations',
  },
  datasource: {
    url: process.env['DATABASE_URL'],
  },
});
