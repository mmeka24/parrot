# Parrot

**A dubbing agent that earns its own money.**

A creator replies `@parrot dub this to Spanish` under their own video. An autonomous
agent decides whether dubbing it is a profitable bet, pays for the dub out of its own
wallet, publishes it, and earns the money back when international viewers unlock it for
two cents. The creator pays nothing and keeps 60% of every unlock.

Nobody in that sentence has to know what a blockchain is.

Built for the UBC 26 hackathon (UT Austin). Main track: **Consumer Applications**.
Chain: **Arc testnet**. Bounties: **ElevenLabs**, **Grok Bot**, **QuickNode Streams**.

---

## Read this first: what is real and what is not

This section is deliberately at the top, because a demo that overstates itself is worse
than a smaller honest one.

| Subsystem | Status in this repo |
| --- | --- |
| Money maths, split, ledger, EV model, state machine | **Real.** 471 tests. |
| Decision loop, competing agent personas, learning loop | **Real.** Runs on every job. Cold-start funnel sourced and calibrated on 31 real X posts. |
| Viewer unlock payment | **Real, on Arc testnet.** 0.02 USDC transfer per unlock, verified on the explorer. |
| x402 / Circle Gateway integration | **Written against the real SDK, not wired to the unlock route.** See Money flows. |
| On-chain USDC settlement on Arc | **Real, broadcast on Arc testnet.** Agent payouts and dub costs verified on the explorer. |
| ElevenLabs dubbing + Scribe STT QC | **Real, run end to end.** An uploaded clip was dubbed into Spanish and passed QC (97% Spanish). Seeded posts still use stand-in audio. |
| QuickNode Streams webhook + filter | **Real, unit-tested offline.** Never received a live delivery. |
| X API | **Written, never called.** The demo runs on Chirp, a local stand-in for X. |
| Browser extension | **Real, run end to end against Chirp** in Chromium. Never run on x.com. |
| Grok intent parsing | **Used when `XAI_API_KEY` is set;** a regex fallback runs otherwise. |
| ffmpeg audio checks | **Not run.** ffmpeg is absent, so the check reports `skipped`, never `passed`. |

With an empty `.env` the whole flow still runs end to end, and every simulated subsystem
is listed in `GET /api/system` and rendered as a banner in the UI. Nothing silently
pretends to be real.

**We never fabricate a transaction hash.** A settlement that was not broadcast is stored
with `simulated: true` and `txHash: null`, and the mappers emit a "Verify on Arc" link
*only* for a settlement that is confirmed on-chain with a real hash. The UI is
structurally incapable of offering to verify something that did not happen.

---

## The problem

A creator with a good 30-second video reaches the people who speak their language. The
rest of the world scrolls past. Dubbing fixes that, but somebody has to pay for it before
anyone knows whether it was worth it — and creators will not pay upfront for an audience
they cannot see yet.

So the risk sits in the wrong place. Parrot moves it: **the agent takes the bet.** It
pays for the dub, and it only makes money back if people actually watch. If it misjudges,
it eats the loss.

**Users.** Creators with an audience in another language. Viewers who want to watch in
theirs. And, for judges, an agent whose P&L is public and live.

---

## Architecture

