// NC Megaphone — build the legislator email list from ncleg.gov
//
// Two pages per chamber, because neither alone is sufficient:
//   /Members/MemberList/{S,H}   — who currently holds each seat. Departed members
//                                 stay listed but are tagged "(Resigned …)" or
//                                 "(Deceased …)". This is the ONLY place that says so.
//   /Members/ContactInfo/{S,H}  — the email addresses. Keeps listing people long
//                                 after they leave (Paul Newton resigned 3/2025 and
//                                 is still there), and has no status column, so
//                                 reading it alone silently reintroduces dead seats.
//
// The two are joined on the member's biography id (/Members/Biography/{S,H}/<id>),
// which both pages carry. No name matching — names differ between the pages
// ("Rep. " prefixes, HTML entities, suffixes) and collide (Carson vs Charles Smith).
//
// Addresses on ContactInfo are Cloudflare-obfuscated: the visible text is
// "[email protected]" and the real value is a hex payload in data-cfemail,
// single-byte XOR with the first byte as the key. That is what broke the old
// scraper — not the URL, which is unchanged.
//
// Usage:  node index.js [--dry-run] [--commit] [--site <path>]

const cheerio = require('cheerio');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36';
const BASE = 'https://www.ncleg.gov';
const CHAMBERS = [
  { name: 'senate', code: 'S', seats: 50 },
  { name: 'house',  code: 'H', seats: 120 },
];
// Anything marking a member as no longer holding the seat.
const DEPARTED = /\((Resigned|Deceased|Died|Removed|Expelled|Left office)\b/i;

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const COMMIT = args.includes('--commit');
const SITE = path.resolve(
  args.includes('--site') ? args[args.indexOf('--site') + 1] : '../email-all-nc-legislators'
);

function fail(msg) {
  console.error(`\n  FAILED: ${msg}`);
  console.error('  Nothing was written. The list on disk is unchanged.\n');
  process.exit(1);
}

async function get(url) {
  let res;
  try {
    res = await fetch(url, { headers: { 'User-Agent': UA }, redirect: 'follow' });
  } catch (e) {
    fail(`could not reach ${url} — ${e.message}`);
  }
  if (!res.ok) fail(`${url} returned HTTP ${res.status}`);
  const body = await res.text();
  if (body.length < 5000) fail(`${url} returned only ${body.length} bytes — that is not the real page`);
  return body;
}

function decodeCfEmail(hex) {
  const b = Buffer.from(hex, 'hex');
  let out = '';
  for (let i = 1; i < b.length; i++) out += String.fromCharCode(b[i] ^ b[0]);
  return out;
}

// Who currently holds each seat.
function parseMemberList(html, code) {
  const $ = cheerio.load(html);
  const sitting = new Map();   // bioId -> { name, district }
  const departed = [];
  $('.member-info-col').each((_, el) => {
    const $el = $(el);
    const link = $el.find(`a[href*="/Members/Biography/${code}/"]`).first();
    if (!link.length) return;
    const id = link.attr('href').match(/\/Members\/Biography\/[SH]\/(\d+)/)[1];
    const name = link.text().trim();
    const districtLink = $el.find('a[href*="/Redistricting/DistrictPlanMap/"]').first();
    const district = districtLink.length ? districtLink.text().replace(/\D+/g, '') : null;
    const marker = $el.text().match(DEPARTED);
    if (marker) departed.push({ id, name, district, why: marker[0].replace(/^\(/, '') });
    else sitting.set(id, { name, district });
  });
  return { sitting, departed };
}

// bioId -> email
function parseContactInfo(html, code) {
  const $ = cheerio.load(html);
  const byId = new Map();
  $('#contactTable tbody tr').each((_, row) => {
    const $row = $(row);
    const link = $row.find(`a[href*="/Members/Biography/${code}/"]`).first();
    if (!link.length) return;
    const id = link.attr('href').match(/\/Members\/Biography\/[SH]\/(\d+)/)[1];
    const cf = $row.find('td').eq(4).find('[data-cfemail]').first().attr('data-cfemail');
    if (!cf) return;                                  // seat with no published address
    const email = decodeCfEmail(cf);
    if (email.endsWith('@ncleg.gov')) byId.set(id, email);
  });
  return byId;
}

// Existing convention: sort by last name, then by the whole address.
const lastName = (a) => a.slice(a.indexOf('.') + 1).toLowerCase();
const byLastName = (a, b) => lastName(a).localeCompare(lastName(b)) || a.localeCompare(b);

async function buildChamber({ name, code, seats }) {
  const [listHtml, contactHtml] = await Promise.all([
    get(`${BASE}/Members/MemberList/${code}`),
    get(`${BASE}/Members/ContactInfo/${code}`),
  ]);

  const { sitting, departed } = parseMemberList(listHtml, code);
  const contacts = parseContactInfo(contactHtml, code);

  if (sitting.size !== seats) {
    fail(`${name}: found ${sitting.size} sitting members, expected ${seats}. ` +
         `ncleg.gov's markup may have changed — refusing to write a list I cannot verify.`);
  }
  const districts = new Set([...sitting.values()].map((m) => m.district));
  if (districts.size !== seats) {
    fail(`${name}: ${sitting.size} members cover only ${districts.size} distinct districts`);
  }

  const emails = [];
  const noEmail = [];
  for (const [id, m] of sitting) {
    const email = contacts.get(id);
    if (email) emails.push(email);
    else noEmail.push(m);          // never invent First.Last@ — report the gap instead
  }
  emails.sort(byLastName);

  console.log(`\n  ${name.toUpperCase()}`);
  console.log(`    sitting members : ${sitting.size} / ${seats} seats`);
  console.log(`    excluded        : ${departed.length} no longer holding a seat`);
  for (const d of departed) console.log(`                      - ${d.name} (D${d.district}, ${d.why})`);
  console.log(`    with an address : ${emails.length}`);
  if (noEmail.length) {
    console.log(`    NO PUBLISHED ADDRESS on ncleg.gov (omitted, not guessed):`);
    for (const m of noEmail) console.log(`                      - ${m.name} (D${m.district})`);
  }
  return emails;
}

function writeSite(senate, house) {
  const indexPath = path.join(SITE, 'index.html');
  const readmePath = path.join(SITE, 'README.md');
  if (!fs.existsSync(indexPath)) fail(`no index.html at ${indexPath} — pass --site <path>`);

  const half = Math.ceil(house.length / 2);
  const blocks = [senate, house.slice(0, half), house.slice(half)];
  const ordered = [...blocks, ...blocks];        // 3 mailto: links, then 3 <textarea>s

  let html = fs.readFileSync(indexPath, 'utf-8');
  const RUN = /(mailto:|<textarea>)([^'<>"]*?@ncleg\.gov[^'<>"]*)/g;
  const found = html.match(RUN) || [];
  if (found.length !== ordered.length) {
    fail(`expected ${ordered.length} address blocks in index.html, found ${found.length}`);
  }
  let i = 0;
  html = html.replace(RUN, (_, lead) => `${lead}${ordered[i++].join(',')}`);

  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = `${pad(now.getMonth() + 1)}/${pad(now.getDate())}/${now.getFullYear()}`;
  if (!/Email list updated on \d{2}\/\d{2}\/\d{4}/.test(html)) {
    fail('could not find the "Email list updated on" line in index.html');
  }
  html = html.replace(/Email list updated on \d{2}\/\d{2}\/\d{4}/, `Email list updated on ${stamp}`);

  const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  const d = now.getDate();
  const suffix = (d % 10 === 1 && d !== 11) ? 'st' : (d % 10 === 2 && d !== 12) ? 'nd' : (d % 10 === 3 && d !== 13) ? 'rd' : 'th';
  const pretty = `${MONTHS[now.getMonth()]} ${d}${suffix}, ${now.getFullYear()}`;

  if (DRY_RUN) {
    fs.writeFileSync(path.join(__dirname, 'output', 'index.dryrun.html'), html, 'utf-8');
    console.log(`\n  DRY RUN — wrote output/index.dryrun.html, site untouched`);
    return { stamp, changed: false };
  }

  fs.writeFileSync(indexPath, html, 'utf-8');
  if (fs.existsSync(readmePath)) {
    const readme = fs.readFileSync(readmePath, 'utf-8').replace(/Last updated: .*/, `Last updated: ${pretty}`);
    fs.writeFileSync(readmePath, readme, 'utf-8');
  }
  console.log(`\n  wrote ${indexPath}`);
  console.log(`  wrote ${readmePath}`);
  return { stamp, changed: true };
}

(async () => {
  console.log(`\n  NC Megaphone list build — ${new Date().toISOString()}`);
  console.log(`  source: ${BASE}/Members/{MemberList,ContactInfo}/{S,H}`);

  const [senate, house] = [await buildChamber(CHAMBERS[0]), await buildChamber(CHAMBERS[1])];

  fs.mkdirSync(path.join(__dirname, 'output'), { recursive: true });
  fs.writeFileSync(path.join(__dirname, 'output', 'senate.txt'), JSON.stringify(senate), 'utf-8');
  fs.writeFileSync(path.join(__dirname, 'output', 'house.txt'), JSON.stringify(house), 'utf-8');

  console.log(`\n  TOTAL: ${senate.length + house.length} addresses (${senate.length} senate + ${house.length} house)`);

  const { stamp, changed } = writeSite(senate, house);

  if (COMMIT && changed) {
    const msg = `Update NC Legislators, ${stamp}`;
    try {
      execFileSync('git', ['-C', SITE, 'commit', '-am', msg], { stdio: 'inherit' });
      console.log(`\n  committed in ${SITE}: "${msg}"`);
      console.log(`  NOT pushed — run "git -C ${SITE} push" to deploy.`);
    } catch {
      console.log('\n  nothing to commit (list already current)');
    }
  } else if (changed) {
    console.log(`\n  not committed. Review with: git -C ${SITE} diff`);
  }
  console.log('');
})();
