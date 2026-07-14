import { getSettings, listApiModels, getDocument, updateDocument, updateDocumentVerification, listApplications, updateApplication } from './database'
import type { ApiModelConfig, FitBreakdown, Job, TailorRequest, TailorResult, VerificationResult } from './types'
import { createDocument, getJob } from './database'
import { readFileSync } from 'fs'
import { join } from 'path'
import { app } from 'electron'
import mammoth from 'mammoth'
import { scoreCompatibility, extractEducationLevel, extractYearsExperience } from './fitHeuristic'

export class RateLimitError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RateLimitError'
  }
}

let cachedTemplate: string | null = null

async function loadHarvardTemplate(): Promise<string> {
  if (cachedTemplate !== null) return cachedTemplate
  try {
    const path = join(app.getAppPath(), '2025-template_bullet.docx')
    const buf = readFileSync(path)
    const result = await mammoth.extractRawText({ buffer: new Uint8Array(buf) })
    cachedTemplate = result.value.trim()
  } catch (err) {
    console.error('[ai] Failed to load Harvard template:', err)
    cachedTemplate = ''
  }
  return cachedTemplate
}

function buildHarvardCvInstructions(template: string): string {
  return `You are an expert career coach. Tailor the candidate's CV for the specific job posting using the EXACT Harvard format demonstrated by the template below. The template is the source of truth — preserve its structure, section order, spacing, capitalization, and TAB-based alignment exactly as shown.

=== HARVARD CV TEMPLATE (source of truth) ===
${template}
=== END TEMPLATE ===

SECTIONS IN ORDER (do not add, remove, or rename any section):
1. Name (centered, on its own line)
2. Contact line: address • city, state zip • email • phone (centered, bullets between fields)
3. Education — School Name (TAB) Location, Degree, Concentration, GPA (TAB) Graduation Date, Thesis
   Then: Relevant Coursework, Study Abroad, High School (same TAB-aligned format)
4. Experience — Organization (TAB) City, State, then Position Title (TAB) Month Year – Month Year
   Then: bullet points describing the role (no personal pronouns, action-verb-led, quantified)
5. Leadership & Activities — same format as Experience
6. Skills & Interests — Technical: / Language: / Laboratory: / Interests: (label: comma-separated values, no bullets)

FORMATTING RULES (must follow exactly):
- Section headers on their own line, centered, bold
- Use a LITERAL TAB CHARACTER (\\t, ASCII 0x09 — NOT spaces, NOT em-dashes, NOT pipes) between the bold left text (school/org/title) and the right-aligned location/dates. Do not use multiple spaces or "—" as separators.
- Each experience entry is EXACTLY two lines, in this order:
    Line 1: <Organization>\\t<City, State>
    Line 2: <Position Title>\\t<Month Year – Month Year>
  Followed by bullet points describing the role.
- Each bullet point on its own line, starting with an action verb
- Write experience bullet points in the XYZ format: "Accomplished [X] as measured by [Y], by doing [Z]."
- Do NOT use asterisks or markdown formatting
- Do NOT use personal pronouns
- Quantify wherever possible
- Output plain text only

CRITICAL — TRUTHFULNESS (this overrides everything else):
- Use ONLY experience, skills, education, and projects that appear in the candidate's Base CV / Background below.
- Do NOT invent or fabricate any experience, employers, job titles, projects, technologies, degrees, courses, GPA, awards, dates, or numbers that are not in the Base CV.
- Do NOT hallucinate metrics ("increased revenue by 40%") unless that specific number is in the Base CV. If the Base CV has no metric, use a non-numeric but truthful phrasing (e.g. "Improved onboarding workflow for new hires").
- Do NOT add skills, tools, languages, or technologies the candidate did not list.
- You MAY reword, reframe, reorder, and tighten existing experience to highlight what is most relevant to the target job. The candidate's actual accomplishments stay — they just sound as strong and as role-aligned as possible.
- If the Base CV is sparse, the output should be sparse. Do not pad with generic filler.`
}

