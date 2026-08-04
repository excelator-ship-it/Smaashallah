/* Smashallah — Dubai Marina · doubles badminton scoreboard */
import { useState, useEffect, useMemo, useRef } from "react";
import { kvGet, kvSet } from "./storage";
import {
  Crown, Trophy, Users, UserPlus, X, Trash2, RotateCw,
  Play, Feather, Utensils, Check, Calendar, Plus,
  RefreshCw, Sun, Moon, AlertTriangle, Share2, Save, ClipboardCopy
} from "lucide-react";

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
const K_THEME = "badminton:theme:v3"; // personal

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
  const nameRef = useRef(null);
  const saveTimer = useRef(null);

  const ask = (message, detail, onYes) => setConfirm({ message, detail, onYes });

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
    setPlayers(s.players || []);
    setRounds(s.rounds || []);
    setHistory(h || []);
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

  const addRound = () => {
    if (players.length < 4) return;
    saveKey(K_ROSTER, players.map((x) => x.name), true);
    setRounds((rs) => [...rs, makeRound(players, rs)]);
    setTab("matches");
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
    };
    const nextHist = [entry, ...history];
    setHistory(nextHist);
    saveKey(K_HISTORY, nextHist, true);
    setRounds([]);
    setTab("history");
  };

  const clearHistory = () => { setHistory([]); saveKey(K_HISTORY, [], true); };

  const backupJson = JSON.stringify(
    { app: "smashallah", version: "v3", exportedAt: new Date().toISOString(),
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
          <span className="bd-logo"><img src="data:image/png;base64,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" alt="Smashallah crest" /></span>
          <div>
            <h1>Smashallah</h1>
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
        </div>
      </header>

      <div className="bd-shared">
        <Share2 size={12} />
        <span>Shared scoreboard — everyone with the link sees these scores. Tap ⟳ to refresh.</span>
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

            {players.length === 0 ? (
              <div className="bd-empty">
                <Feather size={30} strokeWidth={1.6} />
                <p>Who's playing today?</p>
                <span>Add everyone who showed up — 4 or more to get going.</span>
                <button className="bd-btn ghost" onClick={loadLast}>
                  <RotateCw size={15} /> Load last week's players
                </button>
              </div>
            ) : (
              <>
                <ul className="bd-roster">
                  {players.map((p, i) => (
                    <li key={p.id} className="bd-chip">
                      <span className="bd-chip-num">{i + 1}</span>
                      <span className="bd-chip-name">{p.name}</span>
                      <button onClick={() => removePlayer(p.id)} aria-label={"Remove " + p.name}>
                        <X size={15} />
                      </button>
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
                  <div className="bd-plan-actions">
                    <button className="bd-btn primary" disabled={players.length < 4} onClick={addRound}>
                      <Play size={16} /> {rounds.length ? "New round" : "Start playing"}
                    </button>
                    <button
                      className="bd-btn ghost danger"
                      onClick={() => ask("Clear all players?", "This also clears the current rounds. History is kept.", () => { setPlayers([]); setRounds([]); })}
                    >
                      <Trash2 size={15} /> Clear all
                    </button>
                  </div>
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
                <span>Generate a round and fresh partners are drawn automatically.</span>
                <button className="bd-btn primary" disabled={players.length < 4} onClick={addRound}>
                  <Play size={16} /> {players.length < 4 ? "Add 4+ players first" : "Generate round 1"}
                </button>
              </div>
            ) : (
              <>
                {rounds.map((r, rIdx) => (
                  <div key={r.id} className="bd-round">
                    <div className="bd-round-head">
                      <h2>Round {rIdx + 1}</h2>
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
                              <input className="bd-score" inputMode="numeric" placeholder="–"
                                value={m.scoreA} onChange={(e) => setScore(rIdx, mIdx, "A", e.target.value)} />
                              {done && <span className={"bd-pts " + chip(aWin)[1]}>{chip(aWin)[0]}</span>}
                            </div>
                            <div className="bd-vs">vs</div>
                            <div className={"bd-side" + (bWin ? " win" : draw ? " draw" : "")}>
                              {m.teamB.map((id) => <span key={id} className="bd-pl">{nameOf(id)}</span>)}
                              <input className="bd-score" inputMode="numeric" placeholder="–"
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

                <button className="bd-btn primary wide" onClick={addRound}>
                  <Plus size={16} /> New round
                </button>
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

                <button
                  className="bd-btn primary wide"
                  onClick={() => ask("Finish and save this week?", "Saves today's winner to History and clears the rounds. Players stay.", finishWeek)}
                >
                  <Check size={16} /> Finish & save this week
                </button>
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
                {history.map((h) => (
                  <div key={h.id} className="bd-hcard">
                    <div className="bd-hdate">
                      <Calendar size={14} />{h.date}
                      <span className="bd-hmeta">
                        {h.system && h.system !== "2/1/0"
                          ? "previous scoring"
                          : `${h.players} players · ${h.rounds} rounds`}
                      </span>
                    </div>
                    <div className="bd-hrows">
                      {h.champ && (
                        <div className="bd-hrow champ"><Crown size={15} /><strong>{h.champ.name}</strong><b>{h.champ.points} pts</b></div>
                      )}
                      {h.spoon && (
                        <div className="bd-hrow spoon"><Utensils size={14} /><strong>{h.spoon.name}</strong><b>{h.spoon.points} pts</b></div>
                      )}
                    </div>
                  </div>
                ))}
                <button
                  className="bd-btn ghost danger"
                  onClick={() => ask("Clear all history?", "Every saved week will be removed for the whole group.", clearHistory)}
                >
                  <Trash2 size={15} /> Clear history
                </button>
              </>
            )}

            <button className="bd-btn ghost wide" onClick={() => setDataOpen((v) => !v)}>
              <Save size={15} /> Backup & restore {dataOpen ? "▲" : "▼"}
            </button>

            {dataOpen && (
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
.bd-hdate{display:flex;align-items:center;gap:7px;font-family:'Barlow Semi Condensed',sans-serif;font-weight:600;font-size:15px;margin-bottom:10px;}
.bd-hmeta{margin-left:auto;font-family:'Inter';font-size:11px;color:var(--muted);font-weight:400;}
.bd-hrows{display:flex;flex-direction:column;gap:6px;}
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
.bd-modal-actions .bd-btn{flex:1;}

@media (max-width:380px){
  .bd-brand p{display:none;}
  .bd-tab span{font-size:10px;}
  .bd-score{width:48px;font-size:19px;}
}
`;
