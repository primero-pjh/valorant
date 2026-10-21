// 경매 규칙 (순수 함수). Durable Object와 테스트가 함께 쓴다.
// 상태 s.status: lobby → running ⇄ paused → done
// s.phase (running일 때): bid(입찰 중) → gap(결과 표시) → bid ...
// s.pool은 경매 순서. 유찰된 선수는 맨 뒤로 돌아가고 입찰이 나올 때까지 계속 돈다.

export const GAP_MS = 3000;
const LOG_MAX = 60;

function int(v) { return typeof v === "number" && Number.isInteger(v) ? v : NaN; }
function name(v) { return typeof v === "string" ? v.trim().slice(0, 16) : ""; }
function inRange(v, lo, hi) { return Number.isInteger(v) && v >= lo && v <= hi; }

// input: { caps:[{name,points}], players:[{n,tier?,ag?}], slots, minBid, step, first }
export function createState(input, keygen, now, rand) {
  if (!input || typeof input !== "object") return { err: "잘못된 요청이에요" };
  const caps = Array.isArray(input.caps) ? input.caps : [];
  if (caps.length < 2 || caps.length > 10) return { err: "팀장은 2~10명이어야 해요" };
  const seen = new Set();
  const outCaps = [];
  for (const c of caps) {
    const n = name(c && c.name), p = int(c && c.points);
    if (!n) return { err: "팀장 이름을 입력해 주세요" };
    if (seen.has(n.toLowerCase())) return { err: "팀장 이름이 겹쳐요: " + n };
    if (!inRange(p, 1, 1000000)) return { err: n + " 팀장의 포인트를 확인해 주세요" };
    seen.add(n.toLowerCase());
    outCaps.push({ name: n, points: p, start: p, team: [] });
  }
  const cfg = {
    slots: int(input.slots), minBid: int(input.minBid), step: int(input.step),
    first: int(input.first),
  };
  if (!inRange(cfg.slots, 1, 10)) return { err: "팀당 인원은 1~10명이어야 해요" };
  if (!inRange(cfg.minBid, 1, 1000000)) return { err: "최소 입찰가를 확인해 주세요" };
  if (!inRange(cfg.step, 1, 1000000)) return { err: "입찰 단위를 확인해 주세요" };
  if (!inRange(cfg.first, 5, 120)) return { err: "입찰 타이머는 5~120초예요" };

  const players = Array.isArray(input.players) ? input.players : [];
  const info = {}, pool = [];
  for (const p of players) {
    const n = name(p && p.n);
    if (!n || seen.has(n.toLowerCase())) continue; // 빈 이름, 중복, 팀장 이름은 건너뜀
    seen.add(n.toLowerCase());
    info[n] = {
      tier: typeof p.tier === "string" ? p.tier.slice(0, 12) : "",
      ag: Array.isArray(p.ag) ? p.ag.filter(a => typeof a === "string").slice(0, 3).map(a => a.slice(0, 20)) : [],
    };
    pool.push(n);
  }
  if (pool.length < 1) return { err: "경매에 올릴 선수를 1명 이상 넣어 주세요" };
  if (pool.length > 200) return { err: "선수는 200명까지 올릴 수 있어요" };
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }

  return {
    s: {
      v: 2, created: now, status: "lobby", phase: null, cfg,
      caps: outCaps, info, pool, passes: {}, unsold: [],
      cur: null, last: null, wake: null, left: null, log: [],
      hostKey: keygen(), keys: outCaps.map(() => keygen()),
    },
  };
}

function log(s, now, msg) {
  s.log.push({ at: now, msg });
  if (s.log.length > LOG_MAX) s.log.splice(0, s.log.length - LOG_MAX);
}

function open(s) { return s.caps.map((c, i) => i).filter(i => s.caps[i].team.length < s.cfg.slots); }

function finish(s, now, why) {
  s.status = "done"; s.phase = null; s.wake = null;
  s.unsold = (s.cur ? [s.cur.n] : []).concat(s.pool); s.pool = []; s.cur = null;
  log(s, now, "경매 종료" + (why ? " (" + why + ")" : ""));
}