interface CallAIResult {
  content: string | null
  modelUsed: string | null
  rateLimited: boolean
  errors: string[]
}

/**
 * Try all configured AI models.
 * - Returns content + modelUsed on first success.
 * - If all fail and at least one returned 429, throws RateLimitError.
 * - If all fail for other reasons, throws Error with collected error messages.
 */
async function callAI(
  systemPrompt: string,
  userPrompt: string,
  temperature = 0.7,
  timeoutMs = 20000
): Promise<CallAIResult> {
  const models: ApiModelConfig[] = listApiModels().filter((m) => m.enabled !== false)
  if (models.length === 0) throw new Error('No enabled AI models configured. Add one in Settings.')

  let content: string | null = null
  let modelUsed: string | null = null
  let rateLimited = false
  const errors: string[] = []

  for (const model of models) {
    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' }
      if (model.api_key) headers['Authorization'] = `Bearer ${model.api_key}`
      const abort = new AbortController()
      const timer = setTimeout(() => abort.abort(), timeoutMs)
      const response = await fetch(`${model.base_url}/chat/completions`, {
        method: 'POST',
        headers,
        signal: abort.signal,
        body: JSON.stringify({
          model: model.model,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt }
          ],
          temperature
        })
      })
      clearTimeout(timer)
      if (response.ok) {
        const data = (await response.json()) as { choices: { message: { content: string } }[] }
        content = data.choices[0]?.message?.content ?? null
        if (content) {
          modelUsed = model.name || model.model
          break
        }
        errors.push(`${model.name}: empty response`)
      } else if (response.status === 429) {
        rateLimited = true
        errors.push(`${model.name}: rate limited (429)`)
      } else if (response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 425) {
        // Persistent client error — auth, payment required, not found, etc.
        // These won't fix themselves on retry, so record the failure with
        // a short, labeled reason and continue to the next model instead of
        // wasting the rest of the rotation on a known-bad config.
        const label = response.status === 401 ? 'unauthorized (401)'
          : response.status === 402 ? 'payment required (402)'
          : response.status === 403 ? 'forbidden (403)'
          : response.status === 404 ? 'not found (404)'
          : `HTTP ${response.status}`
        const errText = await response.text().catch(() => '')
        // Truncate + collapse whitespace so a chatty error page doesn't
        // blow up the toast with megabytes of HTML.
        const trimmed = errText.replace(/\s+/g, ' ').trim().slice(0, 200)
        errors.push(trimmed ? `${model.name}: ${label} — ${trimmed}` : `${model.name}: ${label}`)
      } else {
        // 5xx, 408 (request timeout), 425 (too early) — transient, worth
        // continuing to the next model.
        errors.push(`${model.name}: HTTP ${response.status}`)
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unknown error'
      errors.push(`${model.name}: ${msg.includes('aborted') ? 'timeout' : msg}`)
    }
  }

  if (!content && rateLimited) {
    throw new RateLimitError(`All AI models failed (rate limited):\n${errors.join('\n')}`)
  }
  if (!content) {
    throw new Error(`All AI models failed:\n${errors.join('\n')}`)
  }

  return { content, modelUsed, rateLimited: false, errors: [] }
}

