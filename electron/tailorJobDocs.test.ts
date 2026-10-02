import { describe, it, expect, vi, beforeEach } from 'vitest'
import { tailorJobDocsForJob } from './tailorJobDocs'
import { tailorDocument } from './ai'
import { getJob, setDocumentContent, writeTailorTimingFields, setJobStatus } from './database'
import { log } from './logger'

// Mock the LLM and store so the test is hermetic.
vi.mock('./ai', () => ({
  tailorDocument: vi.fn(async (req: { document_type: 'cv' | 'cover_letter' }) => ({
    content: `mocked ${req.document_type} content`,
    document_id: req.document_type === 'cv' ? 10 : 11,
    model_used: 'mock',
  })),
}))
vi.mock('./database', () => ({
  getJob: vi.fn((id: number) => ({ id, title: 't', company: 'c', description: 'd', score: 0.8 })),
  // The contract is one write per document, onto the row `tailorDocument`
  // already created: it returns that row's `document_id` and this replaces
  // only its content. `writeDocuments` used to be called here as well and
  // INSERTED a second row for the same document; see the end-to-end
  // proof in `moneyleaks.doubleWrite.store.test.ts`.
  setDocumentContent: vi.fn((id: number) => ({ id })),
  writeTailorTimingFields: vi.fn(async () => { /* no-op mock */ }),
  setJobStatus: vi.fn(async () => { /* no-op mock */ }),
}))
vi.mock('./logger', () => ({
  log: { tailor: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } },
}))

const mockedTailorDocument = vi.mocked(tailorDocument)
const mockedGetJob = vi.mocked(getJob)
const mockedSetDocumentContent = vi.mocked(setDocumentContent)
const mockedWriteTailorTimingFields = vi.mocked(writeTailorTimingFields)
const mockedSetJobStatus = vi.mocked(setJobStatus)
const mockedTailorLog = vi.mocked(log.tailor)

/** The sanitized content stored against each document id. */
function storedContent(): Map<number, string> {
  return new Map(mockedSetDocumentContent.mock.calls.map(([id, content]) => [id, content]))
}

beforeEach(() => {
  vi.clearAllMocks()
  // Default: both documents succeed, each creating its own row.
  mockedTailorDocument.mockImplementation(async (req) => ({
    content: `mocked ${req.document_type} content`,
    document_id: req.document_type === 'cv' ? 10 : 11,
    model_used: 'mock',
  }))
  mockedGetJob.mockImplementation((id: number) => ({
    id, title: 't', company: 'c', description: 'd', score: 0.8
  } as ReturnType<typeof getJob> & object))
  mockedSetDocumentContent.mockImplementation((id: number) => ({ id }) as never)
})

