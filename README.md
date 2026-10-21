# valorant

- `index.html`: 내전 메이커 (참석 조사, 팀 나누기, 맵 뽑기)
- `auction.html`: 경매 내전. 실시간 입찰 서버는 `worker/` (Cloudflare Workers + Durable Objects)
  - 배포: `cd worker && npm install && npx wrangler login && npx wrangler deploy`
  - 배포 후 나온 주소를 `auction.html`의 `PROD_API`에 넣는다
  - 테스트: `cd worker && npm test`, 로컬 서버: `npx wrangler dev` (localhost에서 auction.html을 열면 자동으로 로컬 서버에 붙는다)
