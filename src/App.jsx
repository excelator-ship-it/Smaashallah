/* Marina Smashers — Dubai Marina · doubles badminton scoreboard */
import { useState, useEffect, useMemo, useRef } from "react";
import { kvGet, kvSet, uploadPhoto, deletePhoto } from "./storage";
import {
  Crown, Trophy, Users, UserPlus, X, Trash2, RotateCw,
  Play, Feather, Utensils, Check, Calendar, Plus,
  RefreshCw, Sun, Moon, AlertTriangle, Share2, Save, ClipboardCopy,
  Lock, LockOpen, ChevronDown, ChevronUp, KeyRound, Camera, CalendarCheck, Download, Share
} from "lucide-react";

// Hash the passcode so the readable database only ever holds a hash, not the code.
async function hashCode(s) {
  try {
    const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
    return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
  } catch {
    let h = 0;
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
    return "f" + (h >>> 0).toString(16);
  }
}

/* ---------------- pure logic ---------------- */

const uid = () => Math.random().toString(36).slice(2, 9);

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function emptyStat() {
  return { points: 0, matches: 0, wins: 0, draws: 0, losses: 0, pf: 0, pa: 0, rests: 0 };
}

function computeStats(players, rounds) {
  const stats = {};
  players.forEach((p) => (stats[p.id] = emptyStat()));
  rounds.forEach((r) => {
    r.matches.forEach((m) => {
      const on = [...m.teamA, ...m.teamB];
      on.forEach((id) => stats[id] && (stats[id].matches += 1));
      const sa = m.scoreA, sb = m.scoreB;
      if (sa !== "" && sb !== "" && sa != null && sb != null) {
        const na = Number(sa), nb = Number(sb);
        m.teamA.forEach((id) => stats[id] && (stats[id].pf += na, stats[id].pa += nb));
        m.teamB.forEach((id) => stats[id] && (stats[id].pf += nb, stats[id].pa += na));
        // 2 pts for a win, 1 each for a drawn / unfinished game, 0 for a loss
        if (na > nb) {
          m.teamA.forEach((id) => stats[id] && (stats[id].wins += 1, stats[id].points += 2));
          m.teamB.forEach((id) => stats[id] && (stats[id].losses += 1));
        } else if (nb > na) {
          m.teamB.forEach((id) => stats[id] && (stats[id].wins += 1, stats[id].points += 2));
          m.teamA.forEach((id) => stats[id] && (stats[id].losses += 1));
        } else {
          on.forEach((id) => stats[id] && (stats[id].draws += 1, stats[id].points += 1));
        }
      }
    });
    r.resting.forEach((id) => stats[id] && (stats[id].rests += 1));
  });
  return stats;
}

function historyCounts(rounds) {
  const partner = {}, opponent = {};
  const key = (a, b) => [a, b].sort().join("|");
  const bump = (obj, a, b) => (obj[key(a, b)] = (obj[key(a, b)] || 0) + 1);
  rounds.forEach((r) =>
    r.matches.forEach((m) => {
      bump(partner, m.teamA[0], m.teamA[1]);
      bump(partner, m.teamB[0], m.teamB[1]);
      m.teamA.forEach((a) => m.teamB.forEach((b) => bump(opponent, a, b)));
    })
  );
  return { partner, opponent, key };
}

function makeRound(players, rounds) {
  const ids = players.map((p) => p.id);
  const n = ids.length;
  const restCount = n % 4;
  const stats = computeStats(players, rounds);

  const ordered = shuffle(ids).sort((a, b) => {
    const ma = stats[a].matches, mb = stats[b].matches;
    if (ma !== mb) return mb - ma;
    return stats[a].rests - stats[b].rests;
  });
  const resting = ordered.slice(0, restCount);
  const active = ordered.slice(restCount);

  const { partner, opponent, key } = historyCounts(rounds);
  const cost = (arr) => {
    let c = 0;
    arr.forEach((m) => {
      c += (partner[key(m.teamA[0], m.teamA[1])] || 0) * 100;
      c += (partner[key(m.teamB[0], m.teamB[1])] || 0) * 100;
      m.teamA.forEach((a) =>
        m.teamB.forEach((b) => (c += opponent[key(a, b)] || 0))
      );
    });
    return c;
  };

  let best = null, bestC = Infinity;
  for (let t = 0; t < 700; t++) {
    const s = shuffle(active);
    const matches = [];
    for (let i = 0; i < s.length; i += 4) {
      matches.push({
        teamA: [s[i], s[i + 1]],
        teamB: [s[i + 2], s[i + 3]],
        scoreA: "",
        scoreB: "",
      });
    }
    const c = cost(matches);
    if (c < bestC) { bestC = c; best = matches; if (c === 0) break; }
  }
  return { id: uid(), matches: best || [], resting };
}

/* ---------------- storage (shared = whole group) ---------------- */

const K_SESSION = "badminton:session:v3";
const K_HISTORY = "badminton:history:v3";
const K_ROSTER = "badminton:roster:v3";
const K_LOCK = "badminton:lock:v3";      // shared: { hash } | null — the session passcode
const K_SIGNUPS = "badminton:signups:v3"; // shared: [{ id, date, time, name }]
const K_SESSION_PREV = "badminton:session:prev:v3"; // shared: last session before a destructive change
const K_BOOKINGS = "badminton:bookings:v3"; // shared: { "date|time": { booked, photo:{url,path}, at } }
const K_THEME = "badminton:theme:v3";    // personal
const UNLOCK_KEY = "badminton:unlockHash"; // per-device: hash this device has unlocked
const MAX_PHOTOS = 4;                       // per-match photo cap (protects the free storage tier)

