import { APP_STORE_URL, PLAY_STORE_URL } from "../components/estimate/AppShowcaseCard";

// How-to guides for the composers' Quick Links sheet ("How-to guides"
// group). Picking one inserts short steps plus a link that opens the right
// portal screen after sign-in (LoginPage honors ?next=, same encoded form as
// the cancel plan link). Nothing is sent on pick: the operator reads the
// draft and sends it. Plain ASCII on purpose, since the same rows go into
// texts. Every step names a real button label in PortalPage.jsx; when a
// label there changes, change it here too.

export const HOW_TO_CAPTION = "Steps for the customer. Each link opens the right app screen after sign-in.";

const portalLink = (path) => `portal.wavespestcontrol.com/login?next=${encodeURIComponent(path)}`;

const SIGN_IN = "Sign in to the Waves app with your phone number.";

const GUIDES = [
  {
    key: "add_contact",
    name: "Add another contact",
    title: "How to add another contact in the Waves app",
    keywords: "contact spouse partner tenant property manager family add person notify alerts texts on-location",
    path: "/?tab=visits",
    steps: [
      SIGN_IN,
      "Tap Visits.",
      "Scroll down to the contacts section. If you have more than one property, pick the property first.",
      "Type their name, phone number and email. To add more people, tap + Add another contact (up to 3).",
      "Check the box to confirm they agreed to get our texts, then tap Save.",
    ],
    after: "They will get visit reminders and on-the-way alerts for your property.",
  },
  {
    key: "autopay",
    name: "Set up Auto Pay or change your card",
    title: "How to set up Auto Pay or change your card",
    keywords: "autopay auto pay card credit debit bank update replace payment method billing expired",
    path: "/?tab=billing&focus=payment-methods",
    steps: [
      SIGN_IN,
      "Tap Billing.",
      "If Auto Pay is off, tap Turn on Auto Pay and follow the steps.",
      "To change the card Auto Pay uses, tap Manage Auto Pay, then Change payment method.",
      "To save a new card or bank account, tap Add payment.",
    ],
  },
  {
    key: "notifications",
    name: "Choose how we notify you",
    title: "How to choose how we notify you",
    keywords: "notifications alerts reminders text email app settings preferences stop too many on the way",
    path: "/?tab=visits",
    steps: [
      SIGN_IN,
      "Tap Visits.",
      "Scroll down to Service notifications.",
      "Turn each alert on or off: appointment updates, reminders, on the way and arrival.",
      "Next to each alert, pick how you want it: text, email or app. Changes save right away.",
    ],
  },
  {
    key: "get_app",
    name: "Get the app and turn on notifications",
    title: "How to get the Waves app",
    keywords: "app download install iphone android apple google play push notifications",
    path: "/?tab=visits",
    steps: [
      `Install the app. iPhone: ${APP_STORE_URL} Android: ${PLAY_STORE_URL}`,
      "Open it and sign in with your phone number.",
      "Allow notifications when the app asks.",
      "Want visit updates in the app? Tap Visits, scroll to Service notifications and tap Use app for visit updates.",
    ],
    linkLabel: "Or sign in on the web",
  },
  {
    key: "documents",
    name: "Find your service reports and invoices",
    title: "How to find your service reports and invoices",
    keywords: "documents reports service report pdf invoice receipt paperwork history download",
    path: "/?tab=documents",
    steps: [
      SIGN_IN,
      "Open Documents. On a phone, tap More, then Documents.",
      "Your reports are under Service Reports. Tap one to open it.",
      "Invoices and receipts are in Billing, under Payment History.",
    ],
  },
  {
    key: "reschedule",
    name: "Reschedule or request a visit",
    title: "How to reschedule or request a visit",
    keywords: "reschedule move change date time visit appointment request extra visit pest problem",
    path: "/?tab=visits",
    steps: [
      SIGN_IN,
      "Tap Visits.",
      "Find the visit and tap Reschedule, then pick a new time.",
      "Need an extra visit or seeing pests? Tap Request, choose what you need and send it. We will get back to you.",
    ],
  },
  {
    key: "access_notes",
    name: "Update gate code and access notes",
    title: "How to update your gate code and access notes",
    keywords: "gate code access lockbox garage keypad community gate parking pets dog notes property",
    path: "/?tab=property",
    steps: [
      SIGN_IN,
      "Open My Property. On a phone, tap More, then My Property.",
      "Under Access, fill in Community Gate, Property Gate, Garage Code or Lockbox Code.",
      "Add parking notes and pets too. Changes save on their own.",
    ],
    after: "Your technician sees these before every visit.",
  },
  {
    // The portal has no self-serve add-property flow: the office adds it.
    key: "add_property",
    name: "Add another property",
    title: "How to add another property to your account",
    keywords: "property home house rental second address add another location vacation",
    path: "/?tab=visits",
    steps: [
      "Reply with the address and the service you want there, or call us at (941) 297-5749. We add it for you.",
      "Once it is added, sign in and tap Visits. Use the property menu at the top to switch between homes.",
    ],
    after: "Each property keeps its own schedule and notifications.",
  },
  {
    key: "refer",
    name: "Refer a friend",
    title: "How to refer a friend",
    keywords: "refer referral friend neighbor credit share code invite",
    path: "/?tab=refer",
    steps: [
      SIGN_IN,
      "Tap Refer.",
      "Tap Text a friend or Email a friend, or share your referral code.",
      "You earn a credit when they start service.",
    ],
  },
];

export const HOW_TO_GUIDE_LINKS = GUIDES.map(({ path, ...guide }) => ({
  ...guide,
  key: `howto:${guide.key}`,
  category: "howto",
  url: portalLink(path),
  description: "Steps plus a link to the right app screen",
}));

// The inserted text: title, numbered steps, optional closing line, then the
// link. `url` is the row's url as the composer resolved it (the email
// composer adds https://).
export function howToGuideText(link) {
  const lines = [`${link.title}:`];
  link.steps.forEach((step, index) => lines.push(`${index + 1}. ${step}`));
  if (link.after) lines.push(link.after);
  lines.push(`${link.linkLabel || "Open it here"}: ${link.url}`);
  return lines.join("\n");
}

// A how-to guide is already in a draft when its title line is. The guides
// share deep links (several open Visits), so the URL cannot tell them apart.
export function howToGuidePresent(body, link) {
  return String(body || "").includes(`${link.title}:`);
}