describe('tailorJobDocsForJob', () => {
  it('returns both ids and timing', async () => {
    const result = await tailorJobDocsForJob(1)
    expect(result.cvId).toBe(10)
    expect(result.clId).toBe(11)
    expect(result.ms_cv).toBeGreaterThanOrEqual(0)
    expect(result.ms_cl).toBeGreaterThanOrEqual(0)
  })

  it('writes ONE row per document: exactly two content writes, one per document id', async () => {
    // The double write, pinned at the unit level: `tailorDocument` created
    // both rows and returned both ids, and this function wrote each row's
    // content exactly once. Before, it ALSO called `writeDocuments`, which
    // inserted a second `cv` row and a second `cover_letter` row.
    await tailorJobDocsForJob(1)
    expect(mockedSetDocumentContent).toHaveBeenCalledTimes(2)
    expect(mockedSetDocumentContent.mock.calls.map(([id]) => id).sort()).toEqual([10, 11])
  })

  it('CV fails, CL succeeds: only the CL row is written, lastError set, status NOT flipped', async () => {
    mockedTailorDocument.mockImplementation(async (req) => {
      if (req.document_type === 'cv') throw new Error('cv down')
      return { content: 'mocked cover_letter content', document_id: 11, model_used: 'mock' }
    })
    const result = await tailorJobDocsForJob(1)
    // A failed document left no row at all, so there is nothing to write.
    const stored = storedContent()
    expect(stored.has(10)).toBe(false)
    expect(stored.get(11)).toBe('mocked cover_letter content')
    expect(mockedWriteTailorTimingFields).toHaveBeenCalledWith(
      expect.objectContaining({
        jobId: 1,
        lastError: 'cv down',
        generatedAt: null
      })
    )
    expect(mockedSetJobStatus).not.toHaveBeenCalled()
    expect(mockedTailorLog.error).toHaveBeenCalledWith('cv_failed', { jobId: 1 })
    expect(result.cvId).toBe(0)
    expect(result.clId).toBe(11)
    expect(result.ms_cv).toBeGreaterThanOrEqual(0)
    expect(result.ms_cl).toBeGreaterThanOrEqual(0)
  })

  it('CL fails, CV succeeds: only the CV row is written, lastError set, status NOT flipped', async () => {
    mockedTailorDocument.mockImplementation(async (req) => {
      if (req.document_type === 'cover_letter') throw new Error('cl down')
      return { content: 'mocked cv content', document_id: 10, model_used: 'mock' }
    })
    const result = await tailorJobDocsForJob(1)
    const stored = storedContent()
    expect(stored.has(11)).toBe(false)
    expect(stored.get(10)).toBe('mocked cv content')
    expect(mockedWriteTailorTimingFields).toHaveBeenCalledWith(
      expect.objectContaining({
        jobId: 1,
        lastError: 'cl down',
        generatedAt: null
      })
    )
    expect(mockedSetJobStatus).not.toHaveBeenCalled()
    expect(mockedTailorLog.error).toHaveBeenCalledWith('cl_failed', { jobId: 1 })
    expect(result.clId).toBe(0)
    expect(result.cvId).toBe(10)
  })

  it('both fail: nothing is written, lastError preserved, status NOT flipped', async () => {
    mockedTailorDocument.mockRejectedValue(new Error('llm down'))
    const result = await tailorJobDocsForJob(1)
    expect(mockedSetDocumentContent).not.toHaveBeenCalled()
    expect(mockedWriteTailorTimingFields).toHaveBeenCalledWith(
      expect.objectContaining({
        jobId: 1,
        lastError: 'llm down',
        generatedAt: null
      })
    )
    expect(mockedSetJobStatus).not.toHaveBeenCalled()
    expect(result.cvId).toBe(0)
    expect(result.clId).toBe(0)
  })

  it('a document the user deleted in the gap is not resurrected', async () => {
    // `setDocumentContent` returns null for a row that no longer exists.
    // Inserting a replacement here would bring back a document the user
    // deleted while the model was writing it.
    mockedSetDocumentContent.mockReturnValue(null as never)
    const result = await tailorJobDocsForJob(1)
    expect(result.cvId).toBe(0)
    expect(result.clId).toBe(0)
    expect(mockedSetDocumentContent).toHaveBeenCalledTimes(2)
  })

  it('throws when getJob returns undefined and logs dropped_missing_job', async () => {
    mockedGetJob.mockReturnValue(undefined)
    await expect(tailorJobDocsForJob(999)).rejects.toThrow(/not found/i)
    expect(mockedTailorLog.warn).toHaveBeenCalledWith('dropped_missing_job', { jobId: 999 })
    expect(mockedSetDocumentContent).not.toHaveBeenCalled()
    expect(mockedWriteTailorTimingFields).not.toHaveBeenCalled()
  })

  it('runs CV and CL generation in parallel (Promise.all)', async () => {
    // Track call order via timestamps. If serialized, total > cv+cl
    // overlap. With Promise.all, both fire at t=0.
    const calls: number[] = []
    mockedTailorDocument.mockImplementation(async (req) => {
      calls.push(Date.now())
      return {
        content: `mocked ${req.document_type} content`,
        document_id: req.document_type === 'cv' ? 10 : 11,
        model_used: 'mock'
      }
    })
    await tailorJobDocsForJob(1)
    expect(calls).toHaveLength(2)
    // Both calls must have happened: at least one for cv, one for cl.
    expect(mockedTailorDocument).toHaveBeenCalledWith(
      expect.objectContaining({ document_type: 'cv' })
    )
    expect(mockedTailorDocument).toHaveBeenCalledWith(
      expect.objectContaining({ document_type: 'cover_letter' })
    )
  })

  it('sanitizes an over-long CV before writing to the store', async () => {
    const exp = (n: number) => `Company ${n}\tCity, ST\nRole ${n}\tJan 2024 – Present\n- bullet\n`
    const oversizedCv = `Name\nemail\n\nEXPERIENCE\n${exp(1)}${exp(2)}${exp(3)}${exp(4)}${exp(5)}${exp(6)}\n`
    mockedTailorDocument.mockImplementation(async (req) => {
      if (req.document_type === 'cv') {
        return { content: oversizedCv, document_id: 10, model_used: 'mock' }
      }
      return { content: 'mocked cover_letter content', document_id: 11, model_used: 'mock' }
    })
    await tailorJobDocsForJob(1)
    const stored = storedContent()
    const cvContent = stored.get(10)!
    expect(cvContent).toMatch(/Company 1/)
    expect(cvContent).toMatch(/Company 4/)
    expect(cvContent).not.toMatch(/Company 5/)
    expect(cvContent).not.toMatch(/Company 6/)
  })

  it('sanitizes an over-long cover letter before writing to the store', async () => {
    const oversizedCl = 'Para 1.\n\nPara 2.\n\nPara 3.\n\nPara 4.\n\nPara 5.\n\nPara 6.'
    mockedTailorDocument.mockImplementation(async (req) => {
      if (req.document_type === 'cover_letter') {
        return { content: oversizedCl, document_id: 11, model_used: 'mock' }
      }
      return { content: 'mocked cv content', document_id: 10, model_used: 'mock' }
    })
    await tailorJobDocsForJob(1)
    const clContent = storedContent().get(11)!
    expect(clContent).toMatch(/Para 1/)
    expect(clContent).toMatch(/Para 4/)
    expect(clContent).not.toMatch(/Para 5/)
    expect(clContent).not.toMatch(/Para 6/)
  })

  it('caps technical skills to 15 before writing to the store', async () => {
    const tech = Array.from({ length: 20 }, (_, i) => `skill${i}`).join(', ')
    const cvWithTooManySkills = `Name\nemail\n\nSKILLS & INTERESTS\nTechnical: ${tech}\nLanguage: English\n`
    mockedTailorDocument.mockImplementation(async (req) => {
      if (req.document_type === 'cv') {
        return { content: cvWithTooManySkills, document_id: 10, model_used: 'mock' }
      }
      return { content: 'mocked cover_letter content', document_id: 11, model_used: 'mock' }
    })
    mockedGetJob.mockImplementation((id: number) => ({
      id, title: 't', company: 'c', description: 'skill0 skill1 skill2', score: 0.8
    } as ReturnType<typeof getJob> & object))
    await tailorJobDocsForJob(1)
    const cvContent = storedContent().get(10)!
    const techLine = cvContent.split('\n').find((l) => l.startsWith('Technical:'))!
    const kept = techLine.replace('Technical:', '').split(',').map((s) => s.trim())
    expect(kept).toHaveLength(15)
  })
})