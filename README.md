# 🔴⚫ RED OR BLACK — backend

**Every 5 minutes the community picks a colour. When the bell rings, a public
randomness beacon spins the wheel. If it lands on the community's colour, the
whole creator-reward pot buys the coin back and burns it. If it doesn't, the pot
rolls over to the next spin.**

One Node process: a wall-clock round timer, the vote counter, the wheel, and the
wallet that claims, buys and burns. HTTP + WebSocket on one port. The site lives
in [`red-or-black-front`](https://github.com/Harkor421/red-or-black-front).

```
open ──(5 min of votes)──► bell ──► locked ──► drand beacon ──► spin
                                       │                         │
                                       └── claim creator fees ───┤
                                                                 ├─ lost → pot rolls over
                                                                 └─ won  → buy back → burn
```

---

## The wheel is not ours

A server that picks its own random numbers asks to be trusted. The spin comes
from **drand quicknet** — a public beacon signed by a threshold network
(Cloudflare, Protocol Labs, EPFL…), one value every 3 seconds, and *which*
round is published *when* is fixed forever by its genesis time.

So the beacon a spin will use is known the moment its round **opens**, and its
value does not exist until **after** the bell. Nobody — this server included —
can know the result while votes are open, or choose it afterwards.

```
pocket = WHEEL[ uint64( sha256(randomness + ":" + roundId + ":spin") ) mod 36 ]
tie    = sha256(randomness + ":" + roundId + ":tie")[0] even ? red : black
```

`WHEEL` is the real European wheel order with the zero removed: 36 pockets,
alternating colours, **18 red / 18 black**. There is no green pocket because
there is no house. If the beacon cannot be fetched within a minute the round is
**void** and the pot rolls over — it never falls back to local randomness.

A tie (including nobody voting) is broken by the same beacon, from independent
bits. The frontend re-derives every spin in the browser.

## The pot is a ledger, not a balance

The creator wallet is usually somebody's real wallet with their own SOL in it.
A win that spent "everything above a reserve" would spend that too. So:

```
pot = carried over + what this round claimed from the creator vaults
```

- **Claim** runs at every bell, in both vaults — the pump curve and pump-swap
  (after graduation) — and adds what the vaults held to the pot.
- **Win** spends the pot, never more than the wallet holds minus `LEAVE_SOL`.
  The pot leaves the ledger *before* the buy is signed; the signature is saved
  before it is broadcast. If the process dies mid-flight, the boot-time
  reconcile asks the chain whether it landed and either keeps it spent or puts
  it back. A pot can never be spent twice.
- What the buy did is read off the transaction's own balances (SOL out, tokens
  in), and exactly those tokens are burned (`BURN_MODE=bought`). A dev bag in
  the same wallet is untouched. A burn that fails is retried every minute.
- **Loss** carries the pot to the next spin.

## Modes

| mode | when | what happens |
| --- | --- | --- |
| **demo** | no `TOKEN` | the whole show on a simulated pot, labelled DEMO |
| **dry** | `TOKEN` set, `DRY_RUN=true` or no key | real votes, real beacon, real pot read off the chain; the claim and the buy a win *would* send are **simulated on mainnet** and the result is shown. Nothing is signed. |
| **live** | `TOKEN` + `TREASURY_SECRET` of the coin's **creator** + `DRY_RUN=false` | claims, buys, burns |

The server reads the coin's creator off the chain and **refuses to go live** if
`TREASURY_SECRET` is not that wallet. A coin launched with pump.fun **fee
sharing** has a program account as its creator — nobody can sign for it — so it
stays in dry run and says why. Launch without fee sharing.

## Run it

```bash
npm install
cp .env.example .env
npm start                       # demo
ROUND_MS=30000 npm start        # 30-second rounds for rehearsing
npm run check                   # wheel fairness + beacon maths + a real beacon
npm run probe <mint>            # read a coin and SIMULATE its claim/buy/burn as the creator
```

## Going live (after launching on pump.fun)

1. Launch the coin on pump.fun **from the treasury wallet**, without fee sharing.
2. Put that wallet's secret in Railway as `TREASURY_SECRET` (never in the repo).
3. Set the CA without a redeploy:
   ```bash
   curl -X POST https://<backend>/set-ca -H 'x-admin-password: …' \
     -H 'content-type: application/json' -d '{"ca":"<mint>"}'
   ```
   The page switches from DEMO to DRY RUN on the spot.
4. Watch a few rounds in dry run — every win shows `buy simulated on mainnet: ok`.
5. `DRY_RUN=false` in Railway. The boot log says `LIVE`.

Keep a little SOL in the wallet (`LEAVE_SOL`, default 0.01) — the claim fee is
paid from it.

## Endpoints

| | |
| --- | --- |
| `GET /state` | everything the page gets on connect |
| `GET /rounds` | settled rounds, newest first, with every signature |
| `GET /round/<id>` | one round: votes, beacon, pocket, claim / buy / burn |
| `GET /stats` | wins, losses, SOL spent, tokens burned, streak |
| `GET /health` | mode, viewers |
| `POST /set-ca` | `{"ca":"<mint>"}` — `x-admin-password` |
| `POST /set-pot` | `{"sol":1.5}` — sets what the ledger carries |

WebSocket on the same URL: `hello` on connect, then `round · vote · settle · pot ·
totals · burn · tick`. Send `{op:'vote', voter, side}` to vote,
`{op:'hi', voter}` to get your current pick back.

## Deploy (Railway CLI)

```bash
railway up --service backend --detach
```

Variables live in Railway only. MongoDB in the same project (`MONGO_URL` as a
reference variable) keeps the pot ledger, the rounds and the totals across
deploys — **run live only with it attached**.
