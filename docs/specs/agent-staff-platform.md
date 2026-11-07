# Spec: Agent Staff, the platform

| | |
|---|---|
| **Status** | Draft for review |
| **Author** | Sada Kshirsagar |
| **Date** | 2026-11-06 |
| **Scope** | General-purpose agents a solo founder sets up, runs, and grows. Demos is the first template ([demo-role-end-to-end.md](demo-role-end-to-end.md)) |

## TL;DR

A founder can **hire as many agents as they want**. Each agent is a teammate with a name, an address, a job description in plain language, a set of **triggers** (when it works), **capabilities** (what it may do, each set to *off / approve / auto*), a **scope** (what it can see and who it may email), and **memory** (facts it has learned, which the founder can edit). Every agent, built-in or template-based, uses the same small set of server-enforced actions. That lets one product cover use cases we haven't found yet.

Because we *don't* know all the use cases yet, the product's job is to **discover them**. A generalist agent, **Sam**, takes any task the founder @mentions to it. It records what it was asked, and when it sees a pattern it suggests a specialist: *"You've asked me to chase 4 unpaid invoices this month. Want a Billing agent for that?"* Demos (Ava) is the first specialist we build on purpose. The rest should come from real usage.

---

## 1. Problem statement

A solo founder does a dozen jobs that are each small, repeated, and email-shaped: scheduling, chasing invoices, sorting support, sending investor updates, filing receipts, following up with vendors. Hiring people for these is too early, and today's AI tools either act as the founder (no identity, no accountability) or are single-purpose bots that each need their own setup. Nobody, including us, knows which of these jobs a founder will actually hand off until they try. A product that hard-codes three agents will be wrong. A product that makes **hiring, scoping, trusting, and reshaping an agent cheap** can adapt as the use cases show up.

## 2. Goals

1. **Fast to first agent:** a founder goes from describing a job in one sentence to a working agent in shadow mode in under 5 minutes.
2. **Many agents, one model:** every agent, including Demos, is built only from the platform pieces in this spec (triggers, capabilities, scope, memory). No custom code per agent.
3. **Use cases come from usage:** in dogfood, at least 2 specialist agents per founder are created from Sam's suggestions, not from our template list.
4. **Trust can be measured:** for every agent and every capability we can show the approve-without-edit rate, so moving it from *approve* to *auto* is a decision based on evidence.
5. **Safe by construction:** zero actions taken outside an agent's scope or autonomy, however the model is prompted, in tests or in production.

## 3. Non-goals (v1)

| Non-goal | Why |
|---|---|
| Teams sharing agents | Solo founder first. Workspace scoping and `owner_principal_id` keep this possible later |
| A public agent marketplace | Templates are internal until real use shows which ones matter |
| Arbitrary code or tool execution by agents | Agents only get capabilities from a fixed catalog the server enforces. External webhooks and MCP tools are P1 behind the same contract |
| Agents talking to each other freely | Agents can *hand off* a thread with a note. They can't instruct each other (see A11) |
| A visual workflow builder (nodes and arrows) | Job descriptions in plain language plus triggers are enough to learn from. A builder can come later if founders need one |

## 4. Core concepts

```
Workspace
 ├─ Principals
 │   ├─ Human  (the founder; signs in)
 │   └─ Agent  (Sam, Ava, Billing, …; cannot sign in)
 ├─ Roles     (an address + optional booking pages + members [humans/agents])
 └─ Agent definition (versioned)
      identity      name, avatar, sends-as address, disclosure line
      job           plain-language job description (the "playbook")
      triggers      when it wakes up
      capabilities  what it may do, each set to off / approve / auto, with limits
      scope         which mail it sees, who it may email
      memory        facts it has learned, which the founder can edit
      budget        model tier, monthly spend cap
```

**The rule that makes this safe for many agents:** an agent can only *propose* actions. The server checks every proposal against the agent's scope, capability settings, and limits, then either runs it, queues it for the founder, or rejects it.

## 5. User stories