```
  Creator on X                         ┌──────────────────────────┐
  "@parrot dub this to Spanish"───────▶│  Grok / regex parser     │
                                       │  → {url, lang, duration} │
                                       └───────────┬──────────────┘
                                                   │  zod-validated
                                                   ▼
                                       ┌──────────────────────────┐
                 ┌────── declined ─────│   DECISION LOOP          │
                 │  (bot explains why) │   budget → predict → EV  │
                 │                     │   3 personas compete,    │
                 │                     │   first approver claims  │
                 │                     └───────────┬──────────────┘
                 │                                 │ EV > min_margin
                 │                                 ▼
                 │                     ┌──────────────────────────┐
                 │                     │  AGENT WALLET pays       │
                 │                     │  ElevenLabs (off-chain)  │
                 │                     └───────────┬──────────────┘
                 │                                 ▼
                 │                     ┌──────────────────────────┐
                 │   ┌──── rejected ───│  QC GATE                 │
                 │   │  (loss booked)  │  duration / language /   │
                 │   │                 │  audio sanity            │
                 │   │                 └───────────┬──────────────┘
                 │   │                             │ passed
                 ▼   ▼                             ▼
            bot reply on X              ┌──────────────────────────┐
                                        │  Dub page (PWA)          │
                                        │  8s preview → "Unlock    │
                                        │  for $0.02"              │
                                        └───────────┬──────────────┘
                                                    │ x402 (gasless, batched)
                                                    ▼
                                        ┌──────────────────────────┐
                                        │  Circle Gateway          │
                                        │  pending → available     │
                                        └───────────┬──────────────┘
                                                    │ withdraw()
                                                    ▼
                                        ┌──────────────────────────┐
                                        │  Arc testnet: real USDC  │
                                        │  ERC-20 transfers        │
                                        │  agent 40% / creator 60% │
                                        └───────────┬──────────────┘
                                                    ▼
                                   QuickNode Stream → signed webhook
                                                    ▼
                                   live P&L dashboard + "Verify on Arc"
```

**Monorepo** (npm workspaces — see *Deviations*):

```
packages/shared     money units, EV model, split math, state machine,
                    copy map, zod schemas, Arc/Gateway constants, API contract
apps/backend        job pipeline, decision loop, payments, dubbing, QC,
                    bot, chain feed, HTTP API
apps/web            Next.js 15 PWA: dub page, dashboards, bot console
```

---

## Job state machine

```
REQUESTED → PARSED → EVALUATING ─┬─▶ DECLINED
                                 └─▶ APPROVED → DUBBING → QC ─┬─▶ REJECTED_BY_QC
                                                              └─▶ PUBLISHED
                                                                      ↓
                                                                   EARNING ⇄ SETTLED
```
Plus `FAILED` from any non-terminal state, always with a reason.

One typed reducer is the only way a job changes state, and every transition appends an
event row. The dashboard timeline and the bot's replies are built from that log, so they
cannot drift from what actually happened.

`EARNING ⇄ SETTLED` is deliberately two-way: `SETTLED` means *everything owed so far has
been paid out*, and a new unlock legitimately moves it back. Modelling it one-way would
have forced us to lie about jobs that keep earning.

**Dedupe:** one dub per `(source video, target language)`, enforced by a unique index.
A repeat request returns the existing link instantly rather than paying twice.

---

## Money flows

Four flows, one `PaymentService` method each, every one producing a ledger row.

### 1. Treasury funding (test mode)
Agent wallets and the payout treasury are funded from `faucet.circle.com`. This is a
human, captcha-gated step; we record it, we do not automate it.

### 2. The dubbing cost — honestly off-chain
The ElevenLabs bill is paid in fiat on a card. It is **not** a blockchain transaction and
we do not dress it up as one. We mirror it as a ledger debit against the agent, because
without it the agent would look profitable purely because its costs were invisible.
Optionally (`COST_SINK_ADDRESS`) we also send a real on-chain transfer of the same amount
so the spend is publicly visible. Which of the two happened is recorded per settlement.

### 3. Viewer unlock — a real transfer per unlock
`POST /api/dubs/:id/unlock` sends **0.02 USDC on Arc from the viewer wallet to the revenue
wallet** and waits for it to confirm. Only then is the unlock recorded and split. No
transfer, no unlock. The unlock's payment reference *is* the transaction hash, so the
viewer's receipt has a "Verify on Arc" link to that exact payment. Re-watching is free:
one charge per viewer per dub, enforced by an idempotency key. Measured on Arc testnet:
confirmed in under a second, with a network fee of roughly $0.001.

Without `VIEWER_POOL_PRIVATE_KEY` the unlock falls back to ledger-only, flagged
`simulated`, with no link. The demo's simulated-traffic control always uses that
ledger-only path, so it can run hundreds of unlocks without spending real funds; every one
of those is labelled simulated.

### 4. Split and settlement — real transfers
Each unlock is split instantly in the ledger (40% agent / 60% creator, stored per job).
On a short cadence the scheduler sweeps what is owed and sends **real USDC ERC-20
transfers** on Arc, each with an explorer link. A creator who has not connected a wallet
yet has their share held until they claim it.

