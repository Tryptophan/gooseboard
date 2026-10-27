import { useEffect, useMemo, useState } from 'react'
import { EditorContent, useEditor, type Editor } from '@tiptap/react'
import Collaboration from '@tiptap/extension-collaboration'
import Placeholder from '@tiptap/extension-placeholder'
import type * as Y from 'yjs'
import { fragmentToHTML, noteExtensions } from '../model/noteSchema'
import type { NoteItem } from '../model/types'
import { useSession, useSnapshot } from '../state/session'
import { useUi, useUiDispatch } from '../state/ui'
import { Icon } from './Icons'
import s from './Note.module.css'

export function NoteBody({ item, editing }: { item: NoteItem; editing: boolean }) {
  const { store } = useSession()
  const fragment = useMemo(() => store.noteFragment(item.id), [store, item.id])
  if (!fragment) return null
  return editing ? <NoteEditor fragment={fragment} color={item.color} /> : <NoteStatic id={item.id} fragment={fragment} color={item.color} />
}

function NoteStatic({ id, fragment, color }: { id: string; fragment: Y.XmlFragment; color: string }) {
  const dispatch = useUiDispatch()
  const [html, setHtml] = useState(() => fragmentToHTML(fragment))
  useEffect(() => {
    let raf = 0
    const refresh = () => {
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(() => setHtml(fragmentToHTML(fragment)))
    }
    refresh()
    fragment.observeDeep(refresh)
    return () => {
      fragment.unobserveDeep(refresh)
      cancelAnimationFrame(raf)
    }
  }, [fragment])
  return (
    <div className={s.box} style={{ background: color }}>
      <div className={s.prose} dangerouslySetInnerHTML={{ __html: html || '<p class="empty">Double-click to write…</p>' }} />
      <button className={s.expand} title="Open in window  Shift+Enter" onClick={() => dispatch({ type: 'noteModal', id })} onDoubleClick={(e) => e.stopPropagation()}>
        <Icon name="expand" size={14} />
      </button>
    </div>
  )
}

function useNoteEditor(fragment: Y.XmlFragment) {
  return useEditor(
    {
      extensions: [...noteExtensions, Placeholder.configure({ placeholder: 'Write something… (markdown works: # , **bold**, - , [ ] )' }), Collaboration.configure({ fragment })],
      autofocus: 'end',
    },
    [fragment],
  )
}

function NoteEditor({ fragment, color }: { fragment: Y.XmlFragment; color: string }) {
  const editor = useNoteEditor(fragment)
  return (
    <>
      <div className={s.box} style={{ background: color }}>
        <EditorContent editor={editor} className={`${s.prose} ${s.editing}`} />
      </div>
      {editor && <Toolbar editor={editor} />}
    </>
  )
}

/** The open note from ui.noteModal, in a large window over everything. */
export function NoteModal() {
  const { noteModal } = useUi()
  const dispatch = useUiDispatch()
  const { store } = useSession()
  const snap = useSnapshot()
  const item = noteModal ? snap.all.get(noteModal) : undefined
  const gone = !!noteModal && item?.type !== 'note'
  useEffect(() => {
    if (gone) dispatch({ type: 'noteModal', id: null })
  }, [gone, dispatch])
  const fragment = useMemo(() => (item?.type === 'note' ? store.noteFragment(item.id) : null), [store, item?.id, item?.type])
  if (item?.type !== 'note' || !fragment) return null
  return <NoteWindow key={item.id} fragment={fragment} color={item.color} onClose={() => dispatch({ type: 'noteModal', id: null })} />
}

function NoteWindow({ fragment, color, onClose }: { fragment: Y.XmlFragment; color: string; onClose: () => void }) {
  const editor = useNoteEditor(fragment)
  useEffect(() => {
    const h = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [onClose])
  return (
    <div className={s.backdrop} onClick={onClose} data-nodrag>
      <div className={s.window} style={{ background: color }} onClick={(e) => e.stopPropagation()}>
        <div className={s.windowHead}>
          {editor && <Toolbar editor={editor} className={s.inline} />}
          <button className={s.close} onClick={onClose} title="Close  Esc" aria-label="Close">
            <Icon name="close" size={16} />
          </button>
        </div>
        <EditorContent editor={editor} className={`${s.prose} ${s.editing} ${s.big}`} />
      </div>
    </div>
  )
}

function Toolbar({ editor, className = '' }: { editor: Editor; className?: string }) {
  const [, force] = useState(0)
  useEffect(() => {
    const h = () => force((n) => n + 1)
    editor.on('transaction', h)
    return () => void editor.off('transaction', h)
  }, [editor])
  const B = (name: string, icon: string, run: () => void, active: boolean) => (
    <button key={name} className={active ? s.on : ''} title={name} onMouseDown={(e) => e.preventDefault()} onClick={run}>
      <Icon name={icon} size={15} />
    </button>
  )
  const c = () => editor.chain().focus()
  return (
    <div className={`${s.toolbar} ${className}`} data-nodrag>
      {B('Bold', 'bold', () => c().toggleBold().run(), editor.isActive('bold'))}
      {B('Italic', 'italic', () => c().toggleItalic().run(), editor.isActive('italic'))}
      {B('Strike', 'strike', () => c().toggleStrike().run(), editor.isActive('strike'))}
      {B('Heading', 'heading', () => c().toggleHeading({ level: 3 }).run(), editor.isActive('heading'))}
      {B('Bullets', 'ul', () => c().toggleBulletList().run(), editor.isActive('bulletList'))}
      {B('Numbers', 'ol', () => c().toggleOrderedList().run(), editor.isActive('orderedList'))}
      {B('Checklist', 'check', () => c().toggleTaskList().run(), editor.isActive('taskList'))}
      {B('Code', 'code', () => c().toggleCodeBlock().run(), editor.isActive('codeBlock'))}
    </div>
  )
}
