/* ============================================================================
 * static-api.js — browser-side implementation of the OmniFlow Studio HTTP API
 * ----------------------------------------------------------------------------
 * Purpose: serve the *unmodified* OmniFlow Studio client (`app.js`) from a purely
 * static host (GitHub Pages) with no backend, while keeping the real behaviour.
 *
 * How it stays faithful:
 *   - The layout / validation / analysis / export algorithms are OmniFlow's own
 *     browser-safe modules (`lib/graph-core.js`, `lib/graph-analysis.js`,
 *     `lib/group-suggest.js`, `lib/converters.js`) — the same files the Node
 *     server uses, imported verbatim. Nothing is reimplemented by hand.
 *   - Response envelopes replicate `studio/server.mjs` (`graphDetail`,
 *     `mutateGraph`, the per-action shapes) exactly as captured from the live
 *     server.
 *   - Read data comes from a build-time snapshot in `data/`.
 *
 * What is different from the local server (and is stated in the UI):
 *   - Writes cannot be persisted server-side. Mutations are applied to an
 *     in-memory copy and mirrored to localStorage under a per-graph overlay, so
 *     they survive a reload in *this* browser only. Visitors never see each
 *     other's edits, and the published snapshot is never modified.
 *
 * Must be loaded BEFORE app.js.
 * ========================================================================== */
