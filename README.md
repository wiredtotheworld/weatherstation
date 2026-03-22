# Stockwell Street Weather Station — Live Web Version

A fully dynamic weather station display hosted on Netlify.
The front-end fetches live data from a serverless function that reads
the CR1000 .dat file directly from the repository.

---

## Repository structure

```
stockwell-live/
├── netlify.toml              — Netlify configuration
├── package.json
├── data/
│   └── CR1000_Table1.dat     ← PUT YOUR .DAT FILE HERE
├── public/
│   ├── index.html            — The kiosk display
│   └── images/               ← PUT YOUR STATION PHOTOS HERE
└── netlify/
    └── functions/
        ├── data.js           — Serverless: parses .dat → JSON
        └── images.js         — Serverless: lists photos
```

---

## First-time setup

### 1. Create a GitHub repository
Go to github.com, create a new repository (e.g. `stockwell-weather`),
then push this folder to it:

```bash
cd stockwell-live
git init
git add .
git commit -m "initial"
git remote add origin https://github.com/YOURNAME/stockwell-weather.git
git push -u origin main
```

### 2. Connect to Netlify
- Go to app.netlify.com
- Click "Add new site" → "Import an existing project" → GitHub
- Select your repository
- Build settings are auto-detected from netlify.toml:
  - Publish directory: `public`
  - Functions directory: `netlify/functions`
- Click Deploy

Your site will be live at `https://your-site-name.netlify.app` in about
60 seconds.

### 3. Add your data and photos
Put your .dat file in `data/` and photos in `public/images/`, commit
and push:

```bash
cp /path/to/CR1000_Table1.dat data/
git add data/ public/images/
git commit -m "update data"
git push
```

Netlify will redeploy automatically in ~30 seconds.

---

## Updating data regularly

### Option A — Manual (simplest)
Whenever you export a new .dat file from the CR1000, copy it into
`data/`, commit, and push. The site redeploys in ~30 seconds.

### Option B — Automated script
Put this script on the machine connected to the CR1000 and run it
on a schedule (cron job, Task Scheduler, etc.):

```bash
#!/bin/bash
# update-weather.sh
# Run e.g. daily via cron: 0 8 * * * /path/to/update-weather.sh

REPO="/path/to/stockwell-live"
DAT="/path/to/latest/CR1000_Table1.dat"

cp "$DAT" "$REPO/data/"
cd "$REPO"
git add data/
git commit -m "data update $(date +%Y-%m-%d)"
git push
```

### Option C — GitHub Actions (fully automated)
Add a GitHub Action that runs on a schedule and pulls the .dat file
from a known location (e.g. a shared network drive or FTP).
Ask Claude to generate the workflow file if you want this.

---

## Kiosk mode
Point the kiosk browser at your Netlify URL instead of localhost:
```
https://your-site-name.netlify.app
```

The display auto-refreshes data every 5 minutes.

---

## Custom domain
In Netlify → Domain settings, you can add a custom domain like
`weather.stockwellstreet.ac.uk` if you have one.
