// UI strings in English and Hebrew (spec 0006). English is the default for new
// users; Hebrew when the browser language is Hebrew. The choice is stored per device.
import { useEffect, useState } from "preact/hooks";

export type Lang = "en" | "he";
const KEY = "hub.lang";

const en = {
  // app shell
  offline: "No connection to the server - retrying",
  loading: "Loading",
  tryAgain: "Try again",
  cancel: "Cancel",
  close: "Close",
  save: "Save",
  back: "Back",
  settings: "Settings",

  // auth and error screens
  authTitle: "Sign in needed",
  authText: "Open the sign-in link from your computer (the Mac). It looks like this:",
  authNote: "You can send it to your phone and open it here. After you sign in, this device stays signed in.",
  noServer: "Can't reach the server",

  // tab bar
  mainNav: "Main navigation",
  tabChats: "Chats",
  tabHome: "Home",
  tabDevices: "Devices",

  // store toasts
  patchFailed: "Change not saved - try again",
  labelCreateFailed: "Couldn't create the label",
  labelSaveFailed: "Label not saved",
  labelDeleteFailed: "Couldn't delete the label",

  // status, priority, kind
  status: { waiting: "Waiting for you", working: "Working", idle: "Idle", archived: "Archived" },
  priority: { high: "High", normal: "Normal", low: "Low" },
  kind: { code: "Code", general: "General" },
  tagTerminal: "Terminal",
  tagGeneral: "General",
  waiting: "Waiting",
  disconnected: "Disconnected",

  // Relative time: null means Intl.RelativeTimeFormat. Hebrew keeps its own words,
  // because Chromium's Hebrew data writes "(1)" after one-unit forms.
  relative: null as RelativeWords | null,

  // durations ("Running 3 min")
  durMin1: "1 min",
  durMin: (m: number) => `${m} min`,
  durHour1: "1 hr",
  durHour: (h: number) => `${h} hr`,

  // edit summary
  prioritySummary: (p: string) => `${p} priority`,
  labelOne: (name: string) => `Label: ${name}`,
  labelMany: (n: number) => `${n} labels`,
  hasNote: "Has a note",

  // home
  fallenOne: "1 session stopped",
  fallenMany: (n: number) => `${n} sessions stopped`,
  toRevive: "Revive",
  waitingOne: "1 waiting for you",
  waitingMany: (n: number) => `${n} waiting for you`,
  showAll: "Show all",
  showOnlyThem: "Show only these",
  homeEmptyTitle: "No chats picked yet",
  homeEmptyText: "Star a chat in the Chats tab, and it shows up here with its child chats.",
  toChats: "Go to Chats",
  chatOne: "1 chat",
  chatMany: (n: number) => `${n} chats`,
  kidsWaiting: (n: number) => `${n} waiting`,
  agentOne: "1 agent running",
  agentMany: (n: number) => `${n} agents running`,

  // chats tab
  chatsSub: "Star = shows on Home",
  chatKind: "Chat type",
  search: "Search chats",
  clearSearch: "Clear search",
  filterProject: "Filter by project",
  all: "All",
  noMatchTitle: "No chats found",
  noMatchText: "Try another word or pick another project.",
  noChatsTitle: "No chats yet",
  noChatsGeneral: "When you open a Cowork chat in the Claude app, it shows up here.",
  noChatsCode: "When you open a chat in the Claude app or in a Claude Control terminal, it shows up here.",
  pinOff: "Remove from Home",
  pinOn: "Show on Home",
  fallenTitle: "Not running",
  stopped: "Stopped",
  revive: "Revive",
  reviveAll: "Revive all",

  // chat screen
  bridge: "Bridge",
  openIn: "Open in ",
  openOldIn: "Open the old one in ",
  whereToOpen: "Where to open?",
  whereToOpenText: "In the app, the chat opens where it runs. In the browser, it opens through Remote Control.",
  inApp: ["In the ", " app"] as [string, string],
  inBrowser: ["In the browser (", ")"] as [string, string],
  chatNotFound: "Chat not found",
  chatNotFoundText: "It may have been deleted or not loaded yet. Try going back to Home.",
  noLinkGeneral: "General chats have no link. You can open it in the Claude app on your computer.",
  noLinkTerminal: "No Remote Control link. You can connect from your computer with the command below.",
  noLink: "This session has no link to open.",
  edit: "Edit",
  terminal: "Terminal",
  runInTmux: "Running in tmux",
  runOutsideTmux: "Running outside tmux",
  attachWindow: "Attach to the window",
  restart: "Restart",
  window: "Window ",
  copyCommand: "Copy command",
  copied: "Command copied",
  copyFailed: "Copy failed",
  copy: "Copy",
  reviveInTerminal: "Revive in terminal",
  reviveInTerminalHint: "Opens a copy of the chat in a terminal with Remote Control and adds it to the auto-restore list.",
  whatHappened: "What happened last",
  beforeReplace: "Before it was replaced",
  needsYou: "Needs you",
  childChats: "Child chats",
  childOne: "1 child chat",
  childMany: (n: number) => `${n} child chats`,
  hideFinished: "Hide finished",
  showAllFinished: (n: number) => `Show all - ${n} more finished`,
  agentsRunning: (n: number) => `${n} running`,
  agentsDone: (n: number) => `${n} done`,
  agents: "Agents",
  finished: "Finished",
  running: (dur: string) => `Running ${dur}`.trim(),
  lastUsedRemote: (rel: string) => `Last used remotely ${rel}`,
  lastUsed: (rel: string) => `Last used ${rel}`,
  devices: "Devices",
  olderVersions: "Earlier versions",
  replacedAfterRestart: "Replaced after a restart",
  replacedTitle: "This session was replaced",
  replacedText: " restarted and opened a new session that continues the work. Only the history is left here.",
  goToNew: "Go to the new session",
  newSession: "New session: ",

  // device screen
  linkNotFound: "Connection not found",
  linkNotFoundText: "The connection may have closed. Go back to the device list.",
  linkOf: "Connection of the chat: ",
  linkType: "Connection type",
  lastUsedRemoteKey: "Last used remotely",
  lastActivity: "Last activity",
  lastTurn: "Last turn",
  fromRemote: "Came remotely",
  fromComputer: "Came from the computer",
  id: "ID",
  disconnectIn: ["To disconnect, use the ", " app."] as [string, string],
  deviceNote: "We have no data on the device type or whether it is connected now. We only see that a connection exists and when it was used.",

  // devices tab
  devicesSub: "Active connections by chat",
  loadFailed: "Couldn't load",
  loadFailedText: "No answer from the server. Try again in a moment.",
  noLinksTitle: "No connections",
  noLinksText: "When you open a chat from your phone or a browser through Remote Control, it shows up here.",
  linkOne: "1 connection",
  linkMany: (n: number) => `${n} connections`,
  sharedFolders: "Shared folders",
  folderOn: "Shared",
  folderOff: "Off",

  // edit screen
  goBackRetry: "Go back and try again.",
  saved: "Saved",
  priorityTitle: "Priority",
  labels: "Labels",
  noLabels: "No labels yet. You can create them in Settings.",
  note: "Note",
  notePlaceholder: "What to remember about this chat",
  project: "Project",
  saving: "Saving...",

  // settings
  themes: { system: "System", light: "Light", dark: "Dark" },
  pushOn: "Notifications are on",
  pushOnFailed: (err: string) => `Couldn't turn on notifications${err ? ` - ${err}` : ""}`,
  pushOff: "Notifications are off on this phone",
  pushOffFailed: "Couldn't turn off notifications",
  testSent: "Test notification sent",
  testFailed: "Sending the test failed",
  hintMock: "Demo mode has no server, so notifications can't be turned on.",
  hintIos:
    "On iPhone, first add the app to the Home Screen: tap Share in Safari, then \"Add to Home Screen\". Open Claude Control Mobile from there and come back here.",
  hintUnsupported: "This browser doesn't support push notifications.",
  hintDenied: "Notifications are blocked. You can change this in the browser or device settings.",
  notifications: "Notifications",
  push: "Push notifications",
  pushSub: "When a chat I picked is waiting for me",
  testPush: "Test notification",
  testPushSub: "Sent to this phone",
  sendTest: "Send test",
  theme: "Theme",
  language: "Language",
  version: "Version 2.0",
  fixAll: "Fix all",
  fixAllSub: "Missing and disconnected sessions, and the server",
  fix: "Fix",
  restartServer: ["Restart the ", " server"] as [string, string],
  daemonRunning: (status: string) => (status ? `Running - ${status}` : "Running"),
  daemonDown: "Not running",
  daemonUnknown: "Status unknown",
  restartShort: "Restart",
  controlOptional: "Claude Control is an optional add-on. Without it, terminal sessions and revive are off.",
  newLabel: "New label",
  confirmDelete: (name: string) => `Delete the label "${name}"? It will be removed from all chats.`,
  labelName: "Label name",
  color: "Color",
  delete: "Delete",

  // Claude Control (revive)
  actions: {
    restart_session: "Restart a session",
    resume: "Revive in terminal",
    resume_missing: "Start missing sessions",
    fix_all: "Fix all",
    restart_daemon: "Restart the Remote Control server",
  } as Record<string, string>,
  controlChecking: "Checking Claude Control...",
  controlOff: "Claude Control is not running - revive is off",
  controlBusy: (action: string) => `Claude Control: running an action - ${action}`,
  controlOn: (running: number, total: number) => `Claude Control connected${total ? ` - ${running} of ${total} running` : ""}`,
  done: "Done",
  failed: "Failed",
  noFinal: "No final answer yet. Check again in a moment.",
  actionFailed: "The action failed",
  whatWillHappen: "What will happen",
  loadingPlan: "Loading the plan...",
  noPlan: "No plan to show",
  sending: "Sending to Claude Control...",
  specResumeTitle: (t: string) => `Revive in terminal: ${t}`,
  specResumeText:
    "Claude Control opens a copy of the chat in a terminal (tmux) with Remote Control and adds it to auto-restore. The session in the app does not change.",
  specRestartTitle: (t: string) => `Restart: ${t}`,
  specRestartText:
    "Claude Control sends /exit to the session, waits for it to close, and starts it again with Remote Control. If background work runs in it, it will not close.",
  specReviveTitle: (t: string) => `Revive: ${t}`,
  specReviveText: "Claude Control starts the session again in tmux with Remote Control.",
  specAllText: "Claude Control starts every session on the list that is not running. Running sessions do not change.",
  specFixText:
    "Claude Control fixes what it can on its own: it starts missing sessions, restarts sessions whose Remote Control is disconnected, and restarts the server if it is not running.",
  specFixConfirm: "Fix all",
  specDaemonText:
    "The server stops and comes back within about a minute. During that time the phone will not see new sessions. The sessions themselves keep running.",

  // mock backend (demo mode)
  mockPlan: "Plan only",
  mockPlanName: (n: string) => `Plan only: ${n}`,
  mockStarted: "Started",
  mockDone: "Done",
  mockRunsAgain: "Running again",
  mockResumed: (n: string) => `${n} started and was added to auto-restore`,
  mockNoConversation: "This session has no known conversation, so it can't be revived",
};

