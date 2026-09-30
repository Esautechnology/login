# EsauTech backend

Node + Express + PostgreSQL + Safaricom Daraja (M-Pesa STK push). Shared by the client page and the admin page (to come).

## Deploy on Render
1. Push this repo to GitHub with the folder `backend/` in it.
2. Create a free PostgreSQL database (Render, Neon or Supabase). Copy its connection string.
   Note: Render's free database expires after 30 days. Neon or Supabase free databases do not.
3. Render > New > Web Service > pick the repo.
   - Root Directory: `backend`
   - Build Command: `npm install`
   - Start Command: `npm start`
4. Add the environment variables from `.env.example` in Render > Environment.
   - `ADMIN_PASSWORD`: your admin password
   - `PUBLIC_URL`: your Render URL, e.g. https://esautech-api.onrender.com
   - `CORS_ORIGIN`: your site, e.g. https://yourname.github.io
   - `MPESA_CONSUMER_KEY` and `MPESA_CONSUMER_SECRET` from developer.safaricom.co.ke (My Apps)
5. Open `PUBLIC_URL/health`. You should see `{"ok":true}`.
6. In `index.html` set `API_URL:"https://esautech-api.onrender.com"` and commit.

Free Render services sleep after 15 minutes idle, so the first request can take about a minute. Ping `/health` every 10 minutes with a free monitor (UptimeRobot) to keep it awake.

## Endpoints
Public (client page)
- `GET  /api/products`
- `POST /api/orders` body `{customer, phone, location, items:[{id,qty}]}` returns `{orderId,total}`. Prices come from the database.
- `POST /api/mpesa/stkpush` body `{orderId}` sends the prompt to the phone saved on the order.
- `GET  /api/orders/:id/status` returns `{status:"pending|paid|failed|review", message}`
- `POST /api/mpesa/callback/:secret` Safaricom calls this. Do not call it yourself.

Admin (send `Authorization: Bearer <token>`)
- `POST   /api/admin/login` body `{password}` returns `{token}`
- `GET/POST /api/admin/products`, `PUT/DELETE /api/admin/products/:id`
- `GET /api/admin/orders?status=paid`, `PATCH /api/admin/orders/:id` body `{fulfilment:"new|processing|delivered|cancelled"}`

## Going live with real money
Change `MPESA_ENV=production` and use your live shortcode, passkey and keys from Safaricom. Set `SEED_TEST_PRODUCTS=false` before the first start so the test products are not added.
