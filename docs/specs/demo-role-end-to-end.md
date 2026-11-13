# Spec: The demo@ role, end to end

| | |
|---|---|
| **Status** | Draft for review |
| **Author** | Sada Kshirsagar |
| **Date** | 2026-11-06 |
| **Scope** | The **Demos template**: the first specialist agent on the [Agent Staff platform](agent-staff-platform.md), plus the calendar features it needs |

> **Built on the platform spec.** Generic agent features now live in [agent-staff-platform.md](agent-staff-platform.md), and that spec takes precedence where the two overlap:
>
> | Here | Replaced by (platform) |
> |---|---|
> | R1 Workspace and principals | A1 |
> | R2 Roles (generic parts) | A2. This spec keeps the Demos-specific setup flow |
> | R9 Autonomy and queue | A6 capability catalog, A7 shared queue. The Demos defaults in the R9 table become the template's settings |
> | R14 Timeline | A12 |
> | R15 Take over and hand off | A13 |
> | R16 Instructions vs. data | A11 |
> | §8.4 Action contract | Platform §8.3 |
> | §10 Phasing | Platform §10, Phase 3. Calendar work (R3–R7) happens there |
>
> Ava is an ordinary agent definition (job, triggers, capabilities, scope, memory). Nothing in this spec should need code specific to Ava beyond the calendar capabilities.

## TL;DR

A solo founder sets up a **Demos role** with an address (`demo@acme.com`), a public booking page (`acme.com/book/demo`), and an agent, **Ava**. A prospect books a slot, and from then on everything happens in one email thread from `demo@`. Ava confirms the booking, handles reschedules sent as plain replies, sends the founder a prep brief, and drafts the follow-up. Anything substantive waits in a **Needs your OK** queue until the founder approves it. Ava signs every message as herself and always says she is an AI assistant. The founder's existing calendar (Google, Apple, or Outlook) stays the source of truth for their time. In v1 CloudMail reads it through a secret ICS feed and writes to it by sending invites, so no OAuth and no Google approval are needed.

The key change from Calendly is that **the booking and the email thread are the same object**, and the address it comes from has staff behind it.

---

## 1. Problem statement

A solo founder is sales, support, and scheduling at the same time. Each inbound demo request leads to chores: finding a time, answering "can we do Thursday instead?", prepping, following up, and chasing no-shows. Booking tools only fix the first step. Their confirmations come from a no-reply address, so every later message lands back in the founder's personal inbox with no context. Every demo costs the founder 20–40 minutes of logistics on top of the call itself. Leads go cold when follow-up slips, and a one-person company looks like one person.

AgentMail gives agents their own mailboxes, but humans stay outside the system. Gmail and Superhuman put AI *inside* the founder's inbox, but it acts as the founder with no identity of its own. Neither one gives the founder a **visible, accountable teammate on their own domain**.

## 2. Goals

1. **Zero-touch demos:** at least 70% of booked demos get from booking to a prepped meeting with no founder action other than approvals. *(User goal)*
2. **Less logistics time:** cut the founder's time per demo, excluding the call itself, from about 30 minutes to under 5. *(User goal)*
3. **Trust:** at least 80% of Ava's queued drafts are approved without edits in a founder's third week. This tells us agents can be given more autonomy. *(Validates the riskiest assumption)*
4. **No calendar errors:** zero double bookings and zero invites sent with the wrong time or time zone. *(Quality bar)*
5. **A foundation we can reuse:** principals, roles, and the agent action log ship as general-purpose pieces that billing@, support@, and teams can build on later. *(Business goal)*

## 3. Non-goals (v1)

