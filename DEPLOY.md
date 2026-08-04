# Deploy BeatLine (stable hosting)

Temporary Cursor tunnels (`*.loca.lt`, `*.trycloudflare.com`) die when the cloud agent expires. Use a real host.

## Option A — Render (recommended, free)

1. Open: **https://render.com/deploy?repo=https://github.com/hioncrypto/beatline**
2. Sign in with GitHub → create the **beatline** web service (free).
3. After deploy, open `https://beatline.onrender.com` (or the URL Render shows).
4. Android Chrome → Add to Home Screen.
5. ⋮ → **Import backup** if you have an export from an old tunnel.

Free Render sleeps after ~15 minutes idle; first open after sleep can take 30–60s. The URL does **not** change.

## Option B — Fly.io

```bash
fly auth login
fly apps create beatline
fly volumes create beatline_data --size 1 --region iad
fly deploy
```

## Option C — Docker / VPS

```bash
docker build -t beatline .
docker run -d --restart unless-stopped -p 8765:8765 \
  -v beatline-data:/app/data --name beatline beatline
```
