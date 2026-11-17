# HeyQuicky dashboard — build plan (P0 → P1 → P2)

Status: **approved — Phase 1 in progress.** See FEATURE_STATUS.md.

Sources read:
- Design canvas `MFMeRZeTVKKbFZLzVAebgL`: Dashboard, P1 screens and P2 screens pages, read frame by frame in present mode (about 70 frames). The canvas's source files (`project/app/*.dc.html`) can't be opened from here: the docs connector refuses this artifact, and the frames load in a sandboxed iframe. So looks come from the rendered frames. Each frame is reopened and zoomed while its screen is built.
- Feature sheet `TVEWCmxzyNvjFy3z4LtqNQ`: all 163 rows (ID, module, priority, what it does, screen).

---

## 1. What's in the repo today

| Area | What's there |
|---|---|
| Server | Node 22, Express 5, ES modules, no build step. `src/server.js` → `src/app.js` mounts webhooks, connect, legal and `/api`. |
| Database | MongoDB 7 through Mongoose 8. Numeric `_id`s from a `counters` collection (`db.insert`). Models live in `src/db.js`: workspaces, users, sessions, channels, contacts, conversations, messages, orders, products, saved_replies, leads, oauth_states, pending_connections. No migration runner (schema changes are additive). |
| Auth | Email and password (scrypt), opaque session tokens in `sessions` (TTL index), `Authorization: Bearer`. `requireOwner` middleware. Roles today: `owner` and `moderator` only. |
| Real-time | socket.io server and client, one connection per signed-in session. Events today: new message, conversation update, import progress. |
| AI | `src/ai/agent.js`, `prompt.js`, `providers/claude.js` (Anthropic SDK, system prompt cached with `cache_control`, returns `usage`). Suggest / auto / off modes, practice mode, per-channel `ai_enabled`, debounce. |
| Meta | `src/platforms/meta.js` (send, receive, Graph API), `metaConnect.js` (OAuth, pages, WhatsApp Embedded Signup), `importer.js` (history import). |
| Client | React 19 + Vite 7, served at `/app`. **No router, no UI library, no state library.** Plain CSS in `client/src/style.css`, using CSS variables. Screens are switched by state in `App.jsx`. Fonts: Inter, Space Grotesk, Hind Siliguri (Google Fonts in `client/index.html`). |
| Tests | `node --test` on `test/**/*.test.js`, 79 tests, MongoDB in memory (`mongodb-memory-server-core`), fake Meta and AI servers in the helpers. **No linter, no type checker.** |
| Deploy | Docker project `quicky` on the Hostinger VPS. It builds from the GitHub branch on restart. |

**Design system.** The frames use the existing theme exactly: background `#F6F6F3`, panels white, border `#E4E4DE`, accent `#2B4BFF`, ink `#101217`, yellow `#FFD233`, success `#18A957`. Headings are in Space Grotesk, body text in Inter, Bangla in Hind Siliguri. The dashboard reuses these variables. Nothing new is invented.

---

## 2. Frozen — do not modify

Landing page:
- `public/index.html`, `public/bn.html`
- `src/routes/legal.js` (privacy, terms and data-deletion pages, linked from the landing page)
- In `src/app.js`: the routes for `/`, `/bn` and static `public/`. Other lines in `app.js` may be added to, but these routes stay as they are.

Onboarding (sign-up plus the 5 steps, and the Facebook, Instagram and WhatsApp connect popups):
- `client/src/components/Onboarding.jsx`
- `client/src/components/onboarding/parts.jsx`, `client/src/components/onboarding/parkedSteps.jsx`
- `client/src/components/ConnectFlow.jsx`
- `client/src/components/Auth.jsx` (contains the sign-up entry). The new log-in screen will be a new file that *uses* `SignupStep`; it won't edit this one.
- `client/src/connect.js`

Shared things onboarding depends on. They stay as they are; the dashboard gets its own versions where needed:
- `client/src/style.css` (global CSS and onboarding styles). Dashboard styles go in a new `client/src/dashboard/dashboard.css`, scoped under `.dash`.
- `client/src/components/common.jsx` (FacebookButton, WhatsAppButton, contexts)
- `client/src/api.js`, `client/index.html`, `client/vite.config.js`, `client/src/main.jsx`
- Server behaviour of `POST /api/auth/signup`, `/api/leads`, `GET/PATCH /api/account`, the onboarding fields of `PATCH /api/workspace`, everything in `src/routes/connect.js`, `src/platforms/metaConnect.js`, `/admin/leads.csv`, and the env names already in use. The tests that guard these must keep passing: `onboarding.test.js`, `setup.test.js`, `connect.test.js`.

**The one connection point: `client/src/App.jsx`.** It is the app root, and it currently renders the old `Inbox` when onboarding is finished or paused. I'll change only that line: render `<Dashboard>` instead of `<Inbox>`, and the new `<Login>` instead of `<Auth>`. `<Login>` still shows the same `SignupStep` for `?signup=1`. The onboarding branch, the "Go live" hand-off and the resume button stay byte-for-byte the same. I'll show you this diff on its own.

The PWA manifest and service worker are injected by dashboard code, so `client/index.html` stays unchanged.

Every phase ends with `git diff --stat a201c12 -- <frozen files>` and a byte check. A frozen file that changed gets reverted.

The old dashboard files (`Inbox.jsx`, `Settings.jsx`, `AiSettings.jsx`, `OrderDialog.jsx`, `OrdersDialog.jsx`) are not landing or onboarding. They are replaced by the new dashboard and stay in the repo untouched until Phase 1 is accepted. After that, I'll ask before deleting them.

---

## 3. Approach

- **Client structure.** New folder `client/src/dashboard/`:
  - `Shell` (Sidebar and Topbar), `router.js`, `i18n/` (`en.js`, `bn.js`), `ui/` (dashboard-only Button, Tabs, Modal, Drawer, Table, Toggle, Chip, Empty/Loading/Error states, Skeleton)
  - `screens/` (one folder per screen), `overlays/` (search, notifications, help, brand switcher, assign, snooze, notes, teach, product picker, why)
  - `mobile/` (the responsive layouts, mobile breakpoint ≤ 768 px)
