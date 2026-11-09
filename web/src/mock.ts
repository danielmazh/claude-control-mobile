// Fake data for dev and screenshots without the server (contract v2.4). Titles are invented.
// Texts follow the UI language: English or Hebrew (spec 0006).
import { lang } from "./i18n";
import type { Devices, Label, Link, Session, Snapshot, Subagent } from "./types";

const min = 60_000;
const hour = 60 * min;
const day = 24 * hour;

/** Pick the demo text for the active language. */
const tx = (en: string, he: string) => (lang === "he" ? he : en);

const makeLabels = (): Label[] => [
  { id: "l-client", name: tx("Client", "לקוח"), color: "#3B7BC8" },
  { id: "l-others", name: tx("Waiting on others", "ממתין לאחרים"), color: "#B8801C" },
  { id: "l-personal", name: tx("Personal", "אישי"), color: "#4A8A3F" },
];

/** Demo home folder: ~/code in English, ~/c-projects in Hebrew (as before). */
const home = () => (lang === "he" ? "/Users/demo/c-projects" : "/Users/demo/code");

type Seed = Partial<Session> & Pick<Session, "id" | "title" | "project" | "status"> & { ago: number };

const rc = (n: string): Link => ({
  kind: "remote-control",
  remoteId: `session_01HxQ${n}9vT2mK8pL4fQ`,
  url: `https://claude.ai/code/session_01HxQ${n}9vT2mK8pL4fQ`,
});
const bridge = (n: string): Link => ({
  kind: "bridge",
  remoteId: `session_01Jb${n}7wR3nB5cD2aZ`,
  url: `https://claude.ai/code/session_01Jb${n}7wR3nB5cD2aZ`,
});

const agent = (id: string, type: string, description: string, finished: boolean, agoMin: number, now: number): Subagent => ({
  id,
  type,
  description,
  finished,
  startedAt: now - agoMin * min,
});

