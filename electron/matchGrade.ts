import type { MatchGrade } from './types'

export function matchGradeFor(fitScore: number | null): MatchGrade {
  if (fitScore == null) return null
  if (fitScore >= 0.9) return 'S'
  if (fitScore >= 0.75) return 'A'
  if (fitScore >= 0.6) return 'B'
  if (fitScore >= 0.45) return 'C'
  if (fitScore >= 0.3) return 'D'
  return 'F'
}