function next(s, now) {
  const o = open(s);
  if (o.length === 0) return finish(s, now);
  if (s.pool.length === 0) return finish(s, now);
  if (!o.some(i => s.caps[i].points >= s.cfg.minBid)) return finish(s, now, "입찰할 수 있는 팀이 없음");
  s.cur = { n: s.pool.shift(), bid: 0, by: -1 };
  s.phase = "bid";
  s.wake = now + s.cfg.first * 1000;
}

function resolve(s, now) {
  const c = s.cur;
  if (c.by >= 0) {
    const cap = s.caps[c.by];
    cap.points -= c.bid;
    cap.team.push({ n: c.n, price: c.bid });
    s.last = { type: "sold", n: c.n, by: c.by, price: c.bid };
    log(s, now, c.n + " → " + cap.name + " 낙찰 (" + c.bid + "P)");
  } else {
    s.pool.push(c.n);
    s.passes[c.n] = (s.passes[c.n] || 0) + 1;
    s.last = { type: "pass", n: c.n };
    log(s, now, c.n + " 유찰 (순서 맨 뒤로)");
  }
  s.cur = null;
}

// 시간이 지났으면 다음 단계로 넘긴다. 다음에 깨어날 시각(없으면 null)을 돌려준다.
export function tick(s, now) {
  if (s.status !== "running" || s.wake == null) return null;
  if (now < s.wake) return s.wake;
  if (s.phase === "bid") {
    resolve(s, now);
    s.phase = "gap";
    s.wake = now + GAP_MS;
  } else {
    next(s, now);
  }
  return s.wake;
}

export function start(s, now) {
  if (s.status !== "lobby") return { err: "이미 시작했어요" };
  s.status = "running";
  log(s, now, "경매 시작");
  next(s, now);
  return { ok: true };
}

export function end(s, now) {
  if (s.status === "done") return { err: "이미 끝났어요" };
  finish(s, now, "진행자 종료");
  return { ok: true };
}

export function pause(s, now) {
  if (s.status !== "running") return { err: "진행 중이 아니에요" };
  s.status = "paused"; s.left = Math.max(0, s.wake - now); s.wake = null;
  log(s, now, "일시정지");
  return { ok: true };
}

export function resume(s, now) {
  if (s.status !== "paused") return { err: "일시정지 상태가 아니에요" };
  s.status = "running"; s.wake = now + Math.max(s.left, 3000); s.left = null;
  log(s, now, "재개");
  return { ok: true };
}

export function minNext(s) {
  if (!s.cur) return null;
  return s.cur.by < 0 ? s.cfg.minBid : s.cur.bid + s.cfg.step;
}

export function bid(s, ci, amount, now) {
  if (s.status !== "running" || s.phase !== "bid" || !s.cur || now >= s.wake) return { err: "지금은 입찰할 수 없어요" };
  const cap = s.caps[ci];
  if (!cap) return { err: "팀장이 아니에요" };
  if (cap.team.length >= s.cfg.slots) return { err: "팀이 이미 다 찼어요" };
  if (s.cur.by === ci) return { err: "이미 최고 입찰자예요" };
  const min = minNext(s);
  if (!Number.isInteger(amount) || amount < min) return { err: "최소 " + min + "P부터 입찰할 수 있어요" };
  if (amount > cap.points) return { err: "포인트가 부족해요 (남은 " + cap.points + "P)" };
  s.cur.bid = amount; s.cur.by = ci;
  s.wake = now + s.cfg.first * 1000; // 입찰이 들어오면 타이머를 처음부터 다시
  log(s, now, cap.name + " " + amount + "P 입찰 (" + s.cur.n + ")");
  return { ok: true };
}

// 접속자에게 보낼 화면 데이터. 키는 진행자에게만 보낸다.
export function view(s, role, now) {
  const { hostKey, keys, ...pub } = s;
  const out = { passes: {}, ...pub, now, role };
  if (role.host) out.keys = keys;
  return out;
}

export function roleFor(s, key) {
  if (key && key === s.hostKey) return { host: true, cap: -1 };
  const i = key ? s.keys.indexOf(key) : -1;
  return { host: false, cap: i };
}
