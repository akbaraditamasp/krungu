# Krungu DB snapshot

`krungu.db` is a consistent SQLite snapshot (VACUUM INTO) of the project database: catalog, tags, moods, users, events, serves.
It contains pseudonymous listening logs of real users: keep this repo private.

Restore on another machine (from the project root, on any branch):

    git fetch origin db-snapshot
    git show origin/db-snapshot:krungu.db > krungu.db

Not included (set up separately): `.env` (LASTFM_API_KEY), `.venv` with yt-dlp, and `data/vocab.json` is tracked on master.