- **Routing.** A small history-based router (about 60 lines, no dependency) under `/app/...`. The repo has none, and pulling in react-router for one level of paths isn't worth it.
- **i18n.** A `t('key')` function with English and Bangla dictionaries for every string in the dashboard. It also formats ৳ with Indian grouping (৳1,45,000), uses Bangla digits when the interface is in Bangla, and shows Asia/Dhaka times. The language is saved per user (Profile → Language) and toggled in the top bar.
- **Dark theme.** A `data-theme="dark"` set of the same variables, scoped to `.dash`, so onboarding is untouched.
- **Server structure.** New route modules under `src/routes/dashboard/` (one per area), mounted in `src/app.js` under `/api`. Domain logic lives in `src/services/`. Every external system gets an adapter in `src/adapters/<name>/` with `real` and `fake` modes. The mode is picked by env: fake when credentials are missing or `DRY_RUN=1`, so dev and tests never need keys.
- **Permissions.** A `can(user, action)` matrix taken from the Team → Permissions frame and enforced by middleware on every route (section 6). The UI hides what a role can't do, and the server refuses it with 403.
- **Real-time.** The existing socket.io connection gets rooms per workspace and per conversation. It carries:
  - message and conversation updates
  - a typing/viewing indicator (who is in a chat and who is typing, for collision detection)
  - order status changes
  - notifications and badge counts
