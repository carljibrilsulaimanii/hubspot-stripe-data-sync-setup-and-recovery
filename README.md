<!--
  README.md -- HubSpot Stripe Data Sync: setup and recovery
  Author:  Jibril Sulaiman
  Date:    2026-10-14
  What:    Click-by-click guide for setting up HubSpot's Stripe Data Sync into custom
           payment and subscription objects, and for recovering it when the connection
           dies: rebuilding lost field mappings, matching instead of duplicating,
           date-limited starts, backfilling the outage, and the sync queue that blocks
           live payments.
  Why:     A dead Stripe connection silently stops every payment workflow downstream,
           and the reconnect wipes every mapping. Nothing in HubSpot records what the
           old mapping was or which payments were missed.
-->

# HubSpot Stripe Data Sync: setup and recovery

Set up HubSpot's **Stripe Data Sync** app so Stripe payments and subscriptions land in
HubSpot custom objects your workflows can run on, and get it back when it breaks. It
covers the parts HubSpot doesn't document: rebuilding the field mappings a reconnect
wipes, matching on the Stripe ID so nothing duplicates, starting a sync from a date,
backfilling the payments an outage missed, and the one-at-a-time sync queue that can
hold up live payments for an hour.

It's the base the rest of the
[Stripe beyond HubSpot Commerce](#related-repos-stripe-beyond-hubspot-commerce) series
builds on: every workflow in those repos runs on the payments object this sync fills.

## Why it exists

HubSpot's Stripe Data Sync copies Stripe records into HubSpot. When you sell through
Stripe Payment Links or Checkout instead of HubSpot Commerce, it's the only native way
payments reach HubSpot, so routing, purchase events to ad platforms, confirmation emails
and revenue reports all hang off it. When it breaks:

1. **It fails silently.** Payments simply stop arriving. Nothing alerts you; you find
   out when someone notices missing confirmations or an ad platform's purchases drop.
2. **The reconnect can fail in a loop.** The connection's stored Stripe key dies and
   **Reconnect Stripe** keeps retrying that same dead key:
   *"Couldn't connect to Stripe. Authentication failed."* with
   `{"error": "invalid_client", "error_description": "No such API key: sk_live_***"}`.
   Uninstalling the app to start fresh may not be allowed. HubSpot support traced one
   case to a permissions conflict between the Data Sync app and another Stripe
   connection on the same HubSpot account, fixed on HubSpot's side.
3. **The fix wipes the mappings.** Once the connection works again, the new connection
   comes back with only HubSpot's default syncs (Contact, Product, Invoice), all
   **Off**. Every sync into a custom object, and every field mapping on it, is gone.
   HubSpot keeps no record of what the mapping was.
4. **Re-adding a sync the obvious way duplicates everything.** The default record
   matching is **Do no matching**. Its own help text says it *"may create one-time
   duplicates during the initial sync"*: on an object that already holds tens of
   thousands of payments, that's tens of thousands of duplicates, each one able to
   trigger your workflows.
5. **"Stripe overwrites HubSpot."** The data conflict rule can't be changed for custom
   objects. If your workflows wrote anything into a mapped field (product names into
   the description, for example), a full re-sync overwrites it, and every overwrite is
   a property change that can re-trigger workflows.
6. **Syncs run one at a time.** Each sync does a long first scan. While one scans, the
   others, including the payments sync, wait in a queue. Turning several syncs on at
   once held up live payments, and every workflow behind them, for about an hour.

This guide is the recovery done end to end, written so it can also be followed for a
first-time setup.

## How it works

```text
 Stripe ──► HubSpot Stripe Data Sync (one connection, several syncs, run one at a time)
              │
              ├─ Payment Transactions ─► custom object "Stripe Payment Transactions"
              │      matched on Record ID = Stripe Payment Transaction ID
              │      start filter: Created is after <date>
              │                         │
              │                         ▼
              │           your workflows: product names, routing, purchase events,
              │           confirmation emails (other repos in the series)
              ├─ Subscriptions ───────► custom object "Stripe Subscriptions"
              ├─ Invoices ────────────► HubSpot Invoices
              ├─ Products ────────────► HubSpot Products   (matched on Stripe Product ID)
              └─ Customers ───────────► HubSpot Contacts   (matched on email)
```

## What's in this repo

| Path | What it is | Where it's used |
|---|---|---|
| [`snippets/`](snippets/) | Two browser-console snippets: list an object's properties by the day they were created, and list every workflow's triggers on an object | Steps 1 and 5 |
| [`scripts/`](scripts/) | A read-only Node script that lists the Stripe payments and subscriptions created during an outage | Step 7 |

## Table of contents

- [1. Requirements](#1-requirements)
- [2. Setup and recovery, step by step](#2-setup-and-recovery-step-by-step)
  - [Step 1: Record the mapping before you touch anything](#step-1-record-the-mapping-before-you-touch-anything)
  - [Step 2: Get a dead connection back](#step-2-get-a-dead-connection-back)
  - [Step 3: The payments sync](#step-3-the-payments-sync)
  - [Step 4: The subscriptions sync](#step-4-the-subscriptions-sync)
  - [Step 5: Check your workflows before turning anything on](#step-5-check-your-workflows-before-turning-anything-on)
  - [Step 6: Turn on and verify](#step-6-turn-on-and-verify)
  - [Step 7: Backfill the outage](#step-7-backfill-the-outage)
  - [Step 8: Contacts, invoices and products](#step-8-contacts-invoices-and-products)
  - [Step 9: Order the first scans so payments never wait](#step-9-order-the-first-scans-so-payments-never-wait)
- [Field reference](#field-reference)
- [Troubleshooting](#troubleshooting)
- [Limits](#limits)
- [Security](#security)
- [Related repos: Stripe beyond HubSpot Commerce](#related-repos-stripe-beyond-hubspot-commerce)

## 1. Requirements

| Need | Why |
|---|---|
| HubSpot's **Stripe** data sync app ("Built by HubSpot"), installed and connected | The sync itself |
| A HubSpot plan that allows syncing into **custom objects** (Data Hub / Operations Hub Professional or above at the time of writing) | Payments and subscriptions land in custom objects |
| Super Admin, or app-install permissions, in HubSpot | Editing syncs, and uninstalling if it ever comes to that |
| Admin access to the Stripe account, signed in as the user who owns the connection | Re-authorizing on reconnect |
| Optional: Node.js 18+ and a **restricted live Stripe key** with read access to PaymentIntents and Subscriptions (plus Checkout Sessions for product names) | The outage script in Step 7 |
| Chrome, signed in to HubSpot | The snippets in Steps 1 and 5, and the HAR capture in Step 2 |

## 2. Setup and recovery, step by step

The sync settings live at **Settings → Integrations → Connected apps → Stripe → CRM
syncs**. The page has an **Object view** listing each sync with **Status**, **In
sync**, **Failing**, **Excluded** and **Last edited**, plus **Sync now** and **Sync
more data** buttons. Its URL looks like
`https://app.hubspot.com/data-sync/<portalId>/app/<appId>/account/<accountId>/settings/object-view`.
Note `<accountId>`: it changes when the connection is recreated.

### Step 1: Record the mapping before you touch anything

About 15 minutes. Do this now, while the sync works; it's the only thing that makes
Step 3 fast.

**1a.** Open each sync (hover its row → **Edit**). On **1. Configure**, screenshot
**Sync direction**, **Record matching**, **Data conflict resolution** and the full
**Mapped fields** table (scroll it). On **2. Limit**, screenshot the filters. Save the
screenshots somewhere that isn't HubSpot.

**1b.** If the mapping is already gone, rebuild the list from the fields themselves.
Data Sync creates every field it maps, all at once, the day the sync is first set up.
Open any `app.hubspot.com` page, open DevTools → **Console**, and paste
[`snippets/list-properties-by-created-date.js`](snippets/list-properties-by-created-date.js)
with `PORTAL_ID` and `OBJECT_TYPE` (the object's `2-...` id, from its records page URL)
filled in.

The first output groups fields by creation day, for example:

```text
{ "total": 70, "groups": { "<setup day> u<user>": 50, "<setup day> u-": 2, "<later day> u<user>": 3, ... } }
```

The big group on the earliest day is the original mapping. Every later group is a
field your own workflows or scripts added: product names, UTMs, "sent at" timestamps,
routing flags.

> ⚠️ **Never map the later fields.** Data Sync would overwrite them with Stripe's value
> (usually blank) on every sync. Make a written "do not map" list from the later groups.

**1c.** For each object, open the newest record Data Sync created and note which mapped
fields actually hold values. A field that was always empty on the old sync isn't worth
fighting for if the new one won't map it (Step 4).

✅ **Check:** for each sync you have the direction, the matching rule, a list of mapped
fields, and a "do not map" list.

### Step 2: Get a dead connection back

About 30 minutes of your time; HubSpot's fix may take longer.

**2a. Confirm it's really dead.** Sort the payments object by **Create date**. The
newest record tells you when the sync stopped. Then list Stripe's payments since then
(Stripe Dashboard → **Transactions → Payments**, or the script in Step 7). If Stripe has
payments HubSpot doesn't, it's an outage, not a quiet hour.

**2b. Look on the Stripe side.** In Stripe, **Settings → Team and security → Security
history**, filter **Action** to **Unlinked a Connect platform**, **A Stripe App
Uninstalled**, and the API-key actions (**Rolled an API key**, **Expired an API key**,
**A secret API key has been deleted**). A hit near the outage time names who did it.
HubSpot's Data Sync doesn't appear under **Apps overview → Installed**, so there's
nothing to reinstall from Stripe's side.

> ⚠️ **The Action filter needs Apply twice.** Pick the action, click **Apply**, and if
> the table doesn't change, click **Apply** again. The URL gains `?action=...` when it
> takes.

**2c. Try Reconnect once.** In HubSpot, **Connected apps → Stripe**, click the reconnect
prompt. **Reconnect Stripe** shows two steps, **Connect Stripe** and **Set up sync**;
click **Connect to Stripe** and sign in as the account owner. If it fails with
*"Couldn't connect to Stripe"* and `invalid_client` / `No such API key`, stop retrying:
each attempt reuses the same dead stored key.

**2d. Open a support ticket** with: the error text, your portal id, the connection's
`<accountId>` and app id from the URL, the Stripe login the connection uses, when the
last payment arrived, and a count of what's missing.

**2e. Capture a HAR file**, which support will ask for. The reconnect opens Stripe's
sign-in in a separate window, so capture on the HubSpot tab:

1. Open the page with the **Reconnect Stripe** prompt. Press **F12** → **Network**.
2. Tick **Preserve log**, make sure recording is on, and filter on **All** (not
   **Socket**, which records nothing useful).
3. **Refresh the page** with DevTools open, so recording starts before you click.
4. Click **Connect to Stripe** and go through the sign-in window until the error shows
   again.
5. Check the Network list has rows, then click the **Export HAR** (down-arrow) icon.

A real capture is several MB (one was 50 MB). A 1 KB file has `"entries": []`: nothing
was recorded. Large files can be uploaded to your HubSpot **Files** tool and the link
sent to support.

> ⚠️ **A HAR file contains your HubSpot session.** Send it only to support. Once they're
> done, sign out of HubSpot and back in to end that session.

**2f.** Once support reports a fix, open **CRM syncs**. Expect only **Contact sync**,
**Product sync** and **Invoice sync**, all **Off**. Your custom-object syncs are gone;
Steps 3 and 4 rebuild them.

✅ **Check:** the app shows **Connected**, and the **Account** dropdown shows the right
Stripe account.

### Step 3: The payments sync

About 20 minutes.

**3a.** On **CRM syncs**, click **Sync more data**. On *"Select the data that you want
to sync"*:
1. **Stripe → Select an object → Payment Transactions**.
2. **HubSpot → Select an object**, type `Stripe` in the search, and pick your **existing**
   payments object (for example **Stripe Payment Transactions**, under **Additional
   objects**). If it isn't listed, click **Refresh list**.
3. The arrow between them shows one-way, Stripe → HubSpot. Click **Next**.

> ⚠️ **Pick the existing object.** A new object starts empty, and every workflow,
> report and list still points at the old one.

**3b. Record matching.** Choose **Choose my own fields to match on**:

| Stripe | = | HubSpot |
|---|---|---|
| **Record ID** | = | **Stripe Payment Transaction ID** |

Stripe's **Record ID** here is the `pi_...` id. With this match, a payment already in
HubSpot is updated, not copied.

> ⚠️ **Don't leave "Do no matching" on.** Its help text: *"We recommend this if you're
> looking to bring all your stripe payment transactions over to HubSpot. But if you
> already have stripe payment transactions in HubSpot, this may create one-time
> duplicates during the initial sync."*

**3c. Data conflict resolution** reads *"Stripe will overwrite HubSpot when it's
unclear which one has the most up-to-date information"*. It can't be changed for this
object; Step 5 deals with what that means.

**3d. Mapped fields.** Click **Generate mappings**. A **Review generated field
mappings** panel says, for example, *"We were able to find mappings for 60 out of your
67 Stripe fields."* Read every row: each should pair a Stripe field with the HubSpot
field of the same name. Untick any row that pairs different things, then click
**Accept suggestions and map**.

**3e.** The match row from 3b sits at the bottom with an empty Stripe side. Click its
**Search** dropdown, pick **Record ID**, and click the **✓** at the end of the row. Its
toggle stays greyed: *"Mappings with required fields cannot be turned off"*.

**3f.** Compare the result with your list from Step 1. For each missing field, click
**Add a mapping**, pick the Stripe field, pick the HubSpot field, and click **✓**. Some
can't be mapped any more: the HubSpot field is greyed with *"This field can't be
mapped."* On payments these were:

| Field | What covers it instead |
|---|---|
| `customer` | `customer_id` holds the same `cus_...` id |
| `customer_billing_address` | Its parts (line 1/2, state, postal code, country, phone) are mapped |
| `customer_shipping_address` | Its parts (line 1/2, city, state, postal code, country, phone) are mapped |

Delete any half-finished row with its trash icon. The full list is in the
[Field reference](#field-reference).

**3g. 2. Limit.** Under **Filters**, the box **Payment Transactions syncing from Stripe
to HubSpot (optional)** reads **All payment transactions**. Click **Edit**:
1. **Primary filter type → Payment Transaction properties**.
2. Search `Created`, pick **Created**, choose **is after**, and enter a date and time.
3. Click **Apply filter**, then **Done**. (**Done** stays disabled with *"Apply your
   filter before moving forward."* until you apply.)

Use a start just before the outage if you're recovering (Step 7), or today if you'll
catch up by hand. Leave **Create new stripe payment transactions and update existing in
HubSpot** selected.

> ⚠️ **Why a start date.** Without it the first scan walks every payment Stripe has
> ever taken and updates every matched record with Stripe's values (Step 5). With it,
> older payments are counted as **Excluded** and left alone.

**3h. 3. Organize** shows **Automatic associations** and **Automatic deletions:
Unavailable**. Nothing to set. Data Sync doesn't link payments to contacts; if you
need that, use a workflow.

**3i. 4. Review** lists **Record matching** (`Record ID = Stripe Payment Transaction
ID`), *"N fields will be kept in sync"*, and the filter (*"Created is after ..."*).
Click **Save**, not **Save and sync**, so it's stored but off. The banner reads
*"Success. Stripe Payment Transaction sync saved."*

✅ **Check:** **CRM syncs** lists **Stripe Payment Transaction sync**, **Off**.

### Step 4: The subscriptions sync

About 15 minutes.

**4a.** **Sync more data → Stripe: Subscriptions → HubSpot:** your existing
subscriptions object (for example **Stripe Subscriptions**) **→ Next**.

**4b.** **Choose my own fields to match on**: **Record ID = Stripe Subscription ID**.

**4c.** **Generate mappings** (for example *"43 out of your 89 Stripe fields"*), and
read every row.

> ⚠️ **The generator can be confidently wrong.** It suggested
> **[Latest Invoice] Customer Name → Latest Invoice**, which writes a person's name into
> the field meant for the invoice id. Untick rows like that before **Accept suggestions
> and map**. Check the old records, too: the same wrong pairing had been live before.

**4d.** Finish the **Record ID** row as in 3e, then add what's missing. On subscriptions
these were all greyed out (*"This field can't be mapped."*) and were empty on the old
records anyway: `customer`, `customer_record_id`, `latest_invoice`,
`latest_invoice_record_id`, `latest_invoice_finalized`, `latest_invoice_customer`,
`latest_invoice_line_items`. A HubSpot "product name" field may have no Stripe field to
map from at all.

> ⚠️ **What's greyed out depends on the Stripe side.** Once you pick a link-type Stripe
> field such as **Latest Invoice**, every HubSpot field greys out for that row. Delete
> the row rather than force it.

**4e. 2. Limit:** **Edit → Subscription properties → Created → is after** your start
date → **Apply filter → Done**.

**4f. 4. Review → Save.**

✅ **Check:** **Stripe Subscription sync** is listed, **Off**, matching on the
subscription id.

### Step 5: Check your workflows before turning anything on

About 15 minutes.

**5a.** Paste
[`snippets/list-object-workflow-triggers.js`](snippets/list-object-workflow-triggers.js)
into the console with your portal id and the two object ids. Each line is one workflow:

```text
<id> | ON | LIST_BASED | reEnroll:true | trig:description | reTrig: | watches: | <your product-names workflow>
<id> | ON | EVENT_BASED | reEnroll:true | trig:hs_name,hs_value,evt:... | reTrig: | watches:"description" | <your routing workflow>
```

`watches:` names the property a "property value changed" trigger listens to.

**5b.** Sort them into two groups:

| Safe when the sync turns on | At risk |
|---|---|
| Starts only on record creation, or on a property the sync never changes (the `pi_...` id itself) | Starts or re-enrolls when a **mapped** field changes: `description`, `status`, error codes |
| Doesn't re-enroll, or guards itself with a "sent at" timestamp | Writes into a mapped field itself (then Stripe overwrites it, and it fires again) |

> ⚠️ **The description trap.** A common pattern is a workflow that writes product names
> into a blank Stripe `description`. On a full re-sync, *"Stripe will overwrite HubSpot"*
> puts Stripe's value back. That's a change, which re-triggers routing, which can create
> deals and update contacts, for every old payment where the two differ. A start date
> (3g) avoids this entirely: old records aren't touched. If you must re-sync everything,
> pause the at-risk workflows first.

**5c.** A matched record whose values come back unchanged triggers nothing. Only real
differences between Stripe and HubSpot fire workflows.

✅ **Check:** you know which workflows would fire, and either the start date keeps old
records out or those workflows are paused.

### Step 6: Turn on and verify

About 15 minutes, plus waiting.

**6a.** Open the payments sync (**Edit**), go to **4. Review**, and click **Save and
sync**. The banner reads *"Stripe Payment Transaction sync is on. If there is a lot of
data, syncing can take up to a few hours."*

**6b.** Watch the **Status** column. It moves through **In queue**, *"Scanning N
HubSpot records"* (matching what's already there), and *"Processing N Stripe records"*.
**In sync** counts records it wrote; **Excluded** counts ones your start filter skipped.

**6c.** Within a minute or two the newest payments appear. Open a few and check:

- amount in the same units as old rows (a $10.00 item reads `10`, not `1000`)
- `status`, `description`, receipt email and the `pi_...` id filled in
- after about 3 minutes, every workflow ran: product name, routing flag, purchase-event
  "sent at" timestamps

**6d.** Check the email side too: the buyer's contact shows the confirmation in
**Last marketing email name** / **Last marketing email send date**. Incomplete payments
(`requires_action`, `requires_payment_method`) should get none.

**6e.** Turn on the subscriptions sync the same way. Subscriptions are rare, so it may
show nothing new for a while. That isn't a fault: it just means nobody has subscribed
since the start date.

✅ **Check:** a payment made after you turned it on arrives within a few minutes and
runs every workflow, and no record older than the start date changed.

### Step 7: Backfill the outage

About 20 minutes.

**7a. List what's missing.** Set `FROM` (when the last payment that reached HubSpot was
created) and `TO` (when the sync was back) at the top of
[`scripts/list-unsynced-stripe.mjs`](scripts/list-unsynced-stripe.mjs), then in
PowerShell:

```powershell
$env:STRIPE_LIVE_KEY = "rk_live_..."   # a restricted, read-only key
node scripts/list-unsynced-stripe.mjs
```

Runs [`scripts/list-unsynced-stripe.mjs`](scripts/list-unsynced-stripe.mjs). Success
looks like:

```text
payments: 12, subscriptions: 0
pi_ids:pi_...,pi_...
sub_ids:
```

It writes `unsynced-payments.csv` and `unsynced-subscriptions.csv`. Without Checkout
Sessions read permission it prints *"No Checkout Sessions read permission; products
column left blank."* and carries on.

**7b.** Search the payments object for those `pi_...` ids
(**Stripe Payment Transaction ID** *is any of*). The ones not found are the backfill
list. Hand it to your team as a CSV; it's also the record of what happened.

**7c. Let Data Sync do the backfill.** Open the payments sync → **2. Limit → Edit**,
click the existing **Created is after** filter, move the start back to just before the
outage, **Apply filter → Done → 4. Review → Save and sync**. The banner reads
*"Stripe Payment Transaction sync has been updated."* Because it matches on the `pi_...`
id, payments already in HubSpot are updated, not duplicated, and the missing ones are
created like any other payment, so every workflow runs on them.

> ⚠️ **Changing the filter restarts the full scan.** The sync goes back to **In queue**
> and scans HubSpot's records again before pulling from Stripe. See Step 9 before
> changing filters while other syncs are on.

**7d. Before you backfill, decide about late emails.** Backfilled buyers get their
confirmation emails now, a day late. Check what they've already received:

- Someone may have sent a manual "did not receive" email. Those buyers will now get a
  second one.
- Buyers whose payment was missing **looked like abandoned carts**. They may have
  received abandoned-cart emails after paying. Once the payment syncs, routing should
  clear the abandon-cart status; check a few, and clear any that stayed.
- Purchase events reach Meta and Google a day late, which both still accept.

✅ **Check:** search the payments object for the backfill list again and find every
id. Each has routed and has its "sent at" timestamps, and each checkout buyer got their
confirmation.

### Step 8: Contacts, invoices and products

About 20 minutes. These three are HubSpot's default syncs, so their mappings come
pre-filled. Check them against Step 1 rather than rebuilding.

**8a. Invoice sync.** Defaults: **Invoice Number → Number**, **Due Date**, **Memo →
Comments**, **Status → Invoice status**, **Currency**, **Total → Amount billed**,
**Amount Due → Balance due**, **Created → Invoice external create date/time**, billing
address → **Recipient company** address fields, **Line Items**, **Hosted Invoice URL**,
**Period Start**, **Period End**, and **Customer → Associated Contacts**
(**Association**). Matching offers only **Choose my own fields to match on** or **Do no
matching**, with no Stripe id option. Use a **Created is after** start filter
(**Invoice properties → Created**) so only new invoices come in.

**8b. Product sync.** Matching defaults to **Match on SKU (or similar)**. If your
existing HubSpot products carry a **Stripe Product ID** but no SKU, switch to **Choose
my own fields to match on: Product ID = Stripe Product ID**. Products have **no Created
filter**, so this sync always considers every Stripe product, and the match is what
stops duplicates. **Duplicate reduction: Only sync products with a product name** is
ticked by default.

**8c. Contact sync.** **Stripe Customers → HubSpot Contacts**, **Match on email address
(recommended to sync in events)**, **Data conflict resolution: Use Stripe data**, and
14 default mappings (name, email, billing phone and address, **Stripe Customer ID**,
**Stripe Created Date**, **Stripe Delinquent**, **Stripe Discount ID**, and the last
active subscription's pricing interval). The **Stripe events** box (*"One way sync
Stripe events into HubSpot"*) is optional. For a start date: **2. Limit → Edit →
Customer properties → Created Date → is after**.

> ⚠️ **"Use Stripe data" overwrites what buyers typed into your forms.** With email
> matching, Stripe's name and address replace HubSpot's wherever they differ. It also
> fills in blanks, and that's mostly what it does. A start date limits this to customers
> created since then.

**8d.** Before turning any of these on, run the Step 5 snippet with their object ids
(`0-53` invoices, `0-7` products). Then read Step 9.

✅ **Check:** each of the three is saved with the matching and start filter you chose.

### Step 9: Order the first scans so payments never wait

About 5 minutes, then waiting.

Data Sync runs **one sync at a time** per connection. Each first scan (and each
filter change, 7c) can take a long time; an invoice sync spent a long time on
*"Scanning all associated records"*. While it runs, the payments sync sits at **In
queue**, so new payments don't reach HubSpot and none of your payment workflows run.

**9a.** Turn on **payments first**, and nothing else, until its first scan is done:
the Status stops showing *"Processing"* / *"Scanning"*.

**9b.** Turn the others on **one at a time, off-hours**, when a delay to live payments
costs least.

**9c. If payments are stuck behind another scan**, turn the others off: hover the row →
**More → Turn off sync**. The dialog reads *"This won't delete anything that's already
synced, but updates will no longer sync to either system."* Click **Turn off sync**.
The settings stay saved; turning it back on later is **Edit → 4. Review → Save and
sync**.

> ⚠️ **Don't pick "Delete sync"** from the same menu. That throws away the setup you
> just rebuilt.

✅ **Check:** after each sync finishes its first scan, make a test purchase (or wait for
a real one) and confirm it reaches HubSpot within a few minutes.

## Field reference

**Payment Transactions → your payments object.** Same-name mappings. `*` = HubSpot
won't map it any more (3f).

| Group | Fields |
|---|---|
| Payment | `stripe_payment_transaction_id` (matched on Record ID), `amount`, `amount_capturable`, `amount_received`, `currency`, `status`, `description`, `created`, `canceled_at`, `cancellation_reason`, `capture_method`, `confirmation_method`, `payment_method`, `allowed_payment_methods`, `receipt_email`, `statement_descriptor`, `statement_descriptor_suffix`, `tip_amount` |
| Last payment error | `last_payment_error_code`, `_message`, `_decline_code`, `_network_decline_code`, `_advice_code`, `_network_advice_code` |
| Customer | `customer`*, `customer_id`, `customer_record_id`, `customer_name`, `customer_email`, `customer_description`, `customer_created_date`, `customer_currency`, `customer_account_balance`, `customer_delinquent`, `customer_invoice_prefix`, `customer_tax_ids`, `customer_discount_coupon_id`, `customer_coupon_amount_off`, `customer_coupon_percentage_off`, `customer_pricing_api_id_last_active_subscription`, `customer_pricing_api_id_last_active_trialing_subscription`, `customer_pricing_interval_last_active_subscription` |
| Customer billing | `customer_billing_address`*, `customer_billing_address_line_1_2`, `_state`, `_postal_code`, `_country`, `_phone` |
| Customer shipping | `customer_shipping_address`*, `customer_shipping_address_line_1_2`, `_city`, `_state`, `_postal_code`, `_country`, `_phone` |
| Shipping on the payment | `shipping_recipient_name`, `shipping_recipient_phone`, `shipping_address_line1`, `shipping_address_line2`, `shipping_address_city`, `_state`, `_postal_code`, `_country`, `shipping_carrier`, `shipping_tracking_number` |

**Subscriptions → your subscriptions object.**

| Group | Fields |
|---|---|
| Subscription | `stripe_subscription_id` (matched on Record ID), `product_ids`, `description`, `status`, `currency`, `collection_method`, `created`, `started`, `current_period_end`, `trial_start`, `trial_end`, `cancel_at`, `cancel_at_period_end`, `canceled_at`, `ended_at`, `cancellation_reason`, `cancellation_comment`, `cancellation_feedback`, `automatic_tax_enabled`, `automatic_tax_disabled_reason` |
| Customer | `customer`*, `customer_customer_id`, `customer_record_id`*, `customer_name`, `customer_email`, `customer_description`, `customer_created_date`, `customer_currency`, `customer_invoice_prefix`, `customer_discount_coupon_id`, and the three last-active-subscription pricing fields |
| Latest invoice | `latest_invoice`*, `latest_invoice_record_id`*, `latest_invoice_finalized`*, `latest_invoice_customer`*, `latest_invoice_line_items`*, `latest_invoice_invoice_number`, `_status`, `_created`, `_due_date`, `_paid_date`, `_period_start`, `_period_end`, `_amount_due`, `_amount_paid`, `_currency`, `_customer_email`, `_memo` |

Amounts land in **dollars** (major units), not cents.

## Troubleshooting

| You got | Cause | Fix |
|---|---|---|
| *"Couldn't connect to Stripe"*, `invalid_client`, `No such API key` | The connection's stored key is dead | Stop retrying; support ticket with a HAR (Step 2) |
| HAR file is ~1 KB, `"entries": []` | Recording started after the click, or **Socket** filter | Refresh with DevTools open, filter **All** (2e) |
| Every sync gone, three default syncs **Off** | The connection was recreated | Rebuild from your Step 1 notes (Steps 3, 4) |
| Thousands of duplicate payments | **Do no matching** on an object with records | Match on Record ID (3b) |
| *"This field can't be mapped."* | HubSpot no longer allows that pair | Use the covering fields (3f, 4d) |
| A person's name in **Latest Invoice** | Generator's wrong suggestion | Untick it (4c) |
| Workflow-written fields blanked out | They were mapped | Remove them; use the Step 1 "do not map" list |
| Routing re-ran on old payments | Full re-sync overwrote `description` | Start date (3g), or pause workflows (5b) |
| New payments not arriving, payments sync **In queue** | Another sync's first scan holds the queue | Turn the others off (9c) |
| Old payments show as **Excluded** | Your start filter, as intended | Nothing |
| Buyers got abandoned-cart emails after paying | Their payment was missing during the outage | Backfill (7c), then clear their status (7d) |
| Stripe security log filter won't apply | Needs a second **Apply** | 2b |

## Limits

- **Custom-object conflict rule is fixed:** *"Stripe will overwrite HubSpot"*.
- **No date filter on products.** Matching is the only guard (8b).
- **Invoices can't match on a Stripe id**, so a full invoice re-sync can duplicate.
  Use a start date.
- **Payments aren't associated to contacts** by Data Sync; use a workflow.
- **Live data only.** Test-mode payments never sync; see
  [stripe-test-mode-to-hubspot-payment-mirror](https://github.com/carljibrilsulaimanii/stripe-test-mode-to-hubspot-payment-mirror).
- **One sync at a time** per connection (Step 9).
- The two snippets use HubSpot's **internal** endpoints, the same ones its own pages
  use. They can change without notice.

## Security

- **The outage script is read-only** and needs only a **restricted** key with read
  access. Keep it in an environment variable, never in the file.
- **A HAR file is a session token.** Share it only with support; sign out and back in
  afterwards (2e).
- **The snippets run as you**, in your signed-in browser. Read any snippet before
  pasting it into a console.
- **Turning a sync off doesn't delete records**, but **Delete sync** removes its setup.

## Related repos: Stripe beyond HubSpot Commerce

This repo is one of a set of guides for taking Stripe payments without HubSpot
Commerce, and for getting the Stripe data that HubSpot's native Stripe
integration leaves out into HubSpot. Each one stands alone.

| Repo | What it adds |
|---|---|
| **hubspot-stripe-data-sync-setup-and-recovery** (this repo) | The base the rest builds on: HubSpot's Stripe Data Sync into payment and subscription objects, and getting it back when the connection dies (lost mappings, duplicates, backfill, the sync queue) |
| [hubspot-stripe-utm-attribution](https://github.com/carljibrilsulaimanii/hubspot-stripe-utm-attribution) | UTM attribution: keeps UTMs across pages when HubSpot form redirects drop them, gets them back from Stripe on the checkout success page, and writes them onto the payment record |
| [hubspot-order-form-stripe-checkout-link-integration](https://github.com/carljibrilsulaimanii/hubspot-order-form-stripe-checkout-link-integration) | A two-step HubSpot order form that hands buyers to a Stripe Payment Link with their email and campaign UTMs attached |
| [stripe-webhooks-to-hubspot-custom-events](https://github.com/carljibrilsulaimanii/stripe-webhooks-to-hubspot-custom-events) | Any Stripe event into a HubSpot workflow through the "Webhook event is received" trigger, no middleware |
| [hubspot-capi-server-side-lead-and-purchase-conversions-meta-google](https://github.com/carljibrilsulaimanii/hubspot-capi-server-side-lead-and-purchase-conversions-meta-google) | Stripe purchases sent server-side from HubSpot workflows to Meta and Google |
| [hubspot-stripe-zero-dollar-checkout-sync](https://github.com/carljibrilsulaimanii/hubspot-stripe-zero-dollar-checkout-sync) | Free and 100%-off Stripe Checkout orders, which create no payment, written into a HubSpot custom object, plus a backfill |
| [hubspot-stripe-payment-product-names-and-routing](https://github.com/carljibrilsulaimanii/hubspot-stripe-payment-product-names-and-routing) | Which product each Stripe payment was for, written onto the payment record, and a master workflow that routes buyers by product |
| [stripe-test-mode-to-hubspot-payment-mirror](https://github.com/carljibrilsulaimanii/stripe-test-mode-to-hubspot-payment-mirror) | Stripe test-mode payments in the same HubSpot object as live ones, so payment workflows can be tested without real charges |

---

Built by [Jibril Sulaiman](https://github.com/carljibrilsulaimanii).
