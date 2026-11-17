# Feature status

Updated after each screen. **Done** = built, wired to real data and tested. **Partial** = what's missing is listed.
ONB rows belong to onboarding, which is frozen and was built earlier; only their dashboard-side parts are tracked here.

Phase 1 progress: foundations, shell, log-in, 01 Overview, 02 Inbox (+ 15, 22, 22b), 14 Comments, 03 Orders, 11 Order detail (+ 11b, 11c), 12 New / edit order, 04 Customers, 05 Follow-ups, leads & broadcasts and 06 Saved replies are built.

| ID | Status | Route |
|---|---|---|
| ONB-01 | Done (onboarding); Settings → Channels reuse comes with screen 10 | onboarding |
| ONB-02 | Done (onboarding) | onboarding |
| ONB-03 | Done (onboarding) | onboarding |
| ONB-04 | Done (onboarding); editing in AI agent comes with screen 07 | onboarding |
| ONB-05 | Done (onboarding) | onboarding |
| ONB-06 | Done (onboarding); zone editing comes with screen 10 | onboarding |
| ONB-07 | Done — Overview go-live checklist (7 items, live counts) | /app |
| ONB-08 | Partial — top-bar AI live / Practice switch works, trial clock starts at first go-live; trial credit amount waits on pricing (`TRIAL_CREDIT`) | /app (top bar) |
| ONB-09 | Not started (Phase 3) — the seed it will use exists (`src/dashboard/demoSeed.js`, sandbox mode) | /app/demo |
| ONB-10 | Done (onboarding) | onboarding |
| ONB-11 | Not started (Help panel, Phase 2) | overlay |
| ONB-12 | Not started (screen 08) | /app/catalog |
| INB-01 | Done — Messenger, Instagram, WhatsApp (and website chat channel type) in one list; reply from the dashboard | /app/inbox |
| INB-02 | Done — Waiting / Unread / Open / Done (+ Spam) tabs with live counts, per channel and Mine/Everyone | /app/inbox |
| INB-03 | Done — one-tap Done; the chat reopens by itself when the customer writes, with a "Back from Done" tag and a Reopened banner | /app/inbox?tab=done |
| INB-04 | Partial — Later / snooze picker (1 h, tonight, tomorrow, next week, custom, note); snoozed chats leave the lists and come back at the time or when the customer writes. Missing: the reminder notification at wake-up | /app/inbox |
| INB-05 | Partial — ⌘K, Ctrl+K and "/" open the search overlay; search itself comes with screen 23 | overlay |
| INB-06 | Done — channel chips with counts, Mine/Everyone, select, bulk Done / Reopen / Assign / Tag / Not spam, Tidy up, Mark all read | /app/inbox |
| INB-07 | Done — AI/person badge, who replied last, waiting timer, ACT NOW, needs-a-person, auto tags (Back from Done, customer tags) | /app/inbox |
| INB-08 | Partial — side panel with AI summary, delivery record, orders, team notes, tags, AI switch. Missing: follow-ups, bookings and lead status (come with screens 05 and P2 Bookings) | /app/inbox |
| INB-09 | Partial — team notes on a chat with @mentions that notify the teammate; the dedicated Team notes popup frame comes in Phase 2 | /app/inbox |
| INB-10 | Done — live "Rafi is typing a reply…" bar from socket presence; replying to a chat someone else owns asks you to take over first | /app/inbox |
| INB-11 | Not started (screen 07) | /app/agent |
| INB-12 | Partial — responsive shell with bottom tabs (≤768 px); PWA and push come with screen 19 | /app |
| TEAM-01 | Partial — roles model; invite screen comes with screen 10 / Phase 2 | /app/settings/team |
| TEAM-02 | Partial — permission matrix enforced on the server (`need()`), owner overrides stored per shop; screen in Phase 2 | /app/settings/team |
| TEAM-03 | Done — Assign popup (frame 15): teammates with on-duty dots and open-chat counts, keep AI replying, note; the assignee gets a notification | overlay |
| TEAM-04 | Partial — sidebar On duty / Off duty toggle saves and broadcasts; routing by duty comes with the inbox | /app (sidebar) |
| TEAM-05 | Not started (Phase 2) | /app/settings/team |
| TEAM-06 | Partial — audit log written for AI mode changes; screen in Phase 3 | /app/settings/audit |
| TEAM-07 | Not started (Phase 3) | /app/settings/team |
| AI-01 | Not started | AI pipeline |
| AI-02 | Not started | AI pipeline |
| AI-03 | Not started | AI pipeline |
| AI-04 | Not started | AI pipeline |
| AI-05 | Not started | AI pipeline |
| AI-06 | Not started | AI pipeline |
| AI-07 | Not started | AI pipeline |
| AI-08 | Not started | AI pipeline |
| AI-09 | Not started | AI pipeline |
| AI-10 | Not started | AI pipeline |
| AI-11 | Not started | AI pipeline |
| AI-12 | Not started | AI pipeline |
| AI-13 | Not started | AI pipeline |
| AI-14 | Not started | AI pipeline |
| AI-15 | Not started | AI pipeline |
| TRN-01 | Not started (screen 07) | /app/agent |
| TRN-02 | Not started (Phase 2) | overlay |
| TRN-03 | Not started (Phase 2) | /app/agent/training |
| TRN-04 | Not started (Phase 2) | /app/agent/training |
| TRN-05 | Not started (Phase 2) | /app/agent/training |
| TRN-06 | Not started (Phase 3) | /app/agent/training |
| TRN-07 | Not started (Phase 2) | /app/agent/training |
| TRN-08 | Partial — "Test chat" button in the top bar opens the panel; the chat comes with screen 07 | overlay |
| TRN-09 | Not started (Phase 3) | overlay |
| TRN-10 | Not started (Phase 2) | /app/agent/training |
| HND-01 | Done — "." from Messenger / Business Suite pauses the AI, "." again hands back; the dot is not stored | webhooks |
| HND-02 | Done — after a takeover or reply the AI returns by itself after 30 min (per-shop setting `auto_return_min`; its control comes with screen 07) | /app/inbox |
| HND-03 | Done — Take over / Back to AI buttons | /app/inbox |
| HND-04 | Partial — AI summary, "Ask about this customer" and "Draft reply with AI". Ask and draft need ANTHROPIC_API_KEY; the summary falls back to order history without it | /app/inbox |
| HND-05 | Not started (Phase 3) | extension/ |
| HND-06 | Partial — escalations and handoffs listed under Overview → Needs attention; push alerts come with screen 16 | /app |
| CAT-01 | Not started (screens 08, 13) | /app/catalog |
| CAT-02 | Not started | /app/catalog |
| CAT-03 | Not started (screen 24) | messages |
| CAT-04 | Not started (Phase 2) | overlay |
| CAT-05 | Not started (Phase 2) | /app/catalog/size-charts |
| CAT-06 | Not started (Phase 2) | /app/catalog/posts |
| CMT-01 | Partial — comments from Facebook and Instagram webhooks; public reply, private DM and hide from the dashboard. Missing: the AI replying to comments by itself (AI pipeline step) | /app/comments |
| CMT-02 | Not started (Phase 2) | /app/catalog/posts |
| CMT-03 | Not started (Phase 3) | /app/catalog/posts |
| CMT-04 | Not started (Phase 3) | /app/catalog/posts |
| CMT-05 | Partial — spam and phone-number comments are hidden automatically when they arrive; the switches live on the P1 Posts screen | /app/comments |
| CMT-06 | Not started (Phase 3) | /app/content |
| ORD-01 | Not started | AI pipeline |
| ORD-02 | Not started (screen 24) | messages |
| ORD-03 | Not started (screen 20) | /b/:token |
| ORD-04 | Not started (Phase 2) | /p/:shop/:product |
| ORD-05 | Partial — coupons (% off, ৳ off, free delivery, minimum order, dates, max uses) apply in the order form and are counted; the Coupons screen comes in Phase 2 | /app/orders/new |
| ORD-06 | Not started | AI pipeline |
| ORD-07 | Done — the customer's change request (address or phone) shows on the order with old → new, Keep old / Accept change; the decision is logged | /app/orders/:n |
| ORD-08 | Partial — delivery zones with days (incl. Dhaka suburbs) on orders and the form; the AI telling the customer comes with the AI pipeline | /app/orders/:n |
| ORD-09 | Done — New order form (screen 12): phone check, address split into district/thana/zone, product search with sizes and stock, payment (COD, bKash advance + TrxID, paid), coupon, note, draft, edit; prices come from the catalog and stock is reserved | /app/orders/new |
| ORD-10 | Done — Bangladeshi phone validation in the order form and on the server: 11 digits, 013–019, Bangla digits and +880 accepted, with a clear message | /app/orders/new |
| ORD-11 | Partial — orders created from a chat send a confirmation with items, delivery time and cash to collect; the designed Messenger card comes with screen 24 | /app/orders/new |
| OMS-01 | Done — every order (AI, team, product page, website) with KPI tiles: today, to confirm, ready to ship, COD to collect, returns · 7 days; live updates | /app/orders |
| OMS-02 | Done — pipeline Pending → On hold → Approved → Processing → Ready to ship → In transit → Delivered / Cancelled with only valid moves; inline status menu; every move written to the order history | /app/orders |
| OMS-03 | Done — status tabs with counts, source, zone and date filters, search by name, phone (Bangla digits too) or #number, pagination, CSV export | /app/orders |
| OMS-04 | Done — "N orders" / VIP repeat-buyer badge and "Details updated" flag | /app/orders |
| OMS-05 | Not started (Phase 2) | /app/orders/money |
| OMS-06 | Done — cancel with one of five reasons, optionally putting items back in stock, from the list or the order (frame 11c) | /app/orders/:n |
| OMS-07 | Not started (Phase 2) | /app/orders/money |
| CRR-01 | Partial — one-click and bulk booking (list, order detail, or "Book right away" when creating) with Steadfast and Pathao; real APIs once the shop adds keys, test mode otherwise; label sheet. Missing: auto-booking on approve and key entry in Settings → Couriers (screen 10) | /app/orders |
| CRR-02 | Partial — tracking timeline on the order (frame 11b), Refresh, and a background check of every parcel on the way every 30 minutes that moves the order to Delivered / Returned. Missing: courier webhooks (polling covers it until then) | /app/orders/:n |
| CRR-03 | Not started (Phase 2) | /app/settings/delivery-updates |
| CRR-04 | Not started | AI pipeline |
| CRR-05 | Not started (Phase 2) | /app/settings/delivery-updates |
| CRR-06 | Not started (Phase 3) | /app/settings/delivery-updates |
| CRR-07 | Not started (Phase 3) | /app/settings/courier |
| PAY-01 | Not started (Phase 2) | /app/payments |
| PAY-02 | Not started (Phase 3) | /app/payments?tab=gateway |
| PAY-03 | Partial — "Ask for ৳300 bKash advance" sends your bKash number in the customer's chat and records the request; automatic advance rules come in Phase 2 | /app/orders/:n |
| CRM-01 | Done — customers list (search by name, phone in Bangla or English digits, tag; All / Repeat buyers / VIP / High risk; CSV) and a profile with orders, delivered / returned / cancelled, delivered %, one timeline across Messenger, Instagram, WhatsApp, comments and orders, team notes and tags | /app/customers |
| CRM-02 | Partial — "Before you ship" on the customer, the order and the order form, cached a day. Uses sample data until a fraud-check service is chosen (FRAUDCHECK_API_URL) | /app/customers |
| CRM-03 | Partial — COD risk score (own returns + courier record + amount + zone) shown as Low / Medium / High on orders; segments screen in Phase 2 | /app/orders |
| CRM-04 | Not started (Phase 2) | /app/customers/segments |
| SR-01 | Done — library with shortcuts, folders, whole team / only me, pin to top, usage counts, "answered free this week" | /app/saved-replies |
| SR-02 | Done — auto-answer before the AI: customer phrases matched while ignoring emoji, ???, salam, bhai/apu, word order and Bangla vs English digits; no AI call, ৳0; paused when a teammate takes over or the customer is off / blocked / spam | /app/saved-replies |
| SR-03 | Done — "Found in your chats": real customer phrasings from the last 60 days that are related but not yet covered, added in one tap | /app/saved-replies |
| SR-04 | Done — "would have answered N messages from M customers in the last 14 days" updates as phrases change | /app/saved-replies |
| SR-05 | Partial — extra messages, photos and voice notes (uploaded, kept in MongoDB, served at /files/…), product blocks and blanks. Missing: sending photos/voice as Messenger attachments and product cards as designed cards (screen 24) — sent as links/text for now | /app/saved-replies |
| SR-06 | Done — product blocks read the live price; hidden, archived or sold-out products stop the reply from going out by itself | /app/saved-replies |
| SR-07 | Done — {name}, {order_number}, {order_total}, {cod}, {delivery_charge}, {tracking} filled from the customer's own details; if any is missing the reply is not sent on its own | /app/saved-replies |
| SR-08 | Partial — "/" search in the composer, suggested replies above the box, AI draft. Missing: AI adapting a saved reply while keeping numbers and links | /app/inbox |
| SR-09 | Done — warns when a phone or bKash number in a reply doesn't have 11 digits (Bangla digits too) | /app/saved-replies |
| SR-10 | Done — auto-answers need no AI key or credit and record ৳0 cost | AI pipeline |
| FUP-01 | Done — chats where the customer asked and went quiet are watched: hot (delivery, address, quantity, size) gets reminders at 3 h and 20 h, warm (price only) at 20 h; at most 2, only inside the 24 h window, never in chats a teammate owns; replies and orders stop them; on/off switch; runs every 5 minutes | /app/growth |
| FUP-02 | Partial — optional 10% offer on the last reminder (switch on screen 05). Missing: an expiring per-customer offer the AI honours only until it ends (P2) | /app/growth |
| FUP-03 | Done — interested customers are captured automatically with the product, interest and when to follow up; To chase / Contacted; Open chat, WhatsApp, copy number, Log call (Ordered / Call later / No answer / Not interested) | /app/growth?tab=leads |
| FUP-04 | Not started (Phase 2) | /app/growth/leads |
| FUP-05 | Not started (Phase 3) | /app/growth/leads |
| FUP-06 | Partial — Broadcasts: hot / warm / last 24 h / buyers in 24 h, live recipient count that respects Meta's 24-hour rule, text / buttons / product / carousel / photo, send now or schedule, results (replied, ordered). Missing: the designed Messenger cards (screen 24) — sent as text for now; WhatsApp templates | /app/growth?tab=broadcasts |
| FUP-07 | Not started | AI pipeline |
| FUP-08 | Not started (Phase 3) | /app/growth/leads?tab=lost |
| TKT-01 | Not started (Phase 2) | /app/tickets |
| TKT-02 | Partial — ACT NOW chats listed first under Overview → Needs attention; detection and tickets come with the AI pipeline | /app |
| TKT-03 | Done — first messages are checked for spam; the Spam folder gets no AI reply (৳0); Not spam, Block, and "AI for this customer" off with a note | /app/inbox?tab=spam |
| BKG-01 | Not started (Phase 3) | /app/bookings |
| BKG-02 | Not started (Phase 3) | /app/bookings |
| BKG-03 | Not started (Phase 3) | /app/bookings |
| BKG-04 | Not started (Phase 3) | /app/bookings?tab=quotes |
| ANL-01 | Done — Overview KPIs (conversations vs yesterday, orders and revenue today, AI-handled %, first reply, needs a person), week chart, pipeline, live activity, AI spend; updates live over the socket | /app |
| ANL-02 | Not started (screen 09) | /app/analytics |
| ANL-03 | Partial — "Revenue per ৳1 of AI" on Overview → AI spend today; full report in screen 09 | /app |
| ANL-04 | Not started (screen 09) | /app/analytics |
| ANL-05 | Not started (screen 09) | /app/analytics |
| ANL-06 | Not started (screen 09) | /app/analytics |
| ANL-07 | Not started (screen 09) | /app/analytics |
| ANL-08 | Not started (screen 09) | /app/analytics |
| ANL-09 | Not started (Phase 2) | /app/settings/integrations |
| INT-01 | Not started (Phase 3) | /app/settings/integrations |
| INT-02 | Not started (Phase 2) | /app/settings/integrations |
| INT-03 | Not started (Phase 3) | /s/:shop |
| INT-04 | Not started (Phase 3) | /app/settings/integrations |
| BIL-01 | Partial — credit ledger (`credit_ledger`), balance in the sidebar with replies-left estimate; charging per reply comes with the AI pipeline | /app (sidebar) |
| BIL-02 | Not started (screen 10) | /app/settings |
| BIL-03 | Not started (screen 10) | /app/settings |
| BIL-04 | Partial — trial starts at first go-live; amount waits on pricing | /app |
| BIL-05 | Not started (screen 10) | /app/settings |
| BIL-06 | Not started (screen 10) | /app/settings |
| UX-01 | Partial — full Bangla for the shell, log-in and Overview with Bangla digits and ৳ grouping; a test fails if any English string lacks a Bangla one; other screens add theirs as they're built | /app |
| UX-02 | Partial — dark theme variables and `user.theme`; Profile switch in Phase 2, frame in Phase 3 | /app |
| UX-03 | Not started (Phase 2) | overlay |
| UX-04 | Not started (Phase 3) | overlay |
| UX-05 | Not started (Phase 3) | overlay |
| UX-06 | Partial — keyboard shortcuts open search; commands come with screen 23 | overlay |
| UX-07 | Partial — sidebar hides switched-off modules (`workspace.settings.modules`); Modules screen in Phase 2 | /app |
| UX-08 | Partial — log in by email or phone (Bangla digits too), wrong-password state, forgot → 6-digit code by email or SMS → new password (logs out other devices), "keep me logged in", Continue with Google. Missing: Google needs `GOOGLE_CLIENT_ID`; real email/SMS need `RESEND_API_KEY` / `SMS_API_URL` | /app/login |
| UX-09 | Partial — bell with live unread count; panel comes with screen 16 | overlay |
| UX-10 | Partial — brand list in `/dash/me` and the sidebar switcher button; switcher panel in Phase 2 | overlay |
| UX-11 | Partial — language and theme saved per user; Profile screen in Phase 2 | /app/profile |
| UX-12 | Partial — Empty / Error / Forbidden / Not found / Offline / Skeleton components and the offline bar; applied to each screen as it's built (Overview done) | all |