### Not yet wired: Circle Gateway (x402) batching

The x402 seller/buyer code in `apps/backend/src/payments/` (EIP-3009
`TransferWithAuthorization` against the GatewayWallet EIP-712 domain, the `PAYMENT_MODE`
switch, the Facilitator fallback) is implemented and unit-tested but **not connected to
the unlock route**. The unlock path above is a plain per-payment transfer instead. Gateway
would make unlocks gasless and batched, at the cost of no per-unlock transaction to
verify: an accepted authorization only credits a pending Gateway balance until
`withdraw()` runs.

### Economics consistency

`r`, the agent's expected revenue per international view, is **derived, never hardcoded**:

```
r = unlock_conversion_rate × unlock_price × agent_share
  = 12.5% × $0.02 × 40%
  = $0.001 per view
```

A unit test fails if anyone changes the price or the split without the conversion
assumption following. The conversion rate is a learned, per-(category, language)
parameter, and the dashboard shows this arithmetic.

### Safety

Testnet only. Keys in env only, never logged (tested). Idempotency key on every payout.
One audited payout function — `PaymentService.settle()` is the only thing that can cause
a transfer, and `transferUsdc()` is the only thing that broadcasts one. Rate limits and a
per-viewer unlock cap.

---

## How the crypto is hidden

**Vocabulary.** Every user-facing string lives in `packages/shared/src/copy.ts`. A test
fails the build if any of `wallet`, `USDC`, `gas`, `transaction`, `chain`, `hash`,
`crypto`, `token`, `testnet`, `settle`… appears. The test also proves it can *catch* a
violation, so a green suite means something. Two documented exceptions: the small
"Verify on Arc" link inside a receipt drawer, and the judges-only "Under the hood" page.

**Accounts.** A viewer gets an account silently from a cookie on first visit — no sign-in,
no popup, no network switching. Creators are matched by X user ID, so **earnings accrue
before they have ever signed in**; claiming attaches the account afterwards.

**Gas.** Arc uses USDC for gas, so one balance covers everything. Viewers never touch it:
the pooled viewer wallet pays the ~$0.001 fee per unlock, and we pre-fund every wallet
that pays fees.

**Custody — stated plainly.** In test mode viewer payments are **custodial and pooled**:
one server-held key pays every unlock, while each viewer's balance is tracked in our
ledger. (Gateway batching would not lift this on its own: it requires **EOA signatures
and does not support ERC-1271**, which rules out passkey/smart-contract wallets as the
*buyer*.) This is not how a real deployment should
work, and the path off it is non-custodial accounts (below).

**Receipts, not hashes.** "Unlock paid." "Creator share sent." The main UI never shows a
hash.

---

## The decision loop

For each job, every active agent independently:

1. **Budget check** — `balance − cost ≥ floor`, plus per-job exposure and a daily cap.
2. **Predict** dub viewers as a **low / likely / high range**. With history, from a
   per-`(category, language)` bucket average scaled by this post's engagement. On a cold
   start, from a funnel where every step has a stated source:

   ```
   people who saw the post         X's own view count (or interactions ÷ 2.7%, the
                                    median measured on 31 real X video posts)
   × share of X in that language   DataReportal ad reach by country (Spanish ≈ 8.1%)
   × how well the post reaches it  50%  (assumption — corrected by the learning loop)
   × how many open the dub         5%   (assumption; YouTube's dubbed tracks get >25%
                                         of watch time with one-tap switching — our ceiling)
   ```

   The persona decides which end of the range it plans on: Kestrel the low case, Magpie
   the likely case, Finch the high case.
3. **Compute EV:** `EV = p_success × (predicted_views × r) − dub_cost`, where `p_success`
   is **that agent's own realised QC pass rate** — an agent that keeps shipping bad dubs
   correctly becomes pessimistic about itself.
4. **Bid** if `EV > min_margin`.

The first approver claims the job via an atomic compare-and-set, so the personas visibly
compete. They evaluate in shuffled order so no persona wins purely by list position.

The worked example, which is an executable test:

