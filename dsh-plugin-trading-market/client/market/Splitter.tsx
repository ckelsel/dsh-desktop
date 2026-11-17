/**
 * Drag handle between two market page regions: pointer capture with rAF-throttled offsets from the
 * drag origin, plus arrow-key steps for keyboard users.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from 'react'

export interface SplitterProps {
  /** `column` resizes left and right regions, `row` regions above and below. */
  axis: 'column' | 'row'
  label: string
  /** Current size of the region the handle resizes, for assistive technology. */
  value: number
  min: number
  max: number
  onStart(): void
  /** Offset from the drag origin in px, along the axis. */
  onDrag(delta: number): void
  onEnd(): void
  /** One keyboard step, in px; positive grows toward the right or bottom. */
  onStep(delta: number): void
}

export function Splitter(props: SplitterProps) {
  const [dragging, setDragging] = useState(false)
  const origin = useRef(0)
  const latest = useRef(0)
  const frame = useRef<number | null>(null)
  const capture = useRef<{ element: HTMLDivElement; id: number } | null>(null)
  const callbacks = useRef(props)
  callbacks.current = props
  const position = (event: { clientX: number; clientY: number }): number => props.axis === 'column' ? event.clientX : event.clientY

  const endDrag = useCallback(() => {
    const active = capture.current
    if (active === null) return
    capture.current = null
    if (frame.current !== null) { cancelAnimationFrame(frame.current); frame.current = null }
    if (active.element.hasPointerCapture(active.id)) active.element.releasePointerCapture(active.id)
    setDragging(false)
    callbacks.current.onEnd()
  }, [])
  useEffect(() => endDrag, [endDrag])

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0 || capture.current !== null) return
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    capture.current = { element: event.currentTarget, id: event.pointerId }
    origin.current = position(event)
    latest.current = origin.current
    callbacks.current.onStart()
    setDragging(true)
  }
  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (capture.current?.id !== event.pointerId) return
    latest.current = position(event)
    frame.current ??= requestAnimationFrame(() => {
      frame.current = null
      callbacks.current.onDrag(latest.current - origin.current)
    })
  }
  const onPointerUp = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (capture.current?.id !== event.pointerId) return
    callbacks.current.onDrag(position(event) - origin.current)
    endDrag()
  }
  const onPointerCancel = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (capture.current?.id === event.pointerId) endDrag()
  }
  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    const keys = props.axis === 'column' ? ['ArrowLeft', 'ArrowRight'] : ['ArrowUp', 'ArrowDown']
    const index = keys.indexOf(event.key)
    if (index < 0) return
    event.preventDefault()
    callbacks.current.onStep((index === 0 ? -1 : 1) * (event.shiftKey ? 48 : 16))
  }

  return <div
    className="dshMkSplitter"
    data-axis={props.axis}
    data-dragging={dragging || undefined}
    role="separator"
    tabIndex={0}
    aria-label={props.label}
    aria-orientation={props.axis === 'column' ? 'vertical' : 'horizontal'}
    aria-valuenow={Math.round(props.value)}
    aria-valuemin={Math.round(props.min)}
    aria-valuemax={Math.round(props.max)}
    onPointerDown={onPointerDown}
    onPointerMove={onPointerMove}
    onPointerUp={onPointerUp}
    onPointerCancel={onPointerCancel}
    onLostPointerCapture={onPointerCancel}
    onKeyDown={onKeyDown}
  />
}
