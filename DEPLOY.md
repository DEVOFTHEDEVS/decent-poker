# Deploying Decent Poker

## Step 1 — Push to GitHub

1. Go to https://github.com/new
2. Create a new repo called `decent-poker` (private or public)
3. In your `poke2` folder run:

```
git init
git add .
git commit -m "initial commit"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/decent-poker.git
git push -u origin main
```

---

## Step 2 — Deploy WS Server to Railway

1. Go to https://railway.app and sign up (free)
2. Click **New Project** → **Deploy from GitHub repo**
3. Select your `decent-poker` repo
4. Railway auto-detects the `railway.json` config
5. Under **Settings → Variables**, add:
   ```
   PORT=3001
   ```
6. Under **Settings → Networking**, click **Generate Domain**
7. Copy the domain — it will look like `decent-poker-production.up.railway.app`

Your WS server URL will be: `wss://decent-poker-production.up.railway.app`

---

## Step 3 — Deploy Frontend to Vercel

1. Go to https://vercel.com and sign up (free)
2. Click **Add New Project** → import your `decent-poker` repo
3. Under **Environment Variables**, add:
   ```
   NEXT_PUBLIC_WS_URL=wss://decent-poker-production.up.railway.app
   ```
4. Click **Deploy**
5. Your site will be live at `https://decent-poker.vercel.app`

---

## Step 4 — Share with friends

Send them your Vercel URL: `https://decent-poker.vercel.app`

- **Practice mode** — works immediately, no wallet
- **Friend Table** — create a room, share the link
- **Cash games** — currently uses play money (real SOL coming with Anchor contract)

---

## Updating the game

After making changes locally:
```
git add .
git commit -m "your changes"
git push
```

Both Railway and Vercel auto-redeploy on every push.
