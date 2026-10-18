// Orbit Agents: one card per sub-agent, live from the run's ledger over SSE (/api/agents/stream).
// Card buttons POST to /api/agents/control; the Supervisor that owns the run carries the request
// out and its result comes back on the same stream, matched by request id.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Timer } from "lucide-react";

type State = "queued" | "starting" | "running" | "needs_you" | "paused" | "idle" | "blocked" | "done" | "failed" | "stopped" | "interrupted";
type Action = "pause" | "pause_step" | "resume" | "redirect" | "stop" | "approve" | "deny" | "restart";

type Report = { status: string; summary: string; changes: string[]; questions: string[]; next?: string | null; malformed?: boolean };

type Card = {
  id: string;
  name: string;
  role: string;
  task: string;
  state: State;
  reason: string | null;
  progress: { done: number; total: number; step: string };
  activity: string;
  needs: { kind: string; title: string; path: string | null } | null;
  overBudget: boolean;
  cost: number;
  context: { used: number; size: number } | null;
  model: string | null;
  elapsedMs: number;
  ticking: boolean;
  asOf: number;
  report: Report | null;
};

type RunSummary = { id: string; goal: string; startedAt: number | null; endedAt: number | null; agents: number; active: number; needsYou: number; cost: number; live: boolean };
type FeedItem = { seq: number; t: number; id: string | null; type: string; text: string; state?: State; you?: boolean; failed?: boolean };
type Result = { rid: string; id: string | null; action: Action; ok: boolean; error: string | null };
type Msg =
  | { type: "snapshot"; run: RunSummary; cards: Card[]; feed: FeedItem[] }
  | { type: "update"; run: RunSummary; cards: Card[]; order: string[]; feed: FeedItem[]; results: Result[] };

type Pending = { rid: string; action: Action; at: number };
type Control = (agent: string, action: Action, text?: string) => Promise<boolean>;

const LABEL: Record<State, string> = {
  queued: "Queued", starting: "Starting", running: "Running", needs_you: "Needs you", paused: "Paused", idle: "Idle",
  blocked: "Blocked", done: "Done", failed: "Failed", stopped: "Stopped", interrupted: "Interrupted",
};
const SORT: Record<State, number> = { needs_you: 0, blocked: 1, running: 2, starting: 3, paused: 4, interrupted: 5, idle: 6, queued: 7, failed: 8, done: 9, stopped: 10 };
const PENDING_LABEL: Record<Action, string> = {
  pause: "Pausing…", pause_step: "Asking to pause after this step…", resume: "Resuming…", redirect: "Sending your instruction…",
  stop: "Stopping…", approve: "Approving…", deny: "Denying…", restart: "Restarting…",
};
const NO_ANSWER_MS = 15000;

