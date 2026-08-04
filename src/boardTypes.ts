// Board variants that share a single checkbox in the picker. A variant
// name maps to its group's display label (the canonical board name); a
// board with no variant maps to itself. The persisted selection and the
// scan payload keep using individual board names — this map only
// changes how the picker renders and counts them, so ticking "Indeed"
// selects both "Indeed" and "Indeed (RSS)" and the scan runs both.
export const BOARD_GROUP_OF: Record<string, string> = {
  'Indeed (RSS)': 'Indeed',
  'Indeed Canada (RSS)': 'Indeed Canada',
  'ZipRecruiter (RSS)': 'ZipRecruiter',
  'We Work Remotely (RSS)': 'We Work Remotely',
  'Remotive (API)': 'Remotive',
  'WorkBC (API)': 'WorkBC',
  'Job Bank GC (API)': 'Job Bank (GC)'
}

// Display group for a board name: the variant's canonical label, or
// the name itself when the board has no variant.
export function groupOf(name: string): string {
  return BOARD_GROUP_OF[name] ?? name
}

// Group-based selection summary for a board list. Registry entries in
// the same group collapse into one selectable unit; a group counts as
// selected only when EVERY member is selected, matching the picker's
// "two states, not three" toggle (clicking a partial group completes
// it, clicking a full group clears it).
export function groupSelection(boards: { name: string }[], selected: Set<string>): { selected: number; total: number } {
  const membersByGroup = new Map<string, string[]>()
  for (const b of boards) {
    const g = groupOf(b.name)
    const members = membersByGroup.get(g)
    if (members) members.push(b.name)
    else membersByGroup.set(g, [b.name])
  }
  let selectedCount = 0
  for (const members of membersByGroup.values()) {
    if (members.every((n) => selected.has(n))) selectedCount++
  }
  return { selected: selectedCount, total: membersByGroup.size }
}

// Classification of job boards by category. A board is listed under a
// category ONLY if it is exclusively that type (general job boards that
// include crypto jobs are not classified as Crypto, etc).
export const BOARD_TYPES: { label: string; boards: string[] }[] = [
  {
    label: 'Crypto',
    boards: [
      'Crypto Careers',
      'Cryptorecruit',
      'Cryptocurrency Jobs',
      'CryptoJobsList',
      'cryptojobs.com',
      'Crypto.jobs',
      'Web3.career',
      'Braintrust'
    ]
  },
  {
    label: 'Remote',
    boards: [
      'Remote OK',
      'We Work Remotely',
      'We Work Remotely (RSS)',
      'Remotive',
      'Remotive (API)',
      'Remote.co',
      'Working Nomads',
      'JustRemote',
      'Remote3',
      'Hiring Cafe',
      'Sprout',
      'Contra',
      'SkipTheDrive',
      'Jobspresso',
      'Dynamite Jobs',
      'DailyRemote',
      'NoDesk',
      'Remote100k',
      'FlexJobs',
      'Virtual Vocations',
      'Pangian',
      'PowerToFly',
      'Career Vault',
      'Remote Rocketship'
    ]
  },
  {
    label: 'Startup',
    boards: [
      'Startup.jobs',
      'Built In',
      'Built In Toronto',
      'Built In Vancouver',
      'Wellfound',
      'Y Combinator',
      'Top Startups',
      'Rocketships',
      'Arc',
      'Work At A Startup'
    ]
  },
  {
    label: 'Canadian',
    boards: [
      'Indeed Canada',
      'Job Bank (GC)',
      'Job Bank GC (API)',
      'Eluta.ca',
      'Workopolis',
      'Jobboom',
      'WorkBC',
      'WorkBC (API)',
      'CareerBeacon',
      'Vancouver Jobs',
      'UToronto'
    ]
  },
  {
    label: 'Healthcare',
    boards: [
      'Northern Health',
      'Interior Health'
    ]
  },
  {
    label: 'Nonprofit',
    boards: [
      'CharityVillage',
      'Idealist'
    ]
  }
]
