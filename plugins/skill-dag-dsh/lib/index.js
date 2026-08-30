import { defineTool } from "@deepseek-ai/dsh-tools";
//#region \0rolldown/runtime.js
var __commonJSMin = (cb, mod) => () => (mod || (cb((mod = { exports: {} }).exports, mod), cb = null), mod.exports);
//#endregion
//#region src/index.ts
var import_skill_dag = (/* @__PURE__ */ __commonJSMin(((exports, module) => {
	const DEFAULT_PARAMS = {
		tauLow: .4,
		tauHigh: .65,
		lMax: 3,
		eMax: 5,
		lambda: .5,
		eta: .7,
		k: 5,
		m: 5,
		h: 2,
		rMax: 2,
		pMax: 1,
		confWeights: [
			1.2,
			1,
			.8,
			1.8
		],
		confBias: -2,
		verifyMode: "strict",
		operatorOrder: null
	};
	const STOP = /* @__PURE__ */ new Set([
		"a",
		"an",
		"the",
		"and",
		"it",
		"to",
		"for",
		"of",
		"with",
		"is",
		"are",
		"was",
		"were",
		"be",
		"been",
		"this",
		"that",
		"these",
		"those",
		"we",
		"you",
		"he",
		"she",
		"they",
		"do",
		"does",
		"did",
		"have",
		"has",
		"had",
		"but",
		"or",
		"not",
		"can",
		"could",
		"will",
		"would",
		"should",
		"shall"
	]);
	function tokenize(text) {
		return String(text || "").toLowerCase().split(/[^a-z0-9_]+/).filter((t) => t.length > 0 && !STOP.has(t));
	}
	function tokenSim(a, b) {
		const ta = new Set(tokenize(a)), tb = new Set(tokenize(b));
		if (ta.size === 0 || tb.size === 0) return 0;
		let inter = 0;
		ta.forEach((t) => {
			if (tb.has(t)) inter++;
		});
		const union = ta.size + tb.size - inter;
		return union === 0 ? 0 : inter / union;
	}
	function skillText(s) {
		return [
			s.id,
			s.name,
			s.description || "",
			(s.effect || []).join(" ")
		].join(" ");
	}
	function kl(p, q) {
		let s = 0;
		for (let i = 0; i < p.length; i++) if (p[i] > 0) s += p[i] * Math.log(p[i] / q[i]);
		return s;
	}
	function jsdScore(p, q) {
		const m = p.map((v, i) => (v + q[i]) / 2);
		return .5 * kl(p, m) + .5 * kl(q, m);
	}
	function predName(p) {
		const m = /^([a-z_]+)\(/.exec(p);
		return m ? m[1] : p;
	}
	function goalCover(topM, byId, goal) {
		if (!goal.length) return 1;
		const names = /* @__PURE__ */ new Set();
		topM.forEach((id) => {
			(byId[id].effect || []).forEach((e) => names.add(predName(e)));
		});
		let hit = 0;
		goal.forEach((g) => {
			if (names.has(predName(g))) hit++;
		});
		return hit / goal.length;
	}
	function retrieve({ skills, goal, task, episodes, params }) {
		const P = params;
		const byId = {};
		skills.forEach((s) => {
			byId[s.id] = s;
		});
		const dirRaw = skills.map((s) => tokenSim(task, skillText(s)) + .001);
		const dirSum = dirRaw.reduce((a, b) => a + b, 0);
		const pDir = dirRaw.map((v) => v / dirSum);
		const scored = (episodes || []).map((m, i) => ({
			i,
			rho: tokenSim(task, m.task)
		}));
		scored.sort((a, b) => b.rho - a.rho);
		const topk = scored.slice(0, P.k).filter((r) => r.rho > 0);
		const rhoBar = topk.length ? topk.reduce((a, r) => a + r.rho, 0) / topk.length : 0;
		const memRaw = skills.map((s) => {
			let acc = 0;
			topk.forEach((r) => {
				acc += r.rho * (episodes[r.i].trajectory || []).filter((x) => x === s.id).length;
			});
			return acc + .001;
		});
		const memSum = memRaw.reduce((a, b) => a + b, 0);
		const pMem = memRaw.map((v) => v / memSum);
		let p = pDir.map((v, i) => P.lambda * v + (1 - P.lambda) * pMem[i]);
		const pSum = p.reduce((a, b) => a + b, 0);
		p = p.map((v) => v / pSum);
		const topM = skills.map((s, i) => ({
			id: s.id,
			p: p[i]
		})).sort((a, b) => b.p - a.p).slice(0, P.m).map((r) => r.id);
		const sortedP = p.slice().sort((a, b) => b - a);
		const margin = sortedP.length > 1 ? sortedP[0] - sortedP[1] : sortedP.length ? sortedP[0] : 0;
		const agree = topk.length ? 1 - jsdScore(pDir, pMem) : 0;
		const cover = goalCover(topM, byId, goal);
		const features = [
			rhoBar,
			agree,
			margin,
			cover
		];
		const w = P.confWeights;
		const z = w[0] * features[0] + w[1] * features[1] + w[2] * features[2] + w[3] * features[3] + P.confBias;
		const learned = 1 / (1 + Math.exp(-z));
		const cHist = topk.length ? topk.reduce((a, r) => a + episodes[r.i].success, 0) / topk.length : .5;
		const cRet = P.eta * learned + (1 - P.eta) * cHist;
		return {
			skills: topM,
			p,
			p_dir: pDir,
			p_mem: pMem,
			features: {
				rhoBar,
				agreement: agree,
				margin,
				coverage: cover
			},
			confidence: cRet,
			mode: route(cRet, P).mode,
			memory: topk.map((r) => ({
				task: episodes[r.i].task,
				rho: r.rho,
				success: episodes[r.i].success
			}))
		};
	}
	function route(confidence, params) {
		const c = typeof confidence === "number" ? confidence : null;
		if (c === null) return {
			confidence: c,
			mode: "full-dag-boosted-repair"
		};
		if (c < params.tauLow) return {
			confidence: c,
			mode: "react-fallback"
		};
		if (c > params.tauHigh) return {
			confidence: c,
			mode: "full-dag"
		};
		return {
			confidence: c,
			mode: "full-dag-boosted-repair"
		};
	}
	function parsePred(p) {
		const m = /^([a-z_]+)\(([^)]*)\)$/.exec(p);
		if (!m) return null;
		const args = m[2].split(",").map((s) => s.trim()).filter((s) => s.length > 0);
		return {
			name: m[1],
			args
		};
	}
	function predArg(p) {
		const m = /^[a-z_]+\(([^)]*)\)$/.exec(p);
		if (!m) return null;
		const inner = m[1].split(",").map((s) => s.trim());
		return inner.length === 1 ? inner[0] : null;
	}
	function bindSkill(s, args) {
		const params = s.params || [];
		const bind = (p) => {
			let out = p;
			params.forEach((pm, i) => {
				const val = args[i];
				if (val === void 0 || val === null) return;
				out = out.replace(new RegExp("\\b" + pm + "\\b", "g"), String(val));
			});
			return out;
		};
		return {
			id: s.id,
			name: s.name,
			params: params.slice(),
			args: (args || []).slice(),
			precondition: (s.precondition || []).map(bind),
			effect: (s.effect || []).map(bind),
			verifier: s.verifier || null
		};
	}
	function instantiate(skills, proposal, params) {
		const byId = {};
		skills.forEach((s) => {
			byId[s.id] = s;
		});
		const items = Array.isArray(proposal) && proposal.length ? proposal : skills.map((s) => ({
			skill: s.id,
			args: s.args || []
		}));
		const counts = {};
		const nodes = [];
		items.forEach((item) => {
			const s = byId[item.skill];
			if (!s) return;
			counts[item.skill] = (counts[item.skill] || 0) + 1;
			const bid = bindSkill(s, item.args);
			nodes.push({
				id: item.skill + ":" + counts[item.skill],
				kind: "skill",
				skill: s.id,
				name: s.name,
				args: bid.args,
				params: bid.params,
				precondition: bid.precondition,
				effect: bid.effect,
				verifier: bid.verifier,
				status: "pending",
				confidence: typeof item.confidence === "number" ? item.confidence : 1,
				repairBudget: params.rMax,
				repairCount: 0
			});
		});
		return nodes;
	}
	function backwardFilter(nodes, goal, initial) {
		const kept = /* @__PURE__ */ new Set();
		const produced = new Set(initial || []);
		const needed = new Set((goal || []).filter((g) => !produced.has(g)));
		let changed = true;
		while (changed) {
			changed = false;
			nodes.forEach((n) => {
				if (kept.has(n.id)) return;
				if (n.effect.some((e) => needed.has(e))) {
					kept.add(n.id);
					n.effect.forEach((e) => produced.add(e));
					n.precondition.forEach((p) => {
						if (!produced.has(p)) needed.add(p);
					});
					changed = true;
				}
			});
		}
		return {
			kept,
			produced,
			needed
		};
	}
	function inferEdges(nodes, orderHints) {
		const edges = [];
		const seen = /* @__PURE__ */ new Set();
		const add = (from, to, type, label) => {
			if (from === to) return;
			const k = from + "|" + to + "|" + type + "|" + label;
			if (seen.has(k)) return;
			seen.add(k);
			edges.push({
				from,
				to,
				type,
				label
			});
		};
		for (let i = 0; i < nodes.length; i++) for (let j = 0; j < nodes.length; j++) {
			if (i === j) continue;
			const u = nodes[i], v = nodes[j];
			u.effect.forEach((e) => {
				if (v.precondition.indexOf(e) >= 0) add(u.id, v.id, "state", e);
			});
			v.args.forEach((a) => {
				if (u.effect.some((e) => v.precondition.indexOf(e) >= 0 && predArg(e) === a)) add(u.id, v.id, "data", a + " → " + v.id);
			});
		}
		(orderHints || []).forEach((h) => add(h.from, h.to, "order", h.label || "order"));
		return edges;
	}
	function topoOrder(nodes, edges) {
		const ids = nodes.map((n) => n.id);
		const indeg = {}, adj = {};
		ids.forEach((id) => {
			indeg[id] = 0;
			adj[id] = [];
		});
		edges.forEach((e) => {
			if (!(e.to in indeg) || !(e.from in adj)) return;
			adj[e.from].push(e.to);
			indeg[e.to]++;
		});
		const q = ids.filter((id) => indeg[id] === 0);
		const order = [];
		while (q.length) {
			const id = q.shift();
			order.push(id);
			adj[id].forEach((to) => {
				indeg[to]--;
				if (indeg[to] === 0) q.push(to);
			});
		}
		return order.length === ids.length ? order : null;
	}
	function hasCycle(nodes, edges) {
		return topoOrder(nodes, edges) === null;
	}
	function reachable(a, b, nodes, edges) {
		const adj = {};
		nodes.forEach((n) => {
			adj[n.id] = [];
		});
		edges.forEach((e) => {
			if (e.from in adj && e.to in adj) adj[e.from].push(e.to);
		});
		const seen = { [a]: true };
		const q = [a];
		while (q.length) adj[q.shift()].forEach((t) => {
			if (!seen[t]) {
				seen[t] = true;
				q.push(t);
			}
		});
		return !!seen[b];
	}
	function layoutNodes(nodes, edges) {
		const rank = {};
		nodes.forEach((n) => {
			rank[n.id] = 0;
		});
		(topoOrder(nodes, edges) || nodes.map((n) => n.id)).forEach((id) => {
			edges.forEach((e) => {
				if (e.to === id && e.from in rank) rank[id] = Math.max(rank[id], rank[e.from] + 1);
			});
		});
		const byRank = {};
		Object.keys(rank).forEach((id) => {
			(byRank[rank[id]] = byRank[rank[id]] || []).push(id);
		});
		Object.keys(byRank).forEach((r) => {
			byRank[r].sort();
			byRank[r].forEach((id, i) => {
				const n = nodes.find((x) => x.id === id);
				if (n) {
					n.x = 40 + r * 300;
					n.y = 30 + i * 116;
				}
			});
		});
	}
	async function compileWith(deps, { task, proposal, goal, initialConditions, orderHints }) {
		const { params, skillSource, proposer, store } = deps;
		const P = params;
		const skills = await skillSource.list();
		if (!skills.length) return {
			ok: false,
			reason: "skill source returned no skills"
		};
		const byId = {};
		skills.forEach((s) => {
			byId[s.id] = s;
		});
		const goalList = goal || [];
		const initial = initialConditions || [];
		let ret = null;
		let effectiveProposal = proposal;
		if (task && task.length) {
			ret = retrieve({
				skills,
				goal: goalList,
				task,
				episodes: await store.get("memory:episodes") || [],
				params: P
			});
			if (ret.mode === "react-fallback") return {
				ok: true,
				dag: null,
				routing: {
					confidence: ret.confidence,
					mode: "react-fallback"
				},
				retrieval: {
					skills: ret.skills,
					features: ret.features
				},
				reason: "low retrieval confidence → ReAct fallback"
			};
			if (!Array.isArray(proposal) || !proposal.length) effectiveProposal = await proposer.propose({
				task,
				skills,
				retrieval: ret,
				goal: goalList
			});
		}
		const rejected = [];
		if (Array.isArray(effectiveProposal)) effectiveProposal = effectiveProposal.filter((p) => {
			const s = byId[p.skill];
			if (!s) {
				rejected.push({
					skill: p.skill,
					reason: "unknown skill"
				});
				return false;
			}
			const need = (s.params || []).length;
			const got = (p.args || []).length;
			if (need !== got) {
				rejected.push({
					skill: p.skill,
					reason: "arity " + got + " != " + need
				});
				return false;
			}
			return true;
		});
		let nodes = instantiate(skills, effectiveProposal, P);
		if (!nodes.length) return {
			ok: false,
			reason: "no skill nodes",
			rejected
		};
		const f = backwardFilter(nodes, goalList, initial);
		const keptCount = nodes.filter((n) => f.kept.has(n.id)).length;
		nodes = nodes.filter((n) => f.kept.has(n.id));
		if (!nodes.length) return {
			ok: false,
			reason: "goal unreachable: no skill covers goal",
			rejected
		};
		let edges = inferEdges(nodes, orderHints);
		const hard = edges.filter((e) => e.type !== "order");
		const soft = edges.filter((e) => e.type === "order");
		if (hasCycle(nodes, hard)) return {
			ok: false,
			reason: "cycle among hard edges",
			rejected
		};
		edges = hard.slice();
		soft.slice().sort((a, b) => (a.confidence || 0) - (b.confidence || 0)).forEach((e) => {
			if (!hasCycle(nodes, edges.concat([e]))) edges.push(e);
		});
		const src = {
			id: "src",
			kind: "src",
			skill: null,
			name: "START",
			args: [],
			precondition: [],
			effect: initial.slice(),
			status: "verified",
			confidence: 1
		};
		const snk = {
			id: "snk",
			kind: "snk",
			skill: null,
			name: "GOAL",
			args: [],
			precondition: goalList.slice(),
			effect: [],
			status: "pending",
			confidence: 1
		};
		const all = [src].concat(nodes).concat([snk]);
		const hardIn = {};
		all.forEach((n) => {
			hardIn[n.id] = 0;
		});
		edges.forEach((e) => {
			if (e.to in hardIn) hardIn[e.to]++;
		});
		nodes.forEach((n) => {
			if (hardIn[n.id] === 0) edges.push({
				from: "src",
				to: n.id,
				type: "order",
				label: "start"
			});
		});
		const hasOut = {};
		nodes.forEach((n) => {
			hasOut[n.id] = false;
		});
		edges.forEach((e) => {
			if (e.from in hasOut) hasOut[e.from] = true;
		});
		nodes.forEach((n) => {
			if (!hasOut[n.id] || n.effect.some((e) => goalList.indexOf(e) >= 0)) edges.push({
				from: n.id,
				to: "snk",
				type: "order",
				label: "goal"
			});
		});
		if (hasCycle(all, edges)) return {
			ok: false,
			reason: "cycle after structural edges",
			rejected
		};
		if (!reachable("src", "snk", all, edges)) return {
			ok: false,
			reason: "src to snk unreachable",
			rejected
		};
		const uncovered = goalList.filter((g) => !(initial.indexOf(g) >= 0 || nodes.some((n) => n.effect.indexOf(g) >= 0)));
		if (uncovered.length) return {
			ok: false,
			reason: "goal completeness failed: " + uncovered.join(", "),
			rejected
		};
		const skillEdges = edges.filter((e) => e.from !== "src" && e.to !== "snk");
		const plan = topoOrder(nodes, skillEdges);
		if (!plan) return {
			ok: false,
			reason: "no valid topological order",
			rejected
		};
		layoutNodes(all, edges);
		const planId = "plan_" + await nextSeq(store);
		const dag = {
			planId,
			task: task || "",
			goal: goalList,
			initial_conditions: initial,
			nodes: all,
			edges,
			plan,
			routing: ret ? {
				confidence: ret.confidence,
				mode: ret.mode
			} : route(null, P),
			retrieval: ret ? {
				skills: ret.skills,
				features: ret.features
			} : null,
			filtered: keptCount + " of " + skills.length + " skills kept",
			rejected,
			params: P
		};
		await store.set("plan:" + planId, dag);
		return {
			ok: true,
			dag
		};
	}
	async function nextSeq(store) {
		const next = (await store.get("meta:seq") || 0) + 1;
		await store.set("meta:seq", next);
		return next;
	}
	function verifyStrict(node, before, after, initial) {
		const b = before || [], a = after || [];
		const missingPre = node.precondition.filter((p) => b.indexOf(p) < 0 && (initial || []).indexOf(p) < 0);
		if (missingPre.length) return {
			pass: false,
			type: "precondition",
			message: "missing: " + missingPre.join(", ")
		};
		const missingEff = node.effect.filter((p) => a.indexOf(p) < 0);
		if (missingEff.length) return {
			pass: false,
			type: "postcondition",
			message: "effect not observed: " + missingEff.join(", ")
		};
		return { pass: true };
	}
	async function verifySoft(node, before, after, llmClient) {
		if (!llmClient) return null;
		const prompt = [
			"Skill: " + node.name,
			"Expected effect: " + node.effect.join(", "),
			"State before: " + (before || []).join(", "),
			"State after: " + (after || []).join(", "),
			"Did the expected effect actually occur? Answer strictly \"YES\" or \"NO\" followed by one short reason."
		].join("\n");
		const out = await llmClient.complete({
			prompt,
			temperature: 0
		});
		return {
			pass: /^\s*YES/i.test(String(out || "")),
			type: "postcondition",
			message: "soft verify: " + String(out || "").slice(0, 120)
		};
	}
	async function verifyNode(deps, dag, nodeId, before, after) {
		const node = dag.nodes.find((n) => n.id === nodeId);
		if (!node) return {
			ok: false,
			error: "node not found: " + nodeId
		};
		const strict = verifyStrict(node, before, after, dag.initial_conditions);
		if (strict.pass) {
			node.status = "verified";
			return {
				ok: true,
				pass: true,
				node: node.id,
				mode: "strict"
			};
		}
		if (deps.params.verifyMode === "soft" && strict.type === "postcondition" && node.softVerify !== false) {
			const soft = await verifySoft(node, before, after, deps.llmClient);
			if (soft && soft.pass) {
				node.status = "verified";
				return {
					ok: true,
					pass: true,
					node: node.id,
					mode: "soft"
				};
			}
		}
		node.status = "failed";
		return {
			ok: true,
			pass: false,
			mode: "strict",
			event: {
				nodeId,
				type: strict.type,
				message: strict.message,
				state: before || []
			}
		};
	}
	const BUILTIN_OPERATORS = {
		Bypass({ dag, node, event, helpers }) {
			const dreq = helpers.downstreamReq(dag, node);
			const state = event.state || [];
			if (!dreq.every((p) => state.indexOf(p) >= 0)) return null;
			node.status = "bypassed";
			return {
				operator: "Bypass",
				patch: {
					addedNodes: 0,
					addedEdges: 0,
					bypassed: node.id
				},
				bounded: true
			};
		},
		Rebind({ node, event, library, helpers }) {
			if (!event.args || !Array.isArray(event.args)) return null;
			const s = library.find((x) => x.id === node.skill);
			if (!s) return null;
			const bid = helpers.bindSkill(s, event.args);
			node.args = bid.args;
			node.precondition = bid.precondition;
			node.effect = bid.effect;
			return {
				operator: "Rebind",
				patch: {
					rebind: node.id,
					args: event.args
				},
				bounded: true
			};
		},
		InsertPrereq({ dag, node, event, library, params, helpers }) {
			const state = event.state || [];
			const missing = node.precondition.filter((p) => state.indexOf(p) < 0 && (dag.initial_conditions || []).indexOf(p) < 0);
			if (!missing.length) return null;
			const addedNodes = [];
			for (const p of missing) {
				const cand = library.find((s) => (s.effect || []).some((g) => {
					const gp = helpers.parsePred(g), cp = helpers.parsePred(p);
					return gp && cp && gp.name === cp.name && gp.args.length === cp.args.length;
				}));
				if (!cand) continue;
				if (addedNodes.length + 1 > params.lMax) break;
				const argMap = helpers.deriveArgs(cand, p);
				let cnt = dag.nodes.filter((n) => n.skill === cand.id).length + 1;
				const bid = helpers.bindSkill(cand, argMap);
				addedNodes.push({
					id: cand.id + ":" + cnt,
					kind: "skill",
					skill: cand.id,
					name: cand.name,
					args: bid.args,
					params: bid.params,
					precondition: bid.precondition,
					effect: bid.effect,
					verifier: bid.verifier,
					status: "pending",
					confidence: 1,
					repairBudget: params.rMax,
					repairCount: 0
				});
			}
			if (!addedNodes.length) return null;
			const addedEdges = [];
			addedNodes.forEach((an) => {
				an.effect.forEach((e) => {
					if (node.precondition.indexOf(e) >= 0) addedEdges.push({
						from: an.id,
						to: node.id,
						type: "state",
						label: e
					});
				});
				addedEdges.push({
					from: "src",
					to: an.id,
					type: "order",
					label: "repair"
				});
			});
			if (addedNodes.length > params.lMax || addedEdges.length > params.eMax) return null;
			addedNodes.forEach((an) => dag.nodes.push(an));
			addedEdges.forEach((e) => dag.edges.push(e));
			return {
				operator: "InsertPrereq",
				patch: {
					addedNodes: addedNodes.map((a) => a.id),
					addedEdges: addedEdges.length
				},
				bounded: true
			};
		},
		Substitute({ dag, node, library, helpers }) {
			const dreq = helpers.downstreamReq(dag, node);
			if (!dreq.length) return null;
			const alt = library.find((s) => s.id !== node.skill && dreq.every((p) => (s.effect || []).indexOf(p) >= 0));
			if (!alt) return null;
			node.skill = alt.id;
			node.name = alt.name;
			node.precondition = (alt.precondition || []).slice();
			node.effect = (alt.effect || []).slice();
			return {
				operator: "Substitute",
				patch: { replacedWith: alt.id },
				bounded: true
			};
		},
		Rewire({ dag, node }) {
			const idx = dag.edges.findIndex((e) => e.to === node.id && e.type === "order");
			if (idx < 0) return null;
			dag.edges.splice(idx, 1);
			return {
				operator: "Rewire",
				patch: { removedEdges: 1 },
				bounded: true
			};
		}
	};
	const DEFAULT_ORDER = {
		precondition: [
			"InsertPrereq",
			"Rebind",
			"Substitute",
			"Rewire",
			"Bypass"
		],
		postcondition: [
			"Substitute",
			"Rebind",
			"Rewire",
			"Bypass",
			"InsertPrereq"
		],
		execution: [
			"Substitute",
			"Rebind",
			"Rewire",
			"Bypass"
		],
		timeout: ["Substitute", "Bypass"]
	};
	function helperBag() {
		return {
			bindSkill,
			parsePred,
			predArg,
			downstreamReq(dag, node) {
				const req = /* @__PURE__ */ new Set();
				dag.edges.forEach((e) => {
					if (e.from === node.id) {
						const t = dag.nodes.find((n) => n.id === e.to);
						if (t && t.precondition) t.precondition.forEach((p) => req.add(p));
					}
				});
				const snk = dag.nodes.find((n) => n.id === "snk");
				if (snk) snk.precondition.forEach((p) => {
					if (node.effect.indexOf(p) >= 0) req.add(p);
				});
				return Array.from(req).filter((p) => node.effect.indexOf(p) >= 0);
			},
			deriveArgs(cand, concrete) {
				const args = (cand.params || []).map(() => null);
				const cp = parsePred(concrete);
				if (!cp) return args;
				(cand.effect || []).forEach((g) => {
					const gp = parsePred(g);
					if (gp && gp.name === cp.name && gp.args.length === cp.args.length) gp.args.forEach((ga, i) => {
						const pi = cand.params.indexOf(ga);
						if (pi >= 0) args[pi] = cp.args[i];
					});
				});
				return args;
			}
		};
	}
	async function repairWith(deps, dag, event) {
		const { params, skillSource, operators, store } = deps;
		const node = dag.nodes.find((n) => n.id === event.nodeId);
		if (!node) return {
			ok: false,
			error: "node not found: " + event.nodeId
		};
		if (node.repairBudget <= 0) return {
			ok: true,
			repaired: false,
			escalate: "local-exhausted",
			dag
		};
		node.repairBudget--;
		node.repairCount++;
		const library = await skillSource.list();
		const order = params.operatorOrder || DEFAULT_ORDER[event.type] || DEFAULT_ORDER.precondition;
		const helpers = helperBag();
		for (const name of order) {
			const op = operators[name];
			if (!op) continue;
			const patch = await op({
				dag,
				node,
				event,
				library,
				params,
				helpers
			});
			if (patch) {
				node.status = "ready";
				layoutNodes(dag.nodes, dag.edges);
				await store.set("plan:" + dag.planId, dag);
				return {
					ok: true,
					repaired: true,
					dag,
					patch
				};
			}
		}
		return {
			ok: true,
			repaired: false,
			escalate: "local-failed",
			dag
		};
	}
	function createGraspCore(options) {
		const opts = options || {};
		const params = Object.assign({}, DEFAULT_PARAMS, opts.params || {});
		const deps = {
			params,
			skillSource: opts.skillSource,
			proposer: opts.proposer || { propose: async ({ retrieval, skills }) => {
				const byId = {};
				skills.forEach((s) => {
					byId[s.id] = s;
				});
				return (retrieval ? retrieval.skills : []).map((id) => ({
					skill: id,
					args: byId[id].args || []
				}));
			} },
			store: opts.store || memoryStore(),
			llmClient: opts.llmClient || null,
			operators: Object.assign({}, BUILTIN_OPERATORS, opts.operators || {})
		};
		if (!deps.skillSource) throw new Error("createGraspCore: skillSource is required");
		return {
			params,
			async compile(input) {
				return compileWith(deps, input || {});
			},
			async verify(planId, nodeId, before, after) {
				const dag = await deps.store.get("plan:" + planId);
				if (!dag) return {
					ok: false,
					error: "plan not found: " + planId
				};
				const res = await verifyNode(deps, dag, nodeId, before, after);
				await deps.store.set("plan:" + planId, dag);
				return res;
			},
			async repair(planId, event) {
				const dag = await deps.store.get("plan:" + planId);
				if (!dag) return {
					ok: false,
					error: "plan not found: " + planId
				};
				return repairWith(deps, dag, event);
			},
			async retrieveOnly(task) {
				return retrieve({
					skills: await deps.skillSource.list(),
					goal: [],
					task,
					episodes: await deps.store.get("memory:episodes") || [],
					params
				});
			},
			route(confidence) {
				return route(confidence, params);
			},
			async record({ task, trajectory, success }) {
				const episodes = await deps.store.get("memory:episodes") || [];
				episodes.push({
					task: task || "",
					trajectory: Array.isArray(trajectory) ? trajectory : [],
					success: success ? 1 : 0
				});
				await deps.store.set("memory:episodes", episodes);
				return {
					recorded: true,
					memorySize: episodes.length
				};
			},
			async getPlan(planId) {
				return deps.store.get("plan:" + planId);
			},
			setParams(patch) {
				Object.assign(params, patch || {});
				return params;
			}
		};
	}
	function memoryStore() {
		const m = /* @__PURE__ */ new Map();
		return {
			get: async (k) => m.has(k) ? m.get(k) : null,
			set: async (k, v) => {
				m.set(k, v);
			},
			del: async (k) => {
				m.delete(k);
			},
			keys: async (prefix) => Array.from(m.keys()).filter((k) => !prefix || k.startsWith(prefix))
		};
	}
	function manifestSource(manifest) {
		const skills = manifest && manifest.skills || [];
		return {
			list: async () => skills,
			get: async (id) => skills.find((s) => s.id === id) || null,
			meta: {
				goal: manifest && manifest.goal || [],
				initial: manifest && manifest.initial_conditions || []
			}
		};
	}
	function dshSkillsSource(skillsApi, opts) {
		const o = opts || {};
		const llmClient = o.llmClient || null;
		const cache = {
			at: 0,
			val: null,
			skipped: [],
			inferred: 0,
			scope: void 0
		};
		const TTL = o.ttlMs || 5e3;
		async function inferGrasp(name, description, whenToUse) {
			if (!llmClient) return null;
			const prompt = [
				"Annotate a skill for graph-based planning.",
				"Name: " + name,
				"Description: " + (description || ""),
				"When to use: " + (whenToUse || ""),
				"",
				"Infer typed predicates for a planning DAG:",
				"- params: free variables/arguments this skill operates on (e.g. [\"object\"])",
				"- precondition: predicates that must be true before running (e.g. [\"holding(object)\"])",
				"- effect: predicates that become true after running (e.g. [\"clean(object)\"])",
				"",
				"Reply with ONLY one JSON object, no prose:",
				"{\"params\":[\"...\"],\"precondition\":[\"...\"],\"effect\":[\"...\"]}"
			].join("\n");
			try {
				const raw = await llmClient.complete({
					prompt,
					temperature: 0
				});
				const m = /{[\s\S]*}/.exec(String(raw || ""));
				if (!m) return null;
				const obj = JSON.parse(m[0]);
				const pre = Array.isArray(obj.precondition) ? obj.precondition.map(String) : [];
				const eff = Array.isArray(obj.effect) ? obj.effect.map(String) : [];
				if (!pre.length && !eff.length) return null;
				return {
					name,
					description,
					params: Array.isArray(obj.params) ? obj.params.map(String) : [],
					precondition: pre,
					effect: eff,
					args: [],
					softVerify: void 0
				};
			} catch (e) {
				return null;
			}
		}
		async function load() {
			if (!skillsApi) return [];
			const scope = typeof o.getScope === "function" ? o.getScope() : void 0;
			const cwd = typeof o.getCwd === "function" ? o.getCwd() : void 0;
			const lookup = {};
			if (scope) lookup.scope = scope;
			if (cwd) lookup.cwd = cwd;
			if (cache.val && Date.now() - cache.at < TTL && cache.scope === scope) return cache.val;
			const listed = await skillsApi.list(lookup);
			const out = [];
			const skipped = [];
			let inferred = 0;
			for (const item of listed) {
				const full = await skillsApi.get(item.name, lookup) || item;
				let g = extractGraspMeta(parseFrontmatter(full && full.content || "") || full);
				if (!g && llmClient) {
					const desc = full && full.description || "";
					const wtu = full && full.whenToUse || "";
					const inf = await inferGrasp(item.name, desc, wtu);
					if (inf) {
						g = inf;
						inferred++;
					}
				}
				if (!g) {
					skipped.push({
						name: item.name,
						reason: "no grasp metadata"
					});
					continue;
				}
				out.push({
					id: slug(item.name),
					name: full && (full.name || full.title) || item.name,
					description: full && full.description || "",
					params: g.params || [],
					precondition: g.precondition || [],
					effect: g.effect || [],
					args: g.args || [],
					softVerify: g.softVerify !== false
				});
			}
			cache.val = out;
			cache.at = Date.now();
			cache.scope = scope;
			cache.skipped = skipped;
			cache.inferred = inferred;
			return out;
		}
		return {
			list: load,
			get: async (id) => (await load()).find((s) => s.id === id) || null,
			skipped: () => cache.skipped || [],
			inferred: () => cache.inferred || 0
		};
	}
	function frontmatterSource(files) {
		const parsed = [];
		const skipped = [];
		files.forEach((f) => {
			const g = extractGraspMeta(parseFrontmatter(f.content));
			if (!g) {
				skipped.push({
					name: f.name,
					reason: "no grasp: block"
				});
				return;
			}
			parsed.push({
				id: slug(f.name),
				name: g.name || f.name,
				description: g.description || "",
				params: g.params || [],
				precondition: g.precondition || [],
				effect: g.effect || [],
				args: g.args || []
			});
		});
		return {
			list: async () => parsed,
			get: async (id) => parsed.find((s) => s.id === id) || null,
			skipped: () => skipped
		};
	}
	function slug(s) {
		return String(s || "").toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "");
	}
	function parseFrontmatter(text) {
		const m = /^---\s*\n([\s\S]*?)\n---/.exec(String(text || ""));
		if (!m) return null;
		const body = m[1];
		const root = {};
		let cur = root;
		body.split("\n").forEach((line) => {
			if (!line.trim() || /^\s*#/.test(line)) return;
			const indented = /^\s{2,}\S/.test(line);
			const kv = /^\s*([a-zA-Z_][\w-]*)\s*:\s*(.*)$/.exec(line);
			if (!kv) return;
			const key = kv[1];
			const raw = kv[2].trim();
			const target = indented ? cur : root;
			if (raw === "") {
				root[key] = root[key] || {};
				cur = root[key];
				return;
			}
			target[key] = parseScalar(raw);
		});
		return root;
	}
	function parseScalar(raw) {
		if (/^\[.*\]$/.test(raw)) return parseInlineArray(raw.slice(1, -1));
		if (raw === "true") return true;
		if (raw === "false") return false;
		if (/^-?\d+(\.\d+)?$/.test(raw)) return Number(raw);
		return raw.replace(/^["']|["']$/g, "");
	}
	function parseInlineArray(inner) {
		const s = String(inner).trim();
		if (!s) return [];
		const out = [];
		let buf = "", depth = 0, quote = null;
		for (let i = 0; i < s.length; i++) {
			const ch = s[i];
			if (quote) {
				if (ch === quote) quote = null;
				else buf += ch;
				continue;
			}
			if (ch === "\"" || ch === "'") {
				quote = ch;
				continue;
			}
			if (ch === "(" || ch === "[") {
				depth++;
				buf += ch;
				continue;
			}
			if (ch === ")" || ch === "]") {
				depth--;
				buf += ch;
				continue;
			}
			if (ch === "," && depth === 0) {
				out.push(buf.trim());
				buf = "";
				continue;
			}
			buf += ch;
		}
		if (buf.trim()) out.push(buf.trim());
		return out.filter((x) => x.length > 0);
	}
	function extractGraspMeta(obj) {
		if (!obj) return null;
		const g = obj.grasp || obj.GraSP || null;
		if (!g) return null;
		const pre = g.precondition || [], eff = g.effect || [];
		if (!pre.length && !eff.length) return null;
		return {
			name: obj.name,
			description: obj.description,
			params: g.params || [],
			precondition: pre,
			effect: eff,
			args: g.args || [],
			softVerify: g.softVerify
		};
	}
	function createProposer(kind, opts) {
		const o = opts || {};
		if (kind === "explicit") return { propose: async () => o.list || [] };
		if (kind === "retrieval") return { propose: async ({ retrieval, skills }) => {
			const byId = {};
			skills.forEach((s) => {
				byId[s.id] = s;
			});
			return (retrieval ? retrieval.skills : []).map((id) => ({
				skill: id,
				args: byId[id].args || []
			}));
		} };
		if (kind === "llm") {
			const fallback = createProposer(o.fallback || "retrieval", o);
			return { propose: async (input) => {
				if (!o.llmClient) return fallback.propose(input);
				const { task, skills, goal } = input;
				const catalog = skills.map((s) => "- " + s.id + "(" + (s.params || []).join(", ") + ")  pre=[" + (s.precondition || []).join("; ") + "]  eff=[" + (s.effect || []).join("; ") + "]").join("\n");
				const prompt = [
					"Task: " + task,
					goal && goal.length ? "Goal predicates (must hold at the end): " + goal.join(", ") : "",
					"",
					"Available skills:",
					catalog,
					"",
					"Propose the minimal ordered set of skill invocations to accomplish the task.",
					"Bind every parameter to a concrete value.",
					goal && goal.length ? "Bind arguments so that the skills' effects EXACTLY match the goal predicates (same predicate names AND values — reuse the argument names appearing inside the goal predicates)." : "",
					"Reply with ONLY a JSON array, no prose: [{\"skill\":\"<id>\",\"args\":[\"<v>\"]}]"
				].join("\n");
				try {
					const raw = await o.llmClient.complete({
						prompt,
						temperature: 0
					});
					const json = /\[[\s\S]*\]/.exec(String(raw || ""));
					if (!json) return fallback.propose(input);
					const arr = JSON.parse(json[0]);
					if (!Array.isArray(arr) || !arr.length) return fallback.propose(input);
					return arr;
				} catch (e) {
					return fallback.propose(input);
				}
			} };
		}
		throw new Error("unknown proposer kind: " + kind);
	}
	function kvStore(storage, prefix) {
		const p = prefix || "grasp:";
		return {
			get: async (k) => {
				const raw = await storage.get(p + k);
				if (raw === void 0 || raw === null) return null;
				return typeof raw === "string" ? JSON.parse(raw) : raw;
			},
			set: async (k, v) => {
				await storage.set(p + k, JSON.stringify(v));
			},
			del: async (k) => {
				await storage.delete ? storage.delete(p + k) : storage.set(p + k, null);
			},
			keys: async (pre) => {
				return ((await storage.keys ? storage.keys() : []) || []).filter((k) => k.startsWith(p + (pre || ""))).map((k) => k.slice(p.length));
			}
		};
	}
	module.exports = {
		createGraspCore,
		memoryStore,
		DEFAULT_PARAMS,
		BUILTIN_OPERATORS,
		DEFAULT_ORDER,
		manifestSource,
		dshSkillsSource,
		frontmatterSource,
		createProposer,
		kvStore,
		parseFrontmatter,
		parseInlineArray,
		extractGraspMeta,
		slug
	};
})))();
const name = "grasp";
const inject = [
	"llm",
	"skills",
	"agents",
	"agentDefaultModel"
];
const APPLE = {
	task: "clean an apple and put it on the countertop",
	manifest: {
		goal: ["clean(apple)", "on(apple,countertop)"],
		initial_conditions: ["at(agent,fridge)"],
		skills: [
			{
				id: "find",
				name: "Find object",
				params: ["object"],
				precondition: [],
				effect: ["knows_loc(object)"]
			},
			{
				id: "open",
				name: "Open receptacle",
				params: [],
				precondition: [],
				effect: ["open(fridge)"]
			},
			{
				id: "pick",
				name: "Pick object",
				params: ["object"],
				precondition: ["knows_loc(object)", "open(fridge)"],
				effect: ["holding(object)"]
			},
			{
				id: "goto",
				name: "Go to location",
				params: ["loc"],
				precondition: [],
				effect: ["at(agent,loc)"]
			},
			{
				id: "clean",
				name: "Clean object",
				params: ["object"],
				precondition: ["holding(object)", "at(agent,sink)"],
				effect: ["clean(object)"]
			},
			{
				id: "put",
				name: "Put object",
				params: ["object", "loc"],
				precondition: ["holding(object)", "at(agent,loc)"],
				effect: ["on(object,loc)"]
			},
			{
				id: "heat",
				name: "Heat object",
				params: ["object"],
				precondition: ["holding(object)"],
				effect: ["hot(object)"]
			},
			{
				id: "slice",
				name: "Slice object",
				params: ["object"],
				precondition: ["holding(object)"],
				effect: ["sliced(object)"]
			}
		]
	},
	proposal: [
		{
			skill: "find",
			args: ["apple"]
		},
		{
			skill: "open",
			args: []
		},
		{
			skill: "pick",
			args: ["apple"]
		},
		{
			skill: "clean",
			args: ["apple"]
		},
		{
			skill: "put",
			args: ["apple", "countertop"]
		},
		{
			skill: "heat",
			args: ["apple"]
		},
		{
			skill: "slice",
			args: ["apple"]
		}
	]
};
function apply(ctx) {
	let currentScope = null;
	let currentCwd;
	const llm = ctx.get("llm");
	const defaultModel = ctx.get("agentDefaultModel");
	let llmClient = null;
	if (llm && defaultModel) {
		const sel = defaultModel.currentSelection();
		if (sel && sel.provider && sel.model) llmClient = { async complete({ prompt, temperature }) {
			const messages = [{
				id: "grasp-" + Date.now() + "-" + Math.random().toString(36).slice(2),
				role: "user",
				content: [{
					type: "text",
					text: prompt
				}],
				source: {
					kind: "plugin",
					plugin: "skill-dag-dsh"
				}
			}];
			let text = "";
			for await (const chunk of llm.stream({
				provider: sel.provider,
				model: sel.model,
				messages,
				temperature: typeof temperature === "number" ? temperature : 0
			})) if (chunk.type === "text-delta" && chunk.text) text += chunk.text;
			return text;
		} };
	}
	async function inferGoal(task, skills) {
		if (!llmClient) return null;
		const effects = (skills || []).map((s) => "  - " + s.id + ": " + (s.effect || []).join("; ")).join("\n");
		const prompt = [
			"Decompose this task into goal predicates for a planning DAG.",
			"Task: " + task,
			"",
			"Available skills and their effects:",
			effects || "  (none)",
			"",
			"A predicate is a first-order atom like \"clean(object)\".",
			"Return the goal predicates that must be TRUE after the task completes.",
			"Reuse the EXACT effect predicates from the list above (same strings), so the plan compiles.",
			"Reply with ONLY a JSON array, no prose: [\"pred(...)\", ...]"
		].join("\n");
		try {
			const raw = await llmClient.complete({
				prompt,
				temperature: 0
			});
			const m = /\[[\s\S]*\]/.exec(String(raw || ""));
			if (!m) return null;
			const arr = JSON.parse(m[0]);
			if (!Array.isArray(arr) || !arr.length) return null;
			return arr.map(String);
		} catch {
			return null;
		}
	}
	const skillsApi = ctx.get("skills");
	const realSource = (0, import_skill_dag.dshSkillsSource)(skillsApi, {
		llmClient,
		getScope: () => currentScope,
		getCwd: () => currentCwd
	});
	const demoSource = (0, import_skill_dag.manifestSource)(APPLE.manifest);
	const skillSource = {
		list: async () => {
			const real = await realSource.list();
			return real.length ? real : demoSource.list();
		},
		get: async (id) => (await skillSource.list()).find((s) => s.id === id) || null,
		skipped: () => realSource.skipped(),
		inferred: () => realSource.inferred(),
		usingDemo: async () => (await realSource.list()).length === 0
	};
	const core = (0, import_skill_dag.createGraspCore)({
		skillSource,
		proposer: (0, import_skill_dag.createProposer)(llmClient ? "llm" : "retrieval", { llmClient }),
		store: (0, import_skill_dag.memoryStore)(),
		llmClient
	});
	const OUT = {
		type: "object",
		additionalProperties: true
	};
	const renderJson = (_args, value) => [{
		type: "text",
		text: JSON.stringify(value)
	}];
	const def = (toolDef) => ctx.tools.register(defineTool(toolDef));
	def({
		name: "grasp_compile_task",
		description: "Compile a natural-language task into a DAG against the real skill library (session + workspace skills): jointly infer skill predicates with a shared vocabulary, infer the goal reusing those effects, retrieve, propose with the LLM (binding args to match the goal), and compile. No manual annotation required.",
		parameters: { task: {
			type: "string",
			required: true,
			description: "Natural-language task to compile into a DAG."
		} },
		output: {
			schema: OUT,
			render: renderJson
		},
		async execute(args, exec) {
			currentScope = exec && exec.agent || null;
			currentCwd = exec && exec.agent && exec.agent.session && exec.agent.session.header && exec.agent.session.header.cwd || void 0;
			const skills = await skillSource.list();
			if (!skills.length) return {
				ok: false,
				reason: "no skills available"
			};
			const goal = await inferGoal(args.task, skills);
			if (!goal || !goal.length) return {
				ok: false,
				reason: "could not infer goal predicates"
			};
			return core.compile({
				task: args.task,
				goal,
				initialConditions: []
			});
		}
	});
	def({
		name: "grasp_compile",
		description: "Compile the available skills into a typed executable DAG (GraSP-style). Runs memory-conditioned retrieval first; if confidence is low it returns a react-fallback with no DAG.",
		parameters: {
			task: {
				type: "string",
				required: true,
				description: "Task description (drives retrieval + routing)."
			},
			goal: {
				type: "json",
				description: "Goal predicates, e.g. [\"clean(apple)\"]."
			},
			initialConditions: {
				type: "json",
				description: "Predicates true at start."
			},
			proposal: {
				type: "json",
				description: "Optional explicit node proposals [{skill, args}]."
			}
		},
		output: {
			schema: OUT,
			render: renderJson
		},
		async execute(args, exec) {
			currentScope = exec && exec.agent || null;
			currentCwd = exec && exec.agent && exec.agent.session && exec.agent.session.header && exec.agent.session.header.cwd || void 0;
			return core.compile(args || {});
		}
	});
	def({
		name: "grasp_verify",
		description: "Verify one executed DAG node: precondition against state-before, effect against state-after. Returns pass/fail plus a typed failure event.",
		parameters: {
			planId: {
				type: "string",
				required: true
			},
			nodeId: {
				type: "string",
				required: true
			},
			before: {
				type: "json",
				description: "True predicates before execution."
			},
			after: {
				type: "json",
				description: "True predicates after execution."
			}
		},
		output: {
			schema: OUT,
			render: renderJson
		},
		async execute(args) {
			return core.verify(args.planId, args.nodeId, args.before, args.after);
		}
	});
	def({
		name: "grasp_repair",
		description: "Apply a bounded local repair (typed operators) to a failed DAG node. Returns the repaired DAG plus the patch.",
		parameters: {
			planId: {
				type: "string",
				required: true
			},
			event: {
				type: "json",
				required: true,
				description: "Failure event {nodeId, type, message, state}."
			}
		},
		output: {
			schema: OUT,
			render: renderJson
		},
		async execute(args) {
			return core.repair(args.planId, args.event);
		}
	});
	def({
		name: "grasp_retrieve",
		description: "Memory-conditioned skill retrieval (GraSP Eq.1/2): fuses direct semantic similarity with episodic memory, returns top-M skills, features and calibrated confidence.",
		parameters: { task: {
			type: "string",
			required: true
		} },
		output: {
			schema: OUT,
			render: renderJson
		},
		async execute(args) {
			return core.retrieveOnly(args.task);
		}
	});
	def({
		name: "grasp_record",
		description: "Record an episode (task, skill trajectory, success) into the experience memory used by retrieval.",
		parameters: {
			task: {
				type: "string",
				required: true
			},
			trajectory: {
				type: "json",
				description: "Ordered skill ids used."
			},
			success: { type: "boolean" }
		},
		output: {
			schema: OUT,
			render: renderJson
		},
		async execute(args) {
			return core.record(args);
		}
	});
	def({
		name: "grasp_status",
		description: "Report GraSP plugin wiring: real skill library in use, skills skipped, LLM-inferred count, LLM availability, and current parameters.",
		parameters: {},
		output: {
			schema: OUT,
			render: renderJson
		},
		async execute() {
			return {
				usingDemo: await skillSource.usingDemo(),
				skipped: skillSource.skipped(),
				inferred: skillSource.inferred(),
				hasLLM: !!llmClient,
				persistent: false,
				params: core.params
			};
		}
	});
	console.log("[grasp] host wired: llm=" + (llmClient ? "on" : "off") + " skills=session+workspace");
}
//#endregion
export { apply, inject, name };
