# Parrot

**Get your videos seen in every language. Parrot pays for the dubs; you pay only for the views they bring.**

A creator posts a video. Parrot dubs it into several languages with ElevenLabs, posts each dub in the thread, finds the languages the audience actually watches, and from then on dubs only those. The creator is charged **$1 per 1,000 views the dubs get** (USDC on Arc), up to a per-post budget they set. A dub nobody watches costs the creator nothing: that one is Parrot's loss.

Built for UBC 26. Main track: **Consumer Applications**. Chain: **Arc testnet**. Bounties: **ElevenLabs**, **Grok Bot**.

## What is real and what is not

| Part | Status |
| --- | --- |
| Language planner (explore, then focus on winners), P&L maths, billing | **Real.** Pure, tested (318 tests). |
| ElevenLabs dubbing | **Real** with `ELEVENLABS_API_KEY`; otherwise a labelled stand-in. Seeded demo posts have no footage, so their dubs are always stand-ins. |
| Quality check | **Real and fail-closed.** ffmpeg measures; xAI/Grok hears and judges meaning. ElevenLabs never grades its own dubs. |
| Creator payments on Arc | **Real** for signed-in creators (own Arc wallet, USDC transfer per billing batch, "Verify on Arc" link). Demo creators pay from a labelled test balance with no link. |
| Sign-up wallets | Email/Google sign-in creates a custodial Arc wallet funded with testnet USDC. Needs `WALLET_ENCRYPTION_KEY`, treasury key and a mailer; otherwise off. |
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

- **Arc:** creator payments are USDC transfers on Arc testnet; per-user Arc wallets; contract-free (existing USDC at `0x3600000000000000000000000000000000000000`).
- **ElevenLabs:** the Dubbing API makes every dub; central, not an add-on.
- **Grok Bot:** we use the xAI API (Grok) for QC judging, request parsing, reply-language reading and summaries. This is **not** the Grok Bot assistant inside X, so this bounty may not apply as written; a chat export is still required.
