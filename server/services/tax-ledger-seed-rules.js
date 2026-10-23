/**
 * Seed rules for the tax ledger (GATE_TAX_LEDGER). One row per payee
 * pattern: a case-insensitive regular expression tested against the bank
 * description, the kind of row it is, and the Schedule C category for
 * expenses. Merchant patterns only: a rule about a person (a helper, a
 * customer, a relative) is written by the owner from the Inbox and lives in
 * the database, never here.
 *
 * kinds: expense (deductible, needs a category) | personal | transfer
 * (card payments, moves between own accounts, rewards, fees) | income
 * (a customer receipt outside the processor: kept in the Inbox's Income
 * view until it is recorded as a sale; no seed uses it) | review (the
 * owner decides; an optional category pre-fills the picker).
 *
 * Priority: lower runs first. A rule the owner writes from the Inbox runs
 * at 10 and always wins. Seeds: 80 = a specific review exception (usps po,
 * walmart.com, amazon, temu) that must beat the merchant rule it overlaps;
 * 90 = business merchants and transfers; 95 = card fees; 100 = the broad
 * personal lists (food, stores, health) and the "a person paid / was paid"
 * reviews, so TARGET SPECIALTY (supplies) beats TARGET (store) and USPS PO
 * (review) beats USPS (office).
 */

const A = 'Advertising & Marketing';
const V = 'Vehicle Expenses';
const F = 'Commissions & Fees';
const L = 'Contract Labor';
const I = 'Insurance';
const O = 'Office Expenses';
const S = 'Supplies';
const T = 'Taxes & Licenses';
const U = 'Utilities';
const W = 'Software & Technology';
const E = 'Training & Education';
const H = 'Home Office';

const CATEGORY_LINES = {
  [A]: '8', [V]: '9', [F]: '10', [L]: '11', [I]: '15', [O]: '18', [S]: '22', [T]: '23', [U]: '25', [W]: '27a', [E]: '27a', [H]: '30',
};

const x = (pattern, kind, category = null, note = null, priority = 100) => ({ pattern, kind, category, note, priority });