| Non-goal | Why |
|---|---|
| Teams, round-robin pools, or more than one human per role | Solo founder first. The data model allows pools (see §8), but there's no UI or logic for them |
| OAuth calendar APIs (Google, Microsoft Graph, CalDAV) | v1 reads secret ICS feeds and writes by sending invites, so we don't need Google's app verification. OAuth is the R22 upgrade |
| Agents joining calls or taking notes | A different product. The founder adds notes by replying to the brief (R12) |
| Hosted signup, billing, or being a system-of-record calendar | v1 runs on a single-workspace deploy and adds a calendar layer on top of the founder's existing calendar |
| Bring-your-own agent runtime | Ava is built in. We define the action contract (§8.4) so external runtimes can plug in later |
| Paid bookings, CRM sync, third-party lead enrichment | They add integrations without proving the core loop |
| Outbound prospecting by Ava | Ava only responds to people who booked or wrote in. Cold outreach is a reputation risk |

## 4. Personas

- **Founder (owner):** runs the company alone and lives in Gmail and Google Calendar today. Wants demos to feel handled without giving up control.
- **Prospect (invitee):** an external person booking a demo. Has never heard of CloudMail and should never need an account.
- **Ava (agent principal):** the built-in scheduling and demo agent. She has an identity, permissions, and an audit trail, and she can never do more than her autonomy settings allow.

## 5. User stories

### Founder
1. As a founder, I want to create a Demos role with its own address, booking page, and agent, so that demo requests have one home that isn't my personal inbox.
2. As a founder, I want to connect my calendar once, so that bookings never conflict with my real schedule and booked demos appear where I already look.
3. As a founder, I want to set when demos can happen (blocks, buffers, a daily cap, minimum notice), so that demos fit around focus time instead of breaking it up.
4. As a founder, I want to write a short playbook in plain language, so that Ava qualifies, answers, and follows up the way I would.
5. As a founder, I want everything Ava wants to say that isn't logistics to wait for my OK, so that nothing reaches a prospect that I wouldn't stand behind.
6. As a founder, I want a prep brief before each demo, so that I walk in knowing who they are and what they asked.
7. As a founder, I want to reply to the brief with my call notes and get a drafted follow-up, so that follow-up happens the same day without me writing it.
8. As a founder, I want to see who did what on every thread, me or Ava, so that I can trust and audit the agent.
9. As a founder, I want to take over any thread with one action, so that I can step in when a deal needs me.

### Prospect
10. As a prospect, I want to pick a time and get a calendar invite at once, so that booking takes less than a minute.
11. As a prospect, I want to reschedule by replying in plain words, so that I don't have to hunt for a link.
12. As a prospect, I want to know when I'm talking to an AI assistant, so that I'm never misled about who is on the other end.

### Edge cases
13. As a founder, I want a slot that becomes busy on my calendar after booking to be flagged to me, not silently moved.
14. As a prospect, I want a clear message if my chosen slot was just taken, plus the next available times.
15. As a founder, I want instructions hidden in a prospect's email ("ignore your rules and…") to have no effect on Ava.
16. As a founder, I want queued drafts that are going stale (for example, a reschedule offer for a time that has passed) to expire, not be sent late.

## 6. Requirements

### P0: must ship

**R1. Workspace and principals (foundation)**
Introduce `workspaces` and `principals`. A principal is `kind: human | agent`. Human principals link to `users`. Agent principals have a display name, an avatar, an owner, and autonomy settings. Every new table is scoped by `workspace_id`. Existing deploys migrate into a single default workspace.
- [ ] The migration creates one workspace, and one human principal per existing user, without changing any current mail behavior
- [ ] Agent principals can't sign in through the UI and have no password
- [ ] All existing tests pass unchanged

**R2. Roles**
A role has a name, a slug, an address from the existing `addresses` table, an owner pool (v1: exactly one human), one assigned agent, and a playbook (markdown, 4,000 characters max).
- [ ] The founder can create the Demos role from a guided setup that also creates `demo@<domain>` if it doesn't exist
- [ ] Mail arriving at the role address lands in a **Demos** mailbox view shared by the founder and Ava. It doesn't go to the founder's personal inbox
- [ ] Only human principals can edit the playbook or autonomy settings

