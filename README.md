# valorant

- `index.html`: 내전 메이커 (참석 조사, 팀 나누기, 맵 뽑기)
- `worker/public/index.html`: 경매 내전 페이지. `worker/` (Cloudflare Workers + Durable Objects)가 페이지와 실시간 입찰 서버를 같이 서빙한다 → https://valorant-auction.valorant-auction.workers.dev/
  - 배포: `cd worker && npm install && npx wrangler login && npx wrangler deploy`
  - 테스트: `cd worker && npm test`, 로컬 서버: `npx wrangler dev` (http://127.0.0.1:8787 로 접속)
