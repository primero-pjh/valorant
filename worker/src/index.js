import { DurableObject } from "cloudflare:workers";
import { createState, start, pause, resume, bid, tick, view, roleFor } from "./auction.js";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", ...CORS } });
}

function randId(len) {
  const abc = "abcdefghijkmnpqrstuvwxyz23456789", b = crypto.getRandomValues(new Uint8Array(len));
  return Array.from(b, x => abc[x % abc.length]).join("");
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (req.method === "OPTIONS") return new Response(null, { headers: CORS });

    // POST /rooms → 새 경매방
    if (req.method === "POST" && url.pathname === "/rooms") {
      const body = await req.text();
      if (body.length > 50000) return json({ err: "요청이 너무 커요" }, 413);
      for (let i = 0; i < 3; i++) {
        const id = randId(6);
        const res = await env.ROOM.get(env.ROOM.idFromName(id)).fetch("https://room/init", { method: "POST", body });
        if (res.status === 409) continue;
        const out = await res.json();
        return json(out.err ? out : { room: id, ...out }, res.status);
      }
      return json({ err: "방을 만들지 못했어요. 다시 시도해 주세요" }, 500);
    }

    // GET /rooms/:id/ws?k=키 → 실시간 연결
    const m = url.pathname.match(/^\/rooms\/([a-z0-9]{6})\/ws$/);
    if (m) {
      if (req.headers.get("Upgrade") !== "websocket") return json({ err: "websocket only" }, 426);
      return env.ROOM.get(env.ROOM.idFromName(m[1])).fetch(new Request("https://room/ws" + url.search, req));
    }

    return json({ ok: true, name: "valorant-auction" });
  },
};

export class AuctionRoom extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.s = null;
    ctx.blockConcurrencyWhile(async () => { this.s = (await ctx.storage.get("s")) || null; });
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/init") {
      if (this.s) return json({ err: "exists" }, 409);
      let input;
      try { input = JSON.parse(await req.text()); } catch { return json({ err: "잘못된 요청이에요" }, 400); }
      const r = createState(input, () => randId(12), Date.now());
      if (r.err) return json({ err: r.err }, 400);
      this.s = r.s;
      await this.ctx.storage.put("s", this.s);
      return json({ hostKey: this.s.hostKey, keys: this.s.keys });
    }
    if (url.pathname === "/ws") {
      if (!this.s) return json({ err: "없는 경매방이에요" }, 404);
      const pair = new WebSocketPair();
      const role = roleFor(this.s, url.searchParams.get("k"));
      this.ctx.acceptWebSocket(pair[1]);
      pair[1].serializeAttachment(role);
      pair[1].send(JSON.stringify({ t: "state", s: view(this.s, role, Date.now()) }));
      return new Response(null, { status: 101, webSocket: pair[0] });
    }
    return json({ err: "not found" }, 404);
  }

  async webSocketMessage(ws, raw) {
    if (!this.s || typeof raw !== "string" || raw.length > 500) return;
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    const role = ws.deserializeAttachment() || { host: false, cap: -1 };
    const now = Date.now(), s = this.s;
    let r;
    if (msg.t === "bid" && role.cap >= 0) r = bid(s, role.cap, msg.amount, now);
    else if (msg.t === "start" && role.host) r = start(s, now, Math.random);
    else if (msg.t === "pause" && role.host) r = pause(s, now);
    else if (msg.t === "resume" && role.host) r = resume(s, now);
    else r = { err: "권한이 없어요" };
    if (r.err) { ws.send(JSON.stringify({ t: "err", msg: r.err })); return; }
    await this.commit();
  }

  async alarm() {
    if (!this.s) return;
    tick(this.s, Date.now(), Math.random);
    await this.commit();
  }

  async commit() {
    await this.ctx.storage.put("s", this.s);
    if (this.s.wake != null) await this.ctx.storage.setAlarm(this.s.wake);
    else await this.ctx.storage.deleteAlarm();
    const now = Date.now();
    for (const ws of this.ctx.getWebSockets()) {
      try { ws.send(JSON.stringify({ t: "state", s: view(this.s, ws.deserializeAttachment(), now) })); } catch {}
    }
  }

  async webSocketClose(ws, code) {
    try { ws.close(code, "bye"); } catch {}
  }
}
