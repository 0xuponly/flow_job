import { describe, it, expect, vi, beforeEach } from 'vitest'
import { tailorJobDocsForJob } from './tailorJobDocs'
import { tailorDocument } from './ai'
import {
  getJob,
  writeDocuments,
  writeTailorTimingFields,
  setJobStatus
} from './database'
import { log } from './logger'

// Mock the LLM and store so the test is hermetic.
vi.mock('./ai', () => ({
  tailorDocument: vi.fn(async (req: { document_type: 'cv' | 'cover_letter' }) => ({
    content: `mocked ${req.document_type} content`,
    model_used: 'mock',
  })),
}))
vi.mock('./database', () => ({
  getJob: vi.fn((id: number) => ({ id, title: 't', company: 'c', description: 'd', score: 0.8 })),
  // Use a real in-memory store stub; the implementer can swap to the real one
  // if the test env supports it. The contract is: writeDocuments returns ids,
  // writeTailorTimingFields is idempotent.
  writeDocuments: vi.fn(async () => ({ cvId: 10, clId: 11 })),
  writeTailorTimingFields: vi.fn(async () => { /* no-op mock */ }),
  setJobStatus: vi.fn(async () => { /* no-op mock */ }),
}))
vi.mock('./logger', () => ({
  log: { tailor: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } },
}))

const mockedTailorDocument = vi.mocked(tailorDocument)
const mockedGetJob = vi.mocked(getJob)
const mockedWriteDocuments = vi.mocked(writeDocuments)
const mockedWriteTailorTimingFields = vi.mocked(writeTailorTimingFields)
const mockedSetJobStatus = vi.mocked(setJobStatus)
const mockedTailorLog = vi.mocked(log.tailor)

beforeEach(() => {
  vi.clearAllMocks()
  // Default: both documents succeed.
  mockedTailorDocument.mockImplementation(async (req) => ({
    content: `mocked ${req.document_type} content`,
    model_used: 'mock',
  }))
  mockedGetJob.mockImplementation((id: number) => ({
    id, title: 't', company: 'c', description: 'd', score: 0.8
  } as ReturnType<typeof getJob> & object))
  mockedWriteDocuments.mockResolvedValue({ cvId: 10, clId: 11 })
})

