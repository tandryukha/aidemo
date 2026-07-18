# Demo environments and seed data that make a demo reproducible

July 18, 2026 · Demo Automation · 8 min read · https://aidemo.top/blog/demo-environments-and-seed-data/

> You pinned the browser and the encoder. Then the same click lands on a different dashboard, because the database reseeded. The state has to be pinned too.

**Key takeaways**

- A demo replays clicks, not facts: if the backend reseeds differently, the same click lands on different data. Pin the state before you bother pinning pixels or bytes.
- faker.seed(123) and Postgres setseed() make the RNG repeatable, but Faker's own docs warn that relative-date helpers (date.recent, date.past, uuid v7) default to 'today' and still drift.
- Four leaks survive a fixed seed: relative dates, DB-side random()/now(), external API calls, and unordered or v4-UUID rows. Pin each or the video changes for no product reason.
- Reset to clean before every take: truncate and reseed, roll back a transaction, or clone a pristine Postgres template (template0) so each run starts from an identical state.
- Record and replay external calls (Polly.js) or use a sandbox test clock (Stripe) so a payment, enrichment, or model response doesn't make the demo different every night.

## A demo is a function of its data, not just its clicks

The usual determinism advice stops at the browser. You keep [pinning the browser so it paints the same pixels on every run](/blog/deterministic-browser-automation-for-video): fixed viewport, frozen clock, fonts awaited, network owned. Some teams go further and [freeze the finished MP4 down to the byte](/blog/reproducible-demo-renders). Both are real work, and both assume the thing on screen is the same thing on screen. It often is not, because the spec replays the same *clicks*, and a click is a coordinate, not a fact. Click the second row of the invoices table on Monday and it says \$4,180 from Acme; reseed the database and click the same row Tuesday and it says \$92 from a name the generator picked fresh. The action replayed perfectly. The data underneath it moved.

That is the part [regenerating a demo instead of re-recording it](/blog/automated-product-demo-videos) actually depends on. The demo is a function of three inputs, not one: the spec you committed, the build you run it against, and the state the build is sitting on. Pin the first two and leave the third floating and the re-render is not reproducible, it is a fresh draw from whatever the seed script happened to produce this morning. So the backend needs the same discipline the browser got. The same rows, in the same order, with the same values and the same dates, every single run. This is the mechanics of getting there, and the failure modes that look fixed but are not.

## Seed the generator so the same rows appear every run

