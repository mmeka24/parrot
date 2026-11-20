# Parrot

**A dubbing agent that earns its own money.**

A creator replies `@parrot dub this to Spanish` under their own video. An autonomous
agent decides whether dubbing it is a profitable bet, pays for the dub out of its own
wallet, publishes it, and earns the money back when international viewers unlock it for
two cents. The creator pays nothing and keeps at least 60% of every unlock — more when
several agents compete for the job, because the agents bid against each other for it.

Nobody in that sentence has to know what a blockchain is.

Built for the UBC 26 hackathon (UT Austin). Main track: **Consumer Applications**.
Chain: **Arc testnet**. Bounties: **ElevenLabs**, **Grok Bot**, **QuickNode Streams**.

---

## Read this first: what is real and what is not

This section is deliberately at the top, because a demo that overstates itself is worse
than a smaller honest one.

| Subsystem | Status in this repo |
| --- | --- |
| Money maths, split, ledger, EV model, state machine | **Real.** 517 tests. |
| Decision loop, competing agent personas, learning loop | **Real.** Runs on every job. Cold-start funnel sourced and calibrated on 31 real X posts. |
| Sealed-bid agent auction | **Real.** Runs on every job: the lowest bid for the agent's revenue share wins, and the winner gets exactly what it bid. Tested, and checked in a 400-job simulation. |
| Open agent registration (`POST /api/agents/register`) | **Real.** Run live through the public deploy. Third-party bid endpoints (`bidUrl`) are tested against fakes; no outside agent has bid live yet. |
| `ParrotSplitter` smart contract | **Real, deployed on Arc testnet** at [`0x1699adb8f1495eb9bdb1529d03db784cd424ad6d`](https://explorer.testnet.arc.io/address/0x1699adb8f1495eb9bdb1529d03db784cd424ad6d) and run end to end (2026-11-20): auctions and QC verdicts recorded on-chain, and (on the first version, below) a live $0.02 unlock split by the contract in one transaction, 29.5% to the winning agent and 70.5% held for the creator. Also tested on a local chain. Without `SPLITTER_ADDRESS` the app uses the transfer path in *Money flows*, unchanged. |
| Viewer unlock payment | **Real, on Arc testnet.** 0.02 USDC transfer per unlock, verified on the explorer. |
| x402 / Circle Gateway integration | **Written against the real SDK, not wired to the unlock route.** See Money flows. |
| On-chain USDC settlement on Arc | **Real, broadcast on Arc testnet.** Agent payouts and dub costs verified on the explorer. |
| Independent QC judge + meaning check | **Real, tested; not yet run on a real dub.** ElevenLabs makes the dub and Scribe only transcribes; the verdict on language and meaning comes from Grok (xAI). The back-translation meaning check needs a clip with real audio, which the seeded demo posts do not have, so on them it reports `skipped`. |
| ElevenLabs dubbing + Scribe STT QC | **Real, run live once (2026-11-19).** A 12.5s English clip was dubbed to Spanish in 9s; QC heard Spanish at 98.6% and passed it. That first live run found two bugs the mocks hid, both fixed and now tested: uploads were labelled `application/octet-stream` (rejected with HTTP 400), and speech-to-text answers `spa` where jobs say `es`, so every correct dub failed QC. |
| QuickNode Streams webhook + filter | **Unit-tested offline, not connected.** Nothing in the running server creates the stream or mounts the webhook yet, and it has never received a live delivery. |
| X API | **Written, never called.** The demo runs on Chirp, a local stand-in for X. |
| Browser extension | **Real, run end to end against Chirp** in Chromium, including through the public deploy. **On x.com: built, never run on the live site** (x.com refuses automated browsers, so it cannot be tested from here). |
| Grok intent parsing | **Real, live.** Verified with a request the regex cannot read: "the language they speak in Brazil" came back as Portuguese, and the deployed bot dubbed it. The regex remains the fallback if a Grok call fails. |
| ffmpeg audio checks | **Not run.** ffmpeg is absent, so the check reports `skipped`, never `passed`. |

With an empty `.env` the whole flow still runs end to end, and every simulated subsystem
is listed in `GET /api/system` and rendered as a banner in the UI. Nothing silently
pretends to be real.

### What changed in this revision

- **A real auction.** The old rule gave the job to whichever approving agent happened
  to be checked first, at a fixed 40% share. Now every agent submits a sealed bid (the
  smallest share it needs to clear its own margin), the lowest bid wins, and it gets
  exactly what it bid. Creators kept 95-99% instead of 60% on contested jobs in our tests.
- **Agents are held to their forecasts.** Each agent's forecasts are scaled by how its
  past forecasts compared with reality, so an agent cannot win auctions just by being
  optimistic. In simulation this nearly halved the share of dubs that lost money (22% to 12%).
- **Anyone can enter an agent**, with their own settings or their own model behind a
  `bidUrl`.
- **A smart contract, `ParrotSplitter`,** records each auction on-chain (winner, share and
  a hash of every agent's reasoning) and splits each unlock straight to the creator and
  the agent in one transaction.
- **More conservative funnel assumptions**: reach 50% to 35%, dub uptake 5% to 2%. A
  1.2M-view post now forecasts about 680 Spanish dub viewers instead of about 2,400.
- **QC is judged by someone other than the dubber.** ElevenLabs makes every dub, so it
  no longer grades its own work: Scribe only transcribes, and Grok (xAI) decides the
  language and runs a new **meaning check** (back-translation, score 0-100, 70 to pass).
- **QC verdicts go on-chain.** `recordQc` writes pass/fail and the meaning score next to
  the auction, once per job, and keeps each agent's public passed/failed count.
- **Tooling**: `npm run deploy:splitter` deploys the contract; `npx tsx
  src/scripts/wallet-balances.ts` (in `apps/backend`) prints each wallet's address and
  Arc balance without printing keys. The media-fetcher test now passes on Windows.

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
                 │                     │   sealed-bid auction:    │
                 │                     │   lowest share wins      │
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
apps/backend        job pipeline, decision loop + auction, agent registry,
                    payments, dubbing, QC, bot, chain feed, HTTP API
apps/backend/contracts   ParrotSplitter.sol (auction record + on-chain split)
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

### 5. With the `ParrotSplitter` contract: split on-chain
When `SPLITTER_ADDRESS` is set (see *Setup*), two things move onto the contract:

- **Every auction is recorded** by `recordAuction(jobId, creator, agent, agentBps,
  bidders, decisionsHash)`: the winner, the share it won at, how many agents bid, and the
  keccak256 hash of every agent's full decision record, so anyone can check a published
  decision log was not edited afterwards. Terms are write-once, and only Parrot's operator
  wallet can write them. The transaction hash is stored on the job's `APPROVED` event.
- **Every unlock is split by the contract**: `unlock(jobId, unlockId, amount)` pulls the
  $0.02 from the viewer wallet and sends each share straight to the creator and the agent,
  in one transaction, at the share the auction set. The same `unlockId` can never be
  charged twice.

A party without its own wallet yet is paid via the revenue wallet and settled later as
before; a leg the contract paid directly is recorded as settled, so the sweep never pays
it a second time (tested). Recording an auction is best-effort: if it fails, the dub
still goes ahead and its unlocks use path 3.

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

This is at the default 40% share, which is also the most an agent may bid: the winning
bid is usually lower, so `r` is lower for the winning agent. A unit test fails if anyone changes
the price or the split without the conversion assumption following. The conversion rate is a learned, per-(category, language)
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
   × how well the post reaches it  35% (20-50%)  assumption: big non-English X markets
                                         rank "low"/"moderate" on the EF English Proficiency
                                         Index, so an English post reaches about a third
   × how many open the dub          2% (1-5%)   assumption: the dub is a link in a reply,
                                         and organic links on X see ~1-3% click-through.
                                         YouTube's dubbed tracks get >25% of watch time
                                         with one-tap switching: our far ceiling
   ```

   Both used to be 50% and 5% (ranges 25-75% and 2-15%); the old uptake's high case would
   have beaten most paid ads. They are still assumptions, and the learning loop corrects
   them.

   The persona decides which end of the range it plans on: Kestrel the low case, Magpie
   the likely case, Finch the high case. That plan is then scaled by the agent's
   **calibration**: how its past forecasts compared with what actually happened (see
   *Learning loop*).
3. **Compute EV:** `EV = p_success × (predicted_views × r) − dub_cost`, where `p_success`
   is **that agent's own realised QC pass rate** — an agent that keeps shipping bad dubs
   correctly becomes pessimistic about itself.
4. **Bid** if `EV > min_margin`. The bid is the **smallest agent share** at which its EV
   still clears its margin. EV is linear in the share, so this is exact.

**The auction, in one rule: the lowest bid wins, and the winner gets exactly what it
bid.** Every agent secretly bids the share of each unlock it wants (at most 40%). The
lowest bid leaves the creator the most, so it wins, and the creator keeps everything
else. The built-in agents bid the smallest share that still clears their own profit
margin, so the winner always makes at least its margin (tested). An agent with its own
model (`bidUrl`) can bid whatever it likes. The claim itself is an atomic
compare-and-set; evaluation order is shuffled only to break exact ties.

Before, the first approving agent took the job at a fixed 40%. Same three personas, a
Spanish clip, before and after:

| Original views | Sealed bids | Winner | Creator's share |
| --- | --- | --- | --- |
| 400k | Finch 4.3%, Magpie 24.8% | Finch | 60% to 95.7% |
| 1.2M | Finch 1.4%, Magpie 8.3% | Finch | 60% to 98.6% |
| 5M | Finch 0.3%, Magpie 2.0%, Kestrel 24% | Finch | 60% to 99.7% |

(Measured before the funnel assumptions were lowered. With the new ones fewer jobs clear
at all, and the contested ones split the same way.)

The worked example, which is an executable test:

```
1.2M views × 8.1% × 35% × 2% ≈ 680 likely Spanish viewers
12.5% unlock rate · 70% chance of passing QC · $0.25 cost (30s)
EV = 0.7 × (680 × $0.001) − $0.25 = +$0.23   → dub it (clears Magpie's $0.10 margin)
```

The same funnel gives a 10k-view post about 6 viewers, so a 2-cent dub only pays on posts
with roughly a million views or more. That is what the agents do. For a demo on a smaller
post, `FORCE_DUB=true` skips only the margin test.

**Personas:** *Magpie* (balanced, plans on the likely case), *Kestrel* (cautious — wide
margin, plans on the low case), *Finch* (aggressive, plans on the high case, Spanish only).

**Open entry: any team can add an agent.** `POST /api/agents/register` with a name and,
optionally, `minMarginUsd`, `floorUsd`, `maxExposureUsd`, `dailyCapUsd`, `languageFocus`,
`optimism` (`cautious` / `likely` / `optimistic`) and a `walletAddress` the contract can
pay. The built-in formula then bids for it. Or give a **`bidUrl`** and bring your own
model: before each auction Parrot POSTs the job, the dub cost, the reserve share and its
own forecast to that URL, and the agent answers `{ "bidBps": 1500 }`, or
`{ "bidBps": null }` to pass (format in `apps/backend/src/services/external-bids.ts`). All
endpoints are asked in parallel with a 3-second timeout; a slow, broken or out-of-range
answer is a pass, so one bad agent cannot stall an auction. Every entrant faces the same
budget rules and starts with $12 of test credit. Limits: https endpoints only (plain http
to localhost outside production), unique names, 25 agents.

**Learning loop.** 24 hours later (one minute in demo mode) the realised views and unlocks
are compared against the estimate and folded back into the bucket with exponential
smoothing. The same outcome also updates the **winning agent's calibration**: its
correction moves 30% of the way (in log space) toward actual / forecast, clamped to
0.1-3x. An agent that over-promises plans lower next time, and its reasoning says so ("my
past forecasts ran about 40% high..."). Without this the most optimistic agent wins every
contested auction and eats the losses when reality comes in lower (the winner's curse).
In a 400-job simulation with noisy outcomes, calibration cut the share of dubs that lost
money from 22% to 12% and raised total agent profit from $132 to $147. Finch's win share
fell from 48% to 23%; the cautious Kestrel never wins in either case. It is idempotent, so a re-run cannot bias a bucket twice. Prediction error over
time is charted. In demo mode outcomes are simulated and every such record is flagged.

---

## The QC gate, and its limits

Before publishing, four checks:

- **Duration match** within 10%.
- **Language**: the dub is in the language that was ordered.
- **Audio sanity** via ffmpeg (non-silence ratio, dead gaps, loudness).
- **Meaning (back-translation)**: both the original and the dub are transcribed, the dub
  is translated back to English, and it is scored 0-100 on whether it says the same
  thing. 70 or more to pass.

**The company that made a dub never judges it.** ElevenLabs makes every dub today, so
ElevenLabs Scribe is only used to *transcribe* (write down what is said). The verdict on
language and meaning comes from **Grok (xAI)**, which dubs nothing. Without an xAI key,
language falls back to Scribe's own language ID and the meaning check reports `skipped`.

**The verdict goes on-chain** (`recordQc`), next to the job's auction record: pass/fail,
the meaning score (255 = not measured) and a hash of the full report. The contract keeps
every agent's passed/failed count, publicly and uneditably, as its reputation.

A failure means the dub is **not published**, the cost stays booked as a loss, the agent's
`p_success` drops, and the bot tells the creator the truth rather than handing them
something bad.

**Limits, honestly:** the meaning check judges transcripts, so it cannot hear tone,
timing or lip sync, and it needs the original clip's audio (seeded demo posts have none,
so there it is skipped). It has passed its tests but has not yet run on a real dub.
ffmpeg is not installed here,
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
npm test                 # 517 tests (includes the contract, on an in-memory chain)
npm run typecheck
```

**Deploying the `ParrotSplitter` contract** (optional; everything works without it):

1. Put funded `PARROT_REVENUE_PRIVATE_KEY` (becomes the contract's operator) and
   `VIEWER_POOL_PRIVATE_KEY` in `.env`. Fund their addresses at `faucet.circle.com`
   (choose Arc Testnet). `cd apps/backend && npx tsx src/scripts/wallet-balances.ts`
   shows each address and balance.
2. `npm run deploy:splitter -w @parrot/backend` compiles with solc, deploys, and approves
   the contract to pull USDC from the viewer pool.
3. Paste the printed `SPLITTER_ADDRESS` into `.env` and restart the backend.

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
(`tweet`, `User-Name`, `videoPlayer`, …), listed once in
`packages/shared/src/x-dom.ts`, and the content script reads only those.

**On real x.com** there is no X API (it bills per call) and no bot reading
replies, and a reply would publicly tag whoever owns the bot's handle there. So
the extension works differently on x.com:

- It reads each **video** post off the page (author, likes, replies, reposts,
  views, length) and sends that to Parrot (`POST /api/extension/observe`).
- "Dub this" asks Parrot directly (`POST /api/extension/request`) instead of
  posting a reply. Nothing is ever posted to X.
- Every video post shows a Parrot strip ("No dub yet" until someone asks), so it
  is visible that the extension is running.

**Those numbers are unverified**: the person viewing a page can edit it. They are
marked `source: 'page'`, the strip says so, and two things bound what a forged
page can cost: each agent's spending caps ($2 per job, $10 per day) and the EV
margin every request still has to clear. The author check (only the poster can
ask) also rests on what the page says.

**This has never run on the live site.** If the strip does not appear, open
DevTools on x.com and look for the `[Parrot]` line in the console: it says how
many posts and videos it found, which account it thinks is signed in, and whether
the server is reachable. A renamed hook is a one-line fix in `x-dom.ts`.

**Seeded posts vs. uploads.** The four seeded posts have engagement numbers but no
footage, and they are always dubbed with the stand-in audio, even when an
ElevenLabs key is set. A video **uploaded through Chirp's composer** is a real
file: with `ELEVENLABS_API_KEY` set, the backend sends those bytes to ElevenLabs
and the dub is real (and costs credits). A fresh upload has no likes or views, so
the agents may well decline it - that is the economics working, not a fault.

**Known gap:** in the pipeline, the QC duration check compares the source length
with itself (the dub's real length, which ElevenLabs reports, is not passed
through yet), so `duration_match` cannot fail there. The live test above checked
it against the real length directly.

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

Parrot's one custom contract, `ParrotSplitter` (`apps/backend/contracts/`), is deployed
at **[`0x1699adb8f1495eb9bdb1529d03db784cd424ad6d`](https://explorer.testnet.arc.io/address/0x1699adb8f1495eb9bdb1529d03db784cd424ad6d)** (current version, adds `recordQc`):

| Event | Transaction |
| --- | --- |
| Deploy | [`0x5493ad40…bb39`](https://explorer.testnet.arc.io/tx/0x5493ad408284bc64e4cc6b5d16b90ccb98518d0389506f8b30c52d1b2befbb39) |
| Viewer pool approves the contract | [`0x34b1e053…f0c4`](https://explorer.testnet.arc.io/tx/0x34b1e0538dd69320e483fb0a0137b3889df73fe4dfd0efd31307c19a03caf0c4) |
| Auction recorded | [`0xb059128d…bc99`](https://explorer.testnet.arc.io/tx/0xb059128dea2624864e0747c20386407942685b9ca91ad7874bc0fa6e91eabc99), [`0x75449b7e…af8f`](https://explorer.testnet.arc.io/tx/0x75449b7ed7f40b14573a967c6986fd3d24db80aae0ca82ce62699b9c4fccaf8f) |
| QC recorded (one pass, one staged fail) | [`0xed19cfa9…1021`](https://explorer.testnet.arc.io/tx/0xed19cfa9a072d56b874adf6ded2f4acb8f106f15517d70652ee642b9ff6e1021), [`0xd189785a…f4c8`](https://explorer.testnet.arc.io/tx/0xd189785a76f751e36e479f0bded63d11d225f8139e246b49e017be057938f4c8) |

The first version, still on-chain, at [`0xafe91baf2789e79c764313326c6a3125a968856d`](https://explorer.testnet.arc.io/address/0xafe91baf2789e79c764313326c6a3125a968856d):

| Event | Transaction |
| --- | --- |
| Deploy | [`0x29140c68…4fbb`](https://explorer.testnet.arc.io/tx/0x29140c68b8ae918af77a7856845afefb984c51b89a79f8481b561d7a64ef4fbb) |
| Viewer pool approves the contract | [`0x25daf553…9299`](https://explorer.testnet.arc.io/tx/0x25daf553ef0080a1b18222607a2cf3f567fd92c529117e04594813855ef29299) |
| Auction recorded | [`0xeaab8b50…8da7`](https://explorer.testnet.arc.io/tx/0xeaab8b503dcb29c2928258da497e8a2a0b43a3c017aa26d37b263c4487b18da7), [`0xc802d600…1544`](https://explorer.testnet.arc.io/tx/0xc802d600698a86324e1797689dafa1cc7ff8f7950af0783db4c20d60c0541544) |
| Unlock split ($0.02: $0.005892 to the agent, $0.014108 for the creator) | [`0x9da744dd…2dc6`](https://explorer.testnet.arc.io/tx/0x9da744ddd02b0f312606f49d2cbe3341f3c369c1c337c594ad5d7fcc4cab2dc6) |

Everything else uses USDC's ERC-20 interface and Circle's Gateway contracts as they are.

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
