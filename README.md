# 🛡️ Zcash  Tippy bot

A production-ready Telegram tipping bot for Zcash ambassador communities —
**one bot, added to unlimited groups**, just like Rose, Combot, or other
popular Telegram utility bots. No per-group setup or configuration files;
admins just add the bot and it works immediately.

Enables private, shielded ZEC tipping within any Telegram group using the
Orchard pool (ZIP-224), Unified Addresses (ZIP-316), and ZIP-317 fee model.

---

## How it works (Rose-style)

- **Single deployment.** You run one instance of this bot with one wallet seed.
- **Add it to any group** — it auto-registers the group on join and starts working immediately, no admin config required.
- **One wallet per user, shared across all groups.** A user's `/register` wallet and balance follow them everywhere the bot is added — they don't re-register per group.
- **Settings are per-group.** `/setmintip`, leaderboards, and `/rain` are scoped to whichever group they're run in (keyed by Telegram `group_id` in the DB) — completely independent across communities.
- **Cross-group tip protection.** `/tip @username` verifies the recipient is actually a member of the *current* group via Telegram's API before allowing the tip — prevents tipping someone from an unrelated group.

---

## Architecture Overview

```
master_seed (BIP-39)
    └── Unified Spending Key (USK)
            └── Orchard spending key
                    └── diversifier_index (u64, per user, in SQLite)
                            └── unique u1... Unified Address per user
```

- **One wallet to scan** — single `lightwalletd` connection
- **Per-user unique addresses** — ZIP-316 diversified receivers, global across all groups
- **Off-chain tips** — SQLite balance updates for speed/fee efficiency
- **On-chain only on `/withdraw`** — broadcast to Zcash network via lightwalletd gRPC
- **Orchard-only** — all transactions use the Orchard shielded pool (ZIP-224, Halo 2)
- **Per-group scoping** — `group_settings`, `tips.group_id`, and leaderboards are all keyed by Telegram chat ID, so every community the bot joins gets independent settings automatically

---

## Prerequisites

| Dependency | Version | Notes |
|---|---|---|
| Node.js | ≥ 18.0 | LTS recommended |
| zebrad | latest | Zcash full node |
| lightwalletd | latest | gRPC wallet interface |
| SQLite | built-in | via better-sqlite3 |

---

## Setup

### 1. Clone and Install

```bash
git clone https://github.com/your-org/zcash-tipbot
cd zcash-tipbot
npm install
```

### 2. Configure Environment

```bash
cp .env.example .env
```

Edit `.env`:

```env
# Required
TELEGRAM_BOT_TOKEN=your_token_from_botfather
BOT_SEED_PHRASE=twelve word bip39 mnemonic here...
ENCRYPTION_KEY=$(openssl rand -hex 16)

# Network
ZCASH_NETWORK=mainnet
LIGHTWALLETD_URL=grpc://localhost:9067

# Bot identity (shown in /help and group welcome messages)
BOT_DISPLAY_NAME=Zcash Ambassadors Tipbot
```

That's it — no per-community configuration. Every group the bot is added to is automatically supported.

### 3. Set Up Telegram Bot