export type Strings = typeof en;

interface RelativeWords {
  now: string;
  minutes: (m: number) => string;
  hour1: string;
  hours: (h: number) => string;
  yesterday: string;
  days: (d: number) => string;
  week: string;
}

const he: Strings = {
  offline: "אין חיבור לשרת - מנסה שוב",
  loading: "טוען",
  tryAgain: "נסה שוב",
  cancel: "ביטול",
  close: "סגור",
  save: "שמור",
  back: "חזרה",
  settings: "הגדרות",

  authTitle: "צריך להתחבר",
  authText: "פתח את קישור הכניסה מהמחשב (המק). הוא נראה כך:",
  authNote: "אפשר להעביר אותו לטלפון ולפתוח כאן. אחרי הכניסה המכשיר הזה יישאר מחובר.",
  noServer: "אין חיבור לשרת",

  mainNav: "ניווט ראשי",
  tabChats: "צ'אטים",
  tabHome: "בית",
  tabDevices: "מכשירים",

  patchFailed: "השינוי לא נשמר - נסה שוב",
  labelCreateFailed: "לא הצלחתי ליצור תווית",
  labelSaveFailed: "התווית לא נשמרה",
  labelDeleteFailed: "לא הצלחתי למחוק את התווית",

  status: { waiting: "מחכה לך", working: "עובד", idle: "שקט", archived: "בארכיון" },
  priority: { high: "גבוהה", normal: "רגילה", low: "נמוכה" },
  kind: { code: "קוד", general: "כללי" },
  tagTerminal: "טרמינל",
  tagGeneral: "כללי",
  waiting: "מחכה",
  disconnected: "מנותק",

  relative: {
    now: "עכשיו",
    minutes: (m) => `לפני ${m} דק'`,
    hour1: "לפני שעה",
    hours: (h) => `לפני ${h} שע'`,
    yesterday: "אתמול",
    days: (d) => `לפני ${d} ימים`,
    week: "לפני שבוע",
  },

  durMin1: "דקה",
  durMin: (m) => `${m} דק'`,
  durHour1: "שעה",
  durHour: (h) => `${h} שע'`,

  prioritySummary: (p) => `עדיפות ${p}`,
  labelOne: (name) => `תווית ${name}`,
  labelMany: (n) => `${n} תוויות`,
  hasNote: "יש הערה",

  fallenOne: "סשן אחד נפל",
  fallenMany: (n) => `${n} סשנים נפלו`,
  toRevive: "להחייה",
  waitingOne: "1 מחכה לך",
  waitingMany: (n) => `${n} מחכים לך`,
  showAll: "הצג הכל",
  showOnlyThem: "הצג רק אותם",
  homeEmptyTitle: "עוד לא בחרת צ'אטים",
  homeEmptyText: "סמן כוכב ליד צ'אט בלשונית צ'אטים, והוא יופיע כאן עם הילדים שלו.",
  toChats: "לצ'אטים",
  chatOne: "צ'אט אחד",
  chatMany: (n) => `${n} צ'אטים`,
  kidsWaiting: (n) => `${n} מחכה`,
  agentOne: "סוכן אחד רץ",
  agentMany: (n) => `${n} סוכנים רצים`,

  chatsSub: "כוכב = מופיע בבית",
  chatKind: "סוג צ'אט",
  search: "חיפוש צ'אט",
  clearSearch: "נקה חיפוש",
  filterProject: "סינון לפי פרויקט",
  all: "הכל",
  noMatchTitle: "לא נמצאו צ'אטים",
  noMatchText: "נסה מילה אחרת או בחר פרויקט אחר.",
  noChatsTitle: "אין צ'אטים עדיין",
  noChatsGeneral: "כשתפתח צ'אט Cowork באפליקציית Claude, הוא יופיע כאן.",
  noChatsCode: "כשתפתח צ'אט באפליקציית Claude או בטרמינל של Claude Control, הוא יופיע כאן.",
  pinOff: "הסר מהבית",
  pinOn: "הצג בבית",
  fallenTitle: "נפלו",
  stopped: "עצור",
  revive: "החייה",
  reviveAll: "החייה לכולם",

  bridge: "גשר",
  openIn: "פתח ב-",
  openOldIn: "פתח את הישן ב-",
  whereToOpen: "איפה לפתוח?",
  whereToOpenText: "באפליקציה הצ'אט נפתח במקום שבו הוא רץ. בדפדפן הוא נפתח דרך Remote Control.",
  inApp: ["באפליקציית ", ""],
  inBrowser: ["בדפדפן (", ")"],
  chatNotFound: "הצ'אט לא נמצא",
  chatNotFoundText: "ייתכן שהוא נמחק או שעוד לא נטען. נסה לחזור לבית.",
  noLinkGeneral: "לצ'אט כללי אין קישור. אפשר לפתוח אותו באפליקציית Claude במחשב.",
  noLinkTerminal: "אין קישור Remote Control. אפשר להתחבר מהמחשב עם הפקודה למטה.",
  noLink: "אין קישור לפתיחה לסשן הזה.",
  edit: "עריכה",
  terminal: "טרמינל",
  runInTmux: "רץ ב-tmux",
  runOutsideTmux: "רץ מחוץ ל-tmux",
  attachWindow: "התחברות לחלון",
  restart: "הפעלה מחדש",
  window: "חלון ",
  copyCommand: "העתק פקודה",
  copied: "הפקודה הועתקה",
  copyFailed: "ההעתקה נכשלה",
  copy: "העתק",
  reviveInTerminal: "החייה בטרמינל",
  reviveInTerminalHint: "פותח עותק של השיחה בטרמינל עם Remote Control ומוסיף אותו לרשימת השחזור האוטומטי.",
  whatHappened: "מה קרה בסוף",
  beforeReplace: "לפני ההחלפה",
  needsYou: "צריך ממך",
  childChats: "צ'אטים ילדים",
  childOne: "צ'אט ילד אחד",
  childMany: (n) => `${n} צ'אטים ילדים`,
  hideFinished: "הסתר שהסתיימו",
  showAllFinished: (n) => `הצג הכל - עוד ${n} שהסתיימו`,
  agentsRunning: (n) => `${n} רצים`,
  agentsDone: (n) => `${n} הסתיימו`,
  agents: "סוכנים",
  finished: "הסתיים",
  running: (dur) => `רץ ${dur}`.trim(),
  lastUsedRemote: (rel) => `שימוש אחרון מרחוק ${rel}`,
  lastUsed: (rel) => `שימוש אחרון ${rel}`,
  devices: "מכשירים",
  olderVersions: "גרסאות קודמות",
  replacedAfterRestart: "הוחלף אחרי הפעלה מחדש",
  replacedTitle: "הסשן הזה הוחלף",
  replacedText: " הופעל מחדש ופתח סשן חדש שממשיך את העבודה. כאן נשארה רק ההיסטוריה.",
  goToNew: "עבור לסשן החדש",
  newSession: "הסשן החדש: ",

  linkNotFound: "החיבור לא נמצא",
  linkNotFoundText: "ייתכן שהחיבור נסגר. חזור לרשימת המכשירים.",
  linkOf: "חיבור של הצ'אט: ",
  linkType: "סוג חיבור",
  lastUsedRemoteKey: "שימוש אחרון מרחוק",
  lastActivity: "פעילות אחרונה",
  lastTurn: "התור האחרון",
  fromRemote: "הגיע מרחוק",
  fromComputer: "הגיע מהמחשב",
  id: "מזהה",
  disconnectIn: ["את הניתוק עושים באפליקציית ", "."],
  deviceNote: "אין לנו מידע על סוג המכשיר או אם הוא מחובר עכשיו. רואים רק שיש חיבור ומתי השתמשו בו.",

  devicesSub: "חיבורים פעילים לפי צ'אט",
  loadFailed: "לא הצלחתי לטעון",
  loadFailedText: "אין תשובה מהשרת. נסה שוב בעוד רגע.",
  noLinksTitle: "אין חיבורים",
  noLinksText: "כשתפתח צ'אט מהטלפון או מהדפדפן דרך Remote Control, הוא יופיע כאן.",
  linkOne: "חיבור 1",
  linkMany: (n) => `${n} חיבורים`,
  sharedFolders: "תיקיות משותפות",
  folderOn: "משותפת",
  folderOff: "כבויה",

  goBackRetry: "חזור ונסה שוב.",
  saved: "נשמר",
  priorityTitle: "עדיפות",
  labels: "תוויות",
  noLabels: "אין תוויות עדיין. אפשר ליצור בהגדרות.",
  note: "הערה",
  notePlaceholder: "מה חשוב לזכור על הצ'אט הזה",
  project: "פרויקט",
  saving: "שומר...",

  themes: { system: "מערכת", light: "בהיר", dark: "כהה" },
  pushOn: "התראות הופעלו",
  pushOnFailed: (err) => `לא הצלחתי להפעיל התראות${err ? ` - ${err}` : ""}`,
  pushOff: "התראות כובו בטלפון הזה",
  pushOffFailed: "לא הצלחתי לכבות התראות",
  testSent: "נשלחה התראת בדיקה",
  testFailed: "שליחת הבדיקה נכשלה",
  hintMock: "במצב הדגמה אין שרת, אז אי אפשר להפעיל התראות.",
  hintIos:
    "באייפון צריך קודם להוסיף למסך הבית: כפתור השיתוף בספארי, ואז \"הוספה למסך הבית\". פתח את Claude Control Mobile משם וחזור לכאן.",
  hintUnsupported: "הדפדפן הזה לא תומך בהתראות פוש.",
  hintDenied: "ההתראות חסומות. אפשר לשנות את זה בהגדרות הדפדפן או המכשיר.",
  notifications: "התראות",
  push: "התראות פוש",
  pushSub: "כשצ'אט שבחרתי מחכה לי",
  testPush: "בדיקת התראה",
  testPushSub: "נשלחת לטלפון הזה",
  sendTest: "שלח בדיקה",
  theme: "ערכת צבעים",
  language: "שפה",
  version: "גרסה 2.0",
  fixAll: "תיקון הכל",
  fixAllSub: "סשנים חסרים, מנותקים והשרת",
  fix: "תקן",
  restartServer: ["הפעלה מחדש של שרת ", ""],
  daemonRunning: (status) => `רץ ${status}`.trim(),
  daemonDown: "לא רץ",
  daemonUnknown: "מצב לא ידוע",
  restartShort: "הפעל",
  controlOptional: "Claude Control הוא תוסף לא חובה. בלעדיו אין סשנים בטרמינל ואין החייה.",
  newLabel: "תווית חדשה",
  confirmDelete: (name) => `למחוק את התווית "${name}"? היא תוסר מכל הצ'אטים.`,
  labelName: "שם התווית",
  color: "צבע",
  delete: "מחק",

  actions: {
    restart_session: "הפעלה מחדש של סשן",
    resume: "החייה בטרמינל",
    resume_missing: "הפעלת סשנים חסרים",
    fix_all: "תיקון הכל",
    restart_daemon: "הפעלה מחדש של שרת Remote Control",
  },
  controlChecking: "בודק את Claude Control...",
  controlOff: "Claude Control לא רץ - אי אפשר להחיות מכאן",
  controlBusy: (action) => `Claude Control: רצה פעולה - ${action}`,
  controlOn: (running, total) => `Claude Control מחובר${total ? ` - ${running} מתוך ${total} רצים` : ""}`,
  done: "הסתיים",
  failed: "נכשל",
  noFinal: "לא התקבלה תשובה סופית. בדוק שוב בעוד רגע.",
  actionFailed: "הפעולה נכשלה",
  whatWillHappen: "מה יקרה",
  loadingPlan: "טוען תוכנית...",
  noPlan: "אין תוכנית להצגה",
  sending: "שולח ל-Claude Control...",
  specResumeTitle: (t) => `החייה בטרמינל: ${t}`,
  specResumeText:
    "Claude Control יפתח עותק של השיחה בטרמינל (tmux) עם Remote Control, ויוסיף אותו לשחזור האוטומטי. הסשן באפליקציה לא משתנה.",
  specRestartTitle: (t) => `הפעלה מחדש: ${t}`,
  specRestartText:
    "Claude Control ישלח /exit לסשן, יחכה שייסגר ויפעיל אותו מחדש עם Remote Control. אם רצה בו עבודת רקע, הוא לא ייסגר.",
  specReviveTitle: (t) => `החייה: ${t}`,
  specReviveText: "Claude Control יפעיל את הסשן מחדש ב-tmux עם Remote Control.",
  specAllText: "Claude Control יפעיל כל סשן מהרשימה שלא רץ. סשנים שרצים לא ישתנו.",
  specFixText:
    "Claude Control יתקן מה שהוא יודע לתקן לבד: יפעיל סשנים חסרים, יפעיל מחדש סשנים שה-Remote Control שלהם מנותק, ואת השרת אם הוא לא רץ.",
  specFixConfirm: "תקן הכל",
  specDaemonText: "השרת ייעצר ויעלה מחדש תוך כדקה. בזמן הזה הטלפון לא יראה סשנים חדשים. הסשנים עצמם ממשיכים לרוץ.",

  mockPlan: "תוכנית בלבד",
  mockPlanName: (n) => `תוכנית בלבד: ${n}`,
  mockStarted: "התחיל",
  mockDone: "הסתיים",
  mockRunsAgain: "רץ שוב",
  mockResumed: (n) => `${n} הופעל ונוסף לשחזור האוטומטי`,
  mockNoConversation: "לסשן הזה אין שיחה ידועה, אי אפשר להחיות אותו",
};

