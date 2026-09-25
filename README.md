# 🔴⚫ RED OR BLACK — backend

**Every 5 minutes: paste your wallet, pick a colour. When the bell rings a
public randomness beacon spins the wheel, and everybody who picked the colour
it lands on — and holds the coin — splits the whole creator-reward pot in
equal parts, paid in SOL. If nobody eligible called it, the pot rolls over.**

One Node process: a wall-clock round timer, the picks, the wheel, and the
wallet that claims and pays. HTTP + WebSocket on one port. The site lives in
[`red-or-black-front`](https://github.com/Harkor421/red-or-black-front).

```
open ──(5 min: wallet + colour)──► bell ──► drand beacon ──► spin
                                     │                         │
                                     ├── claim creator fees ───┤
                                     └── read every holding ───┤
                                                               ├─ winners → equal shares, SOL, batched
                                                               └─ nobody  → the pot rolls over
```

---

## Who gets paid

A pick is a wallet and a colour, one per wallet per round, changeable until the
bell. At the bell, a wallet is paid if:

1. it picked the colour the ball landed on,
2. it holds at least `MIN_HOLD_PCT` of the supply **at the bell** (0.05% by
   default — about 500K tokens on a pump.fun coin), and
3. it can receive SOL — a fresh address or a plain system account.

The holding is also read when you pick, so the page can tell you straight away
whether your pick can win, but the reading at the bell is the one that pays.

**Why a floor.** Equal parts per wallet is farmable: a wallet costs nothing to
make, so a bot with 500 empty wallets would take almost everything. The floor
is what prices that attack — to take two shares you have to hold the minimum
twice.

**Why "can receive SOL".** The System Program's own address is a valid address
on the curve, and anyone can open a token account for it. A transfer to it
reverts, and a reverted transfer takes its whole batch down. Program-derived
addresses (pools, curves, vaults) are rejected when you pick: they are off the
curve.

## The share

```
budget = min(pot, wallet balance − LEAVE_SOL, MAX_PAYOUT_SOL) − transfer fees
share  = budget ÷ winners   (rounded down to the lamport)
```

If `share < MIN_SHARE_SOL` (0.001), nobody is paid and the pot rolls over and
grows until it can give everyone a real amount. Nobody is sent dust and told
they won. The floor is also above rent-exemption, so a payout to a brand-new
wallet can never revert.

Payouts are native SOL transfers, 16 to a transaction. No swap, no token
account, nothing that can revert but the balance.

## The wheel is not ours

The spin comes from **drand quicknet** — a public beacon signed by a threshold
network (Cloudflare, Protocol Labs, EPFL…), one value every 3 seconds, and
*which* round is published *when* is fixed forever by its genesis time. The
beacon a spin uses is known when its round **opens** and does not exist until
**after** the bell. Nobody — this server included — can know or choose it.

```
pocket = WHEEL[ uint64( sha256(randomness + ":" + roundId + ":spin") ) mod 36 ]
```

`WHEEL` is the real European order with the zero removed: **18 red / 18 black**.
If the beacon cannot be fetched within a minute the round is **void** and the
pot rolls over — it never falls back to local randomness.

## The pot is a ledger, not a balance

The creator wallet is usually somebody's real wallet with their own SOL in it.
So `pot = carried over + what the bells claimed from the creator vaults` (the
pump curve and pump-swap), and a payout spends that and nothing else.

- The whole payout leaves the ledger **before** the first batch is signed.
- Each batch's signature is saved **before** it is broadcast.
- A batch that did not land is retried only once the chain says it never will
  (its blockhash expired); one that cannot be paid goes back into the pot.
- If the process dies mid-payout, the boot-time reconcile asks the chain about
  every signed batch and finishes the books. A batch is never paid twice.

## Modes

| mode | when | what happens |
| --- | --- | --- |
| **demo** | no `TOKEN` | the whole show on a simulated pot; every wallet counts |
| **dry** | `TOKEN` set, `DRY_RUN=true` or no key | real picks, real beacon, real holdings, real pot; the claim and the first payout batch are **simulated on mainnet** as the creator. Nothing is signed. |
| **live** | `TOKEN` + `TREASURY_SECRET` of the coin's **creator** + `DRY_RUN=false` | claims and pays |

The server reads the coin's creator off the chain and **refuses to go live** if
`TREASURY_SECRET` is not that wallet. A coin launched with pump.fun **fee
sharing** has a program account as its creator — nobody can sign for it — so it
stays in dry run and says why. Launch without fee sharing.

## Run it

```bash
npm install
cp .env.example .env
npm start                          # demo
ROUND_MS=30000 npm start           # 30-second rounds for rehearsing
npm run check                      # wheel fairness, payout maths, a real beacon
npm run probe <mint> [<wallet>…]   # what each wallet holds, and a SIMULATED claim + payout
```

## Going live (after launching on pump.fun)

1. Launch the coin **from the treasury wallet**, without fee sharing.
2. Put that wallet's secret in Railway as `TREASURY_SECRET` (never in the repo).
3. Set the CA without a redeploy:
   ```bash
   curl -X POST https://<backend>/set-ca -H 'x-admin-password: …' \
     -H 'content-type: application/json' -d '{"ca":"<mint>"}'
   ```
4. Watch a few rounds in dry run — every paid round shows `first batch
   simulated on mainnet as the creator: ok`.
5. `DRY_RUN=false` in Railway. The boot log says `LIVE`.

## Endpoints

| | |
| --- | --- |
| `GET /state` | everything the page gets on connect |
| `GET /rounds` | settled rounds, newest first, every wallet paid with its signature |
| `GET /round/<id>` | one round |
| `GET /wallet/<address>` | a wallet's pick this round, whether it can win, and what it has won |
| `GET /stats` | rounds, paid rounds, SOL paid, wallets paid, biggest share |
| `GET /health` | mode, viewers |
| `POST /set-ca` | `{"ca":"<mint>"}` — `x-admin-password` |
| `POST /set-pot` | `{"sol":1.5}` — sets what the ledger carries |

WebSocket on the same URL: `hello` on connect, then `round · vote · settle · pot ·
totals · tick`. Send `{op:'vote', wallet, side}` to pick, `{op:'hi', wallet}` for
that wallet's state.

## Deploy (Railway CLI)

```bash
railway up --service backend --detach
```

Variables live in Railway only. MongoDB in the same project (`MONGO_URL` as a
reference variable) keeps the ledger, rounds, payouts and totals across deploys
— **run live only with it attached**.