const SEED_RULES = [
  // ── transfers between own accounts, card payments, rewards, card fees (never income, never expense)
  x('capital one (mobile|phone|online) pymt|capital one crcardpmt|capital one autopay pymt|direct debit payment|electronic payment|payment from capital one|autopay from capital one|canceled (autopay|payment)', 'transfer', null, 'card payment between own accounts', 90),
  x('withdrawal to capital one bank|deposit from capital one bank|transfer (withdrawal|deposit)|returned (mobile )?ach', 'transfer', null, 'move between own accounts', 90),
  x('amex epayment|payment - thank you|lowes syf paym', 'transfer', null, 'payment to another own card; its charges are their own rows', 90),
  x('points for statement credit|adj redist|credit adjustment|debit adjustment|credit-cash back reward', 'transfer', null, 'card reward or balance adjustment, not income', 90),
  x('check deposit \\(mobile\\) reversal|deposit reversal|returned check', 'transfer', null, 'reversal of a deposit', 90),
  x('capital one member fee|past due fee|late payment fee|late fee|annual membership fee|renewal membership fee', 'personal', null, 'card fee on a mixed-use card', 95),
  x('monthly interest paid', 'personal', null, 'bank interest: personal 1099-INT income, not business', 95),
  // ── a processor payout the deterministic matcher did not link (linked ones never reach the rules)
  x('deposit from stripe|stripe transfer|stripe payout', 'review', null, 'Stripe payout the matcher could not link: check the payout list before anything else', 90),
  // ── receipts and payments to people: the owner decides
  x('zelle money received from|check deposit|mobile deposit|cash added|deposit from venmo|deposit from cash app|deposit from paypal', 'review', null, 'customer payment not in the books, or personal money?'),
  x('zelle money sent to|cash app \\*|venmo payment|withdrawal from wise|wise us inc', 'review', L, 'a helper (contract labor, 1099-NEC at $600) or personal?'),
  // ── advertising (line 8)
  x('google\\W*ads|facebk|meta ads|sticker mule|beehiiv|vistaprint|whitespark|yelp|nextdoor|thumbtack|\\bangi\\b|homeadvisor|semrush|canva|brightlocal|moz\\.com|ahrefs|mamo\\W*social|otc brands|age graphics|indexsy|loominost|kev s best|buylinks|useviral|help-a-marketer|aidirectori|outscraper|peoplefinders|content at scale|gmass|ein presswire|super cheap signs|onlineprintus|dri\\W*printplace|craigslist|serp empire|fatjoe|proxy-seller|linkedin|indeed jobs|onlinejobs\\.ph|the-qrcode-generator|adaired|madwire|usps\\.com every door', 'expense', A, null, 90),
  x('usps po\\b', 'review', A, 'an EDDM postcard drop (advertising) or stamps (office)?', 80),
  // ── vehicle (line 9): actual costs, business share decided at year end
  x('costco gas|wawa|shell oil|shell service|speedway|racetrac|exxon|circle k|7-eleven|-eleven|\\bbp\\b|bpqr|marathon|sunoco|chevron|mobil\\b|murphy|citgo|love.s|flying j|samsclub.*gas|king soopers fuel', 'expense', V, 'fuel', 90),
  x('carfax|autozone|o.?reilly auto|advance auto|jiffy lube|take 5|discount tire|\\btire\\b|napa auto|pep boys|car wash|sunpass|\\btoll\\b|parking|pmt\\W*fl license/tag|\\bdmv\\b|mavis|thorntons|bpc\\W*bumper', 'expense', V, 'repair, registration, tolls', 90),
  // ── contract labor (line 11): platforms file their own 1099-K
  x('fiverr|upwork|taskrabbit', 'expense', L, null, 90),
  // ── insurance (line 15)
  x('next insurance|hiscox|thimble|biberk|simply business|florida heritage', 'expense', I, 'business liability policy', 90),
  x('progressive ins|geico|state farm|allstate', 'review', I, 'business policy or personal auto?'),
  // ── office, postage, shipping (line 18)
  x('the ups store|office depot|staples|fedex office|\\busps\\b|stamps\\.com|pirate ship', 'expense', O, null, 90),
  x('walmart\\.com|best buy', 'review', O, 'office or equipment, or personal?', 80),
  // ── supplies, chemicals, hardware (line 22)
  x('siteone|site one|veseris|propest|sprayer depot|do my own|domyown|solutions pest|forestry supp|\\bewing\\b|pestrong|univar|target specialty|nisus|bell labs|catchmaster|tractor supply|harbor freight|northern tool|rural king|ace hardware|home depot|homedepot|lowe.?s|gulf coast hardware|crowder bros|menards|invatechitalia', 'expense', S, null, 90),
  x('amazon|amzn', 'review', S, 'mixed orders: confirm it is a business item', 80),
  x('\\btemu\\b', 'review', S, 'mixed: confirm it is a business item', 80),
  // ── taxes and licences (line 23)
  x('nic\\W*fl|sunbiz|fdacs|fl dept of agri|myfloridalicense|dept of revenue|business tax receipt|tax collector', 'expense', T, null, 90),
  x('manatee county|sarasota county|charlotte county', 'review', T, 'business tax receipt (deductible) or a utility bill?'),
  // ── utilities (line 25) and home office (line 30): business share decided at year end
  x('verizon|vzwrlss|t-mobile|at&t', 'review', U, 'phone: business share'),
  x('spectrum|frontier comm|comcast|xfinity', 'review', U, 'internet: home office share'),
  x('peace river|\\bfpl\\b|\\bteco\\b|duke energy', 'review', H, 'electric: home office share (Form 8829)'),
  // ── software and services (line 27a)
  x('openai|chatgpt|anthropic|claude\\.ai|railway|github|google\\W*gsuite|google workspace|gsuite|name.?cheap|pipedream|intuit|qbooks|quickbooks|transcriptapi|open-meteo|bouncie|zernio|dropbox|notion|slack|zoom|calendly|godaddy|cloudflare|vercel|heroku|digitalocean|\\baws\\b|microsoft|adobe|grammarly|1password|lastpass|wix|mailchimp|constant contact|jobber|housecall|fieldroutes|pestpac|gorilladesk|yardbook|elevenlabs|paddle\\.(net|com)|proxysell|stealth code|midjourney|x corp\\.? paid|pageoptimizer|local dominator|qi.addons|hix\\.ai|cuppa|themeisle|visualcomposer|wp rocket|gptzero|wordpress|webflow|hostinger|wp all import|wp media|shapedplugin|freemius|aycd\\.io|pingproxies|perplexity|hugedomains|nodemaven|gumrd|geoimgr|justdoneai|leapworx|numerous\\.ai|openweather|pdfsimpli|chaty|gptforwork|flexinput|twilio|sendgrid', 'expense', W, null, 90),
  x('fl pest mgmt assoc|npma\\b', 'expense', E, 'association dues', 90),
  // ── card interest (line 16b): business share decided at year end
  x('interest charge', 'review', null, 'card interest: business share goes on Schedule C line 16b (other interest); no category carries 16b, so it is entered at year end, not booked here'),
  // ── bank fees
  x('wire transfer fee|wire fee|wire convenience charge|overdraft fee|monthly service fee', 'expense', F, 'bank fee', 90),
  // ── travel: the owner decides (no category: travel is line 24a)
  x('delta air|breeze air|airline|airfare|southwest|spirit air|frontier ai\\b|frontier denver|united air|american air|jetblue|hotel|\\binn\\b|marriott|hilton|airbnb|vrbo|expedia|booking\\.com|amtrak|\\buber\\b|\\blyft\\b', 'review', null, 'business trip, or personal?'),
  // ── personal (groceries, pharmacy, gyms, streaming, meals, cash)
  x('atm withdrawal|western union|\\bwu\\b.*\\bco\\b|cash advance', 'personal', null, 'cash or remittance'),
  x('culver|domino|mcdonald|chick-fil|wendy|burger|pizza|taco|subway|starbucks|dunkin|restaurant|grill|cafe|chipotle|panera|sonic|popeyes|kfc|arby|dairy queen|five guys|jersey mike|firehouse|jimmy john|outback|applebee|chili.s|ihop|denny|waffle|cracker barrel|doordash|grubhub|ubereats|bagel|bbq|coffee', 'personal', null, 'meals (only a documented business meal is 50% deductible)'),
  x('lecom|dental|dentist|physician|millennium phys|ymca|lifetime fitness|ltf life time|la fitness|planet fitness|kaiser|\\bkp rx\\b|pharmacy|cvs|walgreens|publix|wal-mart|walmart|wm superc|costco whse|www costco|\\btarget\\b|aldi|winn.?dixie|sam.s club|dollar tree|dollar tr\\b|goodwill|\\bross\\b|tj maxx|marshalls|kohl|macy|nike|netflix|spotify|hulu|disney|xbox|playstation|nintendo|\\bamc\\b|cinema|theat|salon|barber|great clips|sally beauty|simpler hair|\\bspa\\b|church|tuition|childcare|daycare|\\brent\\b|mortgage|\\bhoa\\b|liquor|smoke|vape|tobacco|lottery|casino|gtlcollect|king soopers|safeway|michaels', 'personal', null, 'household'),
  x('apple\\.com/bill|apple com bill', 'personal', null, 'Apple subscriptions on a personal account'),
];

const SEED_CATEGORY_NAMES = [A, V, F, L, I, O, S, T, U, W, E, H];

module.exports = { SEED_RULES, SEED_CATEGORY_NAMES, CATEGORY_LINES };