### Hiring and setting up
1. As a founder, I want to describe a job in a sentence ("chase clients whose invoices are 7+ days overdue, politely") and get a drafted agent I can review, so that I don't have to configure everything from scratch.
2. As a founder, I want to start from a template (Demos, Billing, Support triage, …) and edit it, so that common jobs take seconds.
3. As a founder, I want every new agent to start in **shadow mode**, so that I can see what it *would* do before it does anything.
4. As a founder, I want to edit an agent's job, triggers, or permissions and see what changed, so that I can reshape agents as I learn.

### Working with agents
5. As a founder, I want to @mention any agent in an internal note on a thread ("@billing this one's 30 days late"), so that I can delegate in the flow of reading mail.
6. As a founder, I want to forward or CC an agent's address from any mail client, so that I can delegate even outside CloudMail.
7. As a founder, I want agents to run on a schedule ("every Monday 8am, draft the investor update from last week's threads"), so that recurring jobs happen without me starting them.
8. As a founder, I want my existing filters to be able to assign mail to an agent, so that the right agent picks up the right mail automatically.
9. As a founder, I want one **Needs your OK** queue for every agent, so that I approve everything in one place.

### Trust, control, adapting
10. As a founder, I want a **Staff** page that shows each agent's job, recent actions, approval rate, and spend, so that I know who is doing what.
11. As a founder, I want to pause one agent, or all of them, instantly, so that I can stop anything that goes wrong.
12. As a founder, I want to see and edit what an agent has "learned", so that its memory never drifts from what's true.
13. As a founder, I want Sam to suggest new specialist agents based on what I keep asking it for, so that I discover what to hand off.
14. As a founder, I want an agent to suggest moving a capability from *approve* to *auto* when I've stopped editing its drafts, so that trust grows with evidence.

### Edge cases
15. As a founder, I want two agents that both match the same email to not both act on it.
16. As a founder, I want an agent that gets stuck in a loop (replying to an auto-responder, say) to stop itself.
17. As a founder, I want an external email that tries to command an agent ("@billing refund me $500") to have no effect.

## 6. Requirements

### P0: must ship

**A1. Workspace and principals**
`workspaces` and `principals` (`kind: human | agent`), as specified in the demo spec's former R1, which this replaces. Agents can't sign in and have no password.

**A2. Roles**
A role is an address plus members (humans and agents) plus optional booking pages. Mail to a role address is visible to its members. An agent can belong to several roles, and an agent can also have its own address (`sam@acme.com`).
- [ ] An address belongs to one user, one role, or one agent. Existing addresses stay user-owned

**A3. Agent definition, versioned**
An agent definition holds identity, job, triggers, capabilities, scope, memory reference, and budget. Every save creates a new version, the UI shows a diff against the previous version, and the founder can roll back to any version.
- [ ] Every agent run records the definition version it used
- [ ] The job description is plain markdown, 8,000 characters max

**A4. Hire flow ("describe the job")**
The founder writes one or two sentences. CloudMail drafts a full definition from it: name, job description, suggested triggers, capabilities with conservative autonomy, scope, and the questions it couldn't answer ("Which address should invoice reminders come from?"). The founder reviews and edits, then hires.
- [ ] The draft never sets any capability to *auto*. Every new agent starts in shadow mode (A8)
- [ ] Templates are just pre-filled drafts. There's no separate code path

**A5. Triggers**

