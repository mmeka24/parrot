# Parrot

**Get your videos seen in every language. Parrot pays for the dubs; you pay only for the views they bring.**

A creator posts a video. Parrot dubs it into several languages with ElevenLabs, posts each dub in the thread, finds the languages the audience actually watches, and from then on dubs only those. The creator is charged **$1 per 1,000 views the dubs get** (USDC on Arc), up to a per-post budget they set. A dub nobody watches costs the creator nothing: that one is Parrot's loss.

Built for UBC 26. Main track: **Consumer Applications**. Chain: **Arc testnet**. Bounties: **ElevenLabs**, **Grok Bot**.

## Live demo

**Try it: https://parrot-web.fly.dev**

| What | Link |
| --- | --- |
| Creator dashboard (start here, the demo creator is Maria) | https://parrot-web.fly.dev/creator/maria |
| Get the browser extension | https://parrot-web.fly.dev/extension |
| The X stand-in timeline (Chirp) | https://parrot-chirp.fly.dev |
| Backend API (health check) | https://parrot-backend.fly.dev/api/health |

Press **Dub into N languages** on an undubbed post, then **Send a demo audience** and watch the
views, the language plan and the payments move. Things to know about the live deployment:

- It runs on **Arc testnet**. Nothing here is real money.
- State is kept in memory, so a server restart resets the demo to its seeded starting point.
- Demo creators pay from a labelled test balance. Only a creator who signs in with Google gets a
  real Arc wallet and a real per-view USDC charge.
- Real dubs use ElevenLabs credit, so the server has a daily spend cap. A video with no sound
  cannot be dubbed.
- It is hosted on Fly.io (config in `fly*.toml`).

## On Arc: what moves on-chain, and what does not

All of it is **Arc testnet** (chain 5042002); the USDC has no real value. Parrot deploys **no
smart contracts**: it uses Arc's existing USDC (`0x3600000000000000000000000000000000000000`)
through its ordinary ERC-20 transfer.

| Money flow | On Arc? | How it works |
| --- | --- | --- |
| **A creator pays for views** (signed-in creator) | **Yes** | One USDC transfer per creator per billing batch, from the creator's own Arc wallet to Parrot's revenue address. Each charge has a **Verify on Arc** link to its transaction. |
| **The $1.00 welcome balance** | **Yes** | When someone signs up, a USDC transfer sends $1.00 from Parrot's Treasury to their new wallet. Once per person, at most 25 new wallets a day, and the Treasury always keeps a $1 reserve. |
| **Each user's wallet** | **Yes** | A real Arc address per signed-in user, created by Parrot and held by Parrot (custodial: the key is encrypted at rest). The user never handles a key. |
| Demo creators' charges | No | A labelled test balance in Parrot's own books. No money moves and there is no link. |
| The ElevenLabs bill for each dub | No | Paid in fiat by Parrot and recorded in its books. |
| Counting views, the language planner, quality checks | No | These run on the Parrot server. |

**How a per-view payment stays honest.** A creator is charged only for views Parrot has counted,
never more than the post's budget (default $5.00) and never more than the wallet can pay (a
small reserve is kept back for Arc's network fee, which is paid in USDC from the same balance).
Money moves in batches, one payment per creator per sweep, so a busy post is one transaction
and not thousands. A dub's views are marked as billed **only after its payment confirms on
Arc**, so a failed payment is retried and a landed payment is not charged twice.

**Why no contract.** One batched USDC transfer per creator is all the money movement the product
needs, and a contract would add risk without adding anything a reader could verify. (An earlier
version split every viewer payment through a custom splitter contract; this product has no
per-viewer payments, so it was removed.)

