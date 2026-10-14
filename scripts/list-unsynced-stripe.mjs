// Author:  Jibril Sulaiman
// Date:    2026-10-14
// Run:     node scripts/list-unsynced-stripe.mjs
//          Needs the STRIPE_LIVE_KEY environment variable: a restricted live key with
//          read access to PaymentIntents and Subscriptions (Checkout Sessions read is
//          optional; see below).
// What:    Lists every Stripe PaymentIntent and Subscription created during a Data Sync
//          outage window and writes them to two CSVs, with product names pulled from
//          each payment's Checkout Session when the key allows it.
// Why:     When HubSpot's Stripe Data Sync stops, nothing tells you which payments it
//          missed. This gives you the exact list to check against HubSpot and to backfill.
//          Read-only: it never writes to Stripe.

import { writeFileSync } from 'node:fs';

const KEY = process.env.STRIPE_LIVE_KEY;
if (!KEY) { console.error('STRIPE_LIVE_KEY is not set'); process.exit(1); }

// Set these two. FROM = the created time of the last payment that reached HubSpot.
// TO = when the sync was working again. Over-cover on purpose; rows already in
// HubSpot get marked in the cross-check (README Step 7), not dropped here.
const FROM = Math.floor(Date.parse('2025-01-15T17:00:00Z') / 1000);
const TO = Math.floor(Date.parse('2025-01-16T15:00:00Z') / 1000);

const api = async (path, params = {}) => {
  const qs = new URLSearchParams(params).toString();
  const res = await fetch(`https://api.stripe.com/v1/${path}${qs ? '?' + qs : ''}`, {
    headers: { Authorization: `Bearer ${KEY}` },
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`${res.status} on ${path}: ${body.error?.message}`);
  return body;
};

const listAll = async (path, params) => {
  const out = [];
  let starting_after;
  for (;;) {
    const page = await api(path, { ...params, limit: '100', ...(starting_after && { starting_after }) });
    out.push(...page.data);
    if (!page.has_more) return out;
    starting_after = page.data[page.data.length - 1].id;
  }
};

const et = (s) => new Date(s * 1000).toLocaleString('en-US', { timeZone: 'America/New_York' });
const csv = (rows) => rows.map((r) => r.map((v) => `"${String(v ?? '').replace(/"/g, '""')}"`).join(',')).join('\n');

const window = { 'created[gte]': String(FROM), 'created[lt]': String(TO) };

const intents = await listAll('payment_intents', { ...window, 'expand[]': 'data.latest_charge' });
const payRows = [['created_et', 'stripe_payment_transaction_id', 'status', 'amount', 'amount_received',
  'currency', 'description', 'products', 'customer_name', 'customer_email', 'customer_id',
  'checkout_session_id', 'payment_link_id']];

// The restricted key may lack Checkout Sessions: read. Without it, products and
// payment links are left blank and the Stripe description is all there is.
let canReadSessions = true;

for (const pi of intents.sort((a, b) => a.created - b.created)) {
  let cs;
  if (canReadSessions) {
    try {
      const sessions = await api('checkout/sessions', { payment_intent: pi.id, 'expand[]': 'data.line_items' });
      cs = sessions.data[0];
    } catch (e) {
      if (!String(e.message).startsWith('403')) throw e;
      canReadSessions = false;
      console.error('No Checkout Sessions read permission; products column left blank.');
    }
  }
  const products = cs?.line_items?.data.map((li) => li.description).join('; ') || '';
  const billing = pi.latest_charge?.billing_details || {};
  payRows.push([
    et(pi.created), pi.id, pi.status, (pi.amount / 100).toFixed(2), (pi.amount_received / 100).toFixed(2),
    pi.currency, pi.description, products,
    billing.name || cs?.customer_details?.name, pi.receipt_email || billing.email || cs?.customer_details?.email,
    pi.customer, cs?.id, cs?.payment_link,
  ]);
}

const subs = await listAll('subscriptions', { ...window, status: 'all' });
const subRows = [['created_et', 'stripe_subscription_id', 'status', 'products', 'customer_id', 'latest_invoice']];
for (const s of subs.sort((a, b) => a.created - b.created)) {
  subRows.push([et(s.created), s.id, s.status,
    s.items.data.map((i) => i.price?.nickname || i.price?.product).join('; '), s.customer, s.latest_invoice]);
}

writeFileSync('unsynced-payments.csv', csv(payRows));
writeFileSync('unsynced-subscriptions.csv', csv(subRows));
console.log(`payments: ${intents.length}, subscriptions: ${subs.length}`);
console.log('pi_ids:' + intents.map((p) => p.id).join(','));
console.log('sub_ids:' + subs.map((s) => s.id).join(','));
