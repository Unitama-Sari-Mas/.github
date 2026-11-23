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

async function gqlRaw(q, variables) {
  const res = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json', 'User-Agent': 'org-monitor' },
    body: JSON.stringify({ query: q, variables }),
  });
  const json = await res.json();
  if (!res.ok || json.errors) throw new Error(`GraphQL gagal: ${res.status} ${JSON.stringify(json.errors || json)}`);
  return json.data;
}
const gql = async (variables) => (await gqlRaw(query, variables)).organization.repositories;

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

// ---- Leaderboard kontributor rajin ----
// Dihitung dari commit di branch utama tiap repo dalam LEADER_DAYS hari terakhir.
// Satu commit dihitung sebagai "fitur / perubahan besar" jika:
//   - bukan merge commit, dan bukan dari bot,
//   - pesannya BUKAN perbaikan bug / revert / typo / chore / docs / style / format,
//     (kecuali diawali feat/add/tambah/implement/create/buat), dan
//   - menambahkan minimal LEADER_MIN_ADDITIONS baris kode.
const LB_DAYS = Number(process.env.LEADER_DAYS || 30);
const MIN_ADD = Number(process.env.LEADER_MIN_ADDITIONS || 20);
const MASK_AUTHORS = process.env.MASK_AUTHORS === 'true'; // true = nama diganti "Kontributor #n"
const LB_TOP = Number(process.env.LEADER_TOP || 10);
const BOT = /\[bot\]$|^dependabot|^github-actions/i;
const FEATURE_HINT = /^\s*(feat|feature|add|tambah|tambahkan|implement|implementasi|create|buat)\b/i;
const NOT_NEW = /\b(fix(e[sd])?|bug(fix)?|hotfix|perbaiki|perbaikan|memperbaiki|benerin|koreksi|revert|rollback|typo|patch|chore|docs?|style|lint|format|bump|merge)\b/i;

const historyQuery = `query($owner:String!,$name:String!,$since:GitTimestamp!,$after:String){
  repository(owner:$owner,name:$name){ defaultBranchRef{ target{ ... on Commit{
    history(since:$since, first:100, after:$after){
      pageInfo{hasNextPage endCursor}
      nodes{ messageHeadline additions deletions parents{totalCount} author{ name user{login} } }
    }
  }}}}
}`;

async function loadLeaderboard() {
  const lbSince = new Date(Date.now() - LB_DAYS * DAY).toISOString();
  const people = new Map();
  for (const r of raw.filter((x) => !x.isFork && !x.isArchived && x.name !== '.github')) {
    let cursor = null;
    try {
      for (;;) {
        const d = await gqlRaw(historyQuery, { owner: ORG, name: r.name, since: lbSince, after: cursor });
        const h = d.repository?.defaultBranchRef?.target?.history;
        if (!h) break;
        for (const c of h.nodes) {
          if (c.parents.totalCount > 1) continue; // merge commit
          const login = c.author?.user?.login || null;
          const id = login || c.author?.name || 'unknown';
          if (BOT.test(login || id)) continue;
          const p = people.get(id) || { id, login, name: c.author?.name || login || id, qualifying: 0, additions: 0, commits: 0, fixes: 0, repos: new Set() };
          p.commits++;
          const isFeature = FEATURE_HINT.test(c.messageHeadline) || !NOT_NEW.test(c.messageHeadline);
          if (!isFeature) p.fixes++;
          else if (c.additions >= MIN_ADD) { p.qualifying++; p.additions += c.additions; p.repos.add(r.name); }
          people.set(id, p);
        }
        if (!h.pageInfo.hasNextPage) break;
        cursor = h.pageInfo.endCursor;
      }
    } catch (e) { console.warn(`Riwayat ${r.name} dilewati: ${e.message}`); }
  }
  return [...people.values()]
    .filter((p) => p.qualifying > 0)
    .sort((a, b) => b.qualifying - a.qualifying || b.additions - a.additions)
    .slice(0, LB_TOP)
    .map((p, i) => ({
      rank: i + 1,
      name: MASK_AUTHORS ? `Kontributor #${i + 1}` : p.name,
      avatar: !MASK_AUTHORS && p.login ? `https://github.com/${p.login}.png?size=48` : null,
      qualifying: p.qualifying,
      additions: p.additions,
      commits: p.commits,
      fixes: p.fixes,
      repos: p.repos.size,
    }));
}
const leaderboard = await loadLeaderboard();

mkdirSync('docs/data', { recursive: true });
writeFileSync(DATA, JSON.stringify({ org: ORG, generatedAt, includePrivate: INCLUDE_PRIVATE, leaderDays: LB_DAYS, leaderMinAdditions: MIN_ADD, totals, repos, leaderboard }, null, 2) + '\n');

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
let out = md.replace(re, () => block);

// Bagian leaderboard di README (dibuat otomatis jika penanda belum ada)
const medal = ['🥇', '🥈', '🥉'];
const lbBlock = [
  '<!--LEADER:START-->',
  leaderboard.length
    ? ['| # | Kontributor | Fitur / perubahan besar | Baris ditambah |', '|:-:|---|---:|---:|',
        ...leaderboard.slice(0, 5).map((p) => `| ${medal[p.rank - 1] ?? p.rank} | ${esc(p.name)} | ${p.qualifying} | ${p.additions.toLocaleString('id-ID')} |`)].join('\n')
    : '_Belum ada data kontributor._',
  '',
  `<sub>${LB_DAYS} hari terakhir. Hanya commit fitur dan perubahan besar (minimal ${MIN_ADD} baris); perbaikan bug, revert, merge, dan commit kecil tidak dihitung.</sub>`,
  '<!--LEADER:END-->',
].join('\n');
const reLb = /<!--LEADER:START-->[\s\S]*?<!--LEADER:END-->/;
if (reLb.test(out)) out = out.replace(reLb, () => lbBlock);
else out = out.replace('<!--MONITOR:END-->', () => `<!--MONITOR:END-->\n\n## 🏆 Kontributor rajin\n\n${lbBlock}`);
writeFileSync(README, out);
console.log(`OK: ${repos.length} repo diproses`);
