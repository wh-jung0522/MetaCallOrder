# CallOrder

어르신이 전화로 음식·생필품을 주문하는 AI 음성 주문 서비스의 MVP입니다.

```
apps/web            대시보드와 /sim 전화 시뮬레이터, shadcn/ui (Cloudflare Pages)
apps/voice-worker   통화 1건당 Durable Object 1개 (Cloudflare Workers)
packages/audio      μ-law, 리샘플러
packages/agents     프롬프트, 도구, 에이전트 루프, 주문 확인 게이트
packages/adapters   MerchantAdapter와 Supabase 저장소
supabase            마이그레이션과 데모 데이터
eval                종단 간 테스트와 시나리오
```

## 개발

Node 26과 pnpm 12가 필요합니다.

```sh
pnpm install
pnpm test        # 단위 테스트
pnpm e2e         # 가짜 Meta·Soniox·Supabase로 통화 전 과정을 실행 (키 불필요)
pnpm typecheck

cp apps/web/.env.example apps/web/.env.local
pnpm dev:voice   # apps/voice-worker/.dev.vars에 아래 비밀값과 ALLOWED_ORIGINS=http://localhost:5173 필요
pnpm dev:web     # http://localhost:5173/sim
```

## Worker 비밀값

`apps/voice-worker`에서 `npx wrangler secret put <이름>`으로 등록합니다. 스테이징은 `--env staging`을 붙입니다.

| 이름 | 내용 |
|---|---|
| `META_API_KEY` | Meta Model API 키. LLM과 STT 모두 이 키를 씁니다 |
| `TTS_API_KEY` | Typecast API 키 |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase 서비스 역할 키 |
| `SIM_ACCESS_CODE` | 시뮬레이터 접속 코드 |

STT는 Meta Muse Voice Transcribe, TTS는 Typecast(`ssfm-v31`, 목소리 서현)입니다. `TTS_API_KEY`에 Typecast 키를 등록합니다. `wrangler.jsonc`의 `TTS_PROVIDER`를 `none`으로 바꾸면 음성 없이 글자로만 진행되고, `soniox` 연결도 코드에 남아 있습니다.

## 배포

`main`에 푸시하면 Cloudflare가 Pages(`callorder-web`)와 Worker(`callorder-voice`)를 빌드해 배포합니다. Supabase 마이그레이션은 배포에 포함하지 않으며 직접 적용합니다.
