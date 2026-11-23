// UX-03 · Help: short articles for each page, in English and Bangla. The help bot answers from these
// and links to the page ("Open it for me →"). pages: which screens show it under "Popular on this page".
export const ARTICLES = [
  { id: 'overview', pages: ['overview'], minutes: 1, link: '/',
    en: ['Your day at a glance', 'Overview shows today\'s chats, orders and how many the AI handled alone. "Needs attention" lists what a person should do now — open each one from there. The go-live checklist shows what\'s left to set up.'],
    bn: ['এক নজরে আজকের দিন', 'ওভারভিউতে আজকের চ্যাট, অর্ডার আর AI একা কতগুলো সামলেছে তা দেখা যায়। "Needs attention"-এ যা এখনই মানুষের করা দরকার তা থাকে — সেখান থেকেই খুলুন। গো-লাইভ চেকলিস্টে বাকি সেটআপ দেখায়।'] },
  { id: 'needs-person', pages: ['overview', 'inbox'], minutes: 2, link: '/inbox',
    en: ['What "Needs a person" means', 'When the AI isn\'t sure — a complaint, a refund, a question it can\'t answer — it hands the chat to your team and tells the customer someone will reply. Those chats wait under Waiting in the Inbox. Reply, then press Back to AI or Done.'],
    bn: ['"Needs a person" মানে কী', 'AI নিশ্চিত না হলে — অভিযোগ, রিফান্ড বা যে প্রশ্নের উত্তর জানে না — চ্যাটটা টিমের কাছে দেয় আর কাস্টমারকে জানায় কেউ উত্তর দেবেন। এগুলো ইনবক্সের Waiting-এ থাকে। উত্তর দিয়ে Back to AI বা Done চাপুন।'] },
  { id: 'take-over', pages: ['inbox'], minutes: 1, link: '/inbox',
    en: ['Take over a chat and hand it back', 'Press Take over in a chat to stop the AI and reply yourself (or type "." in Messenger). Press Back to AI when you\'re done — after the time set in AI agent the AI comes back on its own and remembers what you said.'],
    bn: ['চ্যাট নিজে নেওয়া আর ফেরত দেওয়া', 'চ্যাটে Take over চাপলে AI থামে, আপনি উত্তর দেন (মেসেঞ্জারে "." লিখলেও হয়)। শেষ হলে Back to AI চাপুন — AI এজেন্টে ঠিক করা সময় পর AI নিজেই ফেরে আর আপনি যা বলেছেন মনে রাখে।'] },
  { id: 'teach', pages: ['inbox', 'agent', 'training'], minutes: 1, link: '/agent/training',
    en: ['Teach the AI from a wrong reply', 'Press 👎 under an AI reply, pick what was wrong and write the right answer. It\'s saved as a new version — the AI uses it from the next message. Undo it any time from Training → Versions.'],
    bn: ['ভুল উত্তর থেকে AI-কে শেখান', 'AI-এর উত্তরের নিচে 👎 চাপুন, কী ভুল ছিল বেছে নিয়ে ঠিক উত্তর লিখুন। এটা নতুন ভার্সন হিসেবে সেভ হয় — পরের মেসেজ থেকেই AI ব্যবহার করে। ট্রেনিং → ভার্সন থেকে যেকোনো সময় ফেরানো যায়।'] },
  { id: 'pipeline', pages: ['orders'], minutes: 3, link: '/orders',
    en: ['Read the order pipeline', 'Every order moves Pending → Approved → Processing → Ready to ship → In transit → Delivered. Change a status from the list or the order. Booking a courier moves it to In transit, and the courier check moves it to Delivered or Returned.'],
    bn: ['অর্ডারের ধাপগুলো বুঝুন', 'প্রতিটি অর্ডার Pending → Approved → Processing → Ready to ship → In transit → Delivered ধাপে এগোয়। তালিকা বা অর্ডার থেকে অবস্থা বদলান। কুরিয়ার বুক করলে In transit হয়, কুরিয়ার চেক Delivered বা Returned করে দেয়।'] },
  { id: 'advance', pages: ['orders', 'payments'], minutes: 2, link: '/payments?tab=rules',
    en: ['Ask for an advance outside Dhaka', 'Go to Payments → Advance rules and turn on "Outside Dhaka orders". Set the amount (e.g. ৳300) and your bKash or Nagad number. The AI asks for it before confirming, and the order waits until you approve the TrxID in Payments.'],
    bn: ['ঢাকার বাইরে অগ্রিম চাওয়া', 'পেমেন্ট → অ্যাডভান্স রুলস-এ গিয়ে "Outside Dhaka orders" চালু করুন। টাকার পরিমাণ (যেমন ৳৩০০) আর বিকাশ বা নগদ নম্বর দিন। কনফার্মের আগে AI চায়, আর পেমেন্টে TrxID অনুমোদন না দেওয়া পর্যন্ত অর্ডার অপেক্ষা করে।'] },
  { id: 'verify', pages: ['payments'], minutes: 1, link: '/payments',
    en: ['Approve a bKash / Nagad payment', 'Payments lists TrxIDs customers sent, with their screenshot. Check the amount in your bKash or Nagad app, then press Approve — the customer is told and the order moves on. Reject tells them politely.'],
    bn: ['বিকাশ / নগদ পেমেন্ট অনুমোদন', 'পেমেন্টে কাস্টমারের পাঠানো TrxID আর স্ক্রিনশট থাকে। বিকাশ বা নগদ অ্যাপে টাকা মিলিয়ে Approve চাপুন — কাস্টমার জানেন আর অর্ডার এগোয়। Reject চাপলে ভদ্রভাবে জানানো হয়।'] },
  { id: 'courier', pages: ['orders', 'settings'], minutes: 2, link: '/settings/courier',
    en: ['Connect Steadfast or Pathao', 'In Settings → Couriers & delivery, press Connect and paste the API keys from your courier\'s merchant panel. Then book any order in one click, or turn on auto-booking.'],
    bn: ['স্টেডফাস্ট বা পাঠাও যুক্ত করুন', 'সেটিংস → কুরিয়ার ও ডেলিভারিতে Connect চেপে কুরিয়ারের মার্চেন্ট প্যানেলের API কী বসান। তারপর এক ক্লিকে যেকোনো অর্ডার বুক করুন, বা অটো-বুকিং চালু করুন।'] },
  { id: 'delivery-updates', pages: ['orders', 'settings'], minutes: 1, link: '/settings/delivery-updates',
    en: ['Send delivery updates automatically', 'Settings → Couriers & delivery → Delivery updates: pick which steps message the customer (picked up, out for delivery, delivered…) and write the message. Fewer "where is my parcel?" questions.'],
    bn: ['ডেলিভারি আপডেট নিজে থেকে পাঠান', 'সেটিংস → কুরিয়ার ও ডেলিভারি → ডেলিভারি আপডেট: কোন ধাপে কাস্টমার মেসেজ পাবেন (রাইডার নিয়েছেন, ডেলিভারিতে বের হয়েছে, পৌঁছেছে…) বেছে মেসেজ লিখুন। "পার্সেল কোথায়?" প্রশ্ন কমবে।'] },
  { id: 'money', pages: ['orders'], minutes: 2, link: '/orders/money',
    en: ['Track courier cash and returns', 'Orders → Cash & returns shows what each courier owes you and when, parcels that came back, and customers you couldn\'t reach. Press Mark received when a payout arrives.'],
    bn: ['কুরিয়ারের টাকা আর রিটার্ন', 'অর্ডার → ক্যাশ ও রিটার্নে কোন কুরিয়ার কত টাকা কবে দেবে, কী ফেরত এসেছে আর কাদের সাথে যোগাযোগ হয়নি দেখা যায়। টাকা এলে "পেয়েছি" চাপুন।'] },
  { id: 'tickets', pages: ['tickets'], minutes: 1, link: '/tickets',
    en: ['Solve a complaint', 'Complaints, returns and refunds become tickets. Pick an owner, then a resolution (send the right item, exchange, refund to bKash…) — one tap solves it and it stays on record.'],
    bn: ['অভিযোগের সমাধান', 'অভিযোগ, রিটার্ন আর রিফান্ড টিকেট হয়। একজনকে দায়িত্ব দিন, তারপর সমাধান বাছুন (ঠিক পণ্য পাঠানো, এক্সচেঞ্জ, বিকাশে রিফান্ড…) — এক ট্যাপে সমাধান হয়, রেকর্ডও থাকে।'] },
  { id: 'segments', pages: ['customers'], minutes: 2, link: '/customers/segments',
    en: ['Group customers and send offers', 'Customers → Segments: build a group from conditions (orders, spent, delivery success, area…). Send the group a broadcast or a coupon only they can use.'],
    bn: ['কাস্টমারদের দলে ভাগ করে অফার', 'কাস্টমার → সেগমেন্ট: শর্ত দিয়ে দল বানান (অর্ডার, খরচ, ডেলিভারি সফলতা, এলাকা…)। দলটিকে ব্রডকাস্ট বা শুধু তাঁদের জন্য কুপন পাঠান।'] },
  { id: 'followups', pages: ['growth'], minutes: 2, link: '/growth',
    en: ['Follow up people who went quiet', 'The AI reminds customers who asked but didn\'t order — up to twice, inside Meta\'s 24-hour window. Leads lists everyone interested; schedule a call from there and log what happened in one tap.'],
    bn: ['যারা চুপ হয়ে গেছেন তাদের ফলো-আপ', 'যারা জিজ্ঞেস করেছেন কিন্তু অর্ডার করেননি, AI তাদের মনে করিয়ে দেয় — দুইবার পর্যন্ত, মেটার ২৪ ঘণ্টার মধ্যে। লিডসে আগ্রহী সবাই থাকেন; সেখান থেকে কল ঠিক করে এক ট্যাপে ফলাফল লিখুন।'] },
  { id: 'coupons', pages: ['growth', 'coupons'], minutes: 1, link: '/coupons',
    en: ['Make a coupon', 'Coupons → New coupon: % off, ৳ off or free delivery, with a minimum order, dates and who can use it. When a customer types the code, the AI applies it and sends the new bill.'],
    bn: ['কুপন বানান', 'কুপন → নতুন কুপন: % ছাড়, ৳ ছাড় বা ফ্রি ডেলিভারি, সাথে সর্বনিম্ন অর্ডার, তারিখ আর কারা পাবেন। কাস্টমার কোড লিখলে AI লাগিয়ে নতুন বিল পাঠায়।'] },
  { id: 'saved', pages: ['saved'], minutes: 2, link: '/saved-replies',
    en: ['Saved replies that answer by themselves', 'Write a saved reply and add the ways customers ask ("dam koto", "price?"). Turn on auto-answer and it replies instantly — no AI credit used.'],
    bn: ['নিজে থেকে উত্তর দেওয়া সেভ রিপ্লাই', 'সেভ রিপ্লাই লিখে কাস্টমাররা যেভাবে জিজ্ঞেস করেন ("দাম কত", "price?") যোগ করুন। অটো-উত্তর চালু করলে সাথে সাথে উত্তর যায় — AI ক্রেডিট লাগে না।'] },
  { id: 'catalog', pages: ['catalog'], minutes: 2, link: '/catalog',
    en: ['Add products the AI can sell', 'Catalog → Add product: photos, price, sizes and stock. The AI only quotes prices and stock from here, sends product cards, and says "sold out" when stock is zero.'],
    bn: ['AI বিক্রি করতে পারে এমন প্রোডাক্ট যোগ', 'ক্যাটালগ → প্রোডাক্ট যোগ: ছবি, দাম, সাইজ আর স্টক। AI শুধু এখান থেকে দাম আর স্টক বলে, প্রোডাক্ট কার্ড পাঠায়, স্টক শূন্য হলে "স্টক শেষ" বলে।'] },
  { id: 'size-charts', pages: ['catalog'], minutes: 1, link: '/catalog/size-charts',
    en: ['Send a size chart', 'Catalog → Size charts: make one chart per category. When a customer asks which size fits, the AI sends it as an image with the sizes to tap.'],
    bn: ['সাইজ চার্ট পাঠান', 'ক্যাটালগ → সাইজ চার্ট: প্রতিটি ক্যাটাগরির জন্য একটি চার্ট বানান। কাস্টমার সাইজ জানতে চাইলে AI ছবি হিসেবে পাঠায়, সাথে ট্যাপ করার সাইজ।'] },
  { id: 'ai-credit', pages: ['overview', 'agent', 'settings', 'analytics'], minutes: 2, link: '/settings',
    en: ['Why AI credit goes down', 'Each AI reply costs a little credit, priced from the words it reads and writes. Saved-reply auto-answers are free. Settings → Billing lists every charge and lets you set a monthly cap.'],
    bn: ['AI ক্রেডিট কেন কমে', 'প্রতিটি AI উত্তরে সামান্য ক্রেডিট লাগে, কতটুকু পড়ে আর লেখে তা ধরে। সেভ রিপ্লাইয়ের অটো-উত্তর ফ্রি। সেটিংস → বিলিং-এ প্রতিটি খরচ আর মাসিক সীমা ঠিক করার জায়গা আছে।'] },
  { id: 'team', pages: ['settings'], minutes: 1, link: '/settings/team',
    en: ['Add a teammate', 'Settings → Team & roles → Invite teammate: name, email and a role (admin, moderator or agent). There\'s no per-seat fee. Permissions shows what each role can do.'],
    bn: ['টিমমেট যোগ করুন', 'সেটিংস → টিম ও রোল → টিমমেট যোগ: নাম, ইমেইল আর রোল (অ্যাডমিন, মডারেটর বা এজেন্ট)। প্রতি জনের আলাদা খরচ নেই। পারমিশনে কোন রোল কী করতে পারে দেখা যায়।'] },
  { id: 'analytics', pages: ['analytics'], minutes: 1, link: '/analytics',
    en: ['Read your reports', 'Analytics compares this week with the last: orders taken by the AI vs the team, revenue per taka of AI, first reply time, cancellation reasons and courier delivery rates.'],
    bn: ['রিপোর্ট পড়ুন', 'অ্যানালিটিক্সে এই সপ্তাহ আর আগের সপ্তাহ তুলনা হয়: AI আর টিমের নেওয়া অর্ডার, AI-এর প্রতি টাকায় আয়, প্রথম উত্তরের সময়, বাতিলের কারণ আর কুরিয়ারের ডেলিভারি হার।'] },
];

const words = (s) => String(s ?? '').toLowerCase().replace(/[^\p{L}\p{M}\p{N}\s]/gu, ' ').split(/\s+/).filter((w) => w.length > 2);
// Keyword search, used when the AI isn't set up (and to pick the articles the bot reads).
export function searchArticles(question, lang = 'en', limit = 3) {
  const q = new Set(words(question));
  if (!q.size) return [];
  return ARTICLES.map((a) => {
    const text = `${a.en.join(' ')} ${a.bn.join(' ')} ${a.id.replace(/-/g, ' ')}`;
    const score = words(text).reduce((s, w) => s + (q.has(w) ? 1 : 0), 0) + words(a[lang]?.[0] ?? a.en[0]).filter((w) => q.has(w)).length * 2;
    return { a, score };
  }).filter((x) => x.score > 0).sort((x, y) => y.score - x.score).slice(0, limit).map((x) => x.a);
}

export const articleView = (a, lang) => ({ id: a.id, title: (a[lang] ?? a.en)[0], body: (a[lang] ?? a.en)[1], minutes: a.minutes, link: a.link });
