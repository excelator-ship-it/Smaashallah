/* Smaashallah — Dubai Marina · doubles badminton scoreboard */
import { useState, useEffect, useMemo, useRef } from "react";
import { kvGet, kvSet } from "./storage";
import {
  Crown, Trophy, Users, UserPlus, X, Trash2, RotateCw,
  Play, Feather, Utensils, Check, Calendar, Plus,
  RefreshCw, Sun, Moon, AlertTriangle, Share2, Save, ClipboardCopy,
  Lock, LockOpen, ChevronDown, ChevronUp, KeyRound
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
const K_THEME = "badminton:theme:v3";    // personal
const UNLOCK_KEY = "badminton:unlockHash"; // per-device: hash this device has unlocked

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
  const nameRef = useRef(null);
  const saveTimer = useRef(null);

  // No lock set -> open session (setup). Lock set -> only unlocked devices may edit.
  const canEdit = lock ? unlocked : true;

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
    setPlayers((p) => p.filter((x) => x.id !== id));
    setRounds((rs) =>
      rs.map((r) => ({
        ...r,
        matches: r.matches.filter((m) => ![...m.teamA, ...m.teamB].includes(id)),
        resting: r.resting.filter((x) => x !== id),
      })).filter((r) => r.matches.length)
    );
  };
  const loadLast = async () => {
    const last = await loadKey(K_ROSTER, [], true);
    if (last.length) setPlayers(last.map((nm) => ({ id: uid(), name: nm })));
  };

  const doStart = () => {
    if (players.length < 4) return;
    saveKey(K_ROSTER, players.map((x) => x.name), true);
    setRounds((rs) => [...rs, makeRound(players, rs)]);
    setTab("matches");
  };
  const addRound = () => {
    if (players.length < 4) return;
    // Starting a brand-new session with no passcode yet → prompt to set one.
    if (rounds.length === 0 && !lock) { setPass(""); setPassErr(""); setLockModal("start"); return; }
    doStart();
  };
  const rerollRound = (idx) => {
    setRounds((rs) => {
      const prior = rs.slice(0, idx);
      const copy = rs.slice();
      copy[idx] = makeRound(players, prior);
      return copy;
    });
  };
  const deleteRound = (idx) => setRounds((rs) => rs.filter((_, i) => i !== idx));

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
    };
    const nextHist = [entry, ...history];
    setHistory(nextHist);
    saveKey(K_HISTORY, nextHist, true);
    setRounds([]);
    clearLock(); // end of session → passcode resets; next start sets a new one
    setTab("history");
  };

  const clearHistory = () => { setHistory([]); saveKey(K_HISTORY, [], true); };

  const backupJson = JSON.stringify(
    { app: "smaashallah", version: "v3", exportedAt: new Date().toISOString(),
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

  const courtsThisWeek = players.length >= 4 ? Math.floor(players.length / 4) : 0;

  return (
    <div className="bd-wrap" data-theme={theme}>
      <style>{CSS}</style>

      <header className="bd-head">
        <div className="bd-brand">
          <span className="bd-logo"><img src="data:image/png;base64,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" alt="Smaashallah crest" /></span>
          <div>
            <h1>Smaashallah</h1>
          </div>
        </div>
        <div className="bd-head-right">
          <span className="bd-pill">{players.length} <i>in</i></span>
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
                : "View only — enter the scorekeeper's passcode (lock icon) to edit.")
            : "Open session — set a passcode when you start so only you can edit."}
        </span>
      </div>

      <nav className="bd-tabs">
        {[
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
                  </>
                ) : (
                  <span>The match organiser hasn't added players yet.</span>
                )}
              </div>
            ) : (
              <>
                <ul className="bd-roster">
                  {players.map((p, i) => (
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

                <div className="bd-plan">
                  {players.length < 4 ? (
                    <p className="bd-hint warn">Add {4 - players.length} more to start doubles.</p>
                  ) : (
                    <p className="bd-hint">
                      {courtsThisWeek} court{courtsThisWeek > 1 ? "s" : ""} in play
                      {players.length % 4 !== 0 && ` · ${players.length % 4} resting each round`}
                    </p>
                  )}
                  {canEdit && (
                    <div className="bd-plan-actions">
                      <button className="bd-btn primary" disabled={players.length < 4} onClick={addRound}>
                        <Play size={16} /> {rounds.length ? "New round" : "Start playing"}
                      </button>
                      <button
                        className="bd-btn ghost danger"
                        onClick={() => ask("Clear all players?", "This also clears the current rounds and resets the session passcode. History is kept.", () => { setPlayers([]); setRounds([]); clearLock(); })}
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
                    <button className="bd-btn primary" disabled={players.length < 4} onClick={addRound}>
                      <Play size={16} /> {players.length < 4 ? "Add 4+ players first" : "Generate round 1"}
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
                        {hasTable && (open ? <ChevronUp size={16} /> : <ChevronDown size={16} />)}
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
                <p className="bd-data-note">
                  Storage lives with the published app. Copy this backup somewhere safe before you publish
                  changes, and never <em>Unpublish</em> — that erases the group's data for good.
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

.bd-plan{margin-top:20px;padding-top:16px;border-top:1.5px dashed var(--line);}
.bd-plan-actions{display:flex;gap:8px;margin-top:12px;flex-wrap:wrap;}
.bd-hint{font-size:13px;color:var(--soft);margin:0;}
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