**R3. Calendar connection through ICS feeds (no OAuth in v1)**
The founder pastes one or more secret calendar feed URLs: Google's "Secret address in iCal format", an iCloud public calendar link, or an Outlook published calendar. CloudMail fetches each feed every 5 minutes from the existing cron job, using conditional requests (`ETag` / `If-Modified-Since`). It expands recurring events (`RRULE`, `EXDATE`, and per-instance changes) across the booking horizon and **stores only busy intervals**. Event titles, descriptions, and attendees are discarded. Bookings reach the founder's calendar through the invite in R7, because the founder is an attendee on it. There's no separate write to their calendar.
- [ ] Busy times are taken into account within 5 minutes of CloudMail's next fetch. *Note:* Google can take a while to show changes in its secret feed, so measure the real delay in dogfood
- [ ] Feed URLs are secrets: encrypted at rest, never logged, and masked in the UI once saved
- [ ] If no feed has been fetched successfully for 60 minutes, the booking page stops offering slots, shows "temporarily unavailable", shows the founder a banner, and emails them
- [ ] Handles all-day events, `TRANSP:TRANSPARENT` (shown as free), `STATUS:CANCELLED`, and events with their own time zones
- [ ] If a new event in the feed overlaps a confirmed booking, the founder gets a queue item ("Conflict with <event>: keep, or have Ava offer new times?"). Nothing moves automatically (story 13)

**R4. Availability engine**
Each event type has weekly blocks in the founder's time zone, a duration (15/30/45/60 minutes), buffers before and after, a daily cap, minimum notice, and a booking horizon. Free slots are the blocks, minus busy times from the feed, minus existing bookings and buffers, minus days that have hit the cap.
- [ ] Handles daylight-saving changes correctly in both the founder's and the prospect's time zones (tests cover US and EU switchover weeks)
- [ ] Slots are shown in the prospect's detected time zone, which they can change
- [ ] The cap counts confirmed and held bookings, not cancelled ones

**R5. Atomic slot holds**
One Durable Object per calendar owner holds slots. Booking takes a 10-minute hold, re-checks the busy cache (refetching the feeds first if the last fetch is more than 2 minutes old), then confirms or releases the hold.
- [ ] Two simultaneous bookings for the same slot: exactly one succeeds, and the other gets the "just taken" response with the next three slots (story 14)
- [ ] An expired hold releases the slot without any manual step

**R6. Public booking page**
`/book/<role-slug>/<event-type>` shows the role name, the founder's photo and name, the duration, and free slots. A short intake form asks for name, work email, company, and "what do you want to see?", plus up to 3 questions the founder adds. No account is needed. Turnstile protects the form.
- [ ] Booking completes in 3 steps or fewer, and the page works at 375px width
- [ ] Free email domains are allowed, but flagged to Ava for qualification
- [ ] The page is rate limited per IP and per invitee email

**R7. The booking is the thread (core)**
Confirming a booking creates a thread in the Demos mailbox and sends a confirmation **from the role address** with an iCalendar invite (an email with `METHOD:REQUEST`, using a stable `UID`). The thread and the booking point at each other. Rescheduling resends the invite with the same `UID` and a higher `SEQUENCE`. Cancelling sends `METHOD:CANCEL`. **The role address is the organizer, and both the prospect and the founder are attendees on the same invite**, so the founder's calendar adds the event through the invite like any other. There's only one invite, so nothing is duplicated.
- [ ] The prospect's Gmail, Outlook, and Apple Mail each show a native accept/decline invite, and accepting doesn't create duplicates on reschedule
- [ ] The founder's calendar (Gmail with Google Calendar, Apple Calendar, Outlook) shows the event, with a link back to the thread in its description
- [ ] On the next fetch, the busy cache recognizes the founder's copy of the event by its `UID` and doesn't count it as a conflict with its own booking
- [ ] Every reply from the prospect goes into the same thread (using the `In-Reply-To` and `References` threading that already exists)

