import { describe, it, expect } from 'vitest'
import { looksLikeProviderNotice } from './providerNotice'

// Fixtures 1 and 2 are VERBATIM bodies measured in
// ~/Library/Application Support/flow_job/logs/fit.log + fit.log.1 — 337 of
// the 353 `non-parseable` log lines carried one of them. The truncation
// at ~160 chars is the logger's own 240-char snippet slice; the real body
// continued past it.
const POLLINATIONS_TOPUP_QUEST =
  "The account behind this API key doesn't have enough credits. Please [top up](https://enter.pollinations.ai/top-up?ref=agent_low_balance_topup) or [complete a quest](https://enter.pollinations.ai/quests?ref=agent_low_balance_quests), then tr"

const POLLINATIONS_PAID_POLLEN =
  "The account behind this API key doesn't have enough credits. This model needs paid Pollen. Please [top up](https://enter.pollinations.ai/top-up?ref=agent_low_balance_topup), then try again. If this isn’t your Pollinations account, contact w"

describe('looksLikeProviderNotice — measured positives', () => {
  it('recognises the verbatim fit.log "top up / complete a quest" body', () => {
    expect(looksLikeProviderNotice(POLLINATIONS_TOPUP_QUEST)).toBe(true)
  })

  it('recognises the verbatim fit.log "This model needs paid Pollen" body', () => {
    expect(looksLikeProviderNotice(POLLINATIONS_PAID_POLLEN)).toBe(true)
  })

  it('recognises the two short forms quoted in the assessment', () => {
    // The brief quotes these as the two observed shapes in isolation.
    expect(
      looksLikeProviderNotice(
        "The account behind this API key doesn't have enough credits. Please top up (https://enter.pollinations.ai/top-up?ref=agent_low_balance_topup) or complete a quest"
      )
    ).toBe(true)
    expect(looksLikeProviderNotice('This model needs paid Pollen.')).toBe(true)
  })

  it('recognises the 402 bodies from ai.log as an HTML/text alternative', () => {
    // These come back on the non-2xx path today, but the same wording
    // arriving in a 200 body must classify identically.
    expect(
      looksLikeProviderNotice(
        'This request requires more credits, or fewer max_tokens. You requested up to 2048 tokens, but the available balance is only enough for 512.'
      )
    ).toBe(true)
    expect(looksLikeProviderNotice('Insufficient Balance')).toBe(true)
  })

  it('recognises a checkout-URL + billing-vocabulary notice with no decisive phrase', () => {
    // Tier 2 path: no "not enough credits", just common English plus a
    // provider's own checkout endpoint.
    expect(
      looksLikeProviderNotice(
        'Your subscription has run out. Please top up here: https://billing.example.com/checkout — ' +
          'credits are required to continue using this quota.'
      )
    ).toBe(true)
  })

  it('recognises a notice whose balance sentence is too weak alone but is second-person', () => {
    expect(
      looksLikeProviderNotice(
        'Your account balance is low. Add credits to continue — billing is suspended until you top up.'
      )
    ).toBe(true)
  })

  it('recognises an HTML error page served with a 200', () => {
    const html =
      '<!DOCTYPE html><html><head><title>402 Payment Required</title></head>' +
      '<body><h1>Payment required</h1><p>Your balance is too low. ' +
      '<a href="https://billing.example.com/checkout">Add credits</a></p></body></html>'
    expect(looksLikeProviderNotice(html)).toBe(true)
  })
})

