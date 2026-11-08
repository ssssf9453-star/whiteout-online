# STILLSHOT: WHITEOUT ONLINE

This project adds two working online match options to the existing WHITEOUT game:
- **HOST ROOM / JOIN:** Generate a random six-character code; share it; the second player enters it.
- **QUICK MATCH:** Search for another waiting player; the server pairs the first two players automatically.

The server is **required** for online play. Both players open the same deployed HTTPS Render URL (the web page is hosted by this Node server). This build keeps the original local/single-player modes on the home page.

## Deploy to Render (free tier for testing)
1. Create a new GitHub repository named `whiteout-online`.
2. Unzip this package and upload `index.html`, `online.html`, `server.js`, and `package.json` **at the repository root**.
3. In https://dashboard.render.com/ choose **New → Web Service** and connect the GitHub repository.
4. Runtime: **Node**. Build: `npm install`. Start: `npm start`. Select the free instance where available.
5. After deployment, open Render's public URL, click **ONLINE 1V1**, then select **HOST ROOM** or **QUICK MATCH**.
6. A second device opens that *same URL*. It can enter the code via **JOIN**, or use **QUICK MATCH**.

## Controls
- P1 on left: W/S to aim, hold and release A to fire.
- P2 on right: up/down arrows to aim, hold and release left arrow to fire.
- On iPad/phone: touch arrow buttons to aim and hold/release FIRE, or drag on the arena to aim and release to shoot.

## Online implementation
- Rooms and matchmaking exist in server memory; leaving/restarting the server clears them.
- Health, projectile trajectories, hit detection, and the winner are resolved by the server.
- Basic 1V1 with standard arrows, 160 HP each, 62 body / 108 headshot damage.
- The online duel uses a **simplified rendition** of WHITEOUT's physics. Advanced elemental weapons, ragdoll networking, and shop power-ups are not yet synchronized online. Existing offline modes retain them.
- Render free instances may sleep after inactivity, disconnecting active players. This is not an always-on production matchmaking solution.
- Do not use this as a final production server without performance/security review and internet playtests.

## Local test
```
npm install
npm start
```
Open `http://localhost:3000` on two browser tabs, then host/join, or quick-match.

## Health check
`GET /health` returns server status, rooms and queue count.
