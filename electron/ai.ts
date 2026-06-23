import { getSettings } from './database'
import type { Job, TailorRequest, TailorResult } from './types'
import { createDocument, getJob, updateJob } from './database'

export async function tailorDocument(request: TailorRequest): Promise<TailorResult> {
  const settings = getSettings()
  const job = getJob(request.job_id)
  if (!job) throw new Error('Job not found')

  const baseContent =
    request.base_content ||
    settings.base_cv ||
    'No base CV provided. Add your base CV in Settings.'

  if (!settings.openai_api_key) {
    const fallback = generateFallbackDocument(job, request.document_type, baseContent, settings)
    const doc = createDocument(
      request.document_type,
      `${request.document_type === 'cv' ? 'CV' : 'Cover Letter'} — ${job.company}`,
      fallback,
      job.id
    )
    updateJob(job.id, { status: 'tailoring' })
    return { content: fallback, document_id: doc.id }
  }

  const systemPrompt =
    request.document_type === 'cv'
      ? `You are an expert career coach. Tailor the candidate's CV for the specific job posting. 
Keep factual accuracy — only reorganize and emphasize relevant experience. Output plain text formatted as a CV.`
      : `You are an expert career coach. Write a compelling, personalized cover letter for this job.
Keep it concise (3-4 paragraphs), professional, and specific to the role. Output plain text only.`

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

  const response = await fetch(`${settings.openai_base_url}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${settings.openai_api_key}`
    },
    body: JSON.stringify({
      model: settings.openai_model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ],
      temperature: 0.7
    })
  })

  if (!response.ok) {
    const err = await response.text()
    throw new Error(`AI request failed: ${response.status} ${err}`)
  }

  const data = (await response.json()) as {
    choices: { message: { content: string } }[]
  }
  const content = data.choices[0]?.message?.content ?? ''

  const doc = createDocument(
    request.document_type,
    `${request.document_type === 'cv' ? 'CV' : 'Cover Letter'} — ${job.company}`,
    content,
    job.id
  )
  updateJob(job.id, { status: 'ready' })

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

  return `TAILORED CV FOR: ${job.title} at ${job.company}
${'='.repeat(50)}

[Configure an OpenAI API key in Settings for AI-powered tailoring]

RELEVANT KEYWORDS FROM JOB:
${extractKeywords(job.description ?? '')}

---
BASE CV:
${baseCv}`
}

function extractKeywords(description: string): string {
  const words = description
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 4)
  const freq = new Map<string, number>()
  for (const w of words) {
    freq.set(w, (freq.get(w) ?? 0) + 1)
  }
  return [...freq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 15)
    .map(([w]) => w)
    .join(', ')
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
