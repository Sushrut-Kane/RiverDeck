# ♠ Riverdeck

**Fair-dealt poker in your browser.** You against five opponents, played honestly:
one cryptographic shuffle per hand, real hand rankings, and AI that decides from
its *own* cards — never yours, never the deck, never rigged.

No accounts, no money, no tracking, no build step. Just open it and play.

---

## Features

- **Six-handed poker** — you plus five computer opponents.
- **Provably fair dealing** — a single Fisher–Yates shuffle per hand driven by
  `crypto.getRandomValues` (with rejection sampling, so no modulo bias). Cards are
  dealt once and never changed or peeked at.
- **Real hand evaluation** — every ranking from high card to straight flush,
  with correct kickers, split pots, and the Ace-low "wheel" straight.
- **Range-aware, card-based AI** — each opponent estimates equity with a
  Monte-Carlo rollout of its actual hole cards, weighted by other players'
  public action history, bet sizes, position, and real pot odds. It is never
  nudged to make you win or lose.
- **Distinct table personalities** — tight-aggressive, loose-aggressive,
  calling-station, maniac, and tricky-regular opponents use the same fair card
  information but make meaningfully different strategic choices.
- **Explainable decisions** — expand **Developer: AI decisions** under the
  table to inspect each AI's estimated equity, pot price, position, and read
  of the remaining ranges.
- **Complete betting rules** — blinds, four streets, check / call / bet / raise /
  fold, all-in with correct **side pots**, dealer-button rotation, and elimination
  down to one winner.
- **Mobile-first UI** — responsive layout with a thumb-friendly sticky action bar;
  works on Android and iPhone (safe-area aware) as well as desktop.

## Tech

Plain **HTML + CSS + vanilla JavaScript**. Zero dependencies, zero build tooling.

| File | Purpose |
|------|---------|
| `index.html`   | Markup and script loading |
| `style.css`    | All styling (mobile-first, responsive) |
| `deck.js`      | Cards, fair 52-card deck, unbiased shuffle |
| `evaluator.js` | 5- and 7-card hand ranking |
| `ai.js`        | Equity-based opponent decisions |
| `game.js`      | Game engine + rendering |

## Run locally

The app runs straight from the filesystem — **just open `index.html`** in any
modern browser (double-click it, or drag it into a browser window).

Prefer a local server? With Node installed:

```bash
npx serve .
# then open the printed http://localhost:3000
```

## Deploy to Vercel

This is a static site, so Vercel needs **no build**.

**Option A — Git (recommended)**

1. Push this folder to a new GitHub repo.
2. In [Vercel](https://vercel.com/new), **Import** the repo.
3. Settings: **Framework Preset = Other**, **Build Command = _(empty)_**,
   **Output Directory = `./`**. Click **Deploy**.

**Option B — Vercel CLI**

```bash
npm i -g vercel
vercel        # preview deploy
vercel --prod # production deploy
```

Once deployed, open the URL on your phone and use **Add to Home Screen** for a
full-screen, app-like experience.

## How to play

Standard community-card poker (Texas Hold'em rules):

1. Everyone is dealt two private **hole cards**; blinds are posted.
2. Betting rounds happen **pre-flop**, then after the **flop** (3 cards), the
   **turn** (1 card), and the **river** (1 card).
3. On your turn use the bottom bar to **Fold**, **Check/Call**, **Raise**
   (slider or number), or go **All-In**.
4. At showdown the best five-card hand wins; ties split the pot. Run out of chips
   and you're eliminated — last player standing wins.

## Fair by design

Riverdeck's whole point is honesty:

- The deck is shuffled **once** per hand and dealt from the top; nothing is
  reordered mid-hand.
- No player — including every AI — can see another player's hole cards or the
  undealt deck.
- Opponent decisions come purely from **hand equity + pot odds**, so outcomes are
  neither rigged for nor against you.

## Rename it

Riverdeck is a placeholder name — it's your project. To rebrand, change the title
and heading in `index.html`, the header comment in `game.js`, and the `name` in
`package.json`.

## Disclaimer

Play-money only. Riverdeck is a game for entertainment; it is **not** a gambling
product and involves no real currency.

## License

[MIT](LICENSE) © 2026 Your Name
