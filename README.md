# Parrot

**Get your videos seen in every language. Parrot pays for the dubs; you pay only for the views they bring.**

A creator posts a video. Parrot dubs it into several languages with ElevenLabs, posts each dub in the thread, finds the languages the audience actually watches, and from then on dubs only those. The creator is charged **$1 per 1,000 views the dubs get** (USDC on Arc), up to a per-post budget they set. A dub nobody watches costs the creator nothing: that one is Parrot's loss.

Built for UBC 26. Main track: **Consumer Applications**. Chain: **Arc testnet**. Bounties: **ElevenLabs**, **Grok Bot**.

## What is real and what is not

| Part | Status |
| --- | --- |
| Language planner (explore, then focus on winners), P&L maths, billing | **Real.** Pure, tested (303 tests). |
| ElevenLabs dubbing | **Real** with `ELEVENLABS_API_KEY`; otherwise a labelled stand-in. Seeded demo posts have no footage, so their dubs are always stand-ins. |
| Quality check | **Real and fail-closed.** ffmpeg measures; xAI/Grok hears and judges meaning. ElevenLabs never grades its own dubs. |
| Creator payments on Arc | **Real** for signed-in creators (own Arc wallet, USDC transfer per billing batch, "Verify on Arc" link). Demo creators pay from a labelled test balance with no link. |
| Sign-up wallets | Email/Google sign-in creates a custodial Arc wallet funded with testnet USDC. Needs `WALLET_ENCRYPTION_KEY`, treasury key and a mailer; otherwise off. |
| Views | Each dub is its own post; its view count is read back from the timeline. Viewer country comes only from Parrot's own dub page. |
| Demo audience | **Simulated and labelled.** Each demo creator has a hidden taste per language; the planner has to discover it. |
| Timeline | **Chirp**, a local stand-in for X. X API adapter is written but never called. Extension is built for x.com but untested there. |
| Grok | Reads requests, reply languages, and writes the dashboard summary (built-in fallbacks without a key). |

## How it works

1. **Posts 1-2: explore.** Six languages (biggest X audience first); the second post keeps the best half and swaps in new ones.
2. **Post 3+: focus.** Up to 3 proven languages plus one test. A language is *proven* when its dubs average the views needed to pay for themselves (a 30s dub costs $0.25, so 250 views); *dropped* after two misses or one clear miss; retried every 5 posts.
3. **Money.** Parrot pays ElevenLabs per dub up front. The creator is charged per counted view in hourly batches (12s in demo), capped by post budget and balance. The creator's own rate per 1,000 views ("worth") is shown as *their* number, never as income.

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

- **Arc:** creator payments are USDC transfers on Arc testnet; per-user Arc wallets; contract-free (existing USDC at `0x3600000000000000000000000000000000000000`).
- **ElevenLabs:** the Dubbing API makes every dub; central, not an add-on.
- **Grok Bot:** we use the xAI API (Grok) for QC judging, request parsing, reply-language reading and summaries. This is **not** the Grok Bot assistant inside X, so this bounty may not apply as written; a chat export is still required.