export async function tailorDocument(request: TailorRequest): Promise<TailorResult> {
  const settings = getSettings()
  const job = getJob(request.job_id)
  if (!job) throw new Error('Job not found')

  const baseContent =
    request.base_content ||
    settings.base_cv ||
    'No base CV provided. Add your base CV in Settings.'

  const systemPrompt =
    request.document_type === 'cv'
      ? buildHarvardCvInstructions(await loadHarvardTemplate())
      : `You are an expert career coach. Write a compelling, personalized cover letter for this job.
Keep it concise (3-4 paragraphs), professional, and specific to the role. Output plain text only.

CRITICAL — TRUTHFULNESS: reference ONLY the candidate's actual experience, skills, and projects from the Base CV / Background below. Do NOT fabricate employers, job titles, technologies, achievements, or metrics. You may reword and reframe the candidate's real experience to align with the role, but you must not invent anything that is not in the Base CV.`

  const userPrompt = `Job Title: ${job.title}
Company: ${job.company}
Location: ${job.location ?? 'Not specified'}

Job Description:
${job.description ?? 'No description provided.'}

Candidate Name: ${settings.user_name || 'Candidate'}
Candidate Email: ${settings.user_email || ''}

Base CV / Background:
${baseContent}

${request.document_type === 'cover_letter' ? 'Write a tailored cover letter.' : 'Tailor this CV for the role.'}`

  let content: string
  let modelUsed: string | null = null
  try {
    const result = await callAI(systemPrompt, userPrompt, 0.7)
    content = result.content!
    modelUsed = result.modelUsed
  } catch (err) {
    if (err instanceof RateLimitError) throw err
    // Non-rate-limit failure: fall back to base CV / template
    content = generateFallbackDocument(job, request.document_type, baseContent, settings)
  }

  const doc = createDocument(
    request.document_type,
    `${request.document_type === 'cv' ? 'CV' : 'Cover Letter'} — ${job.company}`,
    content,
    job.id,
    false,
    modelUsed || undefined
  )

  return { content, document_id: doc.id }
}

function generateFallbackDocument(
  job: Job,
  type: 'cv' | 'cover_letter',
  baseCv: string,
  settings: { user_name: string; user_email: string }
): string {
  if (type === 'cover_letter') {
    return `Dear Hiring Manager,

I am writing to express my strong interest in the ${job.title} position at ${job.company}.

Based on my background and the requirements outlined in your posting, I believe I would be a strong fit for this role. My experience aligns well with what you're looking for, and I'm excited about the opportunity to contribute to your team.

${job.description ? `I was particularly drawn to this role because of: ${job.description.slice(0, 200)}...` : ''}

I would welcome the opportunity to discuss how my skills and experience can benefit ${job.company}. Thank you for considering my application.

Best regards,
${settings.user_name || 'Your Name'}
${settings.user_email || ''}`
  }

  return baseCv
}

export async function generateFollowUpMessage(
  company: string,
  jobTitle: string,
  daysSinceApplied: number
): Promise<string> {
  const settings = getSettings()

  if (!settings.openai_api_key) {
    return `Hi,

I wanted to follow up on my application for the ${jobTitle} position at ${company}, which I submitted ${daysSinceApplied} days ago. I remain very interested in this opportunity and would appreciate any update on the hiring process.

Thank you for your time.

Best regards,
${settings.user_name || 'Your Name'}`
  }

  const response = await fetch(`${settings.openai_base_url}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${settings.openai_api_key}`
    },
    body: JSON.stringify({
      model: settings.openai_model,
      messages: [
        {
          role: 'system',
          content:
            'Write a brief, professional follow-up email for a job application. Plain text only, no subject line.'
        },
        {
          role: 'user',
          content: `Company: ${company}\nRole: ${jobTitle}\nDays since applied: ${daysSinceApplied}\nCandidate: ${settings.user_name}`
        }
      ],
      temperature: 0.7
    })
  })

  if (!response.ok) {
    throw new Error(`AI request failed: ${response.status}`)
  }

  const data = (await response.json()) as {
    choices: { message: { content: string } }[]
  }
  return data.choices[0]?.message?.content ?? ''
}

const SECTION_HEADERS = new Set([
  'professional summary', 'summary', 'profile',
  'core competencies', 'competencies', 'skills', 'qualifications', 'technical skills',
  'professional experience', 'experience', 'work history', 'work experience',
  'education',
  'certifications', 'languages', 'interests', 'skills & interests', 'skills and interests',
  'projects', 'project experience',
  'leadership & activities', 'leadership and activities', 'activities', 'leadership',
  'publications', 'honors & awards', 'honors and awards', 'awards',
  'additional information', 'additional'
])

