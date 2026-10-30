# Supabase setup

Print Wallah already uses PostgreSQL through the Node `pg` client. Supabase provides the hosted PostgreSQL database, so the application's SQL queries and schema do not need a database-engine rewrite.

## This project's integration

The Next.js quickstart (`page.tsx`, `@supabase/ssr`, and its cookie middleware) is not for this repository: Print Wallah is an Express app with its own login/session flow, not a Next.js app using Supabase Auth. The Supabase project URL and publishable key are for Supabase client APIs; they are not PostgreSQL credentials and cannot be used as `DATABASE_URL`. The current app connects directly to Postgres with `pg`, so it does not need `@supabase/supabase-js`, `@supabase/ssr`, or Supabase Auth for the database switch.

## Create and connect the database

1. Create a Supabase project and keep its database password private.
2. In the Supabase Dashboard, open **Connect** and copy a PostgreSQL connection string suitable for the app's hosting environment. Supabase documents the available direct and pooled connection options in its [database connection guide](https://supabase.com/docs/guides/database/connecting-to-postgres).
3. Copy `.env.example` to `.env` for local development. Set `DATABASE_URL` to the connection string and `DATABASE_SSL=true`. If the password contains URL-special characters, use the URL-encoded form Supabase provides or encode those characters before placing it in the URL.
4. Set `JWT_SECRET`, `SUPER_ADMIN_EMAIL`, and `SUPER_ADMIN_PASSWORD` to private, unique values. Do not commit `.env` or paste credentials into chat.
5. Run `npm install`, then `npm run db:init`. This applies `db/schema.sql` to the configured Supabase database. The app also runs schema initialization on startup.
6. Start the app with `npm start` and sign in using the configured Super Admin email and password.

For a deployed app, add the same variables in the hosting provider's secret environment settings. Set `DATABASE_URL` to the Supabase connection string and `DATABASE_SSL=true`. Keep upload files in the app's configured persistent private storage; Supabase database setup does not move uploaded print documents out of the local storage directory.

The app uses its own Super Admin and shop-admin login tables. Supabase Auth is not required for the current authentication flow. The database schema uses PostgreSQL's `pgcrypto` extension for generated UUIDs.
