# Uniform Order Desk

A complete order management system for a uniform manufacturing business:
- Receives orders automatically from WhatsApp (via Meta's WhatsApp Business Cloud API)
- Parses free-text messages into structured orders (garment, size, quantity, school, delivery date)
- Order status tracking (pending → confirmed → in production → ready → delivered)
- Inventory tracking by garment + size, with low-stock flags
- Billing: generate invoices per order, track payment status, download PDF invoices

Runs as one small Node.js app with a built-in dashboard (works on desktop and mobile browsers).

---

## 1. Run it locally first (no WhatsApp needed yet)

```bash
npm install
cp .env.example .env
npm start
```

Open `http://localhost:3000`. Use **"+ Add order manually"** to paste in a WhatsApp
message and see it get parsed — this is a good way to test and to keep entering
orders from your *personal* WhatsApp while you set up the business number below.

Try pasting something like:
```
St. Xavier School
Shirt 32 x 3
Pinafore 34 x 2
Need by 15/07
```

---

## 2. Connect real WhatsApp (automatic order intake)

This uses Meta's **WhatsApp Business Cloud API** — free to use, but requires
business verification. Rough timeline: 1-3 days.

**Step A — Meta setup**
1. Go to developers.facebook.com → create a Meta Business account (if you don't have one) → create an App → add the "WhatsApp" product.
2. Meta gives you a **test phone number** immediately (good for testing) and a path to add your **real business number** later.
3. From WhatsApp → API Setup in the developer console, copy:
   - the **Temporary/Permanent Access Token**
   - the **Phone Number ID**

**Step B — Put credentials in `.env`**
```
WHATSAPP_TOKEN=your_access_token
WHATSAPP_PHONE_NUMBER_ID=your_phone_number_id
WHATSAPP_VERIFY_TOKEN=pick_any_random_string_yourself
PORT=3000
```

**Step C — Host this app somewhere with a public URL**
Meta needs to reach your `/webhook` endpoint over the internet, so `localhost`
won't work. Cheapest/easiest options: Railway, Render, or a small VPS — all can
run a Node.js app for free or a few dollars a month. Once deployed you'll have
a URL like `https://your-app.onrender.com`.

**Step D — Register the webhook in Meta**
In the developer console → WhatsApp → Configuration → Webhook:
- Callback URL: `https://your-app.onrender.com/webhook`
- Verify token: same string you put in `WHATSAPP_VERIFY_TOKEN`
- Subscribe to the `messages` field

**Step E — Go live**
Once verification passes, every WhatsApp message sent to your business number
will land in the Orders tab automatically, parsed into items. The customer
also gets an automatic "we received your order" reply.

**Important:** customers must message your *new* WhatsApp Business number,
not your personal one — WhatsApp doesn't allow reading a personal account's
chats through this API. If you want to keep using your existing number,
Meta's number-migration tool can move your existing WhatsApp number over to
the Business API (existing chat history is not transferred, but the number
keeps working for WhatsApp going forward).

---

## 2b. Deploying to Render (so Meta can reach your webhook)

**Cost note first:** Render's free web service works for testing, but its disk
is wiped every time the service restarts or redeploys — meaning your orders
would vanish. For real use, go with the **Starter plan ($7/month) + a 1GB
persistent disk (~$0.25/month)**, about $7.25/month total, no data loss, no
downtime. Steps below cover both; skip the disk step if you're just testing.

**Step 1 — Get the code onto GitHub**
1. Go to github.com → New repository → name it e.g. `uniform-order-system` → Create.
2. On the new repo's page, click **"uploading an existing file"** and drag in
   every file/folder from the zip you downloaded (except `node_modules` and
   `.env`, which shouldn't be uploaded). Commit.

   *(If you're comfortable with git instead: `git init`, `git add .`,
   `git commit -m "initial"`, then `git remote add origin <your-repo-url>` and
   `git push -u origin main`.)*

**Step 2 — Create the Render service**
1. Sign up at render.com (no card needed for the free tier; you'll add one when picking Starter).
2. Dashboard → **New +** → **Web Service** → connect your GitHub account → select the `uniform-order-system` repo.
3. Settings:
   - **Runtime:** Node
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - **Instance Type:** Starter ($7/mo) recommended; Free is fine for a quick test.

**Step 3 — Add a persistent disk (skip if testing on Free)**
1. On the service, go to the **Disks** tab → **Add Disk**.
2. Mount path: `/var/data`
3. Size: 1 GB is plenty for years of orders.
4. Render will redeploy automatically once saved.

**Step 4 — Environment variables**
On the service → **Environment** tab, add:
```
WHATSAPP_TOKEN=your_token_from_meta
WHATSAPP_PHONE_NUMBER_ID=your_id_from_meta
WHATSAPP_VERIFY_TOKEN=choose_any_random_string
DB_PATH=/var/data/uniforms.db
```
(Leave `DB_PATH` out if you skipped the disk step — it'll just use local
storage that resets on restart, fine for testing only.)

**Step 5 — Deploy and get your URL**
Render builds and deploys automatically. You'll get a URL like
`https://uniform-order-system.onrender.com` — that's your dashboard AND the
address Meta will send messages to (`https://uniform-order-system.onrender.com/webhook`).
Use that in the Meta webhook setup from Section 2, Step D.

**After this:** every time you push a code change to GitHub, Render
redeploys automatically — you never have to manually re-upload anything.

---

## 3. How order parsing works

`parser.js` looks for garment keywords (shirt, trouser, pinafore, tie, etc.),
then a size and quantity on the same line. It's intentionally rule-based, not
a black box, so you can see exactly why an order was read the way it was —
and you can add more garment names to the `ITEM_KEYWORDS` list as needed.

If a message doesn't match cleanly (unusual phrasing, missing size, etc.), the
order is flagged **"Needs review"** in the dashboard so you check and correct
it by hand rather than the system guessing wrong silently. Editing is done
directly from the order card.

---

## 4. Project structure

```
server.js        Express server: WhatsApp webhook + all API routes
db.js            SQLite schema (orders, order_items, inventory, invoices)
parser.js        Converts raw WhatsApp text into structured order data
public/          Dashboard (HTML/CSS/JS) served at http://localhost:3000
uniforms.db      Created automatically on first run (SQLite file)
```

## 5. Backing up your data

Everything lives in one file: `uniforms.db`. Back it up regularly (copy the
file somewhere safe, e.g. a daily copy to Google Drive/Dropbox). If you outgrow
SQLite later (many staff using it simultaneously), the same schema maps
directly to PostgreSQL/MySQL with minor changes.