function isSectionHeader(line: string): string | null {
  const cleaned = line.toLowerCase().trim().replace(/[*_]/g, '')
  if (SECTION_HEADERS.has(cleaned)) return cleaned
  if (/^[a-z\s&]+$/.test(cleaned)) {
    const stripped = cleaned.replace(/[^a-z\s&]/g, '').trim()
    if (SECTION_HEADERS.has(stripped)) return stripped
  }
  return null
}

const NO_REGENERATE = new Set(['education'])
const NO_BULLET_SECTIONS = new Set(['skills & interests', 'skills and interests', 'skills', 'interests', 'certifications', 'languages', 'additional information', 'additional'])

interface Section {
  header: string
  name: string
  bodyLines: string[]
  startIdx: number
  endIdx: number
}

function parseSections(content: string): Section[] {
  const lines = content.split('\n')
  const sections: Section[] = []
  let currentHeader: string | null = null
  let currentName: string | null = null
  let currentStart = 0

  for (let i = 0; i < lines.length; i++) {
    const name = isSectionHeader(lines[i])
    if (name) {
      if (currentName !== null) {
        sections.push({
          header: lines[currentStart],
          name: currentName,
          bodyLines: lines.slice(currentStart + 1, i),
          startIdx: currentStart,
          endIdx: i
        })
      }
      currentHeader = lines[i]
      currentName = name
      currentStart = i
    }
  }

  if (currentName !== null) {
    sections.push({
      header: lines[currentStart],
      name: currentName,
      bodyLines: lines.slice(currentStart + 1),
      startIdx: currentStart,
      endIdx: lines.length
    })
  }

  return sections
}

export async function verifyDocumentContent(
  jobId: number,
  documentId: number,
  docType: 'cv' | 'cover_letter'
): Promise<VerificationResult> {
  const job = getJob(jobId)
  if (!job) throw new Error('Job not found')
  const doc = getDocument(documentId)
  if (!doc) {
    // Document was deleted (or never existed) — return a SKIP rather than a
    // fake 100/100. Callers must treat this as "no review happened": they
    // MUST NOT persist a verification_score and MUST NOT trigger a regenerate
    // loop. We do still want to clean up the stale application pointer so
    // the next load() doesn't see a dangling reference.
    const apps = listApplications().filter((a) => a.job_id === jobId)
    for (const a of apps) {
      const update: Partial<typeof a> = {}
      if (docType === 'cv' && a.cv_document_id === documentId) update.cv_document_id = null
      if (docType === 'cover_letter' && a.cover_letter_document_id === documentId) update.cover_letter_document_id = null
      if (Object.keys(update).length > 0) updateApplication(a.id, update)
    }
    return { kind: 'skip', reason: 'deleted', feedback: 'Document was deleted; skipping verification.' }
  }

  const systemPrompt = `You are a strict career-document reviewer. Evaluate the ${docType === 'cv' ? 'CV/resume' : 'cover letter'} against the target job posting.

Rate the document 0-100 on these criteria:
- Relevance: Does the content directly address the job requirements?
- Keywords: Are key terms from the job description present?
- Specificity: Is it tailored to this specific role (not generic)?
- Formatting: Is the structure clean and professional?
- Accuracy: Are there any hallucinations or claims not supported by the base CV?

Output ONLY a JSON object with no markdown:
{"score": <0-100>, "passed": <true if score >= 70>, "feedback": "<2-3 sentence critique listing specific issues and the most important improvement>"}`

  const userPrompt = `Job Title: ${job.title}
Company: ${job.company}

Job Description:
${job.description || 'No description provided.'}

${docType === 'cv' ? 'CV' : 'Cover Letter'} Content:
${doc.content}

Evaluate how well this document is tailored for this specific job.`

  let rawResponse = ''
  try {
    const aiResult = await callAI(systemPrompt, userPrompt, 0.3)
    if (aiResult.content) {
      rawResponse = aiResult.content
      // Defensive: locate the first JSON object in the response, in case the
      // model wraps it in prose or stray markdown. Don't blindly `JSON.parse`
      // the whole string — that's what let malformed responses silently
      // overwrite a previously-passing score with 0.
      const match = rawResponse.match(/\{[\s\S]*\}/)
      if (!match) {
        return { kind: 'skip', reason: 'parse_failed', feedback: 'Reviewer returned a non-JSON response.' }
      }
      const parsed = JSON.parse(match[0]) as { score?: unknown; passed?: unknown; feedback?: unknown }
      const rawScore = Number(parsed.score)
      if (!Number.isFinite(rawScore)) {
        return { kind: 'skip', reason: 'parse_failed', feedback: 'Reviewer response was missing a numeric score.' }
      }
      const score = Math.max(0, Math.min(100, rawScore))
      const result: VerificationResult = {
        kind: 'review',
        score,
        passed: !!parsed.passed,
        feedback: typeof parsed.feedback === 'string' ? parsed.feedback : ''
      }
      updateDocumentVerification(documentId, result.score, result.feedback)
      return result
    }
    return { kind: 'skip', reason: 'no_ai_response', feedback: 'No AI model responded to the verification request.' }
  } catch (err) {
    if (err instanceof RateLimitError) throw err
    // Non-rate-limit failure (network, parse error, etc.) — return a skip and
    // do NOT call updateDocumentVerification. The previous score, if any, is
    // preserved on the document row.
    return {
      kind: 'skip',
      reason: 'parse_failed',
      feedback: rawResponse
        ? 'Could not parse the reviewer response.'
        : 'Verification failed before the reviewer could respond.'
    }
  }
}

