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
| `PHONE_WEBHOOK_TOKEN` | ClawOps 번호의 Webhook이 `X-Callorder-Token` 헤더로 보내는 공유 비밀값 |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase 서비스 역할 키 |
| `SIM_ACCESS_CODE` | 시뮬레이터 접속 코드 |

STT는 Meta Muse Voice Transcribe, TTS는 Typecast(`ssfm-v31`, 목소리 서현)입니다. `TTS_API_KEY`에 Typecast 키를 등록합니다. `wrangler.jsonc`의 `TTS_PROVIDER`를 `none`으로 바꾸면 음성 없이 글자로만 진행되고, `soniox` 연결도 코드에 남아 있습니다.

## 배포

`main`에 푸시하면 Cloudflare가 Pages(`callorder-web`)와 Worker(`callorder-voice`)를 빌드해 배포합니다. Supabase 마이그레이션은 배포에 포함하지 않으며 직접 적용합니다.

## 실제 전화

ClawOps 070 번호의 착신을 Webhook(`https://callorder-voice.kwdg1213.workers.dev/phone/voice`, POST)으로 두고 `webhookHeaders`에 `X-Callorder-Token`을 넣습니다. 처음 거는 번호는 `customers`에 자동으로 등록되어(이름 `고객`, 시연용 주소 행복동 12번지, `is_demo=false`) 어느 전화로든 주문할 수 있습니다. `is_demo=false`이므로 번호와 통화, 주문은 공개 화면에 나오지 않고, 가게 계정과 관리자 로그인으로만 보입니다. 발신번호가 표시되지 않는 전화는 고객 없이 연결되며 주문은 할 수 없습니다.

`/sim`의 실제 전화번호 탭에 거는 휴대폰 번호를 넣으면(여러 개는 쉼표로) 그 번호의 통화가 시뮬레이터처럼 실시간 대화로 나오고, 동시에 걸린 통화는 나란히 따로 보입니다. 접속 코드만 있으면 번호를 아는 사람은 누구나 볼 수 있습니다.

미국 번호는 Twilio입니다. 번호의 Voice 설정에서 A call comes in을 Webhook(`https://callorder-voice.kwdg1213.workers.dev/twilio/voice`, HTTP POST)으로 둡니다. `TWILIO_AUTH_TOKEN` 시크릿으로 서명을 검증합니다.