describe('looksLikeProviderNotice — adversarial negatives', () => {
  // These are the cases that matter. A false positive discards a
  // legitimate model answer, which is worse than the status quo.

  it('does NOT flag a financial-analyst CV bullet that mentions billing and credit', () => {
    const cv =
      'Jane Doe\n1 Main St • Cambridge, MA • jane@example.com\n\n' +
      'Experience\nAcme Capital\tBoston, MA\n' +
      'Senior Financial Analyst\tJun 2022 – Present\n' +
      '- Rebuilt the monthly billing reconciliation, cutting close time 4 days.\n' +
      '- Owned credit exposure reporting on a $2.4B loan book.\n' +
      '- Partnered with Treasury on interest-rate hedging strategy.'
    expect(looksLikeProviderNotice(cv)).toBe(false)
  })

  it('does NOT flag a credit-risk job posting', () => {
    const posting =
      'Credit Risk Analyst\nCompany: Northbank\n\n' +
      'About the role\nYou will monitor counterparty credit risk across a ' +
      '$30B corporate portfolio, own the limit-setting model, and report ' +
      'exceptions to the CRO.\n\nRequirements\n3+ years in credit risk, ' +
      'IFRS 9, advanced SQL. Bonus: Python, quota attainment history.'
    expect(looksLikeProviderNotice(posting)).toBe(false)
  })

  it('does NOT flag a cover letter that discusses billing systems', () => {
    const letter =
      'Dear Hiring Manager,\n\nI am writing to apply for the Payments ' +
      'Platform Engineer role. In my current role I rebuilt our billing ' +
      'service, cutting failed-charge retries by 38% and reducing ' +
      'chargebacks. I would welcome the chance to bring that experience ' +
      'to your team.\n\nBest regards,\nSam Patel'
    expect(looksLikeProviderNotice(letter)).toBe(false)
  })

  it('does NOT flag a real CV review JSON whose feedback mentions billing', () => {
    const review =
      '{"score": 92, "passed": true, "feedback": "The candidate has deep ' +
      'billing and credit-risk experience that maps onto the role."}'
    expect(looksLikeProviderNotice(review)).toBe(false)
  })

  it('does NOT flag a genuine CV answer just because it is long and CV-shaped', () => {
    const cv =
      'Jane Doe\nCambridge, MA • jane@example.com\n\nEducation\n' +
      'Harvard University\tCambridge, MA\tMay 2024\n\nExperience\n' +
      'Acme Corp\tBoston, MA\nSoftware Engineer\tJun 2024 – Present\n' +
      '- Led a data pipeline migration\n- Cut p99 latency 40%'
    expect(looksLikeProviderNotice(cv)).toBe(false)
  })

  it('does NOT flag a job description quoted back with credit/quota words', () => {
    const text =
      'The Credit Risk Analyst will carry a revenue quota of $400k in ' +
      'new logo ARR, own billing escalations for the enterprise segment, ' +
      'and manage renewals for 22 accounts.'
    expect(looksLikeProviderNotice(text)).toBe(false)
  })

  it('does NOT flag empty, whitespace, or non-string input', () => {
    expect(looksLikeProviderNotice('')).toBe(false)
    expect(looksLikeProviderNotice('   \n\t ')).toBe(false)
    expect(looksLikeProviderNotice(undefined as unknown as string)).toBe(false)
    expect(looksLikeProviderNotice(null as unknown as string)).toBe(false)
  })

  it('does NOT flag a real deliberation/parse failure body (the plan says keep those as validation failures)', () => {
    expect(
      looksLikeProviderNotice(
        "Here's a thinking process: 1. **Analyze the Request:** - **Role:** Staff Data Engineer - **Company:** Jane"
      )
    ).toBe(false)
    expect(
      looksLikeProviderNotice('[0.0:] The resume has been received. [2.4:] Parsing for relevance and fit.')
    ).toBe(false)
  })

  it('does NOT flag a normal answer that merely contains the word "account"', () => {
    expect(
      looksLikeProviderNotice(
        'I would grow your accounts. Here is a 90-day plan covering onboarding, ' +
          'activation, expansion and churn for a mid-market segment.'
      )
    ).toBe(false)
  })

  it('does NOT flag a generic provider error that is not about billing', () => {
    // A 5xx-shaped body must not be mistaken for a payment problem —
    // that would circuit-break a model for an hour over a transient blip.
    expect(
      looksLikeProviderNotice('The server had an error processing your request. Please try again.')
    ).toBe(false)
  })

  it('does NOT flag a finance answer that merely OPENS with a billing-ish heading', () => {
    // Regression guard for the account-prose tier. It must require the
    // second person — a bare `Account:` / `Balance:` / `Key risks:`
    // heading is ordinary finance prose, not a provider talking to the
    // caller. Each of these carries three supporting phrases (payment
    // required, billing, credits) and still must not match.
    expect(
      looksLikeProviderNotice(
        'Account: the credit facility carries a payment required covenant; billing is handled by Treasury. Credits are tracked quarterly.'
      )
    ).toBe(false)
    expect(
      looksLikeProviderNotice(
        'Balance: the portfolio billing run rate is steady. Payment required terms apply. Credits outstanding are unchanged.'
      )
    ).toBe(false)
    expect(
      looksLikeProviderNotice(
        'Key risks: billing disputes and credit spread widening. Payment required capital is held at the parent. Credits are fungible.'
      )
    ).toBe(false)
    expect(
      looksLikeProviderNotice(
        'Subscription: our SaaS billing tier covers this. Payment required for add-ons. Credits roll monthly.'
      )
    ).toBe(false)
  })

  it('does NOT flag a CV answer with a preamble before its JSON', () => {
    // A model that narrates ("Sure! Here is the review:") puts the JSON
    // after the head window, so the JSON short-circuit cannot see it.
    // The phrase rules must still leave it alone.
    expect(
      looksLikeProviderNotice(
        'Sure! Here is the review:\n{"score": 88, "passed": true, "feedback": ' +
          '"Strong billing and credit-risk background, payment required domain knowledge."}'
      )
    ).toBe(false)
  })

  it('does NOT flag a repository URL that merely contains a billing word', () => {
    // CHECKOUT_URL_RE requires the billing word to be a PATH SEGMENT that
    // is a billing action. A portfolio link is not a checkout page.
    expect(
      looksLikeProviderNotice(
        'I rewrote the billing sync service: https://github.com/jane/billing-service. ' +
          'It handles credits, invoices and payment retries across 40k subscriptions.'
      )
    ).toBe(false)
  })
})