export async function regenerateSection(
  documentId: number,
  sectionName: string,
  jobId: number,
  extraContext?: string
): Promise<string> {
  const job = getJob(jobId)
  if (!job) throw new Error('Job not found')

  const doc = getDocument(documentId)
  if (!doc) throw new Error('Document not found')

  const sectionNameLower = sectionName.toLowerCase().trim()
  if (NO_REGENERATE.has(sectionNameLower)) {
    throw new Error(`Cannot regenerate the "${sectionName}" section.`)
  }

  const sections = parseSections(doc.content)
  const section = sections.find((s) => s.name === sectionNameLower)
  if (!section) throw new Error(`Section "${sectionName}" not found in the document.`)

  const sectionContent = section.bodyLines.join('\n').trim()
  if (!sectionContent) throw new Error(`Section "${sectionName}" is empty.`)

  const systemPrompt = `You are an expert career coach regenerating a single section of a Harvard-format CV.

The section header is "${section.header}". Preserve the exact same header — do not output it.

=== HARVARD CV TEMPLATE (source of truth) ===
${await loadHarvardTemplate()}
=== END TEMPLATE ===

Formatting rules:
${NO_BULLET_SECTIONS.has(sectionNameLower)
  ? '- Each line is a label: comma-separated values (no bullets)'
  : `- Entries use TAB between organization/school name (left) and location (right)
- Role/Title on next line with TAB between title (left) and dates (right)
- Bullet points in XYZ format: "Accomplished [X] as measured by [Y], by doing [Z]."
- Each bullet starts with an action verb
- Do NOT use personal pronouns; each bullet is a phrase, not a full sentence`
}

CRITICAL — TRUTHFULNESS (this overrides everything else):
- Use ONLY experience, skills, education, and projects that appear in the Full CV below.
- Do NOT invent or fabricate any experience, employers, job titles, projects, technologies, degrees, courses, GPA, awards, dates, or numbers that are not in the Full CV.
- Do NOT hallucinate metrics ("increased revenue by 40%") unless that specific number is in the Full CV. If no metric exists, use a non-numeric but truthful phrasing.
- Do NOT add skills, tools, languages, or technologies the candidate did not list.
- You MAY reword, reframe, reorder, and tighten existing entries to highlight what is most relevant to the target job. The candidate's actual accomplishments stay — they just sound as strong and as role-aligned as possible.
- If the section content is sparse, the output should be sparse. Do not pad with generic filler.

Rewrite the section content to better match the target job. Keep only relevant entries. Output ONLY the section body — no header line, no markdown.`

  const userPrompt = `Job Title: ${job.title}
Company: ${job.company}
Job Description:
${job.description || 'No description provided.'}

Full CV:
${doc.content}

Current "${sectionName}" section content:
${sectionContent}
${extraContext && extraContext.trim() ? `\nAdditional context from the user (follow these instructions when rewriting):\n${extraContext.trim()}\n` : ''}
Rewrite only this section's body.`

  const result = await callAI(systemPrompt, userPrompt, 0.7)
  const newBody = result.content!

  const resultLines = [...doc.content.split('\n')]
  resultLines.splice(section.startIdx + 1, section.endIdx - section.startIdx - 1, ...newBody.trim().split('\n'))
  const updatedContent = resultLines.join('\n')

  updateDocument(documentId, doc.title, updatedContent)

  return updatedContent
}

