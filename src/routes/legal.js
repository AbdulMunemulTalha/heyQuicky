import { Router } from 'express';

// Pages Meta's App Review asks for: privacy policy, terms of service, data deletion instructions, and a
// support page. Their URLs go into App settings → Basic. Keep them in step with what the product really does:
// reviewers compare them with the permissions the app asks for.

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function page(title, body, { operator }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} · ${escapeHtml(operator)}</title>
<link rel="icon" href="/favicon.ico" sizes="any"><link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@600;700&amp;family=Inter:wght@400;500;600;700&amp;display=swap" rel="stylesheet">
<style>
  :root { --bg: #F6F6F3; --panel: #FFFFFF; --text: #101217; --muted: #5B606B; --border: #E4E4DE; --accent: #2B4BFF; }
  body { margin: 0; background: var(--bg); color: var(--text); font: 16px/1.65 Inter, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
  header { border-bottom: 1px solid var(--border); background: rgba(246, 246, 243, 0.92); }
  header div { max-width: 760px; margin: 0 auto; padding: 14px 16px; }
  .logo { display: inline-flex; align-items: center; gap: 8px; color: var(--text); text-decoration: none; font: 700 20px/1 "Space Grotesk", Inter, sans-serif; letter-spacing: -0.02em; }
  .logo img { display: block; height: 36px; width: auto; }
  main { max-width: 760px; margin: 32px auto 64px; padding: 40px; background: var(--panel); border: 1px solid var(--border); border-radius: 24px; box-sizing: border-box; }
  h1, h2, h3 { font-family: "Space Grotesk", Inter, sans-serif; letter-spacing: -0.02em; }
  h1 { margin: 0 0 4px; font-size: 36px; line-height: 1.1; }
  h2 { margin-top: 32px; font-size: 21px; }
  h3 { margin: 20px 0 4px; font-size: 17px; }
  li { margin: 4px 0; }
  a { color: var(--accent); }
  .muted { color: var(--muted); }
  table { width: 100%; border-collapse: collapse; font-size: 14.5px; margin: 8px 0; }
  th, td { text-align: left; vertical-align: top; padding: 8px 10px; border-bottom: 1px solid var(--border); }
  th { font-weight: 600; }
  nav { display: flex; gap: 16px; flex-wrap: wrap; margin-top: 40px; padding-top: 20px; border-top: 1px solid var(--border); font-size: 14px; }
  @media (max-width: 640px) { main { margin: 16px; padding: 24px; } h1 { font-size: 28px; } table { font-size: 13.5px; } }
</style>
</head>
<body>
<header><div><a class="logo" href="/"><img src="/brand/quicky-color.svg" alt="Quicky" height="36"></a></div></header>
<main>
<h1>${escapeHtml(title)}</h1>
${body}
<nav><a href="/privacy">Privacy policy</a><a href="/terms">Terms of service</a><a href="/data-deletion">Data deletion</a><a href="/support">Support</a><a href="/">Home</a><a href="/app">Log in</a></nav>
</main>
</body>
</html>`;
}

export function legalRoutes(config) {
  const router = Router();
  const operator = config.legal.operator;
  const email = config.legal.supportEmail;
  const contact = email
    ? `<a href="mailto:${escapeHtml(email)}">${escapeHtml(email)}</a>`
    : 'the contact address shown in your account';
  const updated = `<p class="muted">Last updated: ${escapeHtml(config.legal.updated)}</p>`;
  const opts = { operator };
  const op = escapeHtml(operator);

  router.get('/privacy', (_req, res) => res.send(page('Privacy policy', `${updated}
<p>${op} ("we", "us") is a customer-messaging service for online shops. It lets a business answer the messages and comments
its customers send on Facebook, Instagram and WhatsApp from one inbox, with an AI assistant that can reply for the business,
and record the orders, payments and deliveries that come out of those conversations. This policy explains what data we
handle, why, and the choices you have.</p>

<h2>Who this covers</h2>
<ul>
  <li><strong>Businesses</strong> that sign up for ${op}, and the team members they invite.</li>
  <li><strong>Customers</strong> of those businesses: people who message a business, or comment on its Facebook or Instagram posts.</li>
</ul>
<p>For customer data, the business decides what it collects and why, and we process that data on the business's behalf and
on its instructions. For business account data, we decide how it is used, as described here.</p>

<h2>What we collect</h2>
<h3>From businesses</h3>
<ul>
  <li><strong>Account details:</strong> business name, team members' names, email addresses and phone numbers, and passwords (stored only as one-way hashes).</li>
  <li><strong>Connected accounts:</strong> the IDs and names of the Facebook Pages, Instagram professional accounts and WhatsApp Business numbers a business connects, and the access tokens Meta issues for them. Tokens are stored encrypted.</li>
  <li><strong>Shop setup:</strong> products, prices, stock, delivery charges, policies and answers the business teaches the AI.</li>
  <li><strong>Billing:</strong> the plan, AI credit balance and top-up records. We do not store card numbers.</li>
</ul>
<h3>From Meta, about a business's customers</h3>
<ul>
  <li><strong>Messages:</strong> messages exchanged on the business's connected Messenger, Instagram and WhatsApp accounts, the customer's name, profile picture and platform ID as provided by Meta, attachments (such as photos and voice notes) and delivery status.</li>
  <li><strong>Comments:</strong> comments people post on the business's Facebook Page and Instagram posts: the comment text, the commenter's name and platform ID, the post it belongs to, and the business's replies.</li>
  <li><strong>Posts:</strong> the business's own posts (text, images and linked products), so comments can be matched to products and so the business can schedule new posts.</li>
</ul>
<h3>Created while the business uses ${op}</h3>
<ul>
  <li><strong>Orders and bookings:</strong> customer name, phone number, delivery address, products, amounts, payment status and delivery tracking.</li>
  <li><strong>Customer notes:</strong> tags, notes and order history the business keeps about its customers.</li>
  <li><strong>Technical data:</strong> server logs (such as IP address, browser and time of request) used to keep the service secure and working. We sign team members in with a token stored in the browser; we do not use advertising or tracking cookies.</li>
</ul>

<h2>How we use it</h2>
<p>Only to provide ${op} to the business that connected the account:</p>
<ul>
  <li>show messages and comments in the business's inbox, and send the business's replies back on the same platform;</li>
  <li>reply to a comment publicly, send the commenter one private message about their comment (for example a product's price), and hide comments that are spam or that expose a phone number, following the business's settings;</li>
  <li>let the AI assistant draft or send replies in the business's name, using the conversation, the shop's products and its policies;</li>
  <li>turn voice notes into text so they can be answered;</li>
  <li>create and track orders, payment links and courier deliveries;</li>
  <li>publish posts the business writes or approves to its own Page and Instagram account;</li>
  <li>send account emails (such as sign-in links, alerts and receipts), keep the service secure, and fix problems.</li>
</ul>
<p>We do not sell personal data, use it for advertising, build profiles of people across businesses, or use data received from
Meta for any purpose other than providing ${op} to the business that connected the account. We do not use data received
from Meta to train AI models.</p>

<h2>Who we share it with</h2>
<p>We share data only with the service providers we need to run ${op}, and only what each one needs:</p>
<table>
  <tr><th>Provider</th><th>What for</th></tr>
  <tr><td>Meta Platforms (Facebook, Instagram, WhatsApp)</td><td>Receiving and sending messages and comments, and publishing posts, on the business's connected accounts.</td></tr>
  <tr><td>Anthropic</td><td>The AI assistant: the conversation and the shop details needed to write a reply.</td></tr>
  <tr><td>OpenAI</td><td>Turning voice notes into text, when the business uses this.</td></tr>
  <tr><td>Payment gateways (SSLCommerz, bKash, Nagad)</td><td>Taking a payment when a customer chooses to pay online. The customer pays on the gateway's own page.</td></tr>
  <tr><td>Couriers (such as Pathao, Steadfast and RedX)</td><td>Booking a delivery the business asks for: the customer's name, phone number, address and amount to collect.</td></tr>
  <tr><td>Resend</td><td>Sending account emails.</td></tr>
  <tr><td>Hostinger</td><td>Hosting the servers and database that store the data.</td></tr>
</table>
<p>We also share data when the business itself exports or sends it (for example to its own webhook or API connection), or when the law requires it.</p>

<h2>How long we keep it</h2>
<p>For as long as the business's account is active. When a business disconnects an account, the conversations and comments from
that account are deleted. When a business closes its account or asks for deletion, we delete its data within 30 days, except
records the law requires us to keep (such as payment records).</p>

<h2>Security</h2>
<p>Connections use HTTPS, access tokens and other secrets are encrypted at rest, passwords are hashed, team members only see
what their role allows, and every payment is checked with the gateway before it counts. We back up the database and limit
who can reach the servers.</p>

<h2>Children</h2>
<p>${op} is a tool for businesses and is not meant for children. Businesses must not use it to knowingly collect data from children under 13.</p>

<h2>Your choices and rights</h2>
<p>You can ask us for a copy of your data, or ask us to correct or delete it. See <a href="/data-deletion">data deletion</a>,
or contact us at ${contact}. If you are a customer of a business that uses ${op}, you can also contact that business
directly; we will help it answer your request. A business can remove ${op}'s access to its Facebook account at any time
from its Facebook settings.</p>

<h2>Changes</h2>
<p>We will post any changes to this policy on this page and update the date above. If a change is significant, we will tell businesses by email or in the app.</p>

<h2>Contact</h2>
<p>${op} · ${contact}</p>`, opts)));

  router.get('/terms', (_req, res) => res.send(page('Terms of service', `${updated}
<p>These terms are an agreement between ${op} and the business that creates an account ("you"). By creating an account or using ${op} you agree to them.</p>

<h2>The service</h2>
<p>${op} lets you manage messages and comments from your own Facebook Pages, Instagram professional accounts and WhatsApp
Business numbers in one inbox, use an AI assistant to answer customers, and record orders, payments and deliveries.
You must have the right to manage every account you connect, and you must be old enough to enter a contract.</p>

<h2>Your responsibilities</h2>
<ul>
  <li>Follow Meta's terms and policies, including the Meta Platform Terms, the Messenger and Instagram messaging policies, and the WhatsApp Business policies.</li>
  <li>Only message people in ways those platforms allow (for example within the 24-hour messaging window), and send at most the one private reply to a comment that Meta allows.</li>
  <li>Do not send spam, misleading offers, or unlawful content, and do not sell anything the platforms or the law forbid.</li>
  <li>Keep your team members' passwords safe and remove people who should no longer have access.</li>
  <li>Handle your customers' personal data lawfully. You are responsible for the data you collect from your customers and for telling them how you use it.</li>
</ul>

<h2>The AI assistant</h2>
<p>When you switch the AI on, it replies to customers in your name using your products, prices and policies. You are responsible
for what your shop says, so keep your product details and policies accurate and check the AI's work. The AI hands a conversation
to your team when it is unsure or a customer asks for a person. AI replies use AI credit from your account.</p>

<h2>Payments and fees</h2>
<p>Plans and AI credit are priced as shown in the app. Payments your customers make go to your own payment gateway account;
${op} does not hold your money. Courier and gateway charges are between you and those providers.</p>

<h2>Availability</h2>
<p>We work to keep ${op} running, but it is provided "as is". Messaging depends on Meta's platforms and other providers, which may
change or be unavailable, and we are not liable for losses caused by outages or by changes they make.</p>

<h2>Ending the service</h2>
<p>You can stop using ${op} at any time and ask us to delete your data. We may suspend accounts that break these terms or Meta's
policies, or that put customers or the service at risk.</p>

<h2>Changes and law</h2>
<p>We may update these terms and will post changes on this page. These terms are governed by the laws of Bangladesh.</p>

<h2>Contact</h2>
<p>${contact}</p>`, opts)));

  router.get('/data-deletion', (_req, res) => res.send(page('Data deletion', `${updated}
<p>You can have your data removed from ${op} at any time.</p>
<h2>If you are a business using ${op}</h2>
<ol>
  <li>To remove a single Page, Instagram account or WhatsApp number: open <strong>Settings → Channels</strong> and click
    <strong>Disconnect</strong>. Its conversations and comments are deleted straight away.</li>
  <li>To stop ${op} from accessing your Facebook account: on Facebook go to <strong>Settings &amp; privacy → Settings →
    Business integrations</strong>, select ${op} and click <strong>Remove</strong>. For Instagram, go to
    <strong>Settings → Website permissions → Apps and websites</strong> and remove ${op}.</li>
  <li>To delete your whole account and all of its data: email ${contact} from your account's email address with the subject
    "Delete my account". We delete everything within 30 days and confirm by email.</li>
</ol>
<h2>If you messaged or commented on a business that uses ${op}</h2>
<p>Ask that business to delete your conversation, or email ${contact} with the name of the business and the platform you used
(Messenger, Instagram or WhatsApp). We will delete your messages, comments and any order details within 30 days and confirm.
Deleting a comment on Facebook or Instagram also removes it from ${op}.</p>`, opts)));

  router.get('/support', (_req, res) => res.send(page('Support', `
<p>Need help with ${op}? We're here.</p>
<h2>Contact us</h2>
<ul>
  <li>Email: ${contact}</li>
  <li>In the app: click the <strong>?</strong> button at the bottom of the menu for help articles, or send us a feature request.</li>
</ul>
<h2>Common questions</h2>
<h3>How do I connect my Facebook Page or Instagram account?</h3>
<p>Open <strong>Settings → Channels</strong>, click <strong>Connect</strong> and follow the Facebook window. Choose the Pages and Instagram accounts you want ${op} to manage.</p>
<h3>Why are my comments not showing?</h3>
<p>Reconnect the Page from <strong>Settings → Channels</strong> and allow the comment permissions in the Facebook window.</p>
<h3>How do I turn the AI off?</h3>
<p>Use the <strong>AI live / Off</strong> switch at the top of the dashboard. While it is off, only your team replies.</p>
<h3>How do I delete my data?</h3>
<p>See <a href="/data-deletion">data deletion</a>.</p>`, opts)));

  return router;
}