function seeds(now: number): Seed[] {
  return [
    {
      id: "cowork_local_demo-trip",
      title: tx("Trip planning", "תכנון טיול לצפון"),
      project: "Trips",
      status: "waiting",
      ago: 25 * min,
      pinned: true,
      source: "cowork",
      kind: "general",
      openUrl: null,
      revive: null,
      summary: tx("I made three route options. Waiting for you to pick one.", "הכנתי שלוש אפשרויות למסלול. מחכה שתבחר אחת."),
    },
    {
      id: "cowork_local_demo-budget",
      title: tx("Monthly expense summary", "סיכום הוצאות חודשי"),
      project: "Cowork",
      status: "idle",
      ago: 2 * day,
      source: "cowork",
      kind: "general",
      openUrl: null,
      revive: null,
    },
    {
      id: "cli_demo-0001",
      title: "orch-demo",
      project: tx("code", "c-projects"),
      status: "waiting",
      ago: 12 * min,
      pinned: true,
      source: "terminal",
      terminal: { tmuxTarget: "rc-resume:4", running: true, attachCmd: "tmux attach -t rc-resume:4", name: "orch-demo" },
      revive: "restart",
      summary: tx("Finished the round. All tests pass, waiting for a decision on the next step.", "סיימתי את הסבב. כל הבדיקות עוברות, מחכה להחלטה על השלב הבא."),
      links: [rc("t")],
    },
    {
      id: "cli_demo-0002",
      title: "notes-demo",
      project: tx("code", "c-projects"),
      status: "idle",
      ago: 5 * day,
      source: "terminal",
      openUrl: null,
      terminal: { tmuxTarget: null, running: false, attachCmd: `cd ${home()} && claude --resume demo-0002`, name: "notes-demo" },
      revive: "restart",
    },
    {
      id: "local_pay",
      title: tx("Payment screen upgrade", "שדרוג מסך התשלום"),
      project: "shop-app",
      status: "waiting",
      ago: 4 * min,
      pinned: true,
      priority: "high",
      labelIds: ["l-client"],
      note: tx("Check with the client before merging", "לבדוק מול הלקוח לפני שממזגים"),
      summary: tx(
        "Added address fields to the checkout screen and connected Stripe. All tests pass except one in Safari, which I opened in a separate chat.",
        "הוספתי שדות כתובת למסך התשלום וחיברתי את Stripe. כל הבדיקות עוברות חוץ מבדיקה אחת ב-Safari, שאותה פתחתי בצ'אט נפרד.",
      ),
      needsAction: tx("Approve moving to Stripe Checkout instead of the form.", "לאשר מעבר ל-Stripe Checkout במקום טופס משלנו."),
      links: [rc("a"), bridge("a")],
      remoteSteered: true,
      replaces: ["local_pay_v1", "local_pay_v2"],
      subagents: {
        running: 2,
        done: 1,
        items: [
          agent("ag1", "Explore", tx("Scan the API files", "סורק את קבצי ה-API"), false, 3, now),
          agent("ag2", "general-purpose", tx("Check browser compatibility", "בודק תאימות לדפדפנים"), false, 1, now),
          agent("ag3", "general-purpose", tx("Write form tests", "כותב בדיקות לטופס"), true, 20, now),
        ],
      },
    },
    {
      id: "local_e2e",
      parentId: "local_pay",
      title: tx("Fix e2e test", "תיקון בדיקות e2e"),
      project: "shop-app",
      status: "waiting",
      ago: 6 * min,
      summary: tx("The test fails only in Safari because of the date format.", "מצאתי שהבדיקה נופלת רק ב-Safari בגלל פורמט התאריך."),
      needsAction: tx("Pick one: fix the format on the server or only in the test?", "לבחור: לתקן את הפורמט בשרת או רק בבדיקה?"),
    },
    {
      id: "local_sec",
      parentId: "local_pay",
      title: tx("Mobile security scan", "סקירת אבטחה לטופס"),
      project: "shop-app",
      status: "working",
      ago: 2 * min,
      subagents: { running: 0, done: 0, items: [] },
    },
    { id: "local_txt", parentId: "local_pay", title: tx("Hebrew text update", "עדכון טקסטים בעברית"), project: "shop-app", status: "idle", ago: 26 * hour },
    { id: "local_old1", parentId: "local_pay", title: tx("Old code cleanup", "ניקוי קוד ישן"), project: "shop-app", status: "archived", ago: 5 * day },
    { id: "local_old2", parentId: "local_pay", title: "Fix coupon rounding", project: "shop-app", status: "idle", ago: 4 * day },
    { id: "local_safari", parentId: "local_e2e", title: tx("Run Playwright on Safari", "הרצת Playwright על Safari"), project: "shop-app", status: "working", ago: 3 * min },
    { id: "local_shots", parentId: "local_safari", title: tx("Screenshots to compare", "צילומי מסך להשוואה"), project: "shop-app", status: "idle", ago: 40 * min },
    {
      id: "local_research",
      title: tx("Competitor research", "מחקר מתחרים לאפליקציה"),
      project: "research",
      status: "working",
      ago: 12 * min,
      pinned: true,
      summary: tx("Found 5 competitors and now comparing prices and features.", "אספתי 5 מתחרים ומשווה עכשיו מחירים ותכונות."),
      links: [rc("b")],
      remoteSteered: true,
      subagents: {
        running: 1,
        done: 2,
        items: [
          agent("ag4", "Explore", tx("Read pricing pages", "קורא דפי מחירים"), false, 5, now),
          agent("ag5", "Explore", tx("Sum up store reviews", "מסכם ביקורות בחנויות"), true, 30, now),
          agent("ag6", "general-purpose", tx("Build a comparison table", "בונה טבלת השוואה"), true, 45, now),
        ],
      },
    },
    {
      id: "local_sum5",
      parentId: "local_research",
      title: tx("Summary of 5 competitors", "סיכום 5 מתחרים"),
      project: "research",
      status: "working",
      ago: 8 * min,
      subagents: { running: 2, done: 0, items: [agent("ag7", "Explore", tx("Search for reviews", "מחפש סקירות"), false, 2, now), agent("ag8", "Explore", tx("Read help docs", "קורא מסמכי עזרה"), false, 4, now)] },
    },
    { id: "local_prices", parentId: "local_research", title: tx("Price table", "טבלת מחירים"), project: "research", status: "idle", ago: 50 * min },
    {
      id: "local_backup",
      title: "Nightly backup script",
      project: "ops-tools",
      status: "idle",
      ago: 3 * hour,
      pinned: true,
      priority: "low",
      summary: "The backup runs every night at 02:00 and keeps 14 copies.",
    },
    { id: "local_landing", title: "Landing page copy", project: "shop-app", status: "idle", ago: 3 * day },
    { id: "local_nvr", title: tx("Home camera setup", "התקנת מצלמות בבית"), project: "home-nvr", status: "idle", ago: 8 * day, labelIds: ["l-personal"] },
    { id: "local_dns", title: tx("Home server DNS fix", "תיקון DNS לשרת הבית"), project: "ops-tools", status: "archived", ago: 12 * day },
    // Older versions of "local_pay", replaced after restarts.
    {
      id: "local_pay_v1",
      title: tx("Payment screen upgrade", "שדרוג מסך התשלום"),
      project: "shop-app",
      status: "idle",
      ago: 2 * day + 4 * hour,
      replacedBy: "local_pay_v2",
      summary: tx("Started planning the address fields.", "התחלתי לתכנן את שדות הכתובת."),
    },
    {
      id: "local_pay_v2",
      title: tx("Payment screen upgrade", "שדרוג מסך התשלום"),
      project: "shop-app",
      status: "idle",
      ago: 15 * hour,
      replacedBy: "local_pay",
      summary: tx("Started connecting Stripe and stopped in the middle of the tests. The rest is in the new session.", "התחלתי לחבר את Stripe ועצרתי באמצע הבדיקות. ההמשך נמצא בסשן החדש."),
      links: [rc("c")],
    },
  ];
}