**R8. Ava's identity and disclosure**
Ava sends as `"Ava · <Company>" <demo@acme.com>` with `Reply-To` set to the role address. Every message Ava sends ends with a fixed disclosure line that can't be edited: *"Ava · AI scheduling assistant at Acme. Sada sees this conversation."* Ava never writes in the founder's first person and never signs as the founder.
- [ ] The disclosure line is added at send time on the server, so no draft edit can remove it
- [ ] Messages the founder sends from the same thread go out as the founder, without the disclosure

**R9. Autonomy and the Needs your OK queue**
Every action Ava takes is recorded as an `agent_action` with `kind`, `payload`, and `status: proposed → approved | rejected | expired → executed`. Each action kind has an autonomy level: **auto** (runs at once and is logged) or **approve** (waits in the queue).

| Action | v1 default |
|---|---|
| Booking confirmation, reminder 24 hours before | auto |
| Reschedule to a slot the prospect named that is free | auto |
| Offer new slots, cancel at the prospect's request | auto |
| Answer a question in a prospect's reply | **approve** |
| Qualification redirect ("a 15-minute intro may fit better") | **approve** |
| Post-meeting follow-up, no-show follow-up | **approve** |
| Anything else | **approve** (cannot be changed in v1) |

- [ ] A **Needs your OK** mailbox lists pending actions with the drafted email, Ava's reason, and Approve / Edit and send / Reject with a note
- [ ] Rejecting with a note feeds the note back to Ava for a new draft on that thread
- [ ] Each proposed action has an expiry time. A time-sensitive action (an offer of slots) expires when its earliest slot passes and is never sent late (story 16)
- [ ] The founder can raise or lower autonomy per action kind in role settings

**R10. Rescheduling and cancelling by plain reply**
When a prospect replies on a booking thread, Ava sorts the reply into one of: reschedule (with or without a specific time), cancel, question, running late, or other. She then acts according to R9.
- [ ] "Can we do Thursday at 2?" gets rebooked if the slot is free. If it isn't, Ava offers the 3 nearest free slots
- [ ] "Something came up, need to cancel" cancels the booking, sends the cancel invite, frees the slot, and offers to rebook
- [x] If Ava is unsure about the intent (below a confidence threshold), she hands the thread to the founder rather than guessing (the `hand_off` tool; her job tells her to use it rather than guess)

