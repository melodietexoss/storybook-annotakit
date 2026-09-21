import {
  API_BASE,
  FOCUS_THREAD,
  THREADS_CHANGED,
  THREAD_FOCUSED,
  UI_COMMAND,
  UI_STATE,
  probeMode
} from "./chunk-Y2DYPSGG.mjs";
import {
  getGhLinkedStaticStore,
  ghClientStatus
} from "./chunk-XGVDME4E.mjs";
import {
  renderStaticDigest
} from "./chunk-MLHFKDNW.mjs";

// src/manager/index.tsx
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { addons, types, useStorybookApi, useStorybookState } from "storybook/manager-api";
import { useTheme } from "storybook/theming";
import { BoxIcon, CameraIcon, CheckIcon, CommentIcon, CommentsIcon, EyeIcon, EyeCloseIcon, LinkIcon, PinIcon, SyncIcon } from "@storybook/icons";
var ADDON_ID = "annotakit";
var PANEL_ID = `${ADDON_ID}/panel`;
var TOOL_ID = `${ADDON_ID}/tool`;
var AUTHOR_KEY = "annotakit:author";
async function jfetch(url, init) {
  const res = await fetch(url, init);
  const text = await res.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  if (!res.ok) {
    throw new Error(
      body && typeof body === "object" && "error" in body ? String(body.error) : `HTTP ${res.status}${text.slice(0, 120) ? `: ${text.slice(0, 120)}` : ""}`
    );
  }
  return body;
}
var getThreadsAndSnapshots = (storyId) => jfetch(`${API_BASE}/threads${storyId ? `?storyId=${encodeURIComponent(storyId)}` : ""}`).then((b) => {
  const o = b;
  return { threads: o.threads ?? [], snapshots: new Set(o.snapshots ?? []) };
});
var getHealth = () => fetch(`${API_BASE}/health`, { cache: "no-store" }).then((r) => r.ok ? r.json() : null).catch(() => null);
var getExport = (format, storyId) => fetch(
  `${API_BASE}/export?format=${format}${storyId ? `&storyId=${encodeURIComponent(storyId)}` : ""}`,
  { cache: "no-store" }
).then((r) => {
  if (!r.ok) throw new Error(`export failed: HTTP ${r.status}`);
  return r.text();
});
var getSyncStatus = () => fetch(`${API_BASE}/sync`, { cache: "no-store" }).then((r) => r.ok ? r.json() : null).catch(() => null);
var postSync = () => jfetch(`${API_BASE}/sync`, { method: "POST" });
function stableSort(threads) {
  return [...threads].sort((a, b) => {
    const sa = a.story?.title ?? a.storyId;
    const sb = b.story?.title ?? b.storyId;
    if (sa !== sb) return sa < sb ? -1 : 1;
    return (a.number ?? 0) - (b.number ?? 0);
  });
}
function ago(iso) {
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1e3));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  return `${Math.round(s / 3600)}h ago`;
}
function ReviewPanel() {
  const theme = useTheme();
  const storybookApi = useStorybookApi();
  const state = useStorybookState();
  const storyId = state.storyId;
  const [scope, setScope] = useState("story");
  const [filter, setFilter] = useState("all");
  const [sortMode, setSortMode] = useState("story");
  const [threads, setThreads] = useState([]);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [busy, setBusy] = useState(false);
  const [author, setAuthor] = useState("reviewer");
  const [activeThread, setActiveThread] = useState(null);
  const [ghOpen, setGhOpen] = useState(false);
  const [sync, setSync] = useState(null);
  const [syncing, setSyncing] = useState(false);
  const [health, setHealth] = useState(null);
  const [snapshotIds, setSnapshotIds] = useState(/* @__PURE__ */ new Set());
  const [staticMode, setStaticMode] = useState(false);
  const [ghStat, setGhStat] = useState(null);
  const [ghSettingsOpen, setGhSettingsOpen] = useState(false);
  const [ghForm, setGhForm] = useState({});
  const [ghBusy, setGhBusy] = useState(false);
  useEffect(() => {
    try {
      const a = localStorage.getItem(AUTHOR_KEY);
      if (a) setAuthor(a);
    } catch {
    }
  }, []);
  useEffect(() => {
    let alive = true;
    void probeMode().then((m) => {
      if (!alive || m !== "static") return;
      setStaticMode(true);
    });
    void getHealth().then((h) => {
      if (!alive || !h) return;
      setHealth(h);
    });
    void getSyncStatus().then((s) => {
      if (alive && s) setSync(s);
    });
    return () => {
      alive = false;
    };
  }, []);
  useEffect(() => {
    if (!staticMode) return;
    let alive = true;
    let poll;
    void getGhLinkedStaticStore().then((store) => {
      if (!alive) return;
      void ghClientStatus().then((s) => {
        if (alive) setGhStat(s);
      });
      poll = window.setInterval(() => {
        if (!alive) return;
        setGhStat(store.gh?.status() ?? null);
      }, 2e3);
    });
    return () => {
      alive = false;
      if (poll) window.clearInterval(poll);
    };
  }, [staticMode]);
  const refresh = useCallback(async () => {
    try {
      if (staticMode) {
        const store = await getGhLinkedStaticStore();
        setThreads(store.list(scope === "story" ? storyId : void 0));
        setSnapshotIds(/* @__PURE__ */ new Set());
        setError(null);
      } else {
        const { threads: list, snapshots } = await getThreadsAndSnapshots(scope === "story" ? storyId : void 0);
        setThreads(list);
        setSnapshotIds(snapshots);
        setError(null);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
    if (staticMode) return;
    void getSyncStatus().then((s) => {
      if (s) setSync(s);
    });
    void getHealth().then((h) => {
      if (h) setHealth(h);
    });
  }, [scope, storyId, staticMode]);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  useEffect(() => {
    const ch = addons.getChannel();
    const onChange = (payload) => {
      if (scope === "all" || !payload?.storyId || payload.storyId === storyId) void refresh();
    };
    ch.on(THREADS_CHANGED, onChange);
    return () => {
      ch.removeListener(THREADS_CHANGED, onChange);
    };
  }, [scope, storyId, refresh]);
  useEffect(() => {
    if (!staticMode) return;
    let unsub;
    let alive = true;
    void getGhLinkedStaticStore().then((store) => {
      if (!alive) return;
      unsub = store.subscribe(() => void refresh());
    });
    return () => {
      alive = false;
      unsub?.();
    };
  }, [staticMode, refresh]);
  const saveAuthor = (value) => {
    setAuthor(value);
    try {
      localStorage.setItem(AUTHOR_KEY, value);
    } catch {
    }
  };
  const focusThread = (t) => {
    if (t.storyId !== storyId) {
      storybookApi.selectStory(t.storyId);
      const ch = addons.getChannel();
      let attempts = 0;
      const ack = () => {
        attempts = 99;
        ch.removeListener(THREAD_FOCUSED, ack);
      };
      ch.on(THREAD_FOCUSED, ack);
      const emitOnce = () => {
        if (attempts >= 5) {
          ch.removeListener(THREAD_FOCUSED, ack);
          return;
        }
        attempts += 1;
        ch.emit(FOCUS_THREAD, t.id);
        window.setTimeout(emitOnce, 400);
      };
      window.setTimeout(emitOnce, 400);
    } else {
      addons.getChannel().emit(FOCUS_THREAD, t.id);
    }
    setActiveThread(t.id);
  };
  const reply = async (t, body) => {
    if (!body.trim()) return false;
    setBusy(true);
    try {
      if (staticMode) {
        const store = await getGhLinkedStaticStore();
        await store.addComment(t.id, body, author);
        await refresh();
        return true;
      }
      await jfetch(`${API_BASE}/threads/${encodeURIComponent(t.id)}/comments`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ body, author })
      });
      await refresh();
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return false;
    } finally {
      setBusy(false);
    }
  };
  const setStatus = async (t, status) => {
    setBusy(true);
    try {
      const next = {
        ...t,
        status,
        resolvedAt: status === "resolved" ? t.resolvedAt ?? (/* @__PURE__ */ new Date()).toISOString() : void 0
      };
      if (staticMode) {
        const store = await getGhLinkedStaticStore();
        await store.patch(next);
        await refresh();
        return;
      }
      await jfetch(`${API_BASE}/threads/${encodeURIComponent(t.id)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(next)
      });
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const copy = async (text, what) => {
    try {
      await navigator.clipboard.writeText(text);
      setNotice(`${what} copied to clipboard`);
      window.setTimeout(() => setNotice(null), 2500);
    } catch {
      setError("clipboard blocked \u2014 use Download instead");
    }
  };
  const exportAny = async (format) => {
    const list = staticMode ? (await getGhLinkedStaticStore()).list(scope === "story" ? storyId : void 0) : null;
    if (list !== null) {
      return format === "md" ? renderStaticDigest(list, { storageNote: ghStat?.configured ? `mirrored to GitHub (${ghStat.repo}) by this browser` : void 0 }) : JSON.stringify({ generatedAt: (/* @__PURE__ */ new Date()).toISOString(), mode: "static", threads: list }, null, 2);
    }
    return getExport(format, scope === "story" ? storyId : void 0);
  };
  const doExport = (format, sink) => {
    void exportAny(format).then((text) => sink === "copy" ? copy(text, format === "md" ? "markdown digest" : "JSON bundle") : download(text, "annotakit-review.md")).catch((e) => setError(e instanceof Error ? e.message : String(e)));
  };
  const download = (text, filename) => {
    const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  };
  const syncNow = async () => {
    setSyncing(true);
    try {
      if (staticMode) {
        const store = await getGhLinkedStaticStore();
        if (!store.gh) return;
        await store.gh.syncNow();
        const s = store.gh.status();
        setGhStat(s);
        setNotice(
          s.configured ? `client sync: queue ${s.queue}${s.lastError ? ` \xB7 error: ${s.lastError.slice(0, 200)}` : ""}${s.lastPullCount !== void 0 ? ` \xB7 pulled ${s.lastPullCount} from GitHub` : ""}` : "client GitHub publishing not configured \u2014 open GitHub settings below"
        );
        window.setTimeout(() => setNotice(null), 6e3);
        await refresh();
        return;
      }
      const summary = await postSync();
      if (summary.noop) {
        setNotice(`GitHub mirror not configured \u2014 local mode. ${summary.reason ?? ""}`.slice(0, 400));
      } else {
        setNotice(
          `synced: ${summary.created} issue${summary.created === 1 ? "" : "s"} created \xB7 ${summary.pushed} pushed \xB7 ${summary.pulled} pulled from GitHub${summary.stalled ? ` \xB7 ${summary.stalled} stalled (will retry)` : ""}`
        );
      }
      window.setTimeout(() => setNotice(null), 6e3);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSyncing(false);
    }
  };
  const openGhSettings = () => {
    setGhSettingsOpen((v) => !v);
    if (!ghSettingsOpen) {
      setGhForm({
        repo: ghStat?.repo ?? ghForm.repo ?? "",
        labels: ghStat?.labels?.length ? ghStat.labels : ghForm.labels ?? ["annotakit"],
        token: ghForm.token ?? "",
        pollMs: ghStat?.pollMs ?? 6e4,
        disabled: ghStat?.suppressed
      });
    }
  };
  const saveGhSettings = async () => {
    const store = await getGhLinkedStaticStore();
    if (!store.gh) return;
    setGhBusy(true);
    try {
      const labels = String(ghForm.labels ?? "").split(/[,\s]+/).map((l) => l.trim()).filter(Boolean);
      const patch = {};
      if (ghForm.repo) patch.repo = ghForm.repo.trim();
      if (ghForm.token) patch.token = ghForm.token.trim();
      if (labels.length) patch.labels = labels;
      if (ghForm.pollMs !== void 0) patch.pollMs = ghForm.pollMs;
      patch.disabled = ghForm.disabled ? true : void 0;
      store.gh.saveSettings(patch);
      setNotice(`saved \u2014 publishing${patch.disabled ? " disabled" : ` \u2192 ${patch.repo ?? ghStat?.repo ?? "(baked repo)"}`}${labels.length ? ` \xB7 labels: ${labels.join(", ")}` : ""}`);
      window.setTimeout(() => setNotice(null), 5e3);
      const s = await ghClientStatus();
      setGhStat(s);
      await store.gh.syncNow();
      setGhStat(store.gh.status());
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setGhBusy(false);
    }
  };
  const clearGhSettings = async () => {
    const store = await getGhLinkedStaticStore();
    store.gh?.clearSettings();
    setGhForm({});
    setGhStat(await ghClientStatus());
    setNotice("local overrides cleared \u2014 baked config (if any) applies again");
    window.setTimeout(() => setNotice(null), 5e3);
  };
  const ordered = useMemo(
    () => sortMode === "recent" ? [...threads].sort((a, b) => String(b.updatedAt ?? "").localeCompare(String(a.updatedAt ?? ""))) : stableSort(threads),
    [threads, sortMode]
  );
  const shown = useMemo(
    () => ordered.filter((t) => filter === "all" ? true : filter === "open" ? t.status === "open" : t.status === "fixed"),
    [ordered, filter]
  );
  const openCount = ordered.filter((t) => t.status === "open").length;
  const fixedCount = ordered.filter((t) => t.status === "fixed").length;
  const chip = (bg, color) => ({
    background: bg,
    color,
    borderRadius: 999,
    padding: "1px 7px",
    fontSize: 10,
    fontWeight: 700,
    whiteSpace: "nowrap",
    border: `1px solid ${color}33`
  });
  const miniBtn = (bg, active) => ({
    padding: "3px 10px",
    fontSize: 11,
    fontWeight: 700,
    cursor: "pointer",
    border: "none",
    background: active ? bg : "transparent",
    color: active ? "#fff" : theme.textColor
  });
  return /* @__PURE__ */ React.createElement("div", { style: { fontFamily: theme.fontBase, fontSize: 13, padding: "8px 10px", height: "100%", overflow: "auto", color: theme.textColor } }, /* @__PURE__ */ React.createElement("div", { style: { display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap", paddingBottom: 6, borderBottom: `1px solid ${theme.appBorderColor}` } }, /* @__PURE__ */ React.createElement("div", { style: { display: "flex", gap: 0, border: `1px solid ${theme.appBorderColor}`, borderRadius: 7, overflow: "hidden" } }, /* @__PURE__ */ React.createElement("button", { style: miniBtn(theme.colorSecondary, scope === "story"), onClick: () => setScope("story") }, "This story"), /* @__PURE__ */ React.createElement("button", { style: miniBtn(theme.colorSecondary, scope === "all"), onClick: () => setScope("all") }, "All stories")), /* @__PURE__ */ React.createElement("div", { style: { display: "flex", gap: 0, border: `1px solid ${theme.appBorderColor}`, borderRadius: 7, overflow: "hidden" } }, /* @__PURE__ */ React.createElement("button", { style: miniBtn(theme.colorSecondary, filter === "all"), onClick: () => setFilter("all"), title: "Show everything" }, "all"), /* @__PURE__ */ React.createElement("button", { style: miniBtn(theme.colorSecondary, filter === "open"), onClick: () => setFilter("open"), title: "Show only open (agent work queue)" }, "open"), /* @__PURE__ */ React.createElement("button", { style: miniBtn(theme.colorSecondary, filter === "review"), onClick: () => setFilter("review"), title: "Threads the agent marked fixed \u2014 awaiting your verification (the check-latest-batch view)" }, "to review")), /* @__PURE__ */ React.createElement("div", { style: { display: "flex", gap: 0, border: `1px solid ${theme.appBorderColor}`, borderRadius: 7, overflow: "hidden" } }, /* @__PURE__ */ React.createElement("button", { style: miniBtn(theme.colorSecondary, sortMode === "story"), onClick: () => setSortMode("story"), title: "Stable order: story title, then thread number \u2014 resolving never reorders the list" }, "by story"), /* @__PURE__ */ React.createElement("button", { style: miniBtn(theme.colorSecondary, sortMode === "recent"), onClick: () => setSortMode("recent"), title: "Most recently touched first (replies, status flips) \u2014 the what-was-addressed-since-my-last-visit view" }, "recent")), /* @__PURE__ */ React.createElement("span", { style: { fontSize: 11, color: theme.textMutedColor } }, threads.length ? `${openCount} open${fixedCount > 0 ? ` \xB7 ${fixedCount} to review` : ""} / ${threads.length} threads` : "no threads"), /* @__PURE__ */ React.createElement("span", { style: { flex: 1 } }), /* @__PURE__ */ React.createElement(
    "input",
    {
      style: { padding: "3px 8px", fontSize: 11, borderRadius: 6, border: `1px solid ${theme.inputBorder || theme.appBorderColor}`, background: theme.inputBackground || "transparent", color: theme.textColor, width: 110 },
      value: author,
      onChange: (e) => saveAuthor(e.target.value),
      placeholder: "your name",
      title: "Author name (shared with the preview composer)"
    }
  ), /* @__PURE__ */ React.createElement("button", { style: { padding: "3px 9px", fontSize: 11, fontWeight: 600, cursor: "pointer", borderRadius: 6, border: `1px solid ${theme.appBorderColor}`, background: "transparent", color: theme.textColor }, onClick: () => setGhOpen((v) => !v), title: "GitHub lifecycle sync", hidden: staticMode }, /* @__PURE__ */ React.createElement("span", { style: { display: "inline-flex", gap: 4, alignItems: "center" } }, /* @__PURE__ */ React.createElement(SyncIcon, { width: 12, height: 12 }), " GitHub", sync && sync.mode === "auto" && !sync.lastError && /* @__PURE__ */ React.createElement("span", { style: { width: 6, height: 6, borderRadius: 999, background: theme.colorPositive, display: "inline-block" } }), sync?.lastError && /* @__PURE__ */ React.createElement("span", { style: { width: 6, height: 6, borderRadius: 999, background: theme.colorNegative, display: "inline-block" }, title: "sync error \u2014 open for details" }), sync && sync.mode !== "auto" && !sync.lastError && /* @__PURE__ */ React.createElement("span", { style: { width: 6, height: 6, borderRadius: 999, background: "#f59e0b", display: "inline-block" }, title: sync.mode === "unconfigured" ? "local mode \u2014 GitHub mirror not configured" : "mirror disabled" }))), staticMode && ghStat?.configured && !ghStat.suppressed && /* @__PURE__ */ React.createElement(
    "button",
    {
      style: { padding: "3px 9px", fontSize: 11, fontWeight: 600, cursor: "pointer", borderRadius: 6, border: `1px solid ${theme.appBorderColor}`, background: "transparent", color: theme.textColor, display: "inline-flex", gap: 4, alignItems: "center" },
      onClick: () => void syncNow(),
      disabled: syncing,
      title: "Flush the client queue + pull remote changes now"
    },
    /* @__PURE__ */ React.createElement(SyncIcon, { width: 12, height: 12 }),
    " sync"
  ), staticMode && /* @__PURE__ */ React.createElement(
    "button",
    {
      style: { padding: "3px 9px", fontSize: 11, fontWeight: 600, cursor: "pointer", borderRadius: 6, border: `1px solid ${ghStat?.configured ? "#16a34a66" : theme.appBorderColor}`, background: ghStat?.configured && !ghStat.suppressed ? "#16a34a18" : "transparent", color: ghStat?.configured && !ghStat.suppressed ? "#15803d" : theme.textColor, display: "inline-flex", gap: 4, alignItems: "center" },
      onClick: openGhSettings,
      title: "Client-side GitHub publishing (static builds): issue repo, labels, token"
    },
    /* @__PURE__ */ React.createElement(SyncIcon, { width: 12, height: 12 }),
    " GitHub",
    ghStat?.lastError && /* @__PURE__ */ React.createElement("span", { style: { width: 6, height: 6, borderRadius: 999, background: theme.colorNegative, display: "inline-block" } })
  ), staticMode && !ghStat?.configured && /* @__PURE__ */ React.createElement("span", { style: { ...chip("#f59e0b22", "#b45309"), fontSize: 10 }, title: "Static `storybook build` \u2014 no dev server. Threads live in this browser's localStorage for this deployment. Configure client-side GitHub publishing (GitHub button) to land feedback as issues straight from the browser." }, "static \xB7 local-only"), staticMode && ghStat?.configured && /* @__PURE__ */ React.createElement(
    "span",
    {
      style: {
        ...chip(
          ghStat.suppressed ? "#92400e22" : ghStat.lastError ? "#dc262622" : ghStat.queue > 0 ? "#f59e0b22" : "#16a34a22",
          ghStat.suppressed ? "#b45309" : ghStat.lastError ? "#b91c1c" : ghStat.queue > 0 ? "#b45309" : "#15803d"
        ),
        fontSize: 10
      },
      title: `Client-side publishing${ghStat.suppressed ? " \u2014 DISABLED by local settings (queued feedback holds until re-enabled)" : ` \u2192 ${ghStat.repo ?? "(not set)"} \xB7 labels: ${(ghStat.labels ?? []).join(", ") || "annotakit"} \xB7 queue: ${ghStat.queue}${ghStat.flushing ? " (flushing)" : ""}${ghStat.parked ? ` \xB7 parked: ${ghStat.parked}` : ""}`}${ghStat.lastError ? ` \xB7 error: ${ghStat.lastError}` : ""}${ghStat.lastPushAt && !ghStat.suppressed ? ` \xB7 pushed ${ago(ghStat.lastPushAt)}` : ""}${ghStat.lastPullAt && !ghStat.suppressed ? ` \xB7 pulled ${ago(ghStat.lastPullAt)}` : ""}`
    },
    ghStat.suppressed ? `static \xB7 client GH off${ghStat.queue > 0 ? ` \xB7 ${ghStat.queue} queued` : ""}` : ghStat.lastError ? `static \u2192 github \xB7 error${ghStat.queue > 0 ? ` \xB7 queued ${ghStat.queue}` : ""}` : ghStat.queue > 0 ? `static \u2192 github \xB7 queued ${ghStat.queue}` : "static \u2192 github"
  )), ghOpen && !staticMode && /* @__PURE__ */ React.createElement("div", { style: { padding: "8px 0", borderBottom: `1px solid ${theme.appBorderColor}`, fontSize: 11, display: "flex", flexDirection: "column", gap: 4 } }, /* @__PURE__ */ React.createElement("div", { style: { display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" } }, sync ? /* @__PURE__ */ React.createElement(React.Fragment, null, /* @__PURE__ */ React.createElement("span", { style: { ...chip(sync.mode === "auto" ? `${theme.colorPositive}22` : "#f59e0b22", sync.mode === "auto" ? theme.colorPositive : "#b45309") } }, sync.mode === "auto" ? "auto-sync" : sync.mode === "unconfigured" ? "local mode" : "mirror off"), /* @__PURE__ */ React.createElement("span", { style: { color: theme.textMutedColor } }, sync.mode === "auto" && /* @__PURE__ */ React.createElement(React.Fragment, null, sync.mapped, "/", sync.threads, " threads mirrored", sync.pending > 0 ? ` \xB7 ${sync.pending} queued` : "", sync.stalled > 0 ? ` \xB7 ${sync.stalled} stalled` : "", sync.lastPushAt ? ` \xB7 pushed ${ago(sync.lastPushAt)}` : "", sync.lastPullAt ? ` \xB7 pulled ${ago(sync.lastPullAt)}` : "", sync.pollSec > 0 ? ` \xB7 polls every ${sync.pollSec}s` : "", sync.labels && sync.labels.length ? ` \xB7 labels: ${sync.labels.join(", ")}` : ""), sync.backoffUntil && /* @__PURE__ */ React.createElement(React.Fragment, null, sync.lastError ? " \xB7 " : "", "backoff until ", new Date(sync.backoffUntil).toLocaleTimeString()))) : /* @__PURE__ */ React.createElement("span", { style: { color: theme.textMutedColor } }, "sync status unavailable (dev server offline?)"), /* @__PURE__ */ React.createElement("span", { style: { flex: 1 } }), /* @__PURE__ */ React.createElement(
    "button",
    {
      style: { padding: "3px 10px", fontSize: 11, fontWeight: 700, cursor: syncing ? "default" : "pointer", borderRadius: 6, border: "none", background: theme.colorSecondary, color: "#fff", display: "inline-flex", gap: 4, alignItems: "center" },
      disabled: syncing,
      onClick: () => void syncNow(),
      title: "Force reconcile both directions \u2014 idempotent, never duplicates issues"
    },
    /* @__PURE__ */ React.createElement(SyncIcon, { width: 11, height: 11 }),
    " ",
    syncing ? "syncing\u2026" : "Sync now"
  )), sync?.lastError && /* @__PURE__ */ React.createElement("div", { style: { padding: "4px 8px", borderRadius: 6, background: `${theme.colorNegative}18`, color: theme.colorNegative, whiteSpace: "pre-wrap" } }, "last sync error: ", sync.lastError), sync?.note && /* @__PURE__ */ React.createElement("span", { style: { fontSize: 10, color: theme.textMutedColor, whiteSpace: "pre-wrap" } }, sync.note), /* @__PURE__ */ React.createElement("span", { style: { fontSize: 10, color: theme.textMutedColor } }, health?.agentSurfaces?.github ? /* @__PURE__ */ React.createElement(React.Fragment, null, "repo: ", /* @__PURE__ */ React.createElement("b", null, health.gh?.repo), " \xB7 durability: ", health.agentSurfaces.durability, " \xB7 store: ", health.gh?.autoSync) : health?.agentSurfaces ? /* @__PURE__ */ React.createElement(React.Fragment, null, "local mode \u2014 reviews live here (REST + digests); GitHub mirror: ", health.agentSurfaces.githubReason ?? "off", health.agentSurfaces.durability ? ` \xB7 durability: ${health.agentSurfaces.durability}` : "") : "set ANNOTAKIT_GH_TOKEN in .env (auto-loaded) \xB7 repo auto-detected from git remote"), /* @__PURE__ */ React.createElement("span", { style: { fontSize: 10, color: theme.textMutedColor } }, "Every thread mirrors to exactly ONE issue \u2014 status (open/resolved), replies and fix evidence sync both ways automatically. \u201CSync now\u201D only reconciles; it never creates a duplicate issue.")), ghSettingsOpen && staticMode && /* @__PURE__ */ React.createElement("div", { style: { padding: "8px 0", borderBottom: `1px solid ${theme.appBorderColor}`, fontSize: 11, display: "flex", flexDirection: "column", gap: 6 } }, /* @__PURE__ */ React.createElement("div", { style: { display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" } }, /* @__PURE__ */ React.createElement("span", { style: { ...chip(ghStat?.configured && !ghStat.suppressed ? "#16a34a22" : "#f59e0b22", ghStat?.configured && !ghStat.suppressed ? "#15803d" : "#b45309") } }, ghStat?.configured ? ghStat.suppressed ? "client GH disabled" : `client publish \u2192 ${ghStat.repo ?? "(not set)"}` : "client GH unconfigured"), ghStat?.configured && !ghStat.suppressed && /* @__PURE__ */ React.createElement("span", { style: { color: theme.textMutedColor } }, "queue ", ghStat.queue, ghStat.flushing ? " (flushing)" : "", ghStat.parked ? ` \xB7 parked ${ghStat.parked}` : "", ghStat.lastPushAt ? ` \xB7 pushed ${ago(ghStat.lastPushAt)}` : "", ghStat.lastPullAt ? ` \xB7 pulled ${ago(ghStat.lastPullAt)}` : "", ghStat.pollMs > 0 ? ` \xB7 polls every ${Math.round(ghStat.pollMs / 1e3)}s` : " \xB7 polling off")), ghStat?.lastError && /* @__PURE__ */ React.createElement("div", { style: { padding: "4px 8px", borderRadius: 6, background: `${theme.colorNegative}18`, color: theme.colorNegative, whiteSpace: "pre-wrap" } }, ghStat.lastError), /* @__PURE__ */ React.createElement("label", { style: { display: "flex", gap: 6, alignItems: "center" } }, /* @__PURE__ */ React.createElement("span", { style: { width: 88, color: theme.textMutedColor } }, "issue repo"), /* @__PURE__ */ React.createElement(
    "input",
    {
      style: { flex: 1, padding: "3px 8px", fontSize: 11, borderRadius: 6, border: `1px solid ${theme.inputBorder || theme.appBorderColor}`, background: theme.inputBackground || "transparent", color: theme.textColor },
      value: String(ghForm.repo ?? ""),
      onChange: (e) => setGhForm((f) => ({ ...f, repo: e.target.value })),
      placeholder: "owner/name \u2014 the repo where issues land (can differ from the site's repo)",
      spellCheck: false
    }
  )), /* @__PURE__ */ React.createElement("label", { style: { display: "flex", gap: 6, alignItems: "center" } }, /* @__PURE__ */ React.createElement("span", { style: { width: 88, color: theme.textMutedColor } }, "labels"), /* @__PURE__ */ React.createElement(
    "input",
    {
      style: { flex: 1, padding: "3px 8px", fontSize: 11, borderRadius: 6, border: `1px solid ${theme.inputBorder || theme.appBorderColor}`, background: theme.inputBackground || "transparent", color: theme.textColor },
      value: Array.isArray(ghForm.labels) ? ghForm.labels.join(", ") : String(ghForm.labels ?? ""),
      onChange: (e) => setGhForm((f) => ({ ...f, labels: e.target.value.split(/[, ]+/).filter(Boolean) })),
      placeholder: "annotakit, workstream:payments \u2014 ALL applied on create, filter uses them all",
      spellCheck: false
    }
  )), /* @__PURE__ */ React.createElement("label", { style: { display: "flex", gap: 6, alignItems: "center" } }, /* @__PURE__ */ React.createElement("span", { style: { width: 88, color: theme.textMutedColor } }, "token (PAT)"), /* @__PURE__ */ React.createElement(
    "input",
    {
      type: "password",
      style: { flex: 1, padding: "3px 8px", fontSize: 11, borderRadius: 6, border: `1px solid ${theme.inputBorder || theme.appBorderColor}`, background: theme.inputBackground || "transparent", color: theme.textColor },
      value: String(ghForm.token ?? ""),
      onChange: (e) => setGhForm((f) => ({ ...f, token: e.target.value })),
      placeholder: "classic PAT with repo scope \u2014 empty keeps the baked token",
      spellCheck: false,
      autoComplete: "off"
    }
  )), /* @__PURE__ */ React.createElement("div", { style: { display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" } }, /* @__PURE__ */ React.createElement("label", { style: { display: "flex", gap: 6, alignItems: "center" } }, /* @__PURE__ */ React.createElement("span", { style: { color: theme.textMutedColor } }, "poll (s)"), /* @__PURE__ */ React.createElement(
    "input",
    {
      style: { width: 60, padding: "3px 8px", fontSize: 11, borderRadius: 6, border: `1px solid ${theme.inputBorder || theme.appBorderColor}`, background: theme.inputBackground || "transparent", color: theme.textColor },
      value: String(Math.round((ghForm.pollMs ?? 6e4) / 1e3)),
      onChange: (e) => {
        const n = Number.parseInt(e.target.value, 10);
        setGhForm((f) => ({ ...f, pollMs: Number.isFinite(n) && n >= 0 ? n * 1e3 : 6e4 }));
      },
      title: "How often to pull remote replies/state \u2014 0 disables polling (manual sync only)"
    }
  )), /* @__PURE__ */ React.createElement("label", { style: { display: "flex", gap: 4, alignItems: "center", color: theme.textMutedColor } }, /* @__PURE__ */ React.createElement("input", { type: "checkbox", checked: Boolean(ghForm.disabled), onChange: (e) => setGhForm((f) => ({ ...f, disabled: e.target.checked })) }), "disable client publishing (local-only)"), /* @__PURE__ */ React.createElement("span", { style: { flex: 1 } }), /* @__PURE__ */ React.createElement(
    "button",
    {
      style: { padding: "4px 12px", fontSize: 11, fontWeight: 700, cursor: ghBusy ? "default" : "pointer", borderRadius: 6, border: "none", background: theme.colorSecondary, color: "#fff" },
      disabled: ghBusy,
      onClick: () => void saveGhSettings()
    },
    ghBusy ? "saving\u2026" : "Save & sync"
  ), /* @__PURE__ */ React.createElement(
    "button",
    {
      style: { padding: "4px 12px", fontSize: 11, fontWeight: 600, cursor: "pointer", borderRadius: 6, border: `1px solid ${theme.appBorderColor}`, background: "transparent", color: theme.textColor },
      onClick: () => void clearGhSettings(),
      title: "Remove localStorage overrides \u2014 the baked annotakit-gh.json applies again"
    },
    "Reset"
  )), /* @__PURE__ */ React.createElement("span", { style: { fontSize: 10, color: theme.textMutedColor } }, "Saved overrides live in THIS browser for THIS deployment (localStorage). Every thread mirrors to exactly ONE issue; queued feedback flushes on the next page load even after crashes. Multiple workstreams on one repo: give each a distinct label set here.")), error && /* @__PURE__ */ React.createElement("div", { style: { margin: "6px 0", padding: "5px 8px", fontSize: 11, borderRadius: 6, background: `${theme.colorNegative}22`, color: theme.colorNegative, whiteSpace: "pre-wrap" } }, error), notice && /* @__PURE__ */ React.createElement("div", { style: { margin: "6px 0", padding: "5px 8px", fontSize: 11, borderRadius: 6, background: `${theme.colorPositive}22`, color: theme.colorPositive } }, notice), shown.length === 0 && /* @__PURE__ */ React.createElement("div", { style: { padding: "12px 4px", fontSize: 12, color: theme.textMutedColor } }, threads.length === 0 ? scope === "story" ? /* @__PURE__ */ React.createElement(React.Fragment, null, "No threads for this story. Press ", /* @__PURE__ */ React.createElement("b", null, "\u2325C"), " (Alt+C) in the canvas and click an element \u2014 or ", /* @__PURE__ */ React.createElement("b", null, "\u2325R"), " to drag a region. Everything saves automatically to the dev-server store.") : /* @__PURE__ */ React.createElement(React.Fragment, null, "No threads yet. Press ", /* @__PURE__ */ React.createElement("b", null, "\u2325C"), " (Alt+C) in the canvas and click an element.") : filter === "open" ? /* @__PURE__ */ React.createElement(React.Fragment, null, "Nothing open \u2014 everything is fixed (awaiting review) or resolved. Switch the filter to \u201Cto review\u201D or \u201Call\u201D.") : filter === "review" ? /* @__PURE__ */ React.createElement(React.Fragment, null, "Nothing awaiting review \u2014 no agent fixes pending.") : /* @__PURE__ */ React.createElement(React.Fragment, null, "All threads resolved \u{1F389}.")), shown.map((t) => {
    const active = t.id === activeThread;
    return /* @__PURE__ */ React.createElement(
      "div",
      {
        key: t.id,
        style: {
          padding: "6px 6px 6px 8px",
          margin: "5px 0",
          borderRadius: 7,
          border: `1px solid ${active ? theme.colorSecondary : theme.appBorderColor}`,
          background: active ? `${theme.colorSecondary}11` : "transparent",
          cursor: "pointer",
          opacity: t.status === "resolved" ? 0.75 : 1
        },
        onClick: () => focusThread(t)
      },
      /* @__PURE__ */ React.createElement("div", { style: { display: "flex", gap: 6, alignItems: "center" } }, /* @__PURE__ */ React.createElement(
        "span",
        {
          style: chip(
            t.status === "open" ? "#f59e0b22" : t.status === "fixed" ? "#2563eb22" : "#16a34a22",
            t.status === "open" ? "#b45309" : t.status === "fixed" ? "#1d4ed8" : "#15803d"
          ),
          title: t.status === "fixed" ? "addressed by the agent \u2014 awaiting your verification" : t.status
        },
        "#",
        t.number,
        " ",
        t.status === "open" ? "open" : t.status === "fixed" ? "fixed" : "resolved"
      ), t.gh?.url && /* @__PURE__ */ React.createElement(
        "a",
        {
          href: t.gh.url,
          target: "_blank",
          rel: "noreferrer",
          title: `GitHub issue #${t.gh.issue} \u2014 mirrors this thread's lifecycle (open/closed + replies)`,
          style: { ...chip(`${theme.colorSecondary}18`, theme.colorSecondary), textDecoration: "none", display: "inline-flex", gap: 3, alignItems: "center", cursor: "pointer" },
          onClick: (e) => e.stopPropagation()
        },
        /* @__PURE__ */ React.createElement(LinkIcon, { width: 10, height: 10 }),
        " ",
        t.gh.issue
      ), t.component?.name && /* @__PURE__ */ React.createElement("span", { style: chip(`${theme.colorSecondary}18`, theme.colorSecondary) }, t.component.name), snapshotIds.has(t.id) && /* @__PURE__ */ React.createElement(
        "a",
        {
          href: `${API_BASE}/threads/${encodeURIComponent(t.id)}/snapshot?format=html`,
          target: "_blank",
          rel: "noreferrer",
          title: "Plan-b evidence: story DOM captured at pin time (pinned element highlighted) \u2014 opens as a viewable page",
          style: { ...chip("#d9770618", "#b45309"), textDecoration: "none", display: "inline-flex", gap: 3, alignItems: "center", cursor: "pointer" },
          onClick: (e) => e.stopPropagation()
        },
        /* @__PURE__ */ React.createElement(CameraIcon, { width: 10, height: 10 }),
        " dom"
      ), scope === "all" && t.story.name && /* @__PURE__ */ React.createElement("span", { style: chip("#64748b18", theme.textMutedColor) }, t.story.name), /* @__PURE__ */ React.createElement("span", { style: { flex: 1 } }), /* @__PURE__ */ React.createElement("span", { style: { fontSize: 10, color: theme.textMutedColor } }, t.createdAt.slice(0, 10))),
      /* @__PURE__ */ React.createElement("div", { style: { fontSize: 12, marginTop: 3, color: theme.textColor, textDecoration: t.status === "resolved" ? "line-through" : "none" } }, t.comments[0]?.body?.split("\n")[0]?.slice(0, 140) ?? "(no text)"),
      t.component?.source && /* @__PURE__ */ React.createElement("div", { style: { fontSize: 10.5, color: theme.textMutedColor, fontFamily: theme.fontMonospace, marginTop: 2 } }, t.component.source.file, t.component.source.line ? `:${t.component.source.line}` : ""),
      t.comments.length > 1 && /* @__PURE__ */ React.createElement("div", { style: { fontSize: 10.5, color: theme.textMutedColor, marginTop: 2 } }, "+", t.comments.length - 1, " replies"),
      /* @__PURE__ */ React.createElement(ThreadActions, { thread: t, busy, onReply: reply, onSetStatus: setStatus, active })
    );
  }), /* @__PURE__ */ React.createElement(
    "div",
    {
      style: { display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap", paddingTop: 8, marginTop: 6, borderTop: `1px solid ${theme.appBorderColor}`, position: "sticky", bottom: 0, background: theme.backgroundBar ?? theme.background }
    },
    /* @__PURE__ */ React.createElement("span", { style: { fontSize: 10.5, color: theme.textMutedColor, display: "inline-flex", gap: 4, alignItems: "center" } }, /* @__PURE__ */ React.createElement(CommentIcon, { width: 11, height: 11 }), " agent digest:"),
    /* @__PURE__ */ React.createElement(MiniButton, { theme, onClick: () => doExport("md", "copy") }, "copy md"),
    /* @__PURE__ */ React.createElement(MiniButton, { theme, onClick: () => doExport("json", "copy") }, "copy json"),
    /* @__PURE__ */ React.createElement(MiniButton, { theme, onClick: () => doExport("md", "download") }, "download md"),
    /* @__PURE__ */ React.createElement("span", { style: { flex: 1 } }),
    /* @__PURE__ */ React.createElement("span", { style: { fontSize: 10, color: theme.textMutedColor, fontFamily: theme.fontMonospace } }, staticMode ? "static build \xB7 digest generated locally from this browser's store" : `curl ${API_BASE}/export?format=md`)
  ));
}
function ThreadActions(props) {
  const [body, setBody] = useState("");
  const theme = useTheme();
  if (!props.active) return /* @__PURE__ */ React.createElement(React.Fragment, null);
  return /* @__PURE__ */ React.createElement("div", { style: { display: "flex", gap: 6, marginTop: 6 }, onClick: (e) => e.stopPropagation() }, /* @__PURE__ */ React.createElement(
    "input",
    {
      style: { flex: 1, padding: "3px 8px", fontSize: 12, borderRadius: 6, border: `1px solid ${theme.appBorderColor}`, background: "transparent", color: theme.textColor },
      placeholder: "reply\u2026",
      value: body,
      onChange: (e) => setBody(e.target.value),
      onKeyDown: (e) => {
        if (e.key === "Enter" && body.trim() && !props.busy) {
          void props.onReply(props.thread, body).then((ok) => {
            if (ok) setBody("");
          });
        }
      }
    }
  ), props.thread.status === "open" && /* @__PURE__ */ React.createElement(
    "button",
    {
      style: { padding: "3px 9px", fontSize: 11, fontWeight: 600, cursor: props.busy ? "default" : "pointer", borderRadius: 6, border: "1px solid #86efac", background: "transparent", color: "#15803d", display: "inline-flex", gap: 4, alignItems: "center" },
      disabled: props.busy,
      onClick: () => props.onSetStatus(props.thread, "resolved"),
      title: "Resolve (reviewer-confirmed)"
    },
    /* @__PURE__ */ React.createElement(CheckIcon, { width: 11, height: 11 }),
    "resolve"
  ), props.thread.status === "fixed" && /* @__PURE__ */ React.createElement(React.Fragment, null, /* @__PURE__ */ React.createElement(
    "button",
    {
      style: { padding: "3px 9px", fontSize: 11, fontWeight: 600, cursor: props.busy ? "default" : "pointer", borderRadius: 6, border: "1px solid #86efac", background: "transparent", color: "#15803d", display: "inline-flex", gap: 4, alignItems: "center" },
      disabled: props.busy,
      onClick: () => props.onSetStatus(props.thread, "resolved"),
      title: "Confirm the fix \u2014 the agent addressed this, you verified it"
    },
    /* @__PURE__ */ React.createElement(CheckIcon, { width: 11, height: 11 }),
    "confirm"
  ), /* @__PURE__ */ React.createElement(
    "button",
    {
      style: { padding: "3px 9px", fontSize: 11, fontWeight: 600, cursor: props.busy ? "default" : "pointer", borderRadius: 6, border: "1px solid #fecaca", background: "transparent", color: "#b91c1c", display: "inline-flex", gap: 4, alignItems: "center" },
      disabled: props.busy,
      onClick: () => props.onSetStatus(props.thread, "open"),
      title: "Reject \u2014 back to open (reply with why)"
    },
    "reject"
  )), props.thread.status === "resolved" && /* @__PURE__ */ React.createElement(
    "button",
    {
      style: { padding: "3px 9px", fontSize: 11, fontWeight: 600, cursor: props.busy ? "default" : "pointer", borderRadius: 6, border: "1px solid #fecaca", background: "transparent", color: "#b91c1c", display: "inline-flex", gap: 4, alignItems: "center" },
      disabled: props.busy,
      onClick: () => props.onSetStatus(props.thread, "open")
    },
    "reopen"
  ));
}
function MiniButton(props) {
  return /* @__PURE__ */ React.createElement(
    "button",
    {
      style: { padding: "2px 8px", fontSize: 10.5, fontWeight: 600, cursor: "pointer", borderRadius: 6, border: `1px solid ${props.theme.appBorderColor}`, background: "transparent", color: props.theme.textColor },
      onClick: props.onClick
    },
    props.children
  );
}
function AnnotaKitTool() {
  const theme = useTheme();
  const [ui, setUi] = useState(null);
  useEffect(() => {
    const ch = addons.getChannel();
    const onState = (s) => {
      if (s && typeof s === "object") setUi(s);
    };
    ch.on(UI_STATE, onState);
    return () => {
      ch.removeListener(UI_STATE, onState);
    };
  }, []);
  const emit = useCallback((command) => {
    addons.getChannel().emit(UI_COMMAND, { command });
  }, []);
  const apiDown = ui?.apiOk === false;
  const armed = (on) => ({
    color: on ? theme.barSelectedColor : theme.barTextColor,
    opacity: on ? 1 : 0.75
  });
  const btn = (label, icon, on, onClick) => /* @__PURE__ */ React.createElement(
    "button",
    {
      key: label,
      title: apiDown ? "Annotakit: dev server API down \u2014 run `storybook dev`" : label,
      "aria-label": label,
      disabled: apiDown,
      style: {
        background: "transparent",
        border: "none",
        padding: 4,
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        cursor: apiDown ? "default" : "pointer",
        ...armed(on)
      },
      onClick
    },
    icon
  );
  const open = ui?.open ?? 0;
  const fixed = ui?.fixed ?? 0;
  const total = ui?.total ?? 0;
  const drawerOn = ui?.drawerOpen === true;
  return /* @__PURE__ */ React.createElement("div", { key: "annotakit-tool", style: { display: "inline-flex", alignItems: "center", gap: 2 } }, btn("Pin a comment to an element (\u2325C)", /* @__PURE__ */ React.createElement(PinIcon, { width: 14, height: 14 }), ui?.mode === "pin", () => emit("pin")), btn("Mark a region (\u2325R)", /* @__PURE__ */ React.createElement(BoxIcon, { width: 14, height: 14 }), ui?.mode === "region", () => emit("region")), /* @__PURE__ */ React.createElement(
    "button",
    {
      key: "annotakit-drawer",
      title: apiDown ? "Annotakit: dev server API down \u2014 run `storybook dev`" : "Threads drawer (\u2325D)",
      "aria-label": "Annotakit threads drawer",
      disabled: apiDown,
      style: {
        background: "transparent",
        border: "none",
        padding: 4,
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        cursor: apiDown ? "default" : "pointer",
        ...armed(drawerOn)
      },
      onClick: () => emit("drawer")
    },
    /* @__PURE__ */ React.createElement(CommentsIcon, { width: 14, height: 14 }),
    total > 0 && /* @__PURE__ */ React.createElement(
      "span",
      {
        title: open > 0 ? `${open} open \xB7 ${fixed} fixed (awaiting review) \xB7 ${total} total` : fixed > 0 ? `${fixed} fixed \u2014 awaiting your review (${total} total)` : `${total} threads, all resolved`,
        style: {
          // v0.6.3: amber = agent work queued, blue = fixes awaiting the
          // reviewer's verification (0 open + N fixed is NOT "nothing to do")
          background: open > 0 ? "#d97706" : fixed > 0 ? "#2563eb" : "#94a3b8",
          color: "#fff",
          borderRadius: 999,
          minWidth: 16,
          height: 16,
          lineHeight: "16px",
          textAlign: "center",
          fontSize: 10,
          padding: "0 4px",
          fontWeight: 700
        }
      },
      open > 0 ? open : fixed > 0 ? fixed : total
    )
  ), /* @__PURE__ */ React.createElement("span", { key: "annotakit-sep", style: { width: 1, height: 16, background: theme.appBorderColor, margin: "0 4px" } }), btn(
    ui?.visible === false ? "Show Annotakit pins (\u2325L)" : "Hide Annotakit pins (\u2325L)",
    ui?.visible === false ? /* @__PURE__ */ React.createElement(EyeCloseIcon, { width: 14, height: 14 }) : /* @__PURE__ */ React.createElement(EyeIcon, { width: 14, height: 14 }),
    ui?.visible !== false,
    () => emit("layer")
  ));
}
addons.register(ADDON_ID, () => {
  addons.add(PANEL_ID, {
    type: types.PANEL,
    title: "Annotakit",
    match: ({ viewMode }) => viewMode === "story",
    render: ({ active }) => active ? /* @__PURE__ */ React.createElement(ReviewPanel, null) : null
  });
  addons.add(TOOL_ID, {
    type: types.TOOL,
    title: "Annotakit",
    match: ({ viewMode }) => viewMode === "story",
    render: () => /* @__PURE__ */ React.createElement(AnnotaKitTool, null)
  });
});