**Where to look.**
[Revenue address](https://explorer.testnet.arc.io/address/0x852Ad1a5A355553e0379D339D9AEdbAC8282d951)
(receives creator payments) ·
[Treasury](https://explorer.testnet.arc.io/address/0x373182286E60D2fe26b25816372a54D18d9A54AF)
(funds new wallets) ·
[USDC](https://explorer.testnet.arc.io/address/0x3600000000000000000000000000000000000000).

**Status, stated plainly.** Funding a new wallet from the Treasury has been run live on testnet
and checked on-chain. Charging a creator per view from their own wallet is implemented and
covered by unit tests, but has not yet been run end to end on the live deployment. Wallets are
custodial and testnet only; real-money use would need non-custodial wallets and an audit.

## What is real and what is not

| Part | Status |
| --- | --- |
| Language planner (explore, then focus on winners), P&L maths, billing | **Real.** Pure, tested (318 tests). |
| ElevenLabs dubbing | **Real** with `ELEVENLABS_API_KEY`; otherwise a labelled stand-in. Seeded demo posts have no footage, so their dubs are always stand-ins. |
| Quality check | **Real and fail-closed.** ffmpeg measures; xAI/Grok hears and judges meaning. ElevenLabs never grades its own dubs. |
| Creator payments on Arc | **Real on-chain** for signed-in creators (own Arc wallet, USDC transfer per billing batch, "Verify on Arc" link). Demo creators pay from a labelled test balance with no link. See [On Arc](#on-arc-what-moves-on-chain-and-what-does-not). |
| Sign-up wallets | **Real on-chain.** Google or email sign-in creates a custodial Arc wallet and sends it $1.00 of testnet USDC from the Treasury. Needs `WALLET_ENCRYPTION_KEY`, the Treasury key and a sign-in method; otherwise off. |
| Views | Each dub is its own post; its view count is read back from the timeline. Viewer country comes only from Parrot's own dub page. |
| Demo audience | **Simulated and labelled.** Each demo creator has a hidden taste per language; the planner has to discover it. |
| Timeline | **Chirp**, a local stand-in for X. X API adapter is written but never called. Extension is built for x.com but untested there. |
| Grok | Reads requests, reply languages, and writes the dashboard summary (built-in fallbacks without a key). |

## How it works

1. **Posts 1-2: explore.** Eight languages (biggest X audience first; `EXPLORE_LANGUAGES`); the second post keeps the best half and swaps in new ones.
2. **Post 3+: focus.** Up to 3 proven languages plus one test. A language is *proven* when its dubs average the views needed to pay for themselves (a 30s dub costs $0.25, so 250 views); *dropped* after two misses or one clear miss; retried every 5 posts.
3. **Money.** Parrot pays ElevenLabs per dub up front. The creator is charged per counted view in hourly batches (12s in demo), capped by post budget and balance. The creator's own rate per 1,000 views ("worth") is shown as *their* number, never as income.

## Demo on real x.com with the extension

The extension is the product surface. On x.com it adds **Dub this** under your own video; after you click it, the same strip fills in with the results: each language's views against the views it needs to pay for itself, what you owe, what the views are worth at your rate, and what Parrot has learned.

```
npm run build:extension   # then Load unpacked: apps/extension/dist
```

What works on x.com and what does not: Parrot cannot post to X or read X's view counts (no API access), so the dubs are not posted in the thread. Each lives on its own Parrot page, and views come from that page plus, on a demo server, a **simulated audience** sent with the strip's **Send demo audience** button (always labelled). Everything the extension reads off the page is unverified. A real dub of an x.com video needs `yt-dlp`, `ffmpeg`, `ELEVENLABS_API_KEY` and `XAI_API_KEY`; cost is about $0.50 per minute of video per language.

### The forecast, before you dub

Under your own undubbed video the strip shows **What Parrot expects**: per language, the expected views (a range), what you would pay, and what the views are worth at your own rate, plus the total, what Parrot pays to make the dubs, and an "if it takes off to 1.2M views" line. For a creator Parrot knows nothing about, it is a funnel: your video's views x that language's share of X's audience (DataReportal) x stated assumptions on reach (35%) and uptake (2%); 1.2M views gives about 680 Spanish views. Once a creator has measured posts, languages Parrot has already seen use their own results. After dubbing, the strip shows the forecast next to what actually happened. The estimate is a range and an assumption, never a promise: a creator is charged only for views that happen, and never past their per-post budget.

A video with almost no views forecasts almost nothing (an 8-view video forecasts 0), which is why the take-off line is there.

### Extension only, no Chirp

Set `CHIRP_ENABLED=false` and restart the backend. Nothing is seeded, Chirp's routes are closed, and the demo runs entirely on the posts the extension reads from x.com.

## Run it

```
npm install
cp .env.example .env
npm run dev:backend   # :8787
npm run dev:web       # :3100  (creator dashboard)
npm run dev:xclone    # :3200  (Chirp)
npm test
```

Open `/creator/maria`, press **Dub into N languages**, then **Send a demo audience** and watch views, the plan and the payments move.

## Layout

`packages/shared` money maths, language planner, copy map, API contract · `apps/backend` campaign, billing, views, QC, accounts · `apps/web` dashboard · `apps/x-clone` Chirp · `apps/extension` Chrome extension.

## Validation plan (not yet run)

Alternate dubbed and undubbed posts across 5-10 real accounts for 2-3 weeks (10+ posts each: X views are noisy); success is total views on dubbed posts at least 1.3x undubbed. Track views per language, engagement, follower change and net P&L.

## Bounty notes

- **Arc:** creators pay for views with real USDC transfers on Arc testnet from their own per-user Arc wallets, one batched payment per creator with a Verify on Arc link; new wallets are funded by an on-chain Treasury transfer. Contract-free (existing USDC at `0x3600000000000000000000000000000000000000`). Not everything is on-chain, and the [On Arc](#on-arc-what-moves-on-chain-and-what-does-not) section says exactly what is and is not.
- **ElevenLabs:** the Dubbing API makes every dub; central, not an add-on.
- **Grok Bot:** we use the xAI API (Grok) for QC judging, request parsing, reply-language reading and summaries. This is **not** the Grok Bot assistant inside X, so this bounty may not apply as written; a chat export is still required.