export interface JobFitResult {
  score: number
  rationale: string
  breakdown: FitBreakdown
  source: 'llm' | 'heuristic'
  // Populated when source === 'heuristic' AND the fallback was reached because
  // the LLM call failed (no models, all rate-limited, parse error, etc.).
  // Empty string for the no-base-CV case and for legitimate keyword fallback.
  error?: string
}

function emptyBreakdown(): FitBreakdown {
  return { matched_skills: [], missing_skills: [], experience_years_match: null }
}

function heuristicFit(input: {
  title: string
  description: string | null
  requirements: string | null
  baseCv: string
  cvEduLevel: number
  cvYears: number
  error?: string
}): JobFitResult {
  const score = scoreCompatibility(input.title, input.description || '', input.baseCv)
  return {
    score,
    rationale: `Heuristic score based on keyword overlap. CV education level: ${input.cvEduLevel || 'unspecified'}, years experience: ${input.cvYears || 'unspecified'}.`,
    breakdown: emptyBreakdown(),
    source: 'heuristic',
    error: input.error
  }
}

/**
 * Score how well a job matches the candidate's base CV.
 *
 * Calls the configured LLM to perform a semantic comparison of the candidate's
 * actual experience against the job's requirements. On rate-limit or other
 * failure, falls back to a deterministic keyword heuristic so the user always
 * gets a number.
 */