const todayStr = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const fmtDate = (iso) => {
  try { return new Date(iso + "T00:00:00").toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" }); }
  catch { return iso; }
};
const fmtTime = (t) => {
  if (!t) return "";
  const [h, m] = t.split(":").map(Number);
  const ap = h < 12 ? "AM" : "PM";
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, "0")} ${ap}`;
};
const fmtRegTime = (iso) => {
  try { return new Date(iso).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }); }
  catch { return ""; }
};
const fmtWhen = (iso) => {
  try { return new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }); }
  catch { return ""; }
};

// Each tab has its own shareable URL hash, e.g. .../#register, .../#standings
const TAB_SLUGS = { register: "register", players: "players", matches: "matches", board: "standings", history: "history" };
const SLUG_TABS = { register: "register", players: "players", matches: "matches", standings: "board", history: "history" };
const tabFromHash = () => {
  if (typeof window === "undefined") return null;
  return SLUG_TABS[(window.location.hash || "").replace(/^#/, "").toLowerCase()] || null;
};

// Recurring weekly sessions (getDay: 0=Sun … 6=Sat)
const SCHEDULE = [
  { dow: 2, time: "8 PM" },   // Tuesday
  { dow: 4, time: "8 PM" },   // Thursday
  { dow: 6, time: "10 AM" },  // Saturday
  { dow: 0, time: "10 AM" },  // Sunday
];
const timeMinutes = (t) => {
  if (!t) return 0;
  const [h, ap] = t.split(" ");
  let hh = Number(h) % 12;
  if ((ap || "").toUpperCase() === "PM") hh += 12;
  return hh * 60;
};

// Courts: 1 court holds 5. A 2nd court opens once 8 sign up. Hard cap 10 (2 courts).
const COURT_CAP = 5;
const SECOND_COURT_AT = 8;
const TOTAL_CAP = 10;
const courtInfo = (n) => {
  const courts = n >= SECOND_COURT_AT ? 2 : 1;
  const capacity = courts * COURT_CAP;
  const confirmed = Math.min(n, capacity);
  return { courts, capacity, confirmed, waitlisted: Math.max(0, n - confirmed) };
};

// shared === true  -> group database (Supabase), synced across all devices
// shared === false -> this device only (localStorage), e.g. the theme choice
async function loadKey(key, fallback, shared) {
  try {
    if (!shared) {
      const raw = localStorage.getItem(key);
      return raw != null ? JSON.parse(raw) : fallback;
    }
    const val = await kvGet(key);
    return val != null ? val : fallback;
  } catch {
    return fallback;
  }
}
async function saveKey(key, value, shared) {
  try {
    if (!shared) { localStorage.setItem(key, JSON.stringify(value)); return; }
    await kvSet(key, value);
  } catch {}
}

/* ---------------- component ---------------- */

export default function App() {
  const [tab, setTabState] = useState(() => tabFromHash() || "register");
  const [players, setPlayers] = useState([]);
  const [rounds, setRounds] = useState([]);
  const [history, setHistory] = useState([]);
  const [name, setName] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [theme, setTheme] = useState("dark");
  const [syncing, setSyncing] = useState(false);
  const [confirm, setConfirm] = useState(null);
  const [dataOpen, setDataOpen] = useState(false);
  const [restoreText, setRestoreText] = useState("");
  const [dataMsg, setDataMsg] = useState("");
  const [past, setPast] = useState({ date: "", champ: "", champPts: "", spoon: "", spoonPts: "" });
  // Session lock: `lock` = { hash } | null (shared). Device is unlocked when it knows the code.
  const [lock, setLock] = useState(null);
  const [unlocked, setUnlocked] = useState(false);
  const [lockModal, setLockModal] = useState(null); // "set" | "start" | "enter" | "manage"
  const [pass, setPass] = useState("");
  const [passErr, setPassErr] = useState("");
  const [openWeek, setOpenWeek] = useState(null); // history entry id currently expanded
  const [openSession, setOpenSession] = useState(null); // register session key expanded
  const [lightbox, setLightbox] = useState(null); // photo url being viewed full-screen
  const [uploadingKey, setUploadingKey] = useState(null); // "rIdx-mIdx" currently uploading
  const [installEvt, setInstallEvt] = useState(null); // Android/Chrome deferred install prompt
  const [installHintOpen, setInstallHintOpen] = useState(false); // iOS "add to home screen" hint
  const [signups, setSignups] = useState([]);
  const [reg, setReg] = useState({ date: todayStr(), hour: "7", ap: "PM", name: "" });
  const [regMsg, setRegMsg] = useState("");
  const [myName, setMyName] = useState(() => (typeof window !== "undefined" ? localStorage.getItem("ms_name") || "" : ""));
  const [nameDraft, setNameDraft] = useState("");
  const [nameEditing, setNameEditing] = useState(false);
  const [addTimeOpen, setAddTimeOpen] = useState(false);
  const [addNameDraft, setAddNameDraft] = useState("");
  const [bookings, setBookings] = useState({});
  const [bookingBusy, setBookingBusy] = useState(null); // session key currently uploading
  const [prevSnap, setPrevSnap] = useState(null); // last session before a destructive change
  const nameRef = useRef(null);
  const saveTimer = useRef(null);

  // Switch tab and reflect it in the URL (so it's shareable / deep-linkable).
  const setTab = (t) => {
    setTabState(t);
    const slug = TAB_SLUGS[t];
    if (slug && window.location.hash.replace(/^#/, "") !== slug) {
      window.history.pushState(null, "", "#" + slug);
    }
  };
  useEffect(() => {
    const sync = () => { const t = tabFromHash(); if (t) setTabState(t); };
    window.addEventListener("popstate", sync);
    window.addEventListener("hashchange", sync);
    return () => { window.removeEventListener("popstate", sync); window.removeEventListener("hashchange", sync); };
  }, []);

  // PWA install: capture the Android/Chrome prompt; hide everything once installed.
  useEffect(() => {
    const onPrompt = (e) => { e.preventDefault(); setInstallEvt(e); };
    const onInstalled = () => { setInstallEvt(null); setInstallDismissed(true); };
    window.addEventListener("beforeinstallprompt", onPrompt);
    window.addEventListener("appinstalled", onInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", onPrompt);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);
  const isStandalone = typeof window !== "undefined" &&
    (window.matchMedia?.("(display-mode: standalone)").matches || window.navigator.standalone === true);
  const isIOS = typeof navigator !== "undefined" && /iphone|ipad|ipod/i.test(navigator.userAgent);
  const canInstall = !isStandalone && (installEvt || isIOS);
  const onInstallClick = async () => {
    if (installEvt) {
      installEvt.prompt();
      try { await installEvt.userChoice; } catch {}
      setInstallEvt(null);
    } else {
      setInstallHintOpen(true); // iOS: show the Add to Home Screen hint
    }
  };

  // No lock set -> open session (setup). Lock set -> only unlocked devices may edit.
  const canEdit = lock ? unlocked : true;
  const activePlayers = players.filter((p) => !p.left);
  const leftPlayers = players.filter((p) => p.left);

  const ask = (message, detail, onYes) => setConfirm({ message, detail, onYes });

  // Set (or change) the session passcode — the person doing this controls edits.
  const applyPasscode = async (code) => {
    const c = code.trim();
    if (c.length < 3) { setPassErr("Use at least 3 characters."); return false; }
    const hash = await hashCode(c);
    const next = { hash };
    setLock(next);
    setUnlocked(true);
    localStorage.setItem(UNLOCK_KEY, hash);
    await saveKey(K_LOCK, next, true);
    setPass(""); setPassErr("");
    return true;
  };
  const enterPasscode = async (code) => {
    const hash = await hashCode(code.trim());
    if (lock && hash === lock.hash) {
      setUnlocked(true);
      localStorage.setItem(UNLOCK_KEY, hash);
      setLockModal(null); setPass(""); setPassErr("");
    } else {
      setPassErr("That passcode didn't match.");
    }
  };
  const clearLock = async () => {
    setLock(null); setUnlocked(false);
    localStorage.removeItem(UNLOCK_KEY);
    await saveKey(K_LOCK, null, true);
  };
  const lockThisDevice = () => {
    setUnlocked(false);
    localStorage.removeItem(UNLOCK_KEY);
    setLockModal(null);
  };
  const openLock = () => {
    setPass(""); setPassErr("");
    setLockModal(lock ? (unlocked ? "manage" : "enter") : "set");
  };

  /* initial load */
  useEffect(() => {
    (async () => {
      const t = await loadKey(K_THEME, "dark", false);
      const s = await loadKey(K_SESSION, { players: [], rounds: [] }, true);
      const h = await loadKey(K_HISTORY, [], true);
      setTheme(t || "dark");
      setPlayers(s.players || []);
      setRounds(s.rounds || []);
      setHistory(h || []);
      const lk = await loadKey(K_LOCK, null, true);
      setLock(lk);
      if (lk && localStorage.getItem(UNLOCK_KEY) === lk.hash) setUnlocked(true);
      const su = await loadKey(K_SIGNUPS, [], true);
      setSignups(su || []);
      setPrevSnap(await loadKey(K_SESSION_PREV, null, true));
      setBookings((await loadKey(K_BOOKINGS, {}, true)) || {});
      setLoaded(true);
      // default landing tab is Register (set above); a URL hash still wins.
    })();
  }, []);

  /* debounced shared save */
  useEffect(() => {
    if (!loaded) return;
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      saveKey(K_SESSION, { players, rounds }, true);
    }, 500);
    return () => clearTimeout(saveTimer.current);
  }, [players, rounds, loaded]);

  /* pull latest when returning to the tab */
  const reloadShared = async () => {
    setSyncing(true);
    const s = await loadKey(K_SESSION, { players, rounds }, true);
    const h = await loadKey(K_HISTORY, history, true);
    const lk = await loadKey(K_LOCK, null, true);
    setPlayers(s.players || []);
    setRounds(s.rounds || []);
    setHistory(h || []);
    setLock(lk);
    setUnlocked(lk ? localStorage.getItem(UNLOCK_KEY) === lk.hash : false);
    setSignups((await loadKey(K_SIGNUPS, signups, true)) || []);
    setPrevSnap(await loadKey(K_SESSION_PREV, prevSnap, true));
    setBookings((await loadKey(K_BOOKINGS, bookings, true)) || {});
    setTimeout(() => setSyncing(false), 450);
  };
  useEffect(() => {
    if (!loaded) return;
    const onFocus = () => { if (!document.hidden) reloadShared(); };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);
    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
    };
  }, [loaded]);

  const toggleTheme = () => {
    const t = theme === "dark" ? "light" : "dark";
    setTheme(t);
    saveKey(K_THEME, t, false);
  };

  const stats = useMemo(() => computeStats(players, rounds), [players, rounds]);
  const ranked = useMemo(() => {
    return players
      .map((p) => {
        const s = stats[p.id];
        return { ...p, ...s, diff: s.pf - s.pa, decided: s.wins + s.draws + s.losses };
      })
      .sort((a, b) => {
        if (b.points !== a.points) return b.points - a.points;   // match points (2/1/0)
        if (b.wins !== a.wins) return b.wins - a.wins;
        if (b.diff !== a.diff) return b.diff - a.diff;            // point difference
        if (a.losses !== b.losses) return a.losses - b.losses;
        return a.name.localeCompare(b.name);
      });
  }, [players, stats]);

  const decidedPlayers = ranked.filter((r) => r.decided > 0);
  const anyScores = decidedPlayers.length > 0;
  const maxPts = anyScores ? Math.max(...decidedPlayers.map((r) => r.points)) : null;
  const minPts = anyScores ? Math.min(...decidedPlayers.map((r) => r.points)) : null;
  const leader = anyScores ? ranked.find((r) => r.decided > 0 && r.points === maxPts) : null;

  const nameOf = (id) => players.find((p) => p.id === id)?.name || "?";

  // Share to WhatsApp: native share sheet on mobile (pick the group), wa.me on desktop.
  const shareToWhatsApp = (text) => {
    if (navigator.share) { navigator.share({ text }).catch(() => {}); }
    else { window.open("https://wa.me/?text=" + encodeURIComponent(text), "_blank"); }
  };
  const appUrl = () => (typeof window !== "undefined" ? window.location.origin : "");
  const shareSignup = () =>
    shareToWhatsApp(`🏸 *Marina Smashers* — sign up for the next session 👇\n${appUrl()}/#register`);
  const shareStandings = () => {
    const played = ranked.filter((r) => r.matches > 0);
    if (!played.length) return;
    const lines = played.map((r, i) => `${i + 1}. ${r.name} — ${r.points} pts (${r.wins}W ${r.draws}D ${r.losses}L)`);
    let msg = `🏸 *Marina Smashers* — standings\n\n${lines.join("\n")}`;
    const champ = played[0], spoon = played[played.length - 1];
    msg += `\n\n👑 ${champ.name}`;
    if (spoon && spoon.name !== champ.name) msg += `    🥄 ${spoon.name}`;
    msg += `\n\n${appUrl()}`;
    shareToWhatsApp(msg);
  };

  const today = todayStr();
  // Auto-generate the next several standard sessions from the recurring schedule.
  const upcomingSessions = useMemo(() => {
    const out = [];
    const now = new Date();
    for (let i = 0; i < 28 && out.length < 4; i++) {
      const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + i);
      const slot = SCHEDULE.find((s) => s.dow === d.getDay());
      if (!slot) continue;
      const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      out.push({ date: iso, time: slot.time, key: iso + "|" + slot.time });
    }
    return out;
  }, [today]);

  // Merge auto sessions with any one-off sessions that already have sign-ups (today or later).
  const sessionsToShow = useMemo(() => {
    const map = new Map();
    upcomingSessions.forEach((s) => map.set(s.key, { date: s.date, time: s.time, key: s.key }));
    signups.forEach((s) => {
      const key = s.date + "|" + (s.time || "");
      if (s.date >= today && !map.has(key)) map.set(key, { date: s.date, time: s.time || "", key });
    });
    const arr = [...map.values()];
    arr.forEach((sess) => {
      sess.list = signups
        .filter((x) => x.date === sess.date && x.time === sess.time)
        .sort((a, b) => (a.at || "").localeCompare(b.at || ""));
    });
    arr.sort((a, b) => a.date.localeCompare(b.date) || timeMinutes(a.time) - timeMinutes(b.time));
    return arr.slice(0, 3);
  }, [upcomingSessions, signups, today]);

  const todaySignups = useMemo(() => {
    const seen = new Set(), out = [];
    signups.filter((s) => s.date === today).forEach((s) => {
      const k = s.name.toLowerCase();
      if (!seen.has(k)) { seen.add(k); out.push(s); }
    });
    return out;
  }, [signups, today]);

  const addSignupEntry = async (date, time, name) => {
    const nm = (name || "").trim();
    if (!nm || !date || !time) return false;
    const latest = await loadKey(K_SIGNUPS, signups, true);
    if (latest.some((s) => s.name.toLowerCase() === nm.toLowerCase() && s.date === date && s.time === time)) return "dup";
    const next = [...latest, { id: uid(), date, time, name: nm, at: new Date().toISOString() }];
    setSignups(next);
    await saveKey(K_SIGNUPS, next, true);
    return true;
  };
  const saveMyName = (nm) => {
    const v = (nm || "").trim();
    setMyName(v);
    if (v) localStorage.setItem("ms_name", v); else localStorage.removeItem("ms_name");
    setNameEditing(false);
    setRegMsg("");
  };
  const addOther = async (date, time) => {
    const nm = addNameDraft.trim();
    if (!nm) return;
    const res = await addSignupEntry(date, time, nm);
    if (res === "dup") setRegMsg(`${nm} is already on that list.`);
    else if (res) { setAddNameDraft(""); setRegMsg(`Added ${nm} \u2713`); }
    else setRegMsg("Couldn't add that name.");
  };
  // Court booking (per session key "date|time"), merge-safe so it won't clobber others.
  const writeBooking = async (key, patch) => {
    const latest = (await loadKey(K_BOOKINGS, bookings, true)) || {};
    const next = { ...latest, [key]: { ...(latest[key] || {}), ...patch } };
    if (patch === null) delete next[key];
    setBookings(next);
    await saveKey(K_BOOKINGS, next, true);
  };
  const toggleBooked = (key) => {
    const cur = bookings[key] || {};
    writeBooking(key, { booked: !cur.booked });
  };
  const uploadBooking = async (key, file) => {
    if (!file) return;
    setBookingBusy(key);
    try {
      const photo = await uploadPhoto(file, "court");
      await writeBooking(key, { booked: true, photo, at: new Date().toISOString() });
    } catch (e) {
      alert("Couldn't upload the screenshot. Check the storage bucket is set up, then try again.");
    }
    setBookingBusy(null);
  };
  const clearBooking = async (key) => {
    const ph = bookings[key]?.photo;
    const latest = (await loadKey(K_BOOKINGS, bookings, true)) || {};
    const next = { ...latest }; delete next[key];
    setBookings(next);
    await saveKey(K_BOOKINGS, next, true);
    if (ph?.path) deletePhoto(ph.path);
  };
  const toggleJoin = async (date, time) => {
    const nm = myName.trim();
    if (!nm) { setNameEditing(true); setNameDraft(""); setRegMsg("Add your name first."); return; }
    const mine = signups.find((s) => s.name.toLowerCase() === nm.toLowerCase() && s.date === date && s.time === time);
    if (mine) await removeSignup(mine.id);
    else await addSignupEntry(date, time, nm);
  };
  const addOneOff = async () => {
    const ok = await addSignupEntry(reg.date, `${reg.hour} ${reg.ap}`, myName);
    if (ok === "dup") setRegMsg("You're already on that one.");
    else if (ok) { setRegMsg("Added \u2713"); setAddTimeOpen(false); }
    else setRegMsg("Set your name and a date first.");
  };

  const addSignup = async () => {
    const name = reg.name.trim();
    if (!name || !reg.date || !reg.hour) { setRegMsg("Add your name, date and start time."); return; }
    const time = `${reg.hour} ${reg.ap}`;
    const latest = await loadKey(K_SIGNUPS, signups, true);
    const dup = latest.some((s) => s.name.toLowerCase() === name.toLowerCase() && s.date === reg.date && s.time === time);
    const next = dup ? latest : [...latest, { id: uid(), date: reg.date, time, name, at: new Date().toISOString() }];
    setSignups(next);
    await saveKey(K_SIGNUPS, next, true);
    setReg({ ...reg, name: "" });
    setRegMsg(dup ? "You're already on that list." : "Registered \u2713");
  };
  const removeSignup = async (id) => {
    const latest = await loadKey(K_SIGNUPS, signups, true);
    const next = latest.filter((s) => s.id !== id);
    setSignups(next);
    await saveKey(K_SIGNUPS, next, true);
  };
  const addRegisteredName = (nm) => {
    if (players.some((p) => p.name.toLowerCase() === nm.toLowerCase())) return;
    setPlayers((p) => [...p, { id: uid(), name: nm }]);
  };
  const addAllRegistered = () => {
    setPlayers((prev) => {
      const have = new Set(prev.map((p) => p.name.toLowerCase()));
      const adds = todaySignups.filter((s) => !have.has(s.name.toLowerCase())).map((s) => ({ id: uid(), name: s.name }));
      return [...prev, ...adds];
    });
  };

  /* actions */
  const addPlayer = () => {
    const t = name.trim();
    if (!t) return;
    if (players.some((p) => p.name.toLowerCase() === t.toLowerCase())) { setName(""); return; }
    setPlayers((p) => [...p, { id: uid(), name: t }]);
    setName("");
    nameRef.current?.focus();
  };
  const removePlayer = (id) => {
    const hasPlayed = rounds.some((r) => r.matches.some((m) => [...m.teamA, ...m.teamB].includes(id)));
    if (hasPlayed) {
      // Freeze history: keep the player record so their completed matches and names
      // stay intact; just mark them "left" so new rounds skip them.
      setPlayers((p) => p.map((x) => (x.id === id ? { ...x, left: true } : x)));
    } else {
      setPlayers((p) => p.filter((x) => x.id !== id));
      setRounds((rs) => rs.map((r) => ({ ...r, resting: r.resting.filter((x) => x !== id) })));
    }
  };
  const rejoinPlayer = (id) =>
    setPlayers((p) => p.map((x) => (x.id === id ? { ...x, left: false } : x)));
  // Keep a one-step undo: stash the current session before anything destructive.
  const snapshotSession = () => {
    if (!players.length && !rounds.length) return;
    const snap = { players, rounds, at: new Date().toISOString() };
    setPrevSnap(snap);
    saveKey(K_SESSION_PREV, snap, true);
  };
  const restorePrev = () => {
    if (!prevSnap) return;
    ask(
      "Restore the previous session?",
      `Brings back the session from ${fmtWhen(prevSnap.at)} and replaces what's here now.`,
      () => {
        snapshotSession(); // so this restore is itself undoable
        setPlayers(prevSnap.players || []);
        setRounds(prevSnap.rounds || []);
        setTab("matches");
      }
    );
  };
  const clearAllPlayers = () => { snapshotSession(); setPlayers([]); setRounds([]); clearLock(); };

  const loadLast = async () => {
    const last = await loadKey(K_ROSTER, [], true);
    if (last.length) { snapshotSession(); setPlayers(last.map((nm) => ({ id: uid(), name: nm }))); }
  };

  const doStart = () => {
    if (activePlayers.length < 4) return;
    saveKey(K_ROSTER, activePlayers.map((x) => x.name), true);
    setRounds((rs) => [...rs, makeRound(activePlayers, rs)]);
    setTab("matches");
  };
  const addRound = () => {
    if (activePlayers.length < 4) return;
    // Starting a brand-new session with no passcode yet → prompt to set one.
    if (rounds.length === 0 && !lock) { setPass(""); setPassErr(""); setLockModal("start"); return; }
    doStart();
  };
  const rerollRound = (idx) => {
    setRounds((rs) => {
      const prior = rs.slice(0, idx);
      const copy = rs.slice();
      copy[idx] = makeRound(activePlayers, prior);
      return copy;
    });
  };
  const deleteRound = (idx) => { snapshotSession(); setRounds((rs) => rs.filter((_, i) => i !== idx)); };

  const setScore = (rIdx, mIdx, side, val) => {
    const clean = val.replace(/[^\d]/g, "").slice(0, 3);
    setRounds((rs) =>
      rs.map((r, i) =>
        i !== rIdx ? r : {
          ...r,
          matches: r.matches.map((m, j) =>
            j !== mIdx ? m : { ...m, [side === "A" ? "scoreA" : "scoreB"]: clean }
          ),
        }
      )
    );
  };

  // Photos are open to everyone. To avoid a viewer's stale copy overwriting the
  // scorekeeper's latest scores, merge each change into the freshest shared session.
  const applyPhotoChange = async (roundId, mIdx, transform) => {
    const latest = await loadKey(K_SESSION, { players, rounds }, true);
    const lrounds = (latest.rounds || []).map((r) =>
      r.id !== roundId ? r : {
        ...r,
        matches: r.matches.map((m, j) => (j !== mIdx ? m : { ...m, photos: transform(m.photos || []) })),
      }
    );
    const merged = { players: latest.players || players, rounds: lrounds };
    setPlayers(merged.players);
    setRounds(merged.rounds);
    await saveKey(K_SESSION, merged, true);
  };
  const addPhoto = async (rIdx, mIdx, file) => {
    if (!file) return;
    const roundId = rounds[rIdx]?.id;
    const have = rounds[rIdx]?.matches?.[mIdx]?.photos?.length || 0;
    if (have >= MAX_PHOTOS) { alert(`Up to ${MAX_PHOTOS} photos per match.`); return; }
    setUploadingKey(rIdx + "-" + mIdx);
    try {
      const photo = await uploadPhoto(file, "m");
      await applyPhotoChange(roundId, mIdx, (ps) => [...ps, photo].slice(0, MAX_PHOTOS));
    } catch (e) {
      alert("Couldn't upload the photo. Check the storage bucket is set up, then try again.");
    }
    setUploadingKey(null);
  };
  const removePhoto = async (rIdx, mIdx, pIdx) => {
    const gone = rounds[rIdx]?.matches?.[mIdx]?.photos?.[pIdx];
    if (!gone) return;
    const roundId = rounds[rIdx]?.id;
    await applyPhotoChange(roundId, mIdx, (ps) => ps.filter((p) => p.path !== gone.path));
    deletePhoto(gone.path);
  };

  const finishWeek = () => {
    if (!anyScores) return;
    const champ = ranked.find((r) => r.decided > 0 && r.points === maxPts);
    const spoon = [...ranked].reverse().find((r) => r.decided > 0 && r.points === minPts);
    const entry = {
      id: uid(),
      date: new Date().toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }),
      players: decidedPlayers.length,
      rounds: rounds.length,
      system: "2/1/0",
      champ: champ ? { name: champ.name, points: champ.points } : null,
      spoon: spoon ? { name: spoon.name, points: spoon.points } : null,
      standings: ranked
        .filter((r) => r.matches > 0)
        .map((r) => ({
          name: r.name, points: r.points, wins: r.wins,
          draws: r.draws, losses: r.losses, diff: r.diff,
        })),
      photos: rounds.flatMap((r) => r.matches.flatMap((m) => m.photos || [])),
    };
    const nextHist = [entry, ...history];
    setHistory(nextHist);
    saveKey(K_HISTORY, nextHist, true);
    snapshotSession();
    setRounds([]);
    clearLock(); // end of session → passcode resets; next start sets a new one
    setTab("history");
  };

  const clearHistory = () => { setHistory([]); saveKey(K_HISTORY, [], true); };

  const backupJson = JSON.stringify(
    { app: "marina-smashers", version: "v3", exportedAt: new Date().toISOString(),
      session: { players, rounds }, history },
    null, 2
  );
  const copyBackup = async () => {
    try { await navigator.clipboard.writeText(backupJson); setDataMsg("Backup copied to clipboard \u2713"); }
    catch { setDataMsg("Couldn't auto-copy — tap the text below, select all, and copy."); }
  };
  const doRestore = () => ask(
    "Restore from backup?",
    "This replaces the current players, rounds, and history with the pasted backup.",
    () => {
      try {
        const d = JSON.parse(restoreText);
        if (d.history) { setHistory(d.history); saveKey(K_HISTORY, d.history, true); }
        if (d.session) { setPlayers(d.session.players || []); setRounds(d.session.rounds || []); }
        setRestoreText("");
        setDataMsg("Restored \u2713");
      } catch { setDataMsg("That doesn't look like valid backup text."); }
    }
  );
  const addPast = () => {
    if (!past.date.trim() || !past.champ.trim()) { setDataMsg("Add at least a date and a champion."); return; }
    const entry = {
      id: uid(), date: past.date.trim(), players: 0, rounds: 0, system: "prev",
      champ: { name: past.champ.trim(), points: Number(past.champPts) || 0 },
      spoon: past.spoon.trim() ? { name: past.spoon.trim(), points: Number(past.spoonPts) || 0 } : null,
    };
    const next = [entry, ...history];
    setHistory(next); saveKey(K_HISTORY, next, true);
    setPast({ date: "", champ: "", champPts: "", spoon: "", spoonPts: "" });
    setDataMsg("Past result added \u2713");
  };

  if (!loaded) {
    return (
      <div className="bd-wrap" data-theme={theme}>
        <style>{CSS}</style>
        <div className="bd-load">Loading scoreboard…</div>
      </div>
    );
  }

  const courtsThisWeek = activePlayers.length >= 4 ? Math.floor(activePlayers.length / 4) : 0;

  return (
    <div className="bd-wrap" data-theme={theme}>
      <style>{CSS}</style>

      <header className="bd-head">
        <div className="bd-brand">
          <span className="bd-logo"><img src="/logo.png" alt="Marina Smashers crest" /></span>
          <div className="bd-head-main">
            <h1 className="bd-title">Marina Smashers</h1>
            <div className="bd-head-right">
              {canInstall && (
                <button className="bd-iconbtn install" onClick={onInstallClick} aria-label="Install app" title="Install app">
                  <Download size={17} />
                </button>
              )}
              <button className={"bd-iconbtn" + (syncing ? " spin" : "")} onClick={reloadShared} aria-label="Sync latest scores" title="Pull the latest scores">
                <RefreshCw size={17} />
              </button>
              <button className="bd-iconbtn" onClick={toggleTheme} aria-label="Toggle theme" title="Light / dark">
                {theme === "dark" ? <Sun size={17} /> : <Moon size={17} />}
              </button>
              {lock ? (
                unlocked ? (
                  <button className="bd-iconbtn on" onClick={openLock} aria-label="You control edits" title="You're the scorekeeper — manage the passcode">
                    <LockOpen size={17} />
                  </button>
                ) : (
                  <button className="bd-iconbtn" onClick={openLock} aria-label="Enter passcode to edit" title="Enter the scorekeeper passcode to edit">
                    <Lock size={17} />
                  </button>
                )
              ) : (
                <button className="bd-iconbtn" onClick={openLock} aria-label="Set a session passcode" title="Set a passcode to control edits">
                  <KeyRound size={17} />
                </button>
              )}
            </div>
          </div>
        </div>
      </header>

      {lock && !unlocked && (
        <div className="bd-shared">
          <Lock size={12} />
          <span>Scores are view-only — anyone can add photos. Enter the passcode (lock icon) to edit scores.</span>
        </div>
      )}

      <main className="bd-main">
        {/* REGISTER */}
        {tab === "register" && (
          <section>
            <div className="bd-reg-top">
              <span className="bd-reg-h">Upcoming sessions</span>
              <button className="bd-iconbtn" onClick={shareSignup} aria-label="Share sign-up link to WhatsApp" title="Share sign-up link to WhatsApp">
                <Share2 size={18} />
              </button>
            </div>

            {myName && !nameEditing ? (
              <div className="bd-namecard">
                <span>Signing up as <b>{myName}</b></span>
                <button className="bd-mini" onClick={() => { setNameDraft(myName); setNameEditing(true); }}>Change</button>
              </div>
            ) : (
              <div className="bd-namecard editing">
                <input className="bd-input" placeholder="Your name" value={nameDraft} autoFocus
                  onChange={(e) => setNameDraft(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && nameDraft.trim() && saveMyName(nameDraft)} />
                <button className="bd-btn primary" disabled={!nameDraft.trim()} onClick={() => saveMyName(nameDraft)}>Save</button>
              </div>
            )}
            {regMsg && <p className={"bd-hint" + (regMsg.includes("\u2713") ? "" : " warn")} style={{ margin: "4px 2px 10px" }}>{regMsg}</p>}

            {sessionsToShow.map((sess) => {
              const open = openSession === sess.key;
              const mine = myName && sess.list.some((s) => s.name.toLowerCase() === myName.trim().toLowerCase());
              const ci = courtInfo(sess.list.length);
              const confirmedList = sess.list.slice(0, ci.confirmed);
              const waitList = sess.list.slice(ci.confirmed);
              const nextPos = sess.list.length + 1;
              const wouldWait = nextPos > (nextPos >= SECOND_COURT_AT ? 2 : 1) * COURT_CAP;
              const bk = bookings[sess.key] || {};
              return (
                <div key={sess.key} className="bd-reg-day">
                  <div className="bd-reg-head">
                    <button className="bd-reg-bar" onClick={() => { setOpenSession(open ? null : sess.key); setAddNameDraft(""); setRegMsg(""); }} aria-expanded={open}>
                      <span className="bd-reg-slot">{fmtDate(sess.date)} · {sess.time}</span>
                      <span className="bd-reg-right">
                        {sess.date === today && <span className="bd-today">Today</span>}
                        {(bk.booked || bk.photo) && <span className="bd-book-dot" title="Court booked">🎾</span>}
                        <span className="bd-reg-count"><Users size={12} /> {ci.confirmed}/{TOTAL_CAP}{ci.waitlisted ? ` +${ci.waitlisted}` : ""}</span>
                        {open ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
                      </span>
                    </button>
                    <button className={"bd-join" + (mine ? " in" : "")} onClick={() => toggleJoin(sess.date, sess.time)}>
                      {mine ? <><Check size={15} /> Going</> : (wouldWait ? "Waitlist" : "Join")}
                    </button>
                  </div>
                  {open && (
                    <>
                      <div className="bd-court-info">
                        {ci.courts} court{ci.courts > 1 ? "s" : ""} · {ci.confirmed}/{TOTAL_CAP} playing
                        {ci.waitlisted ? ` · ${ci.waitlisted} on waitlist` : ""}
                      </div>

                      {confirmedList.length ? (
                        <ol className="bd-reg-list">
                          {confirmedList.map((s, i) => (
                            <li key={s.id} className="bd-reg-item">
                              <span className="bd-reg-num">{i + 1}</span>
                              <span className="bd-reg-name">{s.name}</span>
                              <span className="bd-reg-when">{s.at ? fmtRegTime(s.at) : ""}</span>
                              <button onClick={() => removeSignup(s.id)} aria-label={"Remove " + s.name}><X size={14} /></button>
                            </li>
                          ))}
                        </ol>
                      ) : (
                        <p className="bd-reg-none">No one yet — tap Join, or add someone below.</p>
                      )}

                      {waitList.length > 0 && (
                        <>
                          <div className="bd-wait-label">Waitlist{sess.list.length < SECOND_COURT_AT ? ` · needs ${SECOND_COURT_AT} to open court 2` : ""}</div>
                          <ol className="bd-reg-list">
                            {waitList.map((s, i) => (
                              <li key={s.id} className="bd-reg-item wait">
                                <span className="bd-reg-num wait">{ci.confirmed + i + 1}</span>
                                <span className="bd-reg-name">{s.name}</span>
                                <span className="bd-reg-when">{s.at ? fmtRegTime(s.at) : ""}</span>
                                <button onClick={() => removeSignup(s.id)} aria-label={"Remove " + s.name}><X size={14} /></button>
                              </li>
                            ))}
                          </ol>
                        </>
                      )}

                      <div className="bd-addname">
                        <input className="bd-input" placeholder="Add someone else…" value={addNameDraft}
                          onChange={(e) => setAddNameDraft(e.target.value)}
                          onKeyDown={(e) => e.key === "Enter" && addOther(sess.date, sess.time)} />
                        <button className="bd-btn primary square" disabled={!addNameDraft.trim()} onClick={() => addOther(sess.date, sess.time)} aria-label="Add name">
                          <Plus size={18} />
                        </button>
                      </div>

                      <div className={"bd-booking" + (bk.booked || bk.photo ? " done" : "")}>
                        {bk.photo ? (
                          <>
                            <img src={bk.photo.url} alt="court booking" onClick={() => setLightbox(bk.photo.url)} />
                            <div className="bd-booking-txt">
                              <b>Court booked</b>
                              <span>Tap the screenshot to view</span>
                            </div>
                            <button className="bd-mini danger" onClick={() => clearBooking(sess.key)}>Clear</button>
                          </>
                        ) : (
                          <>
                            <div className="bd-booking-txt">
                              <b>{bk.booked ? "Court booked" : "Court not booked yet"}</b>
                              <span>{bk.booked ? "Add the confirmation screenshot" : "Reminder: book the court and save the screenshot"}</span>
                            </div>
                            <label className={"bd-btn ghost" + (bookingBusy === sess.key ? " busy" : "")}>
                              {bookingBusy === sess.key ? <RefreshCw size={15} /> : <Camera size={15} />} Screenshot
                              <input type="file" accept="image/*" hidden
                                onChange={(e) => { uploadBooking(sess.key, e.target.files[0]); e.target.value = ""; }} />
                            </label>
                            <button className="bd-mini" onClick={() => toggleBooked(sess.key)}>{bk.booked ? "Undo" : "Mark booked"}</button>
                          </>
                        )}
                      </div>
                    </>
                  )}
                </div>
              );
            })}

            <button className="bd-btn ghost wide" onClick={() => { setAddTimeOpen((v) => !v); setRegMsg(""); }}>
              <Plus size={15} /> Add a one-off session {addTimeOpen ? "▲" : "▼"}
            </button>
            {addTimeOpen && (
              <div className="bd-reg-form" style={{ marginTop: 10 }}>
                <div className="bd-reg-row">
                  <label>Date
                    <input type="date" className="bd-input" value={reg.date}
                      onChange={(e) => setReg({ ...reg, date: e.target.value })} />
                  </label>
                  <label>Start time
                    <div className="bd-timepick">
                      <select className="bd-input" value={reg.hour} onChange={(e) => setReg({ ...reg, hour: e.target.value })}>
                        {Array.from({ length: 12 }, (_, i) => String(i + 1)).map((h) => <option key={h} value={h}>{h}</option>)}
                      </select>
                      <select className="bd-input" value={reg.ap} onChange={(e) => setReg({ ...reg, ap: e.target.value })}>
                        <option value="AM">AM</option>
                        <option value="PM">PM</option>
                      </select>
                    </div>
                  </label>
                </div>
                <button className="bd-btn primary wide" onClick={addOneOff}>
                  <CalendarCheck size={16} /> {myName ? `Add me (${myName})` : "Add your name first"}
                </button>
              </div>
            )}
          </section>
        )}

        {/* PLAYERS */}
        {tab === "players" && (
          <section>
            {canEdit && (
              <div className="bd-add">
                <input
                  ref={nameRef}
                  className="bd-input"
                  placeholder="Add a player…"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && addPlayer()}
                />
                <button className="bd-btn primary square" onClick={addPlayer} aria-label="Add player">
                  <UserPlus size={18} />
                </button>
              </div>
            )}

            {todaySignups.length > 0 && (
              <div className="bd-signedup">
                <div className="bd-signedup-head">
                  <span><CalendarCheck size={14} /> Signed up for today</span>
                  {canEdit && <button className="bd-mini" onClick={addAllRegistered}>Add all</button>}
                </div>
                <div className="bd-signedup-chips">
                  {todaySignups.map((s) => {
                    const inRoster = players.some((p) => p.name.toLowerCase() === s.name.toLowerCase());
                    return (
                      <button
                        key={s.id}
                        className={"bd-suchip" + (inRoster ? " in" : "")}
                        disabled={!canEdit || inRoster}
                        onClick={() => addRegisteredName(s.name)}
                        title={s.time}
                      >
                        {inRoster ? <Check size={13} /> : <Plus size={13} />} {s.name}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            {players.length === 0 ? (
              <div className="bd-empty">
                <Feather size={30} strokeWidth={1.6} />
                <p>Who's playing today?</p>
                {canEdit ? (
                  <>
                    <span>Add everyone who showed up — 4 or more to get going.</span>
                    <button className="bd-btn ghost" onClick={loadLast}>
                      <RotateCw size={15} /> Load last week's players
                    </button>
                    {prevSnap && (prevSnap.players?.length || prevSnap.rounds?.length) ? (
                      <button className="bd-btn primary" onClick={restorePrev}>
                        <RotateCw size={15} /> Restore previous session ({fmtWhen(prevSnap.at)})
                      </button>
                    ) : null}
                  </>
                ) : (
                  <span>The match organiser hasn't added players yet.</span>
                )}
              </div>
            ) : (
              <>
                <ul className="bd-roster">
                  {activePlayers.map((p, i) => (
                    <li key={p.id} className="bd-chip">
                      <span className="bd-chip-num">{i + 1}</span>
                      <span className="bd-chip-name">{p.name}</span>
                      {canEdit && (
                        <button onClick={() => removePlayer(p.id)} aria-label={"Remove " + p.name}>
                          <X size={15} />
                        </button>
                      )}
                    </li>
                  ))}
                </ul>

                {leftPlayers.length > 0 && (
                  <div className="bd-leftgroup">
                    <span className="bd-leftgroup-label">Left — their finished games are kept</span>
                    <ul className="bd-roster">
                      {leftPlayers.map((p) => (
                        <li key={p.id} className="bd-chip gone">
                          <span className="bd-chip-name">{p.name}</span>
                          {canEdit && (
                            <button onClick={() => rejoinPlayer(p.id)} aria-label={"Bring back " + p.name} title="Bring back">
                              <RotateCw size={14} />
                            </button>
                          )}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                <div className="bd-plan">
                  {activePlayers.length < 4 ? (
                    <p className="bd-hint warn">Add {4 - activePlayers.length} more to start doubles.</p>
                  ) : (
                    <p className="bd-hint">
                      {courtsThisWeek} court{courtsThisWeek > 1 ? "s" : ""} in play
                      {activePlayers.length % 4 !== 0 && ` · ${activePlayers.length % 4} resting each round`}
                    </p>
                  )}
                  {canEdit && (
                    <div className="bd-plan-actions">
                      <button className="bd-btn primary" disabled={activePlayers.length < 4} onClick={addRound}>
                        <Play size={16} /> {rounds.length ? "New round" : "Start playing"}
                      </button>
                      <button
                        className="bd-btn ghost danger"
                        onClick={() => ask("Clear all players?", "This also clears the current rounds and resets the session passcode. History is kept, and you can undo this.", clearAllPlayers)}
                      >
                        <Trash2 size={15} /> Clear all
                      </button>
                    </div>
                  )}
                </div>
              </>
            )}
          </section>
        )}

        {/* MATCHES */}
        {tab === "matches" && (
          <section>
            {leader && (
              <div className="bd-leadbar">
                <Crown size={15} /> <strong>{leader.name}</strong> leads on <b>{leader.points}</b> pts
              </div>
            )}
            {rounds.length === 0 ? (
              <div className="bd-empty">
                <Play size={30} strokeWidth={1.6} />
                <p>No rounds yet</p>
                {canEdit ? (
                  <>
                    <span>Generate a round and fresh partners are drawn automatically.</span>
                    <button className="bd-btn primary" disabled={activePlayers.length < 4} onClick={addRound}>
                      <Play size={16} /> {activePlayers.length < 4 ? "Add 4+ players first" : "Generate round 1"}
                    </button>
                  </>
                ) : (
                  <span>No games have been started yet. Tap ⟳ to refresh.</span>
                )}
              </div>
            ) : (
              <>
                {rounds.map((r, rIdx) => (
                  <div key={r.id} className="bd-round">
                    <div className="bd-round-head">
                      <h2>Round {rIdx + 1}</h2>
                      {canEdit && (
                        <div className="bd-round-tools">
                          {rIdx === rounds.length - 1 && (
                            <button className="bd-mini" onClick={() => rerollRound(rIdx)}>
                              <RotateCw size={13} /> Reroll
                            </button>
                          )}
                          <button
                            className="bd-mini danger"
                            onClick={() => ask("Delete round " + (rIdx + 1) + "?", "Its scores will be removed.", () => deleteRound(rIdx))}
                          >
                            <Trash2 size={13} />
                          </button>
                        </div>
                      )}
                    </div>

                    {r.matches.map((m, mIdx) => {
                      const na = m.scoreA === "" ? null : Number(m.scoreA);
                      const nb = m.scoreB === "" ? null : Number(m.scoreB);
                      const done = na != null && nb != null;
                      const aWin = done && na > nb;
                      const bWin = done && nb > na;
                      const draw = done && na === nb;
                      const chip = (win) => win ? ["+2", "win"] : draw ? ["+1", "draw"] : ["0", "loss"];
                      return (
                        <div key={mIdx} className="bd-court">
                          <span className="bd-court-tag">Court {mIdx + 1}</span>
                          <div className="bd-net">
                            <div className={"bd-side" + (aWin ? " win" : draw ? " draw" : "")}>
                              {m.teamA.map((id) => <span key={id} className="bd-pl">{nameOf(id)}</span>)}
                              <input className="bd-score" inputMode="numeric" placeholder="–" readOnly={!canEdit}
                                value={m.scoreA} onChange={(e) => setScore(rIdx, mIdx, "A", e.target.value)} />
                              {done && <span className={"bd-pts " + chip(aWin)[1]}>{chip(aWin)[0]}</span>}
                            </div>
                            <div className="bd-vs">vs</div>
                            <div className={"bd-side" + (bWin ? " win" : draw ? " draw" : "")}>
                              {m.teamB.map((id) => <span key={id} className="bd-pl">{nameOf(id)}</span>)}
                              <input className="bd-score" inputMode="numeric" placeholder="–" readOnly={!canEdit}
                                value={m.scoreB} onChange={(e) => setScore(rIdx, mIdx, "B", e.target.value)} />
                              {done && <span className={"bd-pts " + chip(bWin)[1]}>{chip(bWin)[0]}</span>}
                            </div>
                          </div>

                          <div className="bd-photos">
                            {(m.photos || []).map((ph, pIdx) => (
                              <div key={pIdx} className="bd-thumb">
                                <img src={ph.url} alt="match" onClick={() => setLightbox(ph.url)} />
                                <button className="bd-thumb-x" onClick={() => removePhoto(rIdx, mIdx, pIdx)} aria-label="Remove photo">
                                  <X size={12} />
                                </button>
                              </div>
                            ))}
                            {(m.photos || []).length < MAX_PHOTOS && (
                              <label className={"bd-addphoto" + (uploadingKey === rIdx + "-" + mIdx ? " busy" : "")}>
                                {uploadingKey === rIdx + "-" + mIdx ? <RefreshCw size={16} /> : <Camera size={16} />}
                                <input type="file" accept="image/*" capture="environment" hidden
                                  onChange={(e) => { addPhoto(rIdx, mIdx, e.target.files[0]); e.target.value = ""; }} />
                              </label>
                            )}
                          </div>
                        </div>
                      );
                    })}

                    {r.resting.length > 0 && (
                      <div className="bd-rest">
                        <span>Resting</span>
                        {r.resting.map((id) => <em key={id}>{nameOf(id)}</em>)}
                      </div>
                    )}
                  </div>
                ))}

                {canEdit && (
                  <button className="bd-btn primary wide" onClick={addRound}>
                    <Plus size={16} /> New round
                  </button>
                )}
              </>
            )}
          </section>
        )}

        {/* STANDINGS */}
        {tab === "board" && (
          <section>
            {!anyScores ? (
              <div className="bd-empty">
                <Trophy size={30} strokeWidth={1.6} />
                <p>No scores yet</p>
                <span>Enter match scores and the leaderboard fills in live.</span>
              </div>
            ) : (
              <>
                <div className="bd-podium">
                  {(() => {
                    const champ = ranked.find((r) => r.decided > 0 && r.points === maxPts);
                    const spoon = [...ranked].reverse().find((r) => r.decided > 0 && r.points === minPts);
                    return (
                      <>
                        <div className="bd-award champ">
                          <Crown size={18} />
                          <div><span className="bd-award-l">Top of the day</span><strong>{champ?.name}</strong></div>
                          <b>{champ?.points}</b>
                        </div>
                        {spoon && spoon.id !== champ?.id && (
                          <div className="bd-award spoon">
                            <Utensils size={16} />
                            <div><span className="bd-award-l">Wooden spoon</span><strong>{spoon?.name}</strong></div>
                            <b>{spoon?.points}</b>
                          </div>
                        )}
                      </>
                    );
                  })()}
                </div>

                <p className="bd-scorekey">2 pts win · 1 drawn · 0 loss — ties broken on point difference</p>
                <div className="bd-table">
                  <div className="bd-tr bd-th">
                    <span className="c-rank">#</span>
                    <span className="c-name">Player</span>
                    <span className="c-num">Pts</span>
                    <span className="c-num">+/−</span>
                  </div>
                  {ranked.map((r, i) => {
                    const isChamp = r.decided > 0 && r.points === maxPts;
                    const isSpoon = r.decided > 0 && r.points === minPts && !isChamp;
                    const diffStr = (r.diff > 0 ? "+" : "") + r.diff;
                    return (
                      <div key={r.id} className={"bd-tr" + (isChamp ? " champ" : "") + (isSpoon ? " spoon" : "")}>
                        <span className="c-rank">{isChamp ? <Crown size={14} /> : i + 1}</span>
                        <span className="c-name">
                          <span className="nm">{r.name}</span>
                          <span className="rec">{r.decided > 0 ? `${r.wins}W · ${r.draws}D · ${r.losses}L` : "—"}</span>
                        </span>
                        <span className="c-num strong">{r.points}</span>
                        <span className="c-num muted">{r.decided > 0 ? diffStr : "–"}</span>
                      </div>
                    );
                  })}
                </div>

                <div className="bd-cta-row">
                  {canEdit && (
                    <button
                      className="bd-btn primary"
                      onClick={() => ask("Close this session?", "Saves this week's full standings to History and clears the rounds. Players stay.", finishWeek)}
                    >
                      <Check size={16} /> Close session
                    </button>
                  )}
                  <button className="bd-iconbtn" onClick={shareStandings} aria-label="Share results to WhatsApp" title="Share results to WhatsApp">
                    <Share2 size={18} />
                  </button>
                </div>
              </>
            )}
          </section>
        )}

        {/* HISTORY */}
        {tab === "history" && (
          <section>
            {history.length === 0 ? (
              <div className="bd-empty">
                <Calendar size={30} strokeWidth={1.6} />
                <p>No saved weeks yet</p>
                <span>Finish a week from Standings and it lands here.</span>
              </div>
            ) : (
              <>
                {history.map((h) => {
                  const open = openWeek === h.id;
                  const hasTable = Array.isArray(h.standings) && h.standings.length > 0;
                  return (
                    <div key={h.id} className="bd-hcard">
                      <button
                        className="bd-hhead"
                        onClick={() => setOpenWeek(open ? null : h.id)}
                        aria-expanded={open}
                      >
                        <div className="bd-hdate">
                          <Calendar size={14} />{h.date}
                          <span className="bd-hmeta">
                            {h.system && h.system !== "2/1/0"
                              ? "previous scoring"
                              : `${h.players} players · ${h.rounds} rounds`}
                          </span>
                        </div>
                        {(hasTable || (h.photos && h.photos.length > 0)) && (open ? <ChevronUp size={16} /> : <ChevronDown size={16} />)}
                      </button>

                      <div className="bd-hrows">
                        {h.champ && (
                          <div className="bd-hrow champ"><Crown size={15} /><strong>{h.champ.name}</strong><b>{h.champ.points} pts</b></div>
                        )}
                        {h.spoon && (
                          <div className="bd-hrow spoon"><Utensils size={14} /><strong>{h.spoon.name}</strong><b>{h.spoon.points} pts</b></div>
                        )}
                      </div>

                      {open && hasTable && (
                        <div className="bd-htable">
                          <div className="bd-htr bd-hth">
                            <span className="c-rank">#</span>
                            <span>Player</span>
                            <span className="c-num">Pts</span>
                            <span className="c-num">+/−</span>
                          </div>
                          {h.standings.map((s, i) => (
                            <div key={i} className="bd-htr">
                              <span className="c-rank">{i + 1}</span>
                              <span className="bd-hname">
                                <span className="nm">{s.name}</span>
                                <span className="rec">{s.wins}W · {s.draws}D · {s.losses}L</span>
                              </span>
                              <span className="c-num strong">{s.points}</span>
                              <span className="c-num muted">{(s.diff > 0 ? "+" : "") + s.diff}</span>
                            </div>
                          ))}
                        </div>
                      )}
                      {open && !hasTable && (
                        <p className="bd-data-note" style={{ marginTop: 8 }}>Full standings weren't saved for this week.</p>
                      )}
                      {open && h.photos && h.photos.length > 0 && (
                        <div className="bd-gallery">
                          {h.photos.map((ph, i) => (
                            <img key={i} src={ph.url} alt="match" onClick={() => setLightbox(ph.url)} />
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
                {canEdit && (
                  <button
                    className="bd-btn ghost danger"
                    onClick={() => ask("Clear all history?", "Every saved week will be removed for the whole group.", clearHistory)}
                  >
                    <Trash2 size={15} /> Clear history
                  </button>
                )}
              </>
            )}

            {canEdit && (
              <button className="bd-btn ghost wide" onClick={() => setDataOpen((v) => !v)}>
                <Save size={15} /> Backup & restore {dataOpen ? "▲" : "▼"}
              </button>
            )}

            {canEdit && dataOpen && (
              <div className="bd-data">
                {prevSnap && (prevSnap.players?.length || prevSnap.rounds?.length) ? (
                  <>
                    <h4 style={{ marginTop: 4 }}>Undo</h4>
                    <p className="bd-data-note">One-tap restore of the session as it was just before your last clear / finish / delete.</p>
                    <button className="bd-btn primary" onClick={restorePrev}>
                      <RotateCw size={15} /> Restore previous session ({fmtWhen(prevSnap.at)})
                    </button>
                  </>
                ) : null}

                <p className="bd-data-note">
                  Copy this backup somewhere safe before big changes, and never <em>Unpublish</em> or delete
                  the Supabase project — free-tier data has no automatic backup.
                </p>

                <h4>Backup</h4>
                <textarea className="bd-ta" readOnly value={backupJson} onFocus={(e) => e.target.select()} />
                <button className="bd-btn primary" onClick={copyBackup}><ClipboardCopy size={15} /> Copy backup</button>

                <h4>Restore from a backup</h4>
                <textarea className="bd-ta" placeholder="Paste backup text here…"
                  value={restoreText} onChange={(e) => setRestoreText(e.target.value)} />
                <button className="bd-btn ghost" disabled={!restoreText.trim()} onClick={doRestore}>
                  <RotateCw size={15} /> Restore
                </button>

                <h4>Add a past result by hand</h4>
                <p className="bd-data-note">For last week's result from the old scoring, or any week played before this app.</p>
                <div className="bd-past">
                  <input className="bd-input" placeholder="Date (e.g. 27 Jul 2026)"
                    value={past.date} onChange={(e) => setPast({ ...past, date: e.target.value })} />
                  <div className="bd-past-row">
                    <input className="bd-input" placeholder="Champion"
                      value={past.champ} onChange={(e) => setPast({ ...past, champ: e.target.value })} />
                    <input className="bd-input pts" inputMode="numeric" placeholder="pts"
                      value={past.champPts} onChange={(e) => setPast({ ...past, champPts: e.target.value.replace(/[^\d]/g, "") })} />
                  </div>
                  <div className="bd-past-row">
                    <input className="bd-input" placeholder="Wooden spoon (optional)"
                      value={past.spoon} onChange={(e) => setPast({ ...past, spoon: e.target.value })} />
                    <input className="bd-input pts" inputMode="numeric" placeholder="pts"
                      value={past.spoonPts} onChange={(e) => setPast({ ...past, spoonPts: e.target.value.replace(/[^\d]/g, "") })} />
                  </div>
                  <button className="bd-btn primary" onClick={addPast}><Plus size={15} /> Add past result</button>
                </div>

                {dataMsg && <p className="bd-datamsg">{dataMsg}</p>}
              </div>
            )}
          </section>
        )}
      </main>

      <nav className="bd-tabs">
        {[
          ["register", "Register", CalendarCheck],
          ["players", "Players", Users],
          ["matches", "Matches", Play],
          ["board", "Standings", Trophy],
          ["history", "History", Calendar],
        ].map(([id, label, Icon]) => (
          <button key={id} className={"bd-tab" + (tab === id ? " on" : "")} onClick={() => setTab(id)}>
            <Icon size={17} strokeWidth={2.2} />
            <span>{label}</span>
          </button>
        ))}
      </nav>

      {confirm && (
        <div className="bd-modal-bg" onClick={() => setConfirm(null)}>
          <div className="bd-modal" onClick={(e) => e.stopPropagation()}>
            <div className="bd-modal-ic"><AlertTriangle size={20} /></div>
            <h3>{confirm.message}</h3>
            {confirm.detail && <p>{confirm.detail}</p>}
            <div className="bd-modal-actions">
              <button className="bd-btn ghost" onClick={() => setConfirm(null)}>Cancel</button>
              <button className="bd-btn danger-solid" onClick={() => { confirm.onYes(); setConfirm(null); }}>
                Yes, do it
              </button>
            </div>
          </div>
        </div>
      )}

      {lockModal && (
        <div className="bd-modal-bg" onClick={() => { setLockModal(null); setPass(""); setPassErr(""); }}>
          <div className="bd-modal" onClick={(e) => e.stopPropagation()}>
            <div className="bd-modal-ic" style={{ background: "var(--panel-2)", color: "var(--accent)" }}>
              {lockModal === "enter" ? <Lock size={20} /> : <KeyRound size={20} />}
            </div>

            {lockModal === "manage" ? (
              <>
                <h3>You're the scorekeeper</h3>
                <p>You set this session's passcode, so you control the scores. Share the code with whoever's keeping score today.</p>
                <div className="bd-lockbtns">
                  <button className="bd-btn ghost" onClick={() => { setPass(""); setPassErr(""); setLockModal("set"); }}>
                    <KeyRound size={15} /> Change passcode
                  </button>
                  <button className="bd-btn ghost" onClick={lockThisDevice}>
                    <Lock size={15} /> Lock this device
                  </button>
                  <button className="bd-btn ghost danger" onClick={() => { setLockModal(null); clearLock(); }}>
                    <LockOpen size={15} /> Remove passcode (open to all)
                  </button>
                </div>
                <div className="bd-modal-actions">
                  <button className="bd-btn ghost" onClick={() => setLockModal(null)}>Close</button>
                </div>
              </>
            ) : (
              <>
                <h3>
                  {lockModal === "enter" ? "Enter passcode to edit"
                    : lockModal === "start" ? "Set a passcode to start"
                    : lock ? "Change the passcode" : "Set a session passcode"}
                </h3>
                <p>
                  {lockModal === "enter"
                    ? "Ask today's scorekeeper for the code."
                    : "Whoever sets this controls the scores for this session. It resets when you close the week."}
                </p>
                <input
                  className={"bd-input" + (passErr ? " err" : "")}
                  type="password"
                  placeholder="Passcode"
                  value={pass}
                  autoFocus
                  onChange={(e) => { setPass(e.target.value); setPassErr(""); }}
                  onKeyDown={(e) => {
                    if (e.key !== "Enter") return;
                    if (lockModal === "enter") enterPasscode(pass);
                    else applyPasscode(pass).then((ok) => { if (ok) { if (lockModal === "start") doStart(); setLockModal(null); } });
                  }}
                  style={{ textAlign: "center", marginBottom: passErr ? 6 : 14 }}
                />
                {passErr && <p style={{ color: "var(--clay)", margin: "0 0 12px", fontSize: 13 }}>{passErr}</p>}
                <div className="bd-modal-actions">
                  {lockModal === "start" ? (
                    <button className="bd-btn ghost" onClick={() => { setLockModal(null); doStart(); }}>Start without one</button>
                  ) : (
                    <button className="bd-btn ghost" onClick={() => { setLockModal(null); setPass(""); setPassErr(""); }}>Cancel</button>
                  )}
                  <button
                    className="bd-btn primary"
                    onClick={() => {
                      if (lockModal === "enter") enterPasscode(pass);
                      else applyPasscode(pass).then((ok) => { if (ok) { if (lockModal === "start") doStart(); setLockModal(null); } });
                    }}
                  >
                    {lockModal === "enter" ? "Unlock" : lockModal === "start" ? "Set & start" : "Save"}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {lightbox && (
        <div className="bd-lightbox" onClick={() => setLightbox(null)}>
          <button className="bd-lightbox-x" aria-label="Close"><X size={22} /></button>
          <img src={lightbox} alt="match" onClick={(e) => e.stopPropagation()} />
        </div>
      )}
      {installHintOpen && (
        <div className="bd-modal-bg" onClick={() => setInstallHintOpen(false)}>
          <div className="bd-modal" onClick={(e) => e.stopPropagation()}>
            <div className="bd-modal-ic" style={{ background: "var(--panel-2)", color: "var(--accent)" }}><Download size={20} /></div>
            <h3>Install Marina Smashers</h3>
            <p>On iPhone, add it to your home screen in two taps:</p>
            <ol style={{ textAlign: "left", margin: "0 0 16px", paddingLeft: 20, color: "var(--soft)", fontSize: 14, lineHeight: 1.7 }}>
              <li>Tap the <b>Share</b> button <Share size={13} style={{ verticalAlign: "-2px" }} /> at the bottom of Safari.</li>
              <li>Choose <b>Add to Home Screen</b>.</li>
              <li>Tap <b>Add</b> — done.</li>
            </ol>
            <p style={{ fontSize: 12, color: "var(--muted)" }}>Make sure you're in Safari (not inside another app's browser).</p>
            <div className="bd-modal-actions">
              <button className="bd-btn primary" onClick={() => setInstallHintOpen(false)}>Got it</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/* ---------------- styles ---------------- */

const CSS = `
@import url('https://fonts.googleapis.com/css2?family=Barlow+Semi+Condensed:wght@500;600;700&family=Inter:wght@400;500;600&display=swap');

.bd-wrap[data-theme="dark"]{
  --bg:#121815; --panel:#1b241f; --panel-2:#222d27; --ink:#eef3ee; --soft:#aebbb2;
  --muted:#748379; --line:#2c3a32; --accent:#2bd08a; --accent-d:#25b478; --on-accent:#0b1f16;
  --gold:#f3c451; --gold-bg:rgba(243,196,81,.15); --gold-tx:#f3c451;
  --clay:#ef8a5f; --clay-bg:rgba(239,138,95,.16); --clay-tx:#f0996f;
  --net:#3a4a41; --focus:rgba(43,208,138,.30); --score-bg:#121815;
}
.bd-wrap[data-theme="light"]{
  --bg:#e6ece7; --panel:#ffffff; --panel-2:#f2f6f2; --ink:#16302a; --soft:#4c5f58;
  --muted:#8a9a92; --line:#dbe4dd; --accent:#12855c; --accent-d:#0d6b4a; --on-accent:#ffffff;
  --gold:#d99400; --gold-bg:#fbf1d3; --gold-tx:#8a6100;
  --clay:#c05a37; --clay-bg:#f7e6dd; --clay-tx:#8f3f22;
  --net:#b7c6bd; --focus:rgba(18,133,92,.15); --score-bg:#e6ece7;
}
.bd-wrap{
  font-family:'Inter',system-ui,sans-serif;
  background:var(--bg); color:var(--ink);
  min-height:100vh; width:100%; -webkit-font-smoothing:antialiased;
  transition:background .25s,color .25s;
  padding-top:env(safe-area-inset-top);
  padding-left:env(safe-area-inset-left);
  padding-right:env(safe-area-inset-right);
  padding-bottom:env(safe-area-inset-bottom);
}
.bd-wrap *{box-sizing:border-box;}
.bd-load{padding:70px 20px;text-align:center;color:var(--muted);}

.bd-head{max-width:640px;margin:0 auto;padding:16px 16px 8px;}
.bd-brand{display:flex;align-items:stretch;gap:14px;min-width:0;}
.bd-logo{width:76px;height:76px;border-radius:16px;overflow:hidden;background:transparent;display:flex;align-items:center;justify-content:center;flex-shrink:0;box-shadow:0 1px 5px rgba(0,0,0,.2);}
.bd-logo img{width:100%;height:100%;object-fit:cover;display:block;}
.bd-head-main{flex:1;min-width:0;display:flex;flex-direction:column;justify-content:center;align-items:center;gap:11px;}
.bd-title{font-family:'Barlow Semi Condensed',sans-serif;font-weight:700;font-size:30px;letter-spacing:.4px;margin:0;line-height:.95;text-transform:uppercase;color:var(--ink);text-align:center;}
.bd-head-right{display:flex;align-items:center;justify-content:center;gap:8px;flex-wrap:wrap;}
.bd-pill{font-family:'Barlow Semi Condensed',sans-serif;font-weight:700;font-size:15px;background:var(--panel);border:1.5px solid var(--line);color:var(--accent);padding:7px 12px;border-radius:10px;}
.bd-pill i{font-style:normal;color:var(--muted);font-weight:600;font-size:11px;text-transform:uppercase;}
.bd-iconbtn{width:40px;height:40px;border-radius:11px;border:1.5px solid var(--line);background:var(--panel);color:var(--soft);display:flex;align-items:center;justify-content:center;cursor:pointer;transition:.15s;}
.bd-iconbtn svg{width:19px;height:19px;}
.bd-iconbtn:hover{color:var(--accent);border-color:var(--accent);}
.bd-iconbtn.spin svg{animation:bd-spin .7s linear;}
.bd-iconbtn.on{background:var(--accent);color:var(--on-accent);border-color:var(--accent);}
.bd-iconbtn.install{border-color:var(--accent);color:var(--accent);}
.bd-input.err{border-color:var(--clay);box-shadow:0 0 0 3px var(--clay-bg);}
@keyframes bd-spin{to{transform:rotate(360deg);}}

.bd-shared{max-width:640px;margin:0 auto;display:flex;align-items:center;gap:7px;padding:7px 16px;color:var(--muted);font-size:11.5px;}
.bd-shared svg{flex-shrink:0;color:var(--accent);}

.bd-tabs{position:fixed;bottom:0;left:0;right:0;display:flex;gap:5px;padding:6px 10px calc(6px + env(safe-area-inset-bottom));max-width:640px;margin:0 auto;background:var(--bg);border-top:1.5px solid var(--line);z-index:20;}
.bd-tab{flex:1;display:flex;flex-direction:column;align-items:center;gap:4px;padding:9px 4px;border:none;background:transparent;cursor:pointer;color:var(--muted);font-size:11px;font-weight:600;font-family:inherit;border-radius:11px;transition:.15s;}
.bd-tab.on{color:var(--accent);background:var(--focus);font-weight:700;box-shadow:inset 0 -2.5px 0 var(--accent);}
.bd-tab.on svg{stroke-width:2.6;}
.bd-tab:hover:not(.on){color:var(--soft);background:var(--panel);}

.bd-main{max-width:640px;margin:0 auto;padding:16px 14px calc(84px + env(safe-area-inset-bottom));}
.bd-install{max-width:640px;margin:0 auto 4px;display:flex;align-items:center;gap:11px;background:var(--panel);border:1.5px solid var(--accent);border-radius:14px;padding:10px 12px;}
.bd-install-icon{width:40px;height:40px;border-radius:10px;flex-shrink:0;}
.bd-install-txt{flex:1;display:flex;flex-direction:column;min-width:0;line-height:1.3;}
.bd-install-txt b{font-size:14px;}
.bd-install-txt span{font-size:12px;color:var(--soft);display:flex;align-items:center;gap:4px;flex-wrap:wrap;}
.bd-install-txt span b{display:inline;font-size:12px;color:var(--ink);}
.bd-install .bd-btn{flex-shrink:0;padding:9px 14px;}
.bd-install-x{flex-shrink:0;border:none;background:transparent;color:var(--muted);cursor:pointer;padding:4px;border-radius:6px;display:flex;}
.bd-install-x:hover{color:var(--ink);background:var(--panel-2);}

.bd-add{display:flex;gap:8px;margin-bottom:16px;}
.bd-input{flex:1;padding:12px 14px;border:1.5px solid var(--line);border-radius:12px;background:var(--panel);font-size:15px;font-family:inherit;color:var(--ink);outline:none;transition:.15s;}
.bd-input::placeholder{color:var(--muted);}
.bd-input:focus{border-color:var(--accent);box-shadow:0 0 0 3px var(--focus);}

.bd-btn{display:inline-flex;align-items:center;justify-content:center;gap:7px;border:none;border-radius:12px;padding:11px 16px;font-size:14px;font-weight:600;font-family:inherit;cursor:pointer;transition:.15s;}
.bd-btn.square{padding:11px;}
.bd-btn.wide{width:100%;margin-top:6px;}
.bd-btn.primary{background:var(--accent);color:var(--on-accent);}
.bd-btn.primary:hover{background:var(--accent-d);}
.bd-btn.primary:disabled{opacity:.45;cursor:not-allowed;}
.bd-btn.ghost{background:transparent;color:var(--soft);border:1.5px solid var(--line);}
.bd-btn.ghost:hover{border-color:var(--muted);}
.bd-btn.ghost.danger{color:var(--clay);border-color:var(--clay-bg);}
.bd-btn.ghost.danger:hover{background:var(--clay-bg);}
.bd-btn.danger-solid{background:var(--clay);color:#fff;}
.bd-cta-row{display:flex;align-items:center;gap:8px;justify-content:flex-end;margin-top:6px;}
.bd-cta-row .bd-btn{flex:1;margin-top:0;}

.bd-empty{text-align:center;padding:44px 20px;color:var(--muted);display:flex;flex-direction:column;align-items:center;gap:8px;}
.bd-empty p{font-family:'Barlow Semi Condensed',sans-serif;font-weight:600;font-size:19px;color:var(--ink);margin:6px 0 0;}
.bd-empty span{font-size:13px;max-width:280px;line-height:1.5;}
.bd-empty .bd-btn{margin-top:12px;}

.bd-roster{list-style:none;margin:0;padding:0;display:flex;flex-wrap:wrap;gap:8px;}
.bd-chip{display:flex;align-items:center;gap:8px;background:var(--panel);border:1.5px solid var(--line);border-radius:11px;padding:7px 9px 7px 8px;}
.bd-chip-num{font-family:'Barlow Semi Condensed',sans-serif;font-weight:700;font-size:12px;color:var(--on-accent);background:var(--accent);width:20px;height:20px;border-radius:6px;display:flex;align-items:center;justify-content:center;}
.bd-chip-name{font-size:14px;font-weight:500;}
.bd-chip button{border:none;background:transparent;color:var(--muted);cursor:pointer;display:flex;padding:2px;border-radius:5px;}
.bd-chip button:hover{color:var(--clay);background:var(--clay-bg);}
.bd-leftgroup{margin-top:14px;}
.bd-leftgroup-label{display:block;font-size:11px;text-transform:uppercase;letter-spacing:.6px;color:var(--muted);font-weight:600;margin-bottom:8px;}
.bd-chip.gone{opacity:.6;border-style:dashed;}
.bd-chip.gone .bd-chip-name{text-decoration:line-through;color:var(--muted);}
.bd-chip.gone button:hover{color:var(--accent);background:transparent;}

.bd-plan{margin-top:20px;padding-top:16px;border-top:1.5px dashed var(--line);}
.bd-plan-actions{display:flex;gap:8px;margin-top:12px;flex-wrap:wrap;}
.bd-hint{font-size:13px;color:var(--soft);margin:0;}

.bd-reg-form{background:var(--panel);border:1.5px solid var(--line);border-radius:14px;padding:14px;margin-bottom:16px;}
.bd-reg-row{display:flex;gap:10px;margin-bottom:10px;}
.bd-reg-row label{flex:1;display:flex;flex-direction:column;gap:5px;font-size:11px;text-transform:uppercase;letter-spacing:.5px;color:var(--muted);font-weight:600;}
.bd-reg-form .bd-input{margin-bottom:0;}
.bd-reg-form>.bd-input{margin-bottom:10px;width:100%;}
.bd-reg-form .bd-btn{margin-top:2px;}
.bd-timepick{display:flex;gap:8px;}
.bd-timepick select{flex:1;cursor:pointer;}
.bd-reg-day{background:var(--panel);border:1.5px solid var(--line);border-radius:14px;padding:4px 14px 6px;margin-bottom:12px;}
.bd-reg-date{display:flex;align-items:center;gap:8px;font-family:'Barlow Semi Condensed',sans-serif;font-weight:700;font-size:15px;text-transform:uppercase;letter-spacing:.5px;padding:10px 0 8px;border-bottom:1.5px solid var(--line);}
.bd-reg-bar{display:flex;align-items:center;gap:8px;width:100%;background:none;border:none;margin:0;padding:12px 2px;cursor:pointer;color:var(--ink);font-family:'Barlow Semi Condensed',sans-serif;font-weight:700;font-size:15px;text-transform:uppercase;letter-spacing:.5px;}
.bd-reg-top{display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;}
.bd-reg-h{font-family:'Barlow Semi Condensed',sans-serif;font-weight:700;font-size:18px;text-transform:uppercase;letter-spacing:.5px;}
.bd-namecard{display:flex;align-items:center;justify-content:space-between;gap:10px;background:var(--panel);border:1.5px solid var(--line);border-radius:12px;padding:11px 13px;margin-bottom:30px;font-size:14px;}
.bd-namecard.editing{gap:8px;}
.bd-namecard.editing .bd-input{flex:1;margin:0;}
.bd-namecard .bd-btn{flex-shrink:0;}
.bd-reg-head{display:flex;align-items:center;gap:8px;}
.bd-reg-head .bd-reg-bar{flex:1;}
.bd-join{flex-shrink:0;display:inline-flex;align-items:center;gap:5px;border:1.5px solid var(--accent);background:transparent;color:var(--accent);font-family:inherit;font-weight:700;font-size:13px;border-radius:20px;padding:7px 16px;cursor:pointer;transition:.15s;}
.bd-join:hover{background:var(--focus);}
.bd-join.in{background:var(--accent);color:var(--on-accent);border-color:var(--accent);}
.bd-reg-none{color:var(--muted);font-size:13px;padding:4px 2px 10px;border-top:1.5px solid var(--line);margin:0;}
.bd-addname{display:flex;gap:8px;padding:8px 2px 4px;}
.bd-addname .bd-input{flex:1;margin:0;}
.bd-court-info{font-size:12px;color:var(--muted);font-weight:600;padding:8px 2px 6px;border-top:1.5px solid var(--line);text-transform:uppercase;letter-spacing:.4px;}
.bd-wait-label{font-size:11px;color:var(--gold);font-weight:700;text-transform:uppercase;letter-spacing:.6px;padding:8px 2px 2px;}
.bd-reg-item.wait{opacity:.7;}
.bd-reg-num.wait{background:var(--panel-2);color:var(--muted);}
.bd-book-dot{font-size:12px;}
.bd-booking{display:flex;align-items:center;gap:10px;margin-top:10px;padding:10px;border:1.5px dashed var(--line);border-radius:11px;}
.bd-booking.done{border-style:solid;border-color:var(--accent);}
.bd-booking img{width:46px;height:46px;object-fit:cover;border-radius:8px;cursor:pointer;flex-shrink:0;}
.bd-booking-txt{flex:1;display:flex;flex-direction:column;min-width:0;}
.bd-booking-txt b{font-size:13px;}
.bd-booking-txt span{font-size:11px;color:var(--muted);}
.bd-booking .bd-btn.ghost{flex-shrink:0;padding:8px 12px;font-size:13px;}
.bd-booking .bd-btn.busy{pointer-events:none;}
.bd-booking .bd-btn.busy svg{animation:bd-spin .7s linear infinite;}
.bd-reg-bar .bd-reg-right svg{color:var(--muted);}
.bd-reg-day .bd-reg-list{border-top:1.5px solid var(--line);padding-top:2px;padding-bottom:4px;}
.bd-reg-slot{color:var(--ink);}
.bd-reg-right{margin-left:auto;display:flex;align-items:center;gap:8px;}
.bd-today{background:var(--accent);color:var(--on-accent);font-size:9px;padding:2px 7px;border-radius:20px;letter-spacing:.5px;}
.bd-reg-count{display:inline-flex;align-items:center;gap:4px;font-family:'Inter';font-weight:600;font-size:12px;color:var(--muted);background:var(--panel-2);border-radius:20px;padding:3px 10px;}
.bd-reg-list{list-style:none;margin:0;padding:0;}
.bd-reg-item{display:flex;align-items:center;gap:11px;padding:9px 0;border-bottom:1px solid var(--line);}
.bd-reg-item:last-child{border-bottom:none;}
.bd-reg-num{font-family:'Barlow Semi Condensed',sans-serif;font-weight:700;font-size:12px;color:var(--on-accent);background:var(--accent);width:20px;height:20px;border-radius:6px;display:flex;align-items:center;justify-content:center;flex-shrink:0;}
.bd-reg-name{flex:1;font-weight:600;font-size:14px;min-width:0;}
.bd-reg-when{font-size:12px;color:var(--muted);font-variant-numeric:tabular-nums;white-space:nowrap;}
.bd-reg-item button{border:none;background:transparent;color:var(--muted);cursor:pointer;display:flex;padding:2px;border-radius:5px;flex-shrink:0;}
.bd-reg-item button:hover{color:var(--clay);background:var(--clay-bg);}

.bd-signedup{background:var(--panel);border:1.5px solid var(--line);border-radius:14px;padding:12px 13px;margin-bottom:16px;}
.bd-signedup-head{display:flex;align-items:center;justify-content:space-between;font-size:12px;text-transform:uppercase;letter-spacing:.5px;color:var(--muted);font-weight:600;margin-bottom:10px;}
.bd-signedup-head span{display:flex;align-items:center;gap:6px;}
.bd-signedup-chips{display:flex;flex-wrap:wrap;gap:8px;}
.bd-suchip{display:inline-flex;align-items:center;gap:5px;font-size:13px;font-weight:600;font-family:inherit;border:1.5px solid var(--accent);color:var(--accent);background:transparent;border-radius:20px;padding:6px 12px;cursor:pointer;transition:.15s;}
.bd-suchip:hover:not(:disabled){background:var(--accent);color:var(--on-accent);}
.bd-suchip.in{border-color:var(--line);color:var(--muted);}
.bd-suchip:disabled{cursor:default;opacity:.85;}
.bd-hint.warn{color:var(--clay);}

.bd-leadbar{display:flex;align-items:center;gap:6px;background:var(--gold-bg);color:var(--gold-tx);border-radius:11px;padding:9px 13px;font-size:13.5px;margin-bottom:14px;}
.bd-leadbar strong{font-weight:600;}
.bd-leadbar b{font-family:'Barlow Semi Condensed',sans-serif;font-size:16px;margin-left:2px;}

.bd-round{margin-bottom:22px;}
.bd-round-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;}
.bd-round-head h2{font-family:'Barlow Semi Condensed',sans-serif;font-weight:700;font-size:17px;text-transform:uppercase;letter-spacing:.5px;margin:0;}
.bd-round-tools{display:flex;gap:6px;}
.bd-mini{display:inline-flex;align-items:center;gap:4px;font-size:11px;font-weight:600;font-family:inherit;border:1.5px solid var(--line);background:var(--panel);color:var(--soft);border-radius:8px;padding:5px 8px;cursor:pointer;}
.bd-mini:hover{border-color:var(--muted);}
.bd-mini.danger{color:var(--clay);}
.bd-mini.danger:hover{background:var(--clay-bg);border-color:var(--clay-bg);}

.bd-court{background:var(--panel);border:1.5px solid var(--line);border-radius:14px;padding:14px;margin-bottom:10px;position:relative;}
.bd-court-tag{position:absolute;top:-8px;left:14px;background:var(--accent);color:var(--on-accent);font-family:'Barlow Semi Condensed',sans-serif;font-weight:600;font-size:10px;letter-spacing:1px;text-transform:uppercase;padding:2px 8px;border-radius:6px;}
.bd-net{display:grid;grid-template-columns:1fr auto 1fr;align-items:center;gap:6px;margin-top:4px;}
.bd-side{display:flex;flex-direction:column;align-items:center;gap:5px;padding:10px 6px;border-radius:10px;transition:.15s;}
.bd-side.win{background:var(--gold-bg);}
.bd-pl{font-size:14px;font-weight:600;text-align:center;line-height:1.25;}
.bd-side.win .bd-pl{color:var(--gold-tx);}
.bd-vs{font-family:'Barlow Semi Condensed',sans-serif;font-size:11px;font-weight:600;color:var(--net);text-transform:uppercase;letter-spacing:1px;border-left:2px dashed var(--net);border-right:2px dashed var(--net);padding:20px 8px;}
.bd-score{width:56px;text-align:center;font-family:'Barlow Semi Condensed',sans-serif;font-weight:700;font-size:22px;color:var(--ink);border:1.5px solid var(--line);border-radius:9px;padding:5px 2px;background:var(--score-bg);outline:none;font-variant-numeric:tabular-nums;}
.bd-score::placeholder{color:var(--muted);}
.bd-score:focus{border-color:var(--accent);box-shadow:0 0 0 3px var(--focus);}

.bd-rest{display:flex;align-items:center;flex-wrap:wrap;gap:8px;margin-top:4px;font-size:12px;color:var(--muted);padding:4px 2px;}
.bd-rest span{text-transform:uppercase;letter-spacing:.8px;font-weight:600;font-size:10px;}
.bd-rest em{font-style:normal;font-weight:500;color:var(--soft);background:var(--panel);border:1px solid var(--line);border-radius:7px;padding:3px 8px;font-size:12px;}

.bd-photos{display:flex;flex-wrap:wrap;gap:8px;margin-top:12px;padding-top:10px;border-top:1px dashed var(--line);}
.bd-thumb{position:relative;width:56px;height:56px;border-radius:9px;overflow:hidden;border:1.5px solid var(--line);}
.bd-thumb img{width:100%;height:100%;object-fit:cover;cursor:pointer;display:block;}
.bd-thumb-x{position:absolute;top:2px;right:2px;width:18px;height:18px;border:none;border-radius:50%;background:rgba(0,0,0,.6);color:#fff;display:flex;align-items:center;justify-content:center;cursor:pointer;padding:0;}
.bd-addphoto{width:56px;height:56px;border-radius:9px;border:1.5px dashed var(--net);color:var(--muted);display:flex;align-items:center;justify-content:center;cursor:pointer;transition:.15s;}
.bd-addphoto:hover{border-color:var(--accent);color:var(--accent);}
.bd-addphoto.busy{pointer-events:none;color:var(--accent);}
.bd-addphoto.busy svg{animation:bd-spin .7s linear infinite;}
.bd-gallery{display:grid;grid-template-columns:repeat(4,1fr);gap:6px;margin-top:12px;border-top:1.5px solid var(--line);padding-top:10px;}
.bd-gallery img{width:100%;aspect-ratio:1;object-fit:cover;border-radius:8px;cursor:pointer;}
.bd-lightbox{position:fixed;inset:0;background:rgba(0,0,0,.9);display:flex;align-items:center;justify-content:center;z-index:60;padding:16px;animation:bd-fade .15s;}
.bd-lightbox img{max-width:100%;max-height:100%;border-radius:8px;}
.bd-lightbox-x{position:absolute;top:16px;right:16px;width:40px;height:40px;border:none;border-radius:50%;background:rgba(255,255,255,.15);color:#fff;display:flex;align-items:center;justify-content:center;cursor:pointer;}

.bd-podium{display:flex;flex-direction:column;gap:8px;margin-bottom:18px;}
.bd-award{display:flex;align-items:center;gap:12px;padding:14px 16px;border-radius:14px;}
.bd-award.champ{background:var(--gold-bg);color:var(--gold-tx);}
.bd-award.spoon{background:var(--clay-bg);color:var(--clay-tx);}
.bd-award > div{flex:1;line-height:1.15;}
.bd-award-l{display:block;font-size:10px;text-transform:uppercase;letter-spacing:1px;opacity:.85;}
.bd-award strong{font-size:17px;font-weight:600;color:var(--ink);}
.bd-award b{font-family:'Barlow Semi Condensed',sans-serif;font-size:26px;font-weight:700;font-variant-numeric:tabular-nums;}
.bd-award.champ b{color:var(--gold);}
.bd-award.spoon b{color:var(--clay);}

.bd-scorekey{font-size:11.5px;color:var(--muted);margin:0 2px 10px;text-align:center;}
.bd-table{background:var(--panel);border:1.5px solid var(--line);border-radius:14px;overflow:hidden;}
.bd-tr{display:grid;grid-template-columns:34px 1fr 46px 52px;align-items:center;padding:9px 12px;border-bottom:1px solid var(--line);font-size:14px;}
.bd-tr:last-child{border-bottom:none;}
.bd-th{background:var(--panel-2);font-size:10px;text-transform:uppercase;letter-spacing:.8px;color:var(--muted);font-weight:600;padding:8px 12px;}
.bd-tr.champ{background:var(--gold-bg);}
.bd-tr.spoon{background:var(--clay-bg);}
.c-rank{display:flex;align-items:center;justify-content:center;color:var(--muted);font-weight:600;}
.bd-tr.champ .c-rank{color:var(--gold);}
.c-name{display:flex;flex-direction:column;line-height:1.2;}
.c-name .nm{font-weight:600;}
.c-name .rec{font-size:10.5px;color:var(--muted);font-weight:500;margin-top:1px;}
.c-num{text-align:center;font-variant-numeric:tabular-nums;}
.c-num.strong{font-family:'Barlow Semi Condensed',sans-serif;font-weight:700;font-size:18px;color:var(--accent);}
.c-num.muted{color:var(--muted);}
.bd-pts{margin-top:5px;font-family:'Barlow Semi Condensed',sans-serif;font-weight:700;font-size:12px;padding:1px 8px;border-radius:20px;letter-spacing:.3px;}
.bd-pts.win{background:var(--accent);color:var(--on-accent);}
.bd-pts.draw{background:var(--gold-bg);color:var(--gold-tx);}
.bd-pts.loss{background:var(--panel-2);color:var(--muted);}
.bd-side.draw{background:var(--gold-bg);}

.bd-hcard{background:var(--panel);border:1.5px solid var(--line);border-radius:14px;padding:14px;margin-bottom:10px;}
.bd-hhead{display:flex;align-items:center;justify-content:space-between;width:100%;background:none;border:none;padding:0;margin:0 0 10px;cursor:pointer;color:var(--ink);font-family:inherit;}
.bd-hhead>svg{color:var(--muted);flex-shrink:0;}
.bd-hdate{display:flex;align-items:center;gap:7px;font-family:'Barlow Semi Condensed',sans-serif;font-weight:600;font-size:15px;}
.bd-hmeta{margin-left:8px;font-family:'Inter';font-size:11px;color:var(--muted);font-weight:400;}
.bd-hrows{display:flex;flex-direction:column;gap:6px;}
.bd-htable{margin-top:12px;border-top:1.5px solid var(--line);padding-top:8px;}
.bd-htr{display:grid;grid-template-columns:28px 1fr 40px 46px;align-items:center;padding:6px 2px;font-size:13px;}
.bd-hth{font-size:10px;text-transform:uppercase;letter-spacing:.6px;color:var(--muted);font-weight:600;}
.bd-hname{display:flex;flex-direction:column;line-height:1.2;}
.bd-hname .nm{font-weight:600;}
.bd-hname .rec{font-size:10px;color:var(--muted);margin-top:1px;}
.bd-hrow{display:flex;align-items:center;gap:8px;padding:8px 11px;border-radius:10px;font-size:14px;}
.bd-hrow strong{flex:1;font-weight:600;}
.bd-hrow b{font-family:'Barlow Semi Condensed',sans-serif;font-weight:700;font-variant-numeric:tabular-nums;}
.bd-hrow.champ{background:var(--gold-bg);color:var(--gold-tx);}
.bd-hrow.spoon{background:var(--clay-bg);color:var(--clay-tx);}

.bd-data{margin-top:12px;background:var(--panel);border:1.5px solid var(--line);border-radius:14px;padding:16px;}
.bd-data-note{font-size:12px;color:var(--soft);line-height:1.5;margin:0 0 6px;}
.bd-data-note em{color:var(--clay);font-style:normal;font-weight:600;}
.bd-data h4{font-family:'Barlow Semi Condensed',sans-serif;font-weight:700;font-size:14px;text-transform:uppercase;letter-spacing:.5px;margin:16px 0 8px;color:var(--ink);}
.bd-data h4:first-of-type{margin-top:4px;}
.bd-ta{width:100%;min-height:70px;resize:vertical;border:1.5px solid var(--line);border-radius:10px;background:var(--score-bg);color:var(--soft);font-family:ui-monospace,Menlo,monospace;font-size:11px;padding:10px;outline:none;margin-bottom:8px;}
.bd-ta:focus{border-color:var(--accent);}
.bd-past{display:flex;flex-direction:column;gap:8px;}
.bd-past-row{display:flex;gap:8px;}
.bd-past-row .bd-input{flex:1;}
.bd-input.pts{width:70px;flex:none;text-align:center;}
.bd-datamsg{margin:12px 0 0;font-size:13px;font-weight:600;color:var(--accent);text-align:center;}

.bd-modal-bg{position:fixed;inset:0;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center;padding:24px;z-index:50;animation:bd-fade .15s;}
@keyframes bd-fade{from{opacity:0;}to{opacity:1;}}
.bd-modal{background:var(--panel);border:1.5px solid var(--line);border-radius:16px;padding:22px;max-width:340px;width:100%;text-align:center;}
.bd-modal-ic{width:44px;height:44px;border-radius:12px;background:var(--clay-bg);color:var(--clay);display:flex;align-items:center;justify-content:center;margin:0 auto 12px;}
.bd-modal h3{font-family:'Barlow Semi Condensed',sans-serif;font-weight:700;font-size:19px;margin:0 0 6px;color:var(--ink);}
.bd-modal p{font-size:13px;color:var(--soft);margin:0 0 18px;line-height:1.5;}
.bd-modal-actions{display:flex;gap:8px;}
.bd-lockbtns{display:flex;flex-direction:column;gap:8px;margin:0 0 16px;}
.bd-lockbtns .bd-btn{width:100%;}
.bd-modal-actions .bd-btn{flex:1;}

@media (max-width:380px){
  .bd-tab span{font-size:10px;}
  .bd-score{width:48px;font-size:19px;}
  .bd-logo{width:64px;height:64px;}
  .bd-title{font-size:25px;}
}
`;