const TABLES: Record<Lang, Strings> = { en, he };

/** Stored choice, else Hebrew for a Hebrew browser, else English. Storage can throw. */
export function readLang(): Lang {
  try {
    const v = localStorage.getItem(KEY);
    if (v === "en" || v === "he") return v;
  } catch {
    /* storage blocked */
  }
  try {
    return /^(he|iw)\b/i.test(navigator.language) ? "he" : "en";
  } catch {
    return "en";
  }
}

/** The active language and its strings. Live bindings: read them at render time. */
export let lang: Lang = readLang();
export let T: Strings = TABLES[lang];

export const dir = (): "ltr" | "rtl" => (lang === "he" ? "rtl" : "ltr");
/** Locale for Intl. */
export const locale = () => (lang === "he" ? "he-IL" : "en-US");

/** Sets <html lang dir>. Call before the first render and on every change. */
export function applyLang(): void {
  const root = document.documentElement;
  root.lang = lang;
  root.dir = dir();
}

const listeners = new Set<(l: Lang) => void>();

export function setLang(next: Lang): void {
  if (next === lang) return;
  lang = next;
  T = TABLES[next];
  applyLang();
  try {
    localStorage.setItem(KEY, next);
  } catch {
    /* not saved, still works for this visit */
  }
  for (const fn of listeners) fn(next);
}

/** Re-renders the caller when the language changes. */
export function useLang(): Lang {
  const [l, setL] = useState(lang);
  useEffect(() => {
    listeners.add(setL);
    setL(lang);
    return () => {
      listeners.delete(setL);
    };
  }, []);
  return l;
}