const fmtElapsed = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return s >= 3600 ? `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
};
const fmtTime = (t: number) => new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
const fmtRunLabel = (r: RunSummary) =>
  `${r.startedAt ? new Date(r.startedAt).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : r.id} · ${r.goal || "Untitled run"}${r.active ? ` (${r.active} active)` : ""}`;

function useNow(ms = 1000) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

function useRuns() {
  const [runs, setRuns] = useState<RunSummary[] | null>(null);
  useEffect(() => {
    let alive = true;
    const load = () =>
      fetch("/api/agents/runs")
        .then((r) => (r.ok ? r.json() : { runs: [] }))
        .then((j) => alive && setRuns(j.runs))
        .catch(() => alive && setRuns((x) => x ?? []));
    load();
    const t = setInterval(load, 3000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);
  return runs;
}

function useRun(id: string | null, onResults: (r: Result[]) => void) {
  const [run, setRun] = useState<RunSummary | null>(null);
  const [cards, setCards] = useState<Record<string, Card>>({});
  const [order, setOrder] = useState<string[]>([]);
  const [feed, setFeed] = useState<FeedItem[]>([]);
  const [connected, setConnected] = useState(false);
  const resultsRef = useRef(onResults);
  resultsRef.current = onResults;

  useEffect(() => {
    setRun(null);
    setCards({});
    setOrder([]);
    setFeed([]);
    if (!id) return;
    const es = new EventSource(`/api/agents/stream?id=${encodeURIComponent(id)}`);
    es.onopen = () => setConnected(true);
    es.onerror = () => setConnected(false); // EventSource reconnects by itself; the server re-sends a snapshot
    es.onmessage = (ev) => {
      const m = JSON.parse(ev.data) as Msg;
      setRun(m.run);
      if (m.type === "snapshot") {
        setCards(Object.fromEntries(m.cards.map((c) => [c.id, c])));
        setOrder(m.cards.map((c) => c.id));
        setFeed(m.feed);
      } else {
        if (m.cards.length) setCards((prev) => ({ ...prev, ...Object.fromEntries(m.cards.map((c) => [c.id, c])) }));
        setOrder(m.order);
        if (m.feed.length) setFeed((prev) => [...prev, ...m.feed.filter((f) => !prev.some((p) => p.seq === f.seq))].slice(-200));
        if (m.results?.length) resultsRef.current(m.results);
      }
    };
    return () => es.close();
  }, [id]);

  return { run, cards: order.map((o) => cards[o]).filter(Boolean), feed, connected };
}

/** Sends card actions and tracks each one until its result comes back on the stream. */
function useControls(runId: string | null) {
  const [pending, setPending] = useState<Record<string, Pending>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});

  const showError = useCallback((agent: string, message: string) => {
    setErrors((e) => ({ ...e, [agent]: message }));
    setTimeout(() => setErrors((e) => (e[agent] === message ? Object.fromEntries(Object.entries(e).filter(([k]) => k !== agent)) : e)), 8000);
  }, []);
  const clearPending = (agent: string, rid?: string) =>
    setPending((p) => (p[agent] && (!rid || p[agent].rid === rid) ? Object.fromEntries(Object.entries(p).filter(([k]) => k !== agent)) : p));

  const control: Control = useCallback(
    async (agent, action, text) => {
      if (!runId) return false;
      setErrors((e) => Object.fromEntries(Object.entries(e).filter(([k]) => k !== agent)));
      try {
        const r = await fetch("/api/agents/control", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ run: runId, agent, action, text }),
        });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) {
          showError(agent, j.error || `Request failed (HTTP ${r.status})`);
          return false;
        }
        setPending((p) => ({ ...p, [agent]: { rid: j.rid, action, at: Date.now() } }));
        return true;
      } catch {
        showError(agent, "Couldn't reach Orbit.");
        return false;
      }
    },
    [runId, showError],
  );

  const onResults = useCallback(
    (results: Result[]) => {
      for (const r of results) {
        if (!r.id) continue;
        clearPending(r.id, r.rid);
        if (!r.ok && r.error) showError(r.id, r.error);
      }
    },
    [showError],
  );

  // A request nobody answers (the run's owner died between the check and the click).
  useEffect(() => {
    const t = setInterval(() => {
      const now = Date.now();
      for (const [agent, p] of Object.entries(pending)) {
        if (now - p.at > NO_ANSWER_MS) {
          clearPending(agent, p.rid);
          showError(agent, "No answer from the run. It may have stopped.");
        }
      }
    }, 1000);
    return () => clearInterval(t);
  }, [pending, showError]);

  useEffect(() => {
    setPending({});
    setErrors({});
  }, [runId]);

  return { control, pending, errors, onResults };
}

export default function AgentsApp() {
  const runs = useRuns();
  const [picked, setPicked] = useState<string | null>(null);
  // Follow the newest run unless the user picked one.
  const runId = picked ?? runs?.[0]?.id ?? null;
  const { control, pending, errors, onResults } = useControls(runId);
  const { run, cards, feed, connected } = useRun(runId, onResults);
  const now = useNow();

  const sorted = useMemo(() => [...cards].sort((a, b) => SORT[a.state] - SORT[b.state]), [cards]);
  const done = cards.reduce((s, c) => s + c.progress.done, 0);
  const total = cards.reduce((s, c) => s + Math.max(c.progress.total, c.progress.done), 0);
  const counts = (s: State[]) => cards.filter((c) => s.includes(c.state)).length;
  const live = !!run?.live;

  return (
    <div className="ag select-none">
      <div className="ag-titlebar">
        <span className="brand">Orbit Agents</span>
        {runs && runs.length > 0 && (
          <select aria-label="Run" value={runId ?? ""} onChange={(e) => setPicked(e.target.value === runs[0]?.id ? null : e.target.value)}>
            {runs.map((r) => (
              <option key={r.id} value={r.id}>
                {fmtRunLabel(r)}
              </option>
            ))}
          </select>
        )}
        {runId && !connected && <span className="ag-small">reconnecting…</span>}
      </div>

      <div className="ag-body">
        {runs === null ? null : runs.length === 0 ? (
          <Empty />
        ) : (
          <div className="ag-wrap">
            {run && (
              <header className="ag-run">
                <div className="goal">
                  <h1>{run.goal || "Untitled run"}</h1>
                  <p>
                    {[
                      `${cards.length} agent${cards.length === 1 ? "" : "s"}`,
                      counts(["running", "starting"]) && `${counts(["running", "starting"])} running`,
                      counts(["needs_you", "blocked"]) && `${counts(["needs_you", "blocked"])} need you`,
                      counts(["paused"]) && `${counts(["paused"])} paused`,
                      counts(["done"]) && `${counts(["done"])} done`,
                      counts(["failed", "interrupted"]) && `${counts(["failed", "interrupted"])} failed`,
                      run.endedAt ? `ended ${fmtTime(run.endedAt)}` : run.startedAt && `started ${fmtTime(run.startedAt)}`,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </p>
                  {!live && <p className="ag-readonly">View only: nothing is running this run any more, so its agents can't be controlled.</p>}
                </div>
                <div className="overall">
                  <div className="ag-small ag-row">
                    <span>Overall</span>
                    <span>
                      {total ? `${done} of ${total} steps` : "planning…"} · ${run.cost.toFixed(2)}
                    </span>
                  </div>
                  <div className="ag-bar">
                    <i style={{ width: `${total ? Math.round((done / total) * 100) : 0}%` }} />
                  </div>
                </div>
              </header>
            )}

            <div className="ag-layout">
              <main className="ag-grid" aria-live="polite">
                {sorted.map((c) => (
                  <AgentCard key={c.id} c={c} now={now} live={live} control={control} pending={pending[c.id]} error={errors[c.id]} />
                ))}
                {run && cards.length === 0 && <p className="ag-small">No agents in this run yet.</p>}
              </main>
              <Feed feed={feed} />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

type CardProps = { c: Card; now: number; live: boolean; control: Control; pending?: Pending; error?: string };

function AgentCard({ c, now, live, control, pending, error }: CardProps) {
  const [open, setOpen] = useState(false);
  const elapsed = c.elapsedMs + (c.ticking ? now - c.asOf : 0);
  const p = c.progress;
  const total = Math.max(p.total, p.done);
  const pct = total ? Math.round((p.done / total) * 100) : 0;
  const finished = ["done", "failed", "stopped"].includes(c.state);
  const pausing = c.state === "running" && c.reason === "pausing after this step";
  const stepText =
    c.state === "done" ? "All steps complete" : total ? `Step ${Math.min(p.done + 1, total)} of ${total}${p.step && p.step !== "finished" ? ` · ${p.step}` : ""}` : c.state === "queued" ? "Waiting for a free slot" : "Planning…";

  return (
    <article className={`ag-card ${c.state}${c.overBudget ? " over" : ""}`}>
      <div className="ag-top">
        <span className="ag-name">{c.name}</span>
        {c.role && <span className="ag-role">{c.role}</span>}
        <span className={`ag-pill ${c.state}`}>{pausing ? "Pausing" : LABEL[c.state]}</span>
      </div>
      <p className="ag-task" title={c.task}>
        {c.task}
      </p>
      <div>
        <div className="ag-bar">
          <i style={{ width: `${pct}%` }} />
        </div>
        <div className="ag-small ag-row" style={{ marginTop: 6 }}>
          <span className="ag-step">{stepText}</span>
          {total > 0 && (
            <span>
              {p.done}/{total}
            </span>
          )}
        </div>
      </div>

      {!finished && c.activity && (
        <div className="ag-activity" title={c.activity}>
          {c.activity}
        </div>
      )}

      {c.state === "needs_you" && c.needs && (
        <div className="ag-note need">
          <div>Waiting for your approval: {c.needs.title.split("\n")[0]}</div>
          {c.needs.path && <div className="sub">{c.needs.path}</div>}
          <div className="ag-actions">
            <button className="ag-btn primary" disabled={!live || !!pending} onClick={() => control(c.id, "approve")}>
              Approve
            </button>
            <button className="ag-btn" disabled={!live || !!pending} onClick={() => control(c.id, "deny")}>
              Deny
            </button>
          </div>
        </div>
      )}
      {pausing && <div className="ag-note">Will pause when this step finishes.</div>}
      {c.state === "paused" && c.reason && <div className={`ag-note ${c.overBudget ? "warn" : ""}`}>{c.reason}</div>}
      {c.state === "blocked" && c.reason && <div className="ag-note need">{c.reason}</div>}
      {(c.state === "failed" || c.state === "interrupted") && c.reason && <div className="ag-note fail">{c.reason}</div>}

      {c.report && (c.state === "done" || c.state === "failed" || open) && (
        <div className="ag-report">
          {c.report.summary}
          {c.report.questions.length > 0 && c.state !== "blocked" && (
            <ul>
              {c.report.questions.map((q) => (
                <li key={q}>{q}</li>
              ))}
            </ul>
          )}
        </div>
      )}
      {open && c.report && c.report.changes.length > 0 && (
        <div className="ag-report">
          <span className="ag-small">Changed files</span>
          <ul>
            {c.report.changes.map((f) => (
              <li key={f}>{f}</li>
            ))}
          </ul>
        </div>
      )}

      <Controls c={c} live={live} control={control} pending={pending} pausing={pausing} />
      {pending && <div className="ag-small ag-pending">{PENDING_LABEL[pending.action]}</div>}
      {error && (
        <div className="ag-error" role="alert">
          {error}
        </div>
      )}

      <div className="ag-meta ag-small">
        <span className="inline-flex items-center gap-1" title="Time spent working">
          <Timer size={11} aria-hidden /> {fmtElapsed(elapsed)}
        </span>
        <span>${c.cost.toFixed(2)}</span>
        {c.context && <span title={`${c.context.used.toLocaleString()} of ${c.context.size.toLocaleString()} tokens`}>context {Math.round((c.context.used / c.context.size) * 100)}%</span>}
        {c.model && <span>{c.model.replace(/^claude-/, "")}</span>}
        {c.report && c.report.changes.length > 0 && (
          <button className="details" onClick={() => setOpen((o) => !o)}>
            {open ? "Hide" : `${c.report.changes.length} file${c.report.changes.length === 1 ? "" : "s"}`}
          </button>
        )}
      </div>
    </article>
  );
}

/** The card's buttons for its current state. One inline panel at a time: pause choice, redirect box or stop confirm. */
function Controls({ c, live, control, pending, pausing }: { c: Card; live: boolean; control: Control; pending?: Pending; pausing: boolean }) {
  const [panel, setPanel] = useState<null | "pause" | "redirect" | "stop">(null);
  const [text, setText] = useState("");
  const box = useRef<HTMLTextAreaElement>(null);
  const s = c.state;

  useEffect(() => {
    if (panel === "redirect") box.current?.focus();
  }, [panel]);
  // A panel that no longer fits the state closes by itself (e.g. the agent finished meanwhile).
  useEffect(() => {
    if (panel === "pause" && !(s === "running" || s === "needs_you")) setPanel(null);
    // The redirect box stays open: a finished agent still takes a follow-up, so typed text is never lost.
    if (panel === "redirect" && ["failed", "stopped", "interrupted"].includes(s)) setPanel(null);
    if (panel === "stop" && ["done", "failed", "stopped", "interrupted"].includes(s)) setPanel(null);
  }, [s, panel]);

  const busy = !live || !!pending;
  const title = !live ? "Nothing is running this run any more" : undefined;
  const act = async (action: Action, t?: string) => {
    if (await control(c.id, action, t)) {
      setPanel(null);
      if (action === "redirect") setText("");
    }
  };

  const canPause = (s === "running" && !pausing) || s === "needs_you";
  const canResume = s === "paused" || s === "idle" || s === "blocked" || pausing;
  const canRedirect = ["running", "needs_you", "paused", "idle", "blocked", "done"].includes(s);
  const canStop = !["done", "failed", "stopped", "interrupted"].includes(s);
  const canRestart = s === "failed" || s === "interrupted" || s === "stopped";
  if (!canPause && !canResume && !canRedirect && !canStop && !canRestart) return null;

  if (panel === "pause")
    return (
      <div className="ag-panel">
        <div className="ag-actions">
          <button className="ag-btn primary" disabled={busy} onClick={() => act("pause")}>
            Pause now
          </button>
          <button className="ag-btn" disabled={busy} onClick={() => act("pause_step")}>
            After this step
          </button>
          <button className="ag-btn ghost" onClick={() => setPanel(null)}>
            Cancel
          </button>
        </div>
        <div className="ag-small">"Pause now" stops mid-step and keeps what the agent knows; "After this step" waits for a clean stopping point.</div>
      </div>
    );

  if (panel === "redirect")
    return (
      <form
        className="ag-panel"
        onSubmit={(e) => {
          e.preventDefault();
          if (text.trim()) act("redirect", text);
        }}
      >
        <textarea
          ref={box}
          value={text}
          maxLength={4000}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && text.trim()) act("redirect", text);
            if (e.key === "Escape") setPanel(null);
          }}
          placeholder={
            s === "blocked" ? `Answer ${c.name}'s question, or give it a new instruction.` : s === "done" ? `Follow-up task for ${c.name}. It remembers what it just did.` : `New instruction for ${c.name}. It keeps what it has learned so far.`
          }
        />
        <div className="ag-actions end">
          <span className="ag-small">Ctrl+Enter to send</span>
          <button type="button" className="ag-btn ghost" onClick={() => setPanel(null)}>
            Cancel
          </button>
          <button className="ag-btn primary" disabled={busy || !text.trim()}>
            {s === "blocked" ? "Send answer" : s === "done" ? "Send" : "Redirect"}
          </button>
        </div>
      </form>
    );

  if (panel === "stop")
    return (
      <div className="ag-panel">
        <div className="ag-small">Stop {c.name}? Its process ends; files it wrote stay. Other agents keep going.</div>
        <div className="ag-actions">
          <button className="ag-btn danger-solid" disabled={busy} onClick={() => act("stop")}>
            Stop {c.name}
          </button>
          <button className="ag-btn ghost" onClick={() => setPanel(null)}>
            Keep running
          </button>
        </div>
      </div>
    );

  return (
    <div className="ag-actions" title={title}>
      {canPause && (
        <button className="ag-btn" disabled={busy} onClick={() => setPanel("pause")}>
          Pause
        </button>
      )}
      {canResume && (
        <button className="ag-btn" disabled={busy} onClick={() => act("resume")}>
          {pausing ? "Keep going" : s === "paused" ? "Resume" : "Continue"}
        </button>
      )}
      {canRedirect && (
        <button className="ag-btn" disabled={busy} onClick={() => setPanel("redirect")}>
          {s === "blocked" ? "Answer" : s === "done" ? "Follow up" : "Redirect"}
        </button>
      )}
      {canRestart && (
        <button className="ag-btn" disabled={busy} onClick={() => act("restart")}>
          Restart
        </button>
      )}
      {canStop && (
        <button className="ag-btn danger" disabled={busy} onClick={() => setPanel("stop")}>
          Stop
        </button>
      )}
    </div>
  );
}

function Feed({ feed }: { feed: FeedItem[] }) {
  const ref = useRef<HTMLUListElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [feed.length]);
  return (
    <aside className="ag-feed">
      <h2>Activity</h2>
      <ul ref={ref}>
        {feed.map((f) => (
          <li key={f.seq} className={f.failed ? "failed" : f.you ? "you" : (f.state ?? "")}>
            <time>{fmtTime(f.t)}</time>
            {f.text}
          </li>
        ))}
      </ul>
    </aside>
  );
}

function Empty() {
  return (
    <div className="ag-empty">
      <h1>No agent runs yet</h1>
      <p>When Orbit runs a team of agents, each one shows up here as a card with its task, status and progress.</p>
      <p>
        Runs are read from <code>%APPDATA%\Orbit\agents\runs</code>.
      </p>
    </div>
  );
}