```
1.2M views × 8.1% × 50% × 5% ≈ 2,425 likely Spanish viewers
12.5% unlock rate · 70% chance of passing QC · $0.25 cost (30s)
EV = 0.7 × (2,425 × $0.001) − $0.25 = +$1.44   → dub it
```

The same funnel gives a 10k-view post about 20 viewers, so a 2-cent dub only pays on posts
with hundreds of thousands of views. That is what the agents do.

**Personas:** *Magpie* (balanced, plans on the likely case), *Kestrel* (cautious — wide
margin, plans on the low case), *Finch* (aggressive, plans on the high case, Spanish only).

**Learning loop.** 24 hours later (one minute in demo mode) the realised views and unlocks
are compared against the estimate and folded back into the bucket with exponential
smoothing. It is idempotent, so a re-run cannot bias a bucket twice. Prediction error over
time is charted. In demo mode outcomes are simulated and every such record is flagged.

---

## The QC gate, and its limits

Before publishing: **duration match** within 10%; **language detection** via ElevenLabs
Scribe on the dub itself, which must report the target language above a confidence floor;
**audio sanity** via ffmpeg (non-silence ratio, dead gaps, loudness). Back-translation was
on the cut list and is **not implemented**.

A failure means the dub is **not published**, the cost stays booked as a loss, the agent's
`p_success` drops, and the bot tells the creator the truth rather than handing them
something bad.

**Limits, honestly:** this checks that a dub is *plausibly the right language and not
broken*. It does not check that the translation is *good*. ffmpeg is not installed here,
so the audio check reports `status: 'skipped'` — a tri-state `status` field exists
precisely because reading a boolean `passed` would make a check that never ran look like
one that succeeded.

---

## Setup

```bash
git clone <this repo> && cd ubc
npm install              # needs Node 20.19+ (Tailwind 4 requires it)
cp .env.example .env     # works as-is; no credentials required

npm run dev:backend      # http://localhost:8787 (reads the root .env itself)
npm run dev:web          # http://localhost:3100
```

The web app talks to the local backend via `apps/web/.env.development`. If the
backend is down, every page falls back to built-in sample data.

`.env.example` documents every variable. To make the money real, fund wallets at
`faucet.circle.com` and fill in the key fields; the app picks up each capability as its
credentials appear.

```bash
npm test                 # 428 tests
npm run typecheck
```

## Parrot as a browser extension

Parrot also ships as a Chrome extension that draws onto the posts in a timeline.
Because the real X API bills $0.20 for every reply that contains a link, the
timeline it runs on in this repo is **Chirp** (`apps/x-clone`), a small local
stand-in for X that shares the backend's store.

```bash
npm run dev:backend        # :8787 - Parrot, plus Chirp's own /api/x routes
npm run dev:xclone         # :3200 - Chirp
npm run build:extension    # -> apps/extension/dist
```

Then `chrome://extensions` → Developer mode → **Load unpacked** →
`apps/extension/dist`, and open http://localhost:3200.

Under each post the extension adds a strip:

- **Anyone** sees "Also in Spanish, Hindi…" chips that open the dub page.
- **The creator, on their own video**, gets **Dub this** → pick a language.

"Dub this" does not call Parrot. It opens the reply box under the creator's own
post, types `@parrot dub this to French`, and sends it, exactly what the creator
would do by hand. Parrot finds that mention like any other, checks **on its own
records** that the person asking wrote the post, and answers in the thread. The
extension's only server calls are two reads (`/api/extension/config`,
`/api/extension/posts?ids=`); it sends post ids, never post content, because
anything read out of a web page can be forged by the person looking at it.

**How it finds posts.** Chirp emits x.com's own `data-testid` hooks
(`tweet`, `User-Name`, `tweetTextarea_0`, …), listed once in
`packages/shared/src/x-dom.ts`, and the content script reads only those. The same
script is meant to run on x.com unchanged. **That has not been tried.** The
manifest only matches `localhost`, x.com changes those hooks without notice, and
the backend's mock adapter would not recognise real post ids anyway.

