interface Props {
  size?: number
  badge?: boolean
  /**
   * The centre could not be read, so "nothing here" is not something this
   * icon is entitled to say.
   *
   * A third state rather than a variant of `badge`, because the two mean
   * opposite things. The dot means "there is something you have not seen" —
   * something exists. This means the question could not be answered. Painting
   * it the same colour would tell the user their notifications are fine at
   * the exact moment that is least true, and painting it the unread colour
   * would be no better: a broken read is not an unseen record.
   *
   * A ring rather than a filled dot, so it reads as a different mark on the
   * same icon rather than as a second badge competing with the first.
   */
  alert?: boolean
}

export default function BellIcon({ size = 16, badge = false, alert = false }: Props) {
  return (
    <span style={{ position: 'relative', display: 'inline-block' }}>
      <svg
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
        <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
      </svg>
      {badge && (
        <span
          aria-hidden="true"
          style={{
            position: 'absolute',
            top: -2,
            right: -2,
            width: 8,
            height: 8,
            background: '#ef4444',  // matches --danger; could be a var but inline is fine for a one-off dot
            borderRadius: '50%',
            border: '2px solid var(--bg)',  // ring matches sidebar background
          }}
        />
      )}
      {alert && (
        <span
          data-testid="bell-alert"
          aria-hidden="true"
          style={{
            position: 'absolute',
            top: -2,
            right: -2,
            width: 9,
            height: 9,
            // Amber rather than red: red is what the unread dot is, and this
            // is a different claim about a different thing.
            border: '2px solid var(--warning)',
            borderRadius: '50%',
            background: 'var(--bg)',  // hollow, so the two marks cannot be mistaken
          }}
        />
      )}
    </span>
  )
}