| Trigger | Example |
|---|---|
| **Mail to an address** the agent is on (its own or a role's) | Support triage on `support@` |
| **@mention** in an internal note by a human | "@billing this one's late" |
| **CC or forward** to the agent's address from anywhere | Forward a receipt to `receipts@` |
| **Filter action** "assign to agent" (extends the existing `filters`) | From `*@stripe.com` → Billing |
| **Schedule** (cron-style, in the founder's time zone) | Mondays 8:00 investor update draft |
| **Calendar events** (booking created or changed, event starting or ending) | Demos prep brief |
| **Timers the agent set itself** ("if no reply by Friday") | Follow-up chaser |

- [ ] Each mail event runs at most once per agent (idempotent on message ID + agent + trigger)
- [ ] **One owner per thread:** if several agents' triggers match the same new thread, the most specific wins (an address the agent owns beats a filter, which beats a role membership). The others see the thread but don't act, unless they're @mentioned (story 15)

**A6. Capability catalog with autonomy and limits**
Agents can only do what's in this catalog. Each capability is set to **off / approve / auto** and can have limits.

| Capability | Default for a new agent | Notes |
|---|---|---|
| Read threads in scope, read attachments | auto | Read-only |
| Label, star, archive, snooze, mark read | approve | Reversible |
| Write an internal note for the founder | auto | Only the founder sees it |
| Draft a reply | auto | Drafting isn't sending |
| Send a reply on an existing thread | approve | Daily limit |
| Send a new email | approve | Recipients must be in scope; daily limit |
| Set a follow-up timer | auto | Max 30 days out |
| Offer slots, book, reschedule, cancel (calendar) | approve | Demos template turns some of these to auto |
| Hand off to another agent or the founder | auto | See A11 |
| Fetch a public web page | auto | Server-side, size-capped, no auth headers |
| Propose a memory entry | approve | See A9 |

- [ ] The server enforces autonomy and limits on every proposal. The model can't override them
- [ ] Limits supported in v1: sends per day, recipients per day, and maximum value in a field (for example, discount ≤ 10%, defined in the job and checked when it can be)

**A7. Needs your OK queue (shared by all agents)**
All agents' *approve*-level proposals go into one queue, grouped by agent, with the draft, the reason, the trigger that started it, and Approve / Edit and send / Reject with a note. Proposals expire when they're no longer relevant.
- [ ] Rejecting with a note sends the note back to the agent as feedback for that thread
- [ ] Each agent's approve-without-edit rate is tracked per capability (it feeds A14 and the metrics)

**A8. Shadow mode**
A new or significantly changed agent starts in shadow mode for its first 20 proposals, or until the founder ends it. In shadow mode it proposes, but **nothing runs, not even auto actions**. The founder sees "would have done…" cards and can mark each one 👍 or 👎.
- [ ] Changing the job description or adding a capability offers to re-enter shadow mode

**A9. Agent memory**
Each agent has a short list of facts the founder can see and edit ("Acme's net terms are 30 days", "Never offer discounts to existing customers"). Agents propose additions (approve by default). The founder can add facts by hand or by telling the agent in a note ("@billing remember: Globex pays on the 15th").
- [ ] Memory is shown in full on the agent's page. Nothing hidden affects behavior

**A10. Staff page and kill switches**
One card per agent: name, avatar, one-line job, triggers, last 10 actions, approval rate, spend this month, status (shadow / active / paused). A **Pause** button per agent, and a global **Pause all agents**.
- [ ] Pausing takes effect for proposals in flight. Queued actions stay queued and nothing new runs
- [ ] Reaching the monthly spend cap pauses the agent and emails the founder

**A11. Instructions vs. data (safety for many agents)**
- Only **humans** give instructions: through job descriptions, memory entries they approved, and internal notes and @mentions they wrote.
- Everything else is **data**: email bodies, attachments, web pages, and **handoff notes from other agents**. Agents can't give each other authority. This stops an external email from being laundered through agent A into an instruction for agent B.
- Recipients are limited to the agent's scope: by default, only people already on the thread plus the founder. The job can widen this to known contacts or listed domains.
- [ ] A red-team suite of at least 40 cases (including injection relayed through another agent and fake founder approvals) causes zero unauthorized actions

**A12. Attribution and timeline**
Every message and action on every thread shows who did it and why: *"Labeled 'Overdue' by Billing (filter: from stripe.com) · approved by Sada"*. Every agent-sent email has a fixed disclosure footer naming the agent as an AI assistant (the demo spec's R8, generalized).

**A13. Take over and hand off**
The founder can take over any thread, and agents then stop acting on it. An agent can hand off to the founder ("Looping in Sada", CC) or to another agent (internal handoff with a note, which A11 treats as data).
- [ ] Hand-offs between agents are limited to 3 per thread per day, after which the thread goes to the founder (story 16)

**A14. Loop and runaway protection**
An agent stops and alerts the founder when it detects an auto-responder (`Auto-Submitted` or `X-Autoreply` headers, or a vacation-reply pattern), more than N sends to one recipient in 24 hours, or a thread with more than 6 agent messages and no human reply.

**A15. Sam, the generalist agent (the discovery engine)**
Every workspace starts with Sam: own address `sam@`, triggered only by @mentions, CC, or forwards. He has every capability set to *approve* and a job description that boils down to "help the founder with what they ask, and ask when unsure." Sam records each delegation as a short description of what was asked ("chase overdue invoice", "find a time with investor").
- [ ] Weekly, Sam sends a "what I did" email. When the same kind of task shows up 3+ times in 30 days, he suggests a specialist, with a pre-drafted definition from A4 that the founder can hire with one click
- [ ] When a specialist is hired, Sam's matching tasks are routed to it from then on, and Sam says so in the thread

### P1: fast follows

- **A16. Replay on past mail:** before turning an agent on, run its definition against the last N matching threads and show what it would have done. This is a stronger version of shadow mode that gives an answer straight away.
- **A17. External tools:** a webhook or MCP tool as a capability (for example "look up customer in Stripe"), with the same autonomy and limits, and an audit of the request and response.
- **External agents** (Claude agents, Grok, Muse, custom) joining as staff through MCP, A2A, REST, or email are specified in [external-agents.md](external-agents.md).
- **A18. Autonomy suggestions:** when a capability has a ≥ 90% approve-without-edit rate over 20+ proposals, suggest switching it to *auto*.
- **A19. Agent-to-founder digests on a schedule** for any agent ("Billing: 3 chased, 1 paid, 1 needs you").
- **A20. Starter templates** (each is just a pre-filled definition, and each is a hypothesis to test):

| Template | Job, in a line | Main triggers |
|---|---|---|
| **Demos (Ava)** | Book, prep, and follow up on demos | Role address, calendar |
| **Billing** | Chase overdue invoices politely, record promises to pay | Filter (Stripe, invoices), timers |
| **Support triage** | Label, answer FAQs from memory, escalate the rest | `support@` |
| **Investor update** | Draft the monthly update from threads and notes | Schedule |
| **Receipts** | File receipts and invoices, monthly summary | Forward to `receipts@`, filter |
| **Follow-up chaser** | Nudge anyone who hasn't replied by a date you set | @mention + timer |
| **Inbox triage** | Sort newsletters and notifications, send a daily digest | Mail to personal address, schedule |

### P2: plan for these now, build later
- Teams: share agents across humans, with memory per human vs. per workspace (decide before teams ship).
- Agents bringing their own runtime, using the `propose()` contract over webhooks or MCP. Now specified in [external-agents.md](external-agents.md) (its MCP part is P0 there).
- Agents with their own calendars and working hours.
- Hosted multi-tenant signup and billing (spend caps already exist per agent).

## 7. Success metrics

| Metric | Type | Target (success / stretch) | When |
|---|---|---|---|
| Time from describing a job to an agent in shadow mode | Leading | < 5 min / < 2 min | Per hire |
| Agents active per founder after 4 weeks | Leading | ≥ 3 / ≥ 5 | Week 4 |
| Specialists created from Sam's suggestions | Leading | ≥ 2 per founder | Week 4 |
| Approve-without-edit rate, per agent per capability | Leading | ≥ 80% by week 3 | Weekly |
| Share of capabilities moved to *auto* by founders | Lagging | ≥ 30% of eligible ones | Week 8 |
| Founder hours saved per week (self-reported, checked against queue time) | Lagging | ≥ 4 hours | Week 4 and week 8 |
| Unauthorized or out-of-scope actions | Quality | **0** | Continuous, plus the CI red-team suite |
| Runaway incidents (loops, mass sends) | Quality | **0** reaching an external recipient | Continuous |
| Model cost per founder per month | Business | < $15 | Monthly |

## 8. Technical design notes

Builds on the current code: `user_id`-scoped tables, inbound mail through `inbound.ts` / `cloudflare-inbound.ts` → `organize-inbound.ts` (filters), outbound through `outbox.ts` → `send-mail.ts`, and the cron job that runs every minute in `worker.ts`.

### 8.1 Tables (adds to the demo spec's sketch)

```sql
agents              (principal_id PK, workspace_id, status CHECK (status IN ('shadow','active','paused')),
                     current_version_id, shadow_remaining, monthly_budget_cents)
agent_versions      (id, agent_principal_id, version, definition_json, created_by_principal_id, created_at)
agent_triggers      (id, agent_principal_id, kind, config_json, enabled)   -- derived from the definition, indexed for routing
agent_memory        (id, agent_principal_id, fact, source CHECK (source IN ('founder','agent')),
                     status CHECK (status IN ('proposed','active','removed')), created_at)
agent_runs          (id, agent_principal_id, version_id, trigger_kind, trigger_ref, thread_id NULL,
                     model, input_tokens, output_tokens, cost_micros, outcome, created_at)
agent_timers        (id, agent_principal_id, thread_id, fire_at, reason, status)
delegation_intents  (id, agent_principal_id, thread_id, intent_label, created_at)   -- Sam's task log (A15)
-- agent_actions, thread_events, roles, role_members: as in the demo spec; agent_actions gains run_id
```

### 8.2 How a run works

```
trigger (mail / mention / filter / cron / calendar / timer)
  → router: pick the owning agent (A5 priority), dedupe
  → Queue "agent-jobs"
  → consumer: load the agent version + memory + thread (untrusted data wrapped and labeled)
  → model call with tools = the agent's enabled capabilities only
  → each tool call = propose()  → policy check (scope, autonomy, limits, shadow, paused)
       → execute | queue for approval | reject (logged)
  → record agent_run (tokens, cost) and update budget
```

- **Router:** runs inside `organizeInbound` after filters, so the filter action "assign to agent" and address ownership are resolved in one place.
- **Scheduling:** schedules and timers are kept in a Durable Object per workspace using alarms. The every-minute cron is the fallback.
- **Policy engine:** one pure function `authorize(agent, version, proposal, state) → execute | queue | reject`, with full unit-test coverage. This is the most important code in the system.
- **Model:** Claude through the Anthropic API. A cheaper model for routing and sorting, a stronger one for drafting. The model is set per agent in its budget.

### 8.3 The contract every agent uses (built-in now, external later)

```
propose(capability, thread_id?, payload, reason) -> { action_id, decision: executed | queued | rejected }
```

## 9. Open questions

| # | Question | Owner | Blocking? |
|---|---|---|---|
| Q1 | How should Sam label delegations: free text clustered by the model, or a fixed list that grows? Clustering finds new use cases but is noisier | Engineering / data | Yes, before A15 |
| Q2 | Should memory be per agent only, or include a shared workspace "company facts" list all agents can read (pricing, terms, tone)? Leaning: both, with company facts edited only by humans | Product | Yes, before A9 |
| Q3 | When a definition changes, should in-flight timers and queued proposals use the old version or the new one? Leaning: queued keeps the old version, timers use the new one | Engineering | No |
| Q4 | Does a fixed disclosure footer suit every agent? Receipts and inbox triage never email outsiders | Legal / design | No |
| Q5 | Spend caps: hard pause, or a degraded mode with a cheaper model? | Product | No |

## 10. Phasing

| Phase | Contents | Why this order |
|---|---|---|
| **0. Foundations** (~1.5 weeks) | A1–A3, A6 policy engine, A7 queue, A10 Staff page and kill switches, A11–A14 | Everything else depends on these, and safety goes first |
| **1. Sam** (~1.5 weeks) | A5 mail, mention, CC, and filter triggers; A8 shadow mode; A9 memory; A15 Sam | **The founder (you) can start using it on day one for anything**, and Sam starts collecting real use cases |
| **2. Hire flow and schedules** (~1 week) | A4 describe-the-job, schedule triggers and timers | Turns Sam's suggestions into one-click specialists |
| **3. Calendar and Demos** (~3 weeks) | The demo spec's calendar work (R3–R7, R10–R13) plus the Demos template | The first specialist we build on purpose, and the one that needs calendar |
| **4. Dogfood and adapt** (ongoing) | Use it ourselves plus 5 founders. Weekly review of Sam's task log and metrics. Ship templates that show up in real usage, cut the ones that don't | The roadmap after this comes from usage, not from this list |

**Riskiest assumption:** founders will delegate *new kinds* of work to a generalist agent often enough for patterns to show up. If Sam gets fewer than ~5 delegations a week per founder, the discovery engine stalls. Then we lean harder on templates and the Demos wedge.