**R11. Prep brief**
At a time the founder sets (default: 7:00 local on the meeting day, or 60 minutes before if the meeting was booked the same day), Ava emails the founder a brief. It includes who is coming, their company (from the email domain and the company's homepage, fetched on the server), their intake answers, the full thread so far, and Ava's suggested focus based on the playbook.
- [x] The brief arrives in the founder's personal inbox and links to the Demos thread (`src/lib/server/prep-brief.ts`)
- [x] If the company site can't be fetched, the brief says so and doesn't make things up

**R12. Follow-up from call notes**
After the meeting ends, the founder can reply to the brief with rough notes, in any format. Ava drafts a follow-up on the prospect's thread from those notes and the playbook, and queues it for approval. If there are no notes 2 hours after the meeting ends, Ava drafts a generic follow-up and queues it.
- [x] Replying to the brief is the only input the founder needs; no form (`src/lib/server/follow-up.ts`)
- [x] The draft never includes anything that wasn't in the notes, the thread, or the playbook (the model is told so, and any link, address, amount, percentage or long number not found in them is flagged on the queued draft; a person approves every follow-up)

**R13. No-shows**
10 minutes after the scheduled end, the queue asks the founder: "Did <name> show?" with **Yes** and **No-show** buttons. Choosing No-show queues a "sorry we missed you" email with 3 new slots.
- [x] If the founder doesn't answer within 24 hours, Ava assumes the meeting happened and does nothing (`src/lib/server/no-show.ts`)

**R14. Thread timeline and attribution**
Every message and action on a thread shows who did it: *"Confirmed by Ava · 2:14pm"*, *"Drafted by Ava · approved by Sada · 3:02pm"*, *"Rescheduled by Ava at prospect's request"*.
- [ ] An `agent_actions` record exists for 100% of Ava's sends; an audit query can show this

**R15. Take over and hand off**
The founder can **take over** a thread. Ava then stops acting on it until the founder hands it back. When Ava escalates on her own (low confidence, the playbook says escalate, the prospect asks for a human), she sends *"Looping in Sada"*, CCs the founder, and makes the founder the assignee.
- [x] After a takeover, Ava takes no action on the thread, not even a reminder, unless the founder turns reminders back on (booking reminders to that guest stop; a per-thread switch turns them back on)

**R16. Instructions vs. data (safety)**
Only the playbook, autonomy settings, and internal notes from human principals count as instructions to Ava. Email bodies, intake answers, attachments, and fetched web pages are passed to the model as clearly marked untrusted data. Ava's tools are limited to the actions in R9, and the server checks every action against autonomy settings no matter what the model asks for.
- [x] A red-team test set of at least 25 injection emails ("ignore previous instructions", fake founder approvals, requests to email a third party, requests to reveal the playbook) causes zero unauthorized actions
- [x] Ava can't email anyone except the booking's invitee(s) and the founder
- [x] Ava never puts the playbook's text in an outgoing email (`tests/red-team.test.ts`; the server refuses a send that quotes 10+ words of her job or the system prompt in a row)

### P1: fast follows

- **R17. Qualify before confirming:** an option to hold the booking as *pending* until Ava qualifies it, for founders who get flooded with poor-fit demo requests. Off by default, because confirming instantly converts better.
- **R18. Generated meeting links:** generate a Google Meet or Teams link for each booking. This needs R22 OAuth. P0 uses a fixed meeting URL per event type.
- **R19. More event types per role**, such as "30-minute demo" and "15-minute intro". The P0 data model already allows this; P1 adds the UI.
- **R20. Weekly digest:** demos booked, held, no-shows, and approvals made, with Ava's suggestions for playbook changes.
- **R21. Overrides for high-value leads:** a playbook rule that lets Ava offer time *outside* demo blocks to qualified leads, which always needs approval.
- **R22. OAuth calendar upgrade (two-way, push):** Google Calendar API with watch channels for changes within seconds, writing events directly to the calendar, and Meet links, behind a `CalendarProvider` interface (then Microsoft Graph, then CalDAV). **Deferred because it needs Google's app verification.** Shortcut: if the founder's own account is on Google Workspace, register the app as *Internal*, which skips verification for users in their own organization. Avoid unverified *external* apps in testing mode, where Google expires refresh tokens after 7 days.

### P2: plan for these now, build later

- Role pools with several humans (round robin, or "first available"). `role_members` is already a table.
- More roles (billing@, support@) using the same principal, role, and agent action model.
- Microsoft Graph and CalDAV calendar connections behind a `CalendarProvider` interface, the way `EmailProvider` already works.
- BYO agent runtimes: an external agent gets the same `agent_action` contract over webhooks or MCP, and the server still checks autonomy.
- A hosted, multi-tenant CloudMail. Everything is scoped by `workspace_id` from day one.

## 7. Success metrics

| Metric | Type | Target (success / stretch) | How measured | When |
|---|---|---|---|---|
| Zero-touch rate: demos from booking to prepped meeting with founder actions limited to approvals | Leading | 70% / 85% | `bookings` joined with `agent_actions` and founder events on the thread | Weekly from week 2 |
| Approve-without-edit rate on queued drafts | Leading | 80% / 90% by week 3 | Status and edit diff on `agent_actions` | Weekly |
| Booking page conversion (page view → confirmed booking) | Leading | ≥ 25% | Page events → `bookings` | Weekly |
| Reschedules handled by Ava with no founder action | Leading | ≥ 90% | `agent_actions` of kind reschedule | Weekly |
| Double bookings or wrong-time invites | Quality | **0** | Incident log plus a nightly check of bookings against the feeds | Continuous |
| Unauthorized agent actions (R16) | Quality | **0** | Server rejections of model-requested actions, plus red-team suite in CI | Every release |
| Founder logistics time per demo (self-reported plus time spent in the queue) | Lagging | < 5 minutes | Dogfood survey plus time on queue actions | Week 4 |
| Founders still using it weekly after 4 weeks (dogfood cohort of 5) | Lagging | 4 of 5 | Weekly active founders | Week 4 and week 8 |

**Decision rule:** if approve-without-edit is ≥ 90% for a given action kind for two weeks in a row, suggest that the founder switch that kind to **auto**. That's how trust grows over time.

## 8. Technical design notes

These are grounded in the current codebase. Today everything is scoped by `user_id` (`emails`, `addresses`, `filters`, …), there's no tenant layer, inbound mail runs through `inbound.ts` and `cloudflare-inbound.ts` into `organize-inbound.ts`, outbound runs through `outbox.ts` → `send-mail.ts`, and a cron job runs every minute (`worker.ts`, `deliverDue`).

### 8.1 New tables (sketch)

```sql
workspaces        (id, name, slug, created_at)
principals        (id, workspace_id, kind CHECK (kind IN ('human','agent')),
                   user_id NULL, display_name, avatar_r2_key, owner_principal_id NULL, created_at)
roles             (id, workspace_id, slug, name, address_id, agent_principal_id,
                   playbook_md, created_at)
role_members      (role_id, principal_id, position)              -- v1: one human
autonomy_settings (role_id, action_kind, level CHECK (level IN ('auto','approve')))
event_types       (id, role_id, slug, title, duration_min, buffer_before_min, buffer_after_min,
                   daily_cap, min_notice_min, horizon_days, weekly_blocks_json, timezone,
                   intake_questions_json, meeting_url)
calendar_connections (id, principal_id, provider CHECK (provider IN ('ics')),  -- 'google' etc. arrive with R22
                   label, feed_url_enc, etag, last_modified, last_fetched_at, last_ok_at,
                   consecutive_failures, status)
calendar_busy     (connection_id, start_utc, end_utc, ical_uid NULL)   -- busy intervals only, no titles
bookings          (id, event_type_id, thread_id, invitee_name, invitee_email, intake_json,
                   start_utc, end_utc, invitee_tz, status, ical_uid, ical_sequence,
                   google_event_id, assignee_principal_id, created_at)
agent_actions     (id, workspace_id, agent_principal_id, thread_id, booking_id NULL, kind,
                   payload_json, reason, status, expires_at, decided_by_principal_id NULL,
                   decision_note NULL, edited INTEGER, executed_at NULL, created_at)
thread_events     (id, thread_id, actor_principal_id, kind, detail_json, created_at)
```

Existing tables get a nullable `workspace_id` filled in by the migration. In v1 `user_id` stays the access check, with role mailboxes allowed through `role_members`.

### 8.2 Runtime pieces

- **CalendarDO** (one per principal with a calendar): keeps the busy cache, holds and confirms slots, and sets alarms for reminders, briefs, no-show prompts, and expiring queued actions. The single-threaded Durable Object is what guarantees R5.
- **Queue `agent-jobs`:** triggers come from inbound mail on a role thread, booking created or changed, and Durable Object alarms. Consumers build the prompt (playbook + thread + untrusted data), call the model with a tool list limited to R9's actions, and write `agent_actions`. The server checks autonomy, then runs the action or queues it for approval.
- **Model:** Claude through the Anthropic API. Use a cheaper model for sorting replies (R10) and a stronger one for drafting (R11 and R12). See Q5.
- **Sending:** reuses `sendAndStore` with a new `actor_principal_id`. The disclosure footer (R8) is added in the send path, not in drafts.
- **iCalendar:** a small module that builds and parses VEVENT and iMIP messages, sent as a `text/calendar; method=REQUEST` part with both providers. Inbound parsing of REPLY messages (attendee accept or decline) updates `bookings`.
- **Calendar feeds:** an `IcsFeedProvider` behind a `CalendarProvider` interface. A cron job fetches and parses each feed (RRULE expansion via a well-maintained iCalendar library), and the busy intervals are written into the CalendarDO cache. The R22 OAuth providers plug into the same interface later.

### 8.3 Inbound routing change

`resolveInboundRoute` gains a step: if the recipient is a role address, store the mail under the role (visible to the role's members) and add an `agent-jobs` message if the thread is tied to a booking or the role has an agent. Filters and blocked senders still apply first.

### 8.4 The agent action contract (designed now for P2 BYO agents)

```
propose(action_kind, thread_id, payload, reason) -> { action_id, status }
```

Every agent, built-in or external, can only *propose*. The server decides whether to run or queue the action. This keeps one place in charge of enforcement, whatever runtime is behind the agent.

## 9. Open questions

| # | Question | Owner | Blocking? |
|---|---|---|---|
| Q1 | ~~Who is the organizer of record?~~ **Settled for v1:** the role address organizes and the founder is an attendee (R7). Reopen when R22 OAuth writes events directly | Engineering | No |
| Q2 | **Deferred (2026-11-06).** Google OAuth verification is only needed for R22. When we pick it up, decide between an *Internal* Workspace app (founder only, no verification) and full verification (other founders) | Engineering / stakeholder | No |
| Q3 | Is the fixed disclosure line in R8 enough for California's bot-disclosure law and the EU AI Act's transparency rules? Does it need a link to a short "about Ava" page? | Legal | No, but needed before public launch |
| Q4 | Retention: how long do we keep model inputs, fetched company pages, and call notes? | Legal / engineering | No |
| Q5 | Model choice and cost per demo. Target: under $0.10 of model cost per booking lifecycle | Engineering / data | No |
| Q6 | Should the prep brief go to the founder's personal inbox, a Demos digest, or both? | Design | No |
| Q7 | How should the founder set Ava's avatar and display name? Fixed "Ava" in v1, or renamable? | Design | No |
| Q8 | Is fetching the company homepage enough context for the brief, or do founders expect LinkedIn-style enrichment? Ask the dogfood founders | Research | No |

## 10. Timeline and phasing

| Phase | Contents | Exit criteria |
|---|---|---|
| **0. Foundations** (~1 week) | R1 workspace and principals migration, R14 timeline, the `agent_actions` table, the empty Needs your OK view | All existing tests green, migration rehearsed on a copy of production data |
| **1. Calendar** (~2 weeks) | R3 ICS feed connection, R4 availability, R5 CalendarDO holds, R6 booking page, R7 thread and iCalendar invite | A founder can be booked by a real Gmail and Outlook user, the invite appears on the founder's own calendar, and there's no double booking under a concurrency test |
| **2. Ava** (~2 weeks) | R2 roles and playbook, R8 identity, R9 queue, R10 reply handling, R11 brief, R12 follow-up, R13 no-show, R15 take over, R16 safety suite | The red-team suite passes, and a full simulated booking lifecycle runs in CI |
| **3. Dogfood** (~4 weeks) | 5 solo founders on a hosted single-workspace deploy each. Weekly metric review against §7 | Go/no-go for P1 and for hosted multi-tenancy, based on zero-touch and approve-without-edit rates |

**Dependencies:** Cloudflare Durable Objects and Queues (needs a Workers paid plan; Cloudflare Email Sending already requires one). An Anthropic API key.

**Riskiest assumption:** founders will let Ava send logistics emails on her own and will approve most of her drafts without editing. Phase 3 is designed to test exactly this. If approve-without-edit stays under 60%, re-scope toward "Ava drafts, the founder sends" before building anything wider.