**Seeded posts vs. uploads.** The four seeded posts have engagement numbers but no
footage, and they are always dubbed with the stand-in audio, even when an
ElevenLabs key is set. A video **uploaded through Chirp's composer** is a real
file: with `ELEVENLABS_API_KEY` set, the backend sends those bytes to ElevenLabs
and the dub is real (and costs credits).

**Simulated reach.** A post written a moment ago has no views, and the agents
correctly refuse to dub it. So when you attach a video, Chirp's composer offers a
*Simulated reach (demo)* picker (default 1.2M views). The post gets those views
plus likes, replies and reposts at the median rate measured on real X posts.

## Demo

The backend seeds the three-part story on boot, deterministically:

```
REJECTED_BY_QC   ← Chef Leo: good numbers, agent takes the bet, dub fails the gate, loss booked
DECLINED         ← devlog: not enough interest; the bot says what would change its mind
PUBLISHED        ← Maria: the worked example; earns on every unlock
```

Then: open the dub page on a phone, tap **Unlock for $0.02**, watch instantly. Turn on
**simulated traffic** (`POST /api/demo/traffic`) — synthetic viewers, but **real payments
through the same code path a human uses**. Watch the agent P&L, the split, and the
settlements update live. `POST /api/demo/learn` compresses the 24-hour learning loop.

---

## Addresses used (Arc testnet, chain ID 5042002)

| What | Address |
| --- | --- |
| USDC (ERC-20 interface, 6 decimals) | `0x3600000000000000000000000000000000000000` |
| Circle GatewayWallet | `0x0077777d7EBA4688BDeF3E311b846F25870A19B9` |
| Circle GatewayMinter | `0x0022222ABE238Cc2C7Bb1f21003F0a260052475B` |
| RPC | `https://rpc.testnet.arc.io` |
| Explorer | `https://explorer.testnet.arc.io` |
| Gateway facilitator (testnet) | `https://gateway-api-testnet.circle.com` |

No custom contracts were deployed. Parrot uses USDC's ERC-20 interface and Circle's
Gateway contracts as they are.

### Two Arc traps worth documenting

**1. USDC has two decimal counts.** It is the native gas token at **18 decimals** and an
ERC-20 at **6**. Mixing them is a 10¹² error. Every conversion goes through one
unit-tested helper, and the internal accounting unit is integer micro-dollars —
deliberately identical to the ERC-20 base unit, so ledger rows and transfer amounts are
the same integer with no conversion at all. Money is `bigint` everywhere; no float ever
touches it.

**2. Arc reports every USDC movement twice.** Once as an EIP-7708 system log from
`0xffff…fffE` at 18 decimals, and again on the ERC-20 mirror at 6. **Indexing both
double-counts the P&L.** We settle via the ERC-20 interface and our ledger is in micros,
so the stream filter matches the ERC-20 address only.

---

## Deviations from the brief

- **npm workspaces, not pnpm.** Corepack could not write to `Program Files` without
  elevation on the build machine. `npm run demo` replaces `pnpm demo`.
- **In-memory store is the default driver**, not Postgres. A live pitch should not depend
  on a container starting. The Drizzle schema is written and is the production path.
- **ElevenLabs dubbing v1, not v2.** v1 is the only tier whose API returns a muxed A/V
  byte stream, and at $0.50/min versus v2's $2.20/min it is the only one where a 2-cent
  unlock economy closes. A 30s dub costs $0.25; at a 40% share that needs ~32 unlocks to
  break even.

## What we would build next

- **Non-custodial accounts.** The honest blocker is that Gateway batching is EOA-only
  today; the path is per-viewer Circle Modular Wallets with passkeys once smart-contract
  signatures are supported, or the per-payment Facilitator path for users who want custody.
- **A real fiat onramp**, replacing the test-mode starter credit with card and Apple Pay.
- **Exchange mode** — fans post a bounty for a dub they want, agents bid, escrow releases
  on a QC pass and slashes the stake on junk. Reuses the QC gate and ledger.
- **More platforms than X**, more languages, and video beyond short clips.
- **Mainnet on Arc**, once the custody story is non-custodial.
- **Back-translation scoring**, to check meaning and not just language.

---

Built in six days. The parts that are real are tested; the parts that are not are labelled.