export function makeMockSnapshot(now = Date.now()): Snapshot {
  const list = seeds(now);
  const sessions: Session[] = list.map((s, i) => ({
    cwd: `${home()}/${s.project}`,
    lastActivityAt: now - s.ago,
    completedTurns: 3 + ((i * 7) % 40),
    openUrl: `https://claude.ai/code/session_mock_${i + 1}`,
    pinned: false,
    priority: "normal",
    labelIds: [],
    note: "",
    parentId: null,
    childIds: [],
    depth: 0,
    summary: null,
    needsAction: null,
    subagents: { running: 0, done: 0, items: [] },
    links: [],
    remoteSteered: false,
    replacedBy: null,
    replaces: [],
    source: "desktop",
    terminal: null,
    revive: "resume",
    kind: "code",
    ...s,
  }));
  for (const s of sessions) delete (s as Partial<Seed>).ago;
  const byId = new Map(sessions.map((s) => [s.id, s]));
  for (const s of sessions) {
    if (s.parentId) byId.get(s.parentId)?.childIds.push(s.id);
    let d = 0;
    for (let p = s.parentId; p; p = byId.get(p)?.parentId ?? null) d++;
    s.depth = d;
  }
  for (const s of sessions) s.childIds.sort((a, b) => byId.get(b)!.lastActivityAt - byId.get(a)!.lastActivityAt);
  return { sessions, labels: makeLabels(), generatedAt: now };
}

export function mockDevices(snap: Snapshot): Devices {
  return {
    sharedFolders: [
      { path: `${home()}/shop-app`, serving: true },
      { path: `${home()}/research`, serving: false },
    ],
    sessions: snap.sessions
      .filter((s) => s.links.length && !s.replacedBy)
      .map((s) => ({ sessionId: s.id, links: s.links, remoteSteered: s.remoteSteered, lastActivityAt: s.lastActivityAt })),
  };
}
