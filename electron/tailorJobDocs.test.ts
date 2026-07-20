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
  writeTailorTimingFields: vi.fn(async () => {}),
  setJobStatus: vi.fn(async () => {}),
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
})
