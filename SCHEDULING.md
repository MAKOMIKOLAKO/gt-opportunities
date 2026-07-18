# Scheduling

Nothing is auto-installed (no cron entries or Windows Scheduled Tasks were created on this
machine) — these are documented commands to wire up manually, since an overnight unattended
build shouldn't be modifying this machine's OS-level task scheduler on its own.

All commands below run from the repo root (`C:\Users\reach\gtopportunities`).

## VIP catalog scraper — run once per semester

The VIP catalog (vip.gatech.edu) changes rarely mid-semester. Re-run around the start of each
term (roughly mid-January and mid-August), ahead of add/drop.

```
npm run scrape:vip
```

Idempotent — safe to run anytime; updates existing rows by VIP entry ID, never duplicates.

### Linux/macOS cron (if ever hosted there)
```
0 6 15 1,8 * cd /path/to/gtopportunities && npm run scrape:vip >> logs/vip-scrape.log 2>&1
```

### Windows Task Scheduler
```
schtasks /Create /TN "GT-Opportunity-Finder-VIP-Scrape" /SC MONTHLY /MO FIRST /D SUN /M JAN,AUG ^
  /TR "cmd /c cd /d C:\Users\reach\gtopportunities && npm run scrape:vip >> logs\vip-scrape.log 2>&1" /ST 06:00
```

## Engage scraper + classification — most likely to need re-running

The Engage directory (~730 orgs) turns over far more than the VIP catalog — new clubs register,
existing ones go inactive, descriptions change. **This is the piece most likely to need periodic
re-running** to keep classification current. Recommend monthly during the semester, and always at
the start of each term.

```
npm run scrape:engage
npm run classify:engage
```

Both stages are cached (raw HTML/JSON under `data/raw-cache/engage/`, classification results
under `data/classification-cache/engage/` keyed by org id + description hash) — re-runs skip
unchanged orgs, so this is cheap to run frequently if desired.

Every row this pipeline inserts or updates lands as `status='pending'` on insert (existing rows'
review status is never touched by a re-run) — nothing from this pipeline reaches the public app
without passing through the admin review queue first.

### Linux/macOS cron
```
0 6 1 * * cd /path/to/gtopportunities && npm run scrape:engage && npm run classify:engage >> logs/engage.log 2>&1
```

### Windows Task Scheduler
```
schtasks /Create /TN "GT-Opportunity-Finder-Engage-Pipeline" /SC MONTHLY /D 1 ^
  /TR "cmd /c cd /d C:\Users\reach\gtopportunities && npm run scrape:engage && npm run classify:engage >> logs\engage.log 2>&1" /ST 06:00
```

## Not scheduled

- Migrations (`npm run migrate`) and tag seeding (`npm run seed:tags`) are one-time/on-deploy
  operations, not recurring — run manually after pulling schema changes.
- The backend server and frontend server are long-running processes (start once, keep running),
  not scheduled jobs — see RUN-STATUS.md "How to run everything" for start commands.