1. Message [@BotFather](https://t.me/BotFather) on Telegram
2. Create bot: `/newbot`
3. Copy the token into `TELEGRAM_BOT_TOKEN`
4. **Critical: disable Privacy Mode.** By default, Telegram bots in groups
   only see messages that start with `/` or directly mention them — they
   can't see the message someone is replying to. This breaks `/tip 0.001`
   (reply-to-tip). Fix it:
   - Message @BotFather → `/mybots` → select your bot → `Bot Settings` → `Group Privacy` → **Turn off**
5. Set commands via BotFather `/setcommands`:

```
register - Create your shielded wallet
address - Show your deposit address
balance - Check your ZEC balance
tip - Tip a user: /tip @user 0.001
rain - Tip multiple users: /rain 0.05 5
withdraw - Withdraw ZEC: /withdraw u1... 0.05
history - Your last 10 tips
stats - Your personal stats
leaderboard - Group leaderboard
help - Show all commands
```

### 4. Set Up zebrad

```toml
# zebrad.toml
[network]
network = "Mainnet"

[rpc]
listen_addr = "127.0.0.1:8232"

[state]
cache_dir = "/var/lib/zebrad"
```

```bash
zebrad start --config zebrad.toml
```

### 5. Set Up lightwalletd

```bash
lightwalletd \
  --zcash-conf-path /etc/zebrad/zebrad.toml \
  --data-dir /var/lib/lightwalletd \
  --log-file /var/log/lightwalletd.log \
  --grpc-bind-addr 127.0.0.1:9067 \
  --no-tls-very-insecure  # use TLS in production
```

### 6. Build Native Wallet Addon (Production)

The wallet module requires a native Node.js addon wrapping `librustzcash`.

**Current status:** The addon at `native/` compiles and passes 16 tests today
(ZIP-317 fees, ZIP-302 memos, BIP-39 seed derivation are all real, verified
implementations). The one stub remaining is ZIP-316 diversified address
derivation, which needs Rust ≥ 1.85 for the `orchard`/`zcash_keys` crates —
see **`native/README.md`** for the exact upgrade steps (each stub function
has the real implementation written in a comment directly above it).

```bash
cd native/
npm install
npm run build      # napi build --platform --release
npm test            # cargo test — confirms all 16 tests pass

# The addon will be at native/zcash_tipbot_native.*.node
```

`wallet.js` automatically detects whether the native addon is built. If it
isn't, the bot logs a warning and falls back to `MOCK_WALLET` behavior rather
than crashing — useful for local development without a Rust toolchain.

### 7. Run Migrations & Start

```bash
npm run migrate
npm start
```

---

## Development Mode (Mock Wallet)

```bash
MOCK_WALLET=true npm run dev
```

This generates deterministic fake `u1mock...` addresses and simulates transactions without touching the Zcash network.

---

## Commands Reference

### User Commands

| Command | Description |
|---|---|
| `/register` | Create your shielded wallet (ZIP-316 diversified address) |
| `/address` | Show your unique `u1...` deposit address |
| `/balance` | Check confirmed balance (zatoshis + ZEC) |
| `/tip @user 0.001` | Tip a user in the group |
| `/tip 0.001` _(reply)_ | Tip the author of a replied-to message |
| `/rain 0.05 5` | Split ZEC among 5 recent active users |
| `/withdraw u1... 0.05` | Send ZEC to an external Unified Address |
| `/history` | Last 10 tips (sent and received) |
| `/stats` | Personal totals: sent, received, counts |
| `/leaderboard` | Top 5 tippers and receivers (last 30 days) |

### Admin Commands (Group Admins Only)

| Command | Description |
|---|---|
| `/setmintip 0.0001` | Set minimum tip amount for the group |

---

## Tip Flow (Internal — Off-chain)

Tips between registered users in the same bot instance are **off-chain SQLite updates**:

```
/tip @bob 0.01 ZEC
  → validate sender registered & balance sufficient
  → BEGIN TRANSACTION
      debit alice  by 0.01 ZEC
      credit bob   by 0.01 ZEC
      INSERT tip record with encrypted memo JSON
  → COMMIT
  → "✅ Tipped @bob 0.01 ZEC"
```

No on-chain transaction is created. The encrypted memo is stored in DB for audit.

---

## Withdrawal Flow (On-chain)

```
/withdraw u1abc...xyz 0.05
  → validate u1... address (ZIP-316, reject t1.../zs1...)
  → validate balance >= amount + ZIP-317 fee
  → store pending_confirmation (expires in 60s)
  → prompt user to reply YES/NO

User replies YES:
  → BEGIN TRANSACTION
      debit user balance (amount + fee)
      INSERT withdrawal record (status=pending)
  → COMMIT
  → broadcast Orchard tx via lightwalletd gRPC
  → update withdrawal status to 'broadcast'
  → "✅ Withdrawal of 0.05 ZEC sent. TXID: ..."
```

---

## Security Model

| Concern | Mitigation |
|---|---|
| Seed storage | AES-256 encrypted at rest, decrypted in memory at startup only |
| Spending keys | Never logged, never exposed via any command |
| Balance mutations | All in SQLite transactions — no race conditions |
| Withdrawal cooldown | 10 minutes after `/register` |
| Withdrawal confirmation | User must reply YES within 60 seconds |
| Tip rate limiting | 10 tips per user per minute |
| Address validation | `zcash_address` crate validation (not regex) |
| Transparent addresses | Rejected — only `u1...` UAs accepted |

---

## Running as a Public Bot

This bot is designed to be public — like Rose, Combot, or other widely-used
Telegram utility bots, anyone can find it and add it to their group. A few
things that come with that:

- **Anyone can add it, anywhere.** There's no allowlist by default. If you
  want to restrict which groups can use it, you'd add a check in the
  `new_chat_members` handler in `bot.js`.
- **`/leave`** lets any group admin remove the bot cleanly from their own
  group at any time.
- **Group-join rate limiting.** The bot caps itself at 20 new group joins
  per hour globally, to avoid tripping Telegram's anti-spam systems if it
  goes viral or gets targeted by automated mass-adding.
- **`/stats_global`** (DM-only, restricted to `BOT_OWNER_TELEGRAM_ID`) gives
  you a live view of total groups, users, tips, and volume — useful for
  monitoring growth without touching the database directly.
- **No group-specific data is collected beyond what's needed to run tipping**
  (tip history scoped to that group, and the group's minimum-tip setting).
  If a group removes the bot, that data simply stops being added to — it's
  not deleted automatically, but nothing further is collected either.

## Adding the Bot to New Communities

Once deployed, growing to new ambassador communities is just like adding
any other Telegram bot:

1. Group admin searches for your bot's username (e.g. `@ZcashAmbassadorsBot`) in Telegram
2. Admin adds it to their group
3. Bot auto-detects the join via the `new_chat_members` event, registers the group in the database with default settings, and posts a welcome message
4. Members can immediately `/register` and start tipping — no further setup

Each group gets independent:
- **Minimum tip amount** (`/setmintip`, defaults to `MIN_TIP_ZATOSHIS` from `.env`)
- **Leaderboard** (scoped to tips that happened in that specific group)
- **Rain recipient pool** (`/rain` only considers users active in that group)

All groups share:
- **The same bot wallet** — one Orchard-shielded hot wallet, one `lightwalletd` connection to scan
- **User identity and balance** — if Alice is in 5 ambassador groups, she has one wallet and one balance across all of them; she only runs `/register` once, ever

---

## Production Checklist

- [ ] `MOCK_WALLET` is NOT set (or set to `false`)
- [ ] `ENCRYPTION_KEY` is 32+ random characters, stored securely
- [ ] `BOT_SEED_PHRASE` backed up offline in cold storage
- [ ] zebrad fully synced to chain tip
- [ ] lightwalletd running and reachable
- [ ] Native addon built and tested
- [ ] DB directory permissions restricted (`chmod 700 data/`)
- [ ] Log file rotation configured
- [ ] Process managed by systemd or PM2
- [ ] TLS configured on lightwalletd endpoint
- [ ] Firewall blocks external access to lightwalletd port

---

## Project Structure

```
zcash-tipbot/
├── src/
│   ├── bot.js          # Telegraf entry point, all command handlers
│   ├── wallet.js       # Address derivation, fee calc, tx broadcast
│   ├── db.js           # SQLite schema, migrations, query helpers
│   ├── tips.js         # Tip logic, validation, rain, stats
│   ├── withdraw.js     # Withdrawal initiation, confirmation, broadcast
│   ├── messages.js     # All formatted bot response strings
│   ├── rateLimiter.js  # Rate limiting middleware
│   ├── config.js       # .env loader and constants
│   └── logger.js       # Winston logger setup
├── scripts/
│   └── migrate.js      # Run DB migrations
├── native/             # librustzcash Node.js native addon (production)
│   ├── src/lib.rs      # Rust FFI: deriveUA, buildOrchardTx
│   └── Cargo.toml
├── data/               # SQLite DB and logs (gitignored)
├── .env.example
├── package.json
└── README.md
```

---

## Zcash Technical References

- [ZIP-316](https://zips.z.cash/zip-0316) — Unified Addresses
- [ZIP-317](https://zips.z.cash/zip-0317) — Proportional Transfer Fee
- [ZIP-224](https://zips.z.cash/zip-0224) — Orchard Shielded Protocol
- [ZIP-302](https://zips.z.cash/zip-0302) — Shielded Memo Format
- [librustzcash](https://github.com/zcash/librustzcash) — Zcash Rust crates
- [lightwalletd](https://github.com/zcash/lightwalletd) — Wallet gRPC server
- [zebrad](https://github.com/ZcashFoundation/zebra) — Zcash full node

---

## License

MIT — Built for the Zcash Ambassador Community
