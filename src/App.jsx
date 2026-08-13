/* Marina Smashers — Dubai Marina · doubles badminton scoreboard */
import { useState, useEffect, useMemo, useRef } from "react";
import { kvGet, kvSet, uploadPhoto, deletePhoto } from "./storage";
import {
  Crown, Trophy, Users, UserPlus, X, Trash2, RotateCw,
  Play, Feather, Utensils, Check, Calendar, Plus,
  RefreshCw, Sun, Moon, AlertTriangle, Share2, Save, ClipboardCopy,
  Lock, LockOpen, ChevronDown, ChevronUp, KeyRound, Camera, CalendarCheck
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
  const [tab, setTab] = useState("players");
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
  const [lightbox, setLightbox] = useState(null); // photo url being viewed full-screen
  const [uploadingKey, setUploadingKey] = useState(null); // "rIdx-mIdx" currently uploading
  const [signups, setSignups] = useState([]);
  const [reg, setReg] = useState({ date: todayStr(), hour: "7", ap: "PM", name: "" });
  const [regMsg, setRegMsg] = useState("");
  const [prevSnap, setPrevSnap] = useState(null); // last session before a destructive change
  const nameRef = useRef(null);
  const saveTimer = useRef(null);

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
      setLoaded(true);
      if ((s.rounds || []).length) setTab("matches");
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

  const today = todayStr();
  const regSessions = useMemo(() => {
    const g = {};
    signups.forEach((s) => {
      const key = s.date + "|" + (s.time || "");
      if (!g[key]) g[key] = { key, date: s.date, time: s.time || "", list: [] };
      g[key].list.push(s);
    });
    const arr = Object.values(g);
    arr.forEach((sess) => sess.list.sort((a, b) => (a.at || "").localeCompare(b.at || "")));
    const tmin = (t) => {
      if (!t) return 0;
      const [h, ap] = t.split(" ");
      let hh = Number(h) % 12;
      if ((ap || "").toUpperCase() === "PM") hh += 12;
      return hh * 60;
    };
    arr.sort((a, b) => a.date.localeCompare(b.date) || tmin(a.time) - tmin(b.time));
    return arr;
  }, [signups]);
  const todaySignups = useMemo(() => {
    const seen = new Set(), out = [];
    signups.filter((s) => s.date === today).forEach((s) => {
      const k = s.name.toLowerCase();
      if (!seen.has(k)) { seen.add(k); out.push(s); }
    });
    return out;
  }, [signups, today]);

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
          <span className="bd-logo"><img src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAIAAAACACAYAAADDPmHLAACzi0lEQVR42mS9dZxd1fX+/97Hrt877nE34o4XQoK7lwKlBQrUcCuUClCghUIpFChSnFJciwRLCBC3SSYy7nNdj+3fH2cy9PP9zR/kxcnNnX22rL3Ws571LGEYBo7jcNhhh3HuOeeQzeW455576O3tZfacOVx26aW4rsv9999PS0sL48aN4xe/+AV+v58nnniCb7/9lurqaq6++moqKir497//zYcffkggEODaa69l9OjR/Pej//LSiy8hhODXv/4106dPZ926dfzjH/8A4JJLLmHp0qXsbG7mz/fdh+u6nHHmmaw4+mg6Ozv505/+RKFQ4KijjuKcc84hHo9z1113MTQ0xIIF87nkkp9gWRZ/+ctf2LdvH5MmTeLnP/85umHwyN//Ljdt2kRNTQ3XXHMN5eXlPPfcc6xevZpQKMQNN9xAY2MDb7/zLv959VUUReGaa65m2rTpfP755zz55JMC4PLLL2fhwoVs2bKV++//CwBnn302Rx99NPv37+fuu+/GsixWrVrJaaedRiKR5K6772JocIilS5dy4YUXUigUuPfee+ns7GTatGn87Gc/Q1EUHn74YbZv386oUaO4+te/JhgK8eSTT7J27VrKymJce+111NTU8Nprr/Huu+9iGAZXX301EyaM5+OPP+GFF14A4KqrrmL2nNlsWL+Bhx9+GIALLriAQw45hL1793Lvvfdi2zYnn3wyJ5xwAtlsFs00TQBc1yUSieBKSaFQwHEcHNsmEolg2zalUgnHcTBNk0gkgs/nw3FsHMehUCgQiUSIRCJIKXEch2w2SzAQIBaLoigqjuMA4PP5iMViaJo28swwDKLRKIauY1kWAJqqEotFGRoKkMvlkFICEI1GKBQK5PN5HMfBth3C4TCmacoDYyyZJSLRCJrmfZ/jOBSKxeExhnFdF8dxyOfzhEIhwuEIgPfOjkMwGCISiaAoCo7jyAPjjkaj6PrIuIWu60QjUQzDoFgsAiCEIBqNYZoW+Vx+5Duj0SiaplIsFnEcB8uyiMViAJimieM4FEslItEogUAA27aHx1ggHA4TjUZHxlgoFAgGg4TDERRVGZlHv89PJBz5P3OratrIepVKpZExRiLeO4ujV6xAVVQ0XSUUDFEqlUhn0hi6D0XxPug4DplMBlVV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" alt="Marina Smashers crest" /></span>
          <div>
            <h1>Marina Smashers</h1>
          </div>
        </div>
        <div className="bd-head-right">
          <span className="bd-pill">{activePlayers.length} <i>in</i></span>
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
      </header>

      <div className="bd-shared">
        {lock && !unlocked ? <Lock size={12} /> : <Share2 size={12} />}
        <span>
          {lock
            ? (unlocked
                ? "You're the scorekeeper — everyone with the link sees your changes."
                : "Scores are view-only — but anyone can add match photos. Enter the passcode (lock icon) to edit scores.")
            : "Open session — set a passcode when you start so only you can edit scores. Photos stay open to all."}
        </span>
      </div>

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

      <main className="bd-main">
        {/* REGISTER */}
        {tab === "register" && (
          <section>
            <div className="bd-reg-form">
              <div className="bd-reg-row">
                <label>Date
                  <input type="date" className="bd-input" value={reg.date}
                    onChange={(e) => { setReg({ ...reg, date: e.target.value }); setRegMsg(""); }} />
                </label>
                <label>Start time
                  <div className="bd-timepick">
                    <select className="bd-input" value={reg.hour}
                      onChange={(e) => { setReg({ ...reg, hour: e.target.value }); setRegMsg(""); }}>
                      {Array.from({ length: 12 }, (_, i) => String(i + 1)).map((h) => <option key={h} value={h}>{h}</option>)}
                    </select>
                    <select className="bd-input" value={reg.ap}
                      onChange={(e) => { setReg({ ...reg, ap: e.target.value }); setRegMsg(""); }}>
                      <option value="AM">AM</option>
                      <option value="PM">PM</option>
                    </select>
                  </div>
                </label>
              </div>
              <input className="bd-input" placeholder="Your name" value={reg.name}
                onChange={(e) => { setReg({ ...reg, name: e.target.value }); setRegMsg(""); }}
                onKeyDown={(e) => e.key === "Enter" && addSignup()} />
              <button className="bd-btn primary wide" onClick={addSignup}>
                <CalendarCheck size={16} /> Register
              </button>
              {regMsg && <p className={"bd-hint" + (regMsg.includes("\u2713") ? "" : " warn")} style={{ textAlign: "center" }}>{regMsg}</p>}
            </div>

            {regSessions.length === 0 ? (
              <div className="bd-empty">
                <CalendarCheck size={30} strokeWidth={1.6} />
                <p>No sign-ups yet</p>
                <span>Add your name, the date, and the start time to sign up for a session.</span>
              </div>
            ) : (
              regSessions.map((sess) => (
                <div key={sess.key} className="bd-reg-day">
                  <div className="bd-reg-date">
                    <span className="bd-reg-slot">{fmtDate(sess.date)}{sess.time ? " · " + sess.time : ""}</span>
                    <span className="bd-reg-right">
                      {sess.date === today && <span className="bd-today">Today</span>}
                      <span className="bd-reg-count">{sess.list.length}</span>
                    </span>
                  </div>
                  <ol className="bd-reg-list">
                    {sess.list.map((s, i) => (
                      <li key={s.id} className="bd-reg-item">
                        <span className="bd-reg-num">{i + 1}</span>
                        <span className="bd-reg-name">{s.name}</span>
                        <span className="bd-reg-when">{s.at ? fmtRegTime(s.at) : ""}</span>
                        <button onClick={() => removeSignup(s.id)} aria-label={"Remove " + s.name}><X size={14} /></button>
                      </li>
                    ))}
                  </ol>
                </div>
              ))
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

                {canEdit && (
                  <button
                    className="bd-btn primary wide"
                    onClick={() => ask("Finish and save this week?", "Saves this week's full standings to History and clears the rounds. Players stay.", finishWeek)}
                  >
                    <Check size={16} /> Finish & save this week
                  </button>
                )}
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
}
.bd-wrap *{box-sizing:border-box;}
.bd-load{padding:70px 20px;text-align:center;color:var(--muted);}

.bd-head{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:16px 16px 12px;max-width:640px;margin:0 auto;}
.bd-brand{display:flex;align-items:center;gap:11px;min-width:0;}
.bd-logo{width:42px;height:42px;border-radius:50%;overflow:hidden;background:transparent;display:flex;align-items:center;justify-content:center;flex-shrink:0;box-shadow:0 1px 4px rgba(0,0,0,.18);}
.bd-logo img{width:100%;height:100%;object-fit:cover;display:block;}
.bd-brand h1{font-family:'Barlow Semi Condensed',sans-serif;font-weight:700;font-size:22px;letter-spacing:.3px;margin:0;line-height:1;text-transform:uppercase;}
.bd-brand p{margin:3px 0 0;font-size:11.5px;color:var(--soft);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.bd-head-right{display:flex;align-items:center;gap:7px;flex-shrink:0;}
.bd-pill{font-family:'Barlow Semi Condensed',sans-serif;font-weight:700;font-size:14px;background:var(--panel);border:1.5px solid var(--line);color:var(--accent);padding:5px 9px;border-radius:9px;}
.bd-pill i{font-style:normal;color:var(--muted);font-weight:600;font-size:10px;text-transform:uppercase;}
.bd-iconbtn{width:36px;height:36px;border-radius:10px;border:1.5px solid var(--line);background:var(--panel);color:var(--soft);display:flex;align-items:center;justify-content:center;cursor:pointer;transition:.15s;}
.bd-iconbtn:hover{color:var(--accent);border-color:var(--accent);}
.bd-iconbtn.spin svg{animation:bd-spin .7s linear;}
.bd-iconbtn.on{background:var(--accent);color:var(--on-accent);border-color:var(--accent);}
.bd-input.err{border-color:var(--clay);box-shadow:0 0 0 3px var(--clay-bg);}
@keyframes bd-spin{to{transform:rotate(360deg);}}

.bd-shared{max-width:640px;margin:0 auto;display:flex;align-items:center;gap:7px;padding:7px 16px;color:var(--muted);font-size:11.5px;}
.bd-shared svg{flex-shrink:0;color:var(--accent);}

.bd-tabs{display:flex;gap:4px;padding:2px 12px 0;max-width:640px;margin:0 auto;position:sticky;top:0;background:var(--bg);z-index:5;}
.bd-tab{flex:1;display:flex;flex-direction:column;align-items:center;gap:3px;padding:9px 4px;border:none;background:transparent;cursor:pointer;color:var(--muted);font-size:11px;font-weight:600;font-family:inherit;border-bottom:2.5px solid transparent;transition:.15s;}
.bd-tab.on{color:var(--accent);border-bottom-color:var(--accent);}
.bd-tab:hover{color:var(--soft);}

.bd-main{max-width:640px;margin:0 auto;padding:16px 14px 64px;}

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
.bd-reg-slot{color:var(--ink);}
.bd-reg-right{margin-left:auto;display:flex;align-items:center;gap:8px;}
.bd-today{background:var(--accent);color:var(--on-accent);font-size:9px;padding:2px 7px;border-radius:20px;letter-spacing:.5px;}
.bd-reg-count{font-family:'Inter';font-weight:600;font-size:12px;color:var(--muted);background:var(--panel-2);border-radius:20px;padding:2px 9px;}
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
  .bd-brand p{display:none;}
  .bd-tab span{font-size:10px;}
  .bd-score{width:48px;font-size:19px;}
}
`;