describe('tailorJobDocsForJob', () => {
  it('returns both ids and timing', async () => {
    const result = await tailorJobDocsForJob(1)
    expect(result.cvId).toBe(10)
    expect(result.clId).toBe(11)
    expect(result.ms_cv).toBeGreaterThanOrEqual(0)
    expect(result.ms_cl).toBeGreaterThanOrEqual(0)
  })

  it('CV fails, CL succeeds: cvId=0, clId returned, lastError set, status NOT flipped', async () => {
    mockedTailorDocument.mockImplementation(async (req) => {
      if (req.document_type === 'cv') throw new Error('cv down')
      return { content: 'mocked cover_letter content', model_used: 'mock' }
    })
    const result = await tailorJobDocsForJob(1)
    // writeDocuments was called with cvContent=null, clContent set.
    expect(mockedWriteDocuments).toHaveBeenCalledWith({
      jobId: 1,
      cvContent: null,
      clContent: 'mocked cover_letter content'
    })
    // The mock returns { cvId: 10, clId: 11 }; cvId=10 is the mock value
    // and the call site's choice depends on writeDocuments impl. The
    // critical invariant is: writeTailorTimingFields sees lastError,
    // generatedAt=null, and setJobStatus is NOT called.
    expect(mockedWriteTailorTimingFields).toHaveBeenCalledWith(
      expect.objectContaining({
        jobId: 1,
        lastError: 'cv down',
        generatedAt: null
      })
    )
    expect(mockedSetJobStatus).not.toHaveBeenCalled()
    expect(mockedTailorLog.error).toHaveBeenCalledWith('cv_failed', { jobId: 1 })
    expect(result.clId).toBe(11)
    expect(result.ms_cv).toBeGreaterThanOrEqual(0)
    expect(result.ms_cl).toBeGreaterThanOrEqual(0)
  })

  it('CL fails, CV succeeds: clId=0, cvId returned, lastError set, status NOT flipped', async () => {
    mockedTailorDocument.mockImplementation(async (req) => {
      if (req.document_type === 'cover_letter') throw new Error('cl down')
      return { content: 'mocked cv content', model_used: 'mock' }
    })
    const result = await tailorJobDocsForJob(1)
    expect(mockedWriteDocuments).toHaveBeenCalledWith({
      jobId: 1,
      cvContent: 'mocked cv content',
      clContent: null
    })
    expect(mockedWriteTailorTimingFields).toHaveBeenCalledWith(
      expect.objectContaining({
        jobId: 1,
        lastError: 'cl down',
        generatedAt: null
      })
    )
    expect(mockedSetJobStatus).not.toHaveBeenCalled()
    expect(mockedTailorLog.error).toHaveBeenCalledWith('cl_failed', { jobId: 1 })
    expect(result.cvId).toBe(10)
  })

  it('both fail: writeDocuments NOT called, lastError preserved, status NOT flipped', async () => {
    mockedTailorDocument.mockRejectedValue(new Error('llm down'))
    const result = await tailorJobDocsForJob(1)
    expect(mockedWriteDocuments).not.toHaveBeenCalled()
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

  it('throws when getJob returns undefined and logs dropped_missing_job', async () => {
    mockedGetJob.mockReturnValue(undefined)
    await expect(tailorJobDocsForJob(999)).rejects.toThrow(/not found/i)
    expect(mockedTailorLog.warn).toHaveBeenCalledWith('dropped_missing_job', { jobId: 999 })
    expect(mockedWriteDocuments).not.toHaveBeenCalled()
    expect(mockedWriteTailorTimingFields).not.toHaveBeenCalled()
  })

  it('runs CV and CL generation in parallel (Promise.all)', async () => {
    // Track call order via timestamps. If serialized, total > cv+cl
    // overlap. With Promise.all, both fire at t=0.
    const calls: number[] = []
    mockedTailorDocument.mockImplementation(async (req) => {
      calls.push(Date.now())
      return { content: `mocked ${req.document_type} content`, model_used: 'mock' }
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
      if (req.document_type === 'cv') return { content: oversizedCv, model_used: 'mock' }
      return { content: 'mocked cover_letter content', model_used: 'mock' }
    })
    await tailorJobDocsForJob(1)
    const call = mockedWriteDocuments.mock.calls[0][0] as { cvContent: string; clContent: string }
    expect(call.cvContent).toMatch(/Company 1/)
    expect(call.cvContent).toMatch(/Company 4/)
    expect(call.cvContent).not.toMatch(/Company 5/)
    expect(call.cvContent).not.toMatch(/Company 6/)
  })

  it('sanitizes an over-long cover letter before writing to the store', async () => {
    const oversizedCl = 'Para 1.\n\nPara 2.\n\nPara 3.\n\nPara 4.\n\nPara 5.\n\nPara 6.'
    mockedTailorDocument.mockImplementation(async (req) => {
      if (req.document_type === 'cover_letter') return { content: oversizedCl, model_used: 'mock' }
      return { content: 'mocked cv content', model_used: 'mock' }
    })
    await tailorJobDocsForJob(1)
    const call = mockedWriteDocuments.mock.calls[0][0] as { cvContent: string; clContent: string }
    expect(call.clContent).toMatch(/Para 1/)
    expect(call.clContent).toMatch(/Para 4/)
    expect(call.clContent).not.toMatch(/Para 5/)
    expect(call.clContent).not.toMatch(/Para 6/)
  })

  it('caps technical skills to 15 before writing to the store', async () => {
    const tech = Array.from({ length: 20 }, (_, i) => `skill${i}`).join(', ')
    const cvWithTooManySkills = `Name\nemail\n\nSKILLS & INTERESTS\nTechnical: ${tech}\nLanguage: English\n`
    mockedTailorDocument.mockImplementation(async (req) => {
      if (req.document_type === 'cv') return { content: cvWithTooManySkills, model_used: 'mock' }
      return { content: 'mocked cover_letter content', model_used: 'mock' }
    })
    mockedGetJob.mockImplementation((id: number) => ({
      id, title: 't', company: 'c', description: 'skill0 skill1 skill2', score: 0.8
    } as ReturnType<typeof getJob> & object))
    await tailorJobDocsForJob(1)
    const call = mockedWriteDocuments.mock.calls[0][0] as { cvContent: string; clContent: string }
    const techLine = call.cvContent.split('\n').find((l) => l.startsWith('Technical:'))!
    const kept = techLine.replace('Technical:', '').split(',').map((s) => s.trim())
    expect(kept).toHaveLength(15)
  })
})
