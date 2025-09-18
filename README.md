# Matur API (Cloudflare Worker)

This Worker serves Stripe Checkout + Webhook and sets Firestore `users/{uid}.premium = true` on successful payment.

## Endpoints (under `https://api.matur.sk/v3/`)
- `POST /stripe/checkout-session` → creates a Stripe Checkout Session (one-time, allows promo codes, collects email)
- `POST /stripe/webhook` → verifies Stripe signature; on `checkout.session.completed`, unlocks premium
- `GET /success` and `GET /cancel` → simple confirmation pages

## Deploy

From `server_cf/`:

```bash
# Configure secrets (paste when prompted)
npx wrangler secret put STRIPE_SECRET
npx wrangler secret put STRIPE_WEBHOOK_SECRET
npx wrangler secret put STRIPE_PRICE_ID  # e.g. price_1S8dZnFE1tYRne9SDRfxxCLQ
npx wrangler secret put FIREBASE_SA_EMAIL
npx wrangler secret put FIREBASE_SA_KEY   # full PEM contents

# Optional (already set in wrangler.jsonc, can override if needed)
npx wrangler secret put STRIPE_SUCCESS_URL
npx wrangler secret put STRIPE_CANCEL_URL
npx wrangler secret put FIREBASE_PROJECT_ID

# Deploy
npx wrangler deploy
```

Ensure your domain route is configured in `wrangler.jsonc`:

```jsonc
{
  "routes": [
    { "pattern": "api.matur.sk/v3/*", "custom_domain": true }
  ]
}
```

## Stripe Dashboard
- Webhook: `https://api.matur.sk/v3/stripe/webhook`
- Events: `checkout.session.completed`
- Branding: logo + color `#DEEFF6`
- Test card: `4242 4242 4242 4242`

## Notes
- The app calls `/stripe/checkout-session` with `{ uid, email }` and opens the returned `url`.
- The webhook sets `premium: true`; the app reads it from Firestore to unlock all lections.
