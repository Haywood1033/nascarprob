# nascarprob

NASCAR Cup Series race simulator: win and finishing odds, head-to-heads, parlays priced inside
the simulation, DFS projections with an exact lineup optimizer, race-day weather with a written
briefing, best plays, live running order and an honest accuracy record. Same stack and design
kit as golfprob, nflprob and hrprob: Vercel serverless functions, optional Supabase Postgres,
one `app.html`.

## Deploy

1. Import the repo in Vercel (framework preset: Other). No build step.
2. Optional but recommended: set `DATABASE_URL` to a Supabase Postgres connection string.
   Without it the model runs on the last 40 races fetched live.
3. Backfill history (with a database): open `/api/sync?season=2022`, repeat until
   `remaining` is 0, then 2023, 2024, 2025 and the current season.
4. Open `/api/health` first: it fetches every NASCAR feed and shows what came back. The feed
   shapes were written from memory, so this is where a renamed field shows up.

## Routes

| Route | What it does |
| --- | --- |
| `/` | The app |
| `/api/race?race=` | Race payload: field, ratings, odds, finish distributions, weather, briefing |
| `/api/races?season=` | Schedule for the race picker |
| `/api/plays` (POST `{book}`) | Best plays; pasted prices switch sections to value ranking |
| `/api/parlay` (POST `{legs}`) | Prices a custom ticket inside the simulation |
| `/api/dfs` (POST `{csv}`) | DFS projections joined to a salary CSV |
| `/api/live` | Live lap, flag and running order |
| `/api/backtest?races=30` | Leak-free backtest |
| `/api/grades` | Graded pre-race snapshots |
| `/api/sync?season=` | History backfill (weekly cron grades too) |
| `/api/status`, `/api/health` | What history is loaded; feed checks (`?race=` audits one race) |

## Tests

`npm test` runs everything against a synthetic world (`tests/fixtures.js`): fake drivers, fake
races, the real handlers. See `docs/BUILD-READOUT.md` for how the model works.
