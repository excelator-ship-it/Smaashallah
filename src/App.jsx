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
          <span className="bd-logo"><img src="data:image/png;base64,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" alt="Marina Smashers crest" /></span>
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
