// Monitoring repo org: tarik data via GraphQL, tulis docs/data/repos.json
// dan perbarui tabel di profile/README.md (antara penanda MONITOR:START/END).
// Jalankan: ORG=Unitama-Sari-Mas GH_TOKEN=... node scripts/monitor.mjs
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

const ORG = process.env.ORG || 'Unitama-Sari-Mas';
const TOKEN = process.env.GH_TOKEN;
const INCLUDE_PRIVATE = process.env.INCLUDE_PRIVATE === 'true'; // default: hanya repo publik
// Repo privat disamarkan (nama, deskripsi, bahasa, link disembunyikan) kecuali MASK_PRIVATE=false.
const MASK_PRIVATE = process.env.MASK_PRIVATE !== 'false';
const TOP_N = Number(process.env.TOP_N || 10);
const README = 'profile/README.md';
const DATA = 'docs/data/repos.json';
const DAY = 864e5;

if (!TOKEN) { console.error('GH_TOKEN belum di-set'); process.exit(1); }

const since = new Date(Date.now() - 30 * DAY).toISOString();
const privacy = INCLUDE_PRIVATE ? '' : ', privacy: PUBLIC';
const query = `query($org:String!,$after:String,$since:GitTimestamp!){
  organization(login:$org){
    repositories(first:50, after:$after, orderBy:{field:PUSHED_AT,direction:DESC}${privacy}){
      pageInfo{hasNextPage endCursor}
      nodes{
        name description url isPrivate isArchived isFork pushedAt stargazerCount forkCount
        primaryLanguage{name color}
        issues(states:OPEN){totalCount}
        pullRequests(states:OPEN){totalCount}
        defaultBranchRef{ target{ ... on Commit{
          ci:statusCheckRollup{state}
          recent:history(since:$since){totalCount}
        }}}
      }
    }
  }
}`;

async function gql(variables) {
  const res = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json', 'User-Agent': 'org-monitor' },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json();
  if (!res.ok || json.errors) throw new Error(`GraphQL gagal: ${res.status} ${JSON.stringify(json.errors || json)}`);
  return json.data.organization.repositories;
}

const raw = [];
let after = null;
for (;;) {
  const page = await gql({ org: ORG, after, since });
  raw.push(...page.nodes);
  if (!page.pageInfo.hasNextPage) break;
  after = page.pageInfo.endCursor;
}

const health = (r) => {
  if (r.isArchived) return 'archived';
  const d = (Date.now() - new Date(r.pushedAt)) / DAY;
  return d <= 30 ? 'active' : d <= 90 ? 'slow' : 'stale';
};
const ciOf = (s) => (!s ? 'none' : s === 'SUCCESS' ? 'pass' : ['FAILURE', 'ERROR'].includes(s) ? 'fail' : 'pending');

let privateNo = 0;
const repos = raw
  .filter((r) => !r.isFork && r.name !== '.github')
  .map((r) => {
    const hide = r.isPrivate && MASK_PRIVATE;
    const label = hide ? `Repo privat #${++privateNo}` : r.name;
    return { r, hide, label };
  })
  .map(({ r, hide, label }) => ({
    name: label,
    description: hide ? '' : r.description || '',
    url: hide ? null : r.url,
    private: r.isPrivate,
    language: hide ? null : r.primaryLanguage?.name || null,
    languageColor: hide ? null : r.primaryLanguage?.color || null,
    stars: hide ? 0 : r.stargazerCount,
    forks: hide ? 0 : r.forkCount,
    openIssues: r.issues.totalCount,
    openPRs: r.pullRequests.totalCount,
    commits30d: r.defaultBranchRef?.target?.recent?.totalCount ?? 0,
    ci: ciOf(r.defaultBranchRef?.target?.ci?.state),
    health: health(r),
    pushedAt: r.pushedAt,
  }));

const sum = (k) => repos.reduce((a, r) => a + r[k], 0);
const totals = {
  repos: repos.length,
  active: repos.filter((r) => r.health === 'active').length,
  stale: repos.filter((r) => r.health === 'stale').length,
  commits30d: sum('commits30d'),
  openIssues: sum('openIssues'),
  openPRs: sum('openPRs'),
  ciFailing: repos.filter((r) => r.ci === 'fail').length,
};
const generatedAt = new Date().toISOString();

mkdirSync('docs/data', { recursive: true });
writeFileSync(DATA, JSON.stringify({ org: ORG, generatedAt, includePrivate: INCLUDE_PRIVATE, totals, repos }, null, 2) + '\n');

// ---- README ----
const H = { active: '🟢 Aktif', slow: '🟡 Lambat', stale: '🔴 Stagnan', archived: '⚪ Arsip' };
const C = { pass: '✅', fail: '❌', pending: '⏳', none: '➖' };
const esc = (s) => s.replace(/\|/g, '\\|').replace(/\n/g, ' ');
const stamp = new Intl.DateTimeFormat('id-ID', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Jakarta' }).format(new Date(generatedAt));

const top = [...repos].sort((a, b) => b.commits30d - a.commits30d || new Date(b.pushedAt) - new Date(a.pushedAt)).slice(0, TOP_N);
const rows = top.map((r) =>
  `| ${r.url ? `[${r.name}](${r.url})` : `🔒 ${r.name}`} | ${r.language ?? '—'} | ${r.commits30d} | ${r.openIssues} | ${r.openPRs} | ${C[r.ci]} | ${H[r.health]} |`);

const block = [
  '<!--MONITOR:START-->',
  `**${totals.repos}** repo · **${totals.active}** aktif · **${totals.commits30d}** commit (30 hari) · **${totals.openIssues}** issue terbuka · **${totals.openPRs}** PR terbuka` +
    (totals.ciFailing ? ` · ❌ **${totals.ciFailing}** CI gagal` : ''),
  '',
  '| Repo | Bahasa | Commit 30h | Issue | PR | CI | Status |',
  '|---|---|---:|---:|---:|:---:|---|',
  ...rows,
  '',
  `<sub>Diperbarui otomatis ${stamp} WIB · <a href="https://${ORG.toLowerCase()}.github.io/.github/">buka dashboard lengkap</a></sub>`,
  '<!--MONITOR:END-->',
].join('\n');

const md = readFileSync(README, 'utf8');
const re = /<!--MONITOR:START-->[\s\S]*?<!--MONITOR:END-->/;
if (!re.test(md)) { console.error('Penanda MONITOR:START/END tidak ada di README'); process.exit(1); }
writeFileSync(README, md.replace(re, () => block));
console.log(`OK: ${repos.length} repo diproses`);