(function () {
  "use strict";

  var SELF = document.currentScript;
  var SITE = new URL("../", SELF ? SELF.src : location.href); // site root (script lives in assets/)

  /* ---------------------------------------------------------- cache busting */
  /* Cloudflare was serving assets/app.js with max-age=14400 (4h), so a fixed
   * bug kept being served from cache and a deploy looked like it "did nothing".
   * The build stamps a content hash here and every subresource request below
   * carries it, so a changed file is always fetched. Replaced at build time. */
  var V = "f68175d5";
  var Q = V && V.indexOf("@@") !== 0 ? "?v=" + V : "";

  /* ------------------------------------------------- published-site defaults */
  /* app.js reads its language and theme from localStorage and hard-defaults the
   * language to zh (`let LANG = localStorage.getItem("of-lang") || "zh"`).
   * This site is an English showcase, so seed the defaults — but only when the
   * visitor has no stored preference, so the in-app toggles keep working. */
  try {
    if (!localStorage.getItem("of-lang")) localStorage.setItem("of-lang", "en");
    if (!localStorage.getItem("of-theme")) localStorage.setItem("of-theme", "dark");
  } catch (e) { /* private mode: fall back to app defaults */ }

  /* The real fetch, captured before we replace it. */
  var realFetch = window.fetch.bind(window);
  var realEventSource = window.EventSource;

  var DATA = new URL("data/", SITE).href;
  var OVERLAY_KEY = "mathflow.overlay.v1";

  /* ------------------------------------------------------------------ libs */
  /* Dynamic import: app.js is a classic, non-deferred script and runs before
   * deferred modules. Every handler awaits this promise, so ordering is safe.
   * The modules live next to this script, under assets/lib/. */
  var LIB = new URL("lib/", SELF ? new URL(".", SELF.src) : new URL("assets/", location.href)).href;
  var libsReady = Promise.all([
    import(LIB + "graph-core.js" + Q),
    import(LIB + "graph-analysis.js" + Q),
    import(LIB + "group-suggest.js" + Q),
    import(LIB + "converters.js" + Q),
  ]).then(function (m) {
    return { core: m[0], an: m[1], gs: m[2], cv: m[3] };
  });

  /* ----------------------------------------------------------------- state */
  var index = null;                 // data/index.json
  var bundles = new Map();          // graphId -> { detail, validate, analyze, notes }
  var graphs = new Map();           // graphId -> live graph object (snapshot + overlay)
  var overlay = readOverlay();      // { graphId: { graph, notes } }
  var overlayDirty = new Set();

  function readOverlay() {
    try { return JSON.parse(localStorage.getItem(OVERLAY_KEY) || "{}"); } catch (e) { return {}; }
  }
  function writeOverlay() {
    try {
      var out = {};
      overlayDirty.forEach(function (id) { if (overlay[id]) out[id] = overlay[id]; });
      localStorage.setItem(OVERLAY_KEY, JSON.stringify(out));
    } catch (e) { /* quota or private mode: edits stay in memory only */ }
  }

  /* ------------------------------------------------------------ data loading */
  function jsonFetch(url) {
    return realFetch(url).then(function (r) {
      if (!r.ok) throw new Error("HTTP " + r.status + " for " + url);
      return r.json();
    });
  }

  function loadIndex() {
    if (index) return Promise.resolve(index);
    return jsonFetch(DATA + "index.json" + Q).then(function (d) { index = d; return d; });
  }

  function loadBundle(id) {
    if (bundles.has(id)) return Promise.resolve(bundles.get(id));
    return jsonFetch(DATA + "g/" + encodeURIComponent(id) + ".json" + Q).then(function (b) {
      bundles.set(id, b);
      return b;
    });
  }

  /* Live graph = published snapshot + this browser's local edits. */
  function liveGraph(id) {
    if (graphs.has(id)) return Promise.resolve(graphs.get(id));
    return loadBundle(id).then(function (b) {
      var base = b.graph;
      var ov = overlay[id];
      if (ov && ov.graph) base = ov.graph;
      graphs.set(id, base);
      return base;
    });
  }

  function markDirty(id) {
    overlayDirty.add(id);
    var g = graphs.get(id);
    if (g) {
      overlay[id] = overlay[id] || {};
      overlay[id].graph = g;
      writeOverlay();
    }
  }

  /* ------------------------------------------------------- envelopes (server parity) */
  function graphDetail(core, graph, notesSummary) {
    var verdict = core.validateGraph(graph);
    var out = {
      id: graph.id,
      name: graph.name,
      description: graph.description,
      revision: graph.revision,
      direction: graph.direction,
      nodeTypes: Object.assign({}, core.NODE_TYPES, graph.nodeTypes),
      edgeTypes: Object.assign({}, core.EDGE_TYPES, graph.edgeTypes),
      valid: verdict.ok,
      issues: verdict.issues,
      warnings: verdict.warnings,
      nodes: graph.nodes,
      edges: graph.edges,
      groups: graph.groups,
      notes: Object.assign({}, graph.notes, notesSummary || {}),
    };
    if (graph.conversation) out.conversation = graph.conversation;
    return out;
  }

  function mutate(graph, fn) {
    // mirrors the server's mutateGraph: run the mutation, bump the revision,
    // and answer {ok, revision, detail}
    try {
      fn(graph);
      graph.revision = (graph.revision || 1) + 1;
      graph.updatedAt = new Date().toISOString();
      return { ok: true, revision: graph.revision, __mutated: true };
    } catch (e) {
      return { ok: false, issues: [String(e && e.message ? e.message : e)] };
    }
  }

  function listEntry(core, graph) {
    var v = core.validateGraph(graph);
    return {
      id: graph.id,
      name: graph.name,
      revision: graph.revision,
      nodes: graph.nodes.length,
      edges: graph.edges.length,
      groups: graph.groups.length,
      valid: v.ok,
      warnings: v.warnings.length,
      updatedAt: graph.updatedAt || graph.createdAt || new Date().toISOString(),
    };
  }

  /* Which graphs the build published (the snapshot is a curated subset). */
  function publishedIds(idx) {
    if (!idx.__published) idx.__published = new Set(idx.graphs.map(function (e) { return e.id; }));
    return idx.__published;
  }

  /* --------------------------------------------------------------- filtering */
  function searchAll(core, q) {
    var needle = String(q || "").trim().toLowerCase();
    var results = [];
    if (!needle) return results;
    graphs.forEach(function (g) {
      var bundle = bundles.get(g.id);
      var notes = (bundle && bundle.notes) || {};
      g.nodes.forEach(function (n) {
        if (String(n.label || "").toLowerCase().indexOf(needle) >= 0) {
          results.push({ graphId: g.id, graphName: g.name, nodeId: n.id, nodeLabel: n.label, where: "node" });
        }
        var body = notes[n.id];
        if (body) {
          var at = body.toLowerCase().indexOf(needle);
          if (at >= 0) {
            var from = Math.max(0, at - 30);
            results.push({
              graphId: g.id, graphName: g.name, nodeId: n.id, nodeLabel: n.label,
              snippet: body.slice(from, from + 90).replace(/\s+/g, " "), where: "note",
            });
          }
        }
      });
      if (String(g.name || "").toLowerCase().indexOf(needle) >= 0) {
        results.push({ graphId: g.id, graphName: g.name, nodeId: null, nodeLabel: g.name, where: "title" });
      }
    });
    return results.slice(0, 200);
  }

  /* ------------------------------------------------------------------ router */
  /* Returns { status, payload }. Mirrors the paths in studio/server.mjs. */
  function route(method, pathname, search, body) {
    return libsReady.then(function (L) {
      return loadIndex().then(function (idx) {
        var q = new URLSearchParams(search || "");

        /* ---- globals ---- */
        if (pathname === "/api/graphs" && method === "GET") {
          return Promise.all(idx.graphs.map(function (e) { return liveGraph(e.id).then(function (g) { return listEntry(L.core, g); }); }))
            .then(function (list) {
              list.sort(function (a, b) { return String(b.updatedAt).localeCompare(String(a.updatedAt)); });
              return { status: 200, payload: list };
            });
        }
        if (pathname === "/api/tree" && method === "GET") {
          return { status: 200, payload: idx.tree };
        }
        if (pathname === "/api/templates" && method === "GET") {
          var lang = q.get("lang") === "en" ? "en" : "zh";
          return { status: 200, payload: (idx.templates && idx.templates[lang]) || [] };
        }
        if (pathname === "/api/crosslinks" && method === "GET") {
          var want = q.get("graph");
          var published = publishedIds(idx);
          var all = (idx.crosslinks && idx.crosslinks.links) || [];
          var kept = all.filter(function (l) {
            var f = l.from || {}, t = l.to || {};
            if (!published.has(f.graph) || !published.has(t.graph)) return false;
            if (want) return f.graph === want || t.graph === want;
            return true;
          });
          return { status: 200, payload: { links: kept } };
        }
        if (pathname === "/api/search" && method === "GET") {
          return { status: 200, payload: { results: searchAll(L.core, q.get("q")) } };
        }
        if (pathname === "/api/live") {
          return { status: 200, payload: { on: false, turns: 0, head: null, openThreads: [] } };
        }
        if (pathname === "/api/events") {
          return { status: 204, payload: null };
        }
        if (pathname === "/api/import" && method === "POST") {
          return { status: 200, payload: { ok: false, error: "Importing is disabled on the published snapshot (read-only host)." } };
        }

        /* ---- graph scoped ---- */
        var m = pathname.match(/^\/api\/graph\/([^/]+)(?:\/(.*))?$/);
        if (!m) return { status: 404, payload: { error: "not found" } };
        var id = decodeURIComponent(m[1]);
        var rest = m[2] || "";

        if (!publishedIds(idx).has(id)) return { status: 404, payload: { error: "graph not published" } };

        return liveGraph(id).then(function (graph) {
          var bundle = bundles.get(id) || { notes: {}, validate: null, analyze: null };
          var notes = bundle.notes || {};

          /* GET /api/graph/:id */
          if (method === "GET" && !rest) {
            var summary = {};
            Object.keys(notes).forEach(function (k) { if (graph.notes[k]) summary[k] = graph.notes[k]; });
            return { status: 200, payload: graphDetail(L.core, graph, summary) };
          }
          /* GET validate */
          if (method === "GET" && rest === "validate") {
            return { status: 200, payload: L.core.validateGraph(graph) };
          }
          /* GET analyze */
          if (method === "GET" && rest === "analyze") {
            var tr = q.get("trace") || null;
            return {
              status: 200,
              payload: Object.assign({}, L.an.analyzeGraph(graph.nodes, graph.edges, { trace: tr }), { groupSuggestions: L.gs.suggestGroups(graph) }),
            };
          }
          /* GET note/:nodeId */
          var nm = rest.match(/^note\/(.+)$/);
          if (method === "GET" && nm) {
            var nodeId = decodeURIComponent(nm[1]);
            var content = notes[nodeId];
            return { status: 200, payload: { content: content == null ? "" : content, exists: content != null } };
          }
          /* GET asset/:name */
          var am = rest.match(/^asset\/(.+)$/);
          if (method === "GET" && am) {
            return { status: 200, payload: null, asset: DATA + "assets/" + encodeURIComponent(id) + "/" + am[1] };
          }
          /* GET export */
          if (method === "GET" && rest === "export") {
            var fmt = q.get("format") || "mermaid";
            if (fmt === "json") return { status: 200, payload: graph };
            if (fmt === "dot") return { status: 200, payload: { text: L.cv.toDot(graph) } };
            if (fmt === "md") return { status: 200, payload: { text: L.cv.toMarkdownOutline(graph) } };
            if (fmt === "txt") return { status: 200, payload: { text: L.cv.toPlainText(graph) } };
            return { status: 200, payload: { text: L.cv.toMermaid(graph) } };
          }
          /* GET convo */
          if (method === "GET" && rest === "convo") {
            var conv = graph.conversation;
            if (!conv) return { status: 200, payload: { head: null, mainline: [], threads: [], forks: [], speakers: [], pending: [] } };
            var ids = new Set(graph.nodes.map(function (n) { return n.id; }));
            var heads = conv.head ? [conv.head] : [];
            return {
              status: 200,
              payload: {
                head: conv.head || null,
                mainline: heads,
                threads: [],
                forks: [],
                speakers: conv.speakers || [],
                pending: [],
                mode: conv.mode !== false,
                topic: conv.topic || "",
              },
            };
          }

          /* ---------------- mutations ---------------- */
          var result;

          if (method === "POST" && rest === "layout") {
            L.an.applyLayout(graph, String((body && body.mode) || "layered"));
            graph.revision = (graph.revision || 1) + 1;
            markDirty(id);
            return { status: 200, payload: { ok: true, detail: graphDetail(L.core, graph) } };
          }
          if (method === "POST" && rest === "node-add") {
            result = mutate(graph, function (g) {
              var type = g.nodeTypes[body.type] || L.core.NODE_TYPES[body.type] ? String(body.type) : "process";
              var def = L.core.nodeTypeDef({ nodeTypes: g.nodeTypes }, type);
              var suffix = Math.random().toString(36).slice(2, 6);
              var node = L.core.normalizeGraph({
                nodeTypes: g.nodeTypes,
                nodes: [{ id: "n-" + type.slice(0, 4) + "-" + suffix, type: type, label: String(body.label == null ? def.label : body.label), x: Number(body.x) || 200, y: Number(body.y) || 160 }],
              }).nodes[0];
              g.nodes.push(node);
            });
            if (result.ok) markDirty(id);
            return { status: result.ok ? 200 : 400, payload: result.ok ? withDetail(L, result, graph) : result };
          }
          if (method === "POST" && rest === "node-patch") {
            var patch = body.patch || {};
            result = mutate(graph, function (g) {
              var node = g.nodes.find(function (c) { return c.id === body.nodeId; });
              if (!node) throw new Error("node " + body.nodeId + " not found");
              ["label", "type", "note", "x", "y", "w", "h", "shape", "fill", "border", "textColor", "icon", "status", "tags"].forEach(function (k) {
                if (patch[k] !== undefined) node[k] = patch[k];
              });
            });
            if (result.ok) markDirty(id);
            return { status: result.ok ? 200 : 400, payload: result.ok ? withDetail(L, result, graph) : result };
          }
          if (method === "DELETE" && rest.match(/^node\/(.+)$/)) {
            var delId = decodeURIComponent(rest.match(/^node\/(.+)$/)[1]);
            result = mutate(graph, function (g) {
              g.nodes = g.nodes.filter(function (n) { return n.id !== delId; });
              g.edges = g.edges.filter(function (e) { return e.source !== delId && e.target !== delId; });
              g.groups.forEach(function (gr) { gr.members = (gr.members || []).filter(function (x) { return x !== delId; }); });
              if (g.notes) delete g.notes[delId];
            });
            if (result.ok) markDirty(id);
            return { status: result.ok ? 200 : 400, payload: result.ok ? { ok: true, nodeId: delId } : result };
          }
          if (method === "POST" && rest === "node-delete") {
            result = mutate(graph, function (g) {
              var nid = String(body.nodeId || "");
              g.nodes = g.nodes.filter(function (n) { return n.id !== nid; });
              g.edges = g.edges.filter(function (e) { return e.source !== nid && e.target !== nid; });
              g.groups.forEach(function (gr) { gr.members = (gr.members || []).filter(function (x) { return x !== nid; }); });
              if (g.notes) delete g.notes[nid];
            });
            if (result.ok) markDirty(id);
            return { status: result.ok ? 200 : 400, payload: result.ok ? withDetail(L, result, graph) : result };
          }
          if (method === "POST" && rest === "edge-add") {
            var source = String(body.source || ""), target = String(body.target || "");
            if (source === target) return { status: 400, payload: { ok: false, issues: ["self-loops are not allowed (source equals target)"] } };
            result = mutate(graph, function (g) {
              if (!g.nodes.some(function (n) { return n.id === source; })) throw new Error("source node " + source + " not found");
              if (!g.nodes.some(function (n) { return n.id === target; })) throw new Error("target node " + target + " not found");
              var edge = L.core.normalizeGraph({
                edgeTypes: g.edgeTypes,
                edges: [{ id: L.core.newId("e"), source: source, target: target, type: typeof body.type === "string" ? body.type : "", label: String(body.label == null ? "" : body.label) }],
              }).edges[0];
              g.edges.push(edge);
            });
            if (result.ok) markDirty(id);
            return { status: result.ok ? 200 : 400, payload: result.ok ? withDetail(L, result, graph) : result };
          }
          if (method === "POST" && rest === "edge-patch") {
            var ep = body.patch || {};
            result = mutate(graph, function (g) {
              var edge = g.edges.find(function (c) { return c.id === body.edgeId; });
              if (!edge) throw new Error("edge " + body.edgeId + " not found");
              ["label", "type", "color", "width", "style", "arrow", "curve"].forEach(function (k) {
                if (ep[k] !== undefined) edge[k] = ep[k];
              });
            });
            if (result.ok) markDirty(id);
            return { status: result.ok ? 200 : 400, payload: result.ok ? withDetail(L, result, graph) : result };
          }
          if (method === "POST" && rest === "edge-delete") {
            result = mutate(graph, function (g) {
              g.edges = g.edges.filter(function (e) { return e.id !== String(body.edgeId || ""); });
            });
            if (result.ok) markDirty(id);
            return { status: result.ok ? 200 : 400, payload: result.ok ? withDetail(L, result, graph) : result };
          }
          if (method === "POST" && rest === "note") {
            var noteNode = String(body.nodeId || "");
            if (!graph.nodes.some(function (n) { return n.id === noteNode; })) {
              return { status: 400, payload: { error: "node not found" } };
            }
            var text = String(body.content == null ? "" : body.content);
            notes[noteNode] = text;
            bundle.notes = notes;
            graph.notes[noteNode] = text.split("\n")[0].slice(0, 120);
            overlay[id] = overlay[id] || {};
            overlay[id].notes = overlay[id].notes || {};
            overlay[id].notes[noteNode] = text;
            markDirty(id);
            return { status: 200, payload: { ok: true } };
          }
          if (method === "POST" && rest === "meta") {
            result = mutate(graph, function (g) {
              if (typeof body.name === "string" && body.name.trim()) g.name = body.name.trim();
              if (typeof body.description === "string") g.description = body.description;
              if (body.direction === "TD" || body.direction === "LR") g.direction = body.direction;
            });
            if (result.ok) markDirty(id);
            return { status: result.ok ? 200 : 400, payload: result.ok ? withDetail(L, result, graph) : result };
          }
          if (method === "POST" && rest === "position") {
            var pn = graph.nodes.find(function (n) { return n.id === body.nodeId; });
            if (!pn) return { status: 400, payload: { error: "node not found" } };
            pn.x = Math.round(Number(body.x) || 0);
            pn.y = Math.round(Number(body.y) || 0);
            markDirty(id);
            return { status: 200, payload: { ok: true } };
          }
          if (method === "POST" && rest === "positions") {
            var moves = body.moves || [];
            var moved = 0;
            moves.forEach(function (mv) {
              var n = graph.nodes.find(function (c) { return c.id === (mv.id || mv.nodeId); });
              if (!n) return;
              if (Number.isFinite(Number(mv.x)) && Number.isFinite(Number(mv.y))) {
                n.x = Math.round(Number(mv.x)); n.y = Math.round(Number(mv.y)); moved++;
              }
            });
            if (moved) markDirty(id);
            return { status: 200, payload: { ok: true, moved: moved } };
          }
          if (method === "POST" && rest === "group-add") {
            result = mutate(graph, function (g) {
              var members = (Array.isArray(body.members) ? body.members : []).map(String).filter(function (mm) {
                return g.nodes.some(function (n) { return n.id === mm; });
              });
              if (!members.length) throw new Error("a group needs at least one existing member node");
              g.groups.push({ id: L.core.newId("g"), label: String(body.label == null ? "Group" : body.label), color: typeof body.color === "string" ? body.color : "#64748B", members: members });
            });
            if (result.ok) markDirty(id);
            return { status: result.ok ? 200 : 400, payload: result.ok ? withDetail(L, result, graph) : result };
          }
          if (method === "POST" && rest === "group-delete") {
            result = mutate(graph, function (g) {
              g.groups = g.groups.filter(function (gr) { return gr.id !== String(body.groupId || ""); });
            });
            if (result.ok) markDirty(id);
            return { status: result.ok ? 200 : 400, payload: result.ok ? withDetail(L, result, graph) : result };
          }
          if (method === "POST" && rest === "group-commit") {
            var group = graph.groups.find(function (gr) { return gr.id === String(body.groupId || ""); });
            if (!group) return { status: 400, payload: { error: "group not found" } };
            var movedN = L.core.moveNodes(graph, body.moves || []);
            var rect = null;
            if (body.rect === null) { delete group.rect; }
            else if (body.rect) { rect = L.core.setGroupRect(graph, group.id, body.rect); }
            else {
              var ms = (group.members || []).map(function (mid) { return graph.nodes.find(function (x) { return x.id === mid; }); }).filter(Boolean);
              if (ms.length) {
                var pad = { x: 24, top: 34, bottom: 24 };
                var minX = Math.min.apply(null, ms.map(function (x) { return x.x; })) - pad.x;
                var minY = Math.min.apply(null, ms.map(function (x) { return x.y; })) - pad.top;
                var maxX = Math.max.apply(null, ms.map(function (x) { return x.x + (x.w || 168); })) + pad.x;
                var maxY = Math.max.apply(null, ms.map(function (x) { return x.y + (x.h || 64); })) + pad.bottom;
                rect = L.core.setGroupRect(graph, group.id, { x: minX, y: minY, w: maxX - minX, h: maxY - minY });
              }
            }
            markDirty(id);
            return { status: 200, payload: { ok: true, moved: movedN, rect: rect } };
          }
          if (method === "POST" && rest === "node-type-patch") {
            result = mutate(graph, function (g) {
              var key = String(body.type || "").trim();
              if (!key) throw new Error("missing type");
              var prev = g.nodeTypes[key] || {};
              g.nodeTypes[key] = Object.assign({}, prev, {
                label: String(body.label == null ? prev.label || key : body.label),
                labelEn: String(body.labelEn == null ? prev.labelEn || prev.label || key : body.labelEn),
                fill: typeof body.fill === "string" ? body.fill : prev.fill || "#6B7280",
                border: typeof body.border === "string" ? body.border : prev.border || "#4B5563",
                textColor: typeof body.textColor === "string" ? body.textColor : prev.textColor || "#0F172A",
                shape: typeof body.shape === "string" ? body.shape : prev.shape || "rounded",
                icon: typeof body.icon === "string" ? body.icon : prev.icon || "◆",
              });
            });
            if (result.ok) markDirty(id);
            return { status: result.ok ? 200 : 400, payload: result.ok ? withDetail(L, result, graph) : result };
          }
          if (method === "POST" && rest === "edge-type-patch") {
            result = mutate(graph, function (g) {
              var key = String(body.type || "");
              var prev = g.edgeTypes[key] || {};
              g.edgeTypes[key] = Object.assign({}, prev, {
                label: String(body.label == null ? prev.label || key : body.label),
                labelEn: String(body.labelEn == null ? prev.labelEn || prev.label || key : body.labelEn),
                color: typeof body.color === "string" ? body.color : prev.color || "#64748B",
                style: typeof body.style === "string" ? body.style : prev.style || "solid",
              });
            });
            if (result.ok) markDirty(id);
            return { status: result.ok ? 200 : 400, payload: result.ok ? withDetail(L, result, graph) : result };
          }
          if (method === "POST" && rest === "replace") {
            var draft = L.core.normalizeGraph(Object.assign({}, body.graph, { id: id, name: (body.graph && body.graph.name) || id }));
            if (!body.force && graph.nodes.length > 0 && draft.nodes.length === 0) {
              return { status: 409, payload: { error: "refusing to overwrite existing content with an empty graph (pass force explicitly if you really mean to clear it)" } };
            }
            var verdict = L.core.validateGraph(draft);
            if (!verdict.ok) return { status: 400, payload: { error: "structure validation failed: " + verdict.issues.slice(0, 3).join("; ") } };
            graphs.set(id, draft);
            markDirty(id);
            return { status: 200, payload: { ok: true } };
          }
          if (method === "POST" && rest === "attach") {
            return { status: 400, payload: { error: "Attachments are disabled on the published snapshot (read-only host)." } };
          }
          if (method === "POST" && rest === "upload") {
            return { status: 400, payload: { error: "Uploads are disabled on the published snapshot (read-only host)." } };
          }
          if (method === "POST" && rest === "project") {
            return { status: 400, payload: { error: "Projection is disabled on the published snapshot (read-only host)." } };
          }
          if (method === "POST" && rest === "convo") {
            // A DAG session needs durable state; on a static host we refuse rather than lie.
            return { status: 400, payload: { error: "Conversation editing is disabled on the published snapshot (read-only host)." } };
          }
          if (method === "POST" && rest === "graph-delete") {
            return { status: 400, payload: { error: "Deleting graphs is disabled on the published snapshot (read-only host)." } };
          }
          return { status: 404, payload: { error: "not found" } };
        });
      });
    });
  }

  function withDetail(L, result, graph) {
    return { ok: true, revision: result.revision, detail: graphDetail(L.core, graph) };
  }

  /* ------------------------------------------------------------- fetch shim */
  window.fetch = function (input, init) {
    var url;
    try {
      url = typeof input === "string" ? new URL(input, location.href) : new URL(input.url, location.href);
    } catch (e) {
      return realFetch(input, init);
    }
    if (url.pathname.indexOf("/api/") !== 0) return realFetch(input, init);

    var method = String((init && init.method) || (typeof input !== "string" && input.method) || "GET").toUpperCase();
    var body = null;
    if (init && init.body) {
      try { body = JSON.parse(init.body); } catch (e) { body = init.body; }
    }

    return route(method, url.pathname, url.search, body || {}).then(function (r) {
      if (r.asset) return realFetch(r.asset);
      if (r.status === 204) return new Response(null, { status: 204 });
      return new Response(JSON.stringify(r.payload), {
        status: r.status,
        headers: { "content-type": "application/json" },
      });
    }).catch(function (e) {
      return new Response(JSON.stringify({ error: String(e && e.message ? e.message : e) }), {
        status: 500,
        headers: { "content-type": "application/json" },
      });
    });
  };

  /* SSE cannot exist without a server; a silent stub keeps the client's
   * boot path from throwing. Cross-tab sync is not needed for a snapshot. */
  window.EventSource = function () {
    this.readyState = 0;
    this.addEventListener = function () {};
    this.removeEventListener = function () {};
    this.close = function () { this.readyState = 2; };
  };
  window.EventSource.CONNECTING = 0;
  window.EventSource.OPEN = 1;
  window.EventSource.CLOSED = 2;
  void realEventSource;

  /* ------------------------------------------------------------- public API */
  window.MathFlow = {
    site: SITE.href,
    isStatic: true,
    loadIndex: loadIndex,
    stats: function () {
      return {
        graphs: index ? index.graphs.length : 0,
        generatedAt: index ? index.generatedAt : null,
        editedGraphs: Object.keys(overlay).length,
      };
    },
    hasEdits: function () {
      var ids = Object.keys(overlay);
      for (var i = 0; i < ids.length; i++) {
        var o = overlay[ids[i]];
        if (o && (o.graph || (o.notes && Object.keys(o.notes).length))) return true;
      }
      return false;
    },
    resetEdits: function () {
      overlay = {};
      overlayDirty = new Set();
      graphs = new Map();
      try { localStorage.removeItem(OVERLAY_KEY); } catch (e) { /* ignore */ }
    },
  };

  /* Warm the dataset so the first paint is not waiting on a round trip. */
  loadIndex().then(function (idx) {
    idx.graphs.forEach(function (e) { liveGraph(e.id).catch(function () {}); });
  }).catch(function () {});
})();