export async function scoreJobFit(input: {
  title: string
  description: string | null
  requirements: string | null
  baseCv: string
}): Promise<JobFitResult> {
  const cvEduLevel = extractEducationLevel(input.baseCv)
  const cvYears = extractYearsExperience(input.baseCv)

  // The fallback returned when the LLM call fails. The error message is
  // captured so callers can surface it on the job row and the user can tell
  // the difference between "bad fit" and "scorer is broken".
  const fallbackWithError = (error: string): JobFitResult =>
    heuristicFit({ ...input, cvEduLevel, cvYears, error })

  if (!input.baseCv) {
    return {
      score: 0.5,
      rationale: 'No base CV configured; returning neutral score.',
      breakdown: emptyBreakdown(),
      source: 'heuristic'
    }
  }

  const systemPrompt = `You are an expert technical recruiter scoring how well a candidate's CV matches a specific job posting.

You will receive:
- The candidate's BASE CV (their full background — work history, education, skills, projects).
- The job title, description, and explicit requirements.
- Optional parsed context: the candidate's detected education level (0-5, higher=more advanced) and years of experience extracted from the CV. Treat these as hints, not ground truth.

Your job: return a fit score between 0.0 and 1.0, where:
- 1.0 = exceptional match, candidate clearly meets or exceeds all must-have requirements.
- 0.6-0.8 = strong match on most requirements, minor gaps.
- 0.3-0.5 = partial match, several important requirements unmet.
- 0.0-0.2 = poor match, candidate's experience is largely unrelated.

RULES (these override anything else):
- Only credit the candidate for skills and experience that are EVIDENT in the base CV. Do not invent.
- Required years of experience, education level, and must-have skills are weighted heavily. Nice-to-haves are weighted lightly.
- Do NOT penalize a candidate for not having a specific technology if they have an adjacent/equivalent one AND the posting does not strictly require that exact tool.
- Do NOT penalize a candidate for not meeting an exact degree requirement if their equivalent professional experience clearly compensates.
- A job with a "5+ years" requirement does not automatically disqualify a candidate with 3 years of directly relevant, senior-level experience.
- Be honest. If the job is senior/staff level and the candidate is junior, the score should reflect that.

OUTPUT: a single JSON object, no markdown, no commentary:
{"score": <0.0-1.0>, "rationale": "<one short sentence, <= 30 words, explaining the score>", "matched_skills": ["<short skill>", ...], "missing_skills": ["<short skill>", ...], "experience_years_match": <true | false | null>}

- matched_skills / missing_skills: list up to 8 each, focused on the most decision-relevant skills mentioned in the posting. Empty arrays if not applicable.
- experience_years_match: true if the candidate's years of relevant experience plausibly meet the posting's requirement, false if clearly short, null if the posting does not specify a years requirement.`

  const userPrompt = `JOB TITLE: ${input.title}

JOB DESCRIPTION:
${input.description || '(none)'}

JOB REQUIREMENTS:
${input.requirements || '(none)'}

CANDIDATE BASE CV:
${input.baseCv}

PARSED CONTEXT (hints only — verify against the CV above):
- Detected CV education level: ${cvEduLevel > 0 ? cvEduLevel : 'unspecified'}
- Detected CV years of experience: ${cvYears > 0 ? cvYears : 'unspecified'}

Return the JSON object now.`

  try {
    const result = await callAI(systemPrompt, userPrompt, 0.2, 20000)
    const content = result.content || ''
    // Try to locate a JSON object in the response (defensive against stray prose)
    const match = content.match(/\{[\s\S]*\}/)
    if (!match) {
      return fallbackWithError(
        result.rateLimited
          ? 'All AI models were rate limited.'
          : 'Reviewer returned a non-JSON response.'
      )
    }
    const parsed = JSON.parse(match[0]) as {
      score?: number
      rationale?: string
      matched_skills?: unknown
      missing_skills?: unknown
      experience_years_match?: unknown
    }
    const rawScore = Number(parsed.score)
    if (!Number.isFinite(rawScore)) {
      return fallbackWithError('Reviewer response was missing a numeric score.')
    }
    const score = Math.max(0, Math.min(1, rawScore))
    const matched = Array.isArray(parsed.matched_skills)
      ? parsed.matched_skills.filter((s): s is string => typeof s === 'string').slice(0, 8)
      : []
    const missing = Array.isArray(parsed.missing_skills)
      ? parsed.missing_skills.filter((s): s is string => typeof s === 'string').slice(0, 8)
      : []
    const expMatch =
      typeof parsed.experience_years_match === 'boolean'
        ? parsed.experience_years_match
        : null
    const rationale =
      typeof parsed.rationale === 'string' && parsed.rationale.trim().length > 0
        ? parsed.rationale.trim().slice(0, 300)
        : `LLM score ${score.toFixed(2)}.`
    return {
      score,
      rationale,
      breakdown: {
        matched_skills: matched,
        missing_skills: missing,
        experience_years_match: expMatch
      },
      source: 'llm'
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error'
    return fallbackWithError(`LLM scorer failed: ${msg}`)
  }
}