- **Migrations.** A `migrations/` folder of numbered scripts, plus a `migrations` collection that records which have run. Run with `npm run migrate`, and automatically at server start. They cover indexes, the role rename (`moderator` stays valid) and backfills.
- **Seed.** `npm run seed:demo` creates **Nokshi Threads** with the people, orders, products and chats from the frames (Talha, Rafi, Mim, Jubayer, Sumi; Sadia Rahman, Tanvir Ahmed, Shirin Akter; orders #1029–#1052…). It is dev-only and refuses to run when `NODE_ENV=production`. The demo shop (ONB-09) uses the same seed, but in an isolated sandbox workspace.
- **Tests.** Each screen gets API tests (node:test, Mongo in memory, fake adapters) for its routes, permissions and validation, plus pure-function unit tests (money, phones, coupons, risk score, status pipeline). The UI is checked in the browser preview against the frame, with a screenshot.
- **Lint and type-check.** The repo has neither (section 10, question 7).

---

## 4. Data model

The existing collections stay. Additions are marked **new**; extra fields are marked +.

| Collection | Key fields |
|---|---|
| `workspaces` (= brand) | + `owner_account_id` (groups brands under one owner, UX-10), `modules` {key: bool} (UX-07), `business_hours`, `delivery_zones` [{key, name, charge, days}], `advance_rules` [], `notify_defaults`, `sla` {reply_min, warn_min, hours}, `assign_mode` (round_robin / least_busy / manual), `followup` {enabled, offer}, `credit_balance_paisa`, `spend_cap_daily`, `spend_cap_monthly`, `low_credit_alert`, `plan`, `plan_renews_at`, `trial_started_at` (BIL-04, set at go-live), `ai_version_id`, `ai_persona` (name, role, tone, style, address style, reply delay), `capi` {pixel_id, events}, `widget` {colour, position, greeting}, `api_key_hash`, `shop_slug` |
| `users` | role enum → `owner`, `admin`, `moderator`, `agent` (existing `moderator` kept). + `phone`, `avatar`, `display_name` (name customers see), `language`, `theme`, `on_duty`, `notify_prefs` {event: {app, phone, whatsapp}}, `quiet_hours`, `google_sub`, `two_step` |
| `sessions` | + `device`, `ip`, `last_seen`, `trusted` (UX-08/UX-11: where you're logged in, log out other devices) |
| `password_resets` **new** | user_id, code_hash, channel (email / sms), expires_at, attempts |
| `channels` | + `comments_ai`, `instagram_ai` flags (INB-11 per-channel switches), `kind` (+ `web` for the website widget) |
| `customers` **new** | workspace_id, name, phones [], emails [], contact_ids [] (one per channel), tags [], notes, ai_off + reason (TKT-03), blocked, stats {orders, delivered, returned, cancelled, spent}, courier_check {rate, total, checked_at}, risk {score, level, action}, last_active_at |
| `contacts` | + `customer_id` |
| `conversations` | status → `waiting`, `open`, `done`, `snoozed`, `spam`. + `ai_state` (ai / human / paused_until), `human_until`, `handoff_reason`, `act_now`, `snooze_until`, `snooze_note`, `reopened_at`, `auto_tags` [], `last_replier`, `waiting_since`, `first_reply_at`, `source_post_id`, `lead_status` |
| `messages` | + `kind` (text, image, voice, product_card, carousel, quick_replies, order_summary, receipt, delivery_card, size_chart, note), `payload`, `quoted_id`, `transcript` (voice), `ai_reply_id`, `author_user_id` |
| `notes` **new** | conversation_id or customer_id, author, text, mentions [user_id] (INB-09) |
| `comments` **new** | channel_id, post_id, external_id, parent_id, author, text, status (needs_you / ai_replied / hidden), public_reply, dm_sent, ai_reply_id |
| `posts` **new** | channel_id, external_id, caption, image, product_ids [], match (linked / ai_match / none), comment_rules {hide_spam, hide_phones, remind_once, react_followup}, ad_id |
| `products` | + `code`/SKU, `description`, `compare_at`, `category`, `photos` [], `video`, `options` [{name, values}], `ai_notes`, `visibility` (everywhere / ai_only / hidden), `size_chart_id`, `upsell_ids` [], `archived`, `sold_count` |
| `variants` **new** | product_id, options {size, colour}, sku, price, stock (null = not counted), reserved |
| `size_charts` **new** | name, unit, columns [], rows [], how_to_measure, image, category_ids [] |
| `orders` | + `number` (per workspace, #1052), `source` (ai / team / product_page / website), `taken_by` (ai / user_id), `items` [{product_id, variant_id, name, qty, price}], `subtotal`, `delivery_zone`, `delivery_charge`, `discount`, `coupon_code`, `advance` {amount, trx_id, method, verified}, `cod_amount`, `address` {full, district, thana, area}, `status` (pending, on_hold, approved, processing, ready_to_ship, in_transit, delivered, cancelled, returned), `cancel_reason`, `change_request` {field, old, new, at}, `details_changed`, `bill_token`, `notes` |
| `order_events` **new** | order_id, type (status / note / change / courier / payment), from, to, by (ai / user / courier / system), text, at (OMS-02 history, the Activity list) |
| `consignments` **new** | order_id, courier, consignment_id, tracking_code, status, events [], cod_collected, fee, payout_id |
| `courier_accounts` **new** | workspace_id, courier, credentials (encrypted with the existing `secrets.js`), auto_book, connected |
| `courier_payouts` **new** | courier, period, parcels, collected, fees, due_date, received_at (OMS-05) |
| `returns` **new** | order_id, type (return / damage / exchange), status, notes |
| `chase_items` **new** | order_id, customer_id, tries [], next_try_at, owner, result (OMS-07) |
| `payments` **new** | order_id or booking_id, method (bkash / nagad / gateway), amount, trx_id, from_number, screenshot, status (waiting / approved / rejected), decided_by (PAY-01) |
| `coupons` **new** | code, type (percent / amount / free_delivery), value, min_order, max_uses, used, starts, ends, audience (everyone / tag / segment / broadcast), ai_may_mention |
| `offers` **new** | customer_id, coupon_id or offer, source (broadcast / follow-up / win-back), expires_at (FUP-02, FUP-07: who got which offer and until when) |
| `saved_replies` | + `name`, `folder`, `pinned`, `scope` (team / private, owner), `blocks` [] (text, photo, product, voice, blank), `phrases` [], `word_rules`, `auto_answer`, `uses`, `answered_count` |
| `ai_versions` **new** | number, published_by, summary, snapshot {persona, knowledge, rules, taught}, self_test {passed, broke}, created_at (TRN-05) |
| `knowledge` **new** | kind (policy / delivery / exchange / hours / faq), title, text, voice_url, source |
| `ai_rules` **new** | text, category (price / handoff / tone / delivery / safety), enabled, author |
| `taught_answers` **new** | question, answer, when (conditions), attach (size_chart…), from_message_id, version_id |
| `unanswered` **new** | normalized question, examples [], count, last_asked_at, status (open / ignored / taught) |
| `ai_replies` **new** | conversation_id, message_id, model, input/output/cache tokens, cost_paisa, cached, steps [], sources [], version_id, rating (BIL-02, BIL-03, TRN-09) |
| `self_tests` **new** | run_at, results [{question, expected, got, pass}] (TRN-06) |
| `credit_ledger` **new** | type (top_up / ai_reply / refund / trial), amount_paisa, ref, balance_after |
| `tickets` **new** | number, customer_id, conversation_id, order_id, type (complaint / exchange / return / refund), act_now, reason, owner, status, resolution, timeline [] |
| `leads_pipeline` **new** (separate from the sign-up `leads`, which stays frozen) | customer_id, product_id, stage (new / contacted / call_scheduled / won / lost), temp (hot / warm), lost_reason, owner, follow_up_at, callback_at, times_asked |
| `followups` **new** | conversation_id, kind (3h / 20h), status, sent_at, skipped_reason |
| `broadcasts` **new** | audience {segment / temp / last_24h}, format (text / buttons / card / carousel / photo), content, scheduled_at, stats {sent, replied, ordered} |
| `segments` **new** | name, conditions [{field, op, value}], auto |
| `tags` **new** | name, colour, auto |
| `bookings` **new** | customer_id, service, start, end, status, advance {amount, trx_id}, reminders [], note |
| `quotes` **new** | customer_id, request, details, amount, status (waiting / sent / accepted / declined) |
| `notifications` **new** | user_id, type, title, body, link, actions, read_at |
| `push_subscriptions` **new** | user_id, endpoint, keys |
| `audit_log` **new** | user_id or system, action, target, before, after, where, at (TEAM-06) |
| `routing_rules` **new** | if {channel / topic / order_over / comment}, then {assign_to / ticket / notify} (TEAM-07) |
| `content_posts` **new** | product_id, about, tone, versions [], chosen, scheduled_at, targets [], status (draft / scheduled / posted) (CMT-06) |
| `integrations` **new** | kind (woocommerce / shopify / sheets / webhook / extension), config (encrypted), status |
| `webhooks` **new** | url, events [], secret, last_status |
| `announcements` **new** / `feature_requests` **new** | global news items with dismissals; requests with votes, status and a reply (UX-04, UX-05) |

Money is stored as integer paisa. Times are stored in UTC and shown in Asia/Dhaka. Bangladeshi phones are normalised with the existing `normalizeBdPhone`, extended to accept Bangla digits (০-৯), `+880` and `880`, and to require `01[3-9]` plus 8 digits.

---

## 5. Route map

### Client (`/app/...`)

| Path | Screen (frame) |
|---|---|
| `/app` | 01 Overview (+ 21 in Bangla, UX-02 in dark) |
| `/app/login` | 18 Log in: `?mode=forgot,code,reset,done`, wrong-password state |
| `/app/inbox`, `/app/inbox/:id` | 02 Inbox, 22 Done/bulk/typing, 22b Spam (`?tab=`) |
| `/app/comments`, `/app/comments/:postId` | 14 Comments thread + DM |
| `/app/orders`, `/app/orders/new`, `/app/orders/:n`, `/app/orders/:n/edit` | 03, 12, 11/11b/11c |
| `/app/orders/money?tab=cash,returns,chase` | OMS-05 Cash, Returns, OMS-07 To chase |
| `/app/customers`, `/app/customers/:id`, `/app/customers/segments` | 04, CRM-03/04 Tags & segments |
| `/app/growth?tab=followups,leads,broadcasts` | 05 |
| `/app/growth/leads?tab=pipeline,lost` | FUP-05 pipeline, FUP-04 callback popup, ANL-08 not ordered |
| `/app/tickets`, `/app/tickets/:n` | TKT-01/02 |
| `/app/saved-replies` | 06 |
| `/app/agent`, `/app/agent/training?tab=unanswered,rules,versions,selftest` | 07, TRN-04/03/05/06 |
| `/app/catalog`, `/app/catalog/new`, `/app/catalog/:id` | 08, 13 |
| `/app/catalog/size-charts`, `/app/catalog/posts` | CAT-05, CAT-06/CMT-02 |
| `/app/coupons` | ORD-05 list + create drawer |
| `/app/payments?tab=verify,rules,gateway` | PAY-01/03/02 |
| `/app/bookings?tab=calendar,quotes` | BKG-01–04 |
| `/app/content` | CMT-06 Content studio |
| `/app/analytics` | 09 |
| `/app/settings`, `/app/settings/{plan,channels,team,payments,courier,integrations,modules,notifications,audit}` | 10 + its P1/P2 tabs. The design switches the sidebar to a Settings menu on these pages, so each tab has its own path |
| `/app/settings/plan` | BIL Plan & upgrade |
| `/app/settings/team?tab=members,permissions,sla,auto,audit` | TEAM-01/02/05/07/06 |
| `/app/settings/delivery-updates` | CRR-03/05 |
| `/app/settings/integrations` | ANL-09/INT-02 |
| `/app/settings/modules` | UX-07 |
| `/app/profile` | UX-11 |
| `/app/demo` | ONB-09 sandbox shop + tour |

Overlays open over any screen and keep the URL:
- ⌘K search (23)
- notifications and their settings (16/16b)
- help, news and requests (UX-03/04/05)
- brand switcher and add brand (UX-10)
- assign (15)
- snooze and team notes (INB-04/09)
- teach (TRN-02/03)
- send products (CAT-04)
- why the AI said this (TRN-09)
- test chat (TRN-08)

Mobile (19a–f) is the same routes in a ≤ 768 px layout: bottom tabs Inbox / Orders / Alerts / More, plus an installable PWA with push notifications.

### Public (no login, Bangla first)

| Path | Frame |
|---|---|
| `/b/:token` | 20 Customer bill: confirmed, shipped, live status; request address change; bKash/Nagad advance |
| `/p/:shop/:product` | ORD-04 Product page → checkout form → bill back in chat |
| `/s/:shop` | INT-03 Shop link storefront |
| `/widget.js` + `/api/widget/*` | INT-02 Website chat widget |

The customer Messenger views (24a–e) aren't pages. They are what the AI sends through Meta: generic-template carousels, quick replies, the order summary and receipt, delivery-update cards, and the review request. They're built as message builders in the Meta adapter, and the dashboard's test chat renders them exactly as frame 24 shows.

### API (new, all under `/api`, all behind auth plus permission checks unless noted)

- `auth`:
  - `POST /auth/login` (+ remember device)
  - `POST /auth/google`
  - `POST /auth/forgot` → `/auth/verify-code` → `/auth/reset`
  - `GET /sessions`, `DELETE /sessions/:id`, `POST /sessions/logout-others`
- `overview`: `GET /overview`. KPIs today vs yesterday, needs-attention list, checklist, live activity, week chart, pipeline, AI spend.
- `conversations`:
  - list with tabs, counts, channel chips, Mine/Everyone, search and pagination
  - `takeover`, `release`, `assign`, `snooze`, `done`, `reopen`, `spam`, `not-spam`, `block`
  - bulk actions, `typing`/`viewing` presence (socket)
  - `summary` and `ask` (copilot), `suggest`, `notes`
- `comments`, `posts`: reply, hide, unhide, DM, link products, sync, automation rules.
- `orders`:
  - CRUD, `status` (writes `order_events`), `cancel` with a reason, `accept-change`/`keep-old`
  - `book-courier` (single and bulk), `labels.pdf`, `orders.csv`
  - `advance-request`, `notes`
- `money`: courier payouts, mark received, returns, chase list and result.
- `customers`:
  - list, filters, detail, timeline, `courier-check`, tags, notes, `ai-off`, merge
  - `segments` CRUD + preview count, `tags`
- `growth`: follow-ups, leads list and pipeline stage changes, callbacks, broadcasts (preview count, schedule, send), win-back.
- `saved-replies`: CRUD, `impact-preview`, `phrase-suggestions`, `mistake-check`.
- `ai`:
  - persona, knowledge, rules
  - `teach` (preview → publish), `versions` (list, rollback), `unanswered` (ignore / teach)
  - `readiness`, `self-test` (run, results), `test-chat` (text, image, voice), `replies/:id/why`
- `catalog`:
  - products, variants, stock, photos (upload), import CSV / Google Sheet, Woo sync
  - `size-charts`, `size-charts/:id/image.png`
- `coupons`, `payments` (verify list, approve, reject), `advance-rules`, `gateways`.
- `tickets`, `bookings`, `quotes`, `content` (generate, schedule).
- `analytics?range=`: attribution, ROI, heatmap, first reply / SLA, cancel reasons, courier rates, best sellers, sources, CSV.
- `billing`: balance, ledger, per-reply costs CSV, caps, top-up (bKash / Nagad / card), plans.
- `team`: members, invite, roles, on-duty, SLA, routing rules, `audit` (+ CSV).
- `notifications`: list, read, read-all, prefs, push subscribe.
- `search?q=`: chats, orders, customers, products, pages (⌘K).
- `brands`: list, create (blank or copy), switch.
- `integrations`: CAPI, widget, webhooks, API keys.
- `modules`, `announcements`, `feature-requests`, `help/ask`.
- Public:
  - `GET/POST /api/public/bill/:token`
  - `/api/public/shop/:slug/...` (product, checkout)
  - courier, payment and gateway webhooks under `/webhooks/...`

---

## 6. Roles and permissions (server-enforced)

From the Team → Permissions frame. Owner can always do everything.

| Action | Owner | Admin | Moderator | Agent |
|---|:-:|:-:|:-:|:-:|
| Reply to chats | ✓ | ✓ | ✓ | ✓ |
| See all chats (not just assigned) | ✓ | ✓ | ✓ | – |
| Create & edit orders | ✓ | ✓ | ✓ | ✓ |
| Cancel orders | ✓ | ✓ | ✓ | – |
| Book couriers | ✓ | ✓ | ✓ | – |
| Teach the AI & publish | ✓ | ✓ | – | – |
| Edit products & prices | ✓ | ✓ | – | – |
| See customer phone numbers | ✓ | ✓ | ✓ | ✓ |
| Billing & top-up | ✓ | – | – | – |
| Invite teammates | ✓ | ✓ | – | – |

The owner can change the ticks; they're stored per workspace and checked on every request. Existing `moderator` users keep today's behaviour.

---

## 7. External services: adapters and env vars

Every adapter has a **fake** mode, used in dev and tests and whenever its credentials are missing. Keys are read only from env (or, for per-shop accounts such as courier keys, from the encrypted DB fields entered in Settings). Nothing is hard-coded.

| Adapter | Used for | Env vars (new ones marked *) |
|---|---|---|
| `meta` (exists) | Messenger, Instagram, comments, private replies, post sync, templates | `META_APP_ID`, `META_APP_SECRET`, `META_VERIFY_TOKEN`, `META_GRAPH_VERSION` (existing names unchanged) |
| `meta-capi` * | Conversions API events (ANL-09) | per-shop pixel ID and token in Settings; `META_CAPI_TEST_CODE`* (optional) |
| `whatsapp` (exists via Meta) | WhatsApp Cloud API | existing |
| `ai` (exists) | Replies, copilot, teach preview, self-test, content studio, voice transcription | `ANTHROPIC_API_KEY`, `AI_MODEL`*, `AI_TRANSCRIBE_PROVIDER`* (see question 2) |
| `steadfast`, `pathao`, `redx`, `paperfly`, `ecourier` * | Booking, tracking webhooks/polling, payouts | per-shop keys in Settings → Courier; `COURIER_WEBHOOK_SECRET`* |
| `fraudcheck` * | Cross-merchant delivery success (CRM-02) | `FRAUDCHECK_API_KEY`* (see question 4) |
| `bkash`, `nagad`, `sslcommerz` * | PAY-02 gateway, BIL-05 top-ups | `BKASH_APP_KEY`*, `BKASH_APP_SECRET`*, `BKASH_USERNAME`*, `BKASH_PASSWORD`*, `NAGAD_MERCHANT_ID`*, `NAGAD_PUBLIC_KEY`*, `NAGAD_PRIVATE_KEY`*, `SSLCZ_STORE_ID`*, `SSLCZ_STORE_PASS`*, `PAYMENTS_SANDBOX`* |
| `sms` * | Phone codes for password reset and 2-step login | `SMS_PROVIDER`*, `SMS_API_KEY`*, `SMS_SENDER_ID`* |
| `email` * | Reset codes, invites | `SMTP_URL`* or `RESEND_API_KEY`*, `MAIL_FROM`* |
| `google-auth` * | Continue with Google | `GOOGLE_CLIENT_ID`*, `GOOGLE_CLIENT_SECRET`* |
| `push` * | Web push (PWA) | `VAPID_PUBLIC_KEY`*, `VAPID_PRIVATE_KEY`*, `VAPID_SUBJECT`* |
| `woocommerce`, `shopify`, `sheets` * | INT-01, ONB-12 | per-shop in Integrations |
| `storage` * | Product photos, voice notes, size-chart images | `UPLOAD_DIR`* (local Docker volume by default), optional `S3_*`* |

New dependencies, each only where the repo has nothing for the job:
- `web-push`, for push encryption.
- `pdfkit`, for courier labels (OMS "Print labels").
- `@resvg/resvg-js`, to render size charts as images: the AI sends an image (CAT-05), and the server must produce a PNG.

That's all. Everything else uses what's already installed. `.env.example` and the README will list every variable.

---

## 8. Feature → screen → backend (all 163)

ONB rows belong to onboarding, which is frozen and already built. Their dashboard-side parts are listed.

| ID | Pri | Screen / route | Backend pieces |
|---|---|---|---|
| ONB-01 | P0 | onboarding (frozen); Settings → Channels reuses the ConnectFlow popup | existing connect routes |
| ONB-02 | P0 | onboarding (frozen); Modules uses the business type | workspace.category |
| ONB-03 | P1 | onboarding (frozen); fields the AI collects show on orders | workspace.order_fields |
| ONB-04 | P0 | onboarding (frozen); AI agent → Persona edit | ai persona API |
| ONB-05 | P0 | as ONB-04 | persona.address_style |
| ONB-06 | P0 | onboarding (frozen); Settings → Courier zones | delivery_zones |
| ONB-07 | P0 | Overview → Go-live checklist card | `/overview` checklist |
| ONB-08 | P0 | Top bar AI live / Practice toggle | workspace.ai_mode, trial_started_at at go-live |
| ONB-09 | P2 | `/app/demo` sandbox + 4-step tour | sandbox workspace seed, reset |
| ONB-10 | P1 | onboarding (frozen) | existing |
| ONB-11 | P1 | Help panel: "Call us", WhatsApp support, setup help | help config |
| ONB-12 | P1 | Catalog → Import CSV / Google Sheet / Woo | productImport + sheets adapter |
| INB-01 | P0 | `/app/inbox` | conversations API, meta/whatsapp/widget |
| INB-02 | P0 | Inbox tabs Waiting / Unread / Open / Done + counts | status model, counts query |
| INB-03 | P0 | 22 Done + auto-reopen banner | reopen on inbound message |
| INB-04 | P1 | Snooze popup ("Later") | snooze_until + scheduler + notification |
| INB-05 | P0 | ⌘K / "/" search | `/search` (text index on messages, customers, orders) |
| INB-06 | P1 | 22 channel chips, Mine/Everyone, select, bulk, tidy up, mark all read | bulk endpoints |
| INB-07 | P0 | Chat row badges, timers, auto-tags | auto_tags, waiting_since |
| INB-08 | P0 | Customer side panel | customer summary API |
| INB-09 | P1 | Team notes & @mentions | notes + notifications |
| INB-10 | P1 | "Rafi is typing" bar | socket presence |
| INB-11 | P0 | AI agent → channel pills | channel ai flags |
| INB-12 | P0 | Mobile 19a–f, PWA, push | manifest, service worker, push adapter |
| TEAM-01 | P0 | Team → Members (unlimited, invite) | users API, invites |
| TEAM-02 | P1 | Team → Permissions | permission matrix + middleware |
| TEAM-03 | P0 | 15 Assign popup | assign API + notification |
| TEAM-04 | P1 | Team → on-duty toggles, sidebar "On duty" | users.on_duty, routing |
| TEAM-05 | P1 | Team → Duty & SLA | SLA config, counters |
| TEAM-06 | P2 | Team → Audit log + CSV | audit_log writer on every mutation |
| TEAM-07 | P2 | Team → Auto-assign | assignment.js + routing_rules |
| AI-01 | P0 | (behaviour) shown in Inbox / Test chat | prompt + language detection |
| AI-02 | P1 | AI agent → reply delay | seen → typing → send with delay |
| AI-03 | P0 | AI agent → tone / style | prompt |
| AI-04 | P0 | 24e voice note | transcription adapter |
| AI-05 | P0 | 24 photo → product cards | vision + catalog match, confidence |
| AI-06 | P0 | 24e burst | existing debounce, one combined reply |
| AI-07 | P1 | 24e quoted reply | quoted_id context |
| AI-08 | P0 | 14 Comments, Posts | post → product mapping in context |
| AI-09 | P0 | Inbox panel, Why | cross-channel customer memory |
| AI-10 | P0 | Why panel, Training rules | catalog tool for price and stock; discounts only from coupons/offers |
| AI-11 | P0 | 24 size buttons | quick replies |
| AI-12 | P1 | Product form "Suggested add-ons", 24e | upsell_ids carousel |
| AI-13 | P2 | 24e gift picks | budget search tool |
| AI-14 | P1 | Size charts, 24 | media tool (photos, video, chart image) |
| AI-15 | P2 | 24e shop hours | business_hours tool |
| TRN-01 | P0 | AI agent → knowledge (write or voice) | knowledge API, transcription |
| TRN-02 | P1 | Teach popup (3 steps) | teach preview → publish version |
| TRN-03 | P1 | Training → New instruction + phone preview | rules + preview |
| TRN-04 | P1 | Training → Unanswered | unanswered collector |
| TRN-05 | P1 | Training → Versions, "Undo last publish" | ai_versions, rollback |
| TRN-06 | P2 | Training → Self-test, Run now | self-test job, weekly cron, alert |
| TRN-07 | P1 | Training → readiness % + gaps | readiness scorer |
| TRN-08 | P0 | Test chat (top bar, AI agent) | `/ai/test-chat` (practice, no customer) |
| TRN-09 | P2 | Why did the AI say this? | ai_replies.steps / sources |
| TRN-10 | P1 | Training → Rules | ai_rules |
| HND-01 | P0 | Inbox tip "type ." | webhook echo: "." from page → pause / resume |
| HND-02 | P0 | AI agent setting, Inbox banner | human_until → auto-return job |
| HND-03 | P0 | Take over / Back to AI | takeover / release API |
| HND-04 | P1 | Inbox AI summary, ask, suggested reply | copilot endpoints |
| HND-05 | P2 | Chrome extension panel | `extension/` MV3 + `/api/ext/*` |
| HND-06 | P0 | Overview "Needs attention", notifications | escalation flags + push |
| CAT-01 | P0 | 08 Catalog, 13 Product form | products, variants, uploads |
| CAT-02 | P0 | Variants & stock | stock reserve/release on orders, AI offers available sizes |
| CAT-03 | P0 | 24 product cards | carousel builder (≤5) |
| CAT-04 | P1 | Send products picker (≤10) | send products API |
| CAT-05 | P1 | Size charts | charts + PNG render |
| CAT-06 | P1 | Posts | post sync + AI match |
| CMT-01 | P0 | 14 Comments | public reply + private DM (Graph) |
| CMT-02 | P1 | Posts: price range + carousel | multi-product rule |
| CMT-03 | P2 | Posts automation toggle | reminder job |
| CMT-04 | P2 | Posts automation toggle | reaction webhook → DM within Meta rules |
| CMT-05 | P2 | Posts automation, Comments "Hidden" | spam classifier + hide |
| CMT-06 | P2 | Content studio | AI generate, schedule, publish to Page/IG |
| ORD-01 | P0 | 24 order flow | order capture tools |
| ORD-02 | P0 | 24b summary | summary builder |
| ORD-03 | P0 | 20 Bill page | `/b/:token`, live status |
| ORD-04 | P1 | Product page + checkout | public shop API, bill back to chat |
| ORD-05 | P1 | Coupons | coupons, AI apply |
| ORD-06 | P0 | 24b edits, Order detail | pre-confirm edit tools, new bill |
| ORD-07 | P0 | 11 change request bar | change_request + handoff |
| ORD-08 | P0 | 24b, 20 | zone ETA |
| ORD-09 | P0 | 12 New order (from chat too) | orders API |
| ORD-10 | P0 | 12, checkout form | phone validation (EN + Bangla digits) |
| ORD-11 | P1 | 24c confirmed + next steps | confirmation template |
| OMS-01 | P0 | 03 Orders + KPI tiles | orders list + stats |
| OMS-02 | P0 | inline status, detail stepper | status machine + order_events |
| OMS-03 | P0 | filters, search, CSV | query + CSV |
| OMS-04 | P1 | "7 orders", "Details updated" badges | stats, details_changed |
| OMS-05 | P1 | Money: Cash, Returns | payouts, returns |
| OMS-06 | P1 | 11c cancel with reason | cancel_reason |
| OMS-07 | P1 | Money: To chase | chase_items |
| CRR-01 | P0 | Book with Steadfast/Pathao (single, bulk, auto) | courier adapters |
| CRR-02 | P0 | 11b tracking | courier webhooks/poll → events |
| CRR-03 | P1 | Delivery updates settings, 24d | delivery cards per step |
| CRR-04 | P0 | 24d "Where's my parcel" | tracking tool |
| CRR-05 | P1 | Delivery updates toggle, notifications | alert on cancel after ship |
| CRR-06 | P2 | Review request toggle, 24d | review card + coupon |
| CRR-07 | P2 | Couriers list (RedX, Paperfly, eCourier) | adapters |
| PAY-01 | P1 | Payments → Verify (+ WhatsApp/Telegram approve) | payments, approve links |
| PAY-02 | P2 | Payments → Gateway | bKash / Nagad / SSLCommerz adapters |
| PAY-03 | P1 | Payments → Advance rules | rules evaluated at order time |
| CRM-01 | P0 | 04 Customers profile | customers + stats |
| CRM-02 | P0 | "Before you ship" courier check | fraudcheck adapter |
| CRM-03 | P1 | Segments COD risk column, order risk | risk scorer |
| CRM-04 | P1 | Tags & segments | tags, segments, auto tags |
| SR-01 | P0 | 06 Saved replies library | saved_replies |
| SR-02 | P1 | auto-answer + phrases | fuzzy matcher (emoji, ???, salam, bhai/apu, Bangla digits) |
| SR-03 | P1 | "Found in your chats" | phrase discovery from messages |
| SR-04 | P2 | "Would have answered 214…" | impact preview query |
| SR-05 | P1 | + Photo / Product / Voice / Blank | blocks + uploads |
| SR-06 | P1 | live price note | price resolved at send time |
| SR-07 | P2 | personal blanks | blank fill from order, never guess |
| SR-08 | P0 | composer "/" + suggestions + AI adapt | composer API |
| SR-09 | P1 | mistake checker | phone / bKash digit check |
| SR-10 | P1 | works without credit | auto-answer bypasses credit |
| FUP-01 | P1 | 05 Follow-ups | follow-up scheduler (3h / 20h, max 2, 24h window) |
| FUP-02 | P2 | Not ordered → Win them back offer | offers with expiry |
| FUP-03 | P0 | 05 Leads tab | leads_pipeline auto-capture |
| FUP-04 | P1 | Schedule a callback popup | callback_at, outcome |
| FUP-05 | P2 | Lead pipeline (won / lost) | stage board |
| FUP-06 | P1 | 05 Broadcasts | broadcasts + recipient count |
| FUP-07 | P1 | Broadcasts, Coupons | offers ledger in AI context |
| FUP-08 | P2 | Not ordered | repeat-asker detector |
| TKT-01 | P1 | Support tickets | tickets |
| TKT-02 | P0 | ACT NOW (Overview, Tickets, Inbox) | angry detection → handoff + ticket |
| TKT-03 | P0 | 22b Spam folder | spam classifier, no AI call |
| BKG-01 | P2 | Bookings calendar | bookings |
| BKG-02 | P2 | booking TrxID | advance fields |
| BKG-03 | P2 | reminders | day-before job |
| BKG-04 | P2 | Quotes | quotes |
| ANL-01 | P0 | 01 Overview | overview aggregates |
| ANL-02 | P1 | 09 Who took the orders | attribution |
| ANL-03 | P1 | 09 Revenue per ৳ of AI | ROI from credit_ledger |
| ANL-04 | P2 | 09 heatmap | messages by hour (Dhaka) |
| ANL-05 | P1 | 09 first reply / SLA | first_reply_at |
| ANL-06 | P1 | 09 cancel reasons, couriers | aggregates |
| ANL-07 | P2 | 09 best sellers, sources | aggregates |
| ANL-08 | P1 | 09 link + Not ordered list | leads lost |
| ANL-09 | P1 | Integrations → Meta CAPI | capi adapter |
| INT-01 | P2 | Integrations → WooCommerce/Shopify | sync adapters |
| INT-02 | P1 | Integrations → Website chat widget | widget.js + widget channel |
| INT-03 | P2 | Shop link `/s/:shop` | public shop API |
| INT-04 | P2 | Integrations → Webhooks & API key | webhooks dispatcher, API key auth |
| BIL-01 | P0 | Settings → Billing | credit_ledger, charge per AI reply |
| BIL-02 | P1 | Cost of every reply + CSV | ai_replies |
| BIL-03 | P0 | Cache savings line | prompt caching + usage accounting |
| BIL-04 | P0 | trial credit | trial ledger entry at go-live |
| BIL-05 | P0 | Top up bKash / Nagad / card | payment adapters |
| BIL-06 | P1 | spend cap, alert below | caps enforced before AI call |
| UX-01 | P0 | whole dashboard in Bangla (21) | i18n dictionaries, user.language |
| UX-02 | P2 | dark theme (Profile, top bar) | user.theme |
| UX-03 | P1 | Help panel, first-visit video, help bot | help content + `/help/ask` (AI) |
| UX-04 | P2 | announcement bar, What's new | announcements |
| UX-05 | P2 | Help → Requests (text / voice) | feature_requests |
| UX-06 | P2 | ⌘K jump anywhere | search + commands |
| UX-07 | P1 | Modules | workspace.modules hides nav and routes |
| UX-08 | P0 | 18 Log in, Google, forgot by email/SMS, trusted device | auth routes, sms/email adapters |
| UX-09 | P0 | 16 Notifications panel + settings | notifications, prefs |
| UX-10 | P1 | Brand switcher + Add brand (blank / copy) | brands under one owner account |
| UX-11 | P1 | Profile | profile, sessions |
| UX-12 | P0 | 17 states on every screen | shared Empty/Loading/Error/Offline/Reconnect components |

---

## 9. Phases

Within each phase, one screen is finished end to end before the next starts: UI matching the frame, API, data, permissions, i18n strings, empty/loading/error states and tests. After each screen, `FEATURE_STATUS.md` is updated (ID | status | route) and the work is committed. Each phase is deployed only when you say so.

**Phase 1: shell, auth, data model, P0 screens 01–24**
1. Foundations:
   - migrations runner, new models, roles and permission middleware
   - adapters (fake modes first), i18n, router, dashboard UI kit, socket rooms
   - Nokshi Threads seed
2. Shell: Sidebar (brand switcher stub, badges, AI credit card, on-duty), Top bar (search, AI live/Practice, Test chat, language, bell).
3. 18 Log in (all modes) + the `App.jsx` connection.
4. 01 Overview, then 21 (Bangla) is checked here, since it's the same screen.
5. 02 Inbox + 15 Assign + 22/22b + 14 Comments + the composer (`/`) + takeover / dot takeover / auto-return.
6. 03 Orders, 12 New/edit order, 11/11b/11c Order detail, courier booking (Steadfast and Pathao, fake mode until accounts exist).
7. 04 Customers (courier check, timeline).
8. 05 Follow-ups / leads / broadcasts (P0 leads list; the follow-up and broadcast engines too, since they're on this screen).
9. 06 Saved replies, 07 AI agent (persona, knowledge, unanswered, test chat, channel switches), 08 Catalog, 13 Product form.
10. 09 Analytics, 10 Settings & billing (all five tabs).
11. 16 Notifications + push, 23 ⌘K search, 17 states applied everywhere.
12. 19 Mobile layouts + PWA, 20 Customer bill page, 24 Messenger message builders + test-chat renderer.
13. AI pipeline: live price and stock, escalation and ACT NOW, spam filter, per-reply cost, caching, credit charging.

P0 features whose frame sits on the P1 page get their **backend in Phase 1** and their screen in Phase 2: TEAM-01 (invite already works in Settings → Team), TKT-02 (ACT NOW shows on Overview and Inbox in Phase 1).

**Phase 2: P1 screens.** In order: Teach popup → Training → Tickets → Send products → Posts → Size charts → Coupons → Payments verify / rules → Delivery updates → Snooze & notes → Tags & segments → Team (members, permissions, SLA) → Help → Integrations → Plan → Brand switcher + Add brand → Profile → Money (cash / returns / to-chase) → Callbacks / Not ordered → Modules → Public product page + checkout.

**Phase 3: P2 screens.** Demo shop + tour → Why did the AI say this? → Chrome extension (MV3 folder, panel UI; publishing to the Chrome Web Store needs your developer account) → Content studio → Bookings + Quotes → Self-test → Auto-assign → Audit log → Lead pipeline → Payment gateway → Announcements → Feature requests → Dark theme → Shop link.

After each phase: frozen-file check, full tests, a production build, and a short summary listing what's done, what's partial, conflicts, and what I need from you.

**Size, honestly:** this is a very large build: about 45 screens, roughly 40 new collections and 14 external integrations. It won't fit in one sitting. I'll work through it screen by screen across many turns, committing as I go, so you can stop me, review or redirect at any point.

---

## 10. Questions only you can answer

1. **Prices.** The Plan page shows `[PRICE]` and `[INCLUDED AI REPLIES]` for Starter, Growth and Pro, plus top-up amounts (৳500 / ৳1,000 / ৳2,500 / ৳5,000 with reply counts) and the per-AI-reply charge. What are the real numbers? Until you tell me, they stay as visible placeholders, and top-ups work only in sandbox.
2. **AI provider.** Keep Anthropic Claude (already wired in, prompt caching works)? Voice notes (AI-04) need speech-to-text, and Claude doesn't take audio. Which service should transcribe Bangla voice notes? Options include OpenAI Whisper, Google Speech-to-Text and others.
3. **Couriers.** Which accounts do you have: Steadfast, Pathao, RedX, Paperfly, eCourier? Each shop enters its own keys in Settings; I need sandbox keys to test the real APIs.
4. **Courier fraud check (CRM-02).** Cross-merchant delivery success needs a data source, for example a BD fraud-check API service or courier data. Which one, or should it stay fake for now?
5. **Payments.** Do you have bKash merchant (tokenized checkout), Nagad merchant and SSLCommerz store accounts, for both top-ups (BIL-05) and the shop gateway (PAY-02)? Sandbox credentials are enough to start.
6. **Log-in extras.** For "Continue with Google", a Google OAuth client is needed. For phone reset codes, an SMS gateway: which one (e.g. SSL Wireless, BulkSMSBD, Alpha SMS)? For email reset codes: SMTP or Resend?
7. **Lint and type-check.** Your brief asks for both, but the repo is plain JavaScript with neither. Should I add ESLint (dev dependency only, run in CI and before commits)? Should I skip TypeScript, since converting would mean touching the frozen files?
8. **PWA push notifications.** OK to generate VAPID keys and add them as env vars in hPanel? You'd add them yourself; I'll give you the names.
9. **Old dashboard files.** When Phase 1 is accepted, may I delete the replaced `Inbox.jsx`, `Settings.jsx`, `AiSettings.jsx`, `OrderDialog.jsx` and `OrdersDialog.jsx`?

### Conflicts noticed so far (feature row wins for behaviour, design wins for looks)

- Your brief describes onboarding as "10 steps"; the live onboarding is the 5-step version you asked for last time. That's what I'll freeze.
- The sheet lists TEAM-01 (Unlimited teammates) as P0, but its frame is on the P1 page. The backend comes in Phase 1 and the Team screen in Phase 2 (see section 9).
- The sheet lists ONB-08 ("free trial clock starts at go-live") and BIL-04 ("trial starts at go-live"). The current code starts nothing at go-live. I'll add `trial_started_at` when "Go live" is pressed, on the server side only, without changing onboarding's screens.
- PAY-01 says the admin approves "from Telegram/WhatsApp". The frame shows "Approvals also on WhatsApp & Telegram". WhatsApp approval links work through the existing WhatsApp channel. Telegram needs a bot token (`TELEGRAM_BOT_TOKEN`), which I'll add as optional.
- Several sheet rows point to frames I haven't opened yet (24c/24d/24e, 11b, the 18b–e log-in states, the Bangla overview, some tab states). They are states of screens I've read; I'll open each in full when I build that screen.
