import test from "node:test";
import assert from "node:assert/strict";
import { createState, start, end, bid, tick, pause, resume, view, roleFor, GAP_MS } from "../src/auction.js";

let k = 0;
const keygen = () => "key" + (k++);
const keep = () => 0.999999; // 섞을 때 순서를 그대로 둔다

function make(over = {}) {
  const r = createState({
    caps: [{ name: "A", points: 100 }, { name: "B", points: 100 }],
    players: ["p1", "p2", "p3", "p4"].map(n => ({ n })),
    slots: 2, minBid: 10, step: 5, first: 20, ...over,
  }, keygen, 0, keep);
  assert.ok(r.s, r.err);
  return r.s;
}

// 현재 단계의 마감 시각으로 시계를 옮긴다
function advance(s) { const t = s.wake; tick(s, t); return t; }

test("검증: 팀장 이름 중복, 선수 없음", () => {
  assert.match(createState({ caps: [{ name: "a", points: 1 }, { name: "A", points: 1 }], players: [{ n: "x" }], slots: 1, minBid: 1, step: 1, first: 10 }, keygen, 0, keep).err, /겹쳐요/);
  assert.match(createState({ caps: [{ name: "a", points: 1 }, { name: "b", points: 1 }], players: [{ n: "a" }], slots: 1, minBid: 1, step: 1, first: 10 }, keygen, 0, keep).err, /선수/);
});

test("팀장 이름과 같은 선수는 목록에서 빠진다", () => {
  const s = make({ players: [{ n: "a" }, { n: "p1" }, { n: "P1" }] });
  assert.deepEqual(s.pool, ["p1"]);
});

test("경매 순서는 방을 만들 때 섞여서 정해지고, 그 순서대로 올라온다", () => {
  const r = createState({
    caps: [{ name: "A", points: 100 }, { name: "B", points: 100 }],
    players: ["p1", "p2", "p3"].map(n => ({ n })), slots: 2, minBid: 10, step: 5, first: 20,
  }, keygen, 0, () => 0);
  const order = r.s.pool.slice();
  assert.deepEqual(order, ["p2", "p3", "p1"]);
  start(r.s, 0);
  assert.equal(r.s.cur.n, order[0]);
  assert.deepEqual(r.s.pool, order.slice(1));
});

test("최고 입찰자가 타이머 종료 시 낙찰되고 포인트가 차감된다", () => {
  const s = make();
  start(s, 0);
  assert.equal(s.cur.n, "p1");
  assert.match(bid(s, 0, 5, 1000).err, /최소 10P/);
  assert.ok(bid(s, 0, 10, 1000).ok);
  assert.match(bid(s, 0, 20, 1000).err, /최고 입찰자/);
  assert.match(bid(s, 1, 12, 1000).err, /최소 15P/);
  assert.ok(bid(s, 1, 30, 2000).ok);
  advance(s);
  assert.equal(s.phase, "gap");
  assert.deepEqual(s.caps[1].team, [{ n: "p1", price: 30 }]);
  assert.equal(s.caps[1].points, 70);
  assert.equal(s.last.type, "sold");
});

test("입찰이 들어오면 타이머가 처음부터 다시 시작된다", () => {
  const s = make();
  start(s, 0);
  assert.equal(s.wake, 20000);
  bid(s, 0, 10, 3000);
  assert.equal(s.wake, 23000);
  bid(s, 1, 15, 22000);
  assert.equal(s.wake, 42000);
  assert.match(bid(s, 0, 20, 42000).err, /입찰할 수 없어요/);
});

test("포인트보다 많이 입찰할 수 없다", () => {
  const s = make();
  start(s, 0);
  assert.match(bid(s, 0, 101, 1).err, /부족/);
});

test("유찰된 선수는 순서 맨 뒤로 가고, 입찰이 나올 때까지 계속 돈다", () => {
  const s = make({ players: [{ n: "p1" }, { n: "p2" }] });
  start(s, 0);
  advance(s); // p1 유찰
  assert.deepEqual(s.pool, ["p2", "p1"]);
  advance(s); // p2 등장
  advance(s); // p2 유찰
  assert.deepEqual(s.pool, ["p1", "p2"]);
  advance(s); // p1 다시 등장
  assert.equal(s.cur.n, "p1");
  advance(s); // 또 유찰
  assert.equal(s.passes.p1, 2);
  assert.equal(s.status, "running");
  advance(s); // p2
  bid(s, 0, 10, s.wake - 1);
  advance(s);
  assert.deepEqual(s.caps[0].team, [{ n: "p2", price: 10 }]);
  assert.deepEqual(s.pool, ["p1"]);
});

test("모든 팀이 차면 남은 선수가 있어도 끝난다", () => {
  const s = make({ slots: 1, players: ["p1", "p2", "p3"].map(n => ({ n })) });
  start(s, 0);
  bid(s, 0, 10, 1); advance(s); advance(s);
  assert.match(bid(s, 0, 10, s.wake - 1).err, /다 찼어요/);
  bid(s, 1, 10, s.wake - 1); advance(s); advance(s);
  assert.equal(s.status, "done");
  assert.deepEqual(s.unsold, ["p3"]);
});

test("자리가 남은 팀이 모두 최소 입찰가를 낼 수 없으면 끝난다", () => {
  const s = make({ caps: [{ name: "A", points: 10 }, { name: "B", points: 5 }] });
  start(s, 0);
  bid(s, 0, 10, 1); advance(s); advance(s); // A는 0P, B는 5P라 아무도 10P를 못 냄
  assert.equal(s.status, "done");
  assert.deepEqual(s.unsold, ["p2", "p3", "p4"]);
});

test("진행자가 경매를 끝내면 현재 선수와 남은 순서가 미배정으로 남는다", () => {
  const s = make();
  start(s, 0);
  assert.ok(end(s, 5).ok);
  assert.equal(s.status, "done");
  assert.equal(s.wake, null);
  assert.deepEqual(s.unsold, ["p1", "p2", "p3", "p4"]);
  assert.match(end(s, 6).err, /이미/);
});

test("일시정지 동안 남은 시간이 보존된다", () => {
  const s = make();
  start(s, 0);
  pause(s, 5000);
  assert.equal(s.wake, null);
  assert.equal(tick(s, 999999), null);
  assert.match(bid(s, 0, 10, 6000).err, /입찰할 수 없어요/);
  resume(s, 100000);
  assert.equal(s.wake, 115000);
});

test("진행자에게만 키를 보낸다", () => {
  const s = make();
  const host = roleFor(s, s.hostKey), cap = roleFor(s, s.keys[1]), guest = roleFor(s, "nope");
  assert.deepEqual([host.host, cap.cap, guest.cap], [true, 1, -1]);
  assert.ok(view(s, host, 0).keys);
  assert.equal(view(s, cap, 0).keys, undefined);
  assert.equal(view(s, cap, 0).hostKey, undefined);
});

test("결과 표시 시간이 지나면 다음 선수가 나온다", () => {
  const s = make();
  start(s, 0);
  const t = advance(s);
  assert.equal(s.wake, t + GAP_MS);
  advance(s);
  assert.equal(s.cur.n, "p2");
});
