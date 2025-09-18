// Cloudflare Worker for Stripe Checkout + Webhook and Firestore unlock (premium=true)
// Endpoints under /v3/

const ROUTE_PREFIX = "/v3";

export default {
  async fetch(request, env, ctx) {
    try {
      const url = new URL(request.url);
      const path = url.pathname;
      if (!path.startsWith(ROUTE_PREFIX)) {
        return new Response("Not Found", { status: 404 });
      }

      // Simple success/cancel pages
      if (path === `${ROUTE_PREFIX}/success` && request.method === "GET") {
        return htmlPage("Platba úspešná", "Môžete sa vrátiť do aplikácie. Ďakujeme.");
      }
      if (path === `${ROUTE_PREFIX}/cancel` && request.method === "GET") {
        return htmlPage("Platba zrušená", "Platbu ste zrušili. Skúste to neskôr.");
      }

      // Create Stripe Checkout Session
      if (path === `${ROUTE_PREFIX}/stripe/checkout-session` && request.method === "POST") {
        const body = await safeJson(request);
        const uid = body.uid;
        const email = body.email || "";
        if (!uid) return json({ error: "uid required" }, 400);

        const params = new URLSearchParams();
        params.set("mode", "payment");
        params.append("payment_method_types[]", "card");
        params.append("line_items[0][price]", env.STRIPE_PRICE_ID);
        params.append("line_items[0][quantity]", "1");
        params.set("allow_promotion_codes", "true");
        if (email) params.set("customer_email", email);
        params.set("success_url", env.STRIPE_SUCCESS_URL || `${url.origin}${ROUTE_PREFIX}/success?session_id={CHECKOUT_SESSION_ID}`);
        params.set("cancel_url", env.STRIPE_CANCEL_URL || `${url.origin}${ROUTE_PREFIX}/cancel`);
        params.set("metadata[uid]", uid);

        const stripeResp = await fetch("https://api.stripe.com/v1/checkout/sessions", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${env.STRIPE_SECRET}`,
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body: params.toString(),
        });
        const data = await stripeResp.json();
        if (!stripeResp.ok) return json({ error: data.error?.message || "stripe_error" }, 500);
        return json({ url: data.url });
      }

      // Stripe Webhook (checkout.session.completed)
      if (path === `${ROUTE_PREFIX}/stripe/webhook` && request.method === "POST") {
        const payload = await request.text();
        const sig = request.headers.get("stripe-signature") || request.headers.get("Stripe-Signature");
        if (!sig) return json({ error: "missing signature" }, 400);
        const ok = await verifyStripeSignature(env.STRIPE_WEBHOOK_SECRET, payload, sig);
        if (!ok) return json({ error: "invalid signature" }, 400);

        const event = JSON.parse(payload);
        if (event.type === "checkout.session.completed") {
          const session = event.data?.object || {};
          const uid = session.metadata?.uid;
          if (uid) {
            try {
              const token = await getGoogleAccessToken(env);
              await patchFirestorePremium(env.FIREBASE_PROJECT_ID, uid, token);
            } catch (e) {
              // best-effort; ignore
            }
          }
        }
        return json({ ok: true });
      }

      return new Response("Not Found", { status: 404 });
    } catch (e) {
      return json({ error: String(e) }, 500);
    }
  },
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

function htmlPage(title, text) {
  return new Response(
    `<!doctype html><html><head><meta charset="utf-8"/><title>${escapeHtml(title)}</title></head>
     <body style="font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial; padding:24px; background:#DEEFF6">
      <h2>${escapeHtml(title)}</h2><p>${escapeHtml(text)}</p>
     </body></html>`,
    { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" } }
  );
}

async function safeJson(request) {
  try { return await request.json(); } catch { return {}; }
}

function escapeHtml(s = "") {
  return s.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// Verify Stripe signature (t=timestamp, v1=signature)
async function verifyStripeSignature(secret, payload, header) {
  try {
    const parts = Object.fromEntries(header.split(",").map(kv => kv.trim().split("=")));
    const t = parts.t; const v1 = parts.v1;
    if (!t || !v1) return false;
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey(
      "raw",
      encoder.encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"]
    );
    const signedPayload = `${t}.${payload}`;
    const sigBuf = await crypto.subtle.sign("HMAC", key, encoder.encode(signedPayload));
    const expected = toHex(new Uint8Array(sigBuf));
    return timingSafeEqual(expected, v1);
  } catch {
    return false;
  }
}

function toHex(bytes) {
  return [...bytes].map(b => b.toString(16).padStart(2, "0")).join("");
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let res = 0;
  for (let i = 0; i < a.length; i++) res |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return res === 0;
}

// Firestore patch helper
async function patchFirestorePremium(projectId, uid, accessToken) {
  const url = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/users/${uid}?updateMask.fieldPaths=premium`;
  const body = JSON.stringify({ fields: { premium: { booleanValue: true } } });
  await fetch(url, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body,
  });
}

// Google service account access token via JWT
async function getGoogleAccessToken(env) {
  const saEmail = env.FIREBASE_SA_EMAIL;
  const saKey = env.FIREBASE_SA_KEY; // PEM (-----BEGIN PRIVATE KEY-----\n...)
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iss: saEmail,
    sub: saEmail,
    scope: "https://www.googleapis.com/auth/datastore",
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
  };
  const jwt = await signJwtRs256(payload, saKey);
  const params = new URLSearchParams();
  params.set("grant_type", "urn:ietf:params:oauth:grant-type:jwt-bearer");
  params.set("assertion", jwt);
  const resp = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });
  const data = await resp.json();
  if (!resp.ok) throw new Error(data.error || "token_error");
  return data.access_token;
}

async function signJwtRs256(claims, pem) {
  const enc = new TextEncoder();
  const header = { alg: "RS256", typ: "JWT" };
  const base64url = obj => btoa(JSON.stringify(obj)).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
  const input = `${base64url(header)}.${base64url(claims)}`;
  const keyData = pemToPkcs8(pem);
  const key = await crypto.subtle.importKey(
    "pkcs8",
    keyData,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign({ name: "RSASSA-PKCS1-v1_5" }, key, enc.encode(input));
  const sigB64 = btoa(String.fromCharCode(...new Uint8Array(sig))).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
  return `${input}.${sigB64}`;
}

function pemToPkcs8(pem) {
  const b64 = pem.replace(/-----BEGIN PRIVATE KEY-----/, "").replace(/-----END PRIVATE KEY-----/, "").replace(/\s+/g, "");
  const binStr = atob(b64);
  const bytes = new Uint8Array(binStr.length);
  for (let i = 0; i < binStr.length; i++) bytes[i] = binStr.charCodeAt(i);
  return bytes.buffer;
}


