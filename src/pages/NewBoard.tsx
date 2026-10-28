import { Navigate, useLocation } from 'react-router-dom'
import { newBoardId } from '../lib/ids'
import { touchBoard } from '../lib/storage'

/** one board per visit to #/new, however often React renders it */
let made: { key: string; id: string } | null = null

/** #/new, the installed app's "New board" shortcut: makes a board and opens it. */
export default function NewBoard() {
  const { key } = useLocation()
  if (made?.key !== key) {
    made = { key, id: newBoardId() }
    touchBoard(made.id)
  }
  return <Navigate to={`/board/${made.id}`} replace />
}
