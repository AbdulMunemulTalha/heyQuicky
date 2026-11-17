# Feature status

Updated after each screen. **Done** = built, wired to real data and tested. **Partial** = what's missing is listed.
ONB rows belong to onboarding, which is frozen and was built earlier; only their dashboard-side parts are tracked here.

Phase 1 progress: foundations (data model, migrations, roles, adapters, router, i18n, UI kit), shell, log-in and 01 Overview are built.

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
| INB-01 | Not started (screen 02) | /app/inbox |
| INB-02 | Not started (screen 02) | /app/inbox |
| INB-03 | Not started (screen 22) | /app/inbox?tab=done |
| INB-04 | Not started (Phase 2) | overlay |
| INB-05 | Partial — ⌘K, Ctrl+K and "/" open the search overlay; search itself comes with screen 23 | overlay |
| INB-06 | Not started (screen 22) | /app/inbox |
| INB-07 | Not started (screen 02) | /app/inbox |
| INB-08 | Not started (screen 02) | /app/inbox |
| INB-09 | Not started (Phase 2) | overlay |
| INB-10 | Not started (screen 22) | /app/inbox |
| INB-11 | Not started (screen 07) | /app/agent |
| INB-12 | Partial — responsive shell with bottom tabs (≤768 px); PWA and push come with screen 19 | /app |
| TEAM-01 | Partial — roles model; invite screen comes with screen 10 / Phase 2 | /app/settings/team |
| TEAM-02 | Partial — permission matrix enforced on the server (`need()`), owner overrides stored per shop; screen in Phase 2 | /app/settings/team |
| TEAM-03 | Not started (screen 15) | overlay |
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
| HND-01 | Not started | inbox / webhooks |
| HND-02 | Not started | inbox |
| HND-03 | Not started (screen 02) | /app/inbox |
| HND-04 | Not started (screen 02) | /app/inbox |
| HND-05 | Not started (Phase 3) | extension/ |
| HND-06 | Partial — escalations and handoffs listed under Overview → Needs attention; push alerts come with screen 16 | /app |
| CAT-01 | Not started (screens 08, 13) | /app/catalog |
| CAT-02 | Not started | /app/catalog |
| CAT-03 | Not started (screen 24) | messages |
| CAT-04 | Not started (Phase 2) | overlay |
| CAT-05 | Not started (Phase 2) | /app/catalog/size-charts |
| CAT-06 | Not started (Phase 2) | /app/catalog/posts |
| CMT-01 | Not started (screen 14) | /app/comments |
| CMT-02 | Not started (Phase 2) | /app/catalog/posts |
| CMT-03 | Not started (Phase 3) | /app/catalog/posts |
| CMT-04 | Not started (Phase 3) | /app/catalog/posts |
| CMT-05 | Not started (Phase 3) | /app/catalog/posts |
| CMT-06 | Not started (Phase 3) | /app/content |
| ORD-01 | Not started | AI pipeline |
| ORD-02 | Not started (screen 24) | messages |
| ORD-03 | Not started (screen 20) | /b/:token |
| ORD-04 | Not started (Phase 2) | /p/:shop/:product |
| ORD-05 | Not started (Phase 2) | /app/coupons |
| ORD-06 | Not started | AI pipeline |
| ORD-07 | Not started (screen 11) | /app/orders/:n |
| ORD-08 | Not started | AI pipeline |
| ORD-09 | Not started (screen 12) | /app/orders/new |
| ORD-10 | Partial — `bdPhone` / `phoneProblem` accept Bangla digits and +880 and explain the error (tested); used by the order form in screen 12 | server util |
| ORD-11 | Not started (screen 24) | messages |
| OMS-01 | Not started (screen 03) | /app/orders |
| OMS-02 | Partial — status pipeline and `order_events` history model; screens 03/11 | /app/orders |
| OMS-03 | Not started (screen 03) | /app/orders |
| OMS-04 | Not started (screen 03) | /app/orders |
| OMS-05 | Not started (Phase 2) | /app/orders/money |
| OMS-06 | Not started (screen 11) | /app/orders/:n |
| OMS-07 | Not started (Phase 2) | /app/orders/money |
| CRR-01 | Not started (screens 03, 11) | /app/orders |
| CRR-02 | Not started (screen 11) | /app/orders/:n |
| CRR-03 | Not started (Phase 2) | /app/settings/delivery-updates |
| CRR-04 | Not started | AI pipeline |
| CRR-05 | Not started (Phase 2) | /app/settings/delivery-updates |
| CRR-06 | Not started (Phase 3) | /app/settings/delivery-updates |
| CRR-07 | Not started (Phase 3) | /app/settings/courier |
| PAY-01 | Not started (Phase 2) | /app/payments |
| PAY-02 | Not started (Phase 3) | /app/payments?tab=gateway |
| PAY-03 | Not started (Phase 2) | /app/payments?tab=rules |
| CRM-01 | Not started (screen 04) | /app/customers |
| CRM-02 | Partial — courier fraud-check adapter (fake mode until a data source is chosen); shown in screens 04/11/12 | adapter |
| CRM-03 | Not started (Phase 2) | /app/customers/segments |
| CRM-04 | Not started (Phase 2) | /app/customers/segments |
| SR-01 | Not started (screen 06) | /app/saved-replies |
| SR-02 | Not started (screen 06) | /app/saved-replies |
| SR-03 | Not started (screen 06) | /app/saved-replies |
| SR-04 | Not started (screen 06) | /app/saved-replies |
| SR-05 | Not started (screen 06) | /app/saved-replies |
| SR-06 | Not started (screen 06) | /app/saved-replies |
| SR-07 | Not started (screen 06) | /app/saved-replies |
| SR-08 | Not started (screens 02, 06) | /app/inbox |
| SR-09 | Not started (screen 06) | /app/saved-replies |
| SR-10 | Not started | AI pipeline |
| FUP-01 | Not started (screen 05) | /app/growth |
| FUP-02 | Not started (Phase 3) | /app/growth/leads?tab=lost |
| FUP-03 | Not started (screen 05) | /app/growth?tab=leads |
| FUP-04 | Not started (Phase 2) | /app/growth/leads |
| FUP-05 | Not started (Phase 3) | /app/growth/leads |
| FUP-06 | Not started (screen 05) | /app/growth?tab=broadcasts |
| FUP-07 | Not started | AI pipeline |
| FUP-08 | Not started (Phase 3) | /app/growth/leads?tab=lost |
| TKT-01 | Not started (Phase 2) | /app/tickets |
| TKT-02 | Partial — ACT NOW chats listed first under Overview → Needs attention; detection and tickets come with the AI pipeline | /app |
| TKT-03 | Not started (screen 22b) | /app/inbox?tab=spam |
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
