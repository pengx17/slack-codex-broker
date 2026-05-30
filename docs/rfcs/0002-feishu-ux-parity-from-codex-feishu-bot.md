# RFC 0002: Feishu UX parity from codex-feishu-bot prior art

Status: Draft for review
Last updated: 2026-05-30

This RFC is a follow-up to [RFC 0001](./0001-slack-feishu-dual-platform.md).
RFC 0001 establishes the Slack + Feishu dual-platform broker baseline. RFC 0002
defines the next product step: borrow useful Feishu interaction patterns from
the older [HOOLC/codex-feishu-bot](https://github.com/HOOLC/codex-feishu-bot)
repository while reducing, not increasing, Slack/Feishu implementation
divergence.

## How to read this RFC

| Layer | Reader need                             | Read                                                                                                             |
| ----- | --------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| 1     | You need the decision and goal.         | Read this page through [Acceptance gates](#acceptance-gates).                                                    |
| 2     | You need product context.               | Expand [Product gap and prior art](#product-gap-and-prior-art).                                                  |
| 3     | You need to prevent Slack/Feishu drift. | Expand [Convergence contract](#convergence-contract).                                                            |
| 4     | You are implementing the work.          | Expand [Implementation slices](#implementation-slices).                                                          |
| 5     | You are reviewing automation/evidence.  | Expand [Automation, evidence, migration, and open questions](#automation-evidence-migration-and-open-questions). |

## Layer 1: Decision summary

Copy the interaction model, not the runtime.

The old Feishu bot has good product ideas for Feishu-native progress cards,
stable output projection, card updates, debounced delivery, and
operator-friendly setup. The current broker already has the better shared
foundation. The missing part is a Feishu experience that feels native in a
group chat instead of feeling like Slack behavior pushed through Feishu
transport.

The hard design constraint:

- Feishu-specific code may own native rendering and Feishu transport details.
- Turn lifecycle, recovery, output intent, dedupe/debounce policy, and
  file/artifact intent should converge toward platform-neutral
  `src/services/chat/` primitives.
- Slack behavior must remain unchanged unless a shared abstraction is extracted
  with Slack regression coverage.

## Goal

Build Feishu-native work visibility while reducing long-term platform fork:

- one active Feishu turn should have a visible status card
- that card should update through queued/thinking/tool/waiting/blocked/final or
  failed states
- Codex commentary, tool progress, final output, and files/artifacts should map
  into stable logical presentation slots
- noisy app-server updates should be deduped, debounced, and serialized before
  reaching Feishu card patch APIs
- reusable turn/projection/file intent logic should move toward chat-domain
  primitives instead of growing a second Feishu-only runtime
- Open Platform setup docs should distinguish CLI-assisted steps from manual
  admin gates

## Long-running task readiness

This RFC is usable as a long-running task only if implementation is tracked as
three parallel workstreams:

1. Shared chat boundary: prevent new Slack/Feishu forks while Feishu UX improves.
2. Feishu-native UX: status card, projection, card patching, and artifact
   display.
3. Automated self-regression: repeatable Slack/Feishu evidence that survives
   handoff, rebases, and long review cycles.

Current verdict:

- The product and architecture direction is long-running-task ready.
- The shared projection, Feishu updateable status card, artifact projection,
  shared self-regression runner, and dashboard work/open-inbound parity slices
  are implemented in PR #73.
- Slack self-regression can become mostly auto-driven because a real test
  channel and Slack user/bot/app credentials can produce controlled inbound and
  outbound evidence. Current Slack drive is blocked by the supplied user-token
  scope posture: the runner can resolve the test channel but cannot post the
  controlled user message.
- Feishu self-regression is not fully unattended with app-only bot credentials:
  the app can observe and reply, but it cannot impersonate a human group member
  to create the required `@bot` and non-`@` inbound messages. Feishu needs either
  a test-user driver credential, a browser/desktop driver, or a manual action
  step followed by automated observation.
- RFC completion must distinguish automated evidence from manually triggered
  evidence. Do not call the Feishu gate "automatic" until the driver limitation
  is resolved.

## Non-goals

- Do not migrate the old repository wholesale.
- Do not replace `SlackAgentBridge`, `SessionManager`, or `CodexBroker` in this
  RFC.
- Do not make private chat a supported product surface.
- Do not require native Feishu read receipts or typing APIs for acceptance; the
  Feishu status card is the product-equivalent signal.
- Do not support Lark international tenant behavior here. This remains China
  Feishu only.
- Do not introduce distributed workers or distributed state. The broker remains
  single-process unless a later RFC changes that assumption.

## Acceptance gates

- [x] `pnpm test` passes.
- [x] `pnpm rfc:feishu-audit -- --json` passes after any audit criteria changes.
- [x] `pnpm rfc:feishu-test-plan -- --json` passes after test-plan updates.
- [x] The implementation PR includes a shared-vs-platform boundary map.
- [x] No new platform-generic behavior is exposed only through a Slack-named
      method.
- [x] Any shared helper touched by Slack has Slack regression coverage.
- [x] Automated self-regression commands are documented and wired for local
      preflight, saved-evidence replay, and platform drive where credentials
      allow it.
- [x] Self-regression reports are sanitized, replayable, and safe to attach to a
      PR without leaking tokens, raw message bodies, user emails, raw bot IDs, or
      host filesystem paths.
- [ ] Slack self-regression evidence bundle is present for the current Slack
      auth/app installation.
- [ ] Feishu self-regression evidence bundle is present for the current China
      Feishu self-built app installation.
- [x] Feishu mock tests cover active status card lifecycle, patch debounce,
      patch ordering, final state, failure state, and file/artifact display.
- [ ] Real tenant smoke evidence bundle is present.

<details>
<summary id="product-gap-and-prior-art">Layer 2: Product gap and prior art</summary>

## Product gap in RFC 0001

| Area                   | RFC 0001 baseline                                                              | RFC 0002 target                                                       |
| ---------------------- | ------------------------------------------------------------------------------ | --------------------------------------------------------------------- |
| Active work visibility | Feishu can run a session and reply, but progress UX is thin.                   | Feishu group sees one evolving active-turn card.                      |
| Typing/status parity   | Slack has more natural typing/status affordances.                              | Feishu uses card state as the product-equivalent signal.              |
| Tool progress          | Tool output can be surfaced, but not yet shaped as a stable Feishu card model. | Current tool/action is folded into a stable card slot.                |
| Message noise          | Multiple progress events may become multiple visible messages.                 | Debounced card patching keeps the group readable.                     |
| Artifact/file path     | File support exists but needs clearer product-level evidence.                  | File/artifact links are first-class card sections and smoke evidence. |
| Operator setup         | RFC 0001 documents required credentials/evidence.                              | Setup docs distinguish CLI-assisted steps from manual admin gates.    |

## Useful old-repo patterns

Copy these ideas:

- updateable Feishu cards for active work instead of posting many independent
  progress messages
- a projector model that maps Codex commentary, tool calls, final answers, and
  artifacts into stable UI slots
- debounced delivery with content hashing so repeated partial updates do not
  spam the group
- per-message/card update queues to avoid out-of-order Feishu patch operations
- folded tool/detail cards so long tool output is available without dominating
  the group
- file/artifact publishing helpers that make Feishu uploads a first-class path
- Open Platform/bootstrap notes that reduce the amount of manual Feishu setup
  guessing

Do not copy:

- the Feishu-only runtime shape
- JSON snapshot state as the broker source of truth
- the old Codex worker/app-server flow
- Docker-first deployment assumptions
- private-chat product behavior
- node:test-only test structure
- one-off parsing shortcuts that bypass the current shared broker contracts

</details>

<details>
<summary id="convergence-contract">Layer 3: Convergence contract</summary>

## Current divergence

RFC 0001 already has a shared `ChatPlatformAdapter` contract, but meaningful
behavior is still uneven:

- Slack has mature conversation service / turn runner paths.
- Feishu has its own bridge for group follow-up, steering, stop, recovery, and
  outbound queueing.
- HTTP routes and admin routes still expose Slack-named bridge methods in
  several places, even when the endpoint is already chat-platform generic.
- Feishu status output is currently a thin adapter hook rather than a real
  platform-neutral status/projection model.

## Target split

| Layer                 | Shared responsibility                                                 | Platform responsibility                                     |
| --------------------- | --------------------------------------------------------------------- | ----------------------------------------------------------- |
| Inbound normalization | `ChatInputMessage`, identity, coordinates, attachment intent          | Slack Events API shape, Feishu long-connection event shape  |
| Turn lifecycle        | active turn state, stop, steer, recovery, bounded history policy      | native message/thread ids and platform history fetch limits |
| Output intent         | status, commentary, tool progress, final answer, file/artifact intent | Slack blocks/mrkdwn, Feishu cards/rich text/files           |
| Delivery policy       | hash/no-op suppression, debounce windows, per-target ordering         | API-specific retry/error mapping and rate-limit ceilings    |
| Admin/evidence        | platform-neutral session state and smoke result schema                | platform-specific setup/admin status fields                 |

## Convergence rules

- [x] New Feishu behavior starts behind `ChatPlatformAdapter` or a
      `src/services/chat/` intent type whenever the behavior is not inherently
      Feishu-specific.
- [x] Feishu-native card JSON stays in `src/services/feishu/`, but the data that
      feeds it should be a shared `ChatTurnProjection`-style model.
- [x] If Feishu needs logic that Slack already has in `SlackTurnRunner` or
      `SlackConversationService`, first decide whether the shared concept should
      move to `src/services/chat/` instead of copying the Slack implementation.
- [x] No new Slack-named API should be added for behavior that is already
      platform-generic. Existing Slack-named compatibility methods may remain
      until a later cleanup.
- [x] Any extraction that touches Slack must include Slack regression tests;
      Feishu product work must not silently change Slack UX.
- [x] Platform-specific branches need a short reason: native capability, API
      limitation, permission model, or product difference.

</details>

<details>
<summary id="implementation-slices">Layer 4: Implementation slices</summary>

## Slice 0: Shared chat boundary check

Implementation targets:

- `src/services/chat/chat-platform-adapter.ts`
- `src/services/chat/` new projection/delivery intent modules if needed
- `src/services/slack/slack-turn-runner.ts`
- `src/services/slack/slack-conversation-service*.ts`
- `src/services/feishu/feishu-codex-bridge.ts`
- `src/http/chat-routes.ts`

Checklist:

- [x] Identify the minimum shared model for turn state, output projection, file
      intent, delivery ordering, and recovery outcome.
- [x] Keep native rendering out of the shared layer: Slack blocks and Feishu card
      JSON remain adapter concerns.
- [x] Prefer additive shared helpers over renaming large Slack classes in this
      RFC; broad class renames can wait for a cleanup-only PR.
- [x] Replace or wrap any new Slack-named API with a chat-platform-neutral name.
- [x] Add one cross-platform test that proves the same logical turn projection
      can render into Slack and Feishu without sharing native renderer code.

Acceptance:

- [x] RFC 0002 implementation has an explicit shared-vs-platform map in its PR
      summary.
- [x] New Feishu status/projection tests exercise shared intent objects, not only
      Feishu card JSON.
- [x] Slack regression tests cover any extracted helper used by Slack.

## Slice 1: Feishu updateable card API

Implementation targets:

- `src/services/feishu/feishu-api.ts`
- `src/services/feishu/feishu-platform-adapter.ts`
- `test/feishu-api.test.ts`
- `test/feishu-platform-adapter.test.ts`

Checklist:

- [x] Add Feishu API coverage for card/message update or patch endpoints.
- [x] Model update failure modes explicitly: missing message id, expired card,
      permission failure, and retryable transport failure.
- [x] Add adapter method such as `updateThreadState` / `updateCard` without
      leaking Feishu endpoint details into the bridge.
- [x] Keep patch/update endpoint selection Feishu-local, but expose only a
      logical chat state/projection update to shared callers.
- [x] Preserve current send-message and callback behavior.

Acceptance:

- [x] Unit tests prove the request body, auth headers, and error mapping for
      update/patch calls.
- [x] Existing Feishu send-message tests still pass.
- [x] Slack tests are unchanged and green.

## Slice 2: Feishu turn status card

Implementation targets:

- `src/services/feishu/feishu-codex-bridge.ts`
- `src/services/feishu/feishu-card-renderer.ts` or equivalent
- `test/feishu-codex-bridge.test.ts`
- `test/feishu-real-smoke.test.ts`

Checklist:

- [x] Create an initial active-turn card when Feishu starts or resumes a Codex
      turn.
- [x] Patch that card as the turn moves through queued/thinking/tool/final/error
      states.
- [x] Represent `waiting for user`, `blocked`, and `stop requested` distinctly.
- [x] Keep the final answer readable in the group even if card patching fails.

Acceptance:

- [x] Mock Feishu tests observe the card state lifecycle for success, failure,
      and stop.
- [ ] Real smoke evidence records at least one active card update and final card
      state.

## Slice 3: Stable progress projector

Implementation targets:

- `src/services/chat/` for platform-neutral projection intent
- `src/services/feishu/` for Feishu card rendering
- `src/services/slack/` only for regression coverage or later reuse

Checklist:

- [x] Convert app-server events into stable Feishu presentation slots.
- [x] Represent those slots as a platform-neutral projection before rendering
      Feishu card JSON.
- [x] Hash rendered slot content and skip no-op card patches.
- [x] Debounce rapid partial updates.
- [x] Serialize patch operations per active Feishu card.
- [x] Fold verbose tool details behind card sections rather than dumping every
      detail into the main group message.

Acceptance:

- [x] Tests cover rapid commentary/tool/final sequences without duplicate
      patches.
- [x] Tests cover out-of-order async patch completion without regressing the
      final visible state.
- [x] At least one test proves the projection model is independent from Feishu
      card JSON.

## Slice 4: File and artifact publishing UX

Implementation targets:

- existing `/chat/post-file` route
- shared chat file/artifact intent model if `/chat/post-file` is too route-bound
- Feishu file upload helpers
- `test/manual/run-real-feishu-smoke.ts`

Checklist:

- [x] Keep a platform-generic helper path for posting files from Codex output.
- [x] Render uploaded files/artifacts as card sections or stable message links.
- [x] Record file evidence in smoke output without logging sensitive content.
- [x] Avoid duplicating Slack file routing semantics inside Feishu bridge code;
      use a shared file intent where possible.

Acceptance:

- [x] Mock test proves Feishu file upload and card/link rendering.
- [ ] Real smoke captures file/artifact evidence when credentials and tenant
      permissions are available.

## Slice 5: Open Platform setup runbook

Implementation targets:

- `docs/feishu-setup.md` or a focused RFC 0002 runbook appendix
- existing smoke/audit evidence docs

Checklist:

- [x] Document which steps CLI can assist: app creation metadata, config checks,
      local preflight, smoke evidence template.
- [x] Document which steps remain manual: sensitive permission approval,
      app publish/release, tenant install, adding bot to group.
- [x] Include the exact permission rationale for `im:message.group_msg` and
      card action callbacks.
- [x] Keep secret handling out of git-tracked examples.

Acceptance:

- [x] A new operator can identify the next manual gate without reading chat
      history.
- [x] The runbook maps directly to smoke/audit evidence fields.

</details>

<details>
<summary id="automation-evidence-migration-and-open-questions">Layer 5: Automation, evidence, migration, and open questions</summary>

## Automated self-regression design

Self-regression should have explicit maturity levels so long-running agents do
not confuse "the checker passed" with "the platform was driven end-to-end."

| Level | Name            | What it proves                                             | Slack target                                                               | Feishu target                                                                       |
| ----- | --------------- | ---------------------------------------------------------- | -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| 0     | Local static    | docs/scripts/tests are present and wired                   | `pnpm test`, RFC doc tests                                                 | `pnpm test`, RFC doc tests                                                          |
| 1     | Preflight       | required env posture is set and raw logging is safe        | Slack auth and channel are configured locally                              | Feishu app credentials, domain, group mode, raw logging posture                     |
| 2     | Observe/replay  | saved admin status and logs satisfy evidence checks        | replay saved Slack evidence bundle                                         | `manual:feishu-smoke -- --status-file ...`                                          |
| 3     | Auto-drive      | test runner creates inbound work and observes broker reply | user token posts in configured test channel, bot replies in thread/channel | requires a Feishu test-user/browser driver; app-only bot credentials are not enough |
| 4     | Scheduled guard | repeated unattended regression catches drift               | scheduled Slack self-regression against the test channel                   | scheduled only after Feishu auto-drive exists                                       |

Current command shape:

- `pnpm manual:self-regression -- --platform slack --preflight --env-file .env.local --json`
- `pnpm manual:self-regression -- --platform slack --drive --channel "$SLACK_SELF_REGRESSION_CHANNEL" --output-dir evidence/self-regression/slack --json`
- `pnpm manual:self-regression -- --platform feishu --preflight --env-file .env.local --json`
- `pnpm manual:self-regression -- --platform feishu --observe --manual-action "operator sent @bot + non-@ follow-up in test group" --setup-evidence-file evidence/feishu-smoke/feishu-setup-evidence.json --output-dir evidence/self-regression/feishu --json`
- `pnpm manual:self-regression -- --status-file evidence/self-regression/<platform>/admin-status.json --output-dir evidence/self-regression/<platform> --json`
- `pnpm manual:codex-coding-smoke -- --output-dir evidence/codex-coding-smoke --json`
- `pnpm rfc:feishu-completion-audit -- --json`

The shared `manual:self-regression` entrypoint is wired for Slack/Feishu
preflight, saved admin-status replay, live admin observe, and Slack channel
drive where credentials and a running broker are available. Slack drive accepts
either a safe `#channel` label or a Slack channel id. If the user token cannot
list channels, the runner may resolve the channel with the bot token, but the
inbound message still requires a user-capable token that can call
`chat.postMessage` in the configured test channel. That token must authenticate
as a human or dedicated test user, not as the bot user: a bot posting
`<@itself>` only produces self-authored Slack message events and cannot prove
human inbound routing. Feishu drive remains explicitly blocked until a
human/browser/test-user driver exists; use Feishu observe mode after the manual
group actions until then. Feishu observe must include `--manual-action` or
`FEISHU_SELF_REGRESSION_MANUAL_ACTION`; otherwise the report fails closed
because broad admin logs alone do not prove which operator action produced the
inbound event. Completion audit remains red until Slack drive, Feishu observe,
and real Codex coding smoke bundles are present, sanitized, and replayable.
Put differently: Slack drive, Feishu observe, and real Codex coding smoke bundles are present before the final acceptance gate can turn green.

Automation rules:

- [x] The runner must load secrets only from local env files, process env, or
      operator memory. It must never require tokens in git-tracked fixtures.
- [x] The Slack driver must use a configured test channel, not an arbitrary
      production channel. The current local channel is private operator
      configuration, not an RFC constant.
- [ ] Slack auto-drive must create a controlled inbound message, observe the
      broker reply/state update, exercise `/chat/post-file`, and write a
      sanitized evidence bundle.
- [x] Slack auto-drive must fail closed with the Slack API `needed`/`provided`
      scope posture when the configured token cannot post the controlled user
      message.
- [x] Slack auto-drive must fail closed when `SLACK_USER_TOKEN` authenticates as
      the bot user; self-authored bot messages do not prove user inbound.
- [x] Feishu observe mode may be accepted as interim evidence only if it clearly
      says which human/browser action produced the inbound event.
- [x] Feishu auto-drive requires a separate driver design. A bot sending a
      message to itself does not prove user inbound, active follow-up, or
      self-sender filtering.
- [x] Saved evidence replay must fail closed when required checks are missing,
      stale, unsafe, or only implied by broad admin health.
- [x] Every evidence bundle must include a manifest with platform, mode
      (`preflight`, `observe`, `drive`, or `replay`), checkedAt, command,
      sanitized source files, and pass/fail checks.

## Trigger matrix

| Change type                             | Required before PR update                              | Required before final acceptance                                     |
| --------------------------------------- | ------------------------------------------------------ | -------------------------------------------------------------------- |
| Feishu renderer/card-only change        | Feishu unit/mock tests, Feishu observe or saved replay | Feishu real smoke evidence                                           |
| Shared chat projection/delivery change  | Slack regression tests and Feishu mock tests           | Slack drive evidence plus Feishu observe/drive evidence              |
| Slack conversation/turn behavior change | Slack unit/e2e tests                                   | Slack drive evidence in the configured test channel                  |
| Setup/runbook-only change               | RFC doc tests and preflight docs                       | No real platform drive unless the runbook changes evidence semantics |
| Secret/evidence sanitizer change        | sanitizer unit tests and saved unsafe fixture tests    | one sanitized Slack or Feishu evidence bundle reviewed for leaks     |

## Self-regression evidence checklist

Both platforms need self-regression evidence before this RFC can be accepted.
These runs are not substitutes for unit tests; they prove that the configured
real Slack app and real Feishu app still work after shared chat-layer changes.

Slack self-regression evidence must show:

- current Slack bot/user/app-level auth is loaded from local secrets, not
  committed fixtures
- Slack app starts and reports ready in the broker
- Slack can create or resume a session from a real channel/message surface
- Slack can send normal replies and state/status updates through the existing
  product path
- Slack file/artifact posting path is exercised or explicitly marked unavailable
  by workspace permission
- Slack behavior remains unchanged by any shared chat-layer extraction

Feishu self-regression evidence must show:

- current China Feishu self-built app credentials are loaded from local secrets,
  not committed fixtures
- Feishu long-connection adapter starts and reports ready in the broker
- Feishu `@bot` creates or resumes a session in a real group
- Feishu non-`@` follow-up enters the same active session when
  `FEISHU_GROUP_MESSAGE_MODE=all`
- Feishu status-card or product-equivalent state update is visible during a real
  turn
- Feishu file/artifact posting path is exercised or explicitly marked
  unavailable by tenant permission

## Real tenant evidence checklist

The real tenant smoke evidence must show:

- bot added to a China Feishu group
- `@bot` creates or resumes a session
- non-`@` follow-up enters the same active session when
  `FEISHU_GROUP_MESSAGE_MODE=all`
- active card changes state during a real Codex coding task
- final answer is visible in the same Feishu group
- file/artifact path is exercised or explicitly marked unavailable by tenant
  permission
- Slack + Feishu are ready in the same process

## Migration boundaries

The safest implementation order is Feishu-first and extraction-second:

1. Define the shared intent boundary before writing Feishu card code.
2. Build the Feishu-native status/card/projector path using that boundary.
3. Stabilize it with mock and real smoke evidence.
4. Extract additional shared chat primitives only where Slack can reuse them
   without changing Slack product behavior.

This avoids forcing Slack into Feishu card semantics while still leaving a clear
path toward a future symmetric `ChatRuntime -> SlackAdapter / FeishuAdapter`
architecture.

## Open questions

- [ ] Which Feishu update endpoint is most reliable for the exact card type used
      by the current adapter: message patch, card update, or a different
      interactive-card API?
- [ ] How long can an active Feishu card remain patchable in the target tenant?
- [ ] Should final answers remain inside the status card, be sent as a normal
      group message, or both?
- [ ] What is the minimum file/artifact evidence required when the tenant does
      not approve upload/download permissions?
- [ ] Should the projector become shared immediately, or stay Feishu-local until
      Slack has an actual product reason to consume it?
- [ ] Which Feishu driver should unlock unattended auto-drive: test user access
      token, browser automation, desktop automation, or a controlled external
      harness?
- [ ] Should Slack self-regression live as a standalone runner or as a platform
      mode inside a shared `manual:self-regression` runner?

</details>
