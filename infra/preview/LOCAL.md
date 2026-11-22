# Local preview against a real database

`pnpm preview:local` starts the web app and the API against a database you supply. It is the way to look at the owner app on a checkout of this repo without loading fixture data.

The database URL has to be in the environment when you start it. The script does not read a connection string from the repo, and it does not seed, migrate, or start a database. Point it at a database that is already migrated, such as the local stack on the box.

```sh
DATABASE_URL='postgres://…' pnpm preview:local
```

The web app listens on port 5173 and the API on port 3100, unless `WEB_PORT` or `API_PORT` is set. Sign in with an account that already belongs to the restaurant's space, then open `/restaurants`.

Do not commit the URL, a dump, or a snapshot.