Randomness enters a demo backend at three layers, and each has its own off switch. The application-code generator is the first. Faker, the standard for this, is random by default, and its own guide is exact about the fix: "If you want consistent results, you can set your own seed," after which `faker.seed(123)` twice yields the same value twice ([Faker, accessed July 2026](https://fakerjs.dev/guide/usage)). One line converts a generator that invents a new customer roster every run into one that invents the same roster forever.

The second layer is the ORM seed script. Prisma frames seeding around exactly this property: it "allows you to consistently re-create the same data in your database," run on demand through `prisma db seed` ([Prisma, accessed July 2026](https://www.prisma.io/docs/orm/prisma-migrate/workflows/seeding)). Make the script idempotent (Prisma's own example reaches for `upsert`, not `create`) so re-running it lands the same table state instead of stacking duplicates. The third layer is the database itself, for anything generated in SQL rather than app code. PostgreSQL will repeat its own randomness on request: "if `setseed()` is called, the series of results of subsequent calls to these functions in the current session can be repeated by re-issuing `setseed()` with the same argument" ([PostgreSQL, accessed July 2026](https://www.postgresql.org/docs/current/functions-math.html)).

A seed script that pins all three reads like this. The comments mark the four things it is pinning, which the next section takes apart one at a time.

```ts
import { PrismaClient } from '@prisma/client'
import { faker } from '@faker-js/faker'

const prisma = new PrismaClient()

faker.seed(42)                                   // 1. same names, emails, amounts every run
faker.setDefaultRefDate('2026-01-15T00:00:00Z')  // 2. pin "now" so relative dates stop aging

async function main() {
  await prisma.invoice.deleteMany()               // 4. reset to clean before seeding
  await prisma.customer.deleteMany()

  for (let i = 0; i < 8; i++) {
    const customer = await prisma.customer.create({
      data: {
        id: `cus_${1000 + i}`,                    // 3. deterministic id, not a v4 uuid
        name: faker.person.fullName(),
        email: faker.internet.email(),
        signedUpAt: faker.date.recent({ days: 30 }), // relative to the pinned refDate
      },
    })
  }
}
```

## A fixed seed is necessary, not sufficient

Here is the trap every Faker tutorial walks right past, because it does not matter for a unit test and matters enormously for a video. Seeding the generator is not the same as seeding the demo. Four things leak through a fixed seed and change the footage anyway, and the first is documented by Faker itself: the relative-date helpers "default to creating a date before or after 'today', and 'today' depends on when the code is run" ([Faker, accessed July 2026](https://fakerjs.dev/guide/usage)). Seed it all you like; a `faker.date.recent()` signup labeled "3 days ago" this week reads "68 days ago" two months from now, and your evergreen demo has a timeline that ages in public. The fix is a fixed reference date, `setDefaultRefDate`, which is why it sits on line two of the script above.

The other three leak the same way: invisible in a test, on camera in a render.

| Leak | Survives `faker.seed()`? | On-screen symptom | The pin |
|---|---|---|---|
| Relative dates | Yes | "3 days ago" becomes "68 days ago" months later | fixed reference date (`setDefaultRefDate`), or a frozen app clock |
| DB-side randomness | Yes | row values or order shift when `random()`, `gen_random_uuid()`, or `now()` run in SQL | `setseed()` before the seed queries; fixed literals, not `now()` |
| External API calls | Yes | a payment status, enrichment result, or model reply differs per run | record and replay the call, or a sandbox test clock |
| Ordering and IDs | Yes | rows render in a different order; v4 UUID keys change every seed | `ORDER BY` a stable column; deterministic IDs, never a v4 UUID |

The external-call row is the one that bites hardest, because it is the layer you do not own. A demo that shows a Stripe charge, a clearbit-style enrichment, or an LLM response is filming a third party's mood at capture time. Two tools close it. Record-and-replay puts a cache in front of the network: Netflix's Polly.js exists to "record your test suite's HTTP interactions and replay them during future test runs for fast, deterministic, accurate tests," and to "simulate different application states" on demand ([Netflix, accessed July 2026](https://github.com/Netflix/pollyjs)). For time-driven services there is a purpose-built clock: Stripe's test clocks let you "see how various Billing resources like subscriptions change over time" in a sandbox, so a renewal or a dunning email happens on the tick you choose instead of whenever the calendar reaches it ([Stripe, accessed July 2026](https://docs.stripe.com/billing/testing/test-clocks)). Either way the rule is the same as the browser's: [take the network out of the shot](/blog/deterministic-browser-automation-for-video) and feed it data you control.

## Reset to a known-clean state before every take

A seed script that assumes an empty database is a bug waiting for the second run. The take before this one left rows behind, a probe run created a half-finished order, yesterday's render bumped an auto-increment counter. Reproducibility needs the starting state to be identical, which means resetting to clean is not optional cleanup, it is part of the seed. Four strategies, trading speed for isolation.

| Strategy | Speed | Isolation | Reach for it when |
|---|---|---|---|
| Truncate then reseed | seconds | full | a small fixture and a single render process |
| Transaction rollback | milliseconds | per-run | the whole flow fits in one transaction (rare for a real browser take) |
| Copy a template database | fast file copy | full | Postgres, and you want a pristine DB per run |
| Snapshot restore or throwaway container | seconds to minutes | full | heavy fixtures, or CI that discards the environment anyway |

The template-database row is the underused one. PostgreSQL builds every new database by copying an existing one: "`CREATE DATABASE` actually works by copying an existing database," and copying the untouched `template0` gives you "a 'pristine' user database (one where no user-defined objects exist and where the system objects have not been altered)" ([PostgreSQL, accessed July 2026](https://www.postgresql.org/docs/current/manage-ag-templatedbs.html)). Seed a database once, register it as a template, and each run spins a clean clone in the time of a file copy rather than a full re-seed.

At the productionized end, the reset becomes the whole environment. Sales-demo platforms sell exactly this move: Bunnyshell spins "one environment per prospect" with "pre-loaded sample data" so the state is fresh and isolated for every session ([Bunnyshell, accessed July 2026](https://www.bunnyshell.com/demo-environments/)). For a recorded demo you rarely need that much machinery, but the principle transfers down: the render should start from a state it built, not one it inherited. That discipline is also what keeps a demo honest, because a shared, drifting environment is one more way [a demo quietly stops matching the product it claims to show](/blog/why-product-demos-go-stale).

## Where the seeded backend sits in the determinism stack

Three layers have to agree before a re-render is trustworthy, and they stack. The state layer is this one: a seeded, reset, clock-pinned backend so the same query returns the same rows. On top sits the capture layer, the pinned browser that turns those rows into identical pixels. On top of that, optionally, the encode layer that freezes the file itself. Skip the bottom layer and the two above it are pinning a moving target with great precision. A nightly re-render against an unseeded backend does not prove the product is stable, it proves the seed script is nondeterministic, and it will page you at 4am over a customer name that changed for no product reason at all.

This is the layer our own engine, aidemo, deliberately does not own, and it is worth being exact about the seam. aidemo drives a real Chrome through a committed storyboard and pins the capture side, but the storyboard expects the app to already be sitting on a controlled state, seeded and reset by your own script or fixture before the take. It is browser-only, its storyboards are agent-authored rather than assembled on a drag-and-drop timeline, and it does not manage your database, so the seed discipline here is yours to run in the job that renders the demo. Reproducible state is also the twin of realistic state: a seed that repeats is worth little if the rows read as lorem ipsum, so pair this with [making those rows believable without leaking a real customer](/blog/realistic-demo-data-generation). Nail both and the re-render stops being a hopeful coincidence: same inputs, same demo, on demand.

## Sources

- [Faker — Usage guide (faker.seed for reproducible values; relative-date helpers default to 'today' and need a fixed reference date)](https://fakerjs.dev/guide/usage)
- [Prisma — Seeding (consistently re-create the same data; prisma db seed; idempotent upsert example)](https://www.prisma.io/docs/orm/prisma-migrate/workflows/seeding)
- [PostgreSQL — Mathematical functions (setseed repeats random() results in the current session)](https://www.postgresql.org/docs/current/functions-math.html)
- [PostgreSQL — Template databases (CREATE DATABASE copies a template; template0 for a pristine copy)](https://www.postgresql.org/docs/current/manage-ag-templatedbs.html)
- [Netflix Polly.js — Record, replay, and stub HTTP interactions for fast, deterministic tests](https://github.com/Netflix/pollyjs)
- [Stripe — Test clocks (simulate Billing objects like subscriptions moving through time in a sandbox)](https://docs.stripe.com/billing/testing/test-clocks)
- [Bunnyshell — Sales demo environments (one environment per prospect, pre-loaded sample data)](https://www.bunnyshell.com/demo-environments/)

## FAQ

### Why does my demo show different data every time it re-renders?

Because the demo replays clicks, not facts, and a click just lands on whatever row the seed script produced this run. If the data generator is unseeded, or seeded but leaking through relative dates, database-side `random()`, external API calls, or unordered queries, the same click hits a different value each time. Pin the generator with a fixed seed, pin the reference date, stub the external calls, and order your queries, so the same coordinate always lands on the same fact.

### How do I stop seeded "3 days ago" timestamps from aging in a demo?

A fixed RNG seed does not fix this on its own. Faker's own docs note that helpers like `faker.date.recent` default to a date relative to "today," so a signup that reads "3 days ago" at seed time drifts as the calendar moves. Set a fixed reference date (`faker.setDefaultRefDate`) or freeze the application clock during the render, so "now" is a pinned value and every relative label reads the same in every re-render.

### How do I reset a demo database to a clean state between renders?

Pick the cheapest reset that gives full isolation for your fixture size. A small dataset can truncate the tables and re-run the seed each time. On PostgreSQL, seed once and copy a template database, since `CREATE DATABASE` clones an existing one in the time of a file copy and `template0` gives a pristine starting point. For heavy fixtures or CI that throws the environment away, restore a snapshot or spin a fresh throwaway container per run